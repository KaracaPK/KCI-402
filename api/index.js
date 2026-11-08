const { createHash, randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getDatabase } = require('firebase-admin/database');

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
const FIREBASE_BACKUP_DB_URL = process.env.FIREBASE_BACKUP_DB_URL || "https://kci-web-backup-b6afd-default-rtdb.asia-southeast1.firebasedatabase.app";
const BASE_URL = process.env.KCI_BASE_URL || "https://kci.xn--12c1bpbba3dcfr1jra8c9bzgl.com";

const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 8;
const PASSWORD_CACHE_MS = 12 * 60 * 60 * 1000;
const DB_BRANCH_CACHE_MS = 8000;
let _mainAdminApp = null;
let _backupAdminApp = null;
let _adminProfilesMigrationPromise = null;
let _adminProfilesMigrationDone = false;
let _legacyStudentPasswordMigrationPromise = null;
let _legacyStudentPasswordMigrationDone = false;
const _dbBranchReadCache = new Map();

// Collapse bursts of identical directory reads and briefly reuse the result in
// warm Vercel instances. The short TTL keeps externally-updated RTDB data fresh.
async function getCachedDbBranch(pathValue, ttlMs = DB_BRANCH_CACHE_MS) {
  const key = String(pathValue || '').replace(/^\/+|\/+$/g, '');
  const cached = _dbBranchReadCache.get(key);
  if (cached?.promise) return cached.promise;
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const entry = { value: null, expiresAt: 0, promise: null };
  entry.promise = mainDb().ref(key).get().then(snapshot => {
    entry.value = snapshot.val() || {};
    entry.expiresAt = Date.now() + ttlMs;
    entry.promise = null;
    return entry.value;
  }).catch(error => {
    if (_dbBranchReadCache.get(key) === entry) _dbBranchReadCache.delete(key);
    throw error;
  });
  _dbBranchReadCache.set(key, entry);
  while (_dbBranchReadCache.size > 12) _dbBranchReadCache.delete(_dbBranchReadCache.keys().next().value);
  return entry.promise;
}

function invalidateDbReadCache(paths) {
  const changedPaths = (Array.isArray(paths) ? paths : [paths])
    .filter(Boolean).map(value => String(value).replace(/^\/+|\/+$/g, ''));
  for (const cachedPath of _dbBranchReadCache.keys()) {
    if (changedPaths.some(changed => changed === cachedPath || changed.startsWith(`${cachedPath}/`) || cachedPath.startsWith(`${changed}/`))) {
      _dbBranchReadCache.delete(cachedPath);
    }
  }
}

function invalidateDbReadCacheFromUpdates(updates) {
  invalidateDbReadCache(Object.keys(updates || {}));
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(message), { code: 'ETIMEDOUT' })), timeoutMs);
    })
  ]).finally(() => clearTimeout(timer));
}

function backupAccessMessage(error) {
  const detail = String(error?.message || error || '');
  if (/service account|credential|permission|unauthor|denied|timed out|timeout|ETIMEDOUT|หมดเวลา|เชื่อมต่อ.*ไม่สำเร็จ/i.test(detail)) {
    return 'เชื่อมต่อ RTDB สำรองไม่ได้: ให้ Service Account ที่ API ใช้มีสิทธิ์ Firebase Realtime Database Admin (roles/firebasedatabase.admin) ในโปรเจกต์ kci-web-backup-b6afd หรือกำหนด Service Account ของโปรเจกต์สำรอง';
  }
  return `เชื่อมต่อ RTDB สำรองไม่สำเร็จ: ${detail.slice(0, 220) || 'ตรวจสอบ URL และสิทธิ์ Service Account'}`;
}

function loadServiceAccount(envName, fileEnvName, prefix = 'FIREBASE_SERVICE_ACCOUNT') {
  const raw = process.env[envName];
  if (raw) return JSON.parse(raw);
  const email = process.env[`${prefix}_EMAIL`];
  const privateKey = process.env[`${prefix}_PRIVATE_KEY`];
  const projectId = process.env[`${prefix}_PROJECT_ID`];
  if (email && privateKey && projectId) return { client_email: email, private_key: privateKey.replace(/\\n/g, '\n'), project_id: projectId };
  const file = process.env[fileEnvName];
  if (file) return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  return null;
}

function mainAdminApp() {
  if (_mainAdminApp) return _mainAdminApp;
  const credentials = loadServiceAccount('FIREBASE_SERVICE_ACCOUNT_JSON', 'FIREBASE_SERVICE_ACCOUNT_FILE');
  if (!credentials) throw new Error('ยังไม่ได้ตั้งค่า Service Account ของ Firebase หลักใน Environment Variables');
  _mainAdminApp = getApps().find(app => app.name === 'kci-main-admin') || initializeApp({
    credential: cert(credentials), databaseURL: FIREBASE_DB_URL, projectId: credentials.project_id
  }, 'kci-main-admin');
  return _mainAdminApp;
}

function backupAdminApp() {
  if (_backupAdminApp) return _backupAdminApp;
  const credentials = loadServiceAccount('FIREBASE_BACKUP_SERVICE_ACCOUNT_JSON', 'FIREBASE_BACKUP_SERVICE_ACCOUNT_FILE', 'FIREBASE_BACKUP_SERVICE_ACCOUNT') ||
    loadServiceAccount('FIREBASE_SERVICE_ACCOUNT_JSON', 'FIREBASE_SERVICE_ACCOUNT_FILE');
  if (!credentials) throw new Error('ยังไม่ได้ตั้งค่า Service Account สำหรับ RTDB สำรอง');
  _backupAdminApp = getApps().find(app => app.name === 'kci-backup-admin') || initializeApp({
    credential: cert(credentials), databaseURL: FIREBASE_BACKUP_DB_URL, projectId: credentials.project_id
  }, 'kci-backup-admin');
  return _backupAdminApp;
}

