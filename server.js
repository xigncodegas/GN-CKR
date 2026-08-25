require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const generatePromptPayPayload = require('promptpay-qr');
const QRCode = require('qrcode');

const app = express();
// จำกัดขนาด body ไว้ที่ 6mb เพราะสลิปโอนเงินที่ผู้ใช้แนบมาจะถูกส่งมาเป็น base64 ใน JSON
app.use(express.json({ limit: '6mb' }));
app.use(cors()); // ปรับ origin ให้เจาะจงโดเมนจริงก่อนใช้งานจริง (เช่น { origin: 'https://yoursite.com' })

// ------------------------------------------------------------------
// เสิร์ฟหน้าเว็บ (index.html, dashboard.html, assets/*) จากเซิร์ฟเวอร์
// ตัวเดียวกับ API — ทำให้ deploy ที่เดียวจบ ไม่ต้องแยก hosting frontend
// กับ backend คนละที่ (และไม่ต้องแก้ API_BASE_URL ให้ตรงกันเอง)
// ------------------------------------------------------------------
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '2h';
const DATABASE_URL = process.env.DATABASE_URL;

// ตรวจสอบตอนสตาร์ทว่าตั้งค่า .env ครบหรือยัง
if (!JWT_SECRET) {
  console.error('❌ ไม่พบ JWT_SECRET ใน .env — กรุณาตั้งค่าก่อนรันเซิร์ฟเวอร์');
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('❌ ไม่พบ DATABASE_URL — กรุณาตั้งค่า PostgreSQL ใน Render ก่อนรันเซิร์ฟเวอร์');
  process.exit(1);
}
if (!process.env.ADMIN_PASSWORD_HASH) {
  console.error('❌ ไม่พบ ADMIN_PASSWORD_HASH ใน .env — รันคำสั่ง `npm run hash-password -- "รหัสผ่าน"` ก่อน');
  process.exit(1);
}

// PromptPay ID = เบอร์โทรศัพท์ (หรือเลขบัตรประชาชน) ที่จะใช้รับเงินจริง
// ใส่ในไฟล์ .env -> PROMPTPAY_ID ไม่ต้อง exit ถ้ายังไม่ตั้งค่า แค่เตือนไว้
// เพราะระบบอื่น ๆ (login, เช่าโปรแกรม) ยังใช้งานได้ปกติ มีแค่ QR เติมพอยท์ที่จะสร้างไม่ได้
const PROMPTPAY_ID = process.env.PROMPTPAY_ID || '';
if (!PROMPTPAY_ID) {
  console.warn('⚠️ ไม่พบ PROMPTPAY_ID ใน .env — ระบบเติมพอยท์ผ่าน QR จะสร้าง QR ไม่ได้จนกว่าจะตั้งค่า');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
});

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(64) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'member',
      points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
      rentals JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_reset_requests (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(64) NOT NULL,
      contact TEXT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      acknowledged_at TIMESTAMPTZ,
      acknowledged_by VARCHAR(64)
    )
  `);

  if (process.env.ADMIN_PASSWORD_HASH) {
    await pool.query(
      `INSERT INTO users (username, password_hash, role, points)
       VALUES ($1, $2, 'admin', 999999)
       ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin'`,
      [process.env.ADMIN_USERNAME || 'GMGas', process.env.ADMIN_PASSWORD_HASH]
    );
  }
}

async function findUser(username) {
  const result = await pool.query(
    'SELECT username, password_hash AS "passwordHash", role, points, rentals FROM users WHERE username = $1',
    [username]
  );
  return result.rows[0] || null;
}

