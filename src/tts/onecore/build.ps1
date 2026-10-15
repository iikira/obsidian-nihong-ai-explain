# build.ps1 — 用系统自带的 .NET Framework csc 编译 OneCoreTts.cs 为 onecore_tts.exe。
# 运行：在 PowerShell 中执行本脚本（Windows 桌面端，需 .NET Framework 4.x，Win10/11 内置）。
# 产物：onecore_tts.exe（约 5KB），可打包进 Obsidian 插件 dist/。
$ErrorActionPreference = 'Stop'

$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$fx = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319'

# Windows SDK UnionMetadata 里的 Windows.winmd（编译期引用）。优先选各版本目录根下的
# Windows.winmd（完整版，自包含契约），排除 Facade 子目录里的占位版。
$unionRoot = 'C:\Program Files (x86)\Windows Kits\10\UnionMetadata'
if (-not (Test-Path $unionRoot)) {
    throw "未找到 Windows SDK UnionMetadata（需安装 Windows SDK）。"
}
$winmd = Get-ChildItem $unionRoot -Recurse -Filter 'Windows.winmd' |
    Where-Object { $_.FullName -match '\\10\.0\.[^\\]+\\Windows\.winmd$' } |
    Sort-Object FullName -Descending | Select-Object -First 1
if (-not $winmd) {
    throw "未找到 Windows.winmd。"
}
$winmdPath = $winmd.FullName

$src = Join-Path $PSScriptRoot 'OneCoreTts.cs'
$out = Join-Path $PSScriptRoot 'onecore_tts.exe'

$argLine = '/nologo /target:exe /platform:x64 ' +
    '/reference:"' + $fx + '\mscorlib.dll"' +
    ' /reference:"' + $fx + '\System.dll"' +
    ' /reference:"' + $fx + '\System.Core.dll"' +
    ' /reference:"' + $fx + '\System.Runtime.dll"' +
    ' /reference:"' + $fx + '\System.Runtime.InteropServices.WindowsRuntime.dll"' +
    ' /reference:"' + $fx + '\System.Runtime.WindowsRuntime.dll"' +
    ' /reference:"' + $winmdPath + '"' +
    ' /out:"' + $out + '" "' + $src + '"'

$tmp = Join-Path $env:TEMP 'onecore_csc_out.txt'
$p = Start-Process -FilePath $csc -ArgumentList $argLine -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput $tmp -RedirectStandardError "$tmp.err"
if (Test-Path "$tmp.err") { Get-Content "$tmp.err" | ForEach-Object { Write-Output "csc: $_" } }
if ($p.ExitCode -ne 0) {
    throw "csc 编译失败，exit=$($p.ExitCode)"
}
Write-Output ("已生成: " + $out + " (" + (Get-Item $out).Length + " bytes)")
