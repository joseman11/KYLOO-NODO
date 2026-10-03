; Instalador de Nodo {{VERSION}} para Windows (NSIS). Lo genera build.mjs; no se edita a mano.
Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"

Name "Nodo {{VERSION}}"
OutFile "{{OUT}}"
InstallDir "$PROGRAMFILES64\Nodo"
InstallDirRegKey HKLM "Software\Kyloo\Nodo" "InstallDir"
RequestExecutionLevel admin
BrandingText "Nodo · by Kyloo"
SetCompressor /SOLID lzma

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_TITLE "Nodo está instalado"
!define MUI_FINISHPAGE_TEXT "Nodo ya funciona como servicio de Windows y arranca solo con el equipo.$\r$\n$\r$\nAbre http://localhost:3003 en este equipo, o http://<IP de este equipo>:3003 desde las tablets.$\r$\n$\r$\nLos datos se guardan en C:\ProgramData\Nodo y no se tocan al actualizar."
!define MUI_FINISHPAGE_RUN "http://localhost:3003"
!define MUI_FINISHPAGE_RUN_TEXT "Abrir Nodo ahora"
!define MUI_FINISHPAGE_RUN_FUNCTION OpenNodo

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Spanish"

Function OpenNodo
  ExecShell "open" "http://localhost:3003"
FunctionEnd

Section "Nodo" SecMain
  SetOutPath "$INSTDIR"
  ; Una actualización: se detiene el servicio antes de reemplazar archivos (los datos viven en ProgramData y no se tocan)
  nsExec::ExecToLog 'net stop NodoServer'
  File /r "{{PKG}}\*.*"
  ; install.ps1 registra el servicio, abre el firewall, arranca y espera a que responda
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\install.ps1" -InstallDir "$INSTDIR" -NoBrowser'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "No se pudo dejar Nodo funcionando (código $0). Revisa los registros en C:\ProgramData\Nodo\logs"
    Abort
  ${EndIf}
  WriteUninstaller "$INSTDIR\Desinstalar.exe"
  WriteRegStr HKLM "Software\Kyloo\Nodo" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nodo" "DisplayName" "Nodo"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nodo" "DisplayVersion" "{{VERSION}}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nodo" "Publisher" "Kyloo"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nodo" "UninstallString" '"$INSTDIR\Desinstalar.exe"'
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nodo" "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nodo" "NoRepair" 1
SectionEnd

Section "Uninstall"
  ; uninstall.ps1 detiene y quita el servicio y el firewall; los datos se conservan
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\uninstall.ps1" -InstallDir "$INSTDIR"'
  Delete "$INSTDIR\Desinstalar.exe"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Nodo"
  DeleteRegKey HKLM "Software\Kyloo\Nodo"
SectionEnd
