using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Automation.Text;
using System.Windows.Forms;

// Hotkey-only acquisition. Hooks cancel acquisition on new input; no trigger scanning or input log.
internal static class SlashHelper {
  delegate IntPtr Hook(int code, IntPtr message, IntPtr data);
  static Hook keyboardProc=Keyboard, mouseProc=Mouse;
  static IntPtr keyboardHook, mouseHook;
  static readonly JavaScriptSerializer json=new JavaScriptSerializer();
  static readonly object outputLock=new object(), commandLock=new object();
  static readonly Queue<Dictionary<string,object>> commands=new Queue<Dictionary<string,object>>();
  static readonly AutoResetEvent wake=new AutoResetEvent(false);
  static volatile bool running=true, visible=false, palette=false, ime=false, busy=false, acquiring=false;
  static volatile int generation=0;
  static int owner, popupLeft, popupTop, popupRight, popupBottom;
  static string trigger="/", confirm="Tab";
  static HashSet<int> swallowed=new HashSet<int>();
  static IntPtr target=IntPtr.Zero;
  static IntPtr targetFocus=IntPtr.Zero;
  static AutomationElement element;
  static TextPatternRange paletteRange;
  static string identity="", prefix="", token="", lastQuery="";
  static string lastUnsupportedApp="";
  static int serial=0;
  static long lastVerified;
  const int PaletteAcquireMs=700, PalettePollMs=40;
#if SLASH_TEST
  static int testMissingCaretReads=0;
#endif

