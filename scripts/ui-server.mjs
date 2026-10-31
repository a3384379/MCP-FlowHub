// Test-only server entry. Production `flowhub serve` never supplies a discovery
// runtime and continues to execute only the configured absolute executable.
// The real daemon, Application, APIs, SQLite and built web UI are all preserved.
import {mkdir,realpath,writeFile} from 'node:fs/promises';
import {realpathSync,statSync} from 'node:fs';
import {isAbsolute,join,relative} from 'node:path';
import {startDaemon} from '../dist/apps/daemon/src/index.js';
const requested=process.env.FLOWHUB_UI_DATA_DIR;
if(!requested||!isAbsolute(requested))throw new Error('An isolated absolute FLOWHUB_UI_DATA_DIR is required.');
await mkdir(requested,{recursive:true});
const dataDir=await realpath(requested),inside=path=>{const child=relative(dataDir,path);return child!==''&&!child.startsWith('..')&&!isAbsolute(child);};
const home=process.env.CODEX_HOME;
if(!home||!inside(await realpath(home)))throw new Error('Playwright must provide an isolated Codex home inside its UI data directory.');
await writeFile(join(home,'config.toml'),'');
const hostDiscoveryRuntime={command(context,args){
  const fixture=realpathSync(context.codexPath);
  if(!inside(fixture)||!fixture.endsWith('.mjs')||!statSync(fixture).isFile())throw new Error('Only trusted JavaScript fixtures inside FLOWHUB_UI_DATA_DIR may run in UI tests.');
  return {executable:process.execPath,args:[fixture,...args]};
}};
const daemon=await startDaemon({dataDir,port:18479,hostDiscoveryRuntime});
let stopping=false;
const stop=async()=>{if(stopping)return;stopping=true;await daemon.close();};
process.once('SIGINT',()=>{void stop().catch(error=>{console.error(error);process.exitCode=1;});});
process.once('SIGTERM',()=>{void stop().catch(error=>{console.error(error);process.exitCode=1;});});