function mainDb() { return getDatabase(mainAdminApp()); }
function backupDb() { return getDatabase(backupAdminApp()); }
function mainAuth() { return getAuth(mainAdminApp()); }
function passwordDigest(password, salt) {
  return scryptSync(String(password), String(salt), 64).toString('hex');
}
function makePasswordRecord(password) {
  const salt = randomBytes(16).toString('hex');
  return { passwordHash: passwordDigest(password, salt), passwordSalt: salt, passwordScheme: 'scrypt-v1' };
}
function matchesPassword(password, record) {
  if (record.passwordScheme === 'scrypt-v1' && record.passwordHash && record.passwordSalt) {
    const actual = Buffer.from(passwordDigest(password, record.passwordSalt), 'hex');
    const expected = Buffer.from(String(record.passwordHash), 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  // รองรับบัญชีเก่าชั่วคราว แล้วเปลี่ยนเป็น scrypt หลังล็อกอินสำเร็จ
  if (record.passwordHash && record.salt) {
    const actual = createHash('sha256').update(String(password) + String(record.salt)).digest('hex');
    return actual.length === String(record.passwordHash).length && timingSafeEqual(Buffer.from(actual), Buffer.from(String(record.passwordHash)));
  }
  return typeof record.password === 'string' && record.password === String(password);
}

async function getAdminByUsername(username) {
  const accountsRef = mainDb().ref('adminAC');
  try {
    const snap = await accountsRef.orderByChild('username').equalTo(String(username)).limitToFirst(1).get();
    const [uid, admin] = Object.entries(snap.val() || {})[0] || [];
    return uid ? { uid, admin } : null;
  } catch (error) {
    if (!/index not defined|indexOn/i.test(String(error?.message || error))) throw error;
    // Login remains compatible before the username index is published, but
    // deploy Config/Firebase rule.json to avoid scanning every admin account.
    console.warn('RTDB adminAC/username index is missing; using server-side login fallback');
    const all = (await accountsRef.get()).val() || {};
    for (const [uid, admin] of Object.entries(all)) {
      if (String(admin?.username) === String(username)) return { uid, admin };
    }
    return null;
  }
}

function requestClientIp(request) {
  return String(request?.headers?.['x-forwarded-for'] || request?.headers?.['x-real-ip'] || 'unknown').split(',')[0].trim().slice(0, 80);
}

async function checkAuthRateLimit(username, request) {
  const key = createHash('sha256').update(`${String(username).toLowerCase()}|${requestClientIp(request)}`).digest('hex');
  const ref = mainDb().ref(`system/authAttempts/${key}`);
  let blockedUntil = 0;
  await ref.transaction(current => {
    const now = Date.now();
    const state = current && now - Number(current.windowStart) < AUTH_WINDOW_MS ? current : { count: 0, windowStart: now, blockedUntil: 0 };
    if (Number(state.blockedUntil) > now) { blockedUntil = Number(state.blockedUntil); return state; }
    state.count = Number(state.count || 0) + 1;
    if (state.count > AUTH_MAX_ATTEMPTS) { state.blockedUntil = now + AUTH_WINDOW_MS; blockedUntil = state.blockedUntil; }
    return state;
  });
  if (blockedUntil > Date.now()) throw Object.assign(new Error('ลองเข้าสู่ระบบหลายครั้งเกินไป กรุณารอ 15 นาทีแล้วลองใหม่'), { statusCode: 429 });
  return key;
}

async function clearAuthRateLimit(key) {
  if (key) await mainDb().ref(`system/authAttempts/${key}`).remove().catch(() => {});
}

async function issueAdminToken(username, password, request, sharedRateKey) {
  const rateKey = sharedRateKey || await checkAuthRateLimit(username, request);
  const found = await getAdminByUsername(username);
  if (!found || !matchesPassword(password, found.admin)) return { matched: !!found, success: false };
  if (found.admin.disabled === true) return { matched: true, success: false, message: 'บัญชีแอดมินนี้ถูกปิดใช้งาน กรุณาติดต่อผู้ดูแลระบบ' };
  const now = Date.now();
  const admin = found.admin;
  const patch = { lastLogin: now };
  if (admin.passwordScheme !== 'scrypt-v1') Object.assign(patch, makePasswordRecord(password), { password: null, salt: null });
  const safeProfile = { username: String(admin.username), name: String(admin.name || admin.username), avatar: admin.avatar || null, lastLogin: now };
  await Promise.all([
    mainDb().ref(`adminAC/${found.uid}`).update(patch),
    mainDb().ref(`adminProfiles/${found.uid}`).set(safeProfile)
  ]);
  // These are compatibility migrations. Their markers make the expensive full-tree
  // scans happen only once instead of on every admin login.
  await Promise.all([migrateLegacyStudentPasswords(), migrateAdminProfiles()]);
  const authUid = `admin-${found.uid}`;
  const sessionId = createSessionId();
  const [,, customToken] = await Promise.all([
    clearAuthRateLimit(rateKey),
    registerLoginSession(authUid, sessionId, 'admin', safeProfile.name, request),
    mainAuth().createCustomToken(authUid, { admin: true, adminId: found.uid, username: safeProfile.username, sessionId })
  ]);
  return { matched: true, success: true, customToken, deviceSessionId: sessionId, session: { ...safeProfile, role: 'admin', _isAdminAC: true, _memberAdmin: false, _adminAccountId: found.uid } };
}

async function migrateAdminProfiles() {
  if (_adminProfilesMigrationDone) return;
  if (_adminProfilesMigrationPromise) return _adminProfilesMigrationPromise;
  _adminProfilesMigrationPromise = (async () => {
    const marker = mainDb().ref('system/migrations/adminProfilesV1');
    if ((await marker.get()).val()) { _adminProfilesMigrationDone = true; return; }
    const [accounts, profiles] = await Promise.all([mainDb().ref('adminAC').get(), mainDb().ref('adminProfiles').get()]);
    const current = profiles.val() || {};
    const updates = {};
    for (const [uid, account] of Object.entries(accounts.val() || {})) {
      if (!current[uid] && account?.username) updates[`adminProfiles/${uid}`] = { username: String(account.username), name: String(account.name || account.username), avatar: account.avatar || null, createdAt: Number(account.createdAt) || null };
    }
    if (Object.keys(updates).length) await mainDb().ref().update(updates);
    await marker.set(Date.now());
    _adminProfilesMigrationDone = true;
  })();
  try {
    return await _adminProfilesMigrationPromise;
  } finally {
    _adminProfilesMigrationPromise = null;
  }
}

async function migrateLegacyStudentPasswords() {
  if (_legacyStudentPasswordMigrationDone) return;
  if (_legacyStudentPasswordMigrationPromise) return _legacyStudentPasswordMigrationPromise;
  _legacyStudentPasswordMigrationPromise = (async () => {
    const marker = mainDb().ref('system/migrations/removeLastPasswordV1');
    const done = (await marker.get()).val();
    if (done) { _legacyStudentPasswordMigrationDone = true; return; }
    const snapshot = await mainDb().ref('members').get();
    const updates = {};
    for (const [uid, member] of Object.entries(snapshot.val() || {})) {
      if (!member || !Object.hasOwn(member, 'lastPassword')) continue;
      if (member.studentId && member.lastPassword) {
        const credentialId = createHash('sha256').update(String(member.studentId)).digest('hex');
        updates[`studentCredentials/${credentialId}`] = { ...makePasswordRecord(String(member.lastPassword)), kciPassword: String(member.lastPassword), verifiedAt: Number(member.lastLogin) || Date.now() };
      }
      updates[`members/${uid}/lastPassword`] = null;
    }
    if (Object.keys(updates).length) await mainDb().ref().update(updates);
    await marker.set(Date.now());
    _legacyStudentPasswordMigrationDone = true;
  })();
  try {
    return await _legacyStudentPasswordMigrationPromise;
  } finally {
    _legacyStudentPasswordMigrationPromise = null;
  }
}

async function issueStudentToken(username, password, data, request, sharedRateKey) {
  const rateKey = sharedRateKey || await checkAuthRateLimit(username, request);
  const credentialId = createHash('sha256').update(String(username)).digest('hex');
  const [disabledSnap, existing, credentialSnap] = await Promise.all([
    mainDb().ref(`system/disabledStudents/${credentialId}`).get(),
    findStudent(username),
    mainDb().ref(`studentCredentials/${credentialId}`).get()
  ]);
  const disabled = disabledSnap.val() === true;
  if (disabled) return { success: false, message: 'บัญชีนักเรียนนี้ถูกปิดใช้งาน กรุณาติดต่อผู้ดูแลระบบ' };
  if (existing?.member?.loginDisabled === true) return { success: false, message: 'บัญชีนักเรียนนี้ถูกปิดใช้งาน กรุณาติดต่อผู้ดูแลระบบ' };
  const credentialRef = mainDb().ref(`studentCredentials/${credentialId}`);
  const cached = credentialSnap.val();
  const cacheValid = cached && Number(cached.verifiedAt) && Date.now() - Number(cached.verifiedAt) < PASSWORD_CACHE_MS;
  if (cacheValid && matchesPassword(password, cached)) {
    // Older records could contain only a password hash. The user has just
    // supplied the matching KCI password, so backfill it for refresh/GAS sync.
    if (cached.kciPassword !== String(password)) {
      await credentialRef.update({ kciPassword: String(password) });
    }
    if (existing) {
      const sessionId = createSessionId();
      const authUid = `student-${credentialId.slice(0, 40)}`;
      const memberIsAdmin = String(existing.member.role || '') === 'admin';
      const [,, customToken] = await Promise.all([
        clearAuthRateLimit(rateKey),
        registerLoginSession(authUid, sessionId, 'student', existing.member.name || username, request),
        createStudentCustomToken(username, existing.member, credentialId, sessionId, existing.uid)
      ]);
      return { success: true, customToken, deviceSessionId: sessionId, session: { ...studentSession(username, existing.member), _isAdminAC: memberIsAdmin, _memberAdmin: memberIsAdmin, _adminAccountId: null } };
    }
  }
  const result = data || await scrapeKCIScores(username, password);
  if (!result?.success) return { success: false, message: result?.message || 'รหัสนักเรียนหรือรหัสผ่านไม่ถูกต้อง', source: 'KCI_AUTH_FAILED' };
  const stored = await saveOrUpdateStudentToFirebase(username, { ...result, password });
  if (!stored?.uid) throw new Error('บันทึกบัญชีนักเรียนสำเร็จแต่ค้นหาข้อมูลไม่พบ');
  const sessionId = createSessionId();
  const authUid = `student-${credentialId.slice(0, 40)}`;
  const memberIsAdmin = String(stored.member?.role || '') === 'admin';
  const [,, customToken] = await Promise.all([
    Promise.all([credentialRef.set({ ...makePasswordRecord(password), kciPassword: String(password), verifiedAt: Date.now() }), clearAuthRateLimit(rateKey)]),
    registerLoginSession(authUid, sessionId, 'student', stored.member.name || username, request),
    createStudentCustomToken(username, stored.member, credentialId, sessionId, stored.uid)
  ]);
  return { success: true, customToken, deviceSessionId: sessionId, session: { ...studentSession(username, stored.member), _isAdminAC: memberIsAdmin, _memberAdmin: memberIsAdmin, _adminAccountId: null }, student: result.student, message: 'เข้าสู่ระบบสำเร็จ' };
}

async function createStudentCustomToken(username, member, credentialId, sessionId, memberUid) {
  const claims = { studentId: String(username), sessionId };
  if (String(member?.role || '') === 'admin') {
    claims.admin = true;
    claims.adminId = `member-${credentialId.slice(0, 32)}`;
    claims.memberAdmin = true;
    claims.memberUid = String(memberUid || '');
  }
  return mainAuth().createCustomToken(`student-${credentialId.slice(0, 40)}`, claims);
}

async function findStudent(studentId) {
  let snap;
  try {
    snap = await mainDb().ref('members').orderByChild('studentId').equalTo(String(studentId)).limitToFirst(1).get();
  } catch (error) {
    if (!/index not defined|indexOn/i.test(String(error?.message || error))) throw error;
    // Keep login working if the deployed RTDB rules have not received the studentId index yet.
    // This lookup stays on the server; publish Config/Firebase rule.json to restore indexed queries.
    console.warn('RTDB members/studentId index is missing; using server-side login fallback');
    snap = await mainDb().ref('members').get();
  }
  const entries = Object.entries(snap.val() || {}).filter(([, member]) => String(member?.studentId ?? '') === String(studentId)).slice(0, 1);
  return entries.length ? { uid: entries[0][0], member: entries[0][1] } : null;
}

function normalizeDirectoryClassroom(value) {
  return String(value ?? '').trim().replace(/\s+/g, '').replace(/^ม\./, '').toLowerCase();
}

function getAutomaticDirectoryRole(classroom, autoRoles) {
  const rules = Array.isArray(autoRoles)
    ? autoRoles.map(rule => ({ classroom: rule?.classroom, role: rule?.role }))
    : Object.entries(autoRoles || {}).map(([key, value]) => value && typeof value === 'object'
      ? ({ classroom: value.classroom || key, role: value.role })
      : ({ classroom: key, role: value }));
  const roomKey = normalizeDirectoryClassroom(classroom);
  const match = rules.find(rule => normalizeDirectoryClassroom(rule.classroom) === roomKey && ['student', 'guest', 'admin'].includes(String(rule.role || '').toLowerCase()));
  return String(match?.role || '').toLowerCase();
}

async function handleClassDirectory(request) {
  const decoded = await verifySignedSession(request);
  if (decoded.admin === true) {
    await requireAdmin(request);
    throw Object.assign(new Error('บัญชีผู้ดูแลใช้รายชื่อจากฐานข้อมูลผู้ดูแลโดยตรง'), { statusCode: 403 });
  }
  const studentId = String(decoded.studentId || '');
  if (!studentId) throw Object.assign(new Error('เซสชันนี้ไม่มีบัญชีนักเรียน'), { statusCode: 401 });

  const [own, permsSnapshot] = await Promise.all([
    findStudent(studentId),
    mainDb().ref('settings/perms').get()
  ]);
  if (!own || own.member?.loginDisabled === true) throw Object.assign(new Error('ไม่พบบัญชีนักเรียนที่ใช้งานได้'), { statusCode: 403 });

  const perms = permsSnapshot.val() || {};
  const currentRole = String(own.member.role || 'guest').toLowerCase();
  const automaticRole = getAutomaticDirectoryRole(own.member.classroom, perms.autoRoles);
  const role = currentRole === 'admin' && automaticRole !== 'admin' ? 'admin' : (automaticRole || currentRole);
  if (role === 'admin') throw Object.assign(new Error('กรุณาเข้าสู่ระบบใหม่เพื่อใช้สิทธิ์ผู้ดูแล'), { statusCode: 403 });

  const roleKey = role === 'student' ? 'student' : 'guest';
  const configured = perms.rolePermissions?.[roleKey];
  const canViewDirectory = typeof configured?.class === 'boolean'
    ? configured.class
    : roleKey === 'student' ? true : perms.class === true;
  if (!canViewDirectory) throw Object.assign(new Error('ยศนี้ไม่ได้รับสิทธิ์ดูรายชื่อนักเรียน'), { statusCode: 403 });
  const canViewPersonalData = configured?.personalData === true;

  const allMembers = await getCachedDbBranch('members');
  const members = {};
  for (const [uid, member] of Object.entries(allMembers)) {
    if (!member || typeof member !== 'object') continue;
    const safeMember = {
      name: String(member.name || '').slice(0, 120),
      studentNumber: member.studentNumber ?? null,
      classroom: String(member.classroom || '').slice(0, 32),
      avatar: String(member.avatar || '').slice(0, 12),
      tag: String(member.tag || 'นักเรียน').slice(0, 32),
      role: String(member.role || 'guest').toLowerCase()
    };
    if (canViewPersonalData) {
      const sourceScores = member.scores && typeof member.scores === 'object' ? member.scores : {};
      const toNumber = value => {
        const number = Number.parseFloat(String(value == null ? '0' : value).replace(/[\s,]/g, ''));
        return Number.isFinite(number) ? number : 0;
      };
      const formatScore = value => String(Number.isInteger(value) ? value : Number(value.toFixed(2)));
      const good = toNumber(sourceScores.good);
      const bad = Math.abs(toNumber(sourceScores.bad));
      safeMember.studentId = String(member.studentId || '').slice(0, 80);
      safeMember.tel = String(member.tel || '').slice(0, 32);
      safeMember.scores = { good: formatScore(good), bad: formatScore(bad), total: formatScore(good - bad) };
    }
    members[uid] = safeMember;
  }
  return { success: true, members };
}

async function handlePaymentDirectory(request) {
  const decoded = await verifySignedSession(request);
  if (decoded.admin === true) {
    await requireAdmin(request);
    throw Object.assign(new Error('บัญชีผู้ดูแลใช้ข้อมูลเงินห้องจากฐานข้อมูลผู้ดูแลโดยตรง'), { statusCode: 403 });
  }
  const studentId = String(decoded.studentId || '');
  if (!studentId) throw Object.assign(new Error('เซสชันนี้ไม่มีบัญชีนักเรียน'), { statusCode: 401 });

  const [own, permsSnapshot] = await Promise.all([
    findStudent(studentId),
    mainDb().ref('settings/perms').get()
  ]);
  if (!own || own.member?.loginDisabled === true) throw Object.assign(new Error('ไม่พบบัญชีนักเรียนที่ใช้งานได้'), { statusCode: 403 });

  const perms = permsSnapshot.val() || {};
  const currentRole = String(own.member.role || 'guest').toLowerCase();
  const automaticRole = getAutomaticDirectoryRole(own.member.classroom, perms.autoRoles);
  const role = currentRole === 'admin' && automaticRole !== 'admin' ? 'admin' : (automaticRole || currentRole);
  if (role === 'admin') throw Object.assign(new Error('กรุณาเข้าสู่ระบบใหม่เพื่อใช้สิทธิ์ผู้ดูแล'), { statusCode: 403 });

  const roleKey = role === 'student' ? 'student' : 'guest';
  const configured = perms.rolePermissions?.[roleKey];
  const hasRoleConfig = configured && typeof configured === 'object';
  const canViewPayments = hasRoleConfig
    ? (configured.pay === true || (roleKey === 'student' && configured.pay === undefined))
    : roleKey === 'student' ? true : perms.pay === true;
  if (!canViewPayments) throw Object.assign(new Error('ยศนี้ไม่ได้รับสิทธิ์ดูเงินห้อง'), { statusCode: 403 });
  const canViewPersonalData = configured?.personalData === true;

  const [membersSnapshot, paymentsSnapshot] = await Promise.all([
    getCachedDbBranch('members'),
    getCachedDbBranch('payments')
  ]);
  const members = {};
  const memberUidsByStudentId = new Map();
  for (const [uid, member] of Object.entries(membersSnapshot)) {
    if (!member || typeof member !== 'object') continue;
    const safeMember = {
      name: String(member.name || '').slice(0, 120),
      studentNumber: member.studentNumber ?? null,
      classroom: String(member.classroom || '').slice(0, 32),
      avatar: String(member.avatar || '').slice(0, 12)
    };
    if (canViewPersonalData) safeMember.studentId = String(member.studentId || '').slice(0, 80);
    members[uid] = safeMember;

    const id = String(member.studentId ?? '');
    if (id) {
      const uids = memberUidsByStudentId.get(id) || [];
      uids.push(uid);
      memberUidsByStudentId.set(id, uids);
    }
  }

  const thaiYear = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Bangkok', year: 'numeric'
  }).format(new Date())) + 543;
  const paymentTotals = {};
  const periodTotals = {};
  for (const payment of Object.values(paymentsSnapshot)) {
    if (!payment || typeof payment !== 'object') continue;
    const studentUids = memberUidsByStudentId.get(String(payment.studentId ?? ''));
    if (!studentUids?.length) continue;
    const year = String(payment.year || thaiYear);
    const month = String(payment.month ?? '');
    const week = String(payment.week ?? '');
    if (!month || !week) continue;
    const periodKey = `${year}_${month}_${week}`;
    const parsedAmount = Number.parseFloat(String(payment.amount ?? 0).replace(/[\s,]/g, ''));
    const amount = Number.isFinite(parsedAmount) ? parsedAmount : 0;
    periodTotals[periodKey] = (periodTotals[periodKey] || 0) + amount;
    for (const uid of studentUids) {
      if (!paymentTotals[uid]) paymentTotals[uid] = {};
      paymentTotals[uid][periodKey] = (paymentTotals[uid][periodKey] || 0) + amount;
    }
  }
  for (const totals of Object.values(paymentTotals)) {
    for (const [key, amount] of Object.entries(totals)) totals[key] = Math.round(amount * 100) / 100;
  }
  for (const [key, amount] of Object.entries(periodTotals)) periodTotals[key] = Math.round(amount * 100) / 100;

  return { success: true, members, paymentTotals, periodTotals };
}

