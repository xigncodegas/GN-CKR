require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { Pool } = require('pg');
const generatePromptPayPayload = require('promptpay-qr');
const QRCode = require('qrcode');

const app = express();
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      fontSrc: ["'self'", 'https:', 'data:'],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", 'https:', "'unsafe-inline'"],
      upgradeInsecureRequests: [],
    },
  },
}));
// จำกัดขนาด body ไว้ที่ 6mb เพราะสลิปโอนเงินที่ผู้ใช้แนบมาจะถูกส่งมาเป็น base64 ใน JSON
app.use(express.json({ limit: '6mb' }));
const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean);
app.use(cors({
  origin: corsOrigins.length ? corsOrigins : false,
}));

// ------------------------------------------------------------------
// เสิร์ฟหน้าเว็บ (index.html, dashboard.html, assets/*) จากเซิร์ฟเวอร์
// ตัวเดียวกับ API — ทำให้ deploy ที่เดียวจบ ไม่ต้องแยก hosting frontend
// กับ backend คนละที่ (และไม่ต้องแก้ API_BASE_URL ให้ตรงกันเอง)
// ------------------------------------------------------------------
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '2h';
const CLIENT_ACCESS_EXPIRES_IN = process.env.CLIENT_ACCESS_EXPIRES_IN || '15m';
const CLIENT_REFRESH_DAYS = Number(process.env.CLIENT_REFRESH_DAYS || 30);
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS permanent_entitlements (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      entitlement_key VARCHAR(100) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, entitlement_key)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS entitlements (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      entitlement_key VARCHAR(100) NOT NULL,
      plan VARCHAR(30) NOT NULL,
      starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ,
      max_devices INTEGER NOT NULL DEFAULT 1 CHECK (max_devices > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, entitlement_key, plan)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS client_sessions (
      id UUID PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      refresh_token_hash CHAR(64) NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      replaced_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS active_leases (
      id UUID PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      entitlement_key VARCHAR(100) NOT NULL,
      client_session_id UUID NOT NULL REFERENCES client_sessions(id) ON DELETE CASCADE,
      lease_token_hash CHAR(64) NOT NULL UNIQUE,
      last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      action VARCHAR(80) NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    INSERT INTO entitlements (user_id, entitlement_key, plan, expires_at, max_devices)
    SELECT id, 'cookie-run-farm-vip',
      CASE WHEN rentals->>'cookie-run-farm-vip-plan' = '30d' THEN '30d' ELSE '24h' END,
      to_timestamp((rentals->>'cookie-run-farm-vip')::double precision / 1000),
      CASE WHEN rentals->>'cookie-run-farm-vip-plan' = '30d' THEN 5 ELSE 1 END
    FROM users WHERE rentals ? 'cookie-run-farm-vip'
    ON CONFLICT (user_id, entitlement_key, plan) DO UPDATE SET expires_at = GREATEST(entitlements.expires_at, EXCLUDED.expires_at), max_devices = EXCLUDED.max_devices
  `);
  await pool.query(`
    INSERT INTO entitlements (user_id, entitlement_key, plan, expires_at, max_devices)
    SELECT id, 'suvip', 'suvip', to_timestamp((rentals->>'suvip')::double precision / 1000), 3
    FROM users WHERE rentals ? 'suvip'
    ON CONFLICT (user_id, entitlement_key, plan) DO UPDATE SET expires_at = GREATEST(entitlements.expires_at, EXCLUDED.expires_at)
  `);
  await pool.query(`
    INSERT INTO entitlements (user_id, entitlement_key, plan, expires_at, max_devices)
    SELECT pe.user_id, pe.entitlement_key, 'permanent', NULL, 1
    FROM permanent_entitlements pe
    ON CONFLICT (user_id, entitlement_key, plan) DO NOTHING
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
    `SELECT u.username, u.id, u.password_hash AS "passwordHash", u.role, u.points, u.rentals,
            EXISTS (
              SELECT 1 FROM permanent_entitlements pe
              WHERE pe.user_id = u.id AND pe.entitlement_key = 'svc-c'
            ) AS "permanentProgramOwned"
     FROM users u WHERE u.username = $1`,
    [username]
  );
  return result.rows[0] || null;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function writeAudit(userId, action, metadata = {}) {
  try {
    await pool.query(
      'INSERT INTO audit_logs (user_id, action, metadata) VALUES ($1, $2, $3::jsonb)',
      [userId || null, action, JSON.stringify(metadata)]
    );
  } catch (err) {
    console.error('บันทึก audit log ไม่สำเร็จ');
  }
}

function signClientAccessToken(user, sessionId) {
  return jwt.sign({ sub: user.username, role: user.role, sessionId, tokenType: 'client_access' }, JWT_SECRET, { expiresIn: CLIENT_ACCESS_EXPIRES_IN });
}

async function createClientSession(user) {
  const sessionId = crypto.randomUUID();
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + CLIENT_REFRESH_DAYS * 24 * 60 * 60 * 1000);
  await pool.query(
    'INSERT INTO client_sessions (id, user_id, refresh_token_hash, expires_at) VALUES ($1, $2, $3, $4)',
    [sessionId, user.id, hashToken(refreshToken), expiresAt]
  );
  return { sessionId, refreshToken, expiresAt };
}

async function getClientUser(req) {
  const user = await findUser(req.user.sub);
  return user;
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
  { id: 'cookie-run-farm-vip', name: 'CookieRun Farm VIP', icon: '🚀', description: 'เครื่องมือช่วยเพิ่มความสะดวกระหว่างเล่น รองรับการตั้งค่าพื้นฐาน', cost: 20, durationMs: 24 * 60 * 60 * 1000, durationLabel: '24 ชม.', available: true },
  { id: 'svc-b', name: 'เช่ายศ SUVIP', icon: '🛰️', description: 'ยศ SUVIP สำหรับเพิ่มสิทธิ์การใช้งาน CookieRun Farm VIP', cost: 35, durationMs: 24 * 60 * 60 * 1000, durationLabel: '24 ชม.', available: true },
  { id: 'svc-c', name: 'ซื้อโปรแกรมช่วยเล่นถาวร', icon: '🧠', description: 'ซื้อครั้งเดียว ใช้งานได้ถาวรตลอดอายุบัญชี', cost: 3000, permanent: true, available: true },
  { id: 'svc-vip', name: 'แพ็กเกจสมาชิก VIP / SUVIP 30 วัน', icon: '🎯', description: 'VIP / SUVIP · 30 วัน · ใช้ได้สูงสุด 5 จอ', cost: 900, durationMs: 30 * 24 * 60 * 60 * 1000, durationLabel: '30 วัน', available: true, cookieRunBundle: true },
];

function formatRemaining(ms) {
  const hrs = Math.ceil(ms / (60 * 60 * 1000));
  if (hrs >= 24) return Math.ceil(hrs / 24) + ' วัน';
  return hrs + ' ชม.';
}

function getMembership(rentals, now = Date.now()) {
  const suvipExpiresAt = Number((rentals || {}).suvip) || null;
  return {
    membershipTier: suvipExpiresAt && suvipExpiresAt > now ? 'SUVIP' : 'Standard',
    suvipExpiresAt: suvipExpiresAt && suvipExpiresAt > now ? suvipExpiresAt : null,
  };
}

function getCookieRunScreenLimit(rentals, membershipTier) {
  const plan = (rentals || {})['cookie-run-farm-vip-plan'];
  const durationDays = Number((rentals || {})['cookie-run-farm-vip-duration-days']);
  if (plan === '30d' || durationDays === 30) return 5;
  return membershipTier === 'SUVIP' ? 3 : 1;
}

function getCookieRunPlan(rentals) {
  return (rentals || {})['cookie-run-farm-vip-plan'] === '30d' ? '30d' : '24h';
}

async function getActiveCookieRunEntitlement(userId, client = pool) {
  const result = await client.query(
    `SELECT plan, expires_at AS "expiresAt", max_devices AS "maxDevices"
     FROM entitlements
     WHERE user_id = $1 AND entitlement_key = 'cookie-run-farm-vip'
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY CASE WHEN plan = '30d' THEN 1 ELSE 0 END DESC, expires_at DESC NULLS LAST
     LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
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
const clientLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'พยายามเข้าสู่ระบบบ่อยเกินไป' } });
const clientRefreshLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'รีเฟรช token บ่อยเกินไป' } });
const slotLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false, message: { error: 'ส่งคำขอ slot บ่อยเกินไป' } });

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
  await writeAudit(user.id, 'web_login');

  return res.json({
    token,
    user: { username: user.username, role: user.role, points: user.points },
  });
});

app.post('/api/client/login', clientLoginLimiter, async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const user = await findUser(username);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    await writeAudit(user?.id, 'client_login_failed');
    return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  }
  const session = await createClientSession(user);
  await writeAudit(user.id, 'client_login');
  res.json({ accessToken: signClientAccessToken(user, session.sessionId), refreshToken: session.refreshToken, accessExpiresIn: CLIENT_ACCESS_EXPIRES_IN, refreshExpiresAt: session.expiresAt });
});

app.post('/api/client/refresh', clientRefreshLimiter, async (req, res) => {
  const refreshToken = String(req.body?.refreshToken || '');
  if (!refreshToken) return res.status(401).json({ error: 'ไม่พบ refresh token' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT cs.*, u.username, u.role, u.id AS user_id FROM client_sessions cs JOIN users u ON u.id = cs.user_id
       WHERE cs.refresh_token_hash = $1 FOR UPDATE`, [hashToken(refreshToken)]
    );
    const session = result.rows[0];
    if (!session || session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'refresh token ไม่ถูกต้องหรือหมดอายุ' });
    }
    const replacementId = crypto.randomUUID();
    const replacementToken = crypto.randomBytes(48).toString('base64url');
    const replacementExpiry = new Date(Date.now() + CLIENT_REFRESH_DAYS * 24 * 60 * 60 * 1000);
    await client.query('UPDATE client_sessions SET revoked_at = NOW(), replaced_by = $1, last_used_at = NOW() WHERE id = $2', [replacementId, session.id]);
    await client.query('INSERT INTO client_sessions (id, user_id, refresh_token_hash, expires_at) VALUES ($1, $2, $3, $4)', [replacementId, session.user_id, hashToken(replacementToken), replacementExpiry]);
    await client.query('COMMIT');
    const user = { username: session.username, role: session.role };
    await writeAudit(session.user_id, 'client_refresh');
    res.json({ accessToken: signClientAccessToken(user, replacementId), refreshToken: replacementToken, accessExpiresIn: CLIENT_ACCESS_EXPIRES_IN, refreshExpiresAt: replacementExpiry });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'refresh token ไม่สำเร็จ' });
  } finally { client.release(); }
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

