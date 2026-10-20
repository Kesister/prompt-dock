// Read-only preview data and geometry. Never participates in insertion or focus.
function localImage(source) {
  if(typeof source!=="string")return "";
  if(/^prompt-dock-image:\/\/asset\/(?:thumbnail|original)\/[a-f0-9]{64}\.(?:png|jpg|webp|gif|svg)$/i.test(source))return source;
  if(/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=\r\n]+$/i.test(source))return source;
  return "";
}
function details(prompt, variantId="default") {
  if(!prompt||prompt.deletedAt)return null;
  const variant=variantId==="default"?{id:"default",title:prompt.defaultVariantTitle||"默认版本",content:prompt.content}
    :(prompt.variants||[]).find(item=>item.id===variantId);
  if(!variant)return null;
  const originals=Array.isArray(prompt.images)?prompt.images:prompt.image?[prompt.image]:[];
  const images=originals.slice(0,6).map((source,index)=>localImage(prompt.imageThumbnails?.[index])||localImage(source)).filter(Boolean);
  return {id:prompt.id,variantId,title:String(prompt.title||"未命名 Prompt"),variantTitle:String(variant.title||"未命名版本"),
    usageNote:String(prompt.usageNote||""),content:String(variant.content||""),tags:(prompt.tags||[]).map(String),images};
}
function bounds(point, area, preview, listHeight=464) {
  const stacked=preview&&area.width<700;
  const width=Math.min(preview&&!stacked?760:400,area.width);
  const height=Math.min(preview?(stacked?640:520):Math.max(192,Math.min(464,listHeight)),area.height);
  const x=Math.max(area.x,Math.min(point.x,area.x+area.width-width));
  let y=point.y+8;
  if(y+height>area.y+area.height)y=point.y-height-8;
  y=Math.max(area.y,Math.min(y,area.y+area.height-height));
  return {x:Math.round(x),y:Math.round(y),width:Math.round(width),height:Math.round(height)};
}
module.exports={details,bounds};
