import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { startServer } from './helpers.js';

test('managers can manage clippers, preserve uploads on deletion, and cannot manage staff', {timeout:120000}, async()=>{
 const server=await startServer(3115);let browser;
 try {
  const req=(p,method='GET',body,cookie)=>fetch(`${server.url}/api${p}`,{method,headers:{...(body instanceof FormData?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{})},body:body instanceof FormData?body:body?JSON.stringify(body):undefined});
  const password='manager-test-password';
  const login=async email=>{const r=await req('/login','POST',{email,password:email==='owner@example.com'?'a-long-test-password':password});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0];};
  const owner=await login('owner@example.com');const ids={};
  for(const [name,role] of [['Jake','clipper_manager'],['Rehan','clipper_manager'],['Bryan','team'],['Gyro','clipper']]){const r=await req('/team','POST',{name,email:`${name}@example.com`,password,role},owner);assert.equal(r.status,201);ids[name]=(await r.json()).id;}
  const jake=await login('jake@example.com');const gyro=await login('gyro@example.com');const bryan=await login('bryan@example.com');
  const teamPermissions=(await (await req('/session','GET',undefined,bryan)).json()).user.permissions;const ownerPermissions=(await (await req('/session','GET',undefined,owner)).json()).user.permissions;assert.deepEqual({...teamPermissions,label:''},{...ownerPermissions,label:''});
  const ownerId=(await (await req('/session','GET',undefined,owner)).json()).user.id;
  for(const cookie of [gyro])assert.equal((await req('/team','POST',{name:'Denied',email:'denied@example.com',password},cookie)).status,403);
  for(const role of ['owner','team','clipper_manager'])assert.equal((await req('/team','POST',{name:'Denied',email:'denied@example.com',password,role},jake)).status,400);
  for(const id of [ownerId,ids.Jake,ids.Rehan,ids.Bryan])for(const [method,suffix,body] of [['PATCH','',{active:false}],['POST','/password',{password}],['DELETE','',undefined]])assert.equal((await req(`/team/${id}${suffix}`,method,body,jake)).status,403);
  assert.equal((await req(`/team/${ids.Gyro}`,'PATCH',{role:'team'},jake)).status,400);
  const form=new FormData();form.append('title','Retained original');form.append('day','2026-09-16');form.append('video',new Blob(['original-bytes'],{type:'video/mp4'}),'original.mp4');
  const upload=await req('/clips','POST',form,gyro);assert.equal(upload.status,201);const clip=(await upload.json()).id;
  assert.deepEqual(await (await req('/clips','GET',undefined,jake)).json(),[]);
  assert.equal((await req(`/clips/${clip}/download`,'GET',undefined,jake)).status,404);
  assert.equal((await (await req('/analytics?from=2026-09-16&to=2026-09-16','GET',undefined,jake)).json()).scope,'personal');
  assert.equal((await req(`/team/${ids.Gyro}`,'PATCH',{name:'Gyro Edited',email:'edited@example.com',active:false},jake)).status,200);
  assert.equal((await req('/clips','GET',undefined,gyro)).status,401);
  assert.equal((await req(`/team/${ids.Gyro}`,'PATCH',{active:true},jake)).status,200);
  assert.equal((await req(`/team/${ids.Gyro}/password`,'POST',{password:'new-clipper-password'},jake)).status,200);
  const changed=await req('/login','POST',{email:'edited@example.com',password:'new-clipper-password'});assert.equal(changed.status,200);
  assert.equal((await req(`/team/${ids.Gyro}`,'DELETE',undefined,jake)).status,200);
  assert.equal((await req('/clips','GET',undefined,changed.headers.get('set-cookie').split(';')[0])).status,401);
  assert.equal((await req('/login','POST',{email:'edited@example.com',password:'new-clipper-password'})).status,401);
  assert.equal((await req(`/team/${ids.Gyro}`,'PATCH',{active:true},jake)).status,404);
  assert.equal(await (await req(`/clips/${clip}/download`,'GET',undefined,owner)).text(),'original-bytes');
  assert.deepEqual(await (await req('/team','GET',undefined,jake)).json(),[]);
  const stats=await (await req('/analytics?from=2026-09-16&to=2026-09-16','GET',undefined,owner)).json();assert.equal(stats.totals.clips,1);

  browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});
  await page.goto(server.url);await page.getByLabel('Email address').fill('rehan@example.com');await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await page.getByRole('button',{name:'The team',exact:true}).click();await page.getByRole('button',{name:'Add member',exact:true}).click();
  assert.equal(await page.getByRole('radio').count(),1);
  await page.getByLabel('Name',{exact:true}).fill('New Clipper');await page.getByLabel('Email address').fill('new@example.com');await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Create member account'}).click();
  await page.getByRole('button',{name:'Manage New Clipper',exact:true}).click();await expect(page.getByLabel('Role',{exact:true})).toBeDisabled();
  await page.getByLabel('Name',{exact:true}).fill('Updated Clipper');await page.getByRole('button',{name:'Save access',exact:true}).click();await page.getByRole('button',{name:'Manage Updated Clipper',exact:true}).click();
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.getByRole('button',{name:'Delete clipper account',exact:true}).click();await page.getByRole('button',{name:'Confirm deletion',exact:true}).click();await expect(page.getByRole('button',{name:'Manage Updated Clipper',exact:true})).toHaveCount(0);
 }finally{await browser?.close();await server.close();}
});