function requireClientAuth(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user?.tokenType !== 'client_access') return res.status(401).json({ error: 'ต้องใช้ client access token' });
    next();
  });
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
    const membership = getMembership(user.rentals);
    res.json({ username: user.username, role: user.role, points: user.points, ...membership });
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

app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  const query = String(req.query.query || '').trim();
  if (query.length > 64) return res.status(400).json({ error: 'คำค้นหายาวเกินไป' });
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.role, u.points,
              cr.expires_at AS "cookieRunExpiresAt", cr.plan AS "cookieRunPlan", cr.max_devices AS "cookieRunMaxDevices",
              sv.expires_at AS "suvipExpiresAt",
              COALESCE((SELECT jsonb_agg(entitlement_key ORDER BY entitlement_key) FROM (
                SELECT pe.entitlement_key FROM permanent_entitlements pe WHERE pe.user_id = u.id
                UNION
                SELECT e.entitlement_key FROM entitlements e WHERE e.user_id = u.id AND e.plan = 'permanent'
              ) permanent_keys), '[]'::jsonb) AS "permanentEntitlements"
       FROM users u
       LEFT JOIN LATERAL (
         SELECT e.expires_at, e.plan, e.max_devices FROM entitlements e
         WHERE e.user_id = u.id AND e.entitlement_key = 'cookie-run-farm-vip'
         ORDER BY e.expires_at DESC LIMIT 1
       ) cr ON true
       LEFT JOIN LATERAL (
         SELECT e.expires_at FROM entitlements e
         WHERE e.user_id = u.id AND e.entitlement_key = 'suvip'
         ORDER BY e.expires_at DESC LIMIT 1
       ) sv ON true
       WHERE ($1 = '' OR u.username ILIKE '%' || $1 || '%')
       ORDER BY u.username ASC`,
      [query]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('ค้นหาสมาชิกไม่สำเร็จ');
    res.status(500).json({ error: 'ค้นหาสมาชิกไม่สำเร็จ' });
  }
});

app.post('/api/admin/users/:username/points', requireAuth, requireAdmin, async (req, res) => {
  const amount = Number(req.body?.amount);
  const reason = String(req.body?.reason || '').trim();
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 100000000) {
    return res.status(400).json({ error: 'จำนวนพอยท์ต้องเป็นจำนวนเต็มที่ไม่เป็นศูนย์' });
  }
  if (!reason || reason.length > 500) return res.status(400).json({ error: 'กรุณาระบุเหตุผลไม่เกิน 500 ตัวอักษร' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE users SET points = points + $1 WHERE username = $2 AND points + $1 >= 0
       RETURNING id, username, points`, [amount, req.params.username]
    );
    if (!result.rowCount) {
      await client.query('ROLLBACK');
      const exists = await pool.query('SELECT 1 FROM users WHERE username = $1', [req.params.username]);
      return res.status(exists.rowCount ? 400 : 404).json({ error: exists.rowCount ? 'พอยท์ต้องไม่ติดลบ' : 'ไม่พบสมาชิก' });
    }
    await client.query('COMMIT');
    await writeAudit(result.rows[0].id, 'admin_points_adjust', { adminUsername: req.user.sub, targetUsername: result.rows[0].username, amount, reason });
    res.json({ ok: true, username: result.rows[0].username, points: result.rows[0].points });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'ปรับพอยท์ไม่สำเร็จ' });
  } finally { client.release(); }
});