// ------------------------------------------------------------------
// แพ็กเกจเติมพอยท์ (ตัวอย่างสาธิต) — ระบบจริงควรเก็บใน DB และผูกกับ
// การยืนยันการชำระเงินจริง (เช่น ตรวจสลิป / webhook จาก payment gateway)
// ก่อนค่อยเพิ่มพอยท์ ไม่ใช่เพิ่มทันทีตามที่ client ขอ
// ------------------------------------------------------------------
const PACKAGES = [
  { id: 'pkg-100', points: 100, price: 39, priceLabel: '฿39' },
  { id: 'pkg-300', points: 300, price: 99, priceLabel: '฿99', best: true },
  { id: 'pkg-650', points: 650, price: 199, priceLabel: '฿199' },
  { id: 'pkg-1500', points: 1500, price: 399, priceLabel: '฿399' },
];

// ------------------------------------------------------------------
// คำขอเติมพอยท์ที่รอตรวจสอบสลิป (ตัวอย่างสาธิต — อยู่ในหน่วยความจำ)
// สถานะ: 'pending' (สร้าง QR แล้วรอโอน/แนบสลิป) -> 'awaiting_review' (แนบสลิปแล้ว
// รอแอดมินตรวจ) -> 'approved' (แอดมินอนุมัติ เพิ่มพอยท์แล้ว) หรือ 'rejected'
// ------------------------------------------------------------------
const pendingTopups = [];

// เพิ่มเศษสตางค์เล็กน้อยที่ไม่ซ้ำกันต่อยอดเงิน ช่วยให้แอดมินจับคู่ระหว่าง
// "คำขอในระบบ" กับ "ยอดโอนที่เข้าบัญชีจริง" ได้ง่ายขึ้นเวลามีคนเติมพร้อมกันหลายคน
let topupSequence = 0;
function nextUniqueAmount(basePrice) {
  topupSequence = (topupSequence + 1) % 100;
  return Math.round((basePrice + topupSequence / 100) * 100) / 100;
}

async function buildPromptPayQr(amount) {
  if (!PROMPTPAY_ID) return null;
  const payload = generatePromptPayPayload(PROMPTPAY_ID, { amount });
  return QRCode.toDataURL(payload, { margin: 1, width: 280 });
}

// ------------------------------------------------------------------
// โปรแกรมช่วยเล่นที่ให้เช่า (ตัวอย่างสาธิต)
// ------------------------------------------------------------------
const SERVICES = [
  { id: 'svc-a', name: 'โปรแกรมช่วยเล่น A', icon: '🚀', description: 'เครื่องมือช่วยเพิ่มความสะดวกระหว่างเล่น รองรับการตั้งค่าพื้นฐาน', cost: 20, durationMs: 24 * 60 * 60 * 1000, durationLabel: '24 ชม.', available: true },
  { id: 'svc-b', name: 'โปรแกรมช่วยเล่น B', icon: '🛰️', description: 'ระบบเสริมสำหรับผู้ใช้ระดับกลาง มีการอัปเดตสม่ำเสมอ', cost: 35, durationMs: 24 * 60 * 60 * 1000, durationLabel: '24 ชม.', available: true },
  { id: 'svc-c', name: 'โปรแกรมช่วยเล่น C', icon: '🧠', description: 'ฟีเจอร์ขั้นสูง กำลังอยู่ระหว่างปรับปรุงระบบ', cost: 50, durationMs: 24 * 60 * 60 * 1000, durationLabel: '24 ชม.', available: false },
  { id: 'svc-vip', name: 'แพ็กเกจสมาชิก VIP', icon: '🎯', description: 'ปลดล็อกสิทธิพิเศษและบริการทั้งหมดในที่เดียว', cost: 80, durationMs: 7 * 24 * 60 * 60 * 1000, durationLabel: '7 วัน', available: true },
];

function formatRemaining(ms) {
  const hrs = Math.ceil(ms / (60 * 60 * 1000));
  if (hrs >= 24) return Math.ceil(hrs / 24) + ' วัน';
  return hrs + ' ชม.';
}

// ------------------------------------------------------------------
// จำกัดจำนวนครั้งการพยายามล็อกอิน ป้องกันการเดารหัสผ่าน (brute force)
// ------------------------------------------------------------------
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 นาที
  max: 10,                  // ล็อกอินผิดได้ไม่เกิน 10 ครั้งต่อ IP ต่อช่วงเวลา
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'พยายามเข้าสู่ระบบบ่อยเกินไป กรุณาลองใหม่ภายหลัง' },
});

