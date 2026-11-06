const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {atomic}=require('./system.cjs');
async function installCloudflared(service,{platform=process.platform,arch=process.arch}={}){
  const assets={darwin:{x64:'cloudflared-darwin-amd64.tgz',arm64:'cloudflared-darwin-arm64.tgz'},win32:{x64:'cloudflared-windows-amd64.exe'},linux:{x64:'cloudflared-linux-amd64',arm64:'cloudflared-linux-arm64'}};
  const assetName=assets[platform]?.[arch];if(!assetName)throw Error('Cloudflare Tunnel is not packaged for this platform. Use the official installation guide.');
  const dir=await service.directory('tools','cloudflared');
  const response=await service.fetcher('https://api.github.com/repos/cloudflare/cloudflared/releases/latest',{headers:{Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error('Could not find the official Cloudflare release. Try again later.');
  const release=await response.json(),asset=release.assets.find(a=>a.name===assetName);
  if(!asset||!/^sha256:[a-f0-9]{64}$/.test(asset.digest)||!asset.browser_download_url.startsWith('https://github.com/cloudflare/cloudflared/releases/download/'))throw Error('This release has no verifiable download checksum. Install cloudflared using the official guide.');
  const download=await service.fetcher(asset.browser_download_url,{signal:AbortSignal.timeout(120000)});if(!download.ok)throw Error('Cloudflare Tunnel could not download.');
  const bytes=Buffer.from(await download.arrayBuffer());
  if('sha256:'+crypto.createHash('sha256').update(bytes).digest('hex')!==asset.digest)throw Error('The Cloudflare download checksum did not match. Nothing was installed.');
  const target=path.join(dir,platform==='win32'?'cloudflared.exe':'cloudflared');
  if(platform==='darwin'){
    const archive=path.join(dir,assetName);await fs.writeFile(archive,bytes,{mode:0o600});
    const extracted=await service.runner('/usr/bin/tar',['-xzf',archive,'-C',dir,'cloudflared'],{home:dir});if(extracted.code!==0)throw Error('Cloudflare Tunnel could not be unpacked.');
  }else await fs.writeFile(target,bytes,{mode:0o700});
  await fs.chmod(target,0o700);await atomic(path.join(dir,'release.json'),{version:release.tag_name,digest:asset.digest,asset:assetName});
  return {message:'Cloudflare Tunnel installed and checksum verified.'};
}
module.exports={installCloudflared};
