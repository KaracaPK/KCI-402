# KCI-402

เว็บจัดการข้อมูลห้องเรียน ประวัติเครดิตเงินห้อง คะแนน และการเงินของแอดมิน

## โครงสร้าง

- `Web/` — หน้าเว็บและ static assets
- `api/` — Node.js API สำหรับ login, จัดการข้อมูล, Audit Log, health และ backup/restore
- `GoogleAppsScript/` — GAS สำหรับซิงก์คะแนนอัตโนมัติ
- `Config/` — RTDB rules และการตั้งค่าที่ไม่ใช่ private key
- `vercel.json` — ให้ Vercel เสิร์ฟ static site จาก `Web/` และรัน Function ใน `api/`

## Deploy

เชื่อม repository กับ Vercel โดยตั้ง Root Directory เป็น `./`, Framework เป็น `Other`, Output Directory เป็น `Web` และปล่อย Build Command ว่าง จากนั้นตั้ง Firebase Service Account Environment Variables ดูรายละเอียดใน [DEPLOY.md](DEPLOY.md)

## ความปลอดภัยและการทำงาน

- Login ตรวจบัญชีผ่าน Node.js API ก่อนออก Firebase custom token; แอดมินใช้บัญชี `adminAC`, นักเรียนตรวจรหัสผ่านกับเว็บ KCI
- RTDB Rules จำกัดการอ่านข้อมูลตามบทบาทและ session; การเขียนจาก browser ถูกปิด แล้วให้ API ตรวจสิทธิ์และบันทึก Audit Log
- บัญชีแอดมินปิด/เปิดได้ ดูประวัติเบราว์เซอร์และแพลตฟอร์มที่เข้าสู่ระบบได้ และยกเลิก session รายอุปกรณ์หรือทั้งหมดได้
- Audit Log เก็บผู้แก้ เวลา เส้นทาง และค่าก่อน/หลัง รวมถึงการเปลี่ยนคะแนนจาก GAS โดยปิดการเขียนจาก browser
- Backup/restore ทำผ่าน server และฐานข้อมูลสำรอง พร้อมตรวจ checksum ก่อนกู้คืนและสร้าง safety backup ก่อนเขียนทับ
- ผู้ใช้ที่ยังไม่ล็อกอินเรียก API login ได้ แต่ไม่สามารถอ่าน RTDB โดยตรง

## GAS

ดู [GoogleAppsScript/README.md](GoogleAppsScript/README.md) สำหรับติดตั้ง trigger ซิงก์คะแนนและตั้งค่า Service Account

อย่า commit `.env`, Service Account JSON, private key หรือไฟล์ credential อื่น ๆ หากเคยเผยแพร่ private key ให้เพิกถอนและสร้าง key ใหม่ทันที
