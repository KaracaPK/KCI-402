const { createHash, randomBytes } = require('node:crypto');

// Native Node.js HTTP helper used by the KCI scraper and Firebase REST calls.
async function httpFetch(url, options = {}) {
    const { method = 'get', payload, contentType, headers = {}, followRedirects = true } = options;
    const requestHeaders = new Headers(headers);
    if (contentType && !requestHeaders.has('content-type')) requestHeaders.set('content-type', contentType);
    else if (payload !== undefined && typeof payload !== 'string' && !requestHeaders.has('content-type')) requestHeaders.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
    let body;
    if (payload !== undefined && !['get', 'head'].includes(String(method).toLowerCase())) {
      if (typeof payload === 'string') body = payload;
      else if (contentType && contentType.includes('application/json')) body = JSON.stringify(payload);
      else body = new URLSearchParams(Object.entries(payload).map(([key, value]) => [key, String(value)])).toString();
    }
    const response = await fetch(url, {
      method: String(method).toUpperCase(),
      headers: requestHeaders,
      ...(body === undefined ? {} : { body }),
      redirect: followRedirects === false ? 'manual' : 'follow',
      signal: AbortSignal.timeout(12000)
    });
    const responseHeaders = Object.fromEntries(response.headers.entries());
    const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    if (cookies.length) {
      responseHeaders['Set-Cookie'] = cookies;
      responseHeaders['set-cookie'] = cookies;
    }
    const text = await response.text();
    return {
      getResponseCode: () => response.status,
      getContentText: () => text,
      getHeaders: () => responseHeaders
    };
}

/**
 * 4/2 Hub — Node.js API for Vercel
 * ดึงข้อมูลจากเว็บ KCI และอัปเดตลง Firebase Realtime Database
 */

// ──────────────────────────────────────────
// CONFIGURATION (ตั้งค่าตรงนี้)
// ──────────────────────────────────────────
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL || "https://kci-web-default-rtdb.asia-southeast1.firebasedatabase.app";
const FIREBASE_AUTH_KEY = process.env.FIREBASE_AUTH_KEY || "";
const BASE_URL = process.env.KCI_BASE_URL || "https://kci.xn--12c1bpbba3dcfr1jra8c9bzgl.com";

// ── Admin helpers: hashing, lookup, and admin CRUD endpoints ──
function hashPassword(pw, salt){
  return createHash('sha256').update(String(pw) + (salt || '')).digest('hex');
}
function generateSalt(){ return randomBytes(8).toString('hex'); }

async function getAdminByUsername(username){
  const url = `${FIREBASE_DB_URL}/adminAC.json${FIREBASE_AUTH_KEY ? '?auth=' + FIREBASE_AUTH_KEY : ''}`;
  const res = await httpFetch(url);
  const all = JSON.parse(res.getContentText()) || {};
  for(const uid in all){
    if(String(all[uid].username) === String(username)) return { uid: uid, admin: all[uid] };
  }
  return null;
}

async function verifyAdminCredentials(username, password){
  const r = await getAdminByUsername(username);
  if(!r) return { success: false };
  const a = r.admin;
  if(a.passwordHash && a.salt){
    const h = hashPassword(password, a.salt);
    return { success: h === a.passwordHash, uid: r.uid, admin: a };
  }
  // legacy fallback: plaintext password field (if any)
  if(a.password){
    return { success: String(a.password) === String(password), uid: r.uid, admin: a };
  }
  return { success: false };
}

async function handleAdminLogin(params){
  const username = params.username || params.user;
  const password = params.password || params.pass;
  if(!username || !password) return makeJSONResponse({ success:false, message:'Missing username or password' });
  const v = await verifyAdminCredentials(username, password);
  if(!v.success) return makeJSONResponse({ success:false, message:'Invalid admin credentials' });
  // update lastLogin
  try{
    const updateUrl = `${FIREBASE_DB_URL}/adminAC/${v.uid}.json${FIREBASE_AUTH_KEY ? '?auth=' + FIREBASE_AUTH_KEY : ''}`;
    await httpFetch(updateUrl, { method:'patch', contentType:'application/json', payload: JSON.stringify({ lastLogin: Date.now() }) });
  }catch(e){}
  return makeJSONResponse({ success:true, username: v.admin.username, name: v.admin.name||v.admin.username, avatar: v.admin.avatar||null });
}

async function handleAdminCreate(params){
  const reqUser = params.reqUser; const reqPass = params.reqPass;
  if(!reqUser || !reqPass) return makeJSONResponse({ success:false, message:'Not authorized' });
  const auth = await verifyAdminCredentials(reqUser, reqPass);
  if(!auth.success) return makeJSONResponse({ success:false, message:'Not authorized' });
  const newUser = params.newUser || params.username;
  const newPass = params.newPass || params.password;
  const name = params.name || newUser;
  const avatar = params.avatar || null;
  if(!newUser || !newPass) return makeJSONResponse({ success:false, message:'Missing newUser/newPass' });
  if(await getAdminByUsername(newUser)) return makeJSONResponse({ success:false, message:'Admin already exists' });
  const salt = generateSalt();
  const passwordHash = hashPassword(newPass, salt);
  const payload = { username: newUser, name: name, passwordHash: passwordHash, salt: salt, avatar: avatar, createdAt: Date.now() };
  const postUrl = `${FIREBASE_DB_URL}/adminAC.json${FIREBASE_AUTH_KEY ? '?auth=' + FIREBASE_AUTH_KEY : ''}`;
  await httpFetch(postUrl, { method:'post', contentType:'application/json', payload: JSON.stringify(payload) });
  return makeJSONResponse({ success:true, message: 'Admin created' });
}

