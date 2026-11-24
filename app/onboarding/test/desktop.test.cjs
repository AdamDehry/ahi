const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {allowedCall,signIn,linuxAutostart}=require('../src/desktop.cjs');

test('only the setup screens reach every action; the start screen reaches start and setup; AHI\'s pages reach nothing',()=>{
  const urls={setupUrl:'file:///app/ui/index.html',startUrl:'file:///app/ui/start.html'};
  assert.equal(allowedCall(urls.setupUrl,'complete',urls),true);
  assert.equal(allowedCall(urls.startUrl,'start',urls),true);
  assert.equal(allowedCall(urls.startUrl,'setup',urls),true);
  assert.equal(allowedCall(urls.startUrl,'voice',urls),false);
  assert.equal(allowedCall('http://localhost:18789/','start',urls),false);
});

test('the window signs in through the server\'s own login, confirms it, and never opens unsigned',async()=>{
  const url='http://localhost:18789/';
  // A scripted server: each path answers from its own queue of statuses.
  const server=answers=>{const calls=[];return {calls,fetcher:async(u,o={})=>{calls.push({url:u,...o});const q=answers[new URL(u).pathname];return {ok:q[0]<300,status:q.length>1?q.shift():q[0]};}};};
  let s=server({'/ui/session':[200]});
  assert.equal(await signIn(s.fetcher,url,'owner-token'),'already');assert.equal(s.calls.length,1);
  s=server({'/ui/session':[401,200],'/ui/login':[200]});
  assert.equal(await signIn(s.fetcher,url,'owner-token'),'signed-in');
  assert.deepEqual(s.calls.map(c=>new URL(c.url).pathname),['/ui/session','/ui/login','/ui/session'],'the session is confirmed after login');
  assert.equal(JSON.parse(s.calls[1].body).token,'owner-token');
  assert.ok(s.calls.every(c=>c.credentials==='include'&&c.redirect==='error'&&c.signal),'cookies kept, no redirects, every request bounded');
  // Failures throw a reason for the start screen.
  await assert.rejects(signIn(server({'/ui/session':[401],'/ui/login':[401]}).fetcher,url,'old-token'),/did not accept/);
  await assert.rejects(signIn(server({'/ui/session':[401],'/ui/login':[200]}).fetcher,url,'owner-token'),/could not stay signed in/);
  await assert.rejects(signIn(async()=>{throw Error('redirect or timeout');},url,'owner-token'),/did not answer the sign-in/);
  await assert.rejects(signIn(s.fetcher,url,null),/no owner key/);
  // A stalled server is cut off by the time bound, not waited on forever.
  const stalled=(_u,o)=>new Promise((_r,reject)=>o.signal.addEventListener('abort',()=>reject(o.signal.reason)));
  const awake=setTimeout(()=>{},5000); // AbortSignal.timeout's timer does not hold a bare test process open
  await assert.rejects(signIn(stalled,url,'owner-token',50),/did not answer the sign-in/);
  clearTimeout(awake);
});

test('Linux start-at-login is an autostart entry that starts the AppImage hidden, quoted for spaces, and goes when off',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autostart-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await linuxAutostart(true,{appImage:'/home/o/My Apps/AHI.AppImage',dir});
  assert.match(await fs.readFile(path.join(dir,'ahi.desktop'),'utf8'),/^Exec="\/home\/o\/My Apps\/AHI\.AppImage" --hidden$/m);
  await linuxAutostart(false,{appImage:'/home/o/My Apps/AHI.AppImage',dir});
  await assert.rejects(fs.access(path.join(dir,'ahi.desktop')));
});
