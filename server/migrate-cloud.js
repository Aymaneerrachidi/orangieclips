// Explicit, repeatable migration; private data is never included in the deployment bundle.
import { DatabaseSync, backup } from 'node:sqlite';
import { createReadStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { storageReady, storageClient } from './cloud-storage.js';

if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL before migrating.');
const data = path.resolve(process.env.DATA_DIR || 'data');
const source = new DatabaseSync(path.join(data, 'clips.sqlite'));
mkdirSync(path.join(data, 'backups'), { recursive: true });
await backup(source, path.join(data, 'backups', `before-cloud-${Date.now()}.sqlite`));
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query('BEGIN');
  for (const name of ['users', 'sessions', 'clips', 'workspace', 'events']) {
    const { sql } = source.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);
    await client.query(sql.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS').replace(/expires INTEGER/g, 'expires BIGINT').replace(/size INTEGER/g, 'size BIGINT'));
  }
  for (const name of ['users', 'workspace']) {
    for (const row of source.prepare(`SELECT * FROM ${name}`).all()) {
      const keys = Object.keys(row);
      await client.query(`INSERT INTO ${name} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT (id) DO NOTHING`, Object.values(row));
    }
  }
  await client.query('COMMIT');
  let imported = 0;
  if (storageReady()) {
    for (const clip of source.prepare('SELECT * FROM clips').all()) {
      if ((await client.query('SELECT id FROM clips WHERE id=$1', [clip.id])).rowCount) continue;
      const pathname = `clips/${clip.user_id}/${clip.id}/${clip.original_name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      let blob;
      const r2 = storageClient(); const params = { Bucket: process.env.R2_BUCKET, Key: pathname };
      try { blob = await r2.send(new HeadObjectCommand(params)); } catch (e) { if (e.$metadata?.httpStatusCode !== 404) throw e; }
      if (!blob) await new Upload({ client: r2, params: { ...params, Body: createReadStream(path.join(data, 'uploads', clip.filename)), ContentType: clip.mime } }).done();
      const meta = await r2.send(new HeadObjectCommand(params));
      if (meta.ContentLength !== clip.size) throw new Error(`Size mismatch for clip ${clip.id}`);
      clip.filename = pathname;
      const keys = Object.keys(clip);
      await client.query(`INSERT INTO clips (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT (id) DO NOTHING`, Object.values(clip));
      imported++;
    }
  }
  for (const row of source.prepare('SELECT * FROM events').all()) {
    if (row.clip_id && !(await client.query('SELECT id FROM clips WHERE id=$1', [row.clip_id])).rowCount) continue;
    const keys = Object.keys(row);
    await client.query(`INSERT INTO events (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT (id) DO NOTHING`, Object.values(row));
  }
  console.log(`Accounts and workspace migrated. ${imported} original clips migrated. ${storageReady() ? '' : 'Originals remain local until private R2 storage is connected.'}`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally { await client.end(); source.close(); }
