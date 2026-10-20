// Isolated UI-only fixtures. No native input helper or personal library is used.
const { app, clipboard, nativeImage, protocol, screen } = require('electron');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const { SlashController }=require('../slash-controller');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'prompt-dock-preview-test-'));
app.setPath('userData',profile);
app.disableHardwareAcceleration();
protocol.registerSchemesAsPrivileged([{scheme:'prompt-dock-image',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let controller,uses=0,requests=[],errors=[];
async function until(check){for(let i=0;i<150;i++){if(await check())return;await sleep(30);}throw Error('Preview test timeout');}
const js=code=>controller.window.webContents.executeJavaScript(code);
const key=async value=>{await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(value)},bubbles:true,cancelable:true}))`);await sleep(70);};
async function open(session=10,query=''){
  controller.event({type:'query',session,palette:true,copyOnly:true,query,x:100,y:100});
  await until(()=>controller.ready);await sleep(150);
}
async function search(value){await js(`(()=>{const s=document.getElementById('search');s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('input'));})()`);await sleep(100);}
async function pointerClick(selector){
  const p=await js(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
  const wc=controller.window.webContents;wc.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});wc.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});await sleep(120);
}
app.whenReady().then(async()=>{
  const bitmap=Buffer.alloc(120*80*4);for(let y=0;y<80;y++)for(let x=0;x<120;x++){const offset=(y*120+x)*4;bitmap[offset]=140+x/3;bitmap[offset+1]=175+y/2;bitmap[offset+2]=210;bitmap[offset+3]=255;}
  const png=nativeImage.createFromBitmap(bitmap,{width:120,height:80}).toPNG();
  protocol.handle('prompt-dock-image',()=>new Response(png,{headers:{'content-type':'image/png'}}));
  const image='prompt-dock-image://asset/thumbnail/'+'a'.repeat(64)+'.png';
  const defaultBody='保持主体、构图与光线不变。将背景替换为纯灰色，边缘自然过渡。\n\n只处理背景，不修改人物或服装。';
  const variantBody='保留人物的姿态、五官和服装细节。\n只把背景替换为柔和的浅灰色，确保发丝与背景边界干净、自然。';
  const longBody=('这是完整的长正文，用于检查预览独立滚动，不改变窗口大小。\n').repeat(300)+'<img src=x onerror=alert(1)>';
  const prompts=[
    {id:'a',title:'灰色背景',favorite:true,defaultVariantTitle:'基础版',content:defaultBody,usageNote:'先上传需要处理的原图。适用于人物、产品和服装展示图。',tags:['图像/背景','修图'],images:[image],imageThumbnails:[image],variants:[{id:'v1',title:'人话版',content:variantBody},{id:'v2',title:'详细版',content:longBody}]},
    {id:'b',title:'光影分析',content:'分析画面中的主光、补光和阴影方向。',tags:['分析'],variants:[]},
    {id:'c',title:'人物四视图（横卡）',content:'生成正面、背面、左侧与右侧视图。',variants:[]}
  ];
  clipboard.writeText('PREVIEW_MUST_NOT_COPY');
  controller=new SlashController({readState:()=>({prompts}),recordUse:()=>uses++});
  const action=controller.action.bind(controller);controller.action=value=>{if(value.type==='preview')requests.push(value);action(value);};
  await open();controller.window.webContents.on('console-message',(_event,level,message)=>{if(level>=3)errors.push(message);});
  await until(async()=>await js('document.getElementById("preview-body").textContent')===defaultBody);
  assert.equal(await js('document.getElementById("preview-version").textContent'),'基础版');
  assert.equal(await js('document.getElementById("preview-note").hidden'),false);
  await until(async()=>await js('document.querySelector("#preview-images img")?.naturalWidth')===120);
  assert.equal(await js('getComputedStyle(document.querySelector("#preview-images img")).objectFit'),'contain');
  const initialBounds=controller.window.getBounds();assert.ok(Math.abs(initialBounds.width-760)<=1);
  fs.writeFileSync(path.join(profile,'preview-default.png'),(await controller.window.webContents.capturePage()).toPNG());
  console.log('PASS: default preview has title, note, full body, custom default name and local thumbnail');

  const stale=requests.at(-1);await key('ArrowDown');
  await until(async()=>await js('document.getElementById("preview-title").textContent')==='光影分析');
  assert.equal(await js('document.getElementById("preview-note").hidden'),true);
  assert.equal(await js('document.getElementById("preview-images-section").hidden'),true);
  controller.window.webContents.send('slash:preview',{session:stale.session,requestId:stale.requestId,detail:{id:'a',variantId:'default',title:'STALE',content:'STALE',usageNote:'',tags:[],images:[]}});await sleep(60);
  assert.equal(await js('document.getElementById("preview-title").textContent'),'光影分析');
  await js('document.querySelectorAll(".item")[0].dispatchEvent(new PointerEvent("pointermove",{bubbles:true,movementX:0,movementY:0}))');
  assert.equal(await js('document.querySelector(".item.selected b").textContent'),'光影分析');
  await js('document.querySelectorAll(".item")[0].dispatchEvent(new PointerEvent("pointermove",{bubbles:true,movementX:1,movementY:1}))');
  await until(async()=>await js('document.getElementById("preview-title").textContent')==='灰色背景');
  assert.equal(clipboard.readText(),'PREVIEW_MUST_NOT_COPY');assert.equal(uses,0);
  console.log('PASS: keyboard and real hover selection update preview; stale responses and stationary pointer ignored; no copy/paste');

  await key('ArrowRight');await key('ArrowDown');
  await until(async()=>await js('document.getElementById("preview-body").textContent')===variantBody);
  assert.equal(await js('document.getElementById("preview-version").textContent'),'人话版');
  await key('ArrowDown');await until(async()=>await js('document.getElementById("preview-body").textContent')===longBody);
  assert.equal(await js('document.getElementById("preview-body").children.length'),0);
  assert.deepEqual(controller.window.getBounds(),initialBounds);
  assert.equal(await js('(()=>{const p=document.getElementById("preview-scroll");p.scrollTop=400;return p.scrollTop>0&&document.getElementById("results").scrollTop===0;})()'),true);
  console.log('PASS: selected variant full text, text-only rendering and independent scrolling; long body cannot resize popup');

  await pointerClick('#preview-toggle');assert.ok(Math.abs(controller.window.getBounds().width-400)<=1);
  assert.equal(await js('document.getElementById("preview").hidden'),true);
  assert.equal(await js('document.activeElement.id'),'search');
  controller.ready=false;controller.window.webContents.reload();await until(()=>controller.ready);await sleep(150);
  assert.equal(await js('document.getElementById("preview").hidden'),true);assert.equal(controller.previewEnabled,false);
  await pointerClick('#preview-toggle');await until(async()=>await js('document.getElementById("preview-body").textContent')===defaultBody);
  assert.equal(await js('document.activeElement.id'),'search');
  console.log('PASS: icon hit area works, preview preference survives reload and toggling keeps search focus');

  controller.window.setBounds({width:400,height:420});await sleep(100);
  assert.equal(await js('(()=>{const a=document.getElementById("candidates").getBoundingClientRect(),b=document.getElementById("preview").getBoundingClientRect(),f=document.querySelector("footer").getBoundingClientRect();return b.top>=a.bottom&&b.bottom<=f.top+1&&f.bottom<=innerHeight;})()'),true);
  fs.writeFileSync(path.join(profile,'preview-stacked.png'),(await controller.window.webContents.capturePage()).toPNG());
  controller.show(true,false);await sleep(100);
  const b=controller.window.getBounds(),area=screen.getDisplayMatching(b).workArea;
  assert.ok(b.x>=area.x&&b.y>=area.y&&b.x+b.width<=area.x+area.width&&b.y+b.height<=area.y+area.height);
  await search('no-match');assert.equal(await js('document.getElementById("preview-content").hidden'),true);assert.equal(await js('document.getElementById("preview-body").textContent'),'');
  console.log('PASS: narrow window stacks preview, bounds fit display and empty search clears old details');

  await search('灰色');await key('ArrowRight');await key('ArrowDown');
  await pointerClick('.item.selected');assert.equal(clipboard.readText(),variantBody);assert.equal(uses,0);
  controller.close();await sleep(80);assert.equal(await js('document.getElementById("preview-body").textContent'),'');
  await open(11);await until(async()=>await js('document.getElementById("preview-body").textContent')===defaultBody);
  controller.close();controller.event({type:'query',session:12,query:'灰色',palette:false,copyOnly:true,x:100,y:100});await sleep(100);
  assert.equal(controller.view,null);assert.equal(controller.window.isVisible(),false);
  assert.deepEqual(errors,[]);
  console.log('PASS: clicking chosen variant still copies body only; close clears details; legacy inline events cannot open a popup');
  console.log('Preview screenshots: '+profile);
}).catch(error=>{console.error(error);process.exitCode=1;})
.finally(()=>{console.log('Preview test profile: '+profile);controller?.dispose();app.exit(process.exitCode||0);});
