import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export async function connectDatabase(data) {
  if (!process.env.DATABASE_URL) {
    if (process.env.VERCEL) throw new Error('Connect a Postgres database before deploying. DATABASE_URL is required.');
    mkdirSync(path.join(data, 'uploads'), { recursive: true });
    const { DatabaseSync } = await import('node:sqlite');
    const sqlite = new DatabaseSync(path.join(data, 'clips.sqlite'));
    let pending = Promise.resolve();
    return {
      cloud: false,
      prepare: sql => sqlite.prepare(sql),
      exec: sql => sqlite.exec(sql),
      middleware: (req, res, next) => {
        // Async handlers must not interleave SQLite transactions on one connection.
        const previous = pending;
        pending = new Promise(resolve => {
          let released = false;
          const release = () => { if (!released) { released = true; resolve(); } };
          res.once('finish', release); res.once('close', release);
        });
        previous.then(() => { if (!res.destroyed) next(); });
      },
    };
  }
  const { default: pg } = await import('pg');
  // All stored counters fit safely within JavaScript's integer precision.
  pg.types.setTypeParser(20, Number);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5, idleTimeoutMillis: 10000 });
  const context = new AsyncLocalStorage();
  const bootstrap = await pool.connect();
  let booting = true;
  const query = (sql, values = []) => (context.getStore() || (booting ? bootstrap : pool)).query(sql, values);
  function translate(sql) {
    let i = 0;
    sql = sql.replace(/\?/g, () => `$${++i}`).replace(/BEGIN IMMEDIATE/g, 'BEGIN');
    if (/INSERT OR IGNORE/i.test(sql)) sql = sql.replace(/INSERT OR IGNORE/i, 'INSERT') + ' ON CONFLICT DO NOTHING';
    return sql;
  }
  return {
    cloud: true,
    prepare: sql => ({
      get: async (...args) => (await query(translate(sql), args)).rows[0],
      all: async (...args) => (await query(translate(sql), args)).rows,
      run: async (...args) => { const result = await query(translate(sql), args); return { changes: result.rowCount }; },
    }),
    exec: sql => query(translate(sql)),
    ready: () => { booting = false; bootstrap.release(); },
    middleware: async (req, res, next) => {
      try {
        const client = await pool.connect();
        let released = false;
        const release = () => { if (!released) { released = true; client.release(); } };
        res.once('finish', release); res.once('close', release);
        context.run(client, next);
      } catch (error) { next(error); }
    },
  };
}
