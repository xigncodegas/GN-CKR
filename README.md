# AURORA HUB — Login + Dashboard (Express + bcrypt + JWT)

## ทำไมเว็บที่อัปขึ้น GitHub ถึงใช้งานไม่ได้

GitHub (ถ้าใช้ **GitHub Pages**) เสิร์ฟได้แค่ไฟล์ static (HTML/CSS/JS) เท่านั้น
รันโค้ด Node.js อย่าง `server.js` ไม่ได้ ระบบล็อคอิน/เติมพอยท์เลยไม่ทำงาน
เพราะไม่มี backend ให้หน้าเว็บเรียกใช้จริง ๆ

**วิธีแก้ในไฟล์ชุดนี้:** ปรับ `server.js` ให้เสิร์ฟทั้งหน้าเว็บ (index.html, dashboard.html,
assets) และ API จากเซิร์ฟเวอร์ Node ตัวเดียวกัน แล้วเอาไปรันบนโฮสต์ที่รองรับ Node.js
(เช่น Render) แทน — จบในที่เดียว ไม่ต้องแยก frontend/backend คนละที่

## โครงสร้างไฟล์

```
index.html         -> หน้าเข้าสู่ระบบ เรียก POST /api/login
dashboard.html      -> หน้าสมาชิก (เติมพอยท์ / เช่าโปรแกรมช่วยเล่น) ต้องมี token ถึงจะเข้าได้
assets/styles.css   -> ดีไซน์ที่ใช้ร่วมกันทั้งสองหน้า
assets/shared.js    -> เก็บ token, เรียก API, toast/modal helper ที่ใช้ร่วมกัน
server.js           -> backend + เสิร์ฟไฟล์หน้าเว็บทั้งหมด (static + API รวมกัน)
hash-password.js    -> สคริปต์แปลงรหัสผ่านเป็น bcrypt hash
```

## รันทดสอบในเครื่องตัวเอง

```bash
npm install
cp .env.example .env

# สร้าง hash ของรหัสผ่านแอดมิน (เปลี่ยนรหัสผ่านตามที่ต้องการ)
npm run hash-password -- "รหัสผ่านของคุณ"
# คัดลอกค่าที่ได้ไปวางใน .env -> ADMIN_PASSWORD_HASH

# สร้าง JWT secret แบบสุ่ม
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
# คัดลอกไปวางใน .env -> JWT_SECRET

npm start
```

เปิดเบราว์เซอร์ไปที่ `http://localhost:4000` จะเจอหน้า login ทันที (ไม่ต้องรัน
เว็บเซิร์ฟเวอร์แยกอีกตัวแล้ว เพราะ `server.js` เสิร์ฟหน้าเว็บให้ในตัว)

ล็อกอินด้วย:
- Username: ค่าที่ตั้งใน `.env` -> `ADMIN_USERNAME` (ค่าเริ่มต้น `GMGas`)
- Password: รหัสผ่านตัวจริงที่ใช้สร้าง hash ไว้ข้างบน

## วิธี deploy ให้ใช้งานได้จริงบนอินเทอร์เน็ต (ฟรี, แนะนำ: Render)

