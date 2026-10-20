// Exercise new controls and delayed UIA readiness in an isolated Windows form.
// Fault injection exists only in SLASH_TEST builds, never in shipped binaries.
const { app, clipboard } = require('electron');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { SlashController } = require('../slash-controller');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'prompt-dock-acquisition-test-')));
let host,controller,id=0,events=[],nativeEvents=[],used=[];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let n=0;n<160;n++){const value=check();if(value)return value;await sleep(25);}throw Error('Timeout: '+JSON.stringify({view:controller?.view,nativeEvents:nativeEvents.slice(-10)}));}
async function cmd(type,extra={}){const request=++id;host.stdin.write(JSON.stringify({id:request,type,...extra})+'\n');return until(()=>events.find(e=>e.id===request));}
async function faults(misses){const start=nativeEvents.length;controller.send({type:'test-acquisition',misses});await until(()=>nativeEvents.slice(start).some(e=>e.type==='test-acquisition-ready'));}
async function start(extra={}){
  controller.close();const start=nativeEvents.length;
  assert.equal((await cmd('set',{text:'BEGIN END',caret:6,fresh:true,...extra})).foreground,true);
  await cmd('hotkey');return start;
}
async function ready(){await until(()=>controller.view&&controller.ready);await sleep(80);assert.equal(controller.window.isFocused(),true);}
async function confirm(){
  assert.equal(controller.window.isFocused(),true);
  const window=controller.window.getNativeWindowHandle().readBigUInt64LE().toString();
  assert.equal((await cmd('popupKey',{key:13,window})).refused,undefined);
}
async function expectPaste(count){await until(()=>used.length===count||controller.view?.finished);assert.equal(used.length,count,JSON.stringify(controller.view));assert.equal((await cmd('read')).text,'BEGIN BODYEND');}
app.whenReady().then(async()=>{
  const [hostPath,helperPath]=process.argv.slice(2);
  host=spawn(hostPath,[String(process.pid)],{windowsHide:true});let buffer='';host.stdout.setEncoding('utf8');
  host.stdout.on('data',chunk=>{buffer+=chunk;let at;while((at=buffer.indexOf('\n'))>=0){events.push(JSON.parse(buffer.slice(0,at)));buffer=buffer.slice(at+1);}});
  await until(()=>events.some(e=>e.ready));
  controller=new SlashController({readState:()=>({prompts:[{id:'p',title:'Test',content:'BODY'}]}),recordUse:()=>used.push(true)});
  controller.executable=()=>helperPath;
  const receive=controller.event.bind(controller);controller.event=e=>{nativeEvents.push(e);receive(e);};
  assert.equal((await controller.configure({enabled:true,trigger:'//',scope:'include',apps:['SlashTestHost'],shortcut:'Control+Alt+Shift+F10',confirm:'Enter'})).ok,true);
  await until(()=>nativeEvents.some(e=>e.type==='ready'));await faults(0);
  await start();await ready();assert.equal(controller.view.copyOnly,false);await confirm();await expectPaste(1);
  console.log('PASS: first shortcut invocation on a new input control inserts once');

  for(const misses of [1,4,8]){
    await faults(misses);const from=await start();await ready();
    assert.equal(controller.view.copyOnly,false,'Transient caret failure must not become permanent copy-only');
    const probe=nativeEvents.slice(from).find(e=>e.type==='acquisition-result');
    assert.ok(probe.ready&&probe.attempts>=misses+2,JSON.stringify(probe));
    const expected=used.length+1;await confirm();await expectPaste(expected);
    console.log('PASS: new input control recovers after '+misses+' unavailable caret reads: '+JSON.stringify(probe));
  }
  // Repeated invocation in the same already-used field must also remain safe.
  const expected=used.length+1;await faults(0);await start({fresh:false});await ready();await confirm();await expectPaste(expected);
  console.log('PASS: repeated invocation in the same input inserts once');

  await faults(100);const timeoutFrom=await start();await ready();
  assert.equal(controller.view.copyOnly,true);assert.match(controller.view.message,/光标/);
  const timeoutProbe=nativeEvents.slice(timeoutFrom).find(e=>e.type==='acquisition-result');
  assert.equal(timeoutProbe.ready,false);assert.ok(timeoutProbe.elapsedMs>=600&&timeoutProbe.elapsedMs<1500,JSON.stringify(timeoutProbe));
  const beforeCopy=used.length;await confirm();await sleep(150);
  assert.equal(used.length,beforeCopy);assert.equal(clipboard.readText(),'BODY');assert.equal((await cmd('read')).text,'BEGIN END');
  console.log('PASS: sustained unavailability falls back with an explicit reason and never auto-pastes');

  for(const change of ['focus','cancel','typing']){
    await faults(100);const from=await start();await until(()=>nativeEvents.slice(from).some(e=>e.type==='acquisition-start'));
    assert.ok(!controller.view,'Popup must not steal focus during acquisition');
    if(change==='focus')await cmd('set',{kind:'other',text:'OTHER'});
    else if(change==='cancel')controller.close();
    else await cmd('key',{key:65});
    await until(()=>nativeEvents.slice(from).some(e=>e.type==='acquisition-result'));await sleep(180);
    assert.ok(!controller.view,'Changed input must abort the pending popup');assert.equal(used.length,beforeCopy);
    console.log('PASS: '+change+' during acquisition cancels without retargeting or pasting');
  }
  await faults(0);await start({readOnly:true});await ready();
  assert.equal(controller.view.copyOnly,true);assert.match(controller.view.message,/只读/);controller.close();
  console.log('PASS: read-only controls remain copy-only');
  const passwordFrom=await start({kind:'password'});
  await until(()=>nativeEvents.slice(passwordFrom).some(e=>e.type==='acquisition-result'));await sleep(100);assert.ok(!controller.view);
  console.log('PASS: password controls do not open the palette');
}).catch(async error=>{console.error(error);console.error('Recent native test events: '+JSON.stringify(nativeEvents.slice(-12)));if(host)console.error('Isolated host status: '+JSON.stringify(await cmd('read')));process.exitCode=1;})
.finally(()=>{controller?.dispose();host?.kill();app.exit(process.exitCode||0);});
