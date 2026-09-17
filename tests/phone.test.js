import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { startServer } from './helpers.js';

test('phone upload retains its draft through taps, selection, focus refresh and keyboard resizing; closing cancels startup', {timeout:120000}, async()=>{
 const server=await startServer(3118);let browser;
 try{
  browser=await (process.env.PHONE_BROWSER === 'webkit' ? webkit.launch({headless:true}) : chromium.launch({channel:'chrome',headless:true}));
  const context=await browser.newContext({baseURL:server.url,viewport:{width:390,height:844},isMobile:true,hasTouch:true});const page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(server.url);await page.getByLabel('Email address').fill('owner@example.com');await page.getByLabel('Password',{exact:true}).fill('a-long-test-password');await page.getByRole('button',{name:'Sign in',exact:true}).tap();
  const open=()=>page.getByRole('button',{name:'Add a clip',exact:true}).first().tap();
  await open();await page.locator('input[type=file]').setInputFiles({name:'phone-original.mp4',mimeType:'video/mp4',buffer:Buffer.from('original phone fixture')});
  const title=page.getByLabel('Clip title',{exact:true});await title.tap();await title.fill('Phone draft');await page.getByLabel('Add to date').fill('2026-09-18');
  // Native dialog retargets some selection/scroll clicks to its background.
  await page.locator('dialog').dispatchEvent('click',{clientX:195,clientY:400});
  await page.touchscreen.tap(2,2);await expect(title).toHaveValue('Phone draft');
  const box=await title.boundingBox();await page.mouse.move(box.x+10,box.y+10);await page.mouse.down();await page.mouse.move(2,2,{steps:5});await page.mouse.up();await expect(title).toHaveValue('Phone draft');
  const refreshed=page.waitForResponse(r=>r.url().endsWith('/api/session'));await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await refreshed;
  await expect(title).toHaveValue('Phone draft');await expect(page.getByLabel('Add to date')).toHaveValue('2026-09-18');assert.equal(await page.locator('input[type=file]').evaluate(e=>e.files[0].name),'phone-original.mp4');
  for(const viewport of [{width:360,height:740},{width:390,height:380},{width:844,height:390},{width:430,height:932}]){
   await page.setViewportSize(viewport);await title.tap();await expect(title).toHaveValue('Phone draft');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.ok(await title.evaluate(e=>parseFloat(getComputedStyle(e).fontSize)>=16));
   await page.getByRole('button',{name:'Add clip',exact:true}).scrollIntoViewIfNeeded();await expect(page.getByRole('button',{name:'Add clip',exact:true})).toBeInViewport();
  }
  await page.setViewportSize({width:390,height:844});const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();assert.deepEqual(audit.violations.filter(v=>['serious','critical'].includes(v.impact)).map(v=>v.id),[]);
  await page.getByRole('button',{name:'Add clip',exact:true}).tap();await expect(page.getByRole('dialog')).toHaveCount(0);await page.getByRole('button',{name:'Phone draft',exact:true}).waitFor();
  const clips=await(await page.request.get('/api/clips')).json();const stored=clips.find(c=>c.title==='Phone draft');assert.equal(await(await page.request.get(`/api/clips/${stored.id}/download`)).text(),'original phone fixture');
  await open();await page.locator('input[type=file]').setInputFiles({name:'cancelled.mp4',mimeType:'video/mp4',buffer:Buffer.from('must not upload')});
  let release;const gate=new Promise(r=>release=r);let started;const seen=new Promise(r=>started=r);let posts=0;
  page.on('request',r=>{if(r.method()==='POST'&&(/\/api\/(clips|uploads)$/.test(r.url())))posts++;});
  await page.route('**/api/upload-config',async route=>{started();await gate;await route.fulfill({json:{mode:'local',available:true}}).catch(()=>{});});
  await page.getByRole('button',{name:'Add clip',exact:true}).tap();await seen;await page.getByRole('button',{name:'Close dialog',exact:true}).tap();release();await page.waitForTimeout(400);assert.equal(posts,0);assert.equal((await(await page.request.get('/api/clips')).json()).length,1);assert.deepEqual(errors,[]);
 }finally{await browser?.close();await server.close();}
});