app.post('/api/admin/users/:username/entitlements/:key/adjust-days', requireAuth, requireAdmin, async (req, res) => {
  const key = String(req.params.key || '');
  const days = Number(req.body?.days);
  const reason = String(req.body?.reason || '').trim();
  if (!['cookie-run-farm-vip', 'suvip'].includes(key)) return res.status(400).json({ error: 'ไม่อนุญาตให้ปรับสิทธิ์ประเภทนี้' });
  if (!Number.isInteger(days) || days === 0 || Math.abs(days) > 3650) return res.status(400).json({ error: 'จำนวนวันต้องเป็นจำนวนเต็มที่ไม่เป็นศูนย์' });
  if (!reason || reason.length > 500) return res.status(400).json({ error: 'กรุณาระบุเหตุผลไม่เกิน 500 ตัวอักษร' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userResult = await client.query('SELECT id, username, rentals FROM users WHERE username = $1 FOR UPDATE', [req.params.username]);
    if (!userResult.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ไม่พบสมาชิก' }); }
    const user = userResult.rows[0];
    const entitlementResult = await client.query(
      `SELECT id, plan, expires_at AS "expiresAt" FROM entitlements
       WHERE user_id = $1 AND entitlement_key = $2 ORDER BY expires_at DESC NULLS LAST LIMIT 1 FOR UPDATE`, [user.id, key]
    );
    const existing = entitlementResult.rows[0];
    const current = existing?.expiresAt ? new Date(existing.expiresAt).getTime() : Number((user.rentals || {})[key]);
    const base = Number.isFinite(current) && current > Date.now() ? current : Date.now();
    const newExpiresAt = Math.max(Date.now(), base + days * 86400000);
    const plan = existing?.plan || (key === 'cookie-run-farm-vip' ? '24h' : 'suvip');
    const maxDevices = key === 'cookie-run-farm-vip' && plan === '30d' ? 5 : key === 'suvip' ? 3 : 1;
    if (existing) {
      await client.query('UPDATE entitlements SET expires_at = to_timestamp($1::double precision / 1000), max_devices = $2 WHERE id = $3', [newExpiresAt, maxDevices, existing.id]);
    } else {
      await client.query(
        `INSERT INTO entitlements (user_id, entitlement_key, plan, expires_at, max_devices)
         VALUES ($1, $2, $3, to_timestamp($4::double precision / 1000), $5)`, [user.id, key, plan, newExpiresAt, maxDevices]
      );
    }
    await client.query(
      `UPDATE users SET rentals = jsonb_set(COALESCE(rentals, '{}'::jsonb), $1, to_jsonb($2::bigint)) WHERE id = $3`,
      [`{${key}}`, newExpiresAt, user.id]
    );
    if (newExpiresAt <= Date.now()) {
      await client.query('DELETE FROM active_leases WHERE user_id = $1 AND entitlement_key = $2', [user.id, key]);
    }
    await client.query('COMMIT');
    await writeAudit(user.id, 'admin_entitlement_adjust_days', { adminUsername: req.user.sub, targetUsername: user.username, entitlementKey: key, days, reason });
    res.json({ ok: true, username: user.username, key, expiresAt: newExpiresAt });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'ปรับวันหมดอายุไม่สำเร็จ' });
  } finally { client.release(); }
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
    const owned = svc.id === 'svc-c' && user.permanentProgramOwned;
    const rentalKey = svc.cookieRunBundle
      ? 'cookie-run-farm-vip'
      : svc.id === 'svc-b' ? 'suvip' : svc.id;
    const expiresAt = (user.rentals || {})[rentalKey];
    const rented = expiresAt && expiresAt > now;
    return {
      id: svc.id,
      name: svc.name,
      icon: svc.icon,
      description: svc.description,
      cost: svc.cost,
      durationLabel: svc.durationLabel,
      available: svc.available,
      permanent: !!svc.permanent,
      owned: !!owned,
      rented: !!rented,
      expiresAt: svc.permanent ? null : (expiresAt || null),
      remainingLabel: rented ? formatRemaining(expiresAt - now) : null,
    };
  });
  res.json(list);
});

