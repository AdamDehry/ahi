const {app,BrowserWindow,Menu,Tray,desktopCapturer,dialog,ipcMain,nativeImage,session,shell}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {SetupService}=require('./service.cjs');
const {RemoteSetup}=require('./remote.cjs');
const {allowedCall,signIn,sessionLanguage,linuxAutostart}=require('./desktop.cjs');
const {t,systemLang}=require('../ui/i18n.js');
let win,winKind,tray,service,remote,starting=null,startAbort=null,stopping=null,stopped=false,quitting=false,trayHintShown=false;
const headless=app.commandLine.hasSwitch('headless-setup')||process.argv.includes('--headless-setup');
if(headless){app.commandLine.appendSwitch('ozone-platform','headless');app.disableHardwareAcceleration();}
// The server is proven on 127.0.0.1 (ahi-runtime serves()); "localhost" could also mean ::1, where some other program
// may listen. So in this app "localhost" IS 127.0.0.1: the key, the cookies and the window all go where the proof ran.
// The address stays "localhost" (not the bare IP) because passkeys are bound to it and are never allowed on an IP.
app.commandLine.appendSwitch('host-resolver-rules','MAP localhost 127.0.0.1');
// Native smoke tests can opt into a workdir-owned home; packaged apps never use fixtures.
const sandbox=!app.isPackaged&&process.env.AHI_SETUP_TEST_ROOT;
// The product is called AHI now; its saved setup stays in the folder "AHI Setup" always used.
app.setPath('userData',sandbox?path.join(sandbox,'desktop-data'):path.join(app.getPath('appData'),'AHI Setup'));
// Started by the login item: bring AHI up without a window (the window opens from the tray, or on a failure).
const hiddenStart=process.argv.includes('--hidden')||(process.platform==='darwin'&&app.getLoginItemSettings().wasOpenedAtLogin);
const setupUrl=pathToFileURL(path.join(__dirname,'../ui/index.html')).href,startUrl=pathToFileURL(path.join(__dirname,'../ui/start.html')).href;
const logFile=()=>path.join(app.getPath('userData'),'ahi.log');
// The owner's language (setup's choice, then AHI's Settings); before setup has loaded, the system's.
const systemLanguages=()=>app.getPreferredSystemLanguages?.()||[app.getLocale()];
const L=()=>service?service.language:systemLang(systemLanguages());
const logLine=line=>{try{fs.appendFileSync(logFile(),`${new Date().toISOString()} ${line}\n`);}catch{}};
// One AHI per computer: a second launch (Start menu, login item, a double click) shows the one already running.
const primary=headless||app.requestSingleInstanceLock();
if(!primary)app.quit();
else app.on('second-instance',()=>showMain());

/** The AHI window's own browser session: persistent (it stays signed in), and only AHI's own origin may use the
 * microphone, notifications, the clipboard or a screen share. */
let ahiOrigin=null;
function ahiSession(origin){
  const ses=session.fromPartition('persist:ahi');
  if(ahiOrigin===origin)return ses;ahiOrigin=origin;
  const allowed=new Set(['media','notifications','clipboard-sanitized-write','fullscreen','display-capture']);
  const ours=url=>{try{return new URL(url).origin===origin;}catch{return false;}};
  ses.setPermissionRequestHandler((wc,permission,callback,details)=>callback(allowed.has(permission)&&ours(details.requestingUrl||wc.getURL())));
  ses.setPermissionCheckHandler((_wc,permission,requestingOrigin)=>allowed.has(permission)&&ours(requestingOrigin));
  // "Look at my screen" on a call: the system's own picker where there is one, else the whole main screen.
  ses.setDisplayMediaRequestHandler((request,callback)=>{
    if(!ours(request.securityOrigin))return callback({});
    desktopCapturer.getSources({types:['screen']}).then(([screen])=>callback(screen?{video:screen}:{}),()=>callback({}));
  },{useSystemPicker:true});
  return ses;
}

/** Replace the one window with a new page: the setup screens, the start screen, or AHI itself. The new window is as
 * visible as the one it replaces (closed to the tray stays in the tray) unless `show` says otherwise. */
