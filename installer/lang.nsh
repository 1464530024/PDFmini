; PDFmini 安装器扩展：
; 1) 把安装时选择的界面语言写入安装目录下的 lang.txt，
;    主程序首次启动时读取它作为默认界面语言（之后用户可在应用内切换）。
; 2) 支持命令行 /LANG=2052|1033 指定语言（静默安装时也能选择语言）。
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!insertmacro GetParameters
!insertmacro GetOptions

; 在语言选择对话框之前解析 /LANG= 参数
!macro preInit
  ${GetParameters} $R0
  ${GetOptions} $R0 "/LANG=" $R1
  ${IfNot} ${Errors}
    ${If} $R1 != ""
      StrCpy $LANGUAGE $R1
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  ${If} $LANGUAGE == "2052"
    FileOpen $9 "$INSTDIR\lang.txt" w
    FileWrite $9 "zh-CN"
    FileClose $9
  ${ElseIf} $LANGUAGE == "1033"
    FileOpen $9 "$INSTDIR\lang.txt" w
    FileWrite $9 "en-US"
    FileClose $9
  ${Else}
    ; 其它语言统一按英语界面
    FileOpen $9 "$INSTDIR\lang.txt" w
    FileWrite $9 "en-US"
    FileClose $9
  ${EndIf}
!macroend
