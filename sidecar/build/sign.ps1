# Sign every PE under src-tauri/sidecar/ ("sign every PE").
#
#   pwsh sidecar/build/sign.ps1 [-Thumbprint <cert thumbprint>]
#
# Tauri's own signing covers coreview.exe and the installer; it does not
# touch resources, so the interpreter's folder is signed here, before
# `tauri build` packs it. Every PE ends up signed:
#
#   - already signed by its publisher with a signature Windows trusts
#     (python.org signs python.exe, its DLLs and the stdlib .pyd files):
#     left as it is — a trusted publisher's signature is worth more than a
#     second one of ours on top;
#   - unsigned (the wheels' native modules, cryptography, bcrypt, nacl,
#     cffi): signed with Coreview's certificate, SHA-256, timestamped.
#
# The check afterwards is that the signer is *our* certificate, not that
# Windows trusts it: a self-signed certificate is reported "UnknownError"
# on a machine that does not trust its root, which is every CI runner, and
# is exactly as trusted as the signature on coreview.exe itself.
#
# Every failure is an annotation (::error), readable without the job log,
# which needs admin rights to download.
#
# The certificate is Coreview's own (decision of 2026-09-29; docs/SIGNING.md).
param(
  [string]$Thumbprint = $env:COREVIEW_SIGN_THUMBPRINT,
  [string]$TimestampUrl = "http://timestamp.digicert.com"
)
$ErrorActionPreference = "Stop"
function Fail([string]$message) {
  Write-Host "::error title=Sidecar signing::$message"
  exit 1
}
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$dir = Join-Path $root "src-tauri\sidecar"
if (-not (Test-Path $dir)) { Fail "no sidecar under $dir; windows.ps1 did not run" }
$pes = @(Get-ChildItem -Recurse $dir -Include *.exe, *.dll, *.pyd)

if ([string]::IsNullOrWhiteSpace($Thumbprint)) {
  $unsigned = @($pes | Where-Object { (Get-AuthenticodeSignature $_.FullName).Status -ne "Valid" })
  Write-Host "::notice title=Sidecar signing::No certificate configured - $($unsigned.Count) of $($pes.Count) sidecar PE files are UNSIGNED."
  exit 0
}

$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | Select-Object -First 1
if (-not $signtool) { Fail "signtool.exe not found under Windows Kits\10\bin" }

$publisher = 0
$ours = 0
$failed = @()
foreach ($pe in $pes) {
  $before = Get-AuthenticodeSignature $pe.FullName
  if ($before.Status -eq "Valid") { $publisher++; continue }
  $out = & $signtool.FullName sign /sha1 $Thumbprint /fd sha256 /tr $TimestampUrl /td sha256 $pe.FullName 2>&1
  if ($LASTEXITCODE -ne 0) {
    $failed += "$($pe.Name): signtool $LASTEXITCODE $(($out | Select-Object -Last 2) -join ' ')"
    continue
  }
  $after = Get-AuthenticodeSignature $pe.FullName
  if (-not $after.SignerCertificate -or $after.SignerCertificate.Thumbprint -ne $Thumbprint) {
    $failed += "$($pe.Name): signer is $($after.SignerCertificate.Thumbprint), status $($after.Status)"
    continue
  }
  $ours++
}
if ($failed.Count -gt 0) {
  Fail ("{0} of {1} not signed: {2}" -f $failed.Count, $pes.Count, ($failed | Select-Object -First 5) -join '; ')
}
Write-Host "::notice title=Sidecar signing::$($pes.Count) sidecar PE files signed: $publisher by their publisher (kept), $ours by Coreview's certificate."