// ------------------------------------------------------------------
// POST /api/register — สร้างบัญชีสมาชิกใน PostgreSQL
// ------------------------------------------------------------------
app.post('/api/register', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!/^[A-Za-z0-9_]{3,64}$/.test(username) || password.length < 8) {
    return res.status(400).json({ error: 'ชื่อผู้ใช้ต้องมี 3-64 ตัวอักษร (a-z, 0-9, _) และรหัสผ่านอย่างน้อย 8 ตัวอักษร' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO users (username, password_hash, role, points)
       VALUES ($1, $2, 'member', 0)
       RETURNING username, role, points`,
      [username, passwordHash]
    );
    return res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'ชื่อผู้ใช้นี้มีอยู่แล้ว' });
    console.error('สมัครสมาชิกไม่สำเร็จ:', err);
    return res.status(500).json({ error: 'สมัครสมาชิกไม่สำเร็จ กรุณาลองใหม่' });
  }
});

// ------------------------------------------------------------------
// POST /api/password-reset-requests — ฝากคำขอให้แอดมินติดต่อกลับ
// ------------------------------------------------------------------
app.post('/api/password-reset-requests', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const contact = String(req.body?.contact || '').trim();
  if (!username || !contact || username.length > 64 || contact.length > 300) {
    return res.status(400).json({ error: 'กรุณากรอกชื่อผู้ใช้และช่องทางติดต่อให้ครบถ้วน' });
  }
  try {
    await pool.query(
      'INSERT INTO password_reset_requests (username, contact) VALUES ($1, $2)',
      [username, contact]
    );
    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error('บันทึกคำขอรีเซ็ตรหัสผ่านไม่สำเร็จ:', err);
    return res.status(500).json({ error: 'ส่งคำขอไม่สำเร็จ กรุณาลองใหม่' });
  }
});

// ------------------------------------------------------------------
// POST /api/login
// ------------------------------------------------------------------
app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' });
  }

  const user = await findUser(username);

  // สำคัญ: ใช้ข้อความ error เดียวกันไม่ว่าจะ "ไม่พบผู้ใช้" หรือ "รหัสผ่านผิด"
  // เพื่อไม่ให้ผู้โจมตีรู้ว่าชื่อผู้ใช้ไหนมีอยู่จริงในระบบ (user enumeration)
  const invalidMsg = 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง';

  if (!user) {
    return res.status(401).json({ error: invalidMsg });
  }

  const passwordOk = await bcrypt.compare(password, user.passwordHash);
  if (!passwordOk) {
    return res.status(401).json({ error: invalidMsg });
  }

  const token = jwt.sign(
    { sub: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

  return res.json({
    token,
    user: { username: user.username, role: user.role, points: user.points },
  });
});

// ------------------------------------------------------------------
// Middleware ตรวจสอบ JWT สำหรับเส้นทางที่ต้องล็อกอินก่อน
// ------------------------------------------------------------------
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'ไม่พบ token กรุณาเข้าสู่ระบบ' });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'token ไม่ถูกต้องหรือหมดอายุ' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'ต้องใช้สิทธิ์แอดมินเท่านั้น' });
  }
  next();
}

// ------------------------------------------------------------------
// GET /api/me — ตัวอย่าง route ที่ต้องล็อกอินก่อนถึงจะเข้าได้
// ------------------------------------------------------------------
app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const user = await findUser(req.user.sub);
    if (!user) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
    res.json({ username: user.username, role: user.role, points: user.points });
  } catch (err) {
    res.status(500).json({ error: 'อ่านข้อมูลผู้ใช้ไม่สำเร็จ' });
  }
});

// ------------------------------------------------------------------
// GET /api/admin/ping — ตัวอย่าง route ที่ต้องเป็นแอดมินเท่านั้น
// ------------------------------------------------------------------
app.get('/api/admin/ping', requireAuth, requireAdmin, (req, res) => {
  res.json({ ok: true, message: `สวัสดีแอดมิน ${req.user.sub}` });
});

app.get('/api/admin/password-reset-requests', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, contact, status, created_at AS "createdAt", acknowledged_at AS "acknowledgedAt", acknowledged_by AS "acknowledgedBy"
       FROM password_reset_requests ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'อ่านคำขอรีเซ็ตรหัสผ่านไม่สำเร็จ' });
  }
});

app.post('/api/admin/password-reset-requests/:id/acknowledge', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE password_reset_requests
       SET status = 'acknowledged', acknowledged_at = NOW(), acknowledged_by = $1
       WHERE id = $2 AND status = 'pending' RETURNING id`,
      [req.user.sub, req.params.id]
    );
    if (!result.rowCount) return res.status(400).json({ error: 'คำขอนี้ถูกรับเรื่องแล้วหรือไม่พบคำขอ' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'รับเรื่องไม่สำเร็จ' });
  }
});

