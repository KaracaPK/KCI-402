# KCI-402

## โครงสร้างโปรเจกต์

- `Web/`: หน้าเว็บและไฟล์ static
- `api/`: Node.js API ที่ Vercel เรียกใช้
- `GoogleAppsScript/`: สคริปต์ซิงก์คะแนนอัตโนมัติ แยกจาก API ของ Vercel
- `vercel.json`: ให้ Vercel เสิร์ฟ `Web/` และสร้าง Function จาก `api/`

## นำเว็บไซต์ขึ้น GitHub และ Vercel

1. Push โฟลเดอร์โปรเจกต์นี้ขึ้น GitHub โดยให้ `Web/`, `api/`, `package.json` และ `vercel.json` อยู่ที่ root ของ repository
2. ใน Vercel เลือก **Add New Project** แล้ว import repository
3. ตั้ง Root Directory เป็น `./` และ Framework Preset เป็น **Other** แล้วกด Deploy
4. ถ้า Firebase Realtime Database ต้องใช้ token ให้เพิ่ม `FIREBASE_AUTH_KEY` ใน Environment Variables ของ Vercel

Push ไปยัง branch ที่ผูกกับ Vercel จะสร้าง deployment ใหม่โดยอัตโนมัติ ไฟล์ GAS ถูกตัดออกจาก Vercel ด้วย `.vercelignore`

## ทดสอบในเครื่อง

รัน `npm run dev` แล้วเปิด `http://127.0.0.1:4173`

## ล็อกอินนักเรียนแบบเร็ว

หลังเคยล็อกอิน KCI สำเร็จ หรือ GAS ซิงก์และยืนยันรหัสสำเร็จ หน้าเว็บใช้ข้อมูลสมาชิกใน Firebase เพื่อให้ล็อกอินได้โดยไม่รอ scrape KCI ซ้ำ ภายใน 24 ชั่วโมง รหัสใหม่หรือข้อมูลยืนยันที่เก่ากว่านั้นยังต้องตรวจที่ KCI และอาจใช้เวลานานกว่า

## ข้อควรแก้ก่อนใช้ข้อมูลนักเรียนจริง

ไฟล์ `Config/Firebase rule.json` ที่ให้มาอนุญาตให้อ่านและเขียนข้อมูลสาธารณะ รวมถึง `members` และ `adminAC` ซึ่งมีรหัสผ่าน KCI สำหรับระบบซิงก์อัตโนมัติ ต้องจำกัด Firebase rules และปรับการยืนยันตัวตนก่อน deploy ใช้ข้อมูลจริง การเก็บ source ใน GitHub แบบ private ก็ไม่ได้ป้องกันคนเข้าถึง Firebase ที่เปิดสิทธิ์สาธารณะ

## ติดตั้ง GAS auto-sync

ดูขั้นตอนใน [GoogleAppsScript/README.md](GoogleAppsScript/README.md) ต้องสร้างโปรเจกต์ Apps Script และติดตั้งทริกเกอร์แยกจาก Vercel
