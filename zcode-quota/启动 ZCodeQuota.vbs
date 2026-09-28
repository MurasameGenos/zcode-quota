Option Explicit
' 启动 ZCodeQuota（无窗口运行控制器；控制器会拉起带调试端口的 ZCode）
Dim shell, fso, dir, controller, where, nodePath
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
controller = Chr(34) & dir & "\controller.mjs" & Chr(34)
shell.CurrentDirectory = dir

nodePath = ""
On Error Resume Next
where = shell.Exec("cmd /c where node").StdOut.ReadAll
If InStr(where, "node.exe") > 0 Then nodePath = "node"
On Error Goto 0

If nodePath = "node" Then
  shell.Run "node " & controller, 0, False
Else
  ' 没有 node 时，用 ZCode 自带的 Electron 以 Node 模式运行控制器
  Dim zc : zc = "C:\Program Files\ZCode\ZCode.exe"
  If fso.FileExists(zc) Then
    shell.Environment("PROCESS")("ELECTRON_RUN_AS_NODE") = "1"
    shell.Run Chr(34) & zc & Chr(34) & " " & controller, 0, False
  Else
    MsgBox "未找到 node，也未找到 ZCode.exe（C:\Program Files\ZCode\ZCode.exe）。" & vbCrLf & _
           "请安装 Node.js 或修改本文件中的 zc 路径。", 16, "ZCodeQuota"
  End If
End If
