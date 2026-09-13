import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
export async function startServer(port, options = {}) {
  const prefix = path.join(os.tmpdir(), 'orangie-test-');
  const data = await mkdtemp(prefix);
  if (options.seed) await options.seed(data);
  let child;
  async function launch() {
  child = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(port), DATA_DIR: data, OWNER_EMAIL: 'owner@example.com', OWNER_PASSWORD: 'a-long-test-password', ...options.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Server startup timed out')); }, 15000);
    child.once('error', e => { clearTimeout(timeout); reject(e); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited: ${code}`)); });
    child.stdout.on('data', data => { if (String(data).includes('Clip room ready')) { clearTimeout(timeout); resolve(); } });
  });
  }
  async function stop() { if (child.exitCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); }); }
  await launch();
  return { url: `http://127.0.0.1:${port}`, data, async restart() { await stop(); await launch(); }, async close() {
    await stop();
    if (!path.resolve(data).startsWith(path.resolve(prefix))) throw new Error('Unexpected test directory');
    await rm(data, { recursive: true, force: true });
  } };
}
