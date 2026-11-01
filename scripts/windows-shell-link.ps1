$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
public class FlowHubShellLinkObject { }

[ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IFlowHubShellLinkW {
  void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int length, IntPtr findData, uint flags);
  void GetIDList(out IntPtr list);
  void SetIDList(IntPtr list);
  void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int length);
  void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string value);
  void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int length);
  void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string value);
  void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int length);
  void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string value);
  void GetHotkey(out short value);
  void SetHotkey(short value);
  void GetShowCmd(out int value);
  void SetShowCmd(int value);
  void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int length, out int index);
  void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string path, int index);
  void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
  void Resolve(IntPtr window, uint flags);
  void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
}

public static class FlowHubShellLink {
  public static string[] Read(string path) {
    object instance = new FlowHubShellLinkObject();
    try {
      ((IPersistFile)instance).Load(path, 0);
      var link = (IFlowHubShellLinkW)instance;
      var target = new StringBuilder(32768);
      var arguments = new StringBuilder(32768);
      link.GetPath(target, target.Capacity, IntPtr.Zero, 0);
      link.GetArguments(arguments, arguments.Capacity);
      return new string[] { target.ToString(), arguments.ToString() };
    } finally { Marshal.ReleaseComObject(instance); }
  }
  public static void Create(string path, string target, string arguments) {
    object instance = new FlowHubShellLinkObject();
    try {
      var link = (IFlowHubShellLinkW)instance;
      link.SetPath(target);
      link.SetArguments(arguments);
      ((IPersistFile)instance).Save(path, true);
    } finally { Marshal.ReleaseComObject(instance); }
  }
}
'@

# Creation is used only by the isolated native probe. Installer smoke only reads.
if ($env:FLOWHUB_SHORTCUT_CREATE_TARGET) {
  [FlowHubShellLink]::Create($env:FLOWHUB_SHORTCUT_PATH, $env:FLOWHUB_SHORTCUT_CREATE_TARGET, $env:FLOWHUB_SHORTCUT_CREATE_ARGUMENTS)
}
$values = [FlowHubShellLink]::Read($env:FLOWHUB_SHORTCUT_PATH)
$json = @{target=$values[0];arguments=$values[1]} | ConvertTo-Json -Compress
[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($json))