  [StructLayout(LayoutKind.Sequential)] struct Point { public int x,y; }
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int left,top,right,bottom; }
  [StructLayout(LayoutKind.Sequential)] struct GuiInfo { public int size,flags; public IntPtr active,focus,capture,menu,move,caret; public Rect rect; }
  [StructLayout(LayoutKind.Sequential)] struct KeyData { public uint key,scan,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct MouseData { public Point pt; public uint data,flags,time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit,Size=40)] struct Input { [FieldOffset(0)] public uint type; [FieldOffset(8)] public ushort key; [FieldOffset(12)] public uint flags; }
  [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id,Hook proc,IntPtr module,uint thread);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook,int code,IntPtr message,IntPtr data);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread,ref GuiInfo info);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window,ref Point pt);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out Point pt);
  [DllImport("user32.dll")] static extern uint SendInput(uint count,Input[] inputs,int size);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("imm32.dll")] static extern IntPtr ImmGetContext(IntPtr window);
  [DllImport("imm32.dll")] static extern bool ImmReleaseContext(IntPtr window,IntPtr context);
  [DllImport("imm32.dll",CharSet=CharSet.Unicode)] static extern int ImmGetCompositionString(IntPtr context,uint index,IntPtr buffer,int size);
  static bool Down(int key) { return (GetAsyncKeyState(key)&0x8000)!=0; }
  static void Emit(object value) { lock(outputLock) Console.WriteLine(new JavaScriptSerializer().Serialize(value)); }
  static string Id(AutomationElement e) { return String.Join(".",e.GetRuntimeId()); }
  static string Str(Dictionary<string,object> d,string k) { return d.ContainsKey(k)?Convert.ToString(d[k]):""; }
  static void Cancel() { generation++;visible=false;palette=false;busy=false;wake.Set(); }
  static string AppName(IntPtr window) { uint pid;GetWindowThreadProcessId(window,out pid);if(pid==owner||pid==Process.GetCurrentProcess().Id)return "";try{return Process.GetProcessById((int)pid).ProcessName;}catch{return "";} }
  // Only reject our own windows / unavailable targets, never apply legacy app lists.
  static bool Allowed(IntPtr window) { return AppName(window).Length>0; }
  static IntPtr FocusWindow() {uint pid;uint tid=GetWindowThreadProcessId(GetForegroundWindow(),out pid);var g=new GuiInfo{size=Marshal.SizeOf(typeof(GuiInfo))};return GetGUIThreadInfo(tid,ref g)?g.focus:IntPtr.Zero;}
  static bool SameTarget() {return GetForegroundWindow()==target&&targetFocus!=IntPtr.Zero&&FocusWindow()==targetFocus;}
  static bool IsComposing() {
    uint pid;var tid=GetWindowThreadProcessId(GetForegroundWindow(),out pid);var g=new GuiInfo{size=Marshal.SizeOf(typeof(GuiInfo))};
    if(!GetGUIThreadInfo(tid,ref g))return false;var c=ImmGetContext(g.focus);if(c==IntPtr.Zero)return false;
    try{return ImmGetCompositionString(c,8,IntPtr.Zero,0)>0;}finally{ImmReleaseContext(g.focus,c);}
  }
  static Point Anchor() {
    uint pid;var tid=GetWindowThreadProcessId(target,out pid);var g=new GuiInfo{size=Marshal.SizeOf(typeof(GuiInfo))};
    if(GetGUIThreadInfo(tid,ref g)&&g.caret!=IntPtr.Zero){var p=new Point{x=g.rect.left,y=g.rect.bottom};if(ClientToScreen(g.caret,ref p))return p;}
    Point point;GetCursorPos(out point);return point;
  }
  static IntPtr Keyboard(int code,IntPtr message,IntPtr data) {
    if(code>=0) {
      var k=(KeyData)Marshal.PtrToStructure(data,typeof(KeyData));int key=(int)k.key;bool up=message.ToInt32()==0x101||message.ToInt32()==0x105;
      if((k.flags&0x10)!=0
#if SLASH_TEST
        &&k.extra.ToUInt64()!=0x50445445
#endif
      )return CallNextHookEx(keyboardHook,code,message,data);
      if(up&&swallowed.Remove(key))return new IntPtr(1);
      // Never open a delayed popup over new input. Let this key reach its real target.
      if(acquiring){if(!up)Cancel();return CallNextHookEx(keyboardHook,code,message,data);}
      if(!up) {
        if(visible&&!palette&&(!SameTarget()||DateTime.UtcNow.Ticks-Interlocked.Read(ref lastVerified)>TimeSpan.TicksPerSecond*2))Cancel();
        if(visible&&!palette&&!busy) {
          if(!ime&&!IsComposing()&&!Down(17)&&!Down(18)&&!Down(91)&&!Down(92)&&!Down(16)) {
            string action=key==27?"Escape":key==38?"ArrowUp":key==40?"ArrowDown":key==39?"ArrowRight":key==37?"ArrowLeft":key==(confirm=="Enter"?13:9)?confirm:null;
            if(action!=null){Emit(new{type="key",session=serial,key=action});swallowed.Add(key);return new IntPtr(1);}
          }
          if(key==13||key==9||key==36||key==35||key==33||key==34||Down(17)||Down(18)||Down(91)||Down(92))Cancel();
          wake.Set();
        }
      }
    }
    return CallNextHookEx(keyboardHook,code,message,data);
  }
  static IntPtr Mouse(int code,IntPtr message,IntPtr data) {
    if(code>=0&&acquiring&&(message.ToInt32()==0x201||message.ToInt32()==0x204||message.ToInt32()==0x207||message.ToInt32()==0x20a))Cancel();
    if(code>=0&&visible&&!palette&&(message.ToInt32()==0x201||message.ToInt32()==0x204||message.ToInt32()==0x207||message.ToInt32()==0x20a)){
      var m=(MouseData)Marshal.PtrToStructure(data,typeof(MouseData));
      if(m.pt.x<popupLeft||m.pt.x>=popupRight||m.pt.y<popupTop||m.pt.y>=popupBottom)Cancel();
    }
    return CallNextHookEx(mouseHook,code,message,data);
  }
  static TextPatternRange Caret(AutomationElement e) {
    object o;if(!e.TryGetCurrentPattern(TextPattern.Pattern,out o))return null;
    var ranges=((TextPattern)o).GetSelection();if(ranges.Length!=1)return null;
    var r=ranges[0];if(r.CompareEndpoints(TextPatternRangeEndpoint.Start,r,TextPatternRangeEndpoint.End)!=0)return null;return r;
  }
  static string Before(TextPatternRange r) {var left=r.Clone();left.MoveEndpointByUnit(TextPatternRangeEndpoint.Start,TextUnit.Character,-256);return left.GetText(512);}
  static bool Split(string text,out string before,out string match) {
    int pos=text.LastIndexOf(trigger,StringComparison.Ordinal);before="";match="";
    if(pos<0||pos>0&&!Char.IsWhiteSpace(text[pos-1]))return false;
    match=text.Substring(pos);if(match.Length>100||match.IndexOfAny(new[]{'\r','\n','\t'})>=0)return false;
    before=text.Substring(Math.Max(0,pos-32),Math.Min(32,pos));return true;
  }
  static void Unsupported() {
    var name=AppName(target);if(name.Length==0||name==lastUnsupportedApp)return;
    lastUnsupportedApp=name;Emit(new{type="unsupported",app=name});
  }
  // A freshly focused control may not expose its caret on the first UIA read.
  // Keep the original native target pinned, re-read UIA, and require two matching
  // samples before showing (and focusing) the search popup. No text is changed.
  static bool AcquirePalette(int g,out AutomationElement e,out TextPatternRange range,out string reason) {
    e=null;range=null;reason="caret-unavailable";
    var clock=Stopwatch.StartNew();TextPatternRange previous=null;string pinnedId="";int attempts=0;
    acquiring=true;
#if SLASH_TEST
    Emit(new{type="acquisition-start"});
#endif
    try {
      do {
        if(g!=generation){reason="cancelled";return false;}
        if(!SameTarget()){reason="target-changed";return false;}
        attempts++;
        try {
          var current=AutomationElement.FocusedElement;
          if(current!=null) {
            if(current.Current.IsPassword||!current.Current.IsEnabled){reason="protected-control";return false;}
            if(current.Current.HasKeyboardFocus) {
              string currentId=Id(current);
              // Once a focused element is observed, never switch to another one.
              if(pinnedId.Length>0&&pinnedId!=currentId){reason="element-changed";return false;}
              pinnedId=currentId;e=current;
              object value;bool readOnly=current.TryGetCurrentPattern(ValuePattern.Pattern,out value)&&((ValuePattern)value).Current.IsReadOnly;
              var caret=readOnly?null:Caret(current);
              // Rich text providers may expose TextPattern without ValuePattern.
              if(caret!=null){var attribute=caret.GetAttributeValue(TextPattern.IsReadOnlyAttribute);if(attribute is bool&&(bool)attribute){readOnly=true;caret=null;}}
#if SLASH_TEST
              if(testMissingCaretReads>0){testMissingCaretReads--;caret=null;}
#endif
              reason=readOnly?"read-only":caret==null?"caret-unavailable":"caret-unstable";
              if(caret!=null&&!IsComposing()) {
                if(previous!=null&&caret.Compare(previous)&&g==generation&&SameTarget()&&clock.ElapsedMilliseconds<=PaletteAcquireMs) {
                  range=caret;reason="";return true;
                }
                previous=caret.Clone();
              } else {previous=null;if(IsComposing())reason="composing";}
              // A confirmed read-only control cannot become editable by waiting.
              if(readOnly)break;
            } else {previous=null;reason="focus-not-ready";}
          } else {previous=null;reason="focus-not-ready";}
        } catch(ElementNotAvailableException) {previous=null;reason="focus-not-ready";}
          catch(InvalidOperationException) {previous=null;reason="caret-unavailable";}
          catch(COMException) {previous=null;reason="caret-unavailable";}
        if(g!=generation){reason="cancelled";return false;}
        if(!SameTarget()){reason="target-changed";return false;}
        int remaining=PaletteAcquireMs-(int)clock.ElapsedMilliseconds;
        if(remaining<=0)break;
        Thread.Sleep(Math.Min(PalettePollMs,remaining));
      } while(clock.ElapsedMilliseconds<PaletteAcquireMs);
      // Safe fallback only: this session may copy, but cannot commit a paste.
      return g==generation&&SameTarget();
    } finally {
      acquiring=false;
#if SLASH_TEST
      Emit(new{type="acquisition-result",attempts=attempts,ready=range!=null,reason=reason,elapsedMs=clock.ElapsedMilliseconds});
#endif
    }
  }
  static void Start(bool manual) {
    // Retain the proven acquisition/commit routines, but expose only the hotkey entry.
    if(!manual)return;
    int startGeneration=generation;
    target=GetForegroundWindow();targetFocus=FocusWindow();if(!Allowed(target)||targetFocus==IntPtr.Zero)return;
    AutomationElement e;TextPatternRange r;string copyReason="";
    if(manual) {
      if(!AcquirePalette(startGeneration,out e,out r,out copyReason))return;
    } else {
      e=AutomationElement.FocusedElement;if(e==null||e.Current.IsPassword||!e.Current.IsEnabled)return;
      object v;bool readOnly=e.TryGetCurrentPattern(ValuePattern.Pattern,out v)&&((ValuePattern)v).Current.IsReadOnly;
      if(readOnly){Unsupported();return;}
      if(e.Current.ControlType!=ControlType.Edit&&e.Current.ControlType!=ControlType.Document&&e.Current.ControlType!=ControlType.ComboBox){Unsupported();return;}
      r=Caret(e);if(r==null){Unsupported();return;}
    }
#if SLASH_TEST
    if(e!=null){var patterns=new List<string>();foreach(var item in e.GetSupportedPatterns())patterns.Add(item.ProgrammaticName);Emit(new{type="diagnostic",control=e.Current.ControlType.ProgrammaticName,focus=e.Current.HasKeyboardFocus,patterns=patterns});}
#endif
    string found="",pre="";
    // Symbols already in the target are ordinary text, never a replacement range.
    bool hasTrigger=false;
    if(!manual&&!hasTrigger)return;
    if(startGeneration!=generation||!SameTarget()||(!manual&&!e.Current.HasKeyboardFocus))return;
    if(manual&&e!=null&&!e.Current.HasKeyboardFocus){r=null;hasTrigger=false;copyReason="focus-not-ready";}
    if(!hasTrigger){found="";pre="";}
    identity=e==null?"":Id(e);element=e;prefix=pre;token=found;lastQuery=hasTrigger?found.Substring(trigger.Length):"";paletteRange=manual?r:null;palette=manual;
    lastUnsupportedApp="";
    Interlocked.Exchange(ref lastVerified,DateTime.UtcNow.Ticks);
    serial++;visible=true;ime=IsComposing();var p=Anchor();
    Emit(new{type="query",session=serial,query=lastQuery,palette=manual,copyOnly=manual&&r==null,copyReason=copyReason,x=p.x,y=p.y});
  }
  static void Poll() {
    if(!visible||palette||busy)return;
    if(!SameTarget()){Cancel();return;}
    var e=AutomationElement.FocusedElement;if(e==null||e.Current.IsPassword||!e.Current.HasKeyboardFocus||Id(e)!=identity){Cancel();return;}
    ime=IsComposing();if(ime){Interlocked.Exchange(ref lastVerified,DateTime.UtcNow.Ticks);return;}
    var r=Caret(e);string pre,found;if(r==null||!Split(Before(r),out pre,out found)||pre!=prefix){Cancel();return;}
    token=found;var query=found.Substring(trigger.Length);
    Interlocked.Exchange(ref lastVerified,DateTime.UtcNow.Ticks);
    if(query!=lastQuery){lastQuery=query;Emit(new{type="query",session=serial,query=query,palette=false,copyOnly=false});}
  }
  static bool Paste() {
    var events=new[]{new Input{type=1,key=17},new Input{type=1,key=86},new Input{type=1,key=86,flags=2},new Input{type=1,key=17,flags=2}};
    return SendInput(4,events,Marshal.SizeOf(typeof(Input)))==4;
  }
  static bool ReadyForCommit(int g,long expires,AutomationElement e) {
    return g==generation&&DateTime.UtcNow.Ticks<=expires&&SameTarget()&&e.Current.HasKeyboardFocus
      &&!Down(1)&&!Down(2)&&!Down(4)&&!Down(17)&&!Down(18)&&!Down(16)&&!Down(91)&&!Down(92)&&!IsComposing();
  }
  static bool WaitForMouseRelease(int g,long expires) {
    while(Down(1)||Down(2)||Down(4)){
      if(g!=generation||DateTime.UtcNow.Ticks>expires)return false;Thread.Sleep(15);
    }
    // A mouse-up can still update the external editor's selection asynchronously.
    Thread.Sleep(35);return g==generation&&DateTime.UtcNow.Ticks<=expires;
  }
  static bool SelectionMatches(AutomationElement e,TextPatternRange expected,string text) {
    object pattern;if(!e.TryGetCurrentPattern(TextPattern.Pattern,out pattern))return false;
    var selected=((TextPattern)pattern).GetSelection();
    return selected.Length==1&&selected[0].Compare(expected)&&selected[0].GetText(-1)==text;
  }
  static bool ConfirmSelection(AutomationElement e,TextPatternRange expected,string text,int g,long expires) {
    long until=Math.Min(expires,DateTime.UtcNow.AddMilliseconds(500).Ticks);int stable=0;
    while(DateTime.UtcNow.Ticks<=until){
      Thread.Sleep(30);
      if(!ReadyForCommit(g,expires,e))return false;
      stable=SelectionMatches(e,expected,text)?stable+1:0;
      if(stable>=2)return true;
    }
    return false;
  }
  static void Commit(Dictionary<string,object> command) {
    int s; if(!Int32.TryParse(Str(command,"session"),out s)||s!=serial||!visible)return;
    busy=true;int g=generation;long expires=Convert.ToInt64(command["expires"]);bool ok=false;string reason="输入位置已变化，内容已复制，请手动粘贴。";
    try {
      if(!WaitForMouseRelease(g,expires))return;
      if(palette) {if(!SetForegroundWindow(target)&&GetForegroundWindow()!=target)return;Thread.Sleep(100);}
      if(!SameTarget()||!Allowed(target))return;
      var e=AutomationElement.FocusedElement;if(e==null||e.Current.IsPassword||!e.Current.HasKeyboardFocus||Id(e)!=identity||IsComposing())return;
      var r=Caret(e);if(r==null)return;
      if(palette&& (paletteRange==null||!r.Compare(paletteRange)))return;
      bool replaceTrigger=token.Length>0;
      if(replaceTrigger) {
        string pre,found;if(!Split(Before(r),out pre,out found)||pre!=prefix||found!=token||(!palette&&found.Substring(trigger.Length)!=Str(command,"query")))return;
        r.MoveEndpointByUnit(TextPatternRangeEndpoint.Start,TextUnit.Character,-found.Length);
        if(r.GetText(-1)!=found)return;
      }
      if(!ReadyForCommit(g,expires,e))return;
      // Select the verified range; never erase using an estimated number of Backspaces.
      if(replaceTrigger){
        r.Select();
        if(!ConfirmSelection(e,r,token,g,expires)){reason="输入框没有确认选中触发词，已停止自动粘贴。Prompt 已复制，请手动选中触发词后粘贴。";return;}
      }
      if(!ReadyForCommit(g,expires,e))return;
      if(replaceTrigger&&!SelectionMatches(e,r,token))return;
      ok=Paste();reason=ok?"":"系统未接受粘贴，内容已复制，请手动粘贴。";
    } catch {reason="该输入框暂不支持自动替换，内容已复制，请手动粘贴。";}
    finally {Cancel();Emit(new{type="result",session=s,ok=ok,message=reason});}
  }
  static void Worker() {
    int observed=generation;
    while(running) {
      wake.WaitOne(visible?90:500);
      try {
        Dictionary<string,object> c=null;lock(commandLock){if(commands.Count>0)c=commands.Dequeue();if(commands.Count>0)wake.Set();}
        if(c!=null) {
          string type=Str(c,"type");
          if(type=="palette"){Cancel();Start(true);}
#if SLASH_TEST
          else if(type=="test-acquisition"){testMissingCaretReads=Convert.ToInt32(c["misses"]);Emit(new{type="test-acquisition-ready"});}
#endif
          else if(type=="commit")Commit(c);
          else if(type=="config") {Cancel();confirm=Str(c,"confirm");}
          else if(type=="cancel")Cancel();
        }
        if(observed!=generation){observed=generation;if(!visible){element=null;paletteRange=null;identity="";prefix="";token="";lastQuery="";Emit(new{type="closed",session=serial});}}
#if SLASH_TEST
      } catch (Exception error) {
        Emit(new{type="diagnostic-error",message=error.Message});
#else
      } catch {
#endif
        Cancel();}
    }
  }
  [STAThread] public static int Main(string[] args) {
    if(args.Length<1||!Int32.TryParse(args[0],out owner))return 2;
    Console.InputEncoding=Encoding.UTF8;Console.OutputEncoding=new UTF8Encoding(false);SetProcessDPIAware();
    var worker=new Thread(Worker){IsBackground=true};worker.SetApartmentState(ApartmentState.MTA);worker.Start();
    var reader=new Thread(()=>{string line;while((line=Console.ReadLine())!=null){try{var c=json.Deserialize<Dictionary<string,object>>(line);if(Str(c,"type")=="cancel"){Cancel();continue;}if(Str(c,"type")=="bounds"){popupLeft=Convert.ToInt32(c["x"]);popupTop=Convert.ToInt32(c["y"]);popupRight=popupLeft+Convert.ToInt32(c["width"]);popupBottom=popupTop+Convert.ToInt32(c["height"]);}else{if(Str(c,"type")=="commit")c["expires"]=DateTime.UtcNow.AddMilliseconds(1400).Ticks;lock(commandLock)commands.Enqueue(c);wake.Set();}}catch{}}Environment.Exit(0);}){IsBackground=true};reader.Start();
    keyboardHook=SetWindowsHookEx(13,keyboardProc,GetModuleHandle(null),0);mouseHook=SetWindowsHookEx(14,mouseProc,GetModuleHandle(null),0);
    if(keyboardHook==IntPtr.Zero||mouseHook==IntPtr.Zero){Emit(new{type="error",message="输入监听启动失败"});return 1;}
    var watchdog=new System.Windows.Forms.Timer{Interval=400};watchdog.Tick+=(s,e)=>{if(visible&&!palette&&DateTime.UtcNow.Ticks-Interlocked.Read(ref lastVerified)>TimeSpan.TicksPerSecond*2)Cancel();};watchdog.Start();
    Emit(new{type="ready"});Application.Run();running=false;UnhookWindowsHookEx(keyboardHook);UnhookWindowsHookEx(mouseHook);return 0;
  }
}
