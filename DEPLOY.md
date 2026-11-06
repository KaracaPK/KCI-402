# วิธี Deploy เว็บไซต์ขึ้น Vercel

1. Push โฟลเดอร์โปรเจกต์นี้ขึ้น GitHub โดยเก็บ `Web/`, `api/`, `package.json` และ `vercel.json` ไว้ที่ root
2. ใน Vercel import GitHub repository ตั้ง Root Directory เป็น `./` และ Framework Preset เป็น **Other**
3. Deploy ได้เลย: Vercel จะเสิร์ฟไฟล์จาก `Web/` และรัน Node.js API จาก `api/`
4. เพิ่ม `FIREBASE_AUTH_KEY` ใน Environment Variables หาก Firebase rules ของโปรเจกต์ต้องใช้ token

การตั้งค่านี้ให้ Vercel deploy ใหม่เมื่อมี push ไปยัง branch ที่เชื่อมไว้ ไฟล์ใน `GoogleAppsScript/` แยกอยู่นอกเว็บและถูกกันออกจาก Vercel ด้วย `.vercelignore`
