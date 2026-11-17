; IBRA VPN — stop the engine before install/uninstall and make sure the system proxy is not left on.
!macro customInit
  nsExec::Exec 'taskkill /F /IM sing-box.exe /T'
!macroend

!macro customUnInstall
  nsExec::Exec 'taskkill /F /IM sing-box.exe /T'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Internet Settings" "ProxyEnable" 0
!macroend
