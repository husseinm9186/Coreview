# Sign every PE under src-tauri/sidecar/ (LT-519, D-060: "sign every PE").
#
#   pwsh sidecar/build/sign.ps1 [-Thumbprint <cert thumbprint>]
#
# Tauri's own signing covers coreview.exe and the installer; it does not
# touch resources, so the interpreter, its DLLs and every .pyd (the wheels'
# native modules come unsigned) are signed here, before `tauri build`
# packs them. A PE that already carries a valid signature (python.org
# signs python.exe and its DLLs) is counter-signed with /as so both
# signatures stand. With no thumbprint, nothing is signed and a notice
# says how many PEs went out unsigned. Timestamped, SHA-256, like the rest.
#
# Azure Trusted Signing replaces the thumbprint with `/dlib` and a metadata
# file; that switch is one argument list below, waiting on the details.
param(
  [string]$Thumbprint = $env:COREVIEW_SIGN_THUMBPRINT,
  [string]$TimestampUrl = "http://timestamp.digicert.com"
)
$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$dir = Join-Path $root "src-tauri\sidecar"
if (-not (Test-Path $dir)) { throw "no sidecar under $dir; run windows.ps1 first" }
$pes = Get-ChildItem -Recurse $dir -Include *.exe, *.dll, *.pyd

if ([string]::IsNullOrWhiteSpace($Thumbprint)) {
  Write-Host "::notice title=Sidecar signing::No certificate configured - $($pes.Count) sidecar PE files are UNSIGNED."
  exit 0
}

$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $signtool) { throw "signtool.exe not found" }

$failed = @()
foreach ($pe in $pes) {
  $before = Get-AuthenticodeSignature $pe.FullName
  $append = @()
  if ($before.Status -eq "Valid") { $append = @("/as") }
  & $signtool.FullName sign /sha1 $Thumbprint /fd sha256 /tr $TimestampUrl /td sha256 @append $pe.FullName | Out-Null
  if ($LASTEXITCODE -ne 0) { $failed += $pe.FullName; continue }
  $after = Get-AuthenticodeSignature $pe.FullName
  if ($after.Status -ne "Valid") { $failed += "$($pe.FullName) ($($after.Status))" }
}
if ($failed.Count -gt 0) {
  throw "not signed: $($failed -join ', ')"
}
Write-Host "::notice title=Sidecar signing::$($pes.Count) sidecar PE files signed and verified."
