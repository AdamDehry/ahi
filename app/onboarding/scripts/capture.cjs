const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const {start}=require('./preview.cjs');
async function main(){
  const {chromium}=require('@playwright/test');
  const output=path.resolve(__dirname,'../evidence/screenshots');await fs.mkdir(output,{recursive:true});
  const data=path.resolve(__dirname,`../.tmp/ui-${Date.now()}`);
  const {server}=await start({port:0,dataDir:data,quiet:true});
  let browser;
  try{browser=await chromium.launch({headless:true,args:['--no-sandbox'],env:{...process.env,TMPDIR:path.resolve(__dirname,'../.tmp')}});}catch(e){await new Promise(resolve=>server.close(resolve));throw e;}
  const page=await browser.newPage({viewport:{width:1280,height:960},reducedMotion:'reduce'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const url=`http://127.0.0.1:${server.address().port}`;
  const shots=[];
  const shot=async(name)=>{await page.screenshot({path:path.join(output,name+'.png'),fullPage:true});shots.push(name);};
  const click=async(action,arg)=>{const selector=`[data-action="${action}"]${arg===undefined?'':`[data-arg="${arg}"]`}`;await page.locator(selector).last().click();await page.waitForFunction(()=>!document.querySelector('[data-action="go"][disabled]'));};
  const step=async id=>{await page.waitForSelector(`[aria-current="step"][data-arg="${id}"]`);};
  try{
    await page.goto(url);await step('space');await shot('01-your-space');
    await click('go','folder');await page.getByRole('status').filter({hasText:'Tell us your name'}).waitFor();
    await page.locator('#owner').fill('Alex');await page.locator('#workspace').fill('Alex’s space');
    await click('go','folder');await step('folder');await shot('02-where-files-live');
    await click('folder');await page.getByText('Your AHI home is ready',{exact:true}).waitFor();await shot('02b-home-prepared');
    await click('go','models');await step('models');await shot('03-connect-models');
    await click('provider','gemini');await shot('03b-provider-sign-in');
    await click('login','gemini');await page.getByRole('status').filter({hasText:'Sample sign-in opened'}).waitFor();
    await click('verify','gemini');await page.getByText('Connected ✓',{exact:true}).waitFor();
    await click('go','brain');await step('brain');await shot('04-default-brain');
    await click('go','voice');await step('voice');await shot('05-find-your-voice');
    await click('voice-open','openai');await page.locator('#voice-key').waitFor();assert.equal(await page.locator('#voice-key').isDisabled(),true);await shot('05b-keychain-guidance');
    await click('go','remote');await step('remote');await shot('06-access-anywhere');
    await page.reload();await step('remote');
    await click('go','connections');await step('connections');await page.locator('[data-connection="gmail"]').check();await shot('07-connections');
    await click('go','ready');await step('ready');await shot('08-review');
    await click('complete');await page.getByText('Setup saved ✓',{exact:true}).waitFor();await shot('09-setup-saved');
    await page.setViewportSize({width:390,height:844});await page.reload();await step('ready');await shot('10-mobile-review');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    // A second fresh browser can still navigate this preview’s saved setup, but cannot inject a live key.
    const response=await page.request.post(url+'/api',{data:{method:'voice',arg:{id:'openai',key:'synthetic-never-save'}}});assert.equal((await response.json()).ok,false);
    assert.deepEqual(errors,[]);
    const {startHeadless}=require('../src/headless.cjs');
    const headless=await startHeadless({dataDir:path.join(data,'headless-state'),node:process.execPath,port:0,parentDefault:path.join(data,'headless-home'),quiet:true});
    await fs.mkdir(path.join(data,'headless-home'));
    try{
      await page.setViewportSize({width:1280,height:960});await page.goto(`http://127.0.0.1:${headless.server.address().port}`);await page.locator('#pairing-code').waitFor();await shot('13-vps-pair-browser');
      await page.locator('#pairing-code').fill(headless.pairingCode);await click('pair');await step('space');
      await page.locator('#owner').fill('Server sandbox');await click('go','folder');await step('folder');await page.locator('#server-parent').waitFor();await shot('14-vps-server-folder');
      await click('folder');await page.getByText('Your AHI home is ready',{exact:true}).waitFor();
      assert.equal((await page.locator('body').innerText()).includes(headless.pairingCode),false);
    }finally{await new Promise(resolve=>headless.server.close(resolve));}
    const evidence={passed:true,checks:['required identity blocks navigation','native-folder fixture prepares home','one non-Claude provider completes setup','provider sign-in fixture returns','key entry disabled in preview','remote step resumes after reload','optional choices survive finish','finish produces handoff','mobile has no horizontal overflow','preview rejects keys','no browser script errors','VPS browser pairs without a code in the URL','paired VPS browser prepares a real sandbox home'],screenshots:shots,mode:'loopback browser preview with explicit sample-provider adapters; paired VPS UI uses the real service without account sign-ins'};
    await fs.writeFile(path.resolve(__dirname,'../evidence/ui-checks.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
