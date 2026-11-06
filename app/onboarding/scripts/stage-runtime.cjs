// Bundle a real Node executable so provider installs do not require Node on the owner's computer.
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
async function main(){
 const platform=process.argv[2]||process.platform,arch=process.argv[3]||process.arch;
 const osName={darwin:'mac',linux:'linux',win32:'win'}[platform];if(!osName||!['x64','arm64'].includes(arch))throw Error('Unsupported runtime target.');
 const version='22.22.2',nodePlatform={darwin:'darwin',linux:'linux',win32:'win'}[platform];
 const name=`node-v${version}-${nodePlatform}-${arch}`,archive=`${name}.${platform==='win32'?'zip':'tar.gz'}`;
 const base=`https://nodejs.org/dist/v${version}/`;
 const output=path.resolve(__dirname,`../runtime/${osName}/${arch}`),scratch=path.resolve(__dirname,`../.cache/node-${osName}-${arch}`);
 await fs.mkdir(output,{recursive:true});await fs.mkdir(scratch,{recursive:true});
 const sumRes=await fetch(base+'SHASUMS256.txt');if(!sumRes.ok)throw Error('Node checksum could not be downloaded.');
 const sum=(await sumRes.text()).split('\n').find(line=>line.trim().endsWith(' '+archive))?.split(/\s+/)[0];if(!sum)throw Error('No official checksum for this runtime.');
 const response=await fetch(base+archive);if(!response.ok)throw Error('Node runtime could not be downloaded.');const bytes=Buffer.from(await response.arrayBuffer());
 if(crypto.createHash('sha256').update(bytes).digest('hex')!==sum)throw Error('Node runtime checksum mismatch.');
 const target=path.join(scratch,archive);await fs.writeFile(target,bytes);
 const command=platform==='win32'?'tar.exe':'tar';const result=spawnSync(command,['-xf',target,'-C',scratch],{stdio:'pipe'});if(result.status!==0)throw Error('Node runtime could not be extracted.');
 const binary=platform==='win32'?'node.exe':'node';await fs.copyFile(path.join(scratch,name,platform==='win32'?'node.exe':'bin/node'),path.join(output,binary));await fs.chmod(path.join(output,binary),0o755);
 await fs.copyFile(path.join(scratch,name,'LICENSE'),path.join(output,'NODE-LICENSE.txt'));
 await fs.writeFile(path.join(output,'provenance.json'),JSON.stringify({version,platform,arch,archive,sha256:sum,source:base+archive},null,2));
 console.log(`Bundled verified Node ${version} for ${osName} ${arch}.`);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
