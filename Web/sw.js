// Service worker ตัวนี้มีไว้เพื่อให้เบราว์เซอร์นับเว็บนี้เป็น "ติดตั้งได้" (installable PWA) เท่านั้น
// ตั้งใจไม่ดัก fetch หรือแคชอะไรทั้งสิ้น เพราะข้อมูลทั้งหมดมาจาก Firebase Realtime Database
// แบบเรียลไทม์ ถ้าแคชไว้อาจทำให้เห็นข้อมูลเก่า (เช่น สถานะจ่ายเงิน) ไม่อัปเดต
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// ไม่มี fetch listener โดยตั้งใจ — ปล่อยให้ทุก request วิ่งผ่าน network ตามปกติ
