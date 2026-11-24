; AHI's Start menu entry, on every install and update (electron-builder includes build/installer.nsh by itself):
; it skips the entry on an update when an earlier one was removed, and the field report (Windows) found none at all.
!macro customInstall
  ${ifNot} ${FileExists} "$newStartMenuLink"
    CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  ${endIf}
!macroend
