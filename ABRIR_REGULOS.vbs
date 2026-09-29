Set shell = CreateObject("WScript.Shell")
base = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = base
shell.Run "cmd.exe /c """ & base & "\INICIAR_REGULOS.bat""", 0, False
Set shell = Nothing
