// Captures the README's AHI Setup screenshots from the loopback preview (scripts/preview.cjs).
// Demo data only: a sample owner, a sample home path and an obviously fake key are shown in place of
// whatever this machine would display. Nothing is installed and no account is connected.
// Usage: [CHROMIUM_PATH=<chromium>] node scripts/readme-shots.cjs [output dir]   (default: the repo's docs/images)
const fs=require('node:fs/promises');
const path=require('node:path');
const {start}=require('./preview.cjs');
const DEMO={owner:'Alex',workspace:'Alex’s space',root:'/Users/alex/AHI',platform:'darwin',token:'0123456789abcdef'.repeat(4)};
async function main(){
  const {chromium}=require('playwright-core');
  const output=path.resolve(process.argv[2]||path.join(__dirname,'../../../docs/images'));await fs.mkdir(output,{recursive:true});
  const data=path.resolve(__dirname,`../.tmp/readme-${Date.now()}`);
  const {server,service}=await start({port:0,dataDir:data,quiet:true});
  // Show the installed-AHI ending (key, Open AHI) with demo values; hide the preview banner the real app never shows.
  const snapshot=service.snapshot.bind(service);let keySaved=false;
  service.snapshot=()=>{const s=snapshot();return {...s,preview:false,platform:DEMO.platform,ahiReady:true,...(s.root?{root:DEMO.root}:{}),...(s.completed&&!keySaved?{token:DEMO.token}:{})};};
  const invoke=service.invoke.bind(service);
  service.invoke=async(method,arg)=>{if(method==='token-saved'){keySaved=true;return service.snapshot();}return invoke(method,arg);};
  let browser;
  try{
    browser=await chromium.launch({headless:true,args:['--no-sandbox'],executablePath:process.env.CHROMIUM_PATH||undefined});
    const page=await browser.newPage({viewport:{width:1280,height:860},deviceScaleFactor:1.5,reducedMotion:'reduce'});
    // Each shot starts at the top of the page unless `at` names the element to bring into view.
    const shot=async(name,at)=>{await page.evaluate(sel=>{document.activeElement?.blur();const el=sel&&document.querySelector(sel);scrollTo(0,el?el.getBoundingClientRect().top+scrollY-48:0);},at);await page.screenshot({path:path.join(output,`setup-${name}.png`)});console.log('setup-'+name);};
    const click=async(action,arg)=>{await page.locator(`[data-action="${action}"]${arg===undefined?'':`[data-arg="${arg}"]`}`).last().click();await page.waitForFunction(()=>!document.querySelector('[data-action][disabled]'));};
    const step=id=>page.waitForSelector(`[aria-current="step"][data-arg="${id}"]`);
    await page.goto(`http://127.0.0.1:${server.address().port}`);await step('space');
    await page.locator('#owner').fill(DEMO.owner);await page.locator('#workspace').fill(DEMO.workspace);await page.getByText('Progress saved on this device').waitFor();await shot('1-welcome');
    await click('go','folder');await step('folder');await click('folder');await page.getByText('Your AHI home is ready',{exact:true}).waitFor();await shot('2-workspace');
    await click('go','models');await step('models');await Promise.all([page.waitForResponse('**/api'),page.locator('[data-model="claude"]').check()]);await click('provider','claude');
    await click('login','claude');await click('verify','claude');await page.getByText('Connected ✓',{exact:true}).first().waitFor();
    await page.locator('#feedback').evaluate(el=>{el.textContent='';});await shot('3-connect-claude');
    await click('go','brain');await click('go','voice');await click('go','remote');await step('remote');await shot('4-remote-access');
    await click('go','connections');await click('go','ready');await step('ready');
    await click('complete');await page.locator('#ahi-token').waitFor();
    await shot('5-your-key','.page > .hint');
    await click('token-saved');await page.getByRole('button',{name:'Open AHI ↗'}).waitFor();await shot('6-home-ready');
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));await fs.rm(data,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
