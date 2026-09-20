; One extra checkbox on the installer's finish page: "Start Flash when Windows
; starts". It writes a marker file and nothing else.
;
; It deliberately does NOT create the Windows startup entry itself. This
; installer is perMachine and runs elevated, so a per-user startup entry written
; from here would land on whichever account accepted the UAC prompt — an
; administrator installing Flash for someone else would give themselves the
; startup entry and give the actual user nothing. The app reads this marker on
; its first run and registers the entry for whoever is really signed in, which
; also means two accounts sharing a PC each get their own.
;
; The marker only ever means "turn it on". Its absence is not "turn it off":
; someone who already enabled autostart and later installs an update without
; ticking the box keeps their setting.

!ifndef FLASH_AUTOSTART_NSH
!define FLASH_AUTOSTART_NSH

!include LogicLib.nsh
!include nsDialogs.nsh

!define FLASH_AUTOSTART_MARKER "$INSTDIR\resources\autostart-requested"

!macro customInstall
  ; Runs after the files are extracted and before the finish page, so a stale
  ; marker from a previous install cannot be read as a fresh request. A silent
  ; install has no finish page and therefore never opts in.
  Delete "${FLASH_AUTOSTART_MARKER}"
  ClearErrors
!macroend

!macro customFinishPage
  ; MUI_FINISHPAGE_RUN is already spoken for by runAfterFinish, so the second
  ; checkbox is the Show Readme one, repurposed. Defining customFinishPage
  ; replaces electron-builder's whole finish-page block including its StartApp
  ; function, so that launch behaviour is reproduced below rather than lost.
  !ifndef HIDE_RUN_AFTER_FINISH
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION FlashFinishStartApp
  !endif

  !define MUI_FINISHPAGE_SHOWREADME
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "Start Flash when Windows starts"
  ; Unticked by default. A pre-ticked box that adds a screen recorder to
  ; someone's startup is not a question, it is an assumption.
  !define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION FlashFinishAutostartNoOp

  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE FlashFinishSaveAutostart
  !insertmacro MUI_PAGE_FINISH

  Function FlashFinishSaveAutostart
    ; MUI replaces both checkboxes with reboot choices when a reboot is
    ; pending, and reading one then would read a radio button instead.
    ${If} ${RebootFlag}
      Return
    ${EndIf}

    Push $0
    ${NSD_GetState} $mui.FinishPage.ShowReadme $0
    ${If} $0 == ${BST_CHECKED}
      ; Written here rather than in the checkbox's own function because MUI
      ; calls LEAVE first and the "run Flash" function second: writing it later
      ; would race Flash starting up and reading it.
      CreateDirectory "$INSTDIR\resources"
      FileOpen $0 "${FLASH_AUTOSTART_MARKER}" w
      ${IfNot} ${Errors}
        FileWrite $0 "1"
        FileClose $0
      ${EndIf}
      ClearErrors
    ${EndIf}
    Pop $0
  FunctionEnd

  Function FlashFinishAutostartNoOp
    ; The marker is written in LEAVE, above. Writing again here could land after
    ; Flash has already started and consumed it.
  FunctionEnd

  !ifndef HIDE_RUN_AFTER_FINISH
    Function FlashFinishStartApp
      ; electron-builder's own launch behaviour, reproduced because defining
      ; customFinishPage replaced it.
      ${If} ${isUpdated}
        StrCpy $1 "--updated"
      ${Else}
        StrCpy $1 ""
      ${EndIf}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd
  !endif
!macroend

!macro customUnInstall
  ; An update runs the old uninstaller too. Cleaning unconditionally here would
  ; delete the marker on every upgrade, which is harmless, but the guard is kept
  ; so the intent is legible: this is uninstall cleanup, not update cleanup.
  ${IfNot} ${isUpdated}
    Delete "${FLASH_AUTOSTART_MARKER}"
    ClearErrors
  ${EndIf}
!macroend

!endif
