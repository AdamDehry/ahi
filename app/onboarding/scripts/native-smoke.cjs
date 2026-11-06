const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const {cleanEnv}=require('../src/system.cjs');
async function main(){
  const {_electron}=require('@playwright/test');
  const root=path.resolve(__dirname,`../.tmp/native-${Date.now()}`);await fs.mkdir(path.join(root,'desktop-data'),{recursive:true});await fs.mkdir(path.join(root,'home'));
  const executablePath=require('electron');
  const args=[path.resolve(__dirname,'..'),...(process.platform==='linux'?['--no-sandbox','--ozone-platform=headless','--disable-gpu']:[])];
  const env={...cleanEnv(path.join(root,'home')),AHI_SETUP_TEST_ROOT:root,LD_LIBRARY_PATH:process.env.LD_LIBRARY_PATH||'',TMPDIR:path.resolve(__dirname,'../.tmp')};
  const electron=await _electron.launch({executablePath,args,env,timeout:25000});
  try{
    const page=await electron.firstWindow({timeout:15000});await page.waitForSelector('#owner');
    const isolation=await page.evaluate(()=>({node:typeof require,process:typeof process,bridge:typeof window.ahi?.invoke,preview:!document.querySelector('#preview-banner').hidden}));assert.deepEqual(isolation,{node:'undefined',process:'undefined',bridge:'function',preview:false});
    await page.locator('#owner').fill('Native sandbox');await page.locator('#workspace').fill('Native smoke');await page.locator('[data-action="go"][data-arg="folder"]').last().click();await page.waitForSelector('[aria-current="step"][data-arg="folder"]');
    await electron.evaluate(({dialog},chosen)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[chosen]});},path.join(root,'home'));
    await page.locator('[data-action="folder"]').click();await page.getByText('Your AHI home is ready',{exact:true}).waitFor();
    assert.deepEqual((await fs.readdir(path.join(root,'home','AHI'))).sort(),['.ahi-setup-claim','AHI_OS','Personal','Work']);
    await page.screenshot({path:path.resolve(__dirname,'../evidence/screenshots/11-native-desktop.png'),fullPage:true});
    const binding=await electron.evaluate(({app})=>{const loader=process.getBuiltinModule('node:module').createRequire(app.getAppPath()+'/package.json');return typeof loader('@napi-rs/keyring').AsyncEntry;});assert.equal(binding,'function');
    const evidence={passed:true,mode:'native Electron desktop app',checks:['renderer has no Node or process access','only narrow IPC bridge exposed','desktop uses real service, no preview fixtures','folder capability invokes real filesystem creation inside sandbox','native credential binding loads inside Electron'],keychainWrite:false};
    await fs.writeFile(path.resolve(__dirname,'../evidence/native-smoke.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
  }finally{await electron.close();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
