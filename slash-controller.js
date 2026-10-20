const { BrowserWindow, ipcMain, screen, clipboard, globalShortcut, app } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const core = require("./slash-core");
const preview = require("./slash-preview");
const { pasteMessage } = require('./mac-input');
const IS_MAC = process.platform === 'darwin';
const copyReasons = {
  "caret-unavailable":"暂未取得可验证的光标位置，本次仅复制；可关闭后重新唤出。",
  "caret-unstable":"光标位置尚未稳定，本次仅复制；可关闭后重新唤出。",
  "focus-not-ready":"输入框焦点尚未就绪，本次仅复制；可关闭后重新唤出。",
  "read-only":"当前位置为只读区域，本次仅复制。",
  "composing":"输入法仍在组合输入，本次仅复制；请选字完成后重新唤出。"
};

class SlashController {
  constructor({readState, recordUse, onStatus, macInput, openMacAccessibility}) {
    this.macInput = macInput;
    this.openMacAccessibility = openMacAccessibility;
    this.readState=readState;this.recordUse=recordUse;this.onStatus=onStatus;this.config=core.settings();
    this.paused=false;this.helper=null;this.window=null;this.view=null;this.activeShortcut="";this.message="";this.ready=false;this.pending=false;this.previewEnabled=true;
    ipcMain.on("slash:ready",(e,options)=>{if(e.sender===this.window?.webContents){this.previewEnabled=options?.previewEnabled!==false;this.ready=true;if(this.view)this.show(true,false);this.publish();this.reveal();}});
    ipcMain.on("slash:action",(e,action)=>{if(e.sender===this.window?.webContents)this.action(action);});
  }
  executable(){return path.join(__dirname,"assets","PromptDock.SlashHelper.exe").replace("app.asar"+path.sep,"app.asar.unpacked"+path.sep);}
  send(value){if(this.helper?.stdin.writable)this.helper.stdin.write(JSON.stringify(value)+"\n");}
  invalidate(){this.sessionPrompts=null;}
  search(query){if(!this.sessionPrompts)this.sessionPrompts=this.readState().prompts;return core.search(this.sessionPrompts,query);}
  status(){return {enabled:this.config.enabled,paused:this.paused,running:IS_MAC ? Boolean(this.config.enabled&&!this.paused&&this.macInput&&!this.macInput.stopped) : Boolean(this.helper),message:this.message,shortcut:this.activeShortcut};}
  async configure(raw, reserved=[]) {
    const next=core.settings(raw);if(!['win32','darwin'].includes(process.platform)&&next.enabled)return {ok:false,message:"当前系统暂不支持快捷调用。"};
    if(next.enabled&&next.shortcut&&reserved.some(x=>String(x).toLowerCase()===next.shortcut.toLowerCase()))return {ok:false,message:"调用快捷键不能与全局唤出或新建快捷键相同。"};
    if(next.enabled&&next.shortcut&&next.shortcut!==this.activeShortcut){
      let ok=false;try{ok=globalShortcut.register(next.shortcut,()=>this.openPalette());}catch{}
      if(!ok)return {ok:false,message:"调用快捷键无效或已被占用，请更换。"};
    }
    if(this.activeShortcut&&(!next.enabled||next.shortcut!==this.activeShortcut))globalShortcut.unregister(this.activeShortcut);
    this.activeShortcut=next.enabled?next.shortcut:"";this.config=next;this.close();
    if(!next.enabled){this.paused=false;this.stop();}
    else if(!this.paused){if(this.helper)this.send({type:"config",...next});else this.start();}
    this.onStatus?.();return {ok:true,...this.status()};
  }
  start(){
    // Load the hidden Mac palette before the hotkey, including its renderer.
    if(IS_MAC){this.ensureWindow();return;}
    if(this.helper||!this.config.enabled||this.paused)return;
    const child=spawn(this.executable(),[String(process.pid)],{windowsHide:true,stdio:["pipe","pipe","ignore"]});this.helper=child;let buffer="";
    child.stdout.setEncoding("utf8");child.stdout.on("data",chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{if(this.helper===child)this.event(JSON.parse(line));}catch{}}});
    child.stdin.on("error",()=>{});
    const fail=()=>{if(this.helper===child){this.helper=null;this.hide();this.message="快捷调用助手已停止，可在设置中关闭后重新开启。";this.onStatus?.();}};
    child.on("error",fail);child.on("exit",fail);this.message="";
  }
  stop(){const child=this.helper;this.helper=null;child?.kill();this.hide();}
  pause(){this.paused=!this.paused;if(this.paused)this.stop();else this.start();this.onStatus?.();}
  async openPalette(){
    if(!this.config.enabled||this.paused||this.acquiring||this.pending)return;
    if(!IS_MAC){this.start();this.send({type:'palette'});return;}
    if(this.view){this.close();return;}
    this.acquiring=true;
    const acquired=await this.macInput?.capture() || {ok:false,reason:'helper-unavailable'};
    this.acquiring=false;
    if(!this.config.enabled||this.paused)return;
    // Password fields are skipped completely; never show an insertion action there.
    if(acquired.reason==='password'){this.message='识别到密码输入框，已跳过快捷调用。';this.onStatus?.();return;}
    this.macToken=acquired.token;
    this.event({type:'query',session:Date.now(),query:'',palette:true,copyOnly:!acquired.ok,copyReason:acquired.reason,x:acquired.x,y:acquired.y});
    if(!acquired.ok&&this.view){this.view.message=pasteMessage(acquired.reason).replace(/内容已复制/g,'本次将仅复制');this.publish();}
  }
  event(event){
    if(event.type==="ready"){this.send({type:"config",...this.config});this.message="";this.onStatus?.();}
    if(event.type==="query"){
      if(event.palette!==true)return; // No inline-trigger sessions, even from a stale helper event.
      if(this.message){this.message="";this.onStatus?.();}
      const fresh=event.session!==this.view?.session;
      if(fresh){this.invalidate();this.view={...event,confirm:this.config.confirm,message:event.copyOnly?(copyReasons[event.copyReason]||"当前输入位置无法验证，本次仅复制。"):"",busy:false};this.pending=false;}
      else Object.assign(this.view,{query:event.query});
      this.view.items=this.search(this.view.query);
      // Populate the warmed Mac renderer before showing/focusing it. Otherwise
      // the focus IPC can reach the just-cleared view before its search field.
      this.show(fresh,!(IS_MAC&&fresh));this.publish();
      if(IS_MAC&&fresh&&this.ready)this.reveal();
    }
    if(event.type==="key"&&event.session===this.view?.session&&!this.pending)this.window?.webContents.send("slash:key",event.key);
    if(event.type==="closed"&&event.session===this.view?.session&&!this.pending&&!this.view.finished)this.hide();
    if(event.type==="result"&&event.session===this.view?.session){
      clearTimeout(this.commitTimer);this.pending=false;
      if(event.ok){this.recordUse(this.chosen.id,this.chosen.variant);this.hide();}
      else {this.view.busy=false;this.view.finished=true;this.view.copyOnly=true;this.view.message=event.message;this.publish();if(this.view.palette)this.reveal();clearTimeout(this.noticeTimer);this.noticeTimer=setTimeout(()=>this.close(),5000);}
    }
    if(event.type==="error"){this.message=event.message;this.onStatus?.();}
  }
  ensureWindow(){
    if(this.window&&!this.window.isDestroyed())return;
    this.ready=false;
    this.window=new BrowserWindow({width:400,height:440,frame:false,show:false,focusable:IS_MAC||Boolean(this.view?.palette),skipTaskbar:true,resizable:false,maximizable:false,minimizable:false,alwaysOnTop:true,backgroundColor:"#fffdf9",
      webPreferences:{preload:path.join(__dirname,"slash-preload.js"),contextIsolation:true,nodeIntegration:false,sandbox:true,...(IS_MAC?{backgroundThrottling:false}:{})}});
    this.window.setMenuBarVisibility(false);this.window.loadFile(path.join(__dirname,"slash.html"));
    this.window.webContents.setWindowOpenHandler(()=>({action:"deny"}));this.window.webContents.on("will-navigate",e=>e.preventDefault());
    this.window.on("blur",()=>{if(this.view?.palette&&!this.pending)this.close();});
    this.window.on("closed",()=>{this.window=null;this.ready=false;});
  }
  show(fresh, reveal=true){
    this.ensureWindow();if(!fresh)return;
    let point=this.view.x!=null?(IS_MAC?{x:this.view.x,y:this.view.y}:screen.screenToDipPoint({x:this.view.x,y:this.view.y})):screen.getCursorScreenPoint();
    const area=screen.getDisplayNearestPoint(point).workArea;
    const {x,y,width,height}=preview.bounds(point,area,Boolean(this.view.palette&&this.previewEnabled),this.view.height||256);
    const current=this.window.getBounds();
    if(current.x!==x||current.y!==y||current.width!==width||current.height!==height)this.window.setBounds({x,y,width,height});
    if(this.window.isFocusable()!==Boolean(this.view.palette))this.window.setFocusable(Boolean(this.view.palette));
    if(!IS_MAC){const a=screen.dipToScreenPoint({x,y}),b=screen.dipToScreenPoint({x:x+width,y:y+height});this.send({type:"bounds",x:a.x,y:a.y,width:b.x-a.x,height:b.y-a.y});}
    if(reveal&&this.ready)this.reveal();
  }
  reveal(){
    if(this.view?.palette){this.window.show();this.window.focus();this.window.webContents.focus();this.window.webContents.send("slash:focus");}
    else if(this.view)this.window.showInactive();
  }
  publish(){if(this.ready&&this.view)this.window?.webContents.send("slash:view",this.view);}
  hide(){clearTimeout(this.noticeTimer);clearTimeout(this.commitTimer);this.invalidate();this.view=null;this.macToken=null;this.pending=false;if(this.ready)this.window?.webContents.send("slash:hidden");this.window?.hide();}
  close(){const token=this.macToken;this.send({type:"cancel"});this.hide();if(IS_MAC&&token)this.macInput?.restore(token);}
  action(value){
    if(!this.view||value?.session!==this.view.session)return;
    if(value.type==='accessibility-settings'&&IS_MAC){this.openMacAccessibility?.();return;}
    if(value.type==="close"){this.close();return;}
    if(value.type==="size"){
      const height=Math.max(192,Math.min(464,Number(value.height)||256));
      if(height!==this.view.height){this.view.height=height;this.show(true,false);}
      return;
    }
    if(this.pending)return;
    if(value.type==="preview-toggle"&&this.view.palette){this.previewEnabled=value.enabled===true;this.show(true,false);return;}
    if(value.type==="preview"&&this.view.palette){
      if(!Number.isSafeInteger(value.requestId)||value.requestId<1||!this.view.items.some(item=>item.id===value.id))return;
      if(!this.sessionPrompts)this.sessionPrompts=this.readState().prompts;
      const detail=preview.details(this.sessionPrompts.find(item=>item.id===value.id),value.variant);
      this.window?.webContents.send("slash:preview",{session:this.view.session,requestId:value.requestId,detail});return;
    }
    if(value.type==="query"&&this.view.palette){this.view.query=String(value.query||"").slice(0,100);this.view.items=this.search(this.view.query);this.publish();return;}
    if(value.type!=="choose")return;
    // Resolve current content in the main process, never accept clipboard text from the popup.
    if(!this.view.items.some(item=>item.id===value.id))return;
    const prompt=this.readState().prompts.find(p=>p.id===value.id&&!p.deletedAt);if(!prompt)return;
    const content=value.variant==="default"?prompt.content:prompt.variants?.find(v=>v.id===value.variant)?.content;if(typeof content!=="string")return;
    clipboard.writeText(content);
    if(this.view.copyOnly){this.view.message=this.view.copyReason==='permission'?'已复制。请先授权辅助功能，授权后才能直接粘贴。':'已复制，请回到输入框手动粘贴。';this.publish();clearTimeout(this.noticeTimer);if(this.view.copyReason!=='permission')this.noticeTimer=setTimeout(()=>this.close(),1800);return;}
    this.pending=true;this.chosen=value;this.view.busy=true;this.view.message="正在核对输入位置…";this.publish();
    if(this.view.palette)(IS_MAC?this.commitMacPalette(this.view.session):this.commitPalette(this.view.session));
    else this.send({type:"commit",session:this.view.session,query:this.view.query});
    this.commitTimer=setTimeout(()=>{if(this.pending&&this.view){this.pending=false;this.view.busy=false;this.view.finished=true;this.view.copyOnly=true;this.view.message="输入框未响应，内容已复制，请手动粘贴。";this.send({type:"cancel"});this.publish();if(this.view.palette)this.reveal();}},IS_MAC?2600:1800);
  }
  async commitMacPalette(session){
    if(IS_MAC){
      this.window.hide();
      const result=this.macToken ? await this.macInput.paste(this.macToken) : {ok:false,reason:'caret-unavailable'};
      if(process.env.PROMPT_DOCK_NATIVE_TEST)console.log('MAC_PALETTE_RESULT:',result);
      if(this.pending&&this.view?.session===session)this.event({type:'result',session,ok:result.ok,message:pasteMessage(result.reason)});
      return;
    }
  }
  async commitPalette(session){
    const helper=this.helper;
    const allowed=helper&&await new Promise(resolve=>{
      const exe=path.join(__dirname,"assets","PromptDock.FocusGrant.exe").replace("app.asar"+path.sep,"app.asar.unpacked"+path.sep);
      const child=spawn(exe,[String(process.pid),String(helper.pid)],{windowsHide:true,stdio:["ignore","pipe","ignore"]});
      let output="",done=false;
      const finish=ok=>{if(done)return;done=true;clearTimeout(timer);resolve(ok);};
      const timer=setTimeout(()=>{child.kill();finish(false);},500);
      child.stdout.on("data",value=>output+=value);child.on("error",()=>finish(false));child.on("close",code=>finish(code===0&&output.trim()==="OK"));
    });
    if(!this.pending||this.view?.session!==session||helper!==this.helper)return;
    if(!allowed){this.event({type:"result",session,ok:false,message:"无法返回原输入框，Prompt 已复制，请手动粘贴。"});return;}
    // Only the focus handoff changes. beta.2 still validates and pastes itself.
    this.window.hide();this.send({type:"commit",session,query:this.view.query});
  }
  dispose(){clearTimeout(this.commitTimer);this.stop();if(this.activeShortcut)globalShortcut.unregister(this.activeShortcut);this.window?.destroy();}
}
module.exports = { SlashController };