GitHub ใช้เก็บโค้ดอย่างเดียว ส่วนที่ต้อง "รัน" ให้ไปสมัครโฮสต์ที่รองรับ Node.js
ต่อไปนี้คือขั้นตอนกับ [Render.com](https://render.com) (มี free tier):

1. **Push โค้ดทั้งหมด** (ทุกไฟล์ในโฟลเดอร์นี้ ยกเว้น `.env` และ `node_modules`) ขึ้น GitHub repo
   — ไม่ใช่แค่ `index.html` แล้ว ต้องมี `server.js`, `package.json`, `assets/` ไปด้วย
2. เข้า Render → **New +** → **Web Service** → เชื่อมกับ GitHub repo นี้
3. ตั้งค่า:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. ไปที่แท็บ **Environment** ใส่ตัวแปรเหล่านี้ (ค่าเดียวกับที่ตั้งใน `.env` ตอนทดสอบในเครื่อง):
   - `ADMIN_USERNAME`
   - `ADMIN_PASSWORD_HASH`
   - `JWT_SECRET`
   - `JWT_EXPIRES_IN` (เช่น `2h`)
5. กด **Deploy** — รอสักครู่ Render จะให้โดเมนมา เช่น `https://aurora-hub.onrender.com`
   เปิดโดเมนนั้นได้เลย ทุกอย่าง (login, dashboard, เติมพอยท์, เช่าโปรแกรม) ทำงานจริงบนโดเมนนี้

ไม่ต้องแก้ `assets/shared.js` เพิ่มเติม เพราะ `API_BASE_URL` ตั้งเป็นค่าว่างไว้แล้ว
(เรียก API แบบ same-origin กับหน้าเว็บอัตโนมัติ ไม่ว่าจะรันในเครื่องหรือบน Render)

> ถ้ายังอยากใช้ GitHub Pages โชว์หน้าเว็บ (แค่ frontend เฉยๆ) ก็ทำได้ แต่ต้องแก้
> `API_BASE_URL` ใน `assets/shared.js` ให้ชี้ไปที่โดเมน backend ที่ deploy แยกไว้ (เช่น Render)
> แทน — แต่วิธีในข้อ 1-5 ด้านบนง่ายกว่า เพราะรันทุกอย่างจากที่เดียว

## API endpoints ที่มีให้แล้ว

| Method | Path             | ต้องล็อกอิน | คำอธิบาย |
|--------|------------------|:---:|---|
| POST   | `/api/login`     | ❌ | ล็อกอิน รับ `{ username, password }` คืน `{ token, user }` |
| GET    | `/api/me`        | ✅ | ข้อมูลผู้ใช้ปัจจุบัน + พอยท์ล่าสุด |
| GET    | `/api/packages`  | ✅ | รายการแพ็กเกจเติมพอยท์ |
| POST   | `/api/topup`     | ✅ | เติมพอยท์ตาม `{ packageId }` |
| GET    | `/api/services`  | ✅ | รายการโปรแกรมช่วยเล่น พร้อมสถานะการเช่าของผู้ใช้ |
| POST   | `/api/rent`      | ✅ | เช่าโปรแกรมด้วย `{ serviceId }` หักพอยท์อัตโนมัติ |
| GET    | `/api/admin/ping`| ✅ (admin เท่านั้น) | ตัวอย่าง route เฉพาะแอดมิน |

## ข้อจำกัดที่ยังเหลืออยู่ (สำคัญมาก ต้องแก้ก่อนเปิดขายจริง)

- **มีผู้ใช้ได้แค่คนเดียว (แอดมิน) และข้อมูลอยู่ใน RAM** — พอยท์/การเช่าจะหายทุกครั้งที่
  เซิร์ฟเวอร์รีสตาร์ทหรือ redeploy และตอนนี้ยังไม่มีระบบ "สมัครสมาชิกใหม่" ที่ใช้งานได้จริง
  (ปุ่มในหน้า index.html ยังเป็นแค่ลิงก์เปล่า) — ถ้าจะขายให้ลูกค้าหลายคนต้องเพิ่ม:
  1. ฐานข้อมูลจริง (PostgreSQL / MySQL / MongoDB) แทนอาเรย์ในหน่วยความจำ
  2. หน้า/route สมัครสมาชิกที่สร้างผู้ใช้ใหม่ลงฐานข้อมูลจริง
- **การเติมพอยท์ยังไม่เชื่อมระบบชำระเงินจริง** — ตอนนี้กด "เติมเลย" แล้วเพิ่มพอยท์ทันที
  ระบบจริงต้องรอยืนยันการชำระเงินก่อน (เช่น ตรวจสลิป, webhook จาก payment gateway
  อย่าง Omise / 2C2P / PromptPay QR) แล้วค่อยเพิ่มพอยท์ฝั่งเซิร์ฟเวอร์
- ตั้งค่า `cors()` ให้อนุญาตเฉพาะโดเมนจริงของคุณก่อนเปิดใช้งานสาธารณะ
- เก็บ `JWT_SECRET` และ `ADMIN_PASSWORD_HASH` เป็นความลับ ห้าม commit ขึ้น git (มี `.gitignore` กัน `.env` ไว้ให้แล้ว)

บอกได้เลยว่าอยากให้ทำข้อไหนต่อ (เช่น ต่อฐานข้อมูลจริง, ทำระบบสมัครสมาชิก,
หรือต่อระบบเติมเงินผ่าน PromptPay QR) จะช่วยต่อให้ครับ