function openWindow(kind,url,{show}={}){
  const old=win&&!win.isDestroyed()?win:null;
  const visible=show??(old?old.isVisible():!(hiddenStart&&kind!=='setup'));
  const webPreferences=kind==='ahi'
    // AHI's own pages are a website: no bridge to this app at all.
    ?{partition:'persist:ahi',contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}
    :{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true};
  win=new BrowserWindow({width:1240,height:900,minWidth:820,minHeight:680,backgroundColor:'#0c1917',title:'AHI',autoHideMenuBar:true,show:visible,webPreferences});winKind=kind;
  if(kind==='ahi'){
    const origin=new URL(url).origin;ahiSession(origin);
    // Leaving the window is when a language change in AHI's Settings has to reach the tray menu.
    win.on('blur',()=>void followLanguage(url));win.on('hide',()=>void followLanguage(url));
    const external=u=>{if(/^https?:/i.test(u))shell.openExternal(u);};
    win.webContents.setWindowOpenHandler(({url:u})=>{try{if(new URL(u).origin===origin)return {action:'allow',overrideBrowserWindowOptions:{autoHideMenuBar:true}};}catch{}external(u);return {action:'deny'};});
    win.webContents.on('will-navigate',(event,u)=>{try{if(new URL(u).origin===origin)return;}catch{}event.preventDefault();external(u);});
  }else{
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.webContents.on('will-navigate',event=>event.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
  }
  // Closing the window keeps AHI running (tray on Windows and Linux, the dock on a Mac); Quit AHI really quits.
  const w=win;w.on('close',event=>{
    if(quitting)return;
    event.preventDefault();w.hide();
    if(tray&&!trayHintShown&&process.platform==='win32'){trayHintShown=true;tray.displayBalloon({title:t(L(),'tray.stillRunningTitle'),content:t(L(),'tray.stillRunningBody')});}
  });
  old?.destroy();
  return win.loadURL(url);
}
function showMain(){
  if(win&&!win.isDestroyed()){if(win.isMinimized())win.restore();win.show();win.focus();return;}
  if(service?.state.completed)openWindow('start',startUrl,{show:true});else openWindow('setup',setupUrl,{show:true});
}

/** Start the AHI server (one attempt at a time; Quit cancels it) and sign the window in; resolves to AHI's address.
 * A sign-in that fails rejects like a failed start: the start screen shows why, never an unsigned window. */
function startAhi(){
  return starting??=(async()=>{
    startAbort=new AbortController();
    try{
      const url=await service.ensureAhi({signal:startAbort.signal});
      if(quitting)throw Error(t(L(),'error.quitting'));
      await signIn((u,o)=>ahiSession(new URL(url).origin).fetch(u,o),url,await service.ownerToken(),undefined,L());
      await followLanguage(url);
      // If the server stops by itself later, say so and offer Retry (a deliberate restart replaces ahiChild first).
      const child=service.ahiChild;
      child?.once('exit',code=>{if(quitting||service.ahiChild!==child)return;logLine(`AHI stopped unexpectedly (exit ${code}).`);if(winKind==='ahi')openWindow('start',startUrl);});
      return url;
    }catch(error){logLine(`AHI could not start: ${error.message}`);throw error;}
    finally{starting=null;}
  })();
}
/** Follow the language the owner saved in AHI's Settings: the tray menu, dialogs and start screen speak it. */
async function followLanguage(url){
  const lang=await sessionLanguage((u,o)=>ahiSession(new URL(url).origin).fetch(u,o),url);
  if(lang&&service&&await service.setLanguage(lang).catch(()=>false))buildTray();
}
/** Started at login: AHI comes up with its window hidden; a failure shows the start screen (which retries once and
 * then gives the reason and Retry). */
async function startHidden(){
  try{await openWindow('ahi',await startAhi());}
  catch{await openWindow('start',startUrl,{show:true});}
}

async function applyLoginItem(){
  if(!app.isPackaged||!service)return;
  const on=service.state.completed&&service.startAtLogin;
  try{
    if(process.platform==='linux')await linuxAutostart(on);
    else app.setLoginItemSettings({openAtLogin:on,args:['--hidden']});
  }catch(e){logLine(`Could not change start-at-login: ${e.message}`);}
}
function buildTray(){
  const icon=nativeImage.createFromPath(path.join(__dirname,'../ui/icon.png')).resize({width:process.platform==='darwin'?18:32});
  const fresh=!tray;tray??=new Tray(icon);tray.setToolTip('AHI');
  const lang=L();
  tray.setContextMenu(Menu.buildFromTemplate([
    {label:t(lang,'tray.open'),click:showMain},
    {label:t(lang,'tray.setup'),click:()=>openWindow('setup',setupUrl,{show:true})},
    {type:'separator'},
    {label:t(lang,'tray.startAtLogin'),type:'checkbox',checked:service.startAtLogin,click:async item=>{await service.setStartAtLogin(item.checked);await applyLoginItem();}},
    {type:'separator'},
    {label:t(lang,'tray.quit'),click:()=>app.quit()},
  ]));
  if(fresh&&process.platform!=='darwin')tray.on('click',showMain);
}

if(primary)app.whenReady().then(async()=>{
  const dataDir=app.getPath('userData');
  const keyring={set:async(account,value)=>{
    const {AsyncEntry}=require('@napi-rs/keyring');
    const entry=new AsyncEntry('org.ahi.setup',account,{linux:{store:'secret-service'}});await entry.setPassword(value);
  },get:async(account)=>{
    const {AsyncEntry}=require('@napi-rs/keyring');
    return new AsyncEntry('org.ahi.setup',account,{linux:{store:'secret-service'}}).getPassword();
  }};
  const runtimeFolder=app.isPackaged?path.join(process.resourcesPath,'runtime'):path.resolve(__dirname,'../runtime',{darwin:'mac',linux:'linux',win32:'win'}[process.platform],process.arch);
  const runtimeNode=path.join(runtimeFolder,process.platform==='win32'?'node.exe':'node');
  if(headless){
    const runner=app.isPackaged?path.join(process.resourcesPath,'setup-server/src/headless-runner.cjs'):path.join(__dirname,'headless-runner.cjs');
    const child=require('node:child_process').spawn(runtimeNode,[runner,dataDir],{stdio:'inherit',env:{...process.env,...(!app.isPackaged?{AHI_SETUP_NATIVE_BINDING:require.resolve('@napi-rs/keyring')}:{})}});
    const keepAlive=setInterval(()=>{},1000);child.once('error',()=>app.quit());child.once('exit',()=>app.quit());app.on('before-quit',()=>{clearInterval(keepAlive);child.kill();});process.once('SIGTERM',()=>{child.kill();app.quit();});process.once('SIGINT',()=>{child.kill();app.quit();});return;
  }
  service=new SetupService({dataDir,systemLanguages:systemLanguages(),node:runtimeNode,npmCli:app.isPackaged?path.join(process.resourcesPath,'app.asar.unpacked/node_modules/npm/bin/npm-cli.js'):undefined,keyring,sandboxRoot:sandbox,inWindow:true,
    chooseFolder:async()=>{const picked=await dialog.showOpenDialog(win,{title:t(L(),'dialog.chooseFolder'),properties:['openDirectory','createDirectory']});return picked.canceled?null:picked.filePaths[0];},
    openExternal:url=>shell.openExternal(url),
    // The bundled AHI server and the hidden OS folder's seed: packaged resources, or this repo while developing.
    ahi:{serverDir:app.isPackaged?path.join(process.resourcesPath,'ahi-server'):(sandbox&&process.env.AHI_SETUP_TEST_SERVER_DIR)||path.resolve(__dirname,'../..'),seed:app.isPackaged?path.join(process.resourcesPath,'ahi-seed'):path.resolve(__dirname,'../../..'),port:Number(process.env.AHI_PORT)||18789}});
  await service.init();remote=new RemoteSetup(service);
  ipcMain.handle('setup:invoke',async(event,method,arg)=>{
    const url=event.senderFrame?.url;
    if(event.sender!==win?.webContents||event.senderFrame!==win.webContents.mainFrame||!allowedCall(url,method,{setupUrl,startUrl}))throw Error('Untrusted setup window.');
    try{
      let result;
      // AHI opens here, in this window, not in a browser tab.
      if(method==='open-ahi'||method==='start'){await startAhi();setImmediate(()=>openWindow('ahi',service.ahiUrl).catch(e=>logLine(`AHI window failed: ${e.message}`)));result=service.snapshot();}
      else if(method==='setup'){setImmediate(()=>openWindow('setup',setupUrl));result={};}
      else result=method==='remote-install'?await remote.install():method==='remote-login'?await remote.login():method==='remote-create'?await remote.create():method==='remote-route'?await remote.route(arg):method==='remote-start'?await remote.start():method==='remote-stop'?await remote.stop():await service.invoke(method,arg);
      if(method==='complete')await applyLoginItem();
      if(method==='patch'&&arg?.language&&tray)buildTray();
      return {ok:true,value:result};
    }catch(error){
      if(method==='start'||method==='open-ahi')win?.show(); // a failed start is shown, even from the tray
      return {ok:false,error:error.message};
    }
  });
  // No display (a server running the app headless): no tray to show, and GTK would abort trying.
  if(app.commandLine.getSwitchValue('ozone-platform')!=='headless')buildTray();
  await applyLoginItem();
  app.on('activate',showMain); // the Mac dock icon
  // Set up already: AHI itself (the start screen starts it, then hands over). First run: the setup screens.
  if(!service.state.completed)await openWindow('setup',setupUrl);else if(hiddenStart)await startHidden();else await openWindow('start',startUrl);
}).catch(error=>{logLine(`AHI could not open: ${error.stack||error.message}`);if(headless)process.stderr.write(`AHI Setup server could not start. Check application folder access and that port 4189 is free. Error class: ${error.code||error.name}\n`);else dialog.showErrorBox(t(L(),'dialog.couldNotOpenTitle'),t(L(),'dialog.couldNotOpenBody'));quitting=true;app.quit();});
// Closing the window keeps AHI running, so the last window closing is not a quit.
app.on('window-all-closed',()=>{if(headless)app.quit();});
// A real quit stops the server cleanly first (it removes its own lock), then lets the app exit.
// A start in progress is cancelled and awaited first, so a server it already spawned is stopped too.
app.on('before-quit',event=>{
  quitting=true;
  if(stopped)return;
  event.preventDefault();
  stopping??=(async()=>{
    if(remote?.child)remote.child.kill();
    startAbort?.abort();
    await Promise.resolve(starting).catch(()=>{});
    await service?.stopAhi().catch(()=>{});
    stopped=true;app.quit();
  })();
});
