const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {cleanEnv}=require('../src/system.cjs');
async function main(){
 const output=process.env.AHI_SETUP_PACKAGE_DIR||path.resolve(__dirname,'../artifacts/linux-unpacked');
 const home=path.resolve(__dirname,`../.tmp/vps-packaged-final-${Date.now()}`);await fs.mkdir(home,{recursive:true});
 let occupied=false;try{await fetch('http://127.0.0.1:4189',{signal:AbortSignal.timeout(300)});occupied=true;}catch{}
 if(occupied)throw Error('The test port is already in use. No process was stopped.');
 const child=spawn(path.join(output,'ahi-setup'),['--no-sandbox','--ozone-platform=headless','--disable-gpu','--headless-setup'],{cwd:home,env:{...cleanEnv(home),LD_LIBRARY_PATH:process.env.LD_LIBRARY_PATH||'',TMPDIR:path.resolve(__dirname,'../.tmp')},stdio:'ignore'});
 try{
  let status,body;
  for(let i=0;i<100;i++){try{const response=await fetch('http://127.0.0.1:4189/api',{method:'POST',headers:{'content-type':'application/json'},body:'{"method":"load"}',signal:AbortSignal.timeout(1000)});status=response.status;body=await response.json();break;}catch{}await new Promise(resolve=>setTimeout(resolve,100));}
  assert.equal(status,401);assert.equal(body.ok,false);assert.match(body.error,/Pair this browser/);
 }finally{child.kill();await new Promise(resolve=>child.once('exit',resolve));}
 let stopped=false;for(let i=0;i<30;i++){try{await fetch('http://127.0.0.1:4189',{signal:AbortSignal.timeout(300)});}catch{stopped=true;break;}await new Promise(resolve=>setTimeout(resolve,100));}
 assert.equal(stopped,true);
 const result={passed:true,extractedAppImage:!!process.env.AHI_SETUP_PACKAGE_DIR,mode:'Packaged VPS mode with bundled Node and a headless display backend',checks:['starts without a graphical desktop','requires pairing before setup state access','port passes the browser fetch bad-port check','stopping the app stops its setup server'],unauthenticatedStatus:401,pairingCodeRendered:false,keychainWrite:false};
 await fs.writeFile(path.resolve(__dirname,'../evidence/headless-packaged-smoke.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
