; IV Studio's installer in its own colours (electron-builder includes this file by name).
; The welcome and finish pages and the strip along the top of every page use the app's near-black and cream;
; the middle of each page is drawn by Windows and keeps its own colours. The artwork (installerSidebar.bmp,
; uninstallerSidebar.bmp, installerHeader.bmp) is made by build/installer-art.py from the app's eye art.

!define MUI_BGCOLOR "100C0E"
!define MUI_TEXTCOLOR "F4ECDC"

; A welcome page before the install choices, with the eye down the side.
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to IV Studio"
  !define MUI_WELCOMEPAGE_TEXT "Make films with MiniMax H3 on your own computer or your own cloud: hunt a few takes, pick the one you like and finish it at full size.$\r$\n$\r$\nYour projects, renders and settings are kept when you update.$\r$\n$\r$\nClick Next to continue."
  !insertmacro MUI_PAGE_WELCOME
!macroend

; electron-builder's own finish page (its StartApp and "Run IV Studio"), plus one thing: Windows draws a themed
; checkbox's label in its own black, unreadable on the dark page. Taking the theme off that one checkbox lets it
; take the page's cream text on near-black.
!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartApp
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW ivFinishShow
  !endif
  !insertmacro MUI_PAGE_FINISH
  !ifndef HIDE_RUN_AFTER_FINISH
    ; after MUI_PAGE_FINISH, which declares $mui.FinishPage.Run
    Function ivFinishShow
      Push $0
      StrCpy $0 $mui.FinishPage.Run
      System::Call 'uxtheme::SetWindowTheme(p r0, w " ", w " ")'
      SetCtlColors $0 "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
      Pop $0
    FunctionEnd
  !endif
!macroend

; An update first runs the old version's uninstaller, which moves every old file out of the install folder. If any
; file there is in use (an antivirus scan, IV Studio's MCP server started again by Claude Desktop or Codex, an ffmpeg
; still finishing) it puts the files back and stops with code 2, and the installer used to stop too, with "Failed to
; uninstall old application files ... : 2" (GitHub #45). Now it closes everything running from the install folder,
; waits, and tries the old uninstaller once more; if that still can't, it installs over the old files instead of
; stopping (the old uninstaller has put its files back, so nothing is missing). The two macros replace
; electron-builder's own check of the uninstaller's result (installUtil.nsh handleUninstallResult).
!macro ivUninstallCheck
  ${if} ${Errors}
    DetailPrint `Uninstall was not successful. Not able to launch uninstaller!`
  ${elseif} $R0 != 0
    DetailPrint `The old version's uninstaller stopped (code $R0): something in "$INSTDIR" is in use. Closing what runs from there and trying again.`
    Push $0
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -C "Get-CimInstance -ClassName Win32_Process | ? {$$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase')} | % { Stop-Process -Id $$_.ProcessId -Force }"`
    Pop $0
    Pop $0
    Sleep 2000
    ClearErrors
    Push $rootKey_uninstallResult
    Call uninstallOldVersion
    ${if} ${Errors}
    ${orif} $R0 != 0
      DetailPrint `The old version's files are still in use (code $R0): installing over them.`
      ClearErrors
    ${endif}
  ${endif}
!macroend
!macro customUnInstallCheck
  !insertmacro ivUninstallCheck
!macroend
!macro customUnInstallCheckCurrentUser
  !insertmacro ivUninstallCheck
!macroend
