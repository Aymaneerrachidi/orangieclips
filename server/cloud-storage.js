import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { S3Client, CreateMultipartUploadCommand, UploadPartCommand, ListPartsCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { validDay } from './analytics.js';

export function storageConfig() {
  const b2 = Boolean(process.env.B2_ENDPOINT);
  return b2 ? {
    endpoint: process.env.B2_ENDPOINT, region: process.env.B2_REGION || 'us-east-005',
    bucket: process.env.B2_BUCKET, accessKeyId: process.env.B2_KEY_ID, secretAccessKey: process.env.B2_APPLICATION_KEY,
  } : {
    endpoint: process.env.R2_ENDPOINT, region: 'auto', bucket: process.env.R2_BUCKET,
    accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  };
}
export const storageReady = () => Object.values(storageConfig()).every(Boolean);
export function storageClient() {
  const { endpoint, region, accessKeyId, secretAccessKey } = storageConfig();
  return new S3Client({ region, endpoint, credentials: { accessKeyId, secretAccessKey }, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
}
const MAX_SIZE = 2 * 1024 ** 3;
const PART_SIZE = 16 * 1024 ** 2;
const mimeFor = name => ({ '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/mp4' })[path.extname(name).toLowerCase()];
const unavailable = res => res.status(503).json({ error: 'Video storage is not connected yet. Please ask Orangie to connect storage, then try again.' });

export async function setupCloudStorage(app, db, auth, storage = { ready: storageReady, client: storageClient, sign: getSignedUrl }) {
  await db.exec(`CREATE TABLE IF NOT EXISTS cloud_uploads (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, day TEXT NOT NULL, original_name TEXT NOT NULL, pathname TEXT UNIQUE NOT NULL, expires BIGINT NOT NULL, size BIGINT NOT NULL, upload_id TEXT NOT NULL)`);
  app.get('/api/upload-config', auth, (req, res) => res.json({ mode: db.cloud ? 'cloud' : 'local', available: !db.cloud || storage.ready() }));
  const ownUpload = (id, user) => db.prepare('SELECT * FROM cloud_uploads WHERE id=? AND user_id=?').get(id, user.id);
  app.post('/api/uploads', auth, async (req, res) => {
    if (!db.cloud || !storage.ready()) return unavailable(res);
    const { title, day, name, size } = req.body;
    if (typeof title !== 'string' || !title.trim() || title.length > 120 || !validDay(day) || typeof name !== 'string' || name.length > 240 || !mimeFor(name) || !Number.isSafeInteger(size) || size <= 0 || size > MAX_SIZE) return res.status(400).json({ error: 'Choose a valid video, title, and date. Videos must be at most 2 GB.' });
    const id = randomUUID();
    const original = path.basename(name.replaceAll('\\', '/'));
    const pathname = `clips/${req.user.id}/${id}/${original}`;
    const client = storage.client();
    const params = { Bucket: storageConfig().bucket, Key: pathname };
    const multipart = await client.send(new CreateMultipartUploadCommand({ ...params, ContentType: mimeFor(original) }));
    try {
      await db.prepare('INSERT INTO cloud_uploads VALUES (?,?,?,?,?,?,?,?,?)').run(id, req.user.id, title.trim(), day, original, pathname, Date.now() + 24 * 3600000, size, multipart.UploadId);
      const urls = await Promise.all(Array.from({ length: Math.ceil(size / PART_SIZE) }, (_, i) => storage.sign(client, new UploadPartCommand({ ...params, UploadId: multipart.UploadId, PartNumber: i + 1, ContentLength: Math.min(PART_SIZE, size - i * PART_SIZE) }), { expiresIn: 3600 })));
      res.status(201).json({ id, partSize: PART_SIZE, urls });
    } catch (error) { await client.send(new AbortMultipartUploadCommand({ ...params, UploadId: multipart.UploadId })); throw error; }
  });
  app.post('/api/uploads/:id/complete', auth, async (req, res) => {
    if (!db.cloud || !storage.ready()) return unavailable(res);
    const pending = await ownUpload(req.params.id, req.user);
    if (!pending) return res.status(404).json({ error: 'Upload not found.' });
    if (pending.expires < Date.now()) return res.status(410).json({ error: 'Upload expired. Please try again.' });
    const client = storage.client();
    const params = { Bucket: storageConfig().bucket, Key: pending.pathname };
    let blob;
    try { blob = await client.send(new HeadObjectCommand(params)); } catch (e) { if (e.$metadata?.httpStatusCode !== 404) throw e; }
    if (!blob) {
      const { Parts = [] } = await client.send(new ListPartsCommand({ ...params, UploadId: pending.upload_id }));
      const expected = Math.ceil(pending.size / PART_SIZE);
      if (Parts.length !== expected || Parts.some((part, i) => part.PartNumber !== i + 1 || part.Size !== Math.min(PART_SIZE, pending.size - i * PART_SIZE))) return res.status(400).json({ error: 'Some parts are missing. Please retry the upload.' });
      await client.send(new CompleteMultipartUploadCommand({ ...params, UploadId: pending.upload_id, MultipartUpload: { Parts: Parts.map(({ ETag, PartNumber }) => ({ ETag, PartNumber })) } }));
      blob = await client.send(new HeadObjectCommand(params));
    }
    if (blob.ContentLength !== pending.size) return res.status(400).json({ error: 'Original file size could not be verified.' });
    const now = new Date().toISOString();
    await db.prepare('INSERT OR IGNORE INTO clips (id,title,day,filename,original_name,mime,size,user_id,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(pending.id, pending.title, pending.day, pending.pathname, pending.original_name, mimeFor(pending.original_name), pending.size, pending.user_id, now);
    await db.prepare('INSERT OR IGNORE INTO events VALUES (?,?,?,?,?,?,?)').run(`upload:${pending.id}`, pending.user_id, pending.user_id, pending.id, 'clip.uploaded', pending.title, now);
    res.json({ id: pending.id });
  });
  app.post('/api/uploads/:id/cancel', auth, async (req, res) => {
    if (!db.cloud || !storage.ready()) return unavailable(res);
    const pending = await ownUpload(req.params.id, req.user);
    if (!pending) return res.status(404).json({ error: 'Upload not found.' });
    try { await storage.client().send(new AbortMultipartUploadCommand({ Bucket: storageConfig().bucket, Key: pending.pathname, UploadId: pending.upload_id })); } catch (e) { if (e.name !== 'NoSuchUpload') throw e; }
    res.json({ ok: true });
  });
}

export async function serveCloudClip(req, res, clip) {
  if (!storageReady()) return unavailable(res);
  const filename = encodeURIComponent(clip.original_name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const url = await getSignedUrl(storageClient(), new GetObjectCommand({ Bucket: storageConfig().bucket, Key: clip.filename, ResponseContentType: req.params.action === 'download' ? 'application/octet-stream' : clip.mime, ResponseContentDisposition: `${req.params.action === 'download' ? 'attachment' : 'inline'}; filename*=UTF-8''${filename}` }), { expiresIn: 900 });
  // The server checks role access before issuing a 15-minute read URL for one object.
  // Playback ranges and original downloads travel directly from private storage to the browser.
  res.redirect(307, url);
}
