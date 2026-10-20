const { spawnSync }=require('node:child_process');
const path=require('node:path');
const root=path.resolve(__dirname,'..'),env={...process.env};
delete env.ELECTRON_RUN_AS_NODE;
const result=spawnSync(require('electron'),[path.join(root,'tests','slash-preview-flow.js')],{cwd:root,env,stdio:'inherit',windowsHide:true,timeout:60000});
if(result.error)throw result.error;
process.exitCode=result.status===0?0:1;
