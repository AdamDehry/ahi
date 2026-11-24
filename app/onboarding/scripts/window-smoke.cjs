// The desktop app as the owner meets it after setup, end to end in real Electron against a stand-in AHI server:
// an impostor on AHI's port (it knows the public home id, not the owner's key) is refused with a reason and Retry and
// never sees the key; a stale lock is cleared; a start while the window is closed to the tray stays in the tray; AHI
// opens in the window signed in by the server's own cookie, with no bridge to the app; closing keeps AHI running;
// Quit stops the server cleanly — also when it comes in the middle of a slow start.
// Needs an Electron binary and `npm run stage:runtime` (or a node at runtime/<os>/<arch>/node).
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {cleanEnv}=require('../src/system.cjs');
const {homeId}=require('../src/ahi-runtime.cjs');

// The stand-in server: /health with this home's id and the owner-key proof (src/desktop-proof.ts), the real login
// cookie's attributes, the singleton's O_EXCL lock and its refusal line, a clean exit on "ahi:stop". With a `slow`
// file beside it, it takes its lock and then waits 20 s before listening.
const STUB=`const http=require('http'),fs=require('fs'),crypto=require('crypto'),path=require('path');
const managed=process.env.AHI_AI_ROOT,lock=process.env.AHI_GATEWAY_LOCK_PATH,home=crypto.createHash('sha256').update(managed).digest('hex').slice(0,16);
try{fs.writeFileSync(lock,process.pid+'\\n',{flag:'wx'});}catch{console.error('[singleton] ANOTHER GATEWAY RUNNING (pid=?, ours='+process.pid+'), exiting');process.exit(1);}
process.on('message',m=>{if(m==='ahi:stop'){fs.rmSync(lock,{force:true});console.log('[stub] clean stop');process.exit(0);}});
const token=JSON.parse(fs.readFileSync(process.env.AHI_USERS_FILE,'utf8')).find(u=>u.admin).token;
const signedIn=req=>(req.headers.cookie||'').split(/; */).includes('ahi_token='+token);
const server=http.createServer((req,res)=>{
  const u=new URL(req.url,'http://x'),c=u.searchParams.get('challenge');
  if(u.pathname==='/health')return res.end(JSON.stringify({ok:true,home,...(c?{proof:crypto.createHmac('sha256',token).update('ahi-desktop-proof:'+c).digest('hex')}:{})}));
  if(u.pathname==='/ui/session'){res.statusCode=signedIn(req)?200:401;return res.end('{}');}
  if(u.pathname==='/ui/login'&&req.method==='POST'){let b='';req.on('data',d=>b+=d);return req.on('end',()=>{if(JSON.parse(b).token!==token){res.statusCode=401;return res.end('{}');}res.setHeader('Set-Cookie','ahi_token='+token+'; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=None');res.end('{"ok":true}');});}
  res.setHeader('Content-Type','text/html');res.end('<title>AHI</title><h1 id="who">'+(signedIn(req)?'signed in':'signed out')+'</h1>');
});
setTimeout(()=>server.listen(Number(process.env.GATEWAY_PORT),'127.0.0.1',()=>console.log('[stub] listening')),fs.existsSync(path.join(__dirname,'..','..','slow'))?20000:0);`;

