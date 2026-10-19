let view = { items:[] }, selected = 0, variants = null, composing = false, compositionEndedAt = 0, pendingConfirm = "";
const $ = id => document.getElementById(id);
let previewEnabled=true, previewRequest=0, previewKey="";
try{previewEnabled=localStorage.getItem("promptDock.quickPreview")!=="false";}catch{}
function rows() { return variants ? variants.variants.map(v => ({...v, promptId:variants.id})) : view.items; }
function choice(){const item=rows()[selected];return item?{id:variants?variants.id:item.id,variant:variants?item.id:"default"}:null;}
function clearPreview(message="选中一条 Prompt 查看内容"){
  previewRequest++;previewKey="";$("preview-content").hidden=true;$("preview-placeholder").hidden=false;$("preview-placeholder").textContent=message;
  for(const id of ["preview-title","preview-version","preview-note-text","preview-body"])$(id).textContent="";
  $("preview-tags").replaceChildren();$("preview-images").replaceChildren();$("preview-scroll").scrollTop=0;
}
function updatePreview(){
  const visible=Boolean(view.palette&&previewEnabled);
  document.body.classList.toggle("with-preview",visible);$("preview").hidden=!visible;$("preview-toggle").hidden=!view.palette;
  $("preview-toggle").setAttribute("aria-pressed",String(previewEnabled));
  $("preview-toggle").title=previewEnabled?"收起预览":"展开预览";$("preview-toggle").setAttribute("aria-label",$("preview-toggle").title);
  const value=choice();
  if(!visible||!value){clearPreview(value?"选中一条 Prompt 查看内容":"没有可预览的内容");return;}
  const nextKey=JSON.stringify([view.session,value.id,value.variant]);if(nextKey===previewKey)return;
  clearPreview("正在读取预览…");previewKey=nextKey;
  window.slash.action({type:"preview",session:view.session,requestId:previewRequest,...value});
}
function select(index,scroll=true){
  selected=Math.max(0,Math.min(index,rows().length-1));
  $("results").querySelectorAll(".item").forEach((button,i)=>{button.classList.toggle("selected",i===selected);button.setAttribute("aria-selected",String(i===selected));});
  if(scroll)$("results").querySelector(".selected")?.scrollIntoView({block:"nearest"});
  updatePreview();
}
function render() {
  const items = rows(); selected = Math.max(0, Math.min(selected, items.length - 1));
  $("results").replaceChildren();
  if (!items.length) { const e=document.createElement("div");e.className="empty";e.textContent="没有匹配的 Prompt";$("results").append(e); }
  items.forEach((item,index) => {
    const b=document.createElement("button");b.className=`item ${index===selected?"selected":""}`;b.dataset.index=String(index);b.setAttribute("role","option");b.setAttribute("aria-selected",String(index===selected));
    const t=document.createElement("div");t.className="title";const title=document.createElement("b");title.textContent=item.title;t.append(title);
    if (!variants && item.variants.length>1) { const n=document.createElement("span");n.className="badge";n.textContent=`${item.variants.length} 个版本 ›`;n.addEventListener("mousedown",e=>{e.preventDefault();e.stopPropagation();});n.addEventListener("click",e=>{e.preventDefault();e.stopPropagation();variants=item;selected=0;render();});t.append(n); }
    b.append(t);const s=document.createElement("div");s.className="summary";s.textContent=variants?variants.title:((item.alias?`${item.alias} · `:"")+item.summary);b.append(s);
    b.addEventListener("mousedown",e=>e.preventDefault());b.addEventListener("click",e=>{if(e.button===0){selected=index;choose();}});$("results").append(b);
  });
  $("query").textContent=variants?`‹ ${variants.title} · 选择版本`:view.query?`搜索：${view.query}`:"常用与最近使用";
  $("hint").textContent=view.message || `↑↓ 选择 · ${variants?"← 返回":"→ 版本"} · ${view.confirm||"Tab"} ${view.copyOnly?"复制":"插入"} · Esc ${variants?"返回":"取消"}`;
  $("results").querySelector(".selected")?.scrollIntoView({block:"nearest"});
  updatePreview();
  window.slash.action({type:"size",session:view.session,height:128+(view.palette?56:0)+Math.max(1,items.length)*64});
}
function choose() { const value=choice();if(!value || view.busy)return;window.slash.action({type:"choose",session:view.session,...value}); }
function key(k) {
  if(k==="Escape") { if(variants){variants=null;selected=0;render();}else window.slash.action({type:"close",session:view.session}); }
  else if(k==="ArrowDown"||k==="ArrowUp"){select((selected+(k==="ArrowDown"?1:-1)+Math.max(rows().length,1))%Math.max(rows().length,1));}
  else if(k==="ArrowRight"&&!variants&&view.items[selected]?.variants.length>1){variants=view.items[selected];selected=0;render();}
  else if(k==="ArrowLeft"&&variants){variants=null;selected=0;render();}
  else if(k===(view.confirm||"Tab"))choose();
}
window.slash.onState(next => {
  const fresh=next.session!==view.session, changed=next.query!==view.query;view=next;
  if(fresh||changed){selected=0;variants=null;pendingConfirm="";clearPreview();}
  $("search").hidden=!view.palette;$("mode").textContent=view.copyOnly?"兼容模式 · 仅复制":view.palette?"快捷键调用":"输入框内匹配";
  render();if(fresh&&view.palette){composing=false;compositionEndedAt=0;$("search").value=view.query||"";$("search").focus();$("search").select();}
});
window.slash.onPreview(result=>{
  if(result.session!==view.session||result.requestId!==previewRequest||!view.palette||!previewEnabled)return;
  const detail=result.detail,value=choice();
  if(!detail){clearPreview("该内容已不可用，请重新搜索");return;}
  if(!value||detail.id!==value.id||detail.variantId!==value.variant)return;
  $("preview-title").textContent=detail.title;$("preview-version").textContent=detail.variantTitle;$("preview-version").title=detail.variantTitle;
  $("preview-tags").replaceChildren(...detail.tags.map(tag=>{const e=document.createElement("span");e.textContent=tag.replace(/\//g," › ");return e;}));
  $("preview-note").hidden=!detail.usageNote.trim();$("preview-note-text").textContent=detail.usageNote;
  $("preview-body").textContent=detail.content||"（这个版本尚未填写正文）";
  $("preview-images-section").hidden=!detail.images.length;$("preview-images-label").textContent=`参考图片 · ${detail.images.length}`;
  $("preview-images").replaceChildren(...detail.images.map((source,index)=>{const img=document.createElement("img");img.src=source;img.alt=`参考图 ${index+1}`;img.draggable=false;img.decoding="async";return img;}));
  $("preview-placeholder").hidden=true;$("preview-content").hidden=false;
});
window.slash.onHidden(()=>{view={items:[]};variants=null;selected=0;pendingConfirm="";clearPreview();});
$("results").addEventListener("pointermove",e=>{
  // Stationary pointer events caused by scrolling/layout must not undo keyboard selection.
  if(!view.palette||view.busy||(!e.movementX&&!e.movementY))return;
  const item=e.target.closest(".item");if(item&&Number(item.dataset.index)!==selected)select(Number(item.dataset.index),false);
});
$("preview-toggle").addEventListener("mousedown",e=>e.preventDefault());
$("preview-toggle").addEventListener("click",()=>{
  if(view.busy)return;previewEnabled=!previewEnabled;
  try{localStorage.setItem("promptDock.quickPreview",String(previewEnabled));}catch{}
  window.slash.action({type:"preview-toggle",session:view.session,enabled:previewEnabled});updatePreview();
});
// Inline mode retains beta.2's native key forwarding; the focused palette uses DOM keys.
window.slash.onKey(k=>{if(!view.palette)key(k);});
window.slash.onFocus(()=>{if(view.palette)$("search").focus({preventScroll:true});});
$("close").addEventListener("mousedown",e=>{e.preventDefault();window.slash.action({type:"close",session:view.session});});
$("search").addEventListener("compositionstart",()=>{composing=true;pendingConfirm="";});
$("search").addEventListener("compositionend",()=>{composing=false;compositionEndedAt=Date.now();window.slash.action({type:"query",session:view.session,query:$("search").value});});
$("search").addEventListener("input",()=>{if(!composing)window.slash.action({type:"query",session:view.session,query:$("search").value});});
window.addEventListener("keydown",e=>{
  if(!view.palette||composing||e.isComposing||e.keyCode===229||Date.now()-compositionEndedAt<80)return;
  const altArrow=e.altKey&&["ArrowLeft","ArrowRight"].includes(e.key);
  if(e.ctrlKey||e.metaKey||e.shiftKey||e.altKey&&!altArrow)return;
  const field=$("search"),atEnd=field.selectionStart===field.selectionEnd&&field.selectionEnd===field.value.length;
  const right=e.key==="ArrowRight"&&!variants&&view.items[selected]?.variants.length>1&&(document.activeElement!==field||atEnd||altArrow);
  const left=e.key==="ArrowLeft"&&Boolean(variants);
  if(!["ArrowUp","ArrowDown","Escape",view.confirm||"Tab"].includes(e.key)&&!right&&!left)return;
  e.preventDefault();e.stopPropagation();
  if(e.repeat&&["Escape",view.confirm||"Tab"].includes(e.key))return;
  if(e.key===(view.confirm||"Tab")){if(!view.busy)pendingConfirm=e.key;return;}
  if(!view.busy||e.key==="Escape")key(e.key);
},true);
// Wait for release so held Enter/Tab cannot leak into the target after insertion.
window.addEventListener("keyup",e=>{
  if(!view.palette||e.key!==pendingConfirm)return;
  pendingConfirm="";e.preventDefault();e.stopPropagation();
  if(!composing&&!e.isComposing&&!e.ctrlKey&&!e.altKey&&!e.metaKey&&!e.shiftKey&&Date.now()-compositionEndedAt>=80)choose();
},true);
window.addEventListener("blur",()=>{pendingConfirm="";});
window.slash.ready({previewEnabled});