async function handleAdminDelete(params){
  const reqUser = params.reqUser; const reqPass = params.reqPass;
  if(!reqUser || !reqPass) return makeJSONResponse({ success:false, message:'Not authorized' });
  const auth = await verifyAdminCredentials(reqUser, reqPass);
  if(!auth.success) return makeJSONResponse({ success:false, message:'Not authorized' });
  const target = params.target || params.username || params.deleteUser;
  if(!target) return makeJSONResponse({ success:false, message:'Missing target username' });
  const existing = await getAdminByUsername(target);
  if(!existing) return makeJSONResponse({ success:false, message:'Target admin not found' });
  const delUrl = `${FIREBASE_DB_URL}/adminAC/${existing.uid}.json${FIREBASE_AUTH_KEY ? '?auth=' + FIREBASE_AUTH_KEY : ''}`;
  await httpFetch(delUrl, { method:'delete' });
  return makeJSONResponse({ success:true, message:'Admin deleted' });
}

async function handleAdminUpdate(params){
  const reqUser = params.reqUser; const reqPass = params.reqPass;
  if(!reqUser || !reqPass) return makeJSONResponse({ success:false, message:'Not authorized' });
  const auth = await verifyAdminCredentials(reqUser, reqPass);
  if(!auth.success) return makeJSONResponse({ success:false, message:'Not authorized' });

  // find target by uid or username
  let targetUid = params.uid || params.targetUid || null;
  let existing = null;
  if(targetUid){
    try{
      const url = `${FIREBASE_DB_URL}/adminAC/${targetUid}.json${FIREBASE_AUTH_KEY ? '?auth=' + FIREBASE_AUTH_KEY : ''}`;
      const res = await httpFetch(url);
      const obj = JSON.parse(res.getContentText()) || null;
      if(obj) existing = { uid: targetUid, admin: obj };
    }catch(e){}
  }
  if(!existing && params.username){
    const r = await getAdminByUsername(params.username);
    if(r) existing = r;
  }
  if(!existing) return makeJSONResponse({ success:false, message:'Target admin not found' });

  const updates = {};
  if(typeof params.name !== 'undefined') updates.name = params.name || '';
  if(typeof params.avatar !== 'undefined') updates.avatar = params.avatar || null;
  if(params.newPass){
    const salt = generateSalt();
    updates.passwordHash = hashPassword(params.newPass, salt);
    updates.salt = salt;
    updates.password = null;
  }
  if(params.newUsername){
    const found = await getAdminByUsername(params.newUsername);
    if(found && found.uid !== existing.uid) return makeJSONResponse({ success:false, message:'Username already exists' });
    updates.username = params.newUsername;
  }

  const patchUrl = `${FIREBASE_DB_URL}/adminAC/${existing.uid}.json${FIREBASE_AUTH_KEY ? '?auth=' + FIREBASE_AUTH_KEY : ''}`;
  await httpFetch(patchUrl, { method:'patch', contentType:'application/json', payload: JSON.stringify(updates) });
  return makeJSONResponse({ success:true, message:'Admin updated' });
}

// ──────────────────────────────────────────
// 1. API GATEWAY (doPost) - สำหรับหน้าเว็บส่งข้อมูลมาล็อกอิน
// ──────────────────────────────────────────
async function doPost(e) {
  try {
    const params = e;

    // Support admin actions via the Node.js API (adminLogin, adminCreate, adminDelete)
    if(params.action){
      if(params.action === 'adminLogin') return await handleAdminLogin(params);
      if(params.action === 'adminCreate') return await handleAdminCreate(params);
      if(params.action === 'adminDelete') return await handleAdminDelete(params);
      if(params.action === 'adminUpdate') return await handleAdminUpdate(params);
      // unknown action falls through to normal KCI login
    }

    const username = params.username;
    const password = params.password;

    if (!username || !password) {
      return makeJSONResponse({ success: false, message: "กรุณากรอก Username และ Password" });
    }

    // ทำการล็อกอินเว็บ KCI และดึงข้อมูล
    const result = await scrapeKCIScores(username, password);

    // ถ้ารหัสผิด (หรือระบบคืนค่าไม่สำเร็จ) ให้ส่งกลับหน้าเว็บทันที
    // พร้อมข้อความชัดเจนว่าล็อกอิน KCI ไม่สำเร็จ
    if (!result.success) {
      return makeJSONResponse({ 
        success: false, 
        message: result.message,
        source: "KCI_AUTH_FAILED"
      });
    }

    // ถ้าสำเร็จ บันทึก/อัปเดต ข้อมูลลง Firebase RTDB
    await saveOrUpdateStudentToFirebase(username, result);

    return makeJSONResponse({
      success:     true,
      student:     result.student,
      tel:         result.tel,
      scores:      result.scores,
      classroom:   result.classroom,
      goodReports: result.goodReports || [],
      badReports:  result.badReports  || [],
      message:     "ซิงค์ข้อมูลลงฐานข้อมูลสำเร็จ"
    });

  } catch (err) {
    return makeJSONResponse({ success: false, message: "เกิดข้อผิดพลาดที่เซิร์ฟเวอร์ Node.js: " + err.toString() });
  }
}

