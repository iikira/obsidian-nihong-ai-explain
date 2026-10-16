# build.ps1 - Compile OneCoreTts.cs into onecore_tts.exe using the system .NET Framework csc.
# Usage: run this script in PowerShell (Windows desktop, requires .NET Framework 4.x, built into Win10/11).
# Output: onecore_tts.exe (~5KB), which gets base64-embedded into the plugin bundle.
$ErrorActionPreference = 'Stop'

$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$fx = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319'

# Windows.winmd from the Windows SDK UnionMetadata (compile-time reference).
# Prefer the Windows.winmd at the root of each version directory (the full,
# self-contained contract) and exclude the placeholder one in the Facade subdir.
$unionRoot = 'C:\Program Files (x86)\Windows Kits\10\UnionMetadata'
if (-not (Test-Path $unionRoot)) {
    throw "Windows SDK UnionMetadata not found (Windows SDK must be installed)."
}
$winmd = Get-ChildItem $unionRoot -Recurse -Filter 'Windows.winmd' |
    Where-Object { $_.FullName -match '\\10\.0\.[^\\]+\\Windows\.winmd$' } |
    Sort-Object FullName -Descending | Select-Object -First 1
if (-not $winmd) {
    throw "Windows.winmd not found."
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
    throw "csc compilation failed, exit=$($p.ExitCode)"
}
Write-Output ("Generated: " + $out + " (" + (Get-Item $out).Length + " bytes)")
