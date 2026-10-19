using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
class SlashTestHost {
  static Form form; static RichTextBox editor; static TextBox other,password;
  static bool rejectSelection; static uint popupOwner;
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr w);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint first,uint second,bool attach);
  [DllImport("user32.dll")] static extern uint SendInput(uint count,Input[] inputs,int size);
  [StructLayout(LayoutKind.Explicit,Size=40)] struct Input { [FieldOffset(0)] public uint type; [FieldOffset(8)] public ushort key; [FieldOffset(12)] public uint flags; [FieldOffset(24)] public UIntPtr extra; }
  static void Emit(object value){Console.WriteLine(new JavaScriptSerializer().Serialize(value));}
  static void NewEditor(){
    if(editor!=null){form.Controls.Remove(editor);editor.Dispose();}
    editor=new RichTextBox{Left=20,Top=20,Width=590,Height=200};form.Controls.Add(editor);
    editor.KeyDown+=(s,e)=>Emit(new{inputKey="down",key=e.KeyCode.ToString(),control=e.Control,alt=e.Alt,shift=e.Shift,foreground=GetForegroundWindow()==form.Handle});
    editor.KeyUp+=(s,e)=>Emit(new{inputKey="up",key=e.KeyCode.ToString(),control=e.Control,alt=e.Alt,shift=e.Shift,foreground=GetForegroundWindow()==form.Handle});
    editor.SelectionChanged+=(s,e)=>{if(rejectSelection&&editor.SelectionLength>0){editor.SelectionStart+=editor.SelectionLength;editor.SelectionLength=0;}};
  }
  [STAThread] static void Main(string[] args){
    if(args.Length>0)UInt32.TryParse(args[0],out popupOwner);
    Console.InputEncoding=System.Text.Encoding.UTF8; Console.OutputEncoding=new System.Text.UTF8Encoding(false);
    form=new Form{Text="Prompt Dock — isolated input regression test",Width=650,Height=400};
    NewEditor();other=new TextBox{Left=20,Top=240,Width=590};password=new TextBox{Left=20,Top=290,Width=590,UseSystemPasswordChar=true};
    form.Controls.AddRange(new Control[]{other,password});
    form.Shown+=(s,e)=>{editor.Focus();Emit(new{ready=true});};
    var reader=new Thread(()=>{string line;while((line=Console.ReadLine())!=null){var c=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(line);form.BeginInvoke((Action)(()=>{
      var op=Convert.ToString(c["type"]);var id=Convert.ToInt32(c["id"]);
      if(op=="close"){form.Close();return;}
      if(op=="selectionPolicy")rejectSelection=Convert.ToString(c["mode"])=="reject";
      if(op=="set"){
        if(c.ContainsKey("fresh")&&Convert.ToBoolean(c["fresh"]))NewEditor();
        var kind=c.ContainsKey("kind")?Convert.ToString(c["kind"]):"rich";
        TextBoxBase field=kind=="password"?(TextBoxBase)password:kind=="other"?(TextBoxBase)other:editor;
        field.ReadOnly=c.ContainsKey("readOnly")&&Convert.ToBoolean(c["readOnly"]);
        string nextText=Convert.ToString(c["text"]);if(field.Text!=nextText)field.Text=nextText;
        field.SelectionStart=c.ContainsKey("caret")?Convert.ToInt32(c["caret"]):field.Text.Length;field.SelectionLength=c.ContainsKey("length")?Convert.ToInt32(c["length"]):0;
        // Test-only activation: Windows may deny focus to a newly spawned console host.
        // Attach only while activating this dedicated test form; never used in the app.
        uint pid;uint foregroundThread=GetWindowThreadProcessId(GetForegroundWindow(),out pid),thisThread=GetCurrentThreadId();
        bool attached=foregroundThread!=thisThread&&foregroundThread!=0&&AttachThreadInput(thisThread,foregroundThread,true);
        try{form.Activate();form.BringToFront();SetForegroundWindow(form.Handle);form.ActiveControl=field;field.Select();field.Focus();}
        finally{if(attached)AttachThreadInput(thisThread,foregroundThread,false);}
      }
      if(op=="clipboard")Clipboard.SetText(Convert.ToString(c["text"]));
      if(op=="hotkey"&&GetForegroundWindow()==form.Handle){
        ushort[] keys={17,18,16,121};var inputs=new List<Input>();
        foreach(var key in keys)inputs.Add(new Input{type=1,key=key});
        for(int i=keys.Length-1;i>=0;i--)inputs.Add(new Input{type=1,key=keys[i],flags=2});
        SendInput((uint)inputs.Count,inputs.ToArray(),Marshal.SizeOf(typeof(Input)));
      }
      if(op=="key"&&GetForegroundWindow()==form.Handle){ushort key=Convert.ToUInt16(c["key"]);SendInput(2,new[]{new Input{type=1,key=key,extra=new UIntPtr(0x50445445)},new Input{type=1,key=key,flags=2,extra=new UIntPtr(0x50445445)}},Marshal.SizeOf(typeof(Input)));}
      if(op=="popupKey"){
        uint activePid;GetWindowThreadProcessId(GetForegroundWindow(),out activePid);
        IntPtr expected=new IntPtr(Convert.ToInt64(c["window"]));
        if(popupOwner==0||GetForegroundWindow()!=expected){Emit(new{id=id,refused=true});return;}
        ushort key=Convert.ToUInt16(c["key"]);string phase=c.ContainsKey("phase")?Convert.ToString(c["phase"]):"both";var keys=new List<Input>();
        if(phase!="up")keys.Add(new Input{type=1,key=key,extra=new UIntPtr(0x50445445)});
        if(phase!="down")keys.Add(new Input{type=1,key=key,flags=2,extra=new UIntPtr(0x50445445)});
        SendInput((uint)keys.Count,keys.ToArray(),Marshal.SizeOf(typeof(Input)));
      }
      uint foregroundPid;GetWindowThreadProcessId(GetForegroundWindow(),out foregroundPid);
      string foregroundName="";try{foregroundName=System.Diagnostics.Process.GetProcessById((int)foregroundPid).ProcessName;}catch{}
      Emit(new{id=id,text=editor.Text,other=other.Text,foreground=GetForegroundWindow()==form.Handle,foregroundPid=foregroundPid,foregroundName=foregroundName,foregroundWindow=GetForegroundWindow().ToInt64().ToString(),caret=editor.SelectionStart,length=editor.SelectionLength,focus=form.ActiveControl==other?"other":form.ActiveControl==password?"password":"rich"});
    }));}}){IsBackground=true};reader.Start();Application.Run(form);
  }
}
