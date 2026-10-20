const path=require('node:path');
const {spawnSync}=require('node:child_process');
if(process.platform!=='win32')throw new Error('Build the focus helper on Windows.');
const root=path.resolve(__dirname,'..');
const compiler=path.join(process.env.WINDIR||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
const result=spawnSync(compiler,['/nologo','/target:exe','/platform:x64','/optimize+','/out:'+path.join(root,'assets','PromptDock.FocusGrant.exe'),path.join(root,'assets','PromptDock.FocusGrant.cs')],{stdio:'inherit',windowsHide:true});
if(result.error)throw result.error;
process.exitCode=result.status||0;
