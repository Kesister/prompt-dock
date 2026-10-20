// Real Electron popup and isolated Windows input form; never uses the personal library.
const { app, clipboard, globalShortcut } = require('electron');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { SlashController } = require('../slash-controller');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'prompt-dock-beta2-keyboard-test-')));
let host,controller,id=0,events=[],used=[],nativeEvents=[],closeEvents=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){for(let i=0;i<160;i++){const r=check();if(r)return r;await sleep(50);}throw Error('Flow timeout: '+JSON.stringify({view:controller?.view,used,nativeEvents:nativeEvents.slice(-12)}));}
async function cmd(type,extra={}){const n=++id;host.stdin.write(JSON.stringify({id:n,type,...extra})+'\n');return until(()=>events.find(e=>e.id===n));}
const js=code=>controller.window.webContents.executeJavaScript(code);
const popupHandle=()=>controller.window.getNativeWindowHandle().readBigUInt64LE().toString();
async function press(keyCode){
  assert.equal(controller.window.isFocused(),true,'Test popup lost focus; stopping');
  const key={Down:40,Up:38,Right:39,Left:37,Tab:9,Return:13,Escape:27}[keyCode];
  assert.equal((await cmd('popupKey',{key,window:popupHandle()})).refused,undefined);await sleep(100);
}
async function query(value){
  await js('(()=>{const e=document.getElementById("search");e.value='+JSON.stringify(value)+';e.setSelectionRange(e.value.length,e.value.length);e.dispatchEvent(new Event("input"));})()');await sleep(120);
}
async function click(selector){
  const point=await js('(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()');
  const wc=controller.window.webContents;
  wc.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
  wc.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});await sleep(100);
}
async function open(text='PREFIX  SUFFIX',caret=7){
  controller.close();const state=await cmd('set',{text,caret});
  assert.equal(state.foreground,true,'Test host not foreground; refusing hotkey');
  await sleep(100);await cmd('hotkey');await until(()=>controller.view&&controller.ready);await sleep(200);
  assert.equal(controller.view.palette,true);assert.equal(controller.window.isFocused(),true);
  assert.equal(await js('document.activeElement.id'),'search');
}
async function usedOnce(expected,text){
  await until(()=>used.length===expected||controller.view?.finished);
  assert.equal(used.length,expected,'Original beta.2 paste result: '+JSON.stringify(controller.view));
  assert.equal((await cmd('read')).text,text);
}
app.whenReady().then(async()=>{
  const [hostPath,helperPath]=process.argv.slice(2);
  host=spawn(hostPath,[String(process.pid)],{windowsHide:true});let buffer='';host.stdout.setEncoding('utf8');
  host.stdout.on('data',c=>{buffer+=c;let i;while((i=buffer.indexOf('\n'))>=0){events.push(JSON.parse(buffer.slice(0,i)));buffer=buffer.slice(i+1);}});
  await until(()=>events.find(e=>e.ready));
  controller=new SlashController({readState:()=>({prompts:[
    {id:'p1',title:'灰色 Prompt',alias:'gray',content:'DEFAULT',favorite:true,variants:[{id:'v1',title:'中文变体',content:'VARIANT'}]},
    {id:'p2',title:'另一个 Prompt',content:'SECOND'}
  ]}),recordUse:(id,variant)=>used.push({id,variant})});
  controller.executable=()=>helperPath;
  const close=controller.close.bind(controller);controller.close=()=>{closeEvents.push({stack:new Error().stack,focused:controller.window?.isFocused(),pending:controller.pending});close();};
  const handle=controller.event.bind(controller);controller.event=e=>{nativeEvents.push(e);handle(e);};
  // A legacy allowlist that excludes the test host must no longer block the hotkey.
  const config={enabled:true,trigger:'//',scope:'include',apps:['NeverAllowedTestHost'],shortcut:'Control+Alt+Shift+F10'};
  const configured=await controller.configure(config);assert.equal(configured.ok,true);await until(()=>nativeEvents.some(e=>e.type==='ready'));await sleep(200);
  await open();assert.equal(controller.view.copyOnly,false);assert.equal(await js('document.querySelectorAll(".item").length'),2);
  await press('Down');assert.equal(await js('document.querySelector(".item.selected b").textContent'),'另一个 Prompt');
  await press('Up');assert.equal(await js('document.querySelector(".item.selected b").textContent'),'灰色 Prompt');
  await press('Right');assert.equal(await js('document.getElementById("query").textContent.includes("选择版本")'),true);
  await press('Left');assert.equal(await js('document.getElementById("query").textContent.includes("选择版本")'),false);
  console.log('PASS: legacy allowlist is ignored; actual global shortcut focuses search; arrows navigate prompts and variants');
  await query('gray');await js('document.getElementById("search").setSelectionRange(1,1)');await press('Right');
  assert.equal(await js('document.getElementById("search").selectionStart'),2);assert.equal(await js('document.getElementById("query").textContent.includes("选择版本")'),false);
  await js('document.getElementById("search").setSelectionRange(4,4)');await press('Right');await press('Left');
  console.log('PASS: text editing retains caret keys; right at end opens variants');
  await js('document.getElementById("search").dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true}))');
  await press('Right');await press('Tab');await press('Escape');assert.ok(controller.view);assert.equal(used.length,0);
  await js('document.getElementById("search").dispatchEvent(new CompositionEvent("compositionend",{bubbles:true}))');await sleep(130);
  console.log('PASS: Chinese composition does not trigger selection, confirmation or dismissal');
  await press('Right');await press('Down');await press('Tab');await usedOnce(1,'PREFIX VARIANT SUFFIX');
  console.log('PASS: global shortcut + keyboard variant + Tab inserts only selected body');
  await controller.configure({...config,confirm:'Enter'});await sleep(150);
  await open();await query('gray');await press('Right');await press('Down');
  assert.equal((await cmd('popupKey',{key:13,phase:'down',window:popupHandle()})).refused,undefined);await sleep(180);
  assert.equal(controller.window.isVisible(),true);assert.equal(used.length,1);
  assert.equal((await cmd('popupKey',{key:13,phase:'up',window:popupHandle()})).refused,undefined);await usedOnce(2,'PREFIX VARIANT SUFFIX');
  console.log('PASS: Enter waits for key release, inserts once and adds no newline');
  await open('KEEP',4);await press('Right');await press('Escape');assert.ok(controller.view);
  assert.equal(await js('document.getElementById("query").textContent.includes("选择版本")'),false);
  await press('Escape');await until(()=>!controller.view);assert.equal((await cmd('read')).text,'KEEP');
  console.log('PASS: beta.2 Esc behavior preserved: return from variants, then close');
  await open('KEEP',4);assert.equal(await js('document.getElementById("search").value'),'');
  await query('not found');await press('Return');assert.equal(used.length,2);assert.equal((await cmd('read')).text,'KEEP');await press('Escape');
  console.log('PASS: reopening resets search; empty results cannot paste');
  for(const symbol of ['/', '//', ';;']){
    // Also test a legacy denylist that explicitly contains this host.
    await controller.configure({...config,trigger:symbol,scope:'exclude',apps:['SlashTestHost']});await sleep(120);
    const before=await cmd('set',{text:'PREFIX ',caret:7});assert.equal(before.foreground,true);
    const from=nativeEvents.length;
    for(const char of symbol){await cmd('key',{key:char==='/'?191:186});await sleep(90);}
    await sleep(220);
    // A Chinese IME may commit full-width punctuation; do not change the user's input method.
    assert.equal((await cmd('read')).text.normalize('NFKC'),'PREFIX '+symbol,'Test keys must type the former trigger, allowing IME punctuation width');
    assert.equal(controller.view,null);assert.equal(controller.window.isVisible(),false);
    assert.ok(!nativeEvents.slice(from).some(e=>e.type==='query'||e.type==='acquisition-start'));
    // Existing symbols + search words must stay literal when using the hotkey.
    const literal='PREFIX '+symbol+'灰色';await open(literal,literal.length);
    assert.equal(controller.view.copyOnly,false);assert.equal(controller.view.query,'');
    await query('gray');await click('.badge');await press('Down');
    const count=used.length+1;await click('.item.selected');await usedOnce(count,literal+'VARIANT');
  }
  console.log('PASS: /, // and ;; never auto-open; legacy denylist is ignored; mouse variant insertion preserves literal symbols and text');
  await controller.configure({...config,confirm:'Enter'});await sleep(120);
  await open('PREFIX  SUFFIX',7);await query('gray');await click('.badge');await press('Down');
  await click('#preview-toggle');assert.equal(await js('document.getElementById("preview").hidden'),true);
  const compactCount=used.length+1;await press('Return');await usedOnce(compactCount,'PREFIX VARIANT SUFFIX');
  console.log('PASS: collapsed preview preserves Enter insertion and target location');
  await controller.configure(config);await sleep(120);
  controller.event({type:'query',session:999,query:'',palette:true,copyOnly:true});await sleep(150);
  assert.equal(await js('document.activeElement.id'),'search');await query('gray');await press('Right');await press('Down');await press('Tab');
  assert.equal(clipboard.readText(),'VARIANT');await press('Escape');await press('Escape');
  console.log('PASS: palette navigation and confirmation work in beta.2 copy-only mode too');
  await controller.configure({enabled:false});assert.equal(controller.helper,null);assert.equal(globalShortcut.isRegistered(config.shortcut),false);
  console.log('PASS: disabling unregisters the hotkey and stops the helper');
}).catch(async error=>{console.error(error);console.error('Test focus: '+JSON.stringify({hostPid:host.pid,popupPid:process.pid,popupWindow:controller.window&&popupHandle(),...await cmd('read')}));console.error('Recent close events: '+JSON.stringify(closeEvents.slice(-3)));console.error('Recent native events: '+JSON.stringify(nativeEvents.slice(-8)));process.exitCode=1;})
.finally(()=>{controller?.dispose();host?.kill();app.exit(process.exitCode||0);});
