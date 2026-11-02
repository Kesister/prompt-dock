// Compile the actual native routines against an in-memory UIA/Win32 model.
// No real window, input, focus, clipboard, hook, or user profile is accessed.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

test('native selection replacement and cancellation focus guards', {skip:process.platform!=='win32'},()=>{
  const source=fs.readFileSync(path.join(__dirname,'../assets/PromptDock.SlashHelper.cs'),'utf8');
  function method(name){
    const at=source.search(new RegExp('  static [^\\n]+ '+name+'\\('));assert.ok(at>=0,name);
    const open=source.indexOf('{',at);let depth=1,end=open+1;
    while(depth&&end<source.length){if(source[end]==='{')depth++;if(source[end]==='}')depth--;end++;}
    assert.equal(depth,0,name);return source.slice(at,end);
  }
  const routines=['Selection','Caret','AcquirePalette','ReadyForCommit','WaitForMouseRelease','SelectionMatches','ConfirmSelection','Commit','Restore'].map(method).join('\n');
  const model=String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
enum TextPatternRangeEndpoint { Start,End }
enum TextUnit { Character }
class ElementNotAvailableException:Exception {}
class COMException:Exception {}
class AutomationElement {
  public static AutomationElement FocusedElement;
  public string Key="field",Text="BEGIN OLD END";
  public int Start=6,End=9,Reads=0,MutateOnRead=0;
  public bool IsPassword=false,IsEnabled=true,HasKeyboardFocus=true,ReadOnly=false,Available=true;
  public Action OnFocus;
  public AutomationElement Current {get{return this;}}
  public bool TryGetCurrentPattern(object p,out object value){value=p==TextPattern.Pattern?(object)new TextPattern(this):new ValuePattern(this);return true;}
  public void SetFocus(){HasKeyboardFocus=true;if(OnFocus!=null)OnFocus();}
}
class TextPattern {
  public static object Pattern=new object(),IsReadOnlyAttribute=new object();
  AutomationElement e;public TextPattern(AutomationElement value){e=value;}
  public TextPatternRange[] GetSelection(){e.Reads++;if(e.Reads==e.MutateOnRead)e.Text="BEGIN NEW END";return e.Available?new[]{new TextPatternRange(e,e.Start,e.End)}:new TextPatternRange[0];}
}
class ValuePattern {
  public static object Pattern=new object();AutomationElement e;
  public ValuePattern(AutomationElement value){e=value;}public ValuePattern Current{get{return this;}}public bool IsReadOnly{get{return e.ReadOnly;}}
}
class TextPatternRange {
  public AutomationElement E;public int Start,End;
  public TextPatternRange(AutomationElement e,int start,int end){E=e;Start=start;End=end;}
  public bool Compare(TextPatternRange r){return E==r.E&&Start==r.Start&&End==r.End;}
  public int CompareEndpoints(TextPatternRangeEndpoint a,TextPatternRange r,TextPatternRangeEndpoint b){return (a==TextPatternRangeEndpoint.Start?Start:End)-(b==TextPatternRangeEndpoint.Start?r.Start:r.End);}
  public string GetText(int limit){return E.Text.Substring(Start,End-Start);}
  public object GetAttributeValue(object a){return E.ReadOnly;}
  public TextPatternRange Clone(){return new TextPatternRange(E,Start,End);}
  public int MoveEndpointByUnit(TextPatternRangeEndpoint a,TextUnit u,int amount){if(a==TextPatternRangeEndpoint.Start)Start+=amount;else End+=amount;return amount;}
  public void Select(){E.Start=Start;E.End=End;}
}
class NativeModel {
  static bool visible,palette,busy,acquiring,composing;
  static int owner=7,serial=1,generation=0,pressed=0,pastes=0,activations=0,checks=0;
  static IntPtr target=new IntPtr(10),targetFocus=new IntPtr(11),foreground,focus;
  static AutomationElement element;
  static TextPatternRange paletteRange;
  static string paletteText="",identity="",token="",prefix="",trigger="/";
  const int PaletteAcquireMs=700,PalettePollMs=40;
  static string Str(Dictionary<string,object> d,string k){return d.ContainsKey(k)?Convert.ToString(d[k]):"";}
  static void Cancel(){generation++;visible=false;palette=false;busy=false;}
  static void Emit(object value){}
  static string Id(AutomationElement e){return e.Key;}
  static bool SameTarget(){return foreground==target&&focus==targetFocus;}
  static bool Allowed(IntPtr w){return w==target;}
  static bool Down(int k){return k==pressed;}
  static bool IsComposing(){return composing;}
  static IntPtr GetForegroundWindow(){return foreground;}
  static uint GetWindowThreadProcessId(IntPtr w,out uint pid){pid=w==new IntPtr(20)?(uint)owner:100;return 1;}
  static bool SetForegroundWindow(IntPtr w){activations++;foreground=w;focus=targetFocus;if(element!=null){element.HasKeyboardFocus=true;AutomationElement.FocusedElement=element;}return true;}
  static bool Paste(){pastes++;var e=AutomationElement.FocusedElement;e.Text=e.Text.Substring(0,e.Start)+"BODY"+e.Text.Substring(e.End);e.Start+=4;e.End=e.Start;return true;}
  static string Before(TextPatternRange r){throw new Exception("Legacy trigger path must stay unused");}
  static bool Split(string s,out string a,out string b){throw new Exception("Legacy trigger path must stay unused");}
  static void Check(bool ok,string name){if(!ok)throw new Exception(name);checks++;}
  static void Reset(bool selected=true){
    generation=0;serial=1;visible=palette=true;busy=acquiring=composing=false;pressed=pastes=activations=0;
    foreground=target;focus=targetFocus;element=new AutomationElement();if(!selected)element.End=element.Start;
    AutomationElement.FocusedElement=element;paletteRange=Selection(element).Clone();paletteText=paletteRange.GetText(-1);identity=Id(element);token="";
    element.OnFocus=()=>{focus=targetFocus;AutomationElement.FocusedElement=element;};
  }
  static Dictionary<string,object> Command(int session=1){return new Dictionary<string,object>{{"session",session},{"expires",DateTime.UtcNow.AddSeconds(1).Ticks},{"query",""}};}
  public static int Main(){
    Reset();Check(Caret(element)==null,"legacy caret reader still rejects selected text");
    AutomationElement acquired;TextPatternRange range;string reason;
    Check(AcquirePalette(0,out acquired,out range,out reason)&&range!=null&&range.GetText(-1)=="OLD","stable selected text is acquired");
    Reset(false);Check(AcquirePalette(0,out acquired,out range,out reason)&&range!=null,"empty caret still acquired");
    Reset();element.Reads=0;element.MutateOnRead=2;
    Check(AcquirePalette(0,out acquired,out range,out reason)&&range!=null&&element.Reads>=3,"live ranges need matching text samples too");
    Reset();element.ReadOnly=true;Check(AcquirePalette(0,out acquired,out range,out reason)&&range==null&&reason=="read-only","read-only stays copy-only");
    Reset();element.IsPassword=true;Check(!AcquirePalette(0,out acquired,out range,out reason)&&range==null,"password rejected");
    Reset();Commit(Command());Check(pastes==1&&element.Text=="BEGIN BODY END","replace selected text once, preserving surrounding text");
    Reset(false);Commit(Command());Check(pastes==1&&element.Text=="BEGIN BODYOLD END","insert at empty caret");
    Reset();element.Start=0;element.End=5;Commit(Command());Check(pastes==0,"changed range cannot paste");
    Reset();element.Text="BEGIN NEW END";Commit(Command());Check(pastes==0,"changed text in same range cannot paste");
    Reset();element.ReadOnly=true;Commit(Command());Check(pastes==0,"newly read-only cannot paste");
    Reset();element.IsPassword=true;Commit(Command());Check(pastes==0,"newly protected cannot paste");
    Reset();element.Key="other";Commit(Command());Check(pastes==0,"different UIA field cannot paste");
    Reset();composing=true;Commit(Command());Check(pastes==0,"IME composition cannot paste");
    Reset();pressed=17;Commit(Command());Check(pastes==0,"held modifier cannot paste");
    Reset();foreground=new IntPtr(20);element.HasKeyboardFocus=false;Restore(Command());
    Check(SameTarget()&&pastes==0&&element.Text=="BEGIN OLD END"&&element.Start==6&&element.End==9,"cancel restores original field without changing selection or text");
    Reset();foreground=new IntPtr(30);Restore(Command());Check(activations==0&&pastes==0,"cancel cannot steal focus from another application");
    Reset();focus=new IntPtr(12);element.HasKeyboardFocus=false;Restore(Command());Check(activations==0,"cancel cannot undo a click into another field of the same application");
    Reset();foreground=new IntPtr(20);Restore(Command(2));Check(activations==0,"stale session cannot restore");
    Reset();foreground=new IntPtr(20);var expired=Command();expired["expires"]=DateTime.UtcNow.AddSeconds(-1).Ticks;Restore(expired);Check(activations==0,"expired cancellation cannot restore");
    Reset();foreground=new IntPtr(20);element.Key="other";Restore(Command());Check(activations==0,"changed element cannot restore");
    Reset();foreground=new IntPtr(20);busy=true;Restore(Command());Check(activations==0,"in-flight paste cannot be restored by cancellation");
    Console.WriteLine("NATIVE_MODEL_OK:"+checks);return 0;
  }
__ROUTINES__
}`.replace('__ROUTINES__',routines);
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'prompt-dock-native-model-'));
  const input=path.join(temp,'NativeModel.cs'),output=path.join(temp,'NativeModel.exe');fs.writeFileSync(input,model);
  const compiler=path.join(process.env.WINDIR||'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const build=spawnSync(compiler,['/nologo','/target:exe','/platform:x64','/out:'+output,input],{encoding:'utf8',windowsHide:true});
  assert.equal(build.status,0,build.stdout+build.stderr);
  const result=spawnSync(output,[],{encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/NATIVE_MODEL_OK:22/);
});
