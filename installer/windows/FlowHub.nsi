Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WinVer.nsh"

!ifndef FLOWHUB_DEFINES
  !error "Build using scripts/windows-installer.mjs with a verified native Windows bundle."
!endif
!include "${FLOWHUB_DEFINES}"

Name "MCP FlowHub ${FLOWHUB_VERSION}"
OutFile "${FLOWHUB_OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\MCP-FlowHub"
InstallDirRegKey HKCU "Software\MCP-FlowHub" "InstallLocation"
RequestExecutionLevel user
ManifestDPIAware true
SetCompressor /SOLID lzma
BrandingText "MCP FlowHub — offline release candidate"
ShowInstDetails show
ShowUninstDetails show
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH
!insertmacro MUI_LANGUAGE "English"

Var MutexHandle
Var HelperResult
Var HelperOutput
Var HelperLog

!macro InstallerInit PREFIX
Function ${PREFIX}.onInit
  SetShellVarContext current
  ReadEnvStr $HelperLog "FLOWHUB_INSTALLER_DIAGNOSTICS"
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "FlowHub requires native Windows x64." /SD IDOK
    SetErrorLevel 21
    Quit
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "FlowHub requires Windows 10 or later." /SD IDOK
    SetErrorLevel 21
    Quit
  ${EndIf}
  System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\MCPFlowHubInstaller") p .r0 ?e'
  Pop $1
  StrCpy $MutexHandle $0
  ${If} $1 = 183
    MessageBox MB_OK|MB_ICONSTOP "Another FlowHub installer or uninstaller is running." /SD IDOK
    SetErrorLevel 20
    Quit
  ${EndIf}
  ${If} $MutexHandle = 0
    MessageBox MB_OK|MB_ICONSTOP "Cannot obtain the FlowHub installation lock. No files were changed." /SD IDOK
    SetErrorLevel 21
    Quit
  ${EndIf}
FunctionEnd
!macroend
!insertmacro InstallerInit ""
!insertmacro InstallerInit "un"

!macro CheckHelper
  Pop $HelperResult
  Pop $HelperOutput
  DetailPrint "$HelperOutput"
  ${If} $HelperLog != ""
    FileOpen $9 "$HelperLog" a
    FileWrite $9 "$HelperResult: $HelperOutput$\r$\n"
    FileClose $9
  ${EndIf}
  ${If} $HelperResult != 0
    MessageBox MB_OK|MB_ICONSTOP "$HelperOutput$\r$\nInstallation stopped. Stop FlowHub before retrying; user data is retained." /SD IDOK
    ${If} $HelperResult == 20
      SetErrorLevel 20
    ${Else}
      SetErrorLevel 21
    ${EndIf}
    Quit
  ${EndIf}
!macroend