// GET /api/license/cookie-run-farm-vip — ตรวจสอบสิทธิ์ CookieRun Farm VIP
app.get('/api/license/cookie-run-farm-vip', requireAuth, async (req, res) => {
  try {
    const user = await findUser(req.user.sub);
    const serverTime = Date.now();
    if (!user) return res.status(403).json({ authorized: false });
    const entitlement = await getActiveCookieRunEntitlement(user.id);
    const rentals = user?.rentals || {};
    const expiresAt = entitlement ? new Date(entitlement.expiresAt).getTime() : Number(rentals['cookie-run-farm-vip']) || null;
    const suvipResult = await pool.query(
      `SELECT expires_at AS "expiresAt" FROM entitlements
       WHERE user_id = $1 AND entitlement_key = 'suvip' AND expires_at > NOW()
       ORDER BY expires_at DESC LIMIT 1`, [user.id]
    );
    const suvipExpiresAt = suvipResult.rows[0] ? new Date(suvipResult.rows[0].expiresAt).getTime() : Number(rentals.suvip) || null;
    const membership = getMembership({ suvip: suvipExpiresAt }, serverTime);
    const plan = entitlement?.plan || getCookieRunPlan(rentals);
    const membershipTier = membership.membershipTier === 'SUVIP' ? 'suvip' : 'standard';
    const maxDevices = plan === '30d' ? 5 : membershipTier === 'suvip' ? 3 : 1;
    if (expiresAt && expiresAt > serverTime) {
      return res.json({
        authorized: true,
        plan,
        membershipTier,
        expiresAt,
        suvipExpiresAt: membership.suvipExpiresAt,
        maxDevices,
        maxScreens: maxDevices,
        serverTime,
      });
    }
    return res.status(403).json({ authorized: false });
  } catch (err) {
    return res.status(500).json({ authorized: false });
  }
});

