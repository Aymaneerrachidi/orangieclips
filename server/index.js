import { setupMembers } from './members.js';
import express from 'express';
import multer from 'multer';
import { setupCloudStorage, serveCloudClip } from './cloud-storage.js';
import { connectDatabase } from './database.js';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLES, STATUSES, permissionsFor, canReadClip } from './permissions.js';
import { analytics, validDay, shiftDay } from './analytics.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const db = await connectDatabase(data);
if (!db.cloud) await db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
await db.exec(`
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS clips (id TEXT PRIMARY KEY, title TEXT NOT NULL, day TEXT NOT NULL, filename TEXT NOT NULL, original_name TEXT NOT NULL, mime TEXT NOT NULL, size BIGINT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);`);
// Additive migration keeps existing accounts and original files intact.
await db.exec('BEGIN IMMEDIATE');
try {
  if (db.cloud) await db.exec('SELECT pg_advisory_xact_lock(7149201)');
  const userColumns = (await db.prepare(db.cloud ? "SELECT column_name AS name FROM information_schema.columns WHERE table_name='users'" : 'PRAGMA table_info(users)').all()).map(c => c.name);
  if (!userColumns.includes('deleted_at')) await db.exec('ALTER TABLE users ADD COLUMN deleted_at TEXT');
  if (!userColumns.includes('active')) await db.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
  if (!userColumns.includes('created_at')) await db.exec("ALTER TABLE users ADD COLUMN created_at TEXT NOT NULL DEFAULT ''");
  const clipColumns = (await db.prepare(db.cloud ? "SELECT column_name AS name FROM information_schema.columns WHERE table_name='clips'" : 'PRAGMA table_info(clips)').all()).map(c => c.name);
  if (!clipColumns.includes('status')) await db.exec("ALTER TABLE clips ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
  if (!clipColumns.includes('posting_tag')) await db.exec("ALTER TABLE clips ADD COLUMN posting_tag TEXT NOT NULL DEFAULT ''");
  if (!clipColumns.includes('review_note')) await db.exec("ALTER TABLE clips ADD COLUMN review_note TEXT NOT NULL DEFAULT ''");
  await db.exec(`CREATE TABLE IF NOT EXISTS workspace (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, actor_id TEXT REFERENCES users(id), subject_id TEXT REFERENCES users(id), clip_id TEXT REFERENCES clips(id), action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS clips_user_day ON clips(user_id, day);
    CREATE INDEX IF NOT EXISTS events_created ON events(created_at);`);
  await db.exec('COMMIT');
} catch (e) { await db.exec('ROLLBACK'); throw e; }
let initialOwner = await db.prepare("SELECT * FROM users WHERE role='owner' LIMIT 1").get();
if (!initialOwner) {
  const email = process.env.OWNER_EMAIL || 'orangie@cliproom.local';
  const password = process.env.OWNER_PASSWORD || randomBytes(24).toString('base64url');
  if (db.cloud && !process.env.OWNER_PASSWORD) throw new Error('OWNER_PASSWORD is required to initialize a cloud workspace.');
  credentials({ name: 'Orangie', email, password });
  const id = randomUUID();
  await db.prepare('INSERT INTO users (id,name,email,password,role,created_at) VALUES (?,?,?,?,?,?)').run(id, 'Orangie', email.toLowerCase(), hashPassword(password), 'owner', new Date().toISOString());
  initialOwner = await db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!process.env.OWNER_PASSWORD && !db.cloud) {
    writeFileSync(path.join(data, 'owner-access.txt'), `Orangie's Clip Room\nEmail: ${email}\nInitial password: ${password}\n\nChange this password in Account after signing in. This file is never served by the app.\n`, { mode: 0o600, flag: 'wx' });
    console.log('Owner account created. Initial credentials saved privately in DATA_DIR/owner-access.txt.');
  }
}
await db.prepare('INSERT OR IGNORE INTO workspace VALUES (?,?,?,?)').run('orangie', "Orangie's workspace", initialOwner.id, new Date().toISOString());
await db.exec("INSERT OR IGNORE INTO events SELECT 'upload:' || id,user_id,user_id,id,'clip.uploaded',title,created_at FROM clips WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.clip_id=clips.id AND e.action='clip.uploaded')");
const workspace = await db.prepare('SELECT * FROM workspace WHERE id=?').get('orangie');
async function record(actor, subject, clip, action, detail) { await db.prepare('INSERT INTO events VALUES (?,?,?,?,?,?,?)').run(randomUUID(), actor, subject, clip, action, detail, new Date().toISOString()); }
async function visibleClips(user) {
  return await db.prepare(`SELECT c.id,c.title,c.day,c.original_name,c.mime,c.size,c.user_id,c.created_at,c.status,c.review_note,c.posting_tag,u.name AS creator FROM clips c JOIN users u ON u.id=c.user_id ${permissionsFor(user.role).allClips ? '' : 'WHERE c.user_id=?'} ORDER BY c.created_at DESC`).all(...(permissionsFor(user.role).allClips ? [] : [user.id]));
}
db.ready?.();
const app = express();
app.use('/api', db.middleware);
app.disable('x-powered-by');
if (process.env.VERCEL) app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use(async (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
    try { if (new URL(req.headers.origin).host !== req.headers.host) return res.status(403).json({ error: 'Request origin is not allowed.' }); } catch { return res.sendStatus(403); }
  }
  next();
});
const digest = value => createHash('sha256').update(value).digest('hex');
function hashPassword(password) { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; }
function checkPassword(password, stored) { const [salt, hash] = stored.split(':'); return timingSafeEqual(Buffer.from(hash, 'hex'), scryptSync(password, salt, 64)); }
const publicUser = u => ({ id: u.id, name: u.name, email: u.email, role: u.role, permissions: permissionsFor(u.role) });
async function setSession(res, user) {
  const token = randomBytes(32).toString('hex');
  await db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  await db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(digest(token), user.id, Date.now() + 7 * 86400000);
  res.setHeader('Set-Cookie', `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${(process.env.COOKIE_SECURE === 'true' || process.env.VERCEL) ? '; Secure' : ''}`);
}
app.use('/api', async (req, res, next) => {
  const token = req.headers.cookie?.split('; ').find(c => c.startsWith('session='))?.slice(8);
  if (token) req.user = await db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.active=1').get(digest(token), Date.now());
  next();
});
const auth = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Please sign in to continue.' });
const staff = (req, res, next) => permissionsFor(req.user.role).teamStats ? next() : res.status(403).json({ error: 'Team access is required.' });
function credentials(body) {
  const { name, email, password } = body;
  if (typeof name !== 'string' || !name.trim() || name.length > 60) throw new Error('Enter a name of up to 60 characters.');
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error('Enter a valid email address.');
  if (typeof password !== 'string' || password.length < 12 || password.length > 200) throw new Error('Use a password between 12 and 200 characters.');
  return { name: name.trim(), email: email.trim().toLowerCase(), password };
}
app.get('/api/session', async (req, res) => res.json({ user: req.user ? publicUser(req.user) : null, workspace: { id: workspace.id, name: workspace.name }, needsSetup: false }));
app.post('/api/setup', (req, res) => res.status(409).json({ error: 'The workspace and owner account are already created. Sign in to continue.' }));
await db.exec('CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, until BIGINT NOT NULL)');
app.post('/api/login', async (req, res) => {
  const key = digest(req.ip || 'unknown'); const now = Date.now();
  const item = await db.prepare('INSERT INTO login_attempts (key,attempts,until) VALUES (?,1,?) ON CONFLICT (key) DO UPDATE SET attempts=CASE WHEN login_attempts.until>? THEN login_attempts.attempts+1 ELSE 1 END, until=CASE WHEN login_attempts.until>? THEN login_attempts.until ELSE ? END RETURNING attempts').get(key, now + 15 * 60000, now, now, now + 15 * 60000);
  if (item.attempts > 15) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const { email, password } = req.body;
  const user = typeof email === 'string' ? await db.prepare('SELECT * FROM users WHERE email=?').get(email.trim().toLowerCase()) : null;
  if (typeof password !== 'string' || password.length > 200 || !user || !user.active || !checkPassword(password, user.password)) return res.status(401).json({ error: 'Email or password is incorrect, or this account is disabled.' });
  await db.prepare('DELETE FROM login_attempts WHERE key=?').run(key); await setSession(res, user); res.json({ user: publicUser(user) });
});
app.post('/api/logout', auth, async (req, res) => {
  const token = req.headers.cookie?.split('; ').find(c => c.startsWith('session='))?.slice(8);
  if (token) await db.prepare('DELETE FROM sessions WHERE token=?').run(digest(token));
  res.setHeader('Set-Cookie', 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); res.json({ ok: true });
});
setupMembers(app, db, { auth, credentials, hashPassword, record });
app.get('/api/roles', auth, (req,res) => res.json(ROLES));
app.post('/api/account/password', auth, async (req, res) => {
  const { currentPassword, password } = req.body;
  if (typeof currentPassword !== 'string' || currentPassword.length > 200 || !checkPassword(currentPassword, req.user.password)) return res.status(400).json({ error: 'Your current password is incorrect.' });
  try { credentials({ ...req.user, password }); } catch(e) { return res.status(400).json({ error: e.message }); }
  await db.prepare('UPDATE users SET password=? WHERE id=?').run(hashPassword(password), req.user.id);
  await db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.user.id); await setSession(res, req.user);
  await record(req.user.id, req.user.id, null, 'account.password_changed', 'Password changed');
  res.json({ ok: true });
});
app.get('/api/clips', auth, async (req, res) => res.json(await visibleClips(req.user)));
app.get('/api/analytics', auth, async (req, res) => {
  const today = new Date().toISOString().slice(0,10); const from = req.query.from || shiftDay(today, -29); const to = req.query.to || today;
  if (!validDay(from) || !validDay(to) || from > to || (Date.parse(to) - Date.parse(from)) / 86400000 > 365) return res.status(400).json({ error: 'Choose a valid date range of up to 366 days.' });
  const all = permissionsFor(req.user.role).teamStats;
  const members = await db.prepare(`SELECT id,name,role,active FROM users ${all ? '' : 'WHERE id=?'}`).all(...(all ? [] : [req.user.id]));
  res.json({ scope: all ? 'workspace' : 'personal', ...analytics(await visibleClips(req.user), members, from, to) });
});
app.get('/api/activity', auth, async (req, res) => {
  const p = permissionsFor(req.user.role);
  const filter = p.auditLog ? '' : p.allClips ? "WHERE e.action LIKE 'clip.%'" : "WHERE e.subject_id=? AND e.action LIKE 'clip.%'";
  res.json(await db.prepare(`SELECT e.*,u.name AS actor,c.title,c.day FROM events e LEFT JOIN users u ON u.id=e.actor_id LEFT JOIN clips c ON c.id=e.clip_id ${filter} ORDER BY e.created_at DESC LIMIT 500`).all(...(!p.allClips ? [req.user.id] : [])));
});
app.patch('/api/clips/:id', auth, async (req, res) => {
  const clip = await db.prepare('SELECT * FROM clips WHERE id=?').get(req.params.id);
  if (!clip || !canReadClip(req.user, clip)) return res.status(404).json({ error: 'Clip not found.' });
  if (!permissionsFor(req.user.role).reviewClips) return res.status(403).json({ error: 'Only Orangie and Team members can review clips.' });
  const { status = clip.status, review_note = clip.review_note, posting_tag = clip.posting_tag } = req.body;
  if (!['', 'personal', 'clip_page'].includes(posting_tag)) return res.status(400).json({ error: 'Choose a valid posting tag.' });
  if (status === 'not_posting' && posting_tag) return res.status(400).json({ error: 'Clear the posting tag when choosing Not posting.' });
  if (!STATUSES.includes(status) || typeof review_note !== 'string' || review_note.length > 1000) return res.status(400).json({ error: 'Choose a valid status and keep notes under 1,000 characters.' });
  if (status === 'changes' && !review_note.trim()) return res.status(400).json({ error: 'Add a note so the clipper knows what to change.' });
  if (status === 'not_posting' && !review_note.trim()) return res.status(400).json({ error: 'Add a note explaining why this clip will not be posted.' });
  await db.exec('BEGIN IMMEDIATE');
  try {
    await db.prepare('UPDATE clips SET status=?,review_note=?,posting_tag=? WHERE id=?').run(status, review_note.trim(), posting_tag, clip.id);
    await record(req.user.id, clip.user_id, clip.id, 'clip.reviewed', `${clip.title}: ${status}${posting_tag ? `, ${posting_tag === 'personal' ? "Ima post" : "Post on Orangie clip page"}` : ""}${review_note.trim() ? ` - ${review_note.trim()}` : ""}`);
    await db.exec('COMMIT');
  } catch(e) { await db.exec('ROLLBACK'); throw e; }
  res.json({ ok: true });
});
await setupCloudStorage(app, db, auth);
const upload = multer({ dest: db.cloud ? '/tmp/cliproom-uploads' : path.join(data, 'uploads'), limits: { fileSize: 2 * 1024 ** 3, files: 1, fields: 2 }, fileFilter: (req, file, cb) => cb(null, ['.mp4', '.mov', '.webm', '.m4v'].includes(path.extname(file.originalname).toLowerCase())) });
app.post('/api/clips', auth, (req, res, next) => db.cloud ? res.status(400).json({ error: 'Use direct cloud uploads for this workspace.' }) : next(), upload.single('video'), async (req, res) => {
  const { title, day } = req.body;
  if (!req.file) return res.status(400).json({ error: 'Choose an MP4, MOV, M4V, or WebM video.' });
  if (typeof title !== 'string' || !title.trim() || title.length > 120 || !validDay(day)) {
    unlinkSync(req.file.path); return res.status(400).json({ error: 'Enter a title (up to 120 characters) and a valid date.' });
  }
  const id = randomUUID();
  await db.exec('BEGIN IMMEDIATE');
  try {
    await db.prepare('INSERT INTO clips (id,title,day,filename,original_name,mime,size,user_id,created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, title.trim(), day, req.file.filename, path.basename(req.file.originalname), req.file.mimetype, req.file.size, req.user.id, new Date().toISOString());
    await record(req.user.id, req.user.id, id, 'clip.uploaded', title.trim()); await db.exec('COMMIT');
  }
  catch (e) { await db.exec('ROLLBACK'); unlinkSync(req.file.path); throw e; }
  res.status(201).json({ id });
});
app.get('/api/clips/:id/:action', auth, async (req, res) => {
  const clip = await db.prepare('SELECT * FROM clips WHERE id=?').get(req.params.id);
  if (!clip || !canReadClip(req.user, clip) || !['preview', 'download'].includes(req.params.action)) return res.status(404).json({ error: 'Clip not found.' });
  if (db.cloud) return serveCloudClip(req, res, clip);
  const file = path.join(data, 'uploads', clip.filename);
  if (req.params.action === 'download') return res.download(file, clip.original_name);
  const types = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };
  res.type(types[path.extname(clip.original_name).toLowerCase()] || 'application/octet-stream'); res.sendFile(file);
});
app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
if (existsSync(path.join(root, 'dist'))) { app.use(express.static(path.join(root, 'dist'))); app.get('/{*path}', (req, res) => res.sendFile(path.join(root, 'dist/index.html'))); }
app.use((err, req, res, next) => { console.error(err.message); if (!res.headersSent) res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'This file exceeds the 2 GB limit.' : 'The request could not be completed. Please try again.' }); });
export default app;
if (!process.env.VERCEL) app.listen(Number(process.env.PORT || 3001), process.env.HOST || '127.0.0.1', error => { if (error) { console.error(error.message); process.exitCode = 1; return; } console.log(`Clip room ready on http://${process.env.HOST || '127.0.0.1'}:${process.env.PORT || 3001}`); });