// ------------------------------------------------------------------
// GET /api/packages — รายการแพ็กเกจเติมพอยท์ (ต้องล็อกอินก่อนถึงจะดูได้)
// ------------------------------------------------------------------
app.get('/api/packages', requireAuth, (req, res) => {
  res.json(PACKAGES.map(({ id, points, priceLabel, best }) => ({ id, points, priceLabel, best: !!best })));
});

// ------------------------------------------------------------------
// GET /api/promptpay-status — เช็กว่าตั้งค่า PROMPTPAY_ID ไว้หรือยัง
// ให้หน้าเว็บใช้เตือนแอดมินถ้ายังไม่ได้ตั้งค่า
// ------------------------------------------------------------------
app.get('/api/promptpay-status', requireAuth, (req, res) => {
  res.json({ configured: !!PROMPTPAY_ID });
});

// ------------------------------------------------------------------
// GET /api/services — รายการโปรแกรมช่วยเล่น พร้อมสถานะการเช่าของผู้ใช้คนนี้
// ------------------------------------------------------------------
app.get('/api/services', requireAuth, async (req, res) => {
  const user = await findUser(req.user.sub);
  if (!user) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });

  const now = Date.now();
  const list = SERVICES.map((svc) => {
    const expiresAt = (user.rentals || {})[svc.id];
    const rented = expiresAt && expiresAt > now;
    return {
      id: svc.id,
      name: svc.name,
      icon: svc.icon,
      description: svc.description,
      cost: svc.cost,
      durationLabel: svc.durationLabel,
      available: svc.available,
      rented: !!rented,
      remainingLabel: rented ? formatRemaining(expiresAt - now) : null,
    };
  });
  res.json(list);
});

// ------------------------------------------------------------------
// POST /api/topup/request — สร้างคำขอเติมพอยท์ + QR PromptPay
// ยังไม่เพิ่มพอยท์ตอนนี้ ต้องรอแอดมินตรวจสลิปแล้วกดอนุมัติก่อน
// ------------------------------------------------------------------
app.post('/api/topup/request', requireAuth, async (req, res) => {
  const { packageId } = req.body || {};
  const pkg = PACKAGES.find((p) => p.id === packageId);
  if (!pkg) return res.status(400).json({ error: 'ไม่พบแพ็กเกจนี้' });

  if (!PROMPTPAY_ID) {
    return res.status(503).json({ error: 'ระบบยังไม่ได้ตั้งค่าบัญชีรับเงิน (PROMPTPAY_ID) กรุณาติดต่อแอดมิน' });
  }

  const amount = nextUniqueAmount(pkg.price);
  let qrDataUrl;
  try {
    qrDataUrl = await buildPromptPayQr(amount);
  } catch (err) {
    console.error('สร้าง QR PromptPay ไม่สำเร็จ:', err);
    return res.status(500).json({ error: 'สร้าง QR ไม่สำเร็จ กรุณาลองใหม่' });
  }

  const topup = {
    id: crypto.randomUUID(),
    username: req.user.sub,
    packageId: pkg.id,
    points: pkg.points,
    amount,
    status: 'pending', // pending -> awaiting_review -> approved / rejected
    slipImageBase64: null,
    createdAt: Date.now(),
    reviewedAt: null,
    rejectReason: null,
  };
  pendingTopups.push(topup);

  res.json({
    topupId: topup.id,
    amount: topup.amount,
    points: topup.points,
    qrDataUrl,
    expiresInSec: 15 * 60, // แนะนำให้โอนภายใน 15 นาที ก่อนยอดนี้ถือว่าหมดอายุ (เช็กฝั่งหน้าเว็บ)
  });
});

