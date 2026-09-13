import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync } from 'node:crypto';
import path from 'node:path';
import { startServer } from './helpers.js';

test('automatic workspace, role isolation, original downloads, daily analytics, reviews and access revocation', async () => {
  const server = await startServer(3111);
  try {
    const request = (endpoint, method = 'GET', body, cookie) => fetch(`${server.url}/api${endpoint}`, { method, headers: { ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
    const login = async (email, password) => { const result = await request('/login', 'POST', { email, password }); assert.equal(result.status,200); return result.headers.get('set-cookie').split(';')[0]; };
    const original = Buffer.from('video-original-byte-preservation-fixture-0123456789');
    async function upload(cookie, title, day) { const form = new FormData(); form.append('title',title); form.append('day',day); form.append('video',new Blob([original],{type:'video/mp4'}),'original.mp4'); const r = await request('/clips','POST',form,cookie); assert.equal(r.status,201); return (await r.json()).id; }
    assert.equal((await request('/clips')).status,401);
    const session = await (await request('/session')).json(); assert.equal(session.needsSetup,false); assert.equal(session.workspace.name,"Orangie's workspace");
    assert.equal((await request('/setup','POST',{})).status,409);
    const owner = await login('owner@example.com','a-long-test-password');
    const me = await (await request('/session','GET',undefined,owner)).json(); assert.equal(me.user.name,'Orangie'); assert.equal(me.user.permissions.manageMembers,true);
    const ids = {};
    for (const [name,role] of [['Sam','clipper'],['Lee','clipper'],['Maya','team']]) { const r = await request('/team','POST',{name,email:`${name.toLowerCase()}@example.com`,password:'another-test-password',role},owner); assert.equal(r.status,201); ids[name]=(await r.json()).id; }
    const sam = await login('sam@example.com','another-test-password'); const lee = await login('lee@example.com','another-test-password'); const team = await login('maya@example.com','another-test-password');
    assert.equal((await request('/team','GET',undefined,sam)).status,403);
    assert.equal((await request('/team','POST',{name:'Nope',email:'nope@example.com',password:'another-test-password'},team)).status,403);
    assert.equal((await request('/team','POST',{name:'Nope',email:'nope@example.com',password:'another-test-password',role:'owner'},owner)).status,400);
    assert.equal((await request(`/team/${me.user.id}`,'PATCH',{active:false},owner)).status,400);
    const samClip = await upload(sam,'Sam original','2026-09-12');
    await upload(sam,'Sam earlier','2026-09-11');
    const leeClip = await upload(lee,'Lee original','2026-09-12');
    await upload(lee,'Lee previous period','2026-09-09');
    const ownList = await (await request('/clips','GET',undefined,sam)).json(); assert.equal(ownList.length,2); assert.ok(ownList.every(c => c.user_id === ids.Sam));
    assert.equal((await (await request('/clips','GET',undefined,owner)).json()).length,4);
    assert.equal((await (await request('/clips','GET',undefined,team)).json()).length,4);
    for (const action of ['preview','download']) {
      assert.equal((await request(`/clips/${leeClip}/${action}`,'GET',undefined,sam)).status,404);
      assert.equal((await request(`/clips/${samClip}/${action}`)).status,401);
    }
    const downloaded = await request(`/clips/${samClip}/download`,'GET',undefined,owner);
    assert.match(downloaded.headers.get('content-disposition'),/attachment.*original\.mp4/); assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),original);
    const range = await fetch(`${server.url}/api/clips/${samClip}/preview`,{headers:{Cookie:team,Range:'bytes=0-9'}}); assert.equal(range.status,206); assert.deepEqual(Buffer.from(await range.arrayBuffer()),original.subarray(0,10));
    assert.equal((await request(`/clips/${samClip}`,'PATCH',{status:'approved'},sam)).status,403);
    assert.equal((await request(`/clips/${samClip}`,'PATCH',{status:'changes'},team)).status,400);
    assert.equal((await request(`/clips/${samClip}`,'PATCH',{status:'approved',review_note:'Ready for the page.'},team)).status,200);
    assert.equal((await request(`/clips/${leeClip}`,'PATCH',{status:'posted'},owner)).status,200);
    const ownStats = await (await request(`/analytics?from=2026-09-10&to=2026-09-12&user_id=${ids.Lee}`,'GET',undefined,sam)).json();
    assert.equal(ownStats.scope,'personal'); assert.equal(ownStats.totals.clips,2); assert.equal(ownStats.members.length,1); assert.equal(ownStats.members[0].id,ids.Sam); assert.equal(ownStats.totals.approved,1); assert.equal(ownStats.allTime.clips,2);
    const stats = await (await request('/analytics?from=2026-09-10&to=2026-09-12','GET',undefined,owner)).json();
    assert.equal(stats.scope,'workspace'); assert.equal(stats.totals.clips,3); assert.equal(stats.totals.contributors,2); assert.equal(stats.previous.clips,1); assert.equal(stats.daily.length,3); assert.equal(stats.daily[0].clips,0); assert.equal(stats.daily[2].clips,2); assert.equal(stats.allTime.clips,4); assert.equal(stats.totals.bytes,original.length*3); assert.equal(stats.totals.posted,1); assert.equal(stats.approvalRate,2/3*100);
    assert.equal((await request('/analytics?from=2026-02-31&to=2026-03-01','GET',undefined,owner)).status,400);
    assert.equal((await request('/analytics?from=2020-01-01&to=2026-03-01','GET',undefined,owner)).status,400);
    const ownActivity = await (await request('/activity','GET',undefined,sam)).json(); assert.ok(ownActivity.every(e => e.subject_id === ids.Sam && e.action.startsWith('clip.')));
    const teamActivity = await (await request('/activity','GET',undefined,team)).json(); assert.ok(teamActivity.every(e => e.action.startsWith('clip.')));
    const ownerActivity = await (await request('/activity','GET',undefined,owner)).json(); assert.ok(ownerActivity.some(e => e.action === 'member.created'));
    const before = ownerActivity.length; await server.restart();
    assert.equal((await (await request('/activity','GET',undefined,owner)).json()).length,before,'Restart must not duplicate historical uploads');
    const invalid = new FormData(); invalid.append('title','Invalid'); invalid.append('day','2026-02-31'); invalid.append('video',new Blob([original]),'original.mp4'); assert.equal((await request('/clips','POST',invalid,sam)).status,400);
    const csrf = await fetch(`${server.url}/api/team`,{method:'POST',headers:{Origin:'http://evil.example',Cookie:owner,'Content-Type':'application/json'},body:'{}'}); assert.equal(csrf.status,403);
    assert.equal((await request(`/team/${ids.Maya}`,'PATCH',{role:'clipper',active:true},owner)).status,200);
    assert.equal((await request('/clips','GET',undefined,team)).status,401,'Role change revokes existing session');
    const demoted = await login('maya@example.com','another-test-password'); assert.equal((await (await request('/clips','GET',undefined,demoted)).json()).length,0);
    assert.equal((await request(`/team/${ids.Sam}`,'PATCH',{active:false},owner)).status,200);
    assert.equal((await request('/clips','GET',undefined,sam)).status,401);
    assert.equal((await request('/login','POST',{email:'sam@example.com',password:'another-test-password'})).status,401);
    assert.equal((await request(`/team/${ids.Lee}/password`,'POST',{password:'new-safe-test-password'},owner)).status,200); assert.equal((await request('/clips','GET',undefined,lee)).status,401);
    const leeNew = await login('lee@example.com','new-safe-test-password');
    assert.equal((await request('/account/password','POST',{currentPassword:'new-safe-test-password',password:'changed-safe-password'},leeNew)).status,200);
    assert.equal((await request('/clips','GET',undefined,leeNew)).status,401);
    assert.equal((await request('/logout','POST',undefined,owner)).status,200); assert.equal((await request('/clips','GET',undefined,owner)).status,401);
  } finally { await server.close(); }
});

test('fresh installs create private owner credentials automatically', async () => {
  const server = await startServer(3113,{env:{OWNER_PASSWORD:''}});
  try {
    const access = await readFile(path.join(server.data,'owner-access.txt'),'utf8'); const password = access.match(/Initial password: (.+)/)[1];
    assert.ok(password.length >= 24);
    assert.equal((await fetch(`${server.url}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'owner@example.com',password})})).status,200);
    const exposed = await fetch(`${server.url}/data/owner-access.txt`); assert.ok(!(await exposed.text()).includes(password));
    await server.restart(); assert.equal(await readFile(path.join(server.data,'owner-access.txt'),'utf8'),access);
  } finally { await server.close(); }
});

test('legacy accounts and clips survive additive schema migration', async () => {
  const server = await startServer(3114,{seed: async data => {
    const db = new DatabaseSync(path.join(data,'clips.sqlite'));
    db.exec('CREATE TABLE users (id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL); CREATE TABLE clips (id TEXT PRIMARY KEY,title TEXT NOT NULL,day TEXT NOT NULL,filename TEXT NOT NULL,original_name TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,user_id TEXT NOT NULL,created_at TEXT NOT NULL);');
    const salt = randomBytes(16).toString('hex'); const hash = `${salt}:${scryptSync('existing-owner-password',salt,64).toString('hex')}`;
    db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run('existing-owner','Orangie','existing@example.com',hash,'owner');
    db.prepare('INSERT INTO clips VALUES (?,?,?,?,?,?,?,?,?)').run('existing-clip','An existing clip','2026-09-12','preserved-file','old.mp4','video/mp4',100,'existing-owner','2026-09-12T12:00:00Z'); db.close();
  }});
  try {
    const r = await fetch(`${server.url}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'existing@example.com',password:'existing-owner-password'})}); assert.equal(r.status,200);
    const cookie = r.headers.get('set-cookie').split(';')[0]; const headers = {Cookie:cookie};
    const clips = await (await fetch(`${server.url}/api/clips`,{headers})).json(); assert.equal(clips.length,1); assert.equal(clips[0].id,'existing-clip'); assert.equal(clips[0].status,'pending');
    assert.equal((await (await fetch(`${server.url}/api/team`,{headers})).json()).length,1);
    await server.restart(); assert.equal((await (await fetch(`${server.url}/api/activity`,{headers})).json()).length,1);
  } finally { await server.close(); }
});