// ──────────────────────────────────────────
// 2. CORE SCRAPER - ฟังก์ชันล็อกอินและดึงข้อมูล KCI (ถอดรหัส TIS-620)
// ──────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// scrapeKCIScores — ใช้ Cookie Jar เพื่อให้ PHP session สมบูรณ์
// flow: login → follow redirect → main-stu.php → pub_stu.php
// ─────────────────────────────────────────────────────────────
async function scrapeKCIScores(username, password) {

  const BASE     = `${BASE_URL}/stu/`;
  const loginUrl = `${BASE}index.php`;
  const mainUrl  = `${BASE}main-stu.php`;
  const pubUrl   = `${BASE}pub_stu.php`;

  // ── Cookie Jar ──────────────────────────────────────────────
  // สะสม cookies จากทุก response เพื่อส่งไปทุก request ต่อๆไป
  // (เหมือน browser ที่เก็บ cookie อัตโนมัติ)
  const jar = {};

  function updateJar(setCookieHeader) {
    if (!setCookieHeader) return;
    const raw = Array.isArray(setCookieHeader) ? setCookieHeader.join('\n') : setCookieHeader;
    raw.split('\n').forEach(line => {
      const kv = line.split(';')[0].trim();
      if (!kv.includes('=')) return;
      const eq = kv.indexOf('=');
      const k  = kv.substring(0, eq).trim();
      const v  = kv.substring(eq + 1).trim();
      if (k && !['path','expires','domain','samesite','httponly','max-age'].includes(k.toLowerCase())) {
        jar[k] = v;
      }
    });
  }

  function jarStr() {
    return Object.entries(jar).map(([k,v]) => `${k}=${v}`).join('; ');
  }

  // fetch แบบ followRedirects:false เพื่อดักจับ Set-Cookie ทุก step
  async function req(url, opts) {
    const res = await httpFetch(url, {
      muteHttpExceptions: true,
      followRedirects: false,
      ...(opts || {}),
      headers: Object.assign({
        'Cookie':          jarStr(),
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':          'text/html,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language': 'th,en;q=0.5'
      }, (opts && opts.headers) || {})
    });
    const h = res.getHeaders();
    updateJar(h['Set-Cookie'] || h['set-cookie']);
    return res;
  }

  // ── STEP 1: Login ────────────────────────────────────────────
  let res = await req(loginUrl, {
    method:  'post',
    payload: { user_stu: username, pass_stu: password, button2: 'เข้าสู่ระบบ' },
    headers: { Referer: loginUrl }
  });

  let loc = (res.getHeaders()['Location'] || res.getHeaders()['location'] || '').trim();
  console.log(`[${username}] Login ${res.getResponseCode()} → ${loc} | session: ${jar['PHPSESSID'] || 'ไม่มี'}`);

  if (loc.includes('notlogin')) {
    return { success: false, message: 'รหัสนักเรียนหรือรหัสผ่านไม่ถูกต้อง' };
  }
  if (!jar['PHPSESSID']) {
    return { success: false, message: 'ไม่ได้รับ session cookie จาก KCI' };
  }

  // ── STEP 2: ตาม redirect chain จนถึงหน้าที่ไม่ redirect ────────
  // (ทุก hop → PHP session ถูก initialize บน server)
  let referer    = loginUrl;
  let mainHtml   = '';
  let hops       = 0;
  const maxHops  = 6;

  while (loc && hops < maxHops) {
    const nextUrl = loc.startsWith('http') ? loc : `${BASE}${loc.replace(/^\/?(stu\/)?/, '')}`;
    res = await req(nextUrl, { headers: { Referer: referer } });
    referer = nextUrl;
    loc     = (res.getHeaders()['Location'] || res.getHeaders()['location'] || '').trim();
    hops++;
    console.log(`[${username}] hop${hops}: ${nextUrl} → ${res.getResponseCode()} ${loc ? '→'+loc : '(สิ้นสุด)'}`);
    if (!loc) mainHtml = res.getContentText('UTF-8');
  }
  if (!mainHtml) mainHtml = res.getContentText('UTF-8');

  if (mainHtml.includes('notlogin') ||
     (mainHtml.includes('index.php') && mainHtml.includes('เข้าสู่ระบบ'))) {
    return { success: false, message: 'KCI ส่งกลับหน้า login' };
  }

  // ถ้า redirect ไปที่อื่นและยังไม่ได้ main-stu.php ให้ดึงเพิ่ม
  if (!mainHtml.includes('main-stu') && !mainHtml.includes('ระบบดูแล')) {
    res = await req(mainUrl, { headers: { Referer: referer } });
    mainHtml = res.getContentText('UTF-8');
    referer  = mainUrl;
    console.log(`[${username}] force main-stu.php ${res.getResponseCode()}`);
  }

  const studentName = extractNameFromHTML(mainHtml);
  const phone       = extractPhoneFromHTML(mainHtml);
  const scores      = extractScoresFromHTML(mainHtml);
  const classroom   = extractClassroomFromHTML(mainHtml);
  console.log(`[${username}] main: ${studentName || '?'} | cookie: ${jarStr().substring(0,80)}`);

  let goodReports = [];
  let badReports = [];
  // ── STEP 3: pub_stu.php (session พร้อมแล้ว) ─────────────────
  // ✅ FIX: เดิมยิง pubUrl เปล่าๆ ไม่มีพารามิเตอร์ → KCI เอาค่าว่างไปต่อ SQL query
  // จึง error "near '' at line 1" ตอนนี้ลองหาลิงก์/ฟอร์มจริงที่หน้า main-stu.php
  // ใช้เรียก pub_stu.php ก่อน (มันน่าจะแนบพารามิเตอร์ เช่น id/type มาด้วย)
  const pubReq    = findPubStuRequest(mainHtml, BASE);
  let pubUrlUsed  = pubUrl;

  if (pubReq) {
    pubUrlUsed = pubReq.url;
    console.log(`[${username}] พบวิธีเรียก pub_stu (${pubReq.source}): ${pubReq.method.toUpperCase()} ${pubReq.url} | payload: ${pubReq.payload && Object.keys(pubReq.payload).length ? JSON.stringify(pubReq.payload) : '(ว่างเปล่า/ไม่มี field)'}`);
    if (pubReq.rawFormPreview) {
      console.log(`[${username}] pub_stu form ดิบ (400 ตัวแรก): ${pubReq.rawFormPreview}`);
    }
    res = await req(pubReq.url, {
      method: pubReq.method,
      ...(pubReq.payload && Object.keys(pubReq.payload).length ? { payload: pubReq.payload } : {}),
      headers: { Referer: mainUrl }
    });
  } else {
    const pIdx = mainHtml.indexOf('pub_stu');
    if (pIdx !== -1) {
      console.log(`[${username}] เจอคำว่า "pub_stu" ใน mainHtml แต่จับลิงก์/ฟอร์มด้วย regex ไม่ได้ บริเวณนั้น: ...${mainHtml.substring(Math.max(0, pIdx - 120), pIdx + 180).replace(/\s+/g, ' ')}...`);
    } else {
      console.log(`[${username}] ⚠️ ไม่พบคำว่า "pub_stu" เลยใน mainHtml — หน้ารายงานอาจต้องกดผ่านเมนู/ลิงก์อื่นก่อนถึงจะมี URL นี้โผล่มา`);
    }
    res = await req(pubUrl, { headers: { Referer: mainUrl } });
  }

  const pubHtml = res.getContentText('UTF-8');
  const pubPrev = pubHtml.substring(0, 160).replace(/\s+/g, ' ');
  console.log(`[${username}] pub_stu ${res.getResponseCode()} | ${pubPrev}`);

  // ถ้ายังเจอ SQL error → log รายละเอียดเพิ่ม (URL ที่ยิงจริง จะได้รู้ว่าใช้ fallback หรือลิงก์ที่เจอ)
  if (pubHtml.includes('SQL syntax')) {
    console.warn(`[${username}] pub_stu: SQL error — URL ที่ยิงจริง: ${pubUrlUsed} | cookie: ${jarStr()}`);
  }

  // parse ทั้ง 2 ตาราง (ทั้งคู่ class="three" แยกด้วย position)
  ({ goodReports, badReports } = parseAllReportTables(pubHtml));
  console.log(`[${username}] ✅ ความดี ${goodReports.length} | ประพฤติ ${badReports.length}`);

  return {
    success:     true,
    student:     studentName,
    tel:         phone || '—',
    scores:      scores,
    classroom:   classroom || null,
    password:    password,
    goodReports: goodReports,
    badReports:  badReports
  };
}

