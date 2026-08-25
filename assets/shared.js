// ตั้งค่ากลาง — ปล่อยเป็นค่าว่างไว้แบบนี้ได้เลย เพราะตอนนี้ server.js
// เสิร์ฟทั้งหน้าเว็บและ API จากที่เดียวกัน (same origin) ทั้งตอนรันในเครื่อง
// และตอนขึ้น production จึงไม่ต้องแก้ค่านี้อีก
// (ใช้กรณีแยก backend ไปคนละโดเมน/พอร์ตเท่านั้น เช่น 'https://api.yoursite.com')
const API_BASE_URL = '';

// เก็บ token ด้วย sessionStorage เพื่อให้ใช้งานข้ามหน้า (index.html -> dashboard.html) ได้จริง
// หมายเหตุ: หากดูตัวอย่างหน้านี้ผ่านหน้าต่างแชทของ Claude โดยตรง sessionStorage อาจใช้งานไม่ได้
// เนื่องจากข้อจำกัดของแซนด์บ็อกซ์ในตัวอย่าง (artifact) — ให้ดาวน์โหลดไฟล์ไปรันเองหรือรันผ่าน server จริง
const AuthStore = {
  KEY_TOKEN: 'ah_token',
  KEY_USER: 'ah_user',
  save(token, user) {
    try {
      sessionStorage.setItem(this.KEY_TOKEN, token);
      sessionStorage.setItem(this.KEY_USER, JSON.stringify(user));
    } catch (e) {
      console.warn('sessionStorage ใช้งานไม่ได้ในสภาพแวดล้อมนี้:', e);
    }
  },
  getToken() {
    try { return sessionStorage.getItem(this.KEY_TOKEN); } catch (e) { return null; }
  },
  getUser() {
    try {
      const raw = sessionStorage.getItem(this.KEY_USER);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  },
  clear() {
    try {
      sessionStorage.removeItem(this.KEY_TOKEN);
      sessionStorage.removeItem(this.KEY_USER);
    } catch (e) { /* noop */ }
  },
};

function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.remove('show'), 2600);
}

function openModal(id) { document.getElementById(id)?.classList.add('open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.modal-overlay').forEach((ov) => {
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.classList.remove('open'); });
  });
});

// เรียก API แบบแนบ token อัตโนมัติ และเด้งกลับหน้า login ถ้า token หมดอายุ/ไม่ถูกต้อง
async function apiFetch(path, options = {}) {
  const token = AuthStore.getToken();
  const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
  if (token) headers['Authorization'] = 'Bearer ' + token;

  const res = await fetch(API_BASE_URL + path, { ...options, headers });

  if (res.status === 401) {
    AuthStore.clear();
    window.location.href = 'index.html';
    throw new Error('unauthorized');
  }
  return res;
}
