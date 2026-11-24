const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {atomic,cleanEnv,exists}=require('./system.cjs');
const {installCloudflared}=require('./cloudflared.cjs');
const {homeId}=require('./ahi-runtime.cjs');
const {t}=require('../ui/i18n.js');
function hostname(value,lang='en'){
  if(typeof value!=='string'||value.length>253||!value.split('.').every(p=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(p))||value.split('.').length<3||!/[a-z]{2,}$/i.test(value))throw Error(t(lang,'err.hostname'));
  return value.toLowerCase();
}
class RemoteSetup {
  constructor(service){this.s=service;this.child=null;}
  /**
   * Nothing is routed to the internet until the port answers as THIS home's AHI server (its /health `home` id) and that
   * server refuses an unsigned request (/ui/session → 401). When the port is the bundled server's, Setup starts it first,
   * which it can only do once setup is finished.
   */
  async assertReady(port){
    const origin=`http://127.0.0.1:${port}`;
    if(this.s.ahi&&port===this.s.ahi.port){
      if(!this.s.state.completed)throw Error(t(this.s.language,'err.remoteFinishFirst'));
      await this.s.ensureAhi();
    }
    const opts={signal:AbortSignal.timeout(3000),redirect:'error'};
    try{
      const health=await this.s.fetcher(`${origin}/health`,opts);const body=await health.json();
      const session=await this.s.fetcher(`${origin}/ui/session`,opts);
      if(!health.ok||body?.home!==homeId(await this.s.managed())||session.status!==401)throw Error();
    }catch{throw Error(t(this.s.language,'err.remoteNotReady'));}
    return origin;
  }
  async executable(){const file=path.join(await this.s.managed(),'tools','cloudflared',process.platform==='win32'?'cloudflared.exe':'cloudflared');return await exists(file)?file:'cloudflared';}
  async install(){return this.s.exclusive('remote-install',()=>installCloudflared(this.s));}
  async context(){const home=await this.s.directory('cloudflare');return {home,cert:path.join(home,'.cloudflared','cert.pem')};}
  async login(){const {home}=await this.context();return this.s.launchTerminal(await this.executable(),['tunnel','login'],home,{lang:this.s.language});}
  async create(){return this.s.exclusive('remote',async()=>{
    if(this.s.state.remote.id)return this.s.snapshot();
    const {home,cert}=await this.context();if(!await exists(cert))throw Error(t(this.s.language,'err.cloudflareSignIn'));
    const name=`ahi-${this.s.state.id.slice(0,8)}`;
    const r=await this.s.runner(await this.executable(),['tunnel','--origincert',cert,'create',name],{home,timeout:60000});
    const folder=path.join(home,'.cloudflared');
    const files=(await fs.readdir(folder)).filter(f=>/^[0-9a-f-]{36}\.json$/i.test(f));
    if(r.code!==0||files.length!==1)throw Error(t(this.s.language,'err.tunnelUnconfirmed'));
    const id=files[0].slice(0,-5);await fs.chmod(path.join(folder,files[0]),0o600);
    this.s.state.remote={stage:'created',id,name};return this.s.save();
  });}
  async route(input){return this.s.exclusive('remote',async()=>{
    const host=hostname(input.hostname,this.s.language),port=Number(input.port);
    if(!Number.isInteger(port)||port<1024||port>65535)throw Error(t(this.s.language,'err.port'));
    const remote=this.s.state.remote;if(!remote.id)throw Error(t(this.s.language,'err.createTunnelFirst'));
    const origin=await this.assertReady(port);
    const {home,cert}=await this.context();
    const config=path.join(home,'config.json');
    await atomic(config,{tunnel:remote.id,'credentials-file':path.join(home,'.cloudflared',`${remote.id}.json`),ingress:[{hostname:host,service:origin},{service:'http_status:404'}]});
    remote.stage='routing';remote.hostname=host;remote.port=port;await this.s.save();
    const r=await this.s.runner(await this.executable(),['tunnel','--origincert',cert,'route','dns',remote.id,host],{home,timeout:60000});
    if(r.code!==0){remote.stage='dns-failed';await this.s.save();throw Error(t(this.s.language,'err.dnsFailed'));}
    remote.stage='configured';return this.s.save();
  });}
  async start(){
    if(this.child)throw Error(t(this.s.language,'err.tunnelRunning'));
    const r=this.s.state.remote;if(!['configured','stopped','running'].includes(r.stage))throw Error(t(this.s.language,'err.tunnelNotReady'));
    await this.assertReady(r.port);
    const {home}=await this.context();
    const child=spawn(await this.executable(),['tunnel','--config',path.join(home,'config.json'),'run',r.id],{cwd:home,env:cleanEnv(home),shell:false,stdio:'ignore',windowsHide:true});
    await new Promise((resolve,reject)=>{child.once('error',()=>reject(Error(t(this.s.language,'err.tunnelStart'))));child.once('spawn',resolve);});
    this.child=child;r.stage='running';
    child.once('exit',()=>{this.child=null;r.stage='stopped';this.s.save().catch(()=>{});});
    return this.s.save();
  }
  async stop(){if(this.child)this.child.kill();return this.s.snapshot();}
}
module.exports={RemoteSetup,hostname};
