; IBRA VPN — installer extras.
; 1) stop the engine before install/uninstall and make sure the system proxy is not left on
; 2) ask: full (whole PC) or browsers only — saved to HKCU\Software\IBRA VPN\InstallMode for the app

!macro customInit
  nsExec::Exec 'taskkill /F /IM sing-box.exe /T'
!macroend

!ifndef BUILD_UNINSTALLER
  !include nsDialogs.nsh
  !include LogicLib.nsh
  Var IbraMode
  Var IbraRadioFull
  Var IbraRadioBrowser

  !macro customPageAfterChangeDir
    Page custom IbraModePage IbraModeLeave
  !macroend

  Function IbraModePage
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 14u "اختر طريقة تنصيب IBRA VPN:"
    Pop $0
    ${NSD_CreateRadioButton} 6u 20u 100% 14u "كامل — VPN لكل الحاسبة"
    Pop $IbraRadioFull
    ${NSD_CreateLabel} 20u 35u 92% 22u "كل البرامج والمتصفحات والتليكرام والألعاب تشتغل عبر الـ VPN. (مستحسن)"
    Pop $0
    ${NSD_CreateRadioButton} 6u 64u 100% 14u "للمتصفحات فقط — إضافة المتصفح"
    Pop $IbraRadioBrowser
    ${NSD_CreateLabel} 20u 79u 92% 30u "الـ VPN يشتغل داخل المتصفح بس (كروم، إيدج، برايف، أوبرا، فايرفوكس) وتتحكم بيه من زر الإضافة. باقي الحاسبة تبقى طبيعية."
    Pop $0
    ${NSD_CreateLabel} 0 116u 100% 22u "تگدر تغيّر الاختيار بعدين من البرنامج: طريقة العمل."
    Pop $0
    ${If} $IbraMode == ""
      ReadRegStr $IbraMode HKCU "Software\IBRA VPN" "InstallMode"
    ${EndIf}
    ${If} $IbraMode == "browser"
      ${NSD_Check} $IbraRadioBrowser
    ${Else}
      ${NSD_Check} $IbraRadioFull
    ${EndIf}
    nsDialogs::Show
  FunctionEnd

  Function IbraModeLeave
    ${NSD_GetState} $IbraRadioBrowser $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $IbraMode "browser"
    ${Else}
      StrCpy $IbraMode "full"
    ${EndIf}
  FunctionEnd

  !macro customInstall
    ${If} $IbraMode != ""
      WriteRegStr HKCU "Software\IBRA VPN" "InstallMode" "$IbraMode"
    ${EndIf}
  !macroend
!endif

!macro customUnInstall
  nsExec::Exec 'taskkill /F /IM sing-box.exe /T'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Internet Settings" "ProxyEnable" 0
  nsExec::Exec 'schtasks /delete /tn "IBRA VPN Admin" /f'
!macroend