async function getActiveLeaseCount(userId, entitlementKey, client = pool) {
  const result = await client.query(
    `SELECT COUNT(*)::integer AS count FROM active_leases
     WHERE user_id = $1 AND entitlement_key = $2
       AND expires_at > NOW() AND last_heartbeat_at > NOW() - INTERVAL '2 minutes'`,
    [userId, entitlementKey]
  );
  return result.rows[0].count;
}

app.post('/api/client/slots/claim', slotLimiter, requireClientAuth, async (req, res) => {
  const entitlementKey = String(req.body?.entitlementKey || 'cookie-run-farm-vip');
  if (entitlementKey !== 'cookie-run-farm-vip') return res.status(400).json({ error: 'ไม่รองรับ entitlement นี้' });
  const user = await getClientUser(req);
  if (!user) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const entitlement = await getActiveCookieRunEntitlement(user.id, client);
    if (!entitlement) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'ไม่มีสิทธิ์ CookieRun Farm VIP' }); }
    const suvip = await client.query(
      `SELECT 1 FROM entitlements WHERE user_id = $1 AND entitlement_key = 'suvip'
       AND expires_at > NOW() LIMIT 1`, [user.id]
    );
    const maxDevices = entitlement.plan === '30d' ? 5 : suvip.rowCount ? 3 : 1;
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user.id]);
    const activeCount = await getActiveLeaseCount(user.id, entitlementKey, client);
    if (activeCount >= maxDevices) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'จำนวนจอที่ใช้งานอยู่ครบแล้ว', maxDevices });
    }
    const leaseId = crypto.randomUUID();
    const leaseToken = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 2 * 60 * 1000);
    await client.query(
      `INSERT INTO active_leases (id, user_id, entitlement_key, client_session_id, lease_token_hash, expires_at)
       SELECT $1, $2, $3, id, $4, $5 FROM client_sessions
       WHERE user_id = $2 AND id = $6 AND revoked_at IS NULL AND expires_at > NOW()`,
      [leaseId, user.id, entitlementKey, hashToken(leaseToken), expiresAt, req.user.sessionId]
    );
    const inserted = await client.query('SELECT 1 FROM active_leases WHERE id = $1', [leaseId]);
    if (!inserted.rowCount) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'client session ไม่ถูกต้อง' });
    }
    await client.query('COMMIT');
    await writeAudit(user.id, 'slot_claim', { entitlementKey });
    res.status(201).json({ leaseId, leaseToken, expiresAt, maxDevices });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'ขอ slot ไม่สำเร็จ' });
  } finally { client.release(); }
});

