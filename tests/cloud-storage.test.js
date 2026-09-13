import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { setupCloudStorage } from '../server/cloud-storage.js';

test('cloud uploads enforce ownership and verified size; completion is idempotent', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES ('gyro'),('other');
    CREATE TABLE clips(id TEXT PRIMARY KEY,title TEXT,day TEXT,filename TEXT,original_name TEXT,mime TEXT,size BIGINT,user_id TEXT,created_at TEXT);
    CREATE TABLE events(id TEXT PRIMARY KEY,actor_id TEXT,subject_id TEXT,clip_id TEXT,action TEXT,detail TEXT,created_at TEXT);`);
  const db = { cloud: true, exec: sql => sqlite.exec(sql), prepare: sql => sqlite.prepare(sql) };
  const objects = new Map(); const parts = new Map(); let next = 0;
  const fake = { send: async command => {
    const p = command.input;
    switch (command.constructor.name) {
      case 'CreateMultipartUploadCommand': { const id = `upload-${++next}`; parts.set(id, []); return { UploadId: id }; }
      case 'HeadObjectCommand': { if (objects.has(p.Key)) return objects.get(p.Key); throw Object.assign(new Error('Missing'), { $metadata: { httpStatusCode: 404 } }); }
      case 'ListPartsCommand': return { Parts: parts.get(p.UploadId) };
      case 'CompleteMultipartUploadCommand': objects.set(p.Key, { ContentLength: parts.get(p.UploadId).reduce((sum, part) => sum + part.Size, 0) }); return {};
      case 'AbortMultipartUploadCommand': parts.delete(p.UploadId); return {};
      default: throw new Error(command.constructor.name);
    }
  } };
  const app = express(); app.use(express.json());
  const auth = (req, res, next) => { req.user = { id: req.headers['x-test-user'] || 'gyro' }; next(); };
  await setupCloudStorage(app, db, auth, { ready: () => true, client: () => fake, sign: async () => 'https://storage.invalid/signed-part' });
  app.use((error, req, res, next) => res.status(500).json({ error: error.message }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body = {}, user = 'gyro') => fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-user': user }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/api/uploads', { title: 'Too large', day: '2026-09-13', name: 'clip.mp4', size: 2 * 1024 ** 3 + 1 })).status, 400);
    const start = await post('/api/uploads', { title: 'A moment', day: '2026-09-13', name: 'original.mp4', size: 100 });
    assert.equal(start.status, 201); const pending = await start.json();
    assert.equal((await post(`/api/uploads/${pending.id}/complete`, {}, 'other')).status, 404);
    assert.equal((await post(`/api/uploads/${pending.id}/cancel`, {}, 'other')).status, 404);
    assert.equal((await post(`/api/uploads/${pending.id}/complete`)).status, 400, 'Missing parts cannot create a clip');
    parts.set('upload-1', [{ PartNumber: 1, Size: 99, ETag: 'etag' }]);
    assert.equal((await post(`/api/uploads/${pending.id}/complete`)).status, 400, 'Wrong original size is rejected');
    parts.set('upload-1', [{ PartNumber: 1, Size: 100, ETag: 'etag' }]);
    assert.equal((await post(`/api/uploads/${pending.id}/complete`)).status, 200);
    assert.equal((await post(`/api/uploads/${pending.id}/complete`)).status, 200);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM clips').get().n, 1);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1);
    const clip = sqlite.prepare('SELECT * FROM clips').get();
    assert.equal(clip.user_id, 'gyro'); assert.equal(clip.size, 100); assert.equal(clip.original_name, 'original.mp4');
  } finally { await new Promise(resolve => server.close(resolve)); sqlite.close(); }
});