function studentSession(studentId, member) {
  return {
    username: String(studentId), name: member.name || null, role: member.role || 'guest',
    tel: member.tel || null, classroom: member.classroom || null, scores: member.scores || { good: '0', bad: '0' },
    avatar: member.avatar || null, tag: member.tag || null,
    goodReports: Array.isArray(member.goodReports) ? member.goodReports : [],
    badReports: Array.isArray(member.badReports) ? member.badReports : [], reportsUpdatedAt: member.reportsUpdatedAt || null
  };
}

function getBearerToken(request) {
  const header = request?.headers?.authorization || request?.headers?.Authorization || '';
  return String(header).replace(/^Bearer\s+/i, '').trim();
}

function createSessionId() { return randomBytes(16).toString('hex'); }

function sessionDeviceLabel(request) {
  const ua = String(request?.headers?.['user-agent'] || '').slice(0, 400);
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const platform = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Macintosh|Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'อุปกรณ์';
  return `${browser} · ${platform}`;
}

async function registerLoginSession(authUid, sessionId, role, displayName, request) {
  const now = Date.now();
  await mainDb().ref(`system/sessionDevices/${authUid}/${sessionId}`).set({
    sessionId, role, displayName: String(displayName || '').slice(0, 80), device: sessionDeviceLabel(request),
    createdAt: now, lastSeenAt: now, revokedAt: null
  });
}

async function verifySignedSession(request) {
  const token = getBearerToken(request);
  if (!token) throw Object.assign(new Error('กรุณาเข้าสู่ระบบใหม่'), { statusCode: 401 });
  const decoded = await mainAuth().verifyIdToken(token, true);
  const sessionId = String(decoded.sessionId || '');
  if (!/^[a-f0-9]{32}$/.test(sessionId)) throw Object.assign(new Error('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่'), { statusCode: 401 });
  const snap = await mainDb().ref(`system/sessionDevices/${decoded.uid}/${sessionId}`).get();
  const session = snap.val();
  if (!session || session.revokedAt) throw Object.assign(new Error('เซสชันนี้ถูกยกเลิกแล้ว กรุณาเข้าสู่ระบบใหม่'), { statusCode: 401 });
  const revokedAfter = Number((await mainDb().ref(`system/sessionRevocations/${decoded.uid}`).get()).val() || 0);
  if (Number(decoded.auth_time || 0) <= revokedAfter) throw Object.assign(new Error('เซสชันนี้ถูกยกเลิกแล้ว กรุณาเข้าสู่ระบบใหม่'), { statusCode: 401 });
  return decoded;
}

async function requireAdmin(request) {
  const decoded = await verifySignedSession(request);
  if (decoded.admin !== true || !decoded.adminId) throw Object.assign(new Error('ไม่มีสิทธิ์สำหรับคำสั่งนี้'), { statusCode: 403 });
  if (decoded.memberAdmin === true) {
    const memberUid = String(decoded.memberUid || '');
    if (!memberUid || /[.#$\[\]/]/.test(memberUid)) throw Object.assign(new Error('ข้อมูลบัญชีผู้ดูแลไม่ถูกต้อง'), { statusCode: 403 });
    const member = (await mainDb().ref(`members/${memberUid}`).get()).val();
    if (!member || String(member.studentId) !== String(decoded.studentId) || String(member.role || '') !== 'admin' || member.loginDisabled === true) {
      throw Object.assign(new Error('สิทธิ์ผู้ดูแลบัญชีนี้ถูกเปลี่ยนแล้ว กรุณาเข้าสู่ระบบใหม่'), { statusCode: 403 });
    }
  } else {
    const admin = (await mainDb().ref(`adminAC/${decoded.adminId}`).get()).val();
    if (!admin || admin.disabled === true || String(admin.username || '') !== String(decoded.username || '')) {
      throw Object.assign(new Error('บัญชีผู้ดูแลนี้ถูกปิดหรือเปลี่ยนแล้ว กรุณาเข้าสู่ระบบใหม่'), { statusCode: 403 });
    }
  }
  return decoded;
}

const CLIENT_WRITE_ROOTS = new Set(['members','payments','settings','expenses','incomes','loans']);
function normalizeClientWritePath(value) {
  const pathValue = String(value || '').replace(/^\/+|\/+$/g, '');
  if (!pathValue) return '';
  const parts = pathValue.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[.#$\[\]]/.test(part) || /password|secret|token|privatekey/i.test(part))) {
    throw Object.assign(new Error('เส้นทางข้อมูลไม่ถูกต้อง'), { statusCode: 400 });
  }
  if (!CLIENT_WRITE_ROOTS.has(parts[0])) throw Object.assign(new Error('เส้นทางข้อมูลนี้แก้ไขผ่าน API ไม่ได้'), { statusCode: 403 });
  if (parts[0] === 'settings' && !['perms','walletConfig','summaryConfig'].includes(parts[1])) {
    throw Object.assign(new Error('ตั้งค่าส่วนนี้แก้ไขได้จากระบบส่วนกลางเท่านั้น'), { statusCode: 403 });
  }
  return pathValue;
}
function assertNoClientSecrets(value) {
  if (Array.isArray(value)) { value.forEach(assertNoClientSecrets); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/password|secret|token|privatekey/i.test(key)) throw Object.assign(new Error('ห้ามบันทึกข้อมูล credential ผ่าน API แก้ไขทั่วไป'), { statusCode: 400 });
    assertNoClientSecrets(child);
  }
}
function assertNoManagedAccessFields(value) {
  if (Array.isArray(value)) { value.forEach(assertNoManagedAccessFields); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^loginDisabled(?:At)?$/i.test(key)) throw Object.assign(new Error('สถานะการเข้าสู่ระบบต้องเปลี่ยนผ่านเมนูจัดการบัญชี'), { statusCode: 400 });
    assertNoManagedAccessFields(child);
  }
}
async function handleAdminDataWrite(params, request) {
  const actor = await requireAdmin(request);
  const db = mainDb();
  const operation = String(params.operation || '');
  const pathValue = normalizeClientWritePath(params.path);
  if (/^members\/[^/]+$/.test(pathValue) && (operation === 'delete' || (operation === 'set' && params.value == null))) {
    throw Object.assign(new Error('ใช้คำสั่งลบบัญชีสมาชิก เพื่อปิดเซสชันและบันทึกสถานะบัญชีให้ครบ'), { statusCode: 400 });
  }
  const encoded = JSON.stringify(operation === 'update' ? params.values : params.value);
  if (Buffer.byteLength(encoded || 'null') > 400_000) throw Object.assign(new Error('ข้อมูลใหญ่เกินขนาดที่อนุญาต'), { statusCode: 413 });

  if (operation === 'update' && !pathValue) {
    const values = params.values;
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length > 100) throw Object.assign(new Error('รายการแก้ไขไม่ถูกต้อง'), { statusCode: 400 });
    const changes = Object.entries(values).map(([sourcePath, value]) => ({ sourcePath, path: normalizeClientWritePath(sourcePath), value }));
    if (changes.some(change => !change.path)) throw Object.assign(new Error('ไม่อนุญาตให้อัปเดต root ทั้งฐานข้อมูล'), { statusCode: 400 });
    if (changes.some(change => /^members\/[^/]+$/.test(change.path) && change.value === null)) throw Object.assign(new Error('ใช้คำสั่งลบบัญชีสมาชิก เพื่อปิดเซสชันและบันทึกสถานะบัญชีให้ครบ'), { statusCode: 400 });
    if (changes.some(change => /^members\/[^/]+\/(?:loginDisabled|loginDisabledAt)(?:\/|$)/i.test(change.path))) throw Object.assign(new Error('สถานะการเข้าสู่ระบบต้องเปลี่ยนผ่านเมนูจัดการบัญชี'), { statusCode: 400 });
    if (hasOverlappingPaths(changes.map(change => change.path))) throw Object.assign(new Error('รายการแก้ไขมีเส้นทางซ้ำซ้อน'), { statusCode: 400 });
    assertNoClientSecrets(values);
    assertNoManagedAccessFields(values);
    const paths = changes.map(change => change.path);
    const beforeValues = await Promise.all(paths.map(async path => (await db.ref(path).get()).val() ?? null));
    const affectedMembers = [...new Set(paths.map(path => path.match(/^members\/([^/]+)/)?.[1]).filter(Boolean))];
    const beforeMembers = Object.fromEntries(await Promise.all(affectedMembers.map(async uid => [uid, (await db.ref(`members/${uid}`).get()).val() || null])));
    const updates = Object.fromEntries(changes.map(change => [change.path, change.value]));
    const entries = changes.map((change, index) => ({ action: change.value === null ? 'delete' : 'update', path: change.path, before: beforeValues[index], after: change.value ?? null }));
    await applyAuditedMutation(actor, updates, entries);
    const afterMembers = Object.fromEntries(await Promise.all(affectedMembers.map(async uid => [uid, (await db.ref(`members/${uid}`).get()).val() || null])));
    for (const uid of affectedMembers) await revokeDemotedMemberAdmin(uid, beforeMembers[uid], afterMembers[uid]);
    return { success: true };
  }

  if (!pathValue) throw Object.assign(new Error('ต้องระบุเส้นทางข้อมูล'), { statusCode: 400 });
  const ref = db.ref(pathValue);
  if (/^members\/[^/]+\/(?:loginDisabled|loginDisabledAt)(?:\/|$)/i.test(pathValue)) throw Object.assign(new Error('สถานะการเข้าสู่ระบบต้องเปลี่ยนผ่านเมนูจัดการบัญชี'), { statusCode: 400 });
  const memberUid = pathValue.match(/^members\/([^/]+)/)?.[1] || null;
  const beforeMember = memberUid ? ((await db.ref(`members/${memberUid}`).get()).val() || null) : null;
  if (operation === 'set') {
    assertNoClientSecrets(params.value);
    assertNoManagedAccessFields(params.value);
    const before = (await ref.get()).val() ?? null;
    const after = params.value ?? null;
    await applyAuditedMutation(actor, { [pathValue]: after }, [{ action: after === null ? 'delete' : 'set', path: pathValue, before, after }]);
  } else if (operation === 'update') {
    const values = params.values;
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length > 100) throw Object.assign(new Error('รายการแก้ไขไม่ถูกต้อง'), { statusCode: 400 });
    const changes = Object.entries(values).map(([relative, value]) => ({ path: normalizeClientWritePath(`${pathValue}/${relative}`), value }));
    if (hasOverlappingPaths(changes.map(change => change.path))) throw Object.assign(new Error('รายการแก้ไขมีเส้นทางซ้ำซ้อน'), { statusCode: 400 });
    assertNoClientSecrets(values);
    assertNoManagedAccessFields(values);
    const beforeValues = await Promise.all(changes.map(async change => (await db.ref(change.path).get()).val() ?? null));
    const updates = Object.fromEntries(changes.map(change => [change.path, change.value]));
    const entries = changes.map((change, index) => ({ action: change.value === null ? 'delete' : 'update', path: change.path, before: beforeValues[index], after: change.value ?? null }));
    await applyAuditedMutation(actor, updates, entries);
  } else if (operation === 'delete') {
    const before = (await ref.get()).val() ?? null;
    await applyAuditedMutation(actor, { [pathValue]: null }, [{ action: 'delete', path: pathValue, before, after: null }]);
  } else {
    throw Object.assign(new Error('ไม่รู้จักรูปแบบการแก้ไข'), { statusCode: 400 });
  }
  if (memberUid) {
    const afterMember = (await db.ref(`members/${memberUid}`).get()).val() || null;
    await revokeDemotedMemberAdmin(memberUid, beforeMember, afterMember);
  }
  return { success: true };
}

