// สคริปต์ช่วยสร้าง bcrypt hash จากรหัสผ่าน
// ใช้งาน:  node hash-password.js "รหัสผ่านของคุณ"
// แล้วนำค่า hash ที่ได้ไปวางใน .env -> ADMIN_PASSWORD_HASH

const bcrypt = require('bcryptjs');

const plainPassword = process.argv[2];

if (!plainPassword) {
  console.error('กรุณาระบุรหัสผ่าน เช่น: node hash-password.js "MyPassword123"');
  process.exit(1);
}

const SALT_ROUNDS = 12;
const hash = bcrypt.hashSync(plainPassword, SALT_ROUNDS);

console.log('\nHash ที่ได้ (นำไปวางใน .env เป็นค่า ADMIN_PASSWORD_HASH):\n');
console.log(hash);
console.log('');