Section "MCP FlowHub (offline)" SEC_MAIN
  ReadRegStr $0 HKCU "Software\MCP-FlowHub" "InstallLocation"
  ${If} $0 != ""
  ${AndIf} $0 != $INSTDIR
    MessageBox MB_OK|MB_ICONSTOP "FlowHub is already installed at $0. Upgrade that location, or uninstall it before choosing another directory. User data will be retained." /SD IDOK
    SetErrorLevel 21
    Quit
  ${EndIf}
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\helper"
  File /oname=node.exe "${FLOWHUB_BUNDLE}\runtime\node.exe"
  File /oname=install-helper.mjs "${FLOWHUB_HELPER}"
  File /oname=payload-manifest.json "${FLOWHUB_MANIFEST}"
  nsExec::ExecToStack /TIMEOUT=90000 '"$PLUGINSDIR\helper\node.exe" "$PLUGINSDIR\helper\install-helper.mjs" preflight --install-dir "$INSTDIR" --data-dir "$LOCALAPPDATA\MCP-FlowHub"'
  !insertmacro CheckHelper
  SetOutPath "$PLUGINSDIR\payload"
  File /r "${FLOWHUB_BUNDLE}\*"
  nsExec::ExecToStack /TIMEOUT=600000 '"$PLUGINSDIR\helper\node.exe" "$PLUGINSDIR\helper\install-helper.mjs" install --install-dir "$INSTDIR" --data-dir "$LOCALAPPDATA\MCP-FlowHub" --payload-dir "$PLUGINSDIR\payload" --payload-manifest "$PLUGINSDIR\helper\payload-manifest.json" --version "${FLOWHUB_VERSION}"'
  !insertmacro CheckHelper
  SetOutPath "$INSTDIR"
  ClearErrors
  File /oname=flowhub.cmd "${FLOWHUB_LAUNCHER}"
  File /oname=installer-helper.mjs "${FLOWHUB_HELPER}"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  File /oname=NSIS-COPYING.txt "${FLOWHUB_NSIS_LICENSE}"
  File /oname=NSIS-NOTICE.txt "${FLOWHUB_NSIS_NOTICE}"
  WriteRegStr HKCU "Software\MCP-FlowHub" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MCP-FlowHub" "DisplayName" "MCP FlowHub"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MCP-FlowHub" "DisplayVersion" "${FLOWHUB_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MCP-FlowHub" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MCP-FlowHub" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MCP-FlowHub" "QuietUninstallString" '$\"$INSTDIR\Uninstall.exe$\" /S'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MCP-FlowHub" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MCP-FlowHub" "NoRepair" 1
  CreateDirectory "$SMPROGRAMS\MCP FlowHub"
  CreateShortcut "$SMPROGRAMS\MCP FlowHub\Start FlowHub.lnk" "$INSTDIR\app\runtime\node.exe" '$\"$INSTDIR\app\dist\apps\daemon\src\cli.js$\" serve' "$INSTDIR\app\runtime\node.exe" 0 SW_SHOWNORMAL
  WriteINIStr "$SMPROGRAMS\MCP FlowHub\Open management.url" "InternetShortcut" "URL" "http://127.0.0.1:18473/"
  CreateShortcut "$SMPROGRAMS\MCP FlowHub\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "FlowHub files or current-user registration could not be completed. User data is retained; repair using this installer." /SD IDOK
    SetErrorLevel 21
    Quit
  ${EndIf}
  SetErrorLevel 0
SectionEnd

Section "Uninstall"
  InitPluginsDir
  CreateDirectory "$PLUGINSDIR\helper"
  ClearErrors
  CopyFiles /SILENT "$INSTDIR\app\runtime\node.exe" "$PLUGINSDIR\helper\node.exe"
  CopyFiles /SILENT "$INSTDIR\installer-helper.mjs" "$PLUGINSDIR\helper\install-helper.mjs"
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "FlowHub uninstall helper is missing. Repair using the reviewed installer, then retry. User data was retained." /SD IDOK
    SetErrorLevel 21
    Quit
  ${EndIf}
  nsExec::ExecToStack /TIMEOUT=600000 '"$PLUGINSDIR\helper\node.exe" "$PLUGINSDIR\helper\install-helper.mjs" uninstall --install-dir "$INSTDIR" --data-dir "$LOCALAPPDATA\MCP-FlowHub"'
  !insertmacro CheckHelper
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  ReadRegStr $0 HKCU "Software\MCP-FlowHub" "InstallLocation"
  ${If} $0 == $INSTDIR
    Delete "$SMPROGRAMS\MCP FlowHub\Start FlowHub.lnk"
    Delete "$SMPROGRAMS\MCP FlowHub\Open management.url"
    Delete "$SMPROGRAMS\MCP FlowHub\Uninstall.lnk"
    RMDir "$SMPROGRAMS\MCP FlowHub"
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\MCP-FlowHub"
    DeleteRegKey HKCU "Software\MCP-FlowHub"
  ${EndIf}
  DetailPrint "User data retained at $LOCALAPPDATA\MCP-FlowHub. Delete it manually only after reviewing backups and audit retention."
  SetErrorLevel 0
SectionEnd
