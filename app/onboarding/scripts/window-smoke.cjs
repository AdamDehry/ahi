// The desktop app as the owner meets it after setup, end to end in real Electron against a stand-in AHI server:
// a stale lock is cleared, a busy port shows its reason with Retry, Retry opens AHI itself in the window, signed in
// with the server's own cookie and no bridge to the app; closing the window keeps AHI running; Quit stops the
// server cleanly (it removes its own lock). Needs `npm run stage:runtime` (or a node at runtime/<os>/<arch>/node).
const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {cleanEnv}=require('../src/system.cjs');

// The stand-in server: /health with this home's id, the real login cookie's attributes, the singleton's O_EXCL
// lock and its refusal line, and a clean exit on the app's "ahi:stop" message.
const STUB=`const http=require('http'),fs=require('fs'),crypto=require('crypto');
const managed=process.env.AHI_AI_ROOT,lock=process.env.AHI_GATEWAY_LOCK_PATH,home=crypto.createHash('sha256').update(managed).digest('hex').slice(0,16);
try{fs.writeFileSync(lock,process.pid+'\\n',{flag:'wx'});}catch{console.error('[singleton] ANOTHER GATEWAY RUNNING (pid=?, ours='+process.pid+'), exiting');process.exit(1);}
const token=JSON.parse(fs.readFileSync(process.env.AHI_USERS_FILE,'utf8')).find(u=>u.admin).token;
const signedIn=req=>(req.headers.cookie||'').split(/; */).includes('ahi_token='+token);
http.createServer((req,res)=>{
  if(req.url==='/health')return res.end(JSON.stringify({ok:true,home}));
  if(req.url==='/ui/session'){res.statusCode=signedIn(req)?200:401;return res.end('{}');}
  if(req.url==='/ui/login'&&req.method==='POST'){let b='';req.on('data',c=>b+=c);return req.on('end',()=>{if(JSON.parse(b).token!==token){res.statusCode=401;return res.end('{}');}res.setHeader('Set-Cookie','ahi_token='+token+'; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=None');res.end('{"ok":true}');});}
  res.setHeader('Content-Type','text/html');res.end('<title>AHI</title><h1 id="who">'+(signedIn(req)?'signed in':'signed out')+'</h1>');
}).listen(Number(process.env.GATEWAY_PORT),'127.0.0.1',()=>console.log('[stub] listening'));
process.on('message',m=>{if(m==='ahi:stop'){fs.rmSync(lock,{force:true});console.log('[stub] clean stop');process.exit(0);}});`;

