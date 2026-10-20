// Compile diagnostic-only probes in TEMP; never load the user's library.
const { spawnSync } = require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'prompt-dock-beta2-flow-'));
const fw=path.join(process.env.WINDIR,'Microsoft.NET','Framework64','v4.0.30319');
function compile(source,name,extra=[]){
  const output=path.join(temp,name+'.exe');
  const r=spawnSync(path.join(fw,'csc.exe'),['/nologo','/target:exe','/platform:x64','/out:'+output,'/reference:System.Windows.Forms.dll','/reference:System.Web.Extensions.dll',...extra,path.join(root,source)],{encoding:'utf8',windowsHide:true});
  assert.equal(r.status,0,r.stdout+r.stderr);return output;
}
try{
  const host=compile('tests/SlashTestHost.cs','SlashTestHost');
  const refs=['UIAutomationClient.dll','UIAutomationTypes.dll','WindowsBase.dll'].map(f=>'/reference:'+path.join(fw,'WPF',f));
  const helper=compile('assets/PromptDock.SlashHelper.cs','SlashTestHelper',['/define:SLASH_TEST',...refs]);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const suite=process.argv.includes('--acquisition')?'palette-acquisition-flow.js':'full-slash-flow.js';
  const r=spawnSync(path.join(root,'node_modules','electron','dist','electron.exe'),[path.join(root,'tests',suite),host,helper],{env,stdio:'inherit',timeout:60000});
  assert.equal(r.status,0);
}catch(e){console.error(e);process.exitCode=1;}finally{console.log('Isolated test artifacts: '+temp);}
