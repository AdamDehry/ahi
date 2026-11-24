const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {allowedCall,signIn,linuxAutostart}=require('../src/desktop.cjs');

test('only the setup screens reach every action; the start screen reaches start and setup; AHI\'s pages reach nothing',()=>{
  const urls={setupUrl:'file:///app/ui/index.html',startUrl:'file:///app/ui/start.html'};
  assert.equal(allowedCall(urls.setupUrl,'complete',urls),true);
  assert.equal(allowedCall(urls.startUrl,'start',urls),true);
  assert.equal(allowedCall(urls.startUrl,'setup',urls),true);
  assert.equal(allowedCall(urls.startUrl,'voice',urls),false);
  assert.equal(allowedCall('http://localhost:18789/','start',urls),false);
});

test('the window signs in through the server\'s own login only when it is not signed in already',async()=>{
  const calls=[];const fetcher=signedIn=>async(url,options={})=>{calls.push({url,...options});return {ok:url.endsWith('/ui/session')?signedIn:true};};
  assert.equal(await signIn(fetcher(true),'http://localhost:18789/','owner-token'),false);
  assert.deepEqual(calls.map(c=>c.url),['http://localhost:18789/ui/session']);
  calls.length=0;
  assert.equal(await signIn(fetcher(false),'http://localhost:18789/','owner-token'),true);
  assert.equal(calls[1].url,'http://localhost:18789/ui/login');assert.equal(calls[1].method,'POST');assert.equal(JSON.parse(calls[1].body).token,'owner-token');
  assert.ok(calls.every(c=>c.credentials==='include'),'the cookie is kept in the window\'s session');
  calls.length=0;
  assert.equal(await signIn(fetcher(false),'http://localhost:18789/',null),false);assert.equal(calls.length,0);
});

test('Linux start-at-login is an autostart entry that starts the AppImage hidden, quoted for spaces, and goes when off',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'autostart-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await linuxAutostart(true,{appImage:'/home/o/My Apps/AHI.AppImage',dir});
  assert.match(await fs.readFile(path.join(dir,'ahi.desktop'),'utf8'),/^Exec="\/home\/o\/My Apps\/AHI\.AppImage" --hidden$/m);
  await linuxAutostart(false,{appImage:'/home/o/My Apps/AHI.AppImage',dir});
  await assert.rejects(fs.access(path.join(dir,'ahi.desktop')));
});