async function main(){
  const {_electron}=require('@playwright/test');
  const root=path.resolve(__dirname,`../.tmp/window-${Date.now()}`),data=path.join(root,'desktop-data'),ahiRoot=path.join(root,'home','My AI','AHI'),managed=path.join(ahiRoot,'AHI_OS'),server=path.join(root,'server');
  const lock=path.join(managed,'logs','gateway.pid'),serverLog=path.join(managed,'logs','ahi-server.log');
  const id=crypto.randomUUID(),token=crypto.randomBytes(32).toString('hex');
  for(const d of [data,path.join(managed,'state'),path.join(managed,'logs'),path.join(managed,'providers','claude'),path.join(server,'dist')])await fs.mkdir(d,{recursive:true});
  await fs.writeFile(path.join(server,'dist','index.js'),STUB);
  await fs.writeFile(path.join(managed,'setup-owner.json'),JSON.stringify({id,version:1}));
  await fs.writeFile(path.join(managed,'state','users.json'),JSON.stringify([{token,name:'Sandbox',admin:true}]));
  await fs.writeFile(path.join(data,'setup.json'),JSON.stringify({version:1,id,step:'ready',owner:'Sandbox',workspace:'Window smoke',root:ahiRoot,folderReady:true,selected:['claude'],providers:{claude:{status:'verified'}},brain:'claude',voice:{},remote:{stage:'later'},connections:[],completed:true}));
  // A lock left by a server that was killed (a dead process id): the app must clear it, or the stand-in refuses.
  const dead=spawnSync(process.execPath,['-e','console.log(process.pid)'],{encoding:'utf8'}).stdout.trim();
  await fs.writeFile(lock,dead+'\n');
  // An impostor on AHI's port: it answers /health with this home's (public) id but cannot prove the owner's key.
  const seen=[];
  const impostor=http.createServer((q,r)=>{let b='';q.on('data',d=>b+=d);q.on('end',()=>{seen.push(q.url+' '+(q.headers.cookie||'')+' '+b);r.end(JSON.stringify({ok:true,home:homeId(managed)}));});});
  await new Promise(r=>impostor.listen(0,'127.0.0.1',r));const port=impostor.address().port;
  const env={...cleanEnv(path.join(root,'home')),AHI_SETUP_TEST_ROOT:root,AHI_SETUP_TEST_SERVER_DIR:server,AHI_PORT:String(port),LD_LIBRARY_PATH:process.env.LD_LIBRARY_PATH||'',TMPDIR:await fs.mkdtemp(path.join(require('node:os').tmpdir(),'ahi-'))}; // short: the one-instance lock is a socket here
  const args=[path.resolve(__dirname,'..'),...(process.platform==='linux'?['--no-sandbox','--ozone-platform=headless','--disable-gpu']:[])];
  const shots=path.resolve(__dirname,'../evidence/screenshots');await fs.mkdir(shots,{recursive:true});
  const checks=[];const ok=c=>{checks.push(c);console.log('ok -',c);};
  const launch=async()=>{const e=await _electron.launch({executablePath:require('electron'),args,env,timeout:25000});e.exited=false;e.process().once('exit',()=>{e.exited=true;});return e;};
  const waitExit=async e=>{for(let i=0;i<300&&!e.exited;i++)await new Promise(r=>setTimeout(r,100));assert.ok(e.exited,'the app exited');};
  const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
  let electron;
  try{
    electron=await launch();
    const start=await electron.firstWindow({timeout:15000});
    await start.getByText('AHI couldn’t start this time.').waitFor({timeout:20000});
    assert.match(await start.locator('#start-reason').textContent(),/Another program is already using port/);
    assert.ok(await start.locator('#retry').isVisible());
    assert.ok(seen.length>0&&seen.every(s=>s.startsWith('/health?challenge=')&&!s.includes(token)),'the impostor only ever got a challenge');
    await start.screenshot({path:path.join(shots,'13-start-error-retry.png')});
    ok('an impostor that knows the home id but not the owner key is refused with a plain reason and Retry, and never sees the key');
    assert.match(await fs.readFile(path.join(data,'ahi.log'),'utf8'),/AHI could not start: Another program is already using port/);
    assert.match(await fs.readFile(serverLog,'utf8'),/\[desktop\] .*AHI could not start/);
    ok('the failure is written to the app log and the server log');

    await new Promise(r=>impostor.close(r));
    // Closed to the tray, then started (as the tray, a crash restart or the login item would): it stays in the tray.
    await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
    const next=electron.waitForEvent('window',{predicate:p=>p.url().startsWith(`http://localhost:${port}`),timeout:30000});
    await start.evaluate(()=>window.ahi.invoke('start'));
    const ahi=await next;await ahi.waitForLoadState();
    assert.deepEqual(await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().map(w=>w.isVisible())),[false]);
    ok('a start while the window is closed to the tray opens AHI still in the tray');
    assert.equal(await ahi.locator('#who').textContent(),'signed in');
    ok('AHI opens in the window, signed in by the server\'s own cookie');
    assert.equal(await ahi.evaluate(()=>typeof window.ahi),'undefined');ok('AHI\'s pages get no bridge to the app');
    assert.notEqual(Number(await fs.readFile(lock,'utf8')),Number(dead));
    ok('the stale lock from a killed server was cleared and the start retried (the stand-in took the lock)');
    assert.equal(await electron.evaluate(({app,BrowserWindow})=>{app.emit('second-instance');return BrowserWindow.getAllWindows()[0].isVisible();}),true);
    await ahi.screenshot({path:path.join(shots,'14-ahi-in-window.png')});
    ok('opening AHI again shows the same window');
    assert.deepEqual(await electron.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.close();return [BrowserWindow.getAllWindows().length,w.isVisible()];}),[1,false]);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).ok,true);
    ok('closing the window hides it and AHI keeps running');
    await electron.evaluate(({app})=>app.quit());await waitExit(electron);
    assert.match(await fs.readFile(serverLog,'utf8'),/\[stub\] clean stop/);
    await assert.rejects(fs.access(lock));
    ok('Quit stops the server cleanly: it removed its own lock');

    // Quit in the middle of a slow start: the half-started server is stopped too, not left holding port and lock.
    await fs.writeFile(path.join(root,'slow'),'');
    const before=(await fs.readFile(serverLog,'utf8')).split('[stub] clean stop').length;
    electron=await launch();
    let pid=0;for(let i=0;i<200&&!pid;i++){pid=Number(await fs.readFile(lock,'utf8').catch(()=>''))||0;if(!pid)await new Promise(r=>setTimeout(r,100));}
    assert.ok(pid&&alive(pid),'the slow server was spawned and holds the lock');
    await electron.evaluate(({app})=>app.quit());await waitExit(electron);
    assert.equal((await fs.readFile(serverLog,'utf8')).split('[stub] clean stop').length,before+1);
    assert.ok(!alive(pid),'the half-started server is gone');await assert.rejects(fs.access(lock));
    ok('Quit during a slow start cancels it and stops the server it had spawned');

    const result={passed:true,mode:'real Electron desktop app, headless, stand-in AHI server',checks};
    await fs.writeFile(path.resolve(__dirname,'../evidence/window-smoke.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
  }finally{if(electron&&!electron.exited)await electron.close().catch(()=>{});impostor.close();await fs.rm(env.TMPDIR,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1;});
