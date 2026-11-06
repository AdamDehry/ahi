// VPS mode: loopback only, paired owner session, no secrets in URLs or request logs.
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {SetupService}=require('./service.cjs');
const {RemoteSetup}=require('./remote.cjs');
const {terminal}=require('./system.cjs');
function equal(a,b){if(typeof a!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y);}
// ahi = { serverDir, seed, port }: the bundled AHI server and seed, so a VPS setup installs and starts AHI too.
async function startHeadless({dataDir,node,npmCli,keyring,port=4189,parentDefault,quiet=false,ahi}={}){
 let selectedParent=parentDefault;
 const pairingCode=crypto.randomBytes(24).toString('base64url'),session=crypto.randomBytes(32).toString('base64url');
 const service=new SetupService({dataDir,node,npmCli,keyring,ahi,chooseFolder:async()=>selectedParent,openExternal:async()=>{},launchTerminal:(command,args,home,options)=>terminal(command,args,home,{...options,scriptOnly:true})});await service.init();
 const snapshot=service.snapshot.bind(service);service.snapshot=()=>({...snapshot(),headless:true,parentDefault});
 const remote=new RemoteSetup(service);let failures=0;
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
  try{
   const address=`127.0.0.1:${server.address().port}`;
   if(req.headers.host!==address&&req.headers.host!==`localhost:${server.address().port}`)throw Error('Use the loopback address or an SSH local forward.');
   if(req.method==='POST'&&req.url==='/api'){
    if(req.headers.origin&&!['http://'+address,`http://localhost:${server.address().port}`].includes(req.headers.origin))throw Error('Invalid setup origin.');
    if(req.headers['content-type']!=='application/json')throw Error('JSON requests only.');
    let body='';for await(const chunk of req){body+=chunk;if(body.length>16384)throw Error('Request too large.');}
    const {method,arg}=JSON.parse(body);
    if(method==='pair'){
     if(failures>=10)throw Error('Pairing is locked. Restart this setup server for a new code.');
     if(!equal(arg,pairingCode)){failures++;throw Error('That pairing code did not match.');}
     res.setHeader('Set-Cookie',`ahi-setup=${session}; HttpOnly; SameSite=Strict; Path=/`);
     res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,value:service.snapshot()}));return;
    }
    const cookie=(req.headers.cookie||'').split(';').map(c=>c.trim()).find(c=>c.startsWith('ahi-setup='))?.slice(10);
    if(!equal(cookie,session)){res.statusCode=401;throw Error('Pair this browser using the code in your SSH terminal.');}
    if(method==='folder'){
     if(typeof arg?.parent!=='string'||!path.isAbsolute(arg.parent))throw Error('Enter an absolute parent folder on this server.');selectedParent=arg.parent;
    }
    const result=method==='remote-install'?await remote.install():method==='remote-login'?await remote.login():method==='remote-create'?await remote.create():method==='remote-route'?await remote.route(arg):method==='remote-start'?await remote.start():method==='remote-stop'?await remote.stop():await service.invoke(method,arg);
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,value:result}));return;
   }
   const files={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/styles.css':'styles.css'};const file=files[req.url];if(!file){res.writeHead(404);res.end('Not found');return;}
   res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(await fs.readFile(path.join(__dirname,'../ui',file)));
  }catch(e){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:false,error:e.message}));}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
 if(!quiet){process.stdout.write(`AHI Setup is listening only on 127.0.0.1:${server.address().port}.\nUse an SSH local forward, then open that loopback address in your browser.\nPairing code for your browser: ${pairingCode}\nKeep this code private. It expires when setup stops.\n${ahi?`When setup finishes and AHI starts, forward port ${ahi.port} the same way to open AHI itself.\n`:''}`);}
 // Stopping headless Setup stops everything it started: the tunnel, the AHI server, then this setup server.
 const stop=async()=>{if(remote.child)remote.child.kill();await service.stopAhi();await new Promise(done=>server.close(()=>done()));};
 return {server,service,remote,pairingCode,stop};
}
module.exports={startHeadless};
