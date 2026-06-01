!macro preInit
  SetRegView 64
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "D:\laojiu\gzxt"
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "D:\laojiu\gzxt"
  SetRegView 32
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "D:\laojiu\gzxt"
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "D:\laojiu\gzxt"
!macroend

!macro customInit
  CreateDirectory "D:\laojiu"

  ${If} $INSTDIR == ""
    StrCpy $INSTDIR "D:\laojiu\gzxt"
  ${ElseIf} $INSTDIR == "D:\laojiu\gzxt\desktop"
    StrCpy $INSTDIR "D:\laojiu\gzxt"
  ${EndIf}
!macroend

!macro customInstall
  CreateDirectory "D:\laojiu\gzdata"
  CreateDirectory "D:\laojiu\gzdata\工资数据"
  CreateDirectory "D:\laojiu\工资导入"
  CreateDirectory "D:\laojiu\工资导入\imported"
  CreateDirectory "D:\laojiu\工资导入\failed"
  CreateDirectory "D:\laojiu\工资导入\templates"
  CreateShortcut "$DESKTOP\工资导入.lnk" "D:\laojiu\工资导入"
  CreateShortcut "$DESKTOP\工资数据.lnk" "D:\laojiu\gzdata\工资数据"
!macroend

!macro customRemoveFiles
  ; 卸载或升级时只删除程序文件，保留工资数据和导入目录。
  FindFirst $R0 $R1 "$INSTDIR\*.*"
  remove_loop:
    StrCmp $R1 "" remove_done
    StrCmp $R1 "." remove_next
    StrCmp $R1 ".." remove_next
    StrCmp $R1 "data" remove_next
    StrCmp $R1 "gzdata" remove_next
    StrCmp $R1 "工资导入" remove_next

    IfFileExists "$INSTDIR\$R1\*.*" remove_dir remove_file
    remove_dir:
      RMDir /r "$INSTDIR\$R1"
      Goto remove_next
    remove_file:
      Delete "$INSTDIR\$R1"

    remove_next:
      FindNext $R0 $R1
      Goto remove_loop

  remove_done:
    FindClose $R0
    RMDir "$INSTDIR"
!macroend
