const path=require('node:path');
const os=require('node:os');
const {startHeadless}=require('./headless.cjs');
const dataDir=process.argv[2]||path.join(os.homedir(),'.config','ahi-setup');
const keyring={set:async(account,value)=>{
  const keyringPath=process.env.AHI_SETUP_NATIVE_BINDING||path.resolve(__dirname,'../../app.asar.unpacked/node_modules/@napi-rs/keyring');
  const {AsyncEntry}=require(keyringPath);const entry=new AsyncEntry('org.ahi.setup',account,{linux:{store:'secret-service'}});await entry.setPassword(value);
},get:async(account)=>{
  const keyringPath=process.env.AHI_SETUP_NATIVE_BINDING||path.resolve(__dirname,'../../app.asar.unpacked/node_modules/@napi-rs/keyring');
  const {AsyncEntry}=require(keyringPath);return new AsyncEntry('org.ahi.setup',account,{linux:{store:'secret-service'}}).getPassword();
}};
const packagedNpm=path.resolve(__dirname,'../../app.asar.unpacked/node_modules/npm/bin/npm-cli.js');
// The bundled AHI server and seed: packaged resources (this file sits in resources/setup-server/src), or this repo.
const resources=path.resolve(__dirname,'../..'),packaged=require('node:fs').existsSync(path.join(resources,'ahi-server','dist','index.js'));
const ahi={serverDir:packaged?path.join(resources,'ahi-server'):resources,seed:packaged?path.join(resources,'ahi-seed'):path.resolve(__dirname,'../../..'),port:Number(process.env.AHI_PORT)||18789};
startHeadless({dataDir,node:process.execPath,npmCli:require('node:fs').existsSync(packagedNpm)?packagedNpm:undefined,keyring,parentDefault:os.homedir(),ahi}).then(({stop})=>{const quit=()=>stop().finally(()=>process.exit(0));process.once('SIGTERM',quit);process.once('SIGINT',quit);}).catch(error=>{process.stderr.write(`AHI Setup server could not start. Error class: ${error.code||error.name}\n`);process.exitCode=1;});