// ------------------------------------------------------------------
// POST /api/topup/:id/slip — แนบสลิปโอนเงินสำหรับคำขอที่สร้างไว้
// รับภาพเป็น base64 data URL (เช่น "data:image/png;base64,....")
// ------------------------------------------------------------------
app.post('/api/topup/:id/slip', requireAuth, (req, res) => {
  const { imageBase64 } = req.body || {};
  if (!imageBase64 || !imageBase64.startsWith('data:image/')) {
    return res.status(400).json({ error: 'กรุณาแนบไฟล์รูปสลิปให้ถูกต้อง' });
  }

  const topup = pendingTopups.find((t) => t.id === req.params.id);
  if (!topup) return res.status(404).json({ error: 'ไม่พบคำขอเติมพอยท์นี้' });
  if (topup.username !== req.user.sub) return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึงคำขอนี้' });
  if (topup.status !== 'pending') {
    return res.status(400).json({ error: 'คำขอนี้แนบสลิปไปแล้ว หรือถูกตรวจสอบไปแล้ว' });
  }

  topup.slipImageBase64 = imageBase64;
  topup.status = 'awaiting_review';
  topup.slipUploadedAt = Date.now();

  res.json({ ok: true, status: topup.status });
});

// ------------------------------------------------------------------
// GET /api/my/topups — ประวัติ/สถานะคำขอเติมพอยท์ของผู้ใช้คนนี้ (ล่าสุดก่อน)
// ------------------------------------------------------------------
app.get('/api/my/topups', requireAuth, (req, res) => {
  const list = pendingTopups
    .filter((t) => t.username === req.user.sub)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(({ id, packageId, points, amount, status, createdAt, rejectReason }) => ({
      id, packageId, points, amount, status, createdAt, rejectReason,
    }));
  res.json(list);
});

// ------------------------------------------------------------------
// GET /api/admin/topups — รายการคำขอเติมพอยท์ทั้งหมด (แอดมินเท่านั้น)
// ค่าเริ่มต้นกรองเฉพาะที่ "แนบสลิปแล้ว รอตรวจสอบ" ใส่ ?status=all เพื่อดูทุกสถานะ
// ------------------------------------------------------------------
app.get('/api/admin/topups', requireAuth, requireAdmin, (req, res) => {
  const statusFilter = req.query.status;
  let list = pendingTopups.slice().sort((a, b) => b.createdAt - a.createdAt);
  if (statusFilter !== 'all') {
    list = list.filter((t) => t.status === (statusFilter || 'awaiting_review'));
  }
  res.json(list);
});