// ─────────────────────────────────────────────────────────────
// findPubStuRequest — หาลิงก์/ฟอร์มจริงที่หน้า main-stu.php ใช้เรียก pub_stu.php
// เพราะยิง pub_stu.php เปล่าๆ (ไม่มีพารามิเตอร์) แล้ว KCI คืน SQL syntax error
// แปลว่าเพจจริงต้องมีพารามิเตอร์ (เช่น id/type/token) แนบไปด้วยแน่ๆ — ฟังก์ชันนี้
// พยายามงมหาพารามิเตอร์นั้นจาก <a href>, <form action>, หรือ string ดิบใน HTML
//
// หมายเหตุ: ดึง name/value ของแต่ละ <input> แยกจากกันโดยไม่สนลำดับ attribute
// (บางเว็บเขียน value ก่อน name) และไม่บังคับว่าต้องมี quote ครอบ เผื่อ HTML เก่าๆ
// ไม่ครบมาตรฐาน — เดิมใช้ regex ตัวเดียวจับทั้ง tag ซึ่งพลาดกรณีสลับลำดับ
// ─────────────────────────────────────────────────────────────
function findPubStuRequest(html, base) {
  const originMatch = base.match(/^https?:\/\/[^\/]+/i);
  const origin = originMatch ? originMatch[0] : '';

  function resolve(path) {
    if (/^https?:\/\//i.test(path)) return path;
    if (path.startsWith('/')) return `${origin}${path}`;
    return `${base}${path}`;
  }

  function getAttr(tag, attr) {
    // รองรับทั้ง attr="val", attr='val', และ attr=val (ไม่มี quote)
    const m = tag.match(new RegExp(`\\b${attr}\\s*=\\s*(?:["']([^"']*)["']|([^\\s>]+))`, 'i'));
    if (!m) return null;
    return m[1] !== undefined ? m[1] : m[2];
  }

  // 1) <a href="...pub_stu.php...">...</a>  — วิธีที่พบบ่อยที่สุด
  const a = html.match(/<a[^>]+href=["']([^"']*pub_stu\.php[^"']*)["']/i);
  if (a) {
    return { method: 'get', url: resolve(a[1].replace(/&amp;/gi, '&')), source: 'a-tag' };
  }

  // 2) <form action="...pub_stu.php..." method="...">...hidden input/select...</form>
  const f = html.match(/<form[^>]+action=["']([^"']*pub_stu\.php[^"']*)["'][^>]*>([\s\S]*?)<\/form>/i);
  if (f) {
    const action = resolve(f[1].replace(/&amp;/gi, '&'));
    const isPost = /method\s*=\s*["']?post["']?/i.test(f[0]);
    const body   = f[2];
    const inputs = {};

    // 2a) <input ...> ทุกตัว — แกะ name/value อิสระจากกัน ไม่สนลำดับ/quote
    const inputTagRe = /<input\b[^>]*>/gi;
    let tagM;
    while ((tagM = inputTagRe.exec(body)) !== null) {
      const name = getAttr(tagM[0], 'name');
      if (!name) continue;
      inputs[name] = getAttr(tagM[0], 'value') || '';
    }

    // 2b) <select name="..."><option selected value="...">...</select> (ถ้ามี)
    const selectTagRe = /<select\b[^>]*>[\s\S]*?<\/select>/gi;
    let selM;
    while ((selM = selectTagRe.exec(body)) !== null) {
      const selTag = selM[0];
      const selName = getAttr(selTag, 'name');
      if (!selName) continue;
      const selectedOpt = selTag.match(/<option\b[^>]*\bselected\b[^>]*>/i);
      const firstOpt     = selTag.match(/<option\b[^>]*>/i);
      const optTag = selectedOpt ? selectedOpt[0] : (firstOpt ? firstOpt[0] : null);
      inputs[selName] = optTag ? (getAttr(optTag, 'value') || '') : '';
    }

    const rawFormPreview = body.substring(0, 400).replace(/\s+/g, ' ').trim();
    const result = { method: isPost ? 'post' : 'get', url: action, source: 'form', rawFormPreview, fieldCount: Object.keys(inputs).length };

    if (isPost) return { ...result, payload: inputs };
    const qs = Object.entries(inputs)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    return { ...result, url: qs ? `${action}${action.includes('?') ? '&' : '?'}${qs}` : action };
  }

  // 3) fallback แบบกว้าง: หา "pub_stu.php?..." ที่ไหนก็ได้ใน HTML (เช่นใน <script> หรือ onclick)
  const loose = html.match(/pub_stu\.php(\?[^"'\s<>]+)/i);
  if (loose) {
    return { method: 'get', url: `${base}pub_stu.php${loose[1].replace(/&amp;/gi, '&')}`, source: 'loose-string' };
  }

  return null;
}

// ──────────────────────────────────────────
// 4. DATABASE SYNC ENGINE - จัดการอัปเดตข้อมูลเข้า Firebase
// ──────────────────────────────────────────
async function saveOrUpdateStudentToFirebase(username, data) {
  const queryUrl = `${FIREBASE_DB_URL}/members.json${FIREBASE_AUTH_KEY ? '?auth=' + FIREBASE_AUTH_KEY : ''}`;
  const response = await httpFetch(queryUrl);
  const members = JSON.parse(response.getContentText()) || {};

  let existingUid = null;

  for (const [uid, m] of Object.entries(members)) {
    if (String(m.studentId) === String(username)) {
      existingUid = uid;
      break;
    }
  }

  const now = Date.now();

  // สร้าง payload พื้นฐาน (ไม่รวม name ก่อน)
  const payload = {
    studentId:    username,
    tel:          data.tel,
    classroom:    data.classroom || null,
    scores:       data.scores,
    lastPassword: data.password,
    lastLogin:    now
  };
  if (data.goodReports && data.goodReports.length > 0) payload.goodReports = data.goodReports;
  if (data.badReports  && data.badReports.length  > 0) payload.badReports  = data.badReports;
  if ((data.goodReports && data.goodReports.length > 0) ||
      (data.badReports  && data.badReports.length  > 0)) payload.reportsUpdatedAt = now;

  // ✅ FIX: เพิ่ม name เฉพาะเมื่อดึงชื่อจาก KCI ได้สำเร็จเท่านั้น
  // ถ้าดึงไม่ได้ (null/empty) จะไม่บันทึก/เขียนทับชื่อเดิม
  const scrapedName = data.student && typeof data.student === 'string' ? data.student.trim() : null;
  if (scrapedName) {
    payload.name = scrapedName;
  }

  if (existingUid) {
    // 🔄 มีข้อมูลอยู่แล้ว: อัปเดตข้อมูลนักเรียนเก่า
    // ถ้าดึงชื่อไม่ได้ → payload ไม่มี field "name" → PATCH จะไม่แตะชื่อเดิมใน DB เลย
    const updateUrl = `${FIREBASE_DB_URL}/members/${existingUid}.json${FIREBASE_AUTH_KEY ? '?auth=' + FIREBASE_AUTH_KEY : ''}`;
    await httpFetch(updateUrl, {
      method: "patch",
      contentType: "application/json",
      payload: JSON.stringify(payload)
    });
  } else {
    // ✨ ไม่มีข้อมูล: เพิ่มข้อมูลนักเรียนใหม่
    // ✅ FIX: role เริ่มต้นเป็น "guest" เสมอ รอให้ Admin อนุมัติก่อน
    payload.role = "guest";
    payload.room = data.classroom || null;
    payload.tag = "นักเรียน";
    payload.createdAt = now;

    // ถ้าดึงชื่อไม่ได้ → สร้าง record โดยไม่มี field "name" ดีกว่าใส่ "ไม่ระบุชื่อ" หรือ ""
    const insertUrl = `${FIREBASE_DB_URL}/members.json${FIREBASE_AUTH_KEY ? '?auth=' + FIREBASE_AUTH_KEY : ''}`;
    await httpFetch(insertUrl, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload)
    });
  }
}

// ──────────────────────────────────────────
// 5. PARSER HELPERS (Regular Expressions)
// ──────────────────────────────────────────
function extractNameFromHTML(html) {

  // ── วิธีที่ 0A (New): ใช้ matchAll หา input tag ทั้งหมด แล้ว filter name="input" หรือ id="input"
  // รองรับ newline ใน HTML โดยใช้ [\s\S]*? (dotall-like behavior)
  try {
    const inputTags = html.matchAll(/<input\b[\s\S]*?\/?\s*>/gi);
    for (const match of inputTags) {
      const tag = match[0];
      // เช็คว่าเป็น input ที่มี name="input" หรือ id="input" (และไม่ใช่ type="image")
      if ((/name=["']input["']/i.test(tag) || /id=["']input["']/i.test(tag)) &&
          !/type=["']image["']/i.test(tag)) {
        // ดึง value จาก tag นี้ - รองรับหลาย patterns
        const valuePatterns = [
          /value=["']([^"']{4,60})["']/i,    // ปกติ: value="..." (รองรับ newline)
          /value=([^\s>"']{4,60})/i,              // ไม่มี quote: value=...
        ];
        for (const vp of valuePatterns) {
          const vm = tag.match(vp);
          if (vm && vm[1] && vm[1].trim()) {
            const cleanName = vm[1].replace(/\s+/g, ' ').trim();
            if (cleanName.length >= 4 && cleanName.length < 60 &&
                !/function|var |</.test(cleanName) &&
                isValidThaiName(cleanName)) {
              return cleanName;
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn("input matchAll failed:", e);
  }

  // ── วิธีที่ 0B (Legacy): name="input" ก่อน value
  const inputMatch1 = html.match(/name=["']input["'][^>]*value=["']([^"']{4,60})["']/i);
  if (inputMatch1 && inputMatch1[1].trim() && !/function|var |</.test(inputMatch1[1])) {
    const cleanName = inputMatch1[1].replace(/\s+/g, ' ').trim();
    if (isValidThaiName(cleanName)) return cleanName;
  }
  // กรณี value อยู่ก่อน name="input"
  const inputMatch2 = html.match(/value=["']([^"']{4,60})["'][^>]*name=["']input["']/i);
  if (inputMatch2 && inputMatch2[1].trim() && !/function|var |</.test(inputMatch2[1])) {
    const cleanName = inputMatch2[1].replace(/\s+/g, ' ').trim();
    if (isValidThaiName(cleanName)) return cleanName;
  }

  // ── วิธีที่ 1 (Enhanced): ดึงจาก <span class="text12"> หรือ <span class="textnamal">
  // KCI ใช้ text12 สำหรับชื่อนักเรียน (อาจ nested ใน textnamal)
  try {
    const spanPatterns = [
      /<span[^>]*\bclass=["']text12["'][^>]*>([\s\S]{3,60}?)<\/span>/i,
      /<span[^>]*\bclass=["']textnamal["'][^>]*>\s*(?:<[^>]*>)?\s*([\s\S]{3,60}?)<\/span>/i,
    ];
    for (const sp of spanPatterns) {
      const sm = html.match(sp);
      if (sm && sm[1]) {
        const n = sm[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
        if (n.length >= 3 && n.length < 60 && !/function|var </.test(n) &&
            isValidThaiName(n)) {
          return n;
        }
      }
    }
  } catch (e) {
    console.warn("text12 match failed:", e);
  }

  // ── วิธีที่ 2 (Enhanced): flexible patterns รองรับ newline
  try {
    const flexiblePatterns = [
      /<input\b[\s\S]{0,200}?\b(name|id)=["']input["'][\s\S]{0,200}?value=["']([^"']{4,60})["'][\s\S]{0,50}?>/i,
      /<input\b[\s\S]{0,200}?value=["']([^"']{4,60})["'][\s\S]{0,200}?\b(name|id)=["']input["'][\s\S]{0,50}?>/i,
    ];
    for (const fp of flexiblePatterns) {
      const fm = html.match(fp);
      if (fm) {
        const captured = fm[2] || fm[1];
        if (captured && captured.trim().length >= 4) {
          const cleanName = captured.replace(/\s+/g, ' ').trim();
          if (cleanName.length < 60 && isValidThaiName(cleanName)) {
            return cleanName;
          }
        }
      }
    }
  } catch (e) {
    console.warn("flexible input match failed:", e);
  }

  // ── วิธีที่ 3: ล้าง HTML tags แล้วหาจากคำนำหน้าชื่อ (text-only fallback)
  const textOnly = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const prefixes = ['นาย', 'นางสาว', 'นาง', 'เด็กชาย', 'เด็กหญิง', 'ด\.ช\.', 'ด\.ญ\.'];

  for (const prefix of prefixes) {
    const escapedPrefix = prefix.replace(/\\/g, '\\\\');
    const regex = new RegExp(escapedPrefix + '[\\s\\S]{2,40}?(?=\\s*(?:ชั้น|ม\\.\\d|\\(|$))', 'i');
    const match = textOnly.match(regex);
    if (match) {
      const cleanName = match[0].replace(/\s+/g, ' ').trim();
      if (cleanName.length >= 5 && cleanName.length < 60 &&
          !/function|var </.test(cleanName) && isValidThaiName(cleanName)) {
        return cleanName;
      }
    }
  }

  // ── วิธีที่ 4: หาจาก tag ที่มี class/id ที่น่าจะเป็นชื่อ
  const nameTagMatch = html.match(/<[^>]*\b(?:student-name|stuname|studentName)\b[^>]*>([^<]{4,60})<\/[^>]*>/i);
  if (nameTagMatch && nameTagMatch[1]) {
    const cleanName = nameTagMatch[1].replace(/\s+/g, ' ').trim();
    if (cleanName.length >= 4 && cleanName.length < 60 && isValidThaiName(cleanName)) {
      return cleanName;
    }
  }

  return null;
}

/**
 * ตรวจสอบว่าข้อความดูเหมือนชื่อภาษาไทยหรือไม่
 * ชื่อควรมีอย่างน้อย 1 ตัวอักษรไทย และไม่มีตัวอักษรที่ไม่น่าจะอยู่ในชื่อ
 */
function isValidThaiName(str) {
  if (!str || typeof str !== 'string') return false;
  // ควรมีตัวอักษรไทยอย่างน้อย 1 ตัว (Unicode range: \u0E00-\u0E7F)
  const hasThai = /[\u0E00-\u0E7F]/.test(str);
  // ไม่ควรมี HTML tags หรือ JavaScript code
  const noCode = !/[<>{}]|function\s*\(|var\s+/.test(str);
  return hasThai && noCode && str.length >= 3;
}

function extractClassroomFromHTML(html) {

  // Helper: ทำให้ค่าห้องเรียนเป็นรูปแบบ "4/2" เสมอ (ไม่มี ม. นำหน้า)
  // เพราะ display code ใน index.html เพิ่ม "ม." เองอยู่แล้ว
  function normalizeRoom(val) {
    return val.replace(/\s+/g, '').replace(/^ม\.?\s*/i, '');
  }

  // ✅ วิธีที่ 0: ดึงจาก <input name="room" value="ม.4/2"> (KCI hidden field)
  // เป็นวิธีที่แม่นยำที่สุด เพราะ KCI ใส่ค่าห้องไว้โดยตรง
  const roomMatch1 = html.match(/name=["']room["'][^>]*value=["']([^"']+)["']/i);
  if (roomMatch1 && /\d/.test(roomMatch1[1])) {
    return normalizeRoom(roomMatch1[1]);
  }
  const roomMatch2 = html.match(/value=["']([^"']+)["'][^>]*name=["']room["']/i);
  if (roomMatch2 && /\d/.test(roomMatch2[1])) {
    return normalizeRoom(roomMatch2[1]);
  }

  // วิธีที่ 1: หาจาก textOnly ด้วย pattern ต่างๆ
  const textOnly = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

  const patterns = [
    /ชั้น\s*ม\.?\s*(\d+\/\d+)/i,          // ชั้น ม.4/2 → capture แค่ "4/2"
    /ม\.\s*(\d+\/\d+)/i,                   // ม.4/2 → capture แค่ "4/2"
    /ห้อง\s*(\d+\/\d+)/i,                  // ห้อง 4/2 → capture แค่ "4/2"
  ];

  for (const pattern of patterns) {
    const match = textOnly.match(pattern);
    if (match && match[1]) {
      return match[1].replace(/\s+/g, ''); // คืน "4/2" เสมอ ไม่มี ม. นำหน้า
    }
  }

  // ✅ FIX: คืน null แทน "4/2" เพื่อไม่ให้ข้อมูลผิดพลาดสำหรับนักเรียนห้องอื่น
  return null;
}

function extractPhoneFromHTML(html) {
  const phoneReg = /0[6-9]\d[\s\-]?\d{3}[\s\-]?\d{4}/;
  const match = html.match(phoneReg);
  if (match) {
    return match[0].replace(/[\s\-]/g, '');
  }
  return null;
}

function extractScoresFromHTML(html) {
  const goodMatch = html.match(/class=["']text1["'][^>]*>\s*([+-]?\d+(?:\.\d+)?)/i);
  const badMatch = html.match(/class=["']text2["'][^>]*>\s*([+-]?\d+(?:\.\d+)?)/i);
  let goodRaw = goodMatch ? goodMatch[1] : null;
  let badRaw = badMatch ? badMatch[1] : null;

  function findScoreAfterLabel(labelPattern) {
    const match = html.match(new RegExp("(?:" + labelPattern.source + ")[\\s\\S]*?<td[^>]*>\\s*([+-]?\\d+(?:\\.\\d+)?)\\s*<", "i"));
    return match ? match[1] : null;
  }

  if (goodRaw === null) goodRaw = findScoreAfterLabel(/ความดี/i);
  if (badRaw === null) badRaw = findScoreAfterLabel(/ประพฤติ|พฤติกรรม/i);

  function toNumber(value) {
    const number = Number.parseFloat(String(value == null ? '0' : value).replace(/[\s,]/g, ''));
    return Number.isFinite(number) ? number : 0;
  }
  function formatScore(value) {
    return String(Number.isInteger(value) ? value : Number(value.toFixed(2)));
  }

  const good = toNumber(goodRaw);
  const bad = Math.abs(toNumber(badRaw));
  return { good: formatScore(good), bad: formatScore(bad), total: formatScore(good - bad) };
}
function makeJSONResponse(obj) {
  return obj;
}

// ──────────────────────────────────────────────────────────────
// 6. REPORT PARSER
// จาก HTML source จริง: ทั้ง 2 ตารางใช้ class="three" เหมือนกัน
// แยกโดย position: ตารางที่ 1 = ความดี, ตารางที่ 2 = ประพฤติ
// ──────────────────────────────────────────────────────────────

function parseAllReportTables(html) {
  const goodReports = [];
  const badReports  = [];

  if (!html || html.includes('SQL syntax') || html.includes('notlogin')) {
    return { goodReports, badReports };
  }

  // หาทุกตารางที่มี class="three" ตามลำดับที่ปรากฏใน HTML
  const tableRe = /<table[^>]+class=["']three["'][^>]*>([\s\S]*?)<\/table>/gi;
  const tables   = [];
  let m;
  while ((m = tableRe.exec(html)) !== null) {
    const rows = parseTableRows(m[1]);
    if (rows.length > 0) tables.push(rows);
  }

  // ตาราง index 0 → ความดี, index 1 → ประพฤติ
  if (tables[0]) tables[0].forEach(r => goodReports.push(r));
  if (tables[1]) tables[1].forEach(r => badReports.push(r));

  return { goodReports, badReports };
}

function parseTableRows(tableBody) {
  const rows   = [];
  const rowRe  = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowM, idx = 0;

  while ((rowM = rowRe.exec(tableBody)) !== null) {
    idx++;
    if (idx === 1) continue; // ข้าม header row (ที่ / รายละเอียด / คะแนน / วันที่)

    const cells  = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellM;
    while ((cellM = cellRe.exec(rowM[1])) !== null) {
      cells.push(
        cellM[1]
          .replace(/<[^>]*>/g, '')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/gi,  '&')
          .replace(/\s+/g, ' ')
          .trim()
      );
    }
    if (cells.length >= 4 && /^\d+$/.test(cells[0])) {
      rows.push({ no: +cells[0], detail: cells[1], score: cells[2], date: cells[3] });
    }
  }
  return rows;
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ success: true, service: 'kci-api' });
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method not allowed' });

  let params = req.body;
  if (Buffer.isBuffer(params)) params = params.toString('utf8');
  if (typeof params === 'string') {
    try { params = JSON.parse(params); }
    catch { return res.status(400).json({ success: false, message: 'รูปแบบข้อมูลไม่ถูกต้อง' }); }
  }
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return res.status(400).json({ success: false, message: 'รูปแบบข้อมูลไม่ถูกต้อง' });
  }

  const result = await doPost(params);
  return res.status(200).json(result);
};

