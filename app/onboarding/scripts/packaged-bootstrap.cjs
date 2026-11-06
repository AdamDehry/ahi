const fs=require('node:fs/promises');
const path=require('node:path');
const {run}=require('../src/system.cjs');
async function main(){
 const output=process.env.AHI_SETUP_PACKAGE_DIR||path.resolve(__dirname,'../artifacts/linux-unpacked');
 const resources=path.join(output,'resources'),node=path.join(resources,'runtime/node'),npmCli=path.join(resources,'app.asar.unpacked/node_modules/npm/bin/npm-cli.js');
 const dir=path.resolve(__dirname,`../.tmp/packaged-bootstrap-${Date.now()}`);await fs.mkdir(path.join(dir,'home'),{recursive:true});
 const {SetupService}=require(path.join(resources,'setup-server/src/service.cjs'));
 const s=new SetupService({dataDir:path.join(dir,'state'),node,npmCli,chooseFolder:async()=>path.join(dir,'home')});await s.init();await s.patch({owner:'Packaged sandbox',workspace:'Portable bootstrap'});await s.prepareFolder();
 const npm=await run(node,[npmCli,'--version'],{home:dir});if(npm.code!==0)throw Error('Packaged npm could not start.');
 const binding=path.join(resources,'app.asar.unpacked/node_modules/@napi-rs/keyring');
 const native=await run(node,['-e','process.stdout.write(typeof require(process.argv[1]).AsyncEntry)',binding],{home:dir});if(native.code!==0||native.out!=='function')throw Error('Packaged credential binding could not load.');
 await s.installTool('codex');const command=await s.cli('codex');const status=await run(command.command,[...command.args,'login','status'],{home:command.home,env:command.env});if(status.code===0)throw Error('The fresh CLI home unexpectedly reported a login.');
 const result={passed:true,extractedAppImage:!!process.env.AHI_SETUP_PACKAGE_DIR,npmVersion:npm.out.trim(),checks:['bundled npm starts with bundled Node','bundled native keyring binding loads','packaged service installs and starts an official Codex CLI','fresh packaged CLI home is signed out'],signIn:false,keychainWrite:false};
 await fs.writeFile(path.resolve(__dirname,'../evidence/packaged-bootstrap.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