app.post('/api/client/slots/heartbeat', slotLimiter, requireClientAuth, async (req, res) => {
  const leaseToken = String(req.body?.leaseToken || '');
  const leaseId = String(req.body?.leaseId || '');
  const result = await pool.query(
    `UPDATE active_leases SET last_heartbeat_at = NOW(), expires_at = NOW() + INTERVAL '2 minutes'
     WHERE id = $1 AND lease_token_hash = $2 AND user_id = (SELECT id FROM users WHERE username = $3)
       AND expires_at > NOW() AND last_heartbeat_at > NOW() - INTERVAL '2 minutes'
     RETURNING expires_at AS "expiresAt"`,
    [leaseId, hashToken(leaseToken), req.user.sub]
  );
  if (!result.rowCount) return res.status(409).json({ error: 'lease ไม่ถูกต้องหรือหมดอายุ' });
  res.json({ ok: true, expiresAt: result.rows[0].expiresAt });
});

app.post('/api/client/slots/release', slotLimiter, requireClientAuth, async (req, res) => {
  const result = await pool.query(
    `DELETE FROM active_leases WHERE id = $1 AND lease_token_hash = $2
     AND user_id = (SELECT id FROM users WHERE username = $3) RETURNING user_id, entitlement_key`,
    [String(req.body?.leaseId || ''), hashToken(String(req.body?.leaseToken || '')), req.user.sub]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'ไม่พบ lease' });
  await writeAudit(result.rows[0].user_id, 'slot_release', { entitlementKey: result.rows[0].entitlement_key });
  res.json({ ok: true });
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

  if (svc.permanent) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user.id]);
      const owned = await client.query(
        `SELECT 1 FROM permanent_entitlements
         WHERE user_id = $1 AND entitlement_key = $2 FOR UPDATE`,
        [user.id, svc.id]
      );
      if (owned.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'คุณมีสิทธิ์โปรแกรมนี้อยู่แล้ว', owned: true, permanent: true });
      }
      const updated = await client.query(
        `UPDATE users SET points = points - $1
         WHERE id = $2 AND points >= $1 RETURNING points`,
        [svc.cost, user.id]
      );
      if (!updated.rowCount) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'พอยท์ไม่เพียงพอ กรุณาเติมพอยท์ก่อน' });
      }
      await client.query(
        'INSERT INTO permanent_entitlements (user_id, entitlement_key) VALUES ($1, $2)',
        [user.id, svc.id]
      );
      await client.query(
        `INSERT INTO entitlements (user_id, entitlement_key, plan, max_devices)
         VALUES ($1, $2, 'permanent', 1) ON CONFLICT (user_id, entitlement_key, plan) DO NOTHING`,
        [user.id, svc.id]
      );
      await client.query('COMMIT');
      await writeAudit(user.id, 'entitlement_purchase', { entitlementKey: svc.id, plan: 'permanent' });
      return res.json({ points: updated.rows[0].points, serviceId: svc.id, owned: true, permanent: true });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('ซื้อโปรแกรมถาวรไม่สำเร็จ:', err);
      return res.status(500).json({ error: 'ซื้อโปรแกรมไม่สำเร็จ กรุณาลองใหม่' });
    } finally {
      client.release();
    }
  }

  if (svc.cookieRunBundle) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user.id]);
      const rentals = user.rentals || {};
      const now = Date.now();
      const currentExpiry = Number(rentals['cookie-run-farm-vip']) > now
        ? Number(rentals['cookie-run-farm-vip'])
        : now;
      const expiresAt = currentExpiry + svc.durationMs;
      const updated = await client.query(
        `UPDATE users SET points = points - $1,
          rentals = jsonb_set(
            jsonb_set(
              jsonb_set(COALESCE(rentals, '{}'::jsonb), '{cookie-run-farm-vip}', to_jsonb($2::bigint)),
              '{cookie-run-farm-vip-plan}', '"30d"'::jsonb
            ),
            '{cookie-run-farm-vip-duration-days}', '30'::jsonb
          )
         WHERE id = $3 AND points >= $1 RETURNING points`,
        [svc.cost, expiresAt, user.id]
      );
      if (!updated.rowCount) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'พอยท์ไม่เพียงพอ กรุณาเติมพอยท์ก่อน' });
      }
      await client.query(
        `UPDATE users SET rentals = jsonb_set(rentals, '{suvip}', to_jsonb($1::bigint)) WHERE id = $2`,
        [expiresAt, user.id]
      );
      await client.query(
        `INSERT INTO entitlements (user_id, entitlement_key, plan, expires_at, max_devices)
         VALUES ($1, 'cookie-run-farm-vip', '30d', to_timestamp($2::double precision / 1000), 5)
         ON CONFLICT (user_id, entitlement_key, plan) DO UPDATE SET expires_at = EXCLUDED.expires_at, max_devices = 5`,
        [user.id, expiresAt]
      );
      await client.query(
        `INSERT INTO entitlements (user_id, entitlement_key, plan, expires_at, max_devices)
         VALUES ($1, 'suvip', 'suvip', to_timestamp($2::double precision / 1000), 3)
         ON CONFLICT (user_id, entitlement_key, plan) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
        [user.id, expiresAt]
      );
      await client.query('COMMIT');
      await writeAudit(user.id, 'entitlement_purchase', { entitlementKey: 'cookie-run-farm-vip', plan: '30d' });
      return res.json({
        points: updated.rows[0].points,
        serviceId: svc.id,
        plan: '30d',
        membershipTier: 'suvip',
        maxDevices: 5,
        expiresAt,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('ซื้อแพ็กเกจ VIP/SUVIP ไม่สำเร็จ:', err);
      return res.status(500).json({ error: 'ซื้อแพ็กเกจไม่สำเร็จ กรุณาลองใหม่' });
    } finally {
      client.release();
    }
  }

  if (user.points < svc.cost) {
    return res.status(400).json({ error: 'พอยท์ไม่เพียงพอ กรุณาเติมพอยท์ก่อน' });
  }

  const rentals = user.rentals || {};
  const now = Date.now();
  const rentalKey = svc.id === 'svc-b' ? 'suvip' : svc.id;
  const currentExpiry = rentals[rentalKey] && rentals[rentalKey] > now ? rentals[rentalKey] : now;
  const newExpiry = currentExpiry + svc.durationMs;
  const updated = await pool.query(
    `UPDATE users SET points = points - $1, rentals = jsonb_set(COALESCE(rentals, '{}'::jsonb), $2, to_jsonb($3::bigint))
     WHERE username = $4 AND points >= $1 RETURNING points`,
    [svc.cost, `{${rentalKey}}`, newExpiry, req.user.sub]
  );
  if (!updated.rowCount) return res.status(400).json({ error: 'พอยท์ไม่เพียงพอ กรุณาเติมพอยท์ก่อน' });

  if (rentalKey === 'suvip' || rentalKey === 'cookie-run-farm-vip') {
    const plan = rentalKey === 'suvip' ? 'suvip' : '24h';
    const maxDevices = rentalKey === 'suvip' ? 3 : 1;
    await pool.query(
      `INSERT INTO entitlements (user_id, entitlement_key, plan, expires_at, max_devices)
       VALUES ((SELECT id FROM users WHERE username = $1), $2, $3, to_timestamp($4::double precision / 1000), $5)
       ON CONFLICT (user_id, entitlement_key, plan) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
      [req.user.sub, rentalKey, plan, newExpiry, maxDevices]
    );
  }
  await writeAudit(user.id, 'entitlement_purchase', { entitlementKey: rentalKey, plan: rentalKey === 'suvip' ? 'suvip' : '24h' });

  res.json({
    points: updated.rows[0].points,
    serviceId: svc.id,
    expiresAt: newExpiry,
    ...(rentalKey === 'suvip' ? { membershipTier: 'SUVIP', suvipExpiresAt: newExpiry } : {}),
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