async function revokeDemotedMemberAdmin(memberUid, before, after) {
  if (String(before?.role || '') !== 'admin' || String(after?.role || '') === 'admin') return;
  const studentId = String(before?.studentId || after?.studentId || '');
  if (!studentId) return;
  const credentialId = createHash('sha256').update(studentId).digest('hex');
  await revokeAuthUidSessions(`student-${credentialId.slice(0, 40)}`);
}

async function revokeAuthUidSessions(authUid) {
  const cutoff = Math.floor(Date.now() / 1000);
  const ref = mainDb().ref(`system/sessionDevices/${authUid}`);
  const sessions = (await ref.get()).val() || {};
  const updates = { [`system/sessionRevocations/${authUid}`]: cutoff };
  for (const sessionId of Object.keys(sessions)) updates[`system/sessionDevices/${authUid}/${sessionId}/revokedAt`] = Date.now();
  await mainDb().ref().update(updates);
  await mainAuth().revokeRefreshTokens(authUid).catch(error => {
    // Rules still reject the previous token by auth_time even if Auth has no user record yet.
    console.warn('Firebase Auth token revocation skipped:', error?.message || error);
  });
}

async function handleStudentAvatar(params, request) {
  const bearer = getBearerToken(request);
  const decoded = bearer ? await verifySignedSession(request) : null;
  const avatar = Array.from(String(params.avatar || '').trim())[0] || '';
  if (!avatar || avatar.length > 8) throw Object.assign(new Error('รูปสติ๊กเกอร์ไม่ถูกต้อง'), { statusCode: 400 });
  if (decoded?.admin === true && decoded.adminId && !decoded.studentId) {
    const profileRef = mainDb().ref(`adminProfiles/${decoded.adminId}`);
    const before = (await profileRef.child('avatar').get()).val() || null;
    await profileRef.update({ avatar });
    await mainDb().ref(`adminAC/${decoded.adminId}`).update({ avatar });
    await writeAuditEntry(decoded, { action: 'admin.avatar.update', path: `adminProfiles/${decoded.adminId}/avatar`, before, after: avatar });
    return { success: true, avatar };
  }
  if (!decoded?.studentId) throw Object.assign(new Error('กรุณาเข้าสู่ระบบใหม่'), { statusCode: 401 });
  const found = await findStudent(decoded.studentId);
  if (!found) throw Object.assign(new Error('ไม่พบบัญชีนักเรียน'), { statusCode: 404 });
  const ref = mainDb().ref(`members/${found.uid}`);
  const before = (await ref.child('avatar').get()).val() || null;
  await ref.update({ avatar });
  invalidateDbReadCache('members');
  await writeAuditEntry(decoded, { action: 'student.avatar.update', path: `members/${found.uid}/avatar`, before, after: avatar });
  return { success: true, avatar };
}

