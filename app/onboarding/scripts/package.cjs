// Keep build-tool caches and temporary files in this checkout; never publish from this command.
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),cache=path.join(root,'.cache'),tmp=path.join(root,'.tmp');
fs.mkdirSync(cache,{recursive:true});fs.mkdirSync(tmp,{recursive:true});
const args=process.argv.slice(2);if(args.some(v=>v==='--publish'||v.startsWith('--publish=')))throw Error('Publishing is disabled in the setup build wrapper.');
// The installer carries ONLY the public skills (listed in skills/MANIFEST.json and marked private: false).
const {stagePublicSkills}=require('../src/public-skills.cjs');
console.log(`staged ${stagePublicSkills(path.resolve(root,'../../skills'),path.join(root,'staged','skills'))} public skills for the installer`);
const cli=require.resolve('electron-builder/cli.js');
const result=spawnSync(process.execPath,[cli,...args,'--publish','never',`--config.electronDownload.cache=${path.join(cache,'electron')}`],{cwd:root,env:{...process.env,electron_config_cache:path.join(cache,'electron'),ELECTRON_BUILDER_CACHE:path.join(cache,'builder'),XDG_CACHE_HOME:cache,TMPDIR:tmp,TEMP:tmp,TMP:tmp},stdio:'inherit'});
process.exitCode=result.status??1;
