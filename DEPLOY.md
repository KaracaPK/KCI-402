# Deploy KCI-402 บน Vercel

## ไฟล์ที่ต้องอยู่ใน GitHub

เก็บ `Web/`, `api/`, `package.json`, `vercel.json`, `README.md`, `.env.example`, `.gitignore`, `.vercelignore`, `DEPLOY.md`, `Config/` เฉพาะไฟล์ตั้งค่าที่ไม่มี private key และ `GoogleAppsScript/` ถ้าต้องการเก็บซอร์ส GAS

**ห้ามอัปโหลด Service Account JSON, `.env`, private key หรือรหัสผ่านนักเรียน** ไฟล์ `Config/kci-web-firebase-adminsdk-*.json` ถูกกันด้วย `.gitignore` อยู่แล้ว ให้ตรวจหน้า GitHub ก่อน push ทุกครั้ง

## ตั้งค่าโปรเจกต์ Vercel

1. Import repository จาก GitHub
2. Root Directory: `./`
3. Framework Preset: `Other`
4. Output Directory: `Web` (กำหนดไว้ใน `vercel.json`)
5. ไม่ต้องกำหนด Build Command; Vercel จะติดตั้ง dependency จาก `package.json` และสร้าง Node.js Function จาก `api/index.js`

## Environment Variables ของ Vercel

เพิ่มค่าต่อไปนี้ใน Production และ Preview:

| Key | ค่า |
| --- | --- |
| `FIREBASE_DB_URL` | URL ของ RTDB หลัก `https://kci-web-default-rtdb.asia-southeast1.firebasedatabase.app` |
| `FIREBASE_SERVICE_ACCOUNT_EMAIL` | `client_email` จาก Service Account ของโปรเจกต์หลัก |
| `FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY` | `private_key` จาก JSON key; เก็บเป็น Environment Variable เท่านั้น |
| `FIREBASE_SERVICE_ACCOUNT_PROJECT_ID` | `project_id` ของโปรเจกต์หลัก `kci-web` |
| `FIREBASE_BACKUP_DB_URL` | URL RTDB สำรอง `https://kci-web-backup-b6afd-default-rtdb.asia-southeast1.firebasedatabase.app` |
| `FIREBASE_BACKUP_SERVICE_ACCOUNT_EMAIL` | Service Account ที่เข้าถึง RTDB สำรองได้ |
| `FIREBASE_BACKUP_SERVICE_ACCOUNT_PRIVATE_KEY` | private key ของ Service Account สำรอง |
| `FIREBASE_BACKUP_SERVICE_ACCOUNT_PROJECT_ID` | `project_id` ของโปรเจกต์สำรอง `kci-web-backup-b6afd` |
| `KCI_BASE_URL` | URL เว็บ KCI (ปกติใช้ค่าตัวอย่างใน `.env.example`) |

ใช้ Service Account แยกสำหรับฐานข้อมูลสำรองจะจัดสิทธิ์ได้ตรงกว่า หากเลือกใช้ key หลักแทน ให้เพิ่ม `FIREBASE_SERVICE_ACCOUNT_EMAIL` เป็นสมาชิกในโปรเจกต์ `kci-web-backup-b6afd` ที่ **Google Cloud Console → IAM & Admin → IAM** แล้วกำหนดบทบาท **Firebase Realtime Database Admin (`roles/firebasedatabase.admin`)** มิฉะนั้น API จะอ่าน/เขียน RTDB สำรองไม่ได้ แม้ URL และกฎฐานข้อมูลถูกต้องก็ตาม ค่า private key ที่ Vercel รับได้มีทั้ง newline จริงหรือ `\\n` ในข้อความ ห้ามส่ง key มาในแชตหรือใส่ไว้ในไฟล์หน้าเว็บ

หลังเพิ่ม/แก้ Environment Variables ให้กด **Redeploy** เพื่อให้ Function โหลดค่าใหม่

## ตั้งค่า Firebase ก่อนเปิดให้ใช้งาน

1. เปิด Firebase Authentication ของโปรเจกต์หลัก เพื่อให้ผู้ใช้ sign in ด้วย custom token ได้
2. สร้าง Service Account สำหรับโปรเจกต์หลักและสำรอง ให้แต่ละบัญชีมีสิทธิ์ server-side ที่จำเป็นกับ RTDB และ Firebase Authentication
3. Deploy API รุ่นนี้บน Vercel และตั้ง Environment Variables ให้ครบ
4. จากนั้นนำ `Config/Firebase rule.json` ไป Publish ใน RTDB หลัก และ `Config/Firebase Backup rule.json` ไป Publish ใน RTDB สำรอง
5. ผู้ใช้เดิมต้องเข้าสู่ระบบใหม่หนึ่งครั้ง เพราะ token รุ่นก่อนยังไม่มี `sessionId`
6. ทดสอบ login แอดมิน/นักเรียน, การอ่านตามสิทธิ์, การแก้ข้อมูลและ Audit Log, การ backup/restore และการยกเลิก session ในบัญชีทดสอบ

กฎปิดการเขียนจาก browser ทั้งหมด การเปลี่ยนข้อมูลของแอดมินผ่าน Node API ที่ตรวจ ID token และสถานะ session แล้วบันทึก Audit Log; GAS และ API ฝั่ง server ใช้ Service Account ส่วนผู้ใช้ที่ยังไม่ล็อกอินส่งข้อมูลรับรองให้ API ตรวจแทนการอ่านฐานข้อมูลโดยตรง

## ตั้งค่า GAS สำหรับซิงก์คะแนน

ติดตั้ง `GoogleAppsScript/Code.js` ตาม [คู่มือ GAS](GoogleAppsScript/README.md) แล้วใส่ `FIREBASE_SERVICE_ACCOUNT_EMAIL` และ `FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY` ใน Script Properties ใช้บัญชีที่เข้าถึง RTDB หลักได้ GAS อ่านรหัส KCI จาก `studentCredentials/{sha256(studentId)}` ซึ่งเป็น branch ที่ browser อ่าน/เขียนไม่ได้ แล้วเขียนสถานะรอบซิงก์ไว้ใน `settings/scoreSync`

ถ้ามีข้อมูลเก่าที่เก็บรหัสไว้ใน `members.lastPassword` ให้แอดมิน login หลัง deploy API หนึ่งครั้งเพื่อย้ายค่าเข้า branch private ก่อนติดตั้ง/รัน trigger ใหม่

## ข้อควรทราบ

- ระบบต้องตั้ง Service Account บน Vercel; API จะไม่ทำงานด้วยการเปิด `Web/index.html` จากไฟล์โดยตรง
- GAS และ Node.js ต้องเข้าถึง Firebase ได้ด้วยบัญชีบริการที่เหมาะสม ไม่ใช้ `FIREBASE_AUTH_KEY` หรือ Database Secret แบบเก่า
- Credential สำหรับซิงก์ KCI ยังเป็นข้อมูลละเอียดอ่อนใน RTDB private branch เพราะ GAS ต้องใช้ล็อกอินเว็บโรงเรียน จำกัด Service Account และผู้แก้ Apps Script ให้เฉพาะผู้ดูแลที่เชื่อถือได้
- กฎที่แก้ในไฟล์ยังไม่มีผลกับ Firebase Console จนกว่าจะ Publish เอง
- ห้าม Publish กฎหลักก่อน API รุ่นนี้ขึ้น Vercel เพราะกฎต้องใช้ทะเบียน `system/sessionDevices` ที่สร้างตอน login และจะปฏิเสธ token รุ่นเก่าที่ไม่มี `sessionId`