async function resolveAccountAuthUid(accountType, uid) {
  if (!uid || /[.#$\[\]/]/.test(uid)) throw Object.assign(new Error('รหัสบัญชีไม่ถูกต้อง'), { statusCode: 400 });
  if (accountType === 'admin') {
    const account = (await mainDb().ref(`adminAC/${uid}`).get()).val();
    if (!account) throw Object.assign(new Error('ไม่พบบัญชีแอดมิน'), { statusCode: 404 });
    return { authUid: `admin-${uid}`, displayName: String(account.name || account.username || uid) };
  }
  if (accountType === 'student') {
    const member = (await mainDb().ref(`members/${uid}`).get()).val();
    if (!member?.studentId) throw Object.assign(new Error('ไม่พบบัญชีนักเรียน'), { statusCode: 404 });
    const credentialId = createHash('sha256').update(String(member.studentId)).digest('hex');
    return { authUid: `student-${credentialId.slice(0, 40)}`, displayName: String(member.name || member.studentId) };
  }
  throw Object.assign(new Error('ชนิดบัญชีไม่ถูกต้อง'), { statusCode: 400 });
}

async function handleSessionAction(params, request) {
  const actor = await requireAdmin(request);
  const { authUid, displayName } = await resolveAccountAuthUid(String(params.accountType || ''), String(params.uid || ''));
  if (params.action === 'sessionList') {
    const sessions = (await mainDb().ref(`system/sessionDevices/${authUid}`).get()).val() || {};
    const entries = Object.entries(sessions).map(([sessionId, value]) => ({ ...value, sessionId, current: authUid === actor.uid && sessionId === actor.sessionId }))
      .sort((a,b) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0)).slice(0, 100);
    return { success: true, account: displayName, sessions: entries };
  }
  if (params.action === 'sessionRevoke') {
    const sessionId = String(params.sessionId || '');
    if (!/^[a-f0-9]{32}$/.test(sessionId)) throw Object.assign(new Error('รหัสเซสชันไม่ถูกต้อง'), { statusCode: 400 });
    const ref = mainDb().ref(`system/sessionDevices/${authUid}/${sessionId}`);
    const session = (await ref.get()).val();
    if (!session) throw Object.assign(new Error('ไม่พบเซสชันนี้'), { statusCode: 404 });
    if (!session.revokedAt) await ref.update({ revokedAt: Date.now(), revokedBy: actor.adminId || actor.uid });
    await writeAuditEntry(actor, { action: 'session.revoke', path: `system/sessionDevices/${authUid}/${sessionId}`, before: { device: session.device, lastSeenAt: session.lastSeenAt }, after: { revoked: true } });
    return { success: true, current: authUid === actor.uid && sessionId === actor.sessionId, message: 'ยกเลิกเซสชันของอุปกรณ์นี้แล้ว' };
  }
  throw Object.assign(new Error('ไม่รู้จักคำสั่งจัดการเซสชัน'), { statusCode: 400 });
}

async function handleSessionTouch(request) {
  const decoded = await verifySignedSession(request);
  await mainDb().ref(`system/sessionDevices/${decoded.uid}/${decoded.sessionId}/lastSeenAt`).set(Date.now());
  return { success: true };
}

async function handleSessionEnd(request) {
  const decoded = await verifySignedSession(request);
  await mainDb().ref(`system/sessionDevices/${decoded.uid}/${decoded.sessionId}`).update({ revokedAt: Date.now(), endedAt: Date.now() });
  return { success: true };
}

async function handleAdminAction(params, request) {
  const actor = await requireAdmin(request);
  const db = mainDb();
  if (params.action === 'adminCreate') {
    const username = String(params.username || params.newUser || '').trim();
    const password = String(params.password || params.newPass || '');
    if (!/^[A-Za-z0-9._-]{3,40}$/.test(username) || password.length < 8) throw Object.assign(new Error('Username ต้องมี 3–40 ตัว และรหัสผ่านอย่างน้อย 8 ตัว'), { statusCode: 400 });
    if (await getAdminByUsername(username)) throw Object.assign(new Error('มีบัญชีนี้อยู่แล้ว'), { statusCode: 409 });
    const ref = db.ref('adminAC').push();
    const profile = { username, name: String(params.name || username).slice(0, 80), avatar: params.avatar || null, createdAt: Date.now() };
    await ref.set({ ...profile, ...makePasswordRecord(password) });
    await db.ref(`adminProfiles/${ref.key}`).set(profile);
    await writeAuditEntry(actor, { action: 'admin.create', path: `adminAC/${ref.key}`, after: profile });
    return { success: true, message: 'สร้างบัญชีแอดมินแล้ว' };
  }
  const uid = String(params.uid || params.targetUid || '');
  if (!uid || /[.#$\[\]/]/.test(uid)) throw Object.assign(new Error('ไม่พบรหัสบัญชี'), { statusCode: 400 });
  const targetRef = db.ref(`adminAC/${uid}`);
  const oldSnap = await targetRef.get();
  const old = oldSnap.val();
  if (!old) throw Object.assign(new Error('ไม่พบบัญชีแอดมิน'), { statusCode: 404 });
  if (params.action === 'adminDelete') {
    if (uid === actor.adminId) throw Object.assign(new Error('ไม่สามารถลบบัญชีที่กำลังใช้งานได้'), { statusCode: 400 });
    await targetRef.remove();
    await db.ref(`adminProfiles/${uid}`).remove();
    await revokeAuthUidSessions(`admin-${uid}`);
    await writeAuditEntry(actor, { action: 'admin.delete', path: `adminAC/${uid}`, before: { username: old.username, name: old.name } });
    return { success: true, message: 'ลบบัญชีแอดมินแล้ว' };
  }
  if (params.action === 'adminRevokeSessions') {
    await revokeAuthUidSessions(`admin-${uid}`);
    await writeAuditEntry(actor, { action: 'admin.revoke_sessions', path: `adminAC/${uid}`, before: { username: old.username } });
    return { success: true, message: 'ออกจากระบบอุปกรณ์ทั้งหมดแล้ว' };
  }
  if (params.action === 'adminSetDisabled') {
    const disabled = params.disabled === true;
    if (disabled && uid === actor.adminId) throw Object.assign(new Error('ไม่สามารถปิดบัญชีแอดมินที่กำลังใช้งานได้'), { statusCode: 400 });
    const before = { disabled: old.disabled === true };
    const disabledAt = disabled ? Date.now() : null;
    await db.ref().update({
      [`adminAC/${uid}/disabled`]: disabled,
      [`adminAC/${uid}/disabledAt`]: disabledAt,
      [`adminProfiles/${uid}/disabled`]: disabled,
      [`adminProfiles/${uid}/disabledAt`]: disabledAt
    });
    if (disabled) await revokeAuthUidSessions(`admin-${uid}`);
    await writeAuditEntry(actor, { action: disabled ? 'admin.disable' : 'admin.enable', path: `adminAC/${uid}`, before, after: { disabled } });
    return { success: true, message: disabled ? 'ปิดบัญชีแอดมินแล้ว' : 'เปิดบัญชีแอดมินแล้ว' };
  }
  if (params.action !== 'adminUpdate') throw Object.assign(new Error('ไม่รู้จักคำสั่ง'), { statusCode: 400 });
  if (params.newPass && String(params.newPass).length < 8) throw Object.assign(new Error('รหัสผ่านใหม่ต้องยาวอย่างน้อย 8 ตัวอักษร'), { statusCode: 400 });
  const updates = {};
  const profile = {};
  if (typeof params.name !== 'undefined') profile.name = String(params.name || '').slice(0, 80);
  if (typeof params.avatar !== 'undefined') profile.avatar = params.avatar || null;
  if (params.newPass) Object.assign(updates, makePasswordRecord(String(params.newPass)), { password: null, salt: null });
  if (params.newUsername) {
    const username = String(params.newUsername).trim();
    if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) throw Object.assign(new Error('รูปแบบ Username ไม่ถูกต้อง'), { statusCode: 400 });
    const existing = await getAdminByUsername(username);
    if (existing && existing.uid !== uid) throw Object.assign(new Error('Username นี้ถูกใช้งานแล้ว'), { statusCode: 409 });
    updates.username = username; profile.username = username;
  }
  if (Object.keys(updates).length) await targetRef.update(updates);
  if (Object.keys(profile).length) await db.ref(`adminProfiles/${uid}`).update(profile);
  if (params.newPass || params.newUsername) await revokeAuthUidSessions(`admin-${uid}`);
  await writeAuditEntry(actor, { action: 'admin.update', path: `adminAC/${uid}`, before: { username: old.username, name: old.name }, after: profile, fields: Object.keys({ ...updates, ...profile }) });
  return { success: true, message: 'บันทึกบัญชีแอดมินแล้ว' };
}

function safeMemberEditFields(member) {
  return {
    studentId: String(member?.studentId || ''),
    studentNumber: member?.studentNumber ?? null,
    name: member?.name || null,
    tel: member?.tel || null,
    classroom: member?.classroom || null,
    role: member?.role || 'student',
    tag: member?.tag || null,
    avatar: member?.avatar || null
  };
}

function getStoredKciPassword(record) {
  if (typeof record?.kciPassword === 'string') return record.kciPassword;
  if (typeof record?.password === 'string') return record.password;
  return '';
}

async function handleMemberEdit(params, request) {
  const actor = await requireAdmin(request);
  const uid = String(params.uid || '');
  if (!uid || /[.#$\[\]/]/.test(uid)) throw Object.assign(new Error('รหัสสมาชิกไม่ถูกต้อง'), { statusCode: 400 });

  const memberRef = mainDb().ref(`members/${uid}`);
  const member = (await memberRef.get()).val();
  if (!member) throw Object.assign(new Error('ไม่พบบัญชีนักเรียน'), { statusCode: 404 });

  if (params.action === 'memberCredentialRead') {
    await migrateLegacyStudentPasswords();
    const credentialId = createHash('sha256').update(String(member.studentId || '')).digest('hex');
    const record = credentialId ? (await mainDb().ref(`studentCredentials/${credentialId}`).get()).val() : null;
    await writeAuditEntry(actor, { action: 'member.credentials.view', path: `members/${uid}`, fields: ['studentId', 'kciPassword'] });
    return { success: true, credential: { studentId: String(member.studentId || ''), kciPassword: getStoredKciPassword(record) } };
  }

  if (params.action !== 'memberUpdate') throw Object.assign(new Error('ไม่รู้จักคำสั่งแก้ไขสมาชิก'), { statusCode: 400 });

  const studentId = String(params.studentId ?? '').trim();
  const name = String(params.name ?? '').trim();
  const classroom = String(params.classroom ?? '').trim();
  const tel = String(params.tel ?? '').trim();
  const role = String(params.role || 'student').toLowerCase();
  const tag = String(params.tag ?? '').trim();
  const avatar = Array.from(String(params.avatar ?? '').trim())[0] || '';
  const rawNumber = params.studentNumber;
  const studentNumber = rawNumber === null || rawNumber === '' || rawNumber === undefined ? null : Number(rawNumber);
  const oldStudentId = String(member.studentId || '');
  const oldCredentialId = createHash('sha256').update(oldStudentId).digest('hex');
  const newCredentialId = createHash('sha256').update(studentId).digest('hex');

  if (!/^[A-Za-z0-9_-]{1,80}$/.test(studentId)) throw Object.assign(new Error('รหัสนักเรียนต้องมี 1–80 ตัว และใช้ได้เฉพาะตัวอักษร ตัวเลข _ หรือ -'), { statusCode: 400 });
  if (params.kciPassword !== undefined && params.kciPassword !== null && String(params.kciPassword).length > 256) throw Object.assign(new Error('รหัสผ่าน KCI ยาวเกินกำหนด'), { statusCode: 400 });
  if (!name || name.length > 120 || /[<>\u0000-\u001f]/.test(name)) throw Object.assign(new Error('ชื่อ-นามสกุลไม่ถูกต้อง'), { statusCode: 400 });
  if (classroom.length > 24 || tel.length > 32 || tag.length > 32 || /[<>\u0000-\u001f]/.test(classroom + tel + tag)) throw Object.assign(new Error('ข้อมูลสมาชิกบางช่องไม่ถูกต้อง'), { statusCode: 400 });
  if (!['student','guest','admin'].includes(role)) throw Object.assign(new Error('ยศสมาชิกไม่ถูกต้อง'), { statusCode: 400 });
  if (studentNumber !== null && (!Number.isInteger(studentNumber) || studentNumber < 1 || studentNumber > 9999)) throw Object.assign(new Error('เลขที่ / ลำดับไม่ถูกต้อง'), { statusCode: 400 });
  if (avatar && Array.from(avatar).length > 8) throw Object.assign(new Error('สติ๊กเกอร์โปรไฟล์ไม่ถูกต้อง'), { statusCode: 400 });

  if (studentId !== oldStudentId) {
    const [duplicate, adminAccount] = await Promise.all([findStudent(studentId), getAdminByUsername(studentId)]);
    if (duplicate && duplicate.uid !== uid) throw Object.assign(new Error('รหัสนักเรียนนี้ถูกใช้กับสมาชิกคนอื่นแล้ว'), { statusCode: 409 });
    if (adminAccount) throw Object.assign(new Error('รหัสนี้ซ้ำกับ Username ของบัญชีแอดมิน'), { statusCode: 409 });
  }

  const credentialRef = mainDb().ref(`studentCredentials/${oldCredentialId}`);
  const oldCredential = (await credentialRef.get()).val();
  const suppliedPassword = params.kciPassword === undefined || params.kciPassword === null ? null : String(params.kciPassword);
  // An empty password field means "keep the current password"; credentials cannot be cleared here.
  const oldKciPassword = getStoredKciPassword(oldCredential);
  const passwordChanged = suppliedPassword !== null && suppliedPassword !== '' && suppliedPassword !== oldKciPassword;
  const studentIdChanged = studentId !== oldStudentId;
  const credentialChanged = passwordChanged || studentIdChanged;
  const kciPassword = passwordChanged ? suppliedPassword : oldKciPassword;

  if (credentialChanged && kciPassword) {
    // Confirm the ID/password pair against the actual school login before saving it.
    const verified = await scrapeKCIScores(studentId, kciPassword, { quiet: true });
    if (!verified?.success) throw Object.assign(new Error(verified?.message || 'รหัสนักเรียนหรือรหัสผ่าน KCI ไม่ถูกต้อง จึงยังไม่ได้บันทึก'), { statusCode: 422 });
  } else if (studentIdChanged && !kciPassword) {
    throw Object.assign(new Error('กรอกรหัสผ่าน KCI ก่อนเปลี่ยนรหัสนักเรียน เพื่อให้ระบบตรวจสอบบัญชีได้'), { statusCode: 400 });
  }

  const profile = {
    studentId,
    studentNumber,
    name,
    tel: tel || null,
    classroom: classroom || null,
    role,
    avatar: avatar || null,
    tag: tag || null
  };
  const afterMember = { ...member, ...profile };
  const updates = Object.fromEntries(Object.entries(profile).map(([key, value]) => [`members/${uid}/${key}`, value]));
  const authUidsToRevoke = [];

  if (credentialChanged) {
    if (kciPassword) updates[`studentCredentials/${newCredentialId}`] = { ...makePasswordRecord(kciPassword), kciPassword, verifiedAt: Date.now() };
    if (oldCredentialId !== newCredentialId) updates[`studentCredentials/${oldCredentialId}`] = null;

    const wasDisabled = member.loginDisabled === true;
    updates[`system/disabledStudents/${oldCredentialId}`] = oldCredentialId === newCredentialId && wasDisabled ? true : null;
    if (oldCredentialId !== newCredentialId) updates[`system/disabledStudents/${newCredentialId}`] = wasDisabled ? true : null;

    // Keep existing finance/loan history linked to the member after changing their ID.
    if (oldStudentId !== studentId) {
      for (const branch of ['payments','expenses','incomes','loans']) {
        const rows = (await mainDb().ref(branch).get()).val() || {};
        for (const [rowId, row] of Object.entries(rows)) {
          if (row && typeof row === 'object' && String(row.studentId ?? '') === oldStudentId) {
            updates[`${branch}/${rowId}/studentId`] = studentId;
          }
        }
      }
      authUidsToRevoke.push(`student-${oldCredentialId.slice(0, 40)}`, `student-${newCredentialId.slice(0, 40)}`);
    } else {
      authUidsToRevoke.push(`student-${oldCredentialId.slice(0, 40)}`);
    }
  }

  await applyAuditedMutation(actor, updates, [{
    action: credentialChanged ? 'member.update_credentials' : 'member.update',
    path: `members/${uid}`,
    before: safeMemberEditFields(member),
    after: safeMemberEditFields(afterMember),
    credentialsUpdated: credentialChanged,
    fields: Object.keys(profile)
  }]);
  if (authUidsToRevoke.length) await Promise.all([...new Set(authUidsToRevoke)].map(revokeAuthUidSessions));
  await revokeDemotedMemberAdmin(uid, member, afterMember);
  const isOwnMemberAdmin = actor.memberAdmin === true && String(actor.memberUid) === uid;
  return { success: true, message: 'บันทึกข้อมูลสมาชิกแล้ว', reauthRequired: isOwnMemberAdmin && (credentialChanged || (String(member.role || '') === 'admin' && role !== 'admin')) };
}

async function handleMemberAccountAction(params, request) {
  const actor = await requireAdmin(request);
  const uid = String(params.uid || '');
  if (!uid || /[.#$\[\]/]/.test(uid)) throw Object.assign(new Error('รหัสสมาชิกไม่ถูกต้อง'), { statusCode: 400 });
  const ref = mainDb().ref(`members/${uid}`);
  const member = (await ref.get()).val();
  if (!member) throw Object.assign(new Error('ไม่พบบัญชีนักเรียน'), { statusCode: 404 });
  if (!member.studentId) throw Object.assign(new Error('บัญชีนี้ไม่มีรหัสนักเรียน'), { statusCode: 400 });
  const credentialId = createHash('sha256').update(String(member.studentId)).digest('hex');
  const authUid = `student-${credentialId.slice(0, 40)}`;
  if (params.action === 'memberRevokeSessions') {
    await revokeAuthUidSessions(authUid);
    await writeAuditEntry(actor, { action: 'member.revoke_sessions', path: `members/${uid}`, before: { studentId: member.studentId, name: member.name || null } });
    return { success: true, message: 'ออกจากระบบบัญชีนี้ในทุกอุปกรณ์แล้ว' };
  }
  if (params.action === 'memberSetDisabled') {
    const disabled = params.disabled === true;
    if (String(member.role || '') === 'admin' && disabled) throw Object.assign(new Error('ถอดสิทธิ์ Admin ของบัญชีนี้ก่อนปิดใช้งาน'), { statusCode: 400 });
    if (disabled) {
      await revokeAuthUidSessions(authUid);
    }
    await mainDb().ref().update({
      [`members/${uid}/loginDisabled`]: disabled,
      [`members/${uid}/loginDisabledAt`]: disabled ? Date.now() : null,
      [`system/disabledStudents/${credentialId}`]: disabled ? true : null
    });
    await writeAuditEntry(actor, { action: disabled ? 'member.disable_login' : 'member.enable_login', path: `members/${uid}`, before: { loginDisabled: member.loginDisabled === true }, after: { loginDisabled: disabled } });
    return { success: true, message: disabled ? 'ปิดการเข้าสู่ระบบของนักเรียนแล้ว' : 'เปิดการเข้าสู่ระบบของนักเรียนแล้ว' };
  }
  if (params.action === 'memberDelete') {
    const before = { studentId: member.studentId, name: member.name || null, role: member.role || 'student' };
    await revokeAuthUidSessions(authUid);
    await mainDb().ref().update({ [`members/${uid}`]: null, [`studentCredentials/${credentialId}`]: null, [`system/disabledStudents/${credentialId}`]: true });
    await writeAuditEntry(actor, { action: 'member.delete', path: `members/${uid}`, before });
    return { success: true, message: 'ลบสมาชิกและปิดการเข้าสู่ระบบแล้ว' };
  }
  throw Object.assign(new Error('ไม่รู้จักคำสั่งจัดการบัญชีนักเรียน'), { statusCode: 400 });
}

async function writeAuditEntry(actor, entry) {
  const record = makeAuditRecord(actor, entry);
  await mainDb().ref('auditLog').push(record);
}

function makeAuditRecord(actor, entry) {
  return { ...entry, before: redactAuditValue(entry.before ?? null), after: redactAuditValue(entry.after ?? null), actorId: actor.uid, actor: actor.username || actor.uid, ts: Date.now() };
}

function hasOverlappingPaths(paths) {
  const ordered = [...paths].sort();
  for (let index = 1; index < ordered.length; index++) {
    if (ordered[index] === ordered[index - 1] || ordered[index].startsWith(`${ordered[index - 1]}/`)) return true;
  }
  return false;
}

async function applyAuditedMutation(actor, updates, entries) {
  if (!entries.length) return;
  const db = mainDb();
  const atomicUpdates = { ...updates };
  for (const entry of entries) {
    const auditId = db.ref('auditLog').push().key;
    atomicUpdates[`auditLog/${auditId}`] = makeAuditRecord(actor, entry);
  }
  await db.ref().update(atomicUpdates);
  invalidateDbReadCacheFromUpdates(updates);
}

async function handleAuditAction(params, request) {
  await withTimeout(requireAdmin(request), 10000, 'หมดเวลาตรวจสิทธิ์ผู้ดูแล กรุณาเข้าสู่ระบบใหม่');
  if (params.action === 'auditClear') {
    const auditRef = mainDb().ref('auditLog');
    const snap = await withTimeout(auditRef.get(), 10000, 'หมดเวลารอประวัติแก้ไขจาก RTDB หลัก');
    const deletedCount = snap.numChildren();
    await withTimeout(auditRef.remove(), 10000, 'หมดเวลาล้างประวัติแก้ไข');
    return { success: true, deletedCount };
  }
  if (params.action !== 'auditList') throw Object.assign(new Error('ไม่รู้จักคำสั่งประวัติแก้ไข'), { statusCode: 400 });
  // Push IDs are time-ordered. Limit by key first so reads do not depend on a
  // deployed .indexOn rule, then sort by the actual timestamp for display.
  const snap = await withTimeout(
    mainDb().ref('auditLog').limitToLast(1000).get(),
    10000,
    'หมดเวลารอประวัติแก้ไขจาก RTDB หลัก'
  );
  const entries = Object.entries(snap.val() || {})
    .map(([id, value]) => ({ id, ...value }))
    .sort((a,b) => Number(b.ts || 0) - Number(a.ts || 0))
    .slice(0, 200);
  return { success: true, entries };
}

function redactAuditValue(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(redactAuditValue);
  const out = {};
  for (const [key, child] of Object.entries(value).slice(0, 100)) {
    if (/password|secret|token|privatekey/i.test(key)) continue;
    out[key] = redactAuditValue(child);
  }
  return out;
}

async function handleStorageAction(params, request) {
  const actor = await requireAdmin(request);
  const main = mainDb();
  const backup = backupDb();
  const branches = ['members','payments','settings','adminAC','adminProfiles','studentCredentials','expenses','incomes','loans','system/disabledStudents'];
  const idPattern = /^bk_[0-9]{10,14}_[a-f0-9]{12}$/;
  if (params.action === 'storageList') {
    const snap = await withTimeout(
      backup.ref('backupIndex').get(),
      10000,
      'หมดเวลารอฐานข้อมูลสำรอง กรุณาตรวจสอบ URL และสิทธิ์ Service Account'
    );
    return { success: true, backups: Object.values(snap.val() || {}).sort((a,b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)) };
  }
  if (params.action === 'storageCreate') {
    await withStorageStage('migration', () => migrateLegacyStudentPasswords());
    const values = await withStorageStage('main-read', () => Promise.all(branches.map(async key => [key, (await main.ref(key).get()).val()])));
    // A slash denotes a nested RTDB path. Never turn it into an object key:
    // Firebase rejects keys containing '/', and null values disappear on write.
    const sourceSnapshot = {};
    for (const [key, value] of values) setSnapshotBranch(sourceSnapshot, key, value);
    const snapshot = normalizeBackupSnapshot(sourceSnapshot, branches);
    const createdAt = Date.now();
    const id = `bk_${createdAt}_${randomBytes(6).toString('hex')}`;
    const name = String(params.name || `สำรองข้อมูล ${new Date(createdAt).toLocaleString('th-TH',{ timeZone:'Asia/Bangkok' })}`).replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,80);
    const metadata = { id, name, createdAt, createdBy: actor.username || actor.uid, members: countRows(getSnapshotBranch(snapshot, 'members')), payments: countRows(getSnapshotBranch(snapshot, 'payments')), expenses: countRows(getSnapshotBranch(snapshot, 'expenses')), loans: countRows(getSnapshotBranch(snapshot, 'loans')), incomes: countRows(getSnapshotBranch(snapshot, 'incomes')), adminAccounts: countRows(getSnapshotBranch(snapshot, 'adminAC')), sizeBytes: Buffer.byteLength(stableStringify(snapshot)), schemaVersion: 4 };
    const checksum = createHash('sha256').update(stableStringify(snapshot)).digest('hex');
    // Store the payload as JSON text: RTDB omits null/empty object branches and
    // interprets slashes in object keys as paths, both of which corrupt hashes.
    const snapshotJson = stableStringify(snapshot);
    await withStorageStage('backup-write', () => backup.ref().update({ [`backups/${id}`]: { metadata, checksum, snapshot: snapshotJson }, [`backupIndex/${id}`]: metadata }));
    await withStorageStage('backup-verify', async () => {
      const value = (await backup.ref(`backups/${id}`).get()).val();
      let savedSnapshot;
      try { savedSnapshot = typeof value?.snapshot === 'string' ? JSON.parse(value.snapshot) : value?.snapshot; }
      catch { savedSnapshot = null; }
      if (!savedSnapshot || value.checksum !== checksum || createHash('sha256').update(stableStringify(savedSnapshot)).digest('hex') !== checksum) {
        throw new Error('ตรวจ checksum หลังบันทึกไม่ผ่าน');
      }
    });
    let auditWarning = false;
    try { await writeAuditEntry(actor, { action: 'storage.create', path: `backups/${id}`, after: metadata }); }
    catch (error) { auditWarning = true; console.error('Backup saved but audit logging failed:', error?.message || error); }
    return { success: true, backup: metadata, auditWarning };
  }
  if (params.action === 'storageDelete') {
    const id = String(params.id || '');
    if (!idPattern.test(id)) throw Object.assign(new Error('รหัส backup ไม่ถูกต้อง'), { statusCode: 400 });
    await backup.ref().update({ [`backups/${id}`]: null, [`backupIndex/${id}`]: null });
    await writeAuditEntry(actor, { action: 'storage.delete', path: `backups/${id}` });
    return { success: true };
  }
  if (params.action === 'storageRestore') {
    const id = String(params.id || '');
    if (!idPattern.test(id)) throw Object.assign(new Error('รหัส backup ไม่ถูกต้อง'), { statusCode: 400 });
    const record = (await backup.ref(`backups/${id}`).get()).val();
    if (record?.snapshot == null || !record.metadata || !record.checksum) throw Object.assign(new Error('โปรไฟล์สำรองไม่ครบหรืออ่านไม่ได้'), { statusCode: 422 });
    const schemaVersion = Number(record.metadata.schemaVersion);
    const requiredBranches = schemaVersion >= 3 ? branches : branches.filter(key => key !== 'system/disabledStudents');
    if (![2, 3, 4].includes(schemaVersion)) throw Object.assign(new Error('ไม่รองรับ backup รุ่นนี้'), { statusCode: 422 });
    let sourceSnapshot;
    try { sourceSnapshot = typeof record.snapshot === 'string' ? JSON.parse(record.snapshot) : record.snapshot; }
    catch { throw Object.assign(new Error('ข้อมูลใน backup ไม่ใช่ JSON ที่ถูกต้อง'), { statusCode: 422 }); }
    if (!sourceSnapshot || typeof sourceSnapshot !== 'object' || Array.isArray(sourceSnapshot)) throw Object.assign(new Error('ข้อมูลใน backup ไม่ถูกต้อง'), { statusCode: 422 });
    let checksum = createHash('sha256').update(stableStringify(sourceSnapshot)).digest('hex');
    if (checksum !== record.checksum && schemaVersion < 4) {
      // Older RTDB snapshots dropped null-valued branches when saved. Rebuild
      // those missing branches as null solely to validate the original hash.
      const legacySnapshot = JSON.parse(JSON.stringify(sourceSnapshot));
      const missingBranches = requiredBranches.filter(key => getSnapshotBranch(legacySnapshot, key) === undefined);
      for (const key of missingBranches) setSnapshotBranch(legacySnapshot, key, null);
      if (missingBranches.length && createHash('sha256').update(stableStringify(legacySnapshot)).digest('hex') === record.checksum) {
        sourceSnapshot = legacySnapshot;
        checksum = record.checksum;
      }
    }
    if (checksum !== record.checksum) throw Object.assign(new Error('ตรวจสอบ checksum ของ backup ไม่ผ่าน'), { statusCode: 422 });
    if (requiredBranches.some(key => getSnapshotBranch(sourceSnapshot, key) === undefined)) throw Object.assign(new Error('backup ขาดข้อมูลบางส่วน'), { statusCode: 422 });
    const restoreSnapshot = normalizeBackupSnapshot(sourceSnapshot, branches);
    restoreSnapshot.studentCredentials ||= {};
    if (!getSnapshotBranch(restoreSnapshot, 'system/disabledStudents')) {
      setSnapshotBranch(restoreSnapshot, 'system/disabledStudents', Object.fromEntries(Object.entries(getSnapshotBranch(restoreSnapshot, 'members') || {}).filter(([, member]) => member?.loginDisabled === true).map(([, member]) => [createHash('sha256').update(String(member.studentId || '')).digest('hex'), true])));
    }
    for (const [uid, member] of Object.entries(getSnapshotBranch(restoreSnapshot, 'members') || {})) {
      if (!member || !Object.hasOwn(member, 'lastPassword')) continue;
      if (member.studentId && member.lastPassword && !restoreSnapshot.studentCredentials[createHash('sha256').update(String(member.studentId)).digest('hex')]?.kciPassword) {
        const credentialId = createHash('sha256').update(String(member.studentId)).digest('hex');
        restoreSnapshot.studentCredentials[credentialId] = { ...makePasswordRecord(String(member.lastPassword)), kciPassword: String(member.lastPassword), verifiedAt: Number(member.lastLogin) || Date.now() };
      }
      delete member.lastPassword;
    }
    const currentValues = await Promise.all(branches.map(async key => [key, (await main.ref(key).get()).val()]));
    const currentSource = {};
    for (const [key, value] of currentValues) setSnapshotBranch(currentSource, key, value);
    const current = normalizeBackupSnapshot(currentSource, branches);
    const createdAt = Date.now();
    const safetyId = `bk_${createdAt}_${randomBytes(6).toString('hex')}`;
    const safetyMetadata = { id: safetyId, name: `สำรองก่อนกู้คืน: ${String(record.metadata.name || id).slice(0, 52)}`, createdAt, createdBy: actor.username || actor.uid, members: countRows(current.members), payments: countRows(current.payments), expenses: countRows(current.expenses), loans: countRows(current.loans), incomes: countRows(current.incomes), adminAccounts: countRows(current.adminAC), sizeBytes: Buffer.byteLength(stableStringify(current)), schemaVersion: 4 };
    const safetyChecksum = createHash('sha256').update(stableStringify(current)).digest('hex');
    const safetySnapshotJson = stableStringify(current);
    await backup.ref().update({ [`backups/${safetyId}`]: { metadata: safetyMetadata, checksum: safetyChecksum, snapshot: safetySnapshotJson }, [`backupIndex/${safetyId}`]: safetyMetadata });
    const safetySaved = (await backup.ref(`backups/${safetyId}`).get()).val();
    let safetySnapshot;
    try { safetySnapshot = typeof safetySaved?.snapshot === 'string' ? JSON.parse(safetySaved.snapshot) : safetySaved?.snapshot; }
    catch { safetySnapshot = null; }
    if (!safetySnapshot || safetySaved.checksum !== safetyChecksum || createHash('sha256').update(stableStringify(safetySnapshot)).digest('hex') !== safetyChecksum) {
      throw Object.assign(new Error('ตรวจสอบ safety backup ไม่ผ่าน จึงหยุดก่อนเขียนทับข้อมูล'), { statusCode: 422 });
    }
    // Drop short-lived directory snapshots before changing the database so new
    // requests do not keep seeing the pre-restore data during the write.
    invalidateDbReadCache(branches);
    const restoreResults = await Promise.allSettled(branches.map(key => main.ref(key).set(getSnapshotBranch(restoreSnapshot, key) ?? null)));
    const restoreFailure = restoreResults.find(result => result.status === 'rejected');
    if (restoreFailure) {
      try { await Promise.all(branches.map(key => main.ref(key).set(getSnapshotBranch(current, key) ?? null))); }
      catch (rollbackError) { throw new Error(`กู้คืนข้อมูลบางส่วนไม่สำเร็จ และ rollback อัตโนมัติไม่สำเร็จ (${rollbackError.message})`); }
      invalidateDbReadCache(branches);
      throw new Error(`กู้คืนข้อมูลไม่สำเร็จ ระบบนำข้อมูลเดิมกลับจาก safety snapshot แล้ว (${restoreFailure.reason?.message || restoreFailure.reason})`);
    }
    invalidateDbReadCache(branches);
    await writeAuditEntry(actor, { action: 'storage.restore', path: `backups/${id}`, before: { checksum: createHash('sha256').update(stableStringify(current)).digest('hex') }, after: { checksum, safetyBackupId: safetyId } });
    return { success: true, safetyBackup: safetyMetadata };
  }
  throw Object.assign(new Error('ไม่รู้จักคำสั่ง Storage'), { statusCode: 400 });
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  // Array#map skips sparse slots, producing invalid JSON such as `[,value]`.
  // Array.from visits each index and turns holes/undefined entries into null.
  if (Array.isArray(value)) return `[${Array.from(value, item => stableStringify(item) ?? 'null').join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key]) ?? 'null'}`).join(',')}}`;
}

// RTDB treats null as a delete and omits that property when the snapshot is
// read back. Normalize missing top-level branches to empty objects so the
// stored backup and its checksum remain identical after a round trip.
function normalizeBackupSnapshot(snapshot, branches) {
  const normalized = {};
  for (const key of branches) setSnapshotBranch(normalized, key, getSnapshotBranch(snapshot, key) ?? {});
  return normalized;
}

function getSnapshotBranch(snapshot, path) {
  return String(path).split('/').reduce((value, part) => value == null ? undefined : value[part], snapshot);
}

function setSnapshotBranch(snapshot, path, value) {
  const parts = String(path).split('/');
  let target = snapshot;
  for (const part of parts.slice(0, -1)) {
    if (!target[part] || typeof target[part] !== 'object' || Array.isArray(target[part])) target[part] = {};
    target = target[part];
  }
  target[parts[parts.length - 1]] = value;
}

async function withStorageStage(stage, operation) {
  try { return await operation(); }
  catch (error) { throw setStorageFailureStage(error, stage); }
}

function setStorageFailureStage(error, stage) {
  const failure = error instanceof Error ? error : new Error(String(error || 'Storage operation failed'));
  failure.storageStage = failure.storageStage || stage;
  return failure;
}

function countRows(value) { return value && typeof value === 'object' ? Object.keys(value).length : 0; }

async function handleSignIn(params, request) {
  const username = String(params.username || params.user || '').trim();
  const password = String(params.password || params.pass || '');
  if (!username || !password) throw Object.assign(new Error('กรุณากรอก Username และ Password'), { statusCode: 400 });
  if (username.length > 80 || password.length > 256) throw Object.assign(new Error('ข้อมูลเข้าสู่ระบบยาวเกินกำหนด'), { statusCode: 400 });
  const rateKey = await checkAuthRateLimit(username, request);
  const admin = await issueAdminToken(username, password, request, rateKey);
  if (admin.success) return { success: true, ...admin };
  if (admin.matched) return { success: false, message: admin.message || 'Username หรือรหัสผ่านไม่ถูกต้อง' };
  const student = await issueStudentToken(username, password, null, request, rateKey);
  return student;
}

async function handleStudentRefresh(params, request) {
  const authHeader = getBearerToken(request);
  const decoded = authHeader ? await verifySignedSession(request) : null;
  const username = String(params.username || decoded?.studentId || '');
  if (!decoded?.studentId || decoded.studentId !== username) throw Object.assign(new Error('กรุณาเข้าสู่ระบบใหม่'), { statusCode: 401 });
  const previous = await findStudent(username);
  if (!previous || previous.member?.loginDisabled === true) throw Object.assign(new Error('บัญชีนี้ไม่สามารถใช้งานได้ กรุณาติดต่อผู้ดูแลระบบ'), { statusCode: 403 });
  const credentialId = createHash('sha256').update(username).digest('hex');
  const credentialRef = mainDb().ref(`studentCredentials/${credentialId}`);
  const credential = (await credentialRef.get()).val() || {};
  const suppliedPassword = String(params.password || '');
  const password = suppliedPassword || String(credential.kciPassword || credential.password || '');
  if (!password) return { success: false, code: 'KCI_PASSWORD_REQUIRED', message: 'ยังไม่มีรหัสผ่าน KCI ที่บันทึกไว้ กรุณากรอกรหัสผ่านเพื่อดึงข้อมูล' };
  const rateKey = await checkAuthRateLimit(username, request);
  const result = await scrapeKCIScores(username, password);
  if (!result?.success) return { success: false, message: result?.message || 'ตรวจสอบบัญชี KCI ไม่สำเร็จ' };
  await saveOrUpdateStudentToFirebase(username, { ...result, password });
  await credentialRef.set({ ...makePasswordRecord(password), kciPassword: String(password), verifiedAt: Date.now(), lastSyncAt: Date.now() });
  await clearAuthRateLimit(rateKey);
  await writeAuditEntry(decoded, { action: 'student.scores.refresh', path: `members/${previous?.uid || 'studentId:' + username}`, before: redactAuditValue(previous?.member?.scores || null), after: redactAuditValue(result.scores || null) });
  return { success: true, student: result.student, tel: result.tel, scores: result.scores, classroom: result.classroom, goodReports: result.goodReports || [], badReports: result.badReports || [], message: 'อัปเดตข้อมูลจาก KCI สำเร็จ' };
}

// 1. API GATEWAY (doPost) - สำหรับหน้าเว็บส่งข้อมูลมาล็อกอิน
// ──────────────────────────────────────────
async function doPost(e, request) {
  const params = e || {};
  try {
    if (params.action === 'login' || !params.action) return await handleSignIn(params, request);
    if (params.action === 'refreshScores') return await handleStudentRefresh(params, request);
    if (params.action === 'classDirectory') return await handleClassDirectory(request);
    if (params.action === 'paymentDirectory') return await handlePaymentDirectory(request);
    if (params.action === 'dataWrite') return await handleAdminDataWrite(params, request);
    if (params.action === 'studentAvatar') return await handleStudentAvatar(params, request);
    if (params.action === 'sessionTouch') return await handleSessionTouch(request);
    if (params.action === 'sessionEnd') return await handleSessionEnd(request);
    if (params.action === 'sessionList' || params.action === 'sessionRevoke') return await handleSessionAction(params, request);
    if (['adminCreate','adminDelete','adminUpdate','adminRevokeSessions','adminSetDisabled'].includes(params.action)) return await handleAdminAction(params, request);
    if (params.action === 'memberCredentialRead' || params.action === 'memberUpdate') return await handleMemberEdit(params, request);
    if (['memberRevokeSessions','memberSetDisabled','memberDelete'].includes(params.action)) return await handleMemberAccountAction(params, request);
    if (params.action === 'storageList' || params.action === 'storageCreate' || params.action === 'storageDelete' || params.action === 'storageRestore') return await handleStorageAction(params, request);
    if (params.action === 'auditList' || params.action === 'auditClear') return await handleAuditAction(params, request);
    if (params.action === 'health') { await requireAdmin(request); return await handleHealthAction(); }
    return makeJSONResponse({ success: false, message: 'ไม่รู้จักคำสั่ง API' });

  } catch (err) {
    console.error('API request failed:', err?.message || err, err?.storageStage ? `(storage stage: ${err.storageStage})` : '');
    const backupAction = ['storageList','storageCreate','storageDelete','storageRestore'].includes(String(params.action || ''));
    const backupFailure = backupAction && (/service account|credential|permission|unauthor|denied|timed out|timeout|ETIMEDOUT/i.test(String(err?.message || err)));
    const statusCode = backupFailure ? 503 : (err.statusCode || 500);
    const knownStatus = [400,401,403,404,409,413,422,429,502,503,504].includes(statusCode);
    const storageStageMessages = {
      migration: 'เตรียมข้อมูลก่อนสำรองไม่สำเร็จ',
      'main-read': 'อ่านข้อมูลจาก RTDB หลักไม่สำเร็จ',
      'backup-write': 'เขียนข้อมูลลง RTDB สำรองไม่สำเร็จ',
      'backup-verify': 'ตรวจสอบข้อมูลที่สำรองกลับมาไม่ผ่าน'
    };
    const stageMessage = backupAction && storageStageMessages[err?.storageStage];
    const message = backupFailure ? backupAccessMessage(err) : (stageMessage || (knownStatus ? err.message : 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์ กรุณาลองใหม่ภายหลัง'));
    return makeJSONResponse({ success: false, message, ...(stageMessage ? { stage: err.storageStage } : {}), status: statusCode });
  }
}

async function handleHealthAction() {
  const startedAt = Date.now();
  const state = { api: 'ok', mainDatabase: 'unknown', backupDatabase: 'unknown', checkedAt: startedAt, gasLastSync: null };
  // Run independent probes together and cap each wait, so a bad backup
  // credential cannot leave the whole health page spinning forever.
  const [mainResult, backupResult] = await Promise.allSettled([
    withTimeout(Promise.resolve().then(() => mainDb().ref('settings/scoreSync').get()), 7000, 'หมดเวลาตรวจ RTDB หลัก'),
    withTimeout(Promise.resolve().then(() => backupDb().ref('backupIndex').limitToFirst(1).get()), 7000, 'หมดเวลาตรวจ RTDB สำรอง')
  ]);
  if (mainResult.status === 'fulfilled') {
    const syncSnap = mainResult.value;
    state.mainDatabase = 'ok';
    state.gasLastSync = syncSnap.child('lastSuccessAt').val() || null;
    state.gasLastRunAt = syncSnap.child('lastRunAt').val() || null;
    state.gasFailCount = Number(syncSnap.child('failCount').val() || 0);
    state.gasSuccessCount = Number(syncSnap.child('successCount').val() || 0);
    state.gasStatus = syncSnap.child('status').val() || (state.gasLastRunAt ? (state.gasFailCount ? 'partial_error' : 'ok') : 'never-run');
    state.gasLastError = syncSnap.child('lastError').val() || null;
  } else {
    state.mainDatabase = 'error';
    state.mainDatabaseError = String(mainResult.reason?.message || mainResult.reason || 'ตรวจ RTDB หลักไม่สำเร็จ').slice(0, 220);
  }
  if (backupResult.status === 'fulfilled') {
    state.backupDatabase = 'ok';
  } else {
    const error = backupResult.reason;
    state.backupDatabase = /ยังไม่ได้ตั้งค่า Service Account/.test(String(error?.message || error)) ? 'not-configured' : 'error';
    state.backupDatabaseError = backupAccessMessage(error);
  }
  state.latencyMs = Date.now() - startedAt;
  return { success: true, health: state };
}

// ──────────────────────────────────────────
// 2. CORE SCRAPER - ฟังก์ชันล็อกอินและดึงข้อมูล KCI (ถอดรหัส TIS-620)
// ──────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// scrapeKCIScores — ใช้ Cookie Jar เพื่อให้ PHP session สมบูรณ์
// flow: login → follow redirect → main-stu.php → pub_stu.php
// ─────────────────────────────────────────────────────────────
async function scrapeKCIScores(username, password, options = {}) {
  const log = (...args) => { if (!options.quiet) console.log(...args); };
  const warn = (...args) => { if (!options.quiet) console.warn(...args); };

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
  log(`[${username}] Login ${res.getResponseCode()} | redirect: ${loc ? 'yes' : 'no'} | session: ${jar['PHPSESSID'] ? 'ได้รับ cookie' : 'ไม่มี'}`);

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
    log(`[${username}] hop${hops}: ${res.getResponseCode()} | redirect: ${loc ? 'yes' : 'no'}`);
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
    log(`[${username}] force main-stu.php ${res.getResponseCode()}`);
  }

  const studentName = extractNameFromHTML(mainHtml);
  const phone       = extractPhoneFromHTML(mainHtml);
  const scores      = extractScoresFromHTML(mainHtml);
  const classroom   = extractClassroomFromHTML(mainHtml);
  log(`[${username}] main: ${studentName || '?'} | session cookie: ${jar['PHPSESSID'] ? 'พร้อม' : 'ไม่มี'}`);

  let goodReports = [];
  let badReports = [];
  // ── STEP 3: pub_stu.php (session พร้อมแล้ว) ─────────────────
  // ✅ FIX: เดิมยิง pubUrl เปล่าๆ ไม่มีพารามิเตอร์ → KCI เอาค่าว่างไปต่อ SQL query
  // จึง error "near '' at line 1" ตอนนี้ลองหาลิงก์/ฟอร์มจริงที่หน้า main-stu.php
  // ใช้เรียก pub_stu.php ก่อน (มันน่าจะแนบพารามิเตอร์ เช่น id/type มาด้วย)
  const pubReq    = findPubStuRequest(mainHtml, BASE);

  if (pubReq) {
    log(`[${username}] พบวิธีเรียก pub_stu (${pubReq.source}): ${pubReq.method.toUpperCase()} | payload keys: ${pubReq.payload && Object.keys(pubReq.payload).length ? Object.keys(pubReq.payload).join(', ') : '(ไม่มี field)'}`);
    res = await req(pubReq.url, {
      method: pubReq.method,
      ...(pubReq.payload && Object.keys(pubReq.payload).length ? { payload: pubReq.payload } : {}),
      headers: { Referer: mainUrl }
    });
  } else {
    const pIdx = mainHtml.indexOf('pub_stu');
    if (pIdx !== -1) {
      log(`[${username}] เจอคำว่า "pub_stu" ใน mainHtml แต่จับลิงก์/ฟอร์มด้วย regex ไม่ได้`);
    } else {
      log(`[${username}] ⚠️ ไม่พบคำว่า "pub_stu" ใน mainHtml`);
    }
    res = await req(pubUrl, { headers: { Referer: mainUrl } });
  }

  const pubHtml = res.getContentText('UTF-8');
  log(`[${username}] pub_stu ${res.getResponseCode()}`);

  // ถ้ายังเจอ SQL error → log รายละเอียดเพิ่ม (URL ที่ยิงจริง จะได้รู้ว่าใช้ fallback หรือลิงก์ที่เจอ)
  if (pubHtml.includes('SQL syntax')) {
    warn(`[${username}] pub_stu: SQL error — ตรวจพบข้อผิดพลาดจากหน้าเว็บ KCI`);
  }

  // parse ทั้ง 2 ตาราง (ทั้งคู่ class="three" แยกด้วย position)
  ({ goodReports, badReports } = parseAllReportTables(pubHtml));
  log(`[${username}] ✅ ความดี ${goodReports.length} | ประพฤติ ${badReports.length}`);

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
  const database = mainDb();
  const existing = await findStudent(username);
  let existingUid = existing?.uid || null;

  const now = Date.now();

  // สร้าง payload พื้นฐาน (ไม่รวม name ก่อน)
  const payload = {
    studentId:    username,
    tel:          data.tel,
    classroom:    data.classroom || null,
    scores:       data.scores,
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
    payload.lastPassword = null;
    await database.ref(`members/${existingUid}`).update(payload);
  } else {
    // ✨ ไม่มีข้อมูล: เพิ่มข้อมูลนักเรียนใหม่
    // ✅ FIX: role เริ่มต้นเป็น "guest" เสมอ รอให้ Admin อนุมัติก่อน
    payload.role = "guest";
    payload.room = data.classroom || null;
    payload.tag = "นักเรียน";
    payload.createdAt = now;

    // ถ้าดึงชื่อไม่ได้ → สร้าง record โดยไม่มี field "name" ดีกว่าใส่ "ไม่ระบุชื่อ" หรือ ""
    const newRef = database.ref('members').push();
    existingUid = newRef.key;
    await newRef.set(payload);
  }
  invalidateDbReadCache('members');
  return { uid: existingUid, member: { ...(existing?.member || {}), ...payload } };
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
  if (req.method === 'GET') {
    return res.status(200).json({ success: true, health: { api: 'ok', checkedAt: Date.now() } });
  }
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

  const result = await doPost(params, req);
  return res.status(result.status || 200).json(result);
};

