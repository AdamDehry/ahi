const {spawn}=require('node:child_process');
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const {cleanEnv,run}=require('../src/system.cjs');
async function main(){
 const {chromium}=require('@playwright/test');
 const output=process.env.AHI_SETUP_PACKAGE_DIR||path.resolve(__dirname,'../artifacts/linux-unpacked');
 const root=path.resolve(__dirname,`../.tmp/packaged-${Date.now()}`);await fs.mkdir(root,{recursive:true});
 const env={...cleanEnv(root),TMPDIR:path.resolve(__dirname,'../.tmp'),LD_LIBRARY_PATH:process.env.LD_LIBRARY_PATH||''};
 const child=spawn(path.join(output,'ahi-setup'),['--no-sandbox','--ozone-platform=headless','--disable-gpu','--remote-debugging-address=127.0.0.1','--remote-debugging-port=4194'],{cwd:root,env,stdio:'ignore'});
 let browser;
 try{
  for(let i=0;i<100;i++){try{const r=await fetch('http://127.0.0.1:4194/json/version');if(r.ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.connectOverCDP('http://127.0.0.1:4194');
  const context=browser.contexts()[0],page=context.pages()[0];await page.waitForSelector('#owner',{timeout:15000});
  const check=await page.evaluate(()=>({node:typeof require,bridge:typeof window.ahi.invoke,preview:!document.querySelector('#preview-banner').hidden}));assert.deepEqual(check,{node:'undefined',bridge:'function',preview:false});
  const node=await run(path.join(output,'resources/runtime/node'),['--version'],{home:root});assert.equal(node.code,0);assert.equal(node.out.trim(),'v22.22.2');
  await page.screenshot({path:path.resolve(__dirname,'../evidence/screenshots/12-packaged-desktop.png'),fullPage:true});
  const result={passed:true,mode:'Actual packaged Linux desktop executable with bundled Node; headless Chromium display',extractedAppImage:!!process.env.AHI_SETUP_PACKAGE_DIR,checks:['packaged app launches','packaged preload bridge works','renderer Node access disabled','real desktop service selected','bundled portable Node starts without system Node'],published:false};
  await fs.writeFile(path.resolve(__dirname,'../evidence/packaged-smoke.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 }finally{if(browser)await browser.close();child.kill();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
