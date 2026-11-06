// Real official CLIs; fresh empty homes only. No login, no production credential reads.
const fs=require('node:fs/promises');
const path=require('node:path');
const {SetupService}=require('../src/service.cjs');
const {run}=require('../src/system.cjs');
async function main(){
  const dir=path.resolve(__dirname,`../evidence/probe-home/run-${Date.now()}`);await fs.mkdir(path.join(dir,'home'),{recursive:true,mode:0o700});
  const s=new SetupService({dataDir:path.join(dir,'state'),chooseFolder:async()=>path.join(dir,'home'),openExternal:async()=>{},sandboxRoot:dir});await s.init();await s.patch({owner:'Sandbox',workspace:'CLI adapter check'});await s.prepareFolder();
  const result={mode:'Live official CLI binaries with clean per-provider homes. No sign-in or live credential supplied.',providers:{}};
  for(const id of ['codex','claude','gemini']){
    console.log(`Installing official ${id} CLI in the sandbox…`);
    const installed=await s.installTool(id);const c=await s.cli(id);
    const version=await run(c.command,[...c.args,'--version'],{home:c.home,env:c.env,timeout:30000});
    // Only version output is retained. Status output can contain account identifiers and is discarded.
    let status;if(id==='gemini')status=await run(c.command,[...c.args,'-p','Reply with only AHI_READY.','--output-format','json'],{home:c.home,env:c.env,timeout:20000});
    else status=await run(c.command,[...c.args,...s.snapshot().catalog.providers[id].status],{home:c.home,env:c.env,timeout:20000});
    let signedOut=status.code!==0;if(id==='claude'&&status.code===0){try{signedOut=JSON.parse(status.out).loggedIn===false;}catch{signedOut=false;}}
    result.providers[id]={installed:installed.installed,version:version.out.trim().replace(/\x1b\[[0-9;]*m/g,'').slice(0,160),versionExit:version.code,freshHomeRecognizedAsSignedOut:signedOut,statusExit:status.code};
    console.log(`${id}: version ${version.code===0?'passed':'failed'}; empty-home sign-out ${signedOut?'passed':'failed'}`);
  }
  const cloudHome=path.join(dir,'cloudflare');await fs.mkdir(cloudHome,{mode:0o700});const cv=await run('/usr/local/bin/cloudflared',['--version'],{home:cloudHome});
  result.cloudflared={version:cv.out.trim().slice(0,160),versionExit:cv.code,note:'Version only. No account, tunnel, DNS or live service used.'};
  result.passed=Object.values(result.providers).every(p=>p.installed&&p.versionExit===0&&p.freshHomeRecognizedAsSignedOut)&&cv.code===0;
  await fs.writeFile(path.resolve(__dirname,'../evidence/cli-probe.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