async function main(){
  const {_electron}=require('@playwright/test');
  const root=path.resolve(__dirname,`../.tmp/window-${Date.now()}`),data=path.join(root,'desktop-data'),ahiRoot=path.join(root,'home','My AI','AHI'),managed=path.join(ahiRoot,'AHI_OS'),server=path.join(root,'server');
  const id=crypto.randomUUID(),token=crypto.randomBytes(32).toString('hex');
  for(const d of [data,path.join(managed,'state'),path.join(managed,'logs'),path.join(managed,'providers','claude'),path.join(server,'dist')])await fs.mkdir(d,{recursive:true});
  await fs.writeFile(path.join(server,'dist','index.js'),STUB);
  await fs.writeFile(path.join(managed,'setup-owner.json'),JSON.stringify({id,version:1}));
  await fs.writeFile(path.join(managed,'state','users.json'),JSON.stringify([{token,name:'Sandbox',admin:true}]));
  await fs.writeFile(path.join(data,'setup.json'),JSON.stringify({version:1,id,step:'ready',owner:'Sandbox',workspace:'Window smoke',root:ahiRoot,folderReady:true,selected:['claude'],providers:{claude:{status:'verified'}},brain:'claude',voice:{},remote:{stage:'later'},connections:[],completed:true}));
  // A lock left by a server that was killed (a dead process id): the app must clear it, or the stand-in refuses.
  const dead=spawnSync(process.execPath,['-e','console.log(process.pid)'],{encoding:'utf8'}).stdout.trim();
  await fs.writeFile(path.join(managed,'logs','gateway.pid'),dead+'\n');
  // Something else on AHI's port: the first start fails with a reason, until it goes away and Retry is pressed.
  const squatter=http.createServer((_q,r)=>r.end('{}'));await new Promise(r=>squatter.listen(0,'127.0.0.1',r));const port=squatter.address().port;
  const env={...cleanEnv(path.join(root,'home')),AHI_SETUP_TEST_ROOT:root,AHI_SETUP_TEST_SERVER_DIR:server,AHI_PORT:String(port),LD_LIBRARY_PATH:process.env.LD_LIBRARY_PATH||'',TMPDIR:await fs.mkdtemp(path.join(require('node:os').tmpdir(),'ahi-'))}; // short: the one-instance lock is a socket here
  const args=[path.resolve(__dirname,'..'),...(process.platform==='linux'?['--no-sandbox','--ozone-platform=headless','--disable-gpu']:[])];
  const shots=path.resolve(__dirname,'../evidence/screenshots');await fs.mkdir(shots,{recursive:true});
  const checks=[];const ok=c=>{checks.push(c);console.log('ok -',c);};
  let electron,exited=false;
  try{
    electron=await _electron.launch({executablePath:require('electron'),args,env,timeout:25000});
    electron.process().once('exit',()=>{exited=true;});
    const start=await electron.firstWindow({timeout:15000});
    await start.getByText('AHI couldn’t start this time.').waitFor({timeout:20000});
    assert.match(await start.locator('#start-reason').textContent(),/Another program is already using port/);
    assert.ok(await start.locator('#retry').isVisible());
    await start.screenshot({path:path.join(shots,'13-start-error-retry.png')});
    ok('a busy port shows the reason in plain words, with Retry');
    const log=await fs.readFile(path.join(data,'ahi.log'),'utf8');assert.match(log,/AHI could not start: Another program is already using port/);
    assert.match(await fs.readFile(path.join(managed,'logs','ahi-server.log'),'utf8'),/\[desktop\] .*AHI could not start/);
    ok('the failure is written to the app log and the server log');
    await new Promise(r=>squatter.close(r));
    const next=electron.waitForEvent('window',{predicate:p=>p.url().startsWith(`http://localhost:${port}`),timeout:30000});
    await start.locator('#retry').click();
    const ahi=await next;await ahi.waitForLoadState();
    assert.equal(await ahi.locator('#who').textContent(),'signed in');
    ok('Retry starts AHI and opens it in the window, signed in by the server\'s own cookie');
    assert.equal(await ahi.evaluate(()=>typeof window.ahi),'undefined');ok('AHI\'s pages get no bridge to the app');
    await ahi.screenshot({path:path.join(shots,'14-ahi-in-window.png')});
    ok('the stale lock from a killed server was cleared and the start retried (the stand-in took the lock)');
    const lockPid=Number(await fs.readFile(path.join(managed,'logs','gateway.pid'),'utf8'));assert.notEqual(lockPid,Number(dead));
    const state=await electron.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.close();return {count:BrowserWindow.getAllWindows().length,visible:w.isVisible(),title:w.getTitle()};});
    assert.deepEqual({count:state.count,visible:state.visible},{count:1,visible:false});
    const health=await fetch(`http://127.0.0.1:${port}/health`).then(r=>r.ok);assert.equal(health,true);
    ok('closing the window hides it and AHI keeps running');
    const shown=await electron.evaluate(({app,BrowserWindow})=>{app.emit('second-instance');const w=BrowserWindow.getAllWindows()[0];return w.isVisible();});
    assert.equal(shown,true);ok('opening AHI again shows the same window');
    await electron.evaluate(({app})=>app.quit());
    for(let i=0;i<100&&!exited;i++)await new Promise(r=>setTimeout(r,100));
    assert.ok(exited,'the app exited');
    assert.match(await fs.readFile(path.join(managed,'logs','ahi-server.log'),'utf8'),/\[stub\] clean stop/);
    await assert.rejects(fs.access(path.join(managed,'logs','gateway.pid')));
    ok('Quit stops the server cleanly: it removed its own lock');
    const result={passed:true,mode:'real Electron desktop app, headless, stand-in AHI server',checks};
    await fs.writeFile(path.resolve(__dirname,'../evidence/window-smoke.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
  }finally{if(electron&&!exited)await electron.close().catch(()=>{});squatter.close();await fs.rm(env.TMPDIR,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e.stack||e.message);process.exitCode=1;});
