const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');

function cleanEnv(home, source=process.env) {
  // Positive allowlist: never inherit the gateway's provider keys or agent context.
  const env={};
  for (const key of ['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS','LANG','LC_ALL','TERM']) if(source[key]) env[key]=source[key];
  return {...env, HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_CACHE_HOME:path.join(home,'.cache'),APPDATA:path.join(home,'AppData','Roaming'),LOCALAPPDATA:path.join(home,'AppData','Local'),CODEX_HOME:path.join(home,'.codex'),CLAUDE_CONFIG_DIR:path.join(home,'.claude'),GEMINI_CLI_HOME:home,CI:'1',NO_COLOR:'1'};
}
async function atomic(file, value) {
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const temp=`${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp,typeof value==='string'?value:JSON.stringify(value,null,2),{mode:0o600,flag:'wx'});
  await fs.rename(temp,file);
}
async function exists(file) {try {await fs.lstat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function realDirectory(file) {
  const st=await fs.lstat(file);
  if(!st.isDirectory()||st.isSymbolicLink())throw Error('Choose a regular folder, rather than a link or file.');
  return fs.realpath(file);
}
function run(command,args,{home,cwd=home,timeout=30000,env={},limit=131072}={}) {
  return new Promise(resolve=>{
    const child=spawn(command,args,{cwd,env:{...cleanEnv(home),...env},shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let out='',err='',settled=false;
    const timer=setTimeout(()=>{child.kill();finish({code:-1,out:'',err:'Operation timed out.'});},timeout);
    function finish(result){if(settled)return;settled=true;clearTimeout(timer);resolve(result);}
    child.stdout.on('data',b=>{out=(out+b).slice(-limit);});
    child.stderr.on('data',b=>{err=(err+b).slice(-limit);});
    child.once('error',e=>finish({code:-1,out:'',err:e.code==='ENOENT'?'Tool is not installed.':'Tool could not start.'}));
    child.once('close',code=>finish({code,out,err}));
  });
}
function quoteSh(s){return "'"+s.replaceAll("'","'\\''")+"'";}
function quotePs(s){return "'"+s.replaceAll("'","''")+"'";}
async function terminal(command,args,home,{platform=process.platform,launch=spawn,extraEnv={},scriptOnly=false}={}) {
  const env={...cleanEnv(home),...extraEnv};
  delete env.CI;
  const id=crypto.randomUUID();
  const folder=path.join(home,'launch');await fs.mkdir(folder,{recursive:true,mode:0o700});
  let script;
  if(platform==='win32') {
    script=path.join(folder,`${id}.ps1`);
    const content=Object.entries(env).map(([k,v])=>`$env:${k} = ${quotePs(v)}`).join('\r\n')+`\r\nSet-Location -LiteralPath ${quotePs(home)}\r\n& ${quotePs(command)} ${args.map(quotePs).join(' ')}\r\nRead-Host 'Return to AHI and click Check connection'`;
    await atomic(script,content);
    await new Promise((resolve,reject)=>{const p=launch('powershell.exe',['-NoExit','-NoProfile','-ExecutionPolicy','Bypass','-File',script],{shell:false,env,detached:true,stdio:'ignore',windowsHide:false});p.once('error',()=>reject(Error('PowerShell could not open. Please check your Windows installation.')));p.once('spawn',()=>{p.unref();resolve();});});
  }else{
    script=path.join(folder,`${id}.command`);
    const assignments=Object.entries(env).map(([k,v])=>`${k}=${quoteSh(v)}`).join(' ');
    await atomic(script,`#!/bin/sh\ncd ${quoteSh(home)} || exit 1\nenv -i ${assignments} ${quoteSh(command)} ${args.map(quoteSh).join(' ')}\nprintf '\\nReturn to AHI and click Check connection.\\n'\nread answer\n`);
    await fs.chmod(script,0o700);
    if(scriptOnly)return {message:`In your SSH terminal, run: sh ${quoteSh(script)}. Finish the provider’s sign-in there, then check the connection here.`};
    const tool=platform==='darwin'?'open':'x-terminal-emulator';
    const argv=platform==='darwin'?['-a','Terminal',script]:['-e',script];
    await new Promise((resolve,reject)=>{const p=launch(tool,argv,{env,detached:true,stdio:'ignore'});p.once('error',()=>reject(Error('A system terminal is required. Install a terminal and try again.')));p.once('spawn',()=>{p.unref();resolve();});});
  }
  return {message:'Your provider’s official CLI is open in a system terminal. Finish its browser sign-in, then check the connection here.'};
}
module.exports={cleanEnv,atomic,exists,realDirectory,run,terminal,quoteSh,quotePs};
