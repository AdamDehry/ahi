// This server is a conspicuous, loopback-only fixture. It never accepts a live secret.
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const {SetupService}=require('../src/service.cjs');
async function start({port=4189,dataDir=path.resolve(__dirname,'../evidence/sandbox'),quiet=false}={}){
  await fs.mkdir(path.join(dataDir,'home'),{recursive:true,mode:0o700});
  const service=new SetupService({dataDir:path.join(dataDir,'state'),sandboxRoot:dataDir,chooseFolder:async()=>path.join(dataDir,'home'),openExternal:async()=>{},runner:async(_cmd,args)=>({code:0,out:args.includes('status')?JSON.stringify({loggedIn:true}):'AHI_READY'}),launchTerminal:async()=>({message:'Sample sign-in opened. In the desktop app, this opens the provider’s official CLI in a system terminal.'})});
  await service.init();
  const originalSnapshot=service.snapshot.bind(service);service.snapshot=()=>({...originalSnapshot(),preview:true});
  service.installTool=async()=>({message:'Sample CLI installed. The desktop app installs the real official CLI.'});
  service.saveVoice=async()=>{throw Error('Live keys are disabled in the preview. Use the desktop app or skip voice for now.');};
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    try{
      if(req.method==='POST'&&req.url==='/api'){
        if(req.headers.origin&&req.headers.origin!==`http://127.0.0.1:${server.address().port}`)throw Error('Use the local preview address.');
        if(req.headers['content-type']!=='application/json')throw Error('JSON requests only.');
        let body='';for await(const chunk of req){body+=chunk;if(body.length>16384)throw Error('Request is too large.');}
        const {method,arg}=JSON.parse(body);
        // Keys are rejected before entering the service. Preview only supports its advertised fixtures.
        if(method==='voice')throw Error('Live keys are disabled in the preview.');
        const result=method.startsWith('remote-')?{message:'Preview only. Use the desktop app for Cloudflare sign-in and tunnel setup.'}:await service.invoke(method,arg);
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,value:result}));return;
      }
      const files={'/':'index.html','/index.html':'index.html','/app.js':'app.js','/styles.css':'styles.css'};
      const file=files[req.url];if(!file){res.writeHead(404);res.end('Not found');return;}
      res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':'text/html');
      res.end(await fs.readFile(path.join(__dirname,'../ui',file)));
    }catch(e){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:false,error:e.message}));}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  if(!quiet)console.log(`AHI Setup preview: http://127.0.0.1:${server.address().port} (sample services, no live accounts)`);
  return {server,service};
}
if(require.main===module)start({port:Number(process.env.AHI_SETUP_PREVIEW_PORT||4189)}).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={start};
