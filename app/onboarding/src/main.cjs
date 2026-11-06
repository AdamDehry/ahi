const {app,BrowserWindow,ipcMain,dialog,shell}=require('electron');
const path=require('node:path');
const {SetupService}=require('./service.cjs');
const {RemoteSetup}=require('./remote.cjs');
let win,service,remote;
const headless=app.commandLine.hasSwitch('headless-setup')||process.argv.includes('--headless-setup');
if(headless){app.commandLine.appendSwitch('ozone-platform','headless');app.disableHardwareAcceleration();}
// Native smoke tests can opt into a workdir-owned home; packaged apps never use fixtures.
const sandbox=!app.isPackaged&&process.env.AHI_SETUP_TEST_ROOT;
if(sandbox)app.setPath('userData',path.join(sandbox,'desktop-data'));
app.whenReady().then(async()=>{
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
  service=new SetupService({dataDir,node:runtimeNode,npmCli:app.isPackaged?path.join(process.resourcesPath,'app.asar.unpacked/node_modules/npm/bin/npm-cli.js'):undefined,keyring,sandboxRoot:sandbox,
    chooseFolder:async()=>{const picked=await dialog.showOpenDialog(win,{title:'Choose where AHI will live',properties:['openDirectory','createDirectory']});return picked.canceled?null:picked.filePaths[0];},
    openExternal:url=>shell.openExternal(url),
    // The bundled AHI server and the hidden OS folder's seed: packaged resources, or this repo while developing.
    ahi:{serverDir:app.isPackaged?path.join(process.resourcesPath,'ahi-server'):path.resolve(__dirname,'../..'),seed:app.isPackaged?path.join(process.resourcesPath,'ahi-seed'):path.resolve(__dirname,'../../..'),port:Number(process.env.AHI_PORT)||18789}});
  await service.init();remote=new RemoteSetup(service);
  // Already set up: start AHI and open it straight away (the window stays as AHI's home base).
  if(service.state.completed&&!headless)service.openAhi().catch(()=>{});
  const ui=path.join(__dirname,'../ui/index.html');
  ipcMain.handle('setup:invoke',async(event,method,arg)=>{
    if(event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||event.senderFrame.url!==require('node:url').pathToFileURL(ui).href)throw Error('Untrusted setup window.');
    try{
      const result=method==='remote-install'?await remote.install():method==='remote-login'?await remote.login():method==='remote-create'?await remote.create():method==='remote-route'?await remote.route(arg):method==='remote-start'?await remote.start():method==='remote-stop'?await remote.stop():await service.invoke(method,arg);
      return {ok:true,value:result};
    }catch(error){return {ok:false,error:error.message};}
  });
  win=new BrowserWindow({width:1240,height:900,minWidth:820,minHeight:680,backgroundColor:'#0c1917',title:'AHI · Make yourself at home',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',event=>event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
  await win.loadFile(ui);
}).catch(error=>{if(headless)process.stderr.write(`AHI Setup server could not start. Check application folder access and that port 4189 is free. Error class: ${error.code||error.name}\n`);else dialog.showErrorBox('AHI Setup could not open','Your saved setup has been kept. Check folder access, then reopen the app.');app.quit();});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',()=>{if(remote?.child)remote.child.kill();if(service?.ahiChild)service.ahiChild.kill();});
