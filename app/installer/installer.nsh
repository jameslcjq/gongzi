!macro preInit
  SetRegView 64
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "D:\laojiu\gzxt\desktop"
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "D:\laojiu\gzxt\desktop"
  SetRegView 32
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "D:\laojiu\gzxt\desktop"
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "D:\laojiu\gzxt\desktop"
!macroend

!macro customInstall
  CreateDirectory "D:\laojiu\gzxt\data"
  CreateDirectory "D:\laojiu\gzxt\data\工资存档"
  CreateDirectory "D:\laojiu\工资导入"
  CreateDirectory "D:\laojiu\工资导入\imported"
  CreateDirectory "D:\laojiu\工资导入\failed"
  CreateDirectory "D:\laojiu\工资导入\templates"
  CreateShortcut "$DESKTOP\工资导入.lnk" "D:\laojiu\工资导入"
!macroend