// ------------------------------------------------------------------
// POST /api/admin/topups/:id/approve — อนุมัติคำขอ เพิ่มพอยท์ให้ผู้ใช้จริง
// ------------------------------------------------------------------
app.post('/api/admin/topups/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  const topup = pendingTopups.find((t) => t.id === req.params.id);
  if (!topup) return res.status(404).json({ error: 'ไม่พบคำขอนี้' });
  if (topup.status !== 'awaiting_review') {
    return res.status(400).json({ error: 'คำขอนี้ไม่ได้อยู่ในสถานะรอตรวจสอบ' });
  }

  const user = await findUser(topup.username);
  if (!user) return res.status(404).json({ error: 'ไม่พบผู้ใช้เจ้าของคำขอนี้' });

  const updated = await pool.query(
    'UPDATE users SET points = points + $1 WHERE username = $2 RETURNING username, points',
    [topup.points, topup.username]
  );
  if (!updated.rowCount) return res.status(404).json({ error: 'ไม่พบผู้ใช้เจ้าของคำขอนี้' });
  topup.status = 'approved';
  topup.reviewedAt = Date.now();
  topup.reviewedBy = req.user.sub;

  res.json({ ok: true, username: updated.rows[0].username, newPoints: updated.rows[0].points });
});

// ------------------------------------------------------------------
// POST /api/admin/topups/:id/reject — ปฏิเสธคำขอ (เช่น สลิปปลอม/ยอดไม่ตรง)
// ------------------------------------------------------------------
app.post('/api/admin/topups/:id/reject', requireAuth, requireAdmin, (req, res) => {
  const { reason } = req.body || {};
  const topup = pendingTopups.find((t) => t.id === req.params.id);
  if (!topup) return res.status(404).json({ error: 'ไม่พบคำขอนี้' });
  if (topup.status !== 'awaiting_review') {
    return res.status(400).json({ error: 'คำขอนี้ไม่ได้อยู่ในสถานะรอตรวจสอบ' });
  }

  topup.status = 'rejected';
  topup.reviewedAt = Date.now();
  topup.reviewedBy = req.user.sub;
  topup.rejectReason = reason || 'ไม่ระบุเหตุผล';

  res.json({ ok: true });
});

// ------------------------------------------------------------------
// POST /api/rent — เช่าโปรแกรมช่วยเล่นด้วยพอยท์
// ------------------------------------------------------------------
app.post('/api/rent', requireAuth, async (req, res) => {
  const { serviceId } = req.body || {};
  const svc = SERVICES.find((s) => s.id === serviceId);
  if (!svc) return res.status(400).json({ error: 'ไม่พบโปรแกรมนี้' });
  if (!svc.available) return res.status(400).json({ error: 'โปรแกรมนี้ยังไม่เปิดให้ใช้งาน' });

  const user = await findUser(req.user.sub);
  if (!user) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });

  if (user.points < svc.cost) {
    return res.status(400).json({ error: 'พอยท์ไม่เพียงพอ กรุณาเติมพอยท์ก่อน' });
  }

  const rentals = user.rentals || {};
  const now = Date.now();
  const currentExpiry = rentals[svc.id] && rentals[svc.id] > now ? rentals[svc.id] : now;
  const newExpiry = currentExpiry + svc.durationMs;
  const updated = await pool.query(
    `UPDATE users SET points = points - $1, rentals = jsonb_set(COALESCE(rentals, '{}'::jsonb), $2, to_jsonb($3::bigint))
     WHERE username = $4 AND points >= $1 RETURNING points`,
    [svc.cost, `{${svc.id}}`, newExpiry, req.user.sub]
  );
  if (!updated.rowCount) return res.status(400).json({ error: 'พอยท์ไม่เพียงพอ กรุณาเติมพอยท์ก่อน' });

  res.json({
    points: updated.rows[0].points,
    serviceId: svc.id,
    expiresAt: newExpiry,
    expiresLabel: new Date(newExpiry).toLocaleString('th-TH'),
  });
});

// ------------------------------------------------------------------
// เส้นทางอื่น ๆ ที่ไม่ตรงกับไฟล์ static หรือ /api/* ให้ตกกลับไปหน้า index.html
// (กันไว้เผื่อคนกดรีเฟรชหน้าที่ไม่มีไฟล์ตรง ๆ) — ต้องอยู่หลังสุดเสมอ
// ------------------------------------------------------------------
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ Server (frontend + API) running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('❌ เชื่อมต่อ PostgreSQL หรือสร้างตารางไม่สำเร็จ');
    console.error(err.message);
    process.exit(1);
  });
