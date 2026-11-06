const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {providers,voices,connections}=require('./catalog.cjs');
const {atomic,exists,realDirectory,run,terminal}=require('./system.cjs');
const runtime=require('./ahi-runtime.cjs');
const STEPS=['space','folder','models','brain','voice','remote','connections','ready'];
// The installed AHI runtime runs its agents on Claude only (src/claude-invoke.ts), so setup requires Claude and makes it
// the default brain. Other providers can still be connected and are kept for when the runtime can route to them.
const BRAIN='claude';
const NEED_CLAUDE='AHI’s agents think with Claude today. Connect Claude to continue.';
class SetupService {
  // ahi = { serverDir, seed, port }: the bundled AHI server and the hidden OS folder's seed (absent = setup handoff only).
  constructor({dataDir,chooseFolder,openExternal,node=process.execPath,npmCli,runner=run,launchTerminal=terminal,keyring,fetcher=fetch,sandboxRoot,ahi}={}){
    Object.assign(this,{dataDir,chooseFolder,openExternal,node,npmCli,runner,launchTerminal,keyring,fetcher,sandboxRoot,ahi});
    this.busy=new Set();
  }
  async init(){
    await fs.mkdir(this.dataDir,{recursive:true,mode:0o700});
    this.file=path.join(this.dataDir,'setup.json');
    if(await exists(this.file)){this.state=JSON.parse(await fs.readFile(this.file,'utf8'));if(this.state.version!==1)throw Error('This setup was saved by a different version. Keep your data and update AHI Setup.');}
    else this.state={version:1,id:crypto.randomUUID(),step:'space',owner:'',workspace:'My AHI',root:null,selected:[],providers:{},brain:null,voice:{},remote:{stage:'later'},connections:[],completed:false};
    return this.snapshot();
  }
  snapshot(){return structuredClone({...this.state,catalog:{providers,voices},platform:process.platform,ahiReady:!!this.ahi,ahiUrl:this.ahiUrl||null,...(this.freshToken?{token:this.freshToken}:{})});}
  async save(){const record=structuredClone(this.state);this.saveChain=(this.saveChain||Promise.resolve()).catch(()=>{}).then(()=>atomic(this.file,record));await this.saveChain;return this.snapshot();}
  async exclusive(key,fn){if(this.busy.has(key))throw Error('This operation is already running. Please wait.');this.busy.add(key);try{return await fn();}finally{this.busy.delete(key);}}
  async root(){if(!this.state.root)throw Error('Choose and prepare your AHI folder first.');const root=await realDirectory(this.state.root);const marker=JSON.parse(await fs.readFile(path.join(root,'AHI_OS','setup-owner.json'),'utf8'));if(marker.id!==this.state.id)throw Error('This AHI home belongs to a different setup.');return root;}
  async managed(){return realDirectory(path.join(await this.root(),'AHI_OS'));}
  async directory(...parts){let current=await this.managed();for(const part of parts){current=path.join(current,part);try{await fs.mkdir(current,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}await realDirectory(current);}return current;}
  async providerHome(id){if(!providers[id])throw Error('Choose a supported model provider.');return this.directory('providers',id);}
  async cli(id){
    const p=providers[id],home=await this.providerHome(id),tools=path.join(await this.managed(),'tools');
    const pkg=path.join(tools,'node_modules',...p.package.split('/'),'package.json');
    if(await exists(pkg)){const info=JSON.parse(await fs.readFile(pkg,'utf8'));const bin=typeof info.bin==='string'?info.bin:info.bin[p.bin],target=path.resolve(path.dirname(pkg),bin),env={PATH:path.dirname(this.node)+path.delimiter+(process.env.PATH||'')};return /\.[cm]?js$/i.test(target)?{command:this.node,args:[target],home,env}:{command:target,args:[],home,env};}
    return {command:p.bin,args:[],home,env:{}};
  }
  async checkTool(id){const c=await this.cli(id);const r=await this.runner(c.command,[...c.args,'--version'],{home:c.home,env:c.env});return {installed:r.code===0,message:r.code===0?'Official CLI is available.':'Install the official CLI to continue.'};}
  async installTool(id){return this.exclusive('install',async()=>{
    if(!providers[id])throw Error('Unsupported provider.');
    const tools=await this.directory('tools');
    const manifest=path.join(tools,'package.json');
    const policy=await exists(manifest)?JSON.parse(await fs.readFile(manifest,'utf8')):{name:'ahi-private-provider-tools',private:true};
    // npm 12 requires explicit script policy. Allow only the known official CLI and native dependencies.
    policy.allowScripts={...policy.allowScripts,'@anthropic-ai/claude-code':true,'@openai/codex':true,'@google/gemini-cli':true,'node-pty':true,'@lydell/node-pty':true,'@lvce-editor/verror':true};
    await atomic(manifest,policy);
    const npm=this.npmCli||path.join(path.dirname(require.resolve('npm/package.json')),'bin','npm-cli.js').replace('app.asar/','app.asar.unpacked/');
    const result=await this.runner(this.node,[npm,'install','--prefix',tools,'--registry=https://registry.npmjs.org','--no-audit','--no-fund',providers[id].package],{home:await this.providerHome(id),cwd:tools,env:{PATH:path.dirname(this.node)+path.delimiter+(process.env.PATH||''),npm_config_cache:path.join(tools,'.cache')},timeout:300000});
    if(result.code!==0)throw Error('The official CLI could not be installed. Check your internet connection and retry.');
    const check=await this.checkTool(id);if(!check.installed)throw Error('The CLI downloaded but could not start on this computer. Check the official guide for supported systems.');return check;
  });}
  async login(id){if(!(await this.checkTool(id)).installed)throw Error('Install this provider’s CLI first.');const c=await this.cli(id);return this.launchTerminal(c.command,[...c.args,...providers[id].login],c.home,{extraEnv:c.env});}
  async verifyProvider(id){return this.exclusive('provider',async()=>{
    const c=await this.cli(id),p=providers[id];let valid=false;
    if(p.status){const status=await this.runner(c.command,[...c.args,...p.status],{home:c.home,env:c.env});valid=status.code===0;if(id==='claude'&&valid){try{valid=JSON.parse(status.out).loggedIn===true;}catch{valid=false;}}}
    else valid=true; // Gemini has no auth-status command: only a successful model probe can connect it.
    if(!valid){this.state.providers[id]={status:'disconnected'};if(this.state.brain===id)this.state.brain=null;await this.save();throw Error('Not signed in yet. Finish the official browser sign-in, then try again.');}
    const prompt='Reply with only AHI_READY. Do not use any tools, read files, or take actions.';
    const args=id==='claude'?['-p',prompt,'--tools','']:id==='codex'?['exec','--skip-git-repo-check','--sandbox','read-only',prompt]:['-p',prompt,'--output-format','json'];
    const probe=await this.runner(c.command,[...c.args,...args],{home:c.home,env:c.env,timeout:90000});
    valid=probe.code===0&&probe.out.includes('AHI_READY');
    this.state.providers[id]={status:valid?'verified':'unavailable',checkedAt:new Date().toISOString()};
    if(valid&&!this.state.brain&&id===BRAIN)this.state.brain=id;
    if(!valid&&this.state.brain===id)this.state.brain=null;
    await this.save();
    if(!valid)throw Error('Signed-in status alone was not enough: the small model check failed. Check your account’s access, quota, and connection, then retry.');
    return this.snapshot();
  });}
  async prepareFolder(){return this.exclusive('folder',async()=>{
    if(this.state.folderReady){await this.root();return this.snapshot();}
    const chosen=this.state.root||await this.chooseFolder();if(!chosen)return this.snapshot();
    const parent=await realDirectory(chosen);
    const root=path.basename(parent).toLowerCase()==='ahi'?parent:path.join(parent,'AHI');
    if(this.sandboxRoot&&!root.startsWith(path.resolve(this.sandboxRoot)+path.sep))throw Error('The preview can only prepare its own sandbox folder.');
    if(await exists(root)){
      await realDirectory(root);
      const items=await fs.readdir(root);
      if(items.length){const claim=path.join(root,'.ahi-setup-claim');if(!this.state.root||!await exists(claim)||(await fs.readFile(claim,'utf8'))!==this.state.id)throw Error('There is already data in this AHI folder. Choose an empty location. Existing installations need a separate migration.');}
    }
    const disk=await fs.statfs(parent);if(Number(disk.bavail)*Number(disk.bsize)<1024**3)throw Error('Please free at least 1 GB before setting up AHI.');
    await fs.mkdir(root,{recursive:true,mode:0o700});
    const marker=path.join(root,'.ahi-setup-claim');if(!await exists(marker))await fs.writeFile(marker,this.state.id,{flag:'wx',mode:0o600});
    this.state.root=root;await this.save();
    // Do not follow pre-existing children or adopt another installation.
    for(const name of ['Personal','Work','AHI_OS']){const child=path.join(root,name);if(await exists(child))await realDirectory(child);else await fs.mkdir(child,{mode:0o700});}
    await atomic(path.join(root,'AHI_OS','setup-owner.json'),{id:this.state.id,version:1});
    this.state.folderReady=true;return this.save();
  });}
  async saveVoice({id,key,allowEnv=false}){return this.exclusive('voice',async()=>{
    const voice=voices[id];if(!voice)throw Error('Choose a supported voice service.');
    if(typeof key!=='string'||key.length<12||key.length>4096||/[\r\n\0]/.test(key))throw Error('Paste a valid API key.');
    let response;
    try{response=await this.fetcher(voice.endpoint,{headers:{[voice.header]:voice.prefix+key,...(id==='cartesia'?{'Cartesia-Version':'2025-04-16'}:{})},signal:AbortSignal.timeout(15000),redirect:'error'});}catch{throw Error('Could not reach the voice provider. Your key was not saved.');}
    if(!response.ok)throw Error(response.status===401||response.status===403?'The provider did not accept this key. Check permissions and try again.':'The provider could not verify access. Check quota and try again.');
    // Availability is separate from capability. The installed voice runtime selects and tests an actual voice.
    let storage='keychain',reference=`${this.state.id}:${id}`;
    try{if(!this.keyring)throw Error();await this.keyring.set(reference,key);}catch{
      if(!allowEnv)throw Error('The system keychain is unavailable. Unlock it and retry, or explicitly choose the private environment file fallback.');
      storage='env';const directory=await this.directory('credentials');
      if(process.platform==='win32'){const acl=await this.runner('icacls.exe',[directory,'/inheritance:r','/grant:r',`${os.userInfo().username}:(OI)(CI)F`],{home:directory});if(acl.code!==0)throw Error('Windows could not restrict the fallback folder. Unlock Credential Manager and try again.');}else await fs.chmod(directory,0o700);
      reference=path.join(directory,`${id}.env`);
      await atomic(reference,`${voice.env}=${JSON.stringify(key)}\n`);
    }
    this.state.voice[id]={storage,reference,...(storage==='keychain'?{service:'org.ahi.setup'}:{}),status:'key-verified',checkedAt:new Date().toISOString()};return this.save();
  });}
  async navigate(step){
    if(!STEPS.includes(step))throw Error('Unknown setup step.');
    const i=STEPS.indexOf(step);
    if(i>0&&(!this.state.owner.trim()||!this.state.workspace.trim()))throw Error('Tell us your name and name your space first.');
    if(i>1)await this.root();
    if(i>2&&this.state.providers[BRAIN]?.status!=='verified')throw Error(NEED_CLAUDE);
    if(i>3)this.state.brain=BRAIN; // Claude is verified (checked just above) and the only brain the runtime can run
    this.state.step=step;return this.save();
  }
  async patch(values){
    for(const key of Object.keys(values))if(!['owner','workspace','selected','brain','connections'].includes(key))throw Error('Unsupported setup field.');
    if(values.owner!==undefined){if(typeof values.owner!=='string'||values.owner.length>100)throw Error('Use a name under 100 characters.');this.state.owner=values.owner;}
    if(values.workspace!==undefined){if(typeof values.workspace!=='string'||values.workspace.length>100)throw Error('Use a workspace name under 100 characters.');this.state.workspace=values.workspace;}
    if(values.selected!==undefined){if(!Array.isArray(values.selected)||values.selected.some(id=>!providers[id]))throw Error('Unsupported provider.');this.state.selected=[...new Set(values.selected)];}
    if(values.brain!==undefined){if(values.brain!==BRAIN)throw Error(NEED_CLAUDE);if(this.state.providers[values.brain]?.status!=='verified')throw Error('Choose a verified model.');this.state.brain=values.brain;}
    if(values.connections!==undefined){if(!Array.isArray(values.connections)||values.connections.some(id=>!connections.includes(id)))throw Error('Unsupported connection.');this.state.connections=[...new Set(values.connections)];}
    this.state.completed=false;return this.save();
  }
  async complete(){return this.exclusive('complete',async()=>{
    await this.navigate('ready');
    await this.verifyProvider(this.state.brain);
    const config={schemaVersion:1,setupId:this.state.id,owner:this.state.owner,workspace:this.state.workspace,root:this.state.root,defaultBrain:this.state.brain,providers:this.state.providers,providerHomes:Object.fromEntries(await Promise.all(Object.keys(this.state.providers).map(async id=>[id,await this.providerHome(id)]))),voice:this.state.voice,remote:this.state.remote,pendingConnections:this.state.connections,agentHandoff:{status:'pending-runtime',brief:'Finish optional connections with the owner; keep Personal and Work separate and use the existing AHI memory system.'}};
    await atomic(path.join(await this.managed(),'setup-handoff.json'),config);
    if(this.ahi){const made=await runtime.install({managed:await this.managed(),seed:this.ahi.seed,owner:this.state.owner});if(made.token)this.freshToken=made.token;}
    this.state.completed=true;return this.save();
  });}
  /**
   * The voice settings the AHI server needs, from the keys this setup verified: each key read back from the
   * keychain (or its private fallback file) and handed only to the server process, never logged or saved here.
   * Speaking voice: OpenAI, then Cartesia, ElevenLabs, Gemini. Transcription (needed to hear you): Cartesia, then OpenAI.
   */
  async voiceEnv(){
    const env={};
    for(const [id,v] of Object.entries(this.state.voice||{})){
      const spec=voices[id];if(!spec||v.status!=='key-verified')continue;
      let key=null;
      try{
        if(v.storage==='keychain'&&this.keyring?.get)key=await this.keyring.get(v.reference);
        else if(v.storage==='env'){const line=(await fs.readFile(v.reference,'utf8')).split('\n').find(l=>l.startsWith(spec.env+'='));if(line)key=JSON.parse(line.slice(spec.env.length+1));}
      }catch{key=null;}
      if(typeof key==='string'&&key)env[spec.env]=key;
    }
    const tts=['openai','cartesia','elevenlabs','gemini'].find(id=>env[voices[id].env]);
    const stt=['cartesia','openai'].find(id=>env[voices[id].env]);
    if(tts)for(const agent of runtime.AGENTS)env[`${agent.toUpperCase()}_TTS_PROVIDER`]=tts;
    if(stt)env.VOICE_STT_PROVIDER=stt;
    if(tts&&stt)env.VOICE_MODE_ENABLED='true';
    return env;
  }
  /** Stop the AHI server this Setup started, if it is still running; resolves once it has exited. */
  async stopAhi(){
    const child=this.ahiChild;this.ahiChild=null;
    if(!child||child.exitCode!==null||child.signalCode!==null)return;
    await new Promise(done=>{child.once('exit',done);child.kill();});
  }
  /** Start the bundled AHI server with the brain's own sign-in (Claude's provider home), then open it in the browser. */
  async openAhi(){const url=await this.ensureAhi();await this.openExternal(url);return this.snapshot();}
  /** Start the bundled AHI server (or adopt the one already running for this home); resolves to its local URL. */
  async ensureAhi(){return this.exclusive('open',async()=>{
    if(!this.ahi)throw Error('This copy of AHI Setup does not include AHI itself. Download the full AHI Setup.');
    if(!this.state.completed)throw Error('Finish setup first.');
    const managed=await this.managed(),root=await this.root();
    if(this.state.providers[BRAIN]?.status!=='verified')throw Error(NEED_CLAUDE);
    // An npm install whose entry point is JavaScript is handed over as that file; the server runs it with its own Node.
    const c=await this.cli(BRAIN);
    const claude={home:c.home,bin:c.args[0]||c.command,binDir:path.dirname(this.node)};
    // Once remote access is set up, AHI's links and sign-in pages use the remote address instead of localhost.
    const r=this.state.remote||{};
    const appUrl=r.hostname&&['configured','running','stopped'].includes(r.stage)?`https://${r.hostname}`:null;
    if(this.ahiChild&&(this.ahiAppUrl??null)!==appUrl)await this.stopAhi();
    const s=await runtime.start({node:this.node,serverDir:this.ahi.serverDir,managed,root,port:this.ahi.port,claude,extra:{...await this.voiceEnv(),...(appUrl?{AHI_APP_URL:appUrl}:{})}});
    if(s.child){this.ahiChild=s.child;this.ahiAppUrl=appUrl;}this.ahiUrl=s.url;
    return s.url;
  });}
  async invoke(method,arg){
    switch(method){
      case 'load':return this.snapshot();case 'patch':return this.patch(arg);case 'navigate':return this.navigate(arg);case 'folder':return this.prepareFolder();case 'install':return this.installTool(arg);case 'tool':return this.checkTool(arg);case 'login':return this.login(arg);case 'verify':return this.verifyProvider(arg);case 'voice':return this.saveVoice(arg);case 'complete':return this.complete();case 'open-ahi':return this.openAhi();case 'token-saved':this.freshToken=null;return this.snapshot();
      case 'external':{const allowed=[...Object.values(providers).map(p=>p.guide),...Object.values(voices).map(v=>v.guide),'https://dash.cloudflare.com/sign-up','https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/'];if(!allowed.includes(arg))throw Error('Unknown external guide.');await this.openExternal(arg);return {};}
      default:throw Error('Unknown setup action.');
    }
  }
}
module.exports={SetupService,STEPS};
