# Scan the installer on VirusTotal and fail on any detection (LT-519, D-060:
# "build → sign → VirusTotal scan → fail on any detection → publish").
#
#   pwsh .github/actions/virustotal/scan.ps1 -Path <installer.exe>
#
# Uploads through the v3 API (a large-file upload URL above 32 MB), waits
# for the analysis, and fails when any engine says malicious or suspicious.
# The installer carries the sidecar's PEs inside it; VirusTotal unpacks
# NSIS installers and scans what is inside. With no API key, it says so
# and does nothing, like the signing step.
param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = "Stop"
function Fail([string]$m) { Write-Host "::error title=VirusTotal::$m"; exit 1 }
$key = $env:VIRUSTOTAL_API_KEY
if ([string]::IsNullOrWhiteSpace($key)) {
  Write-Host "::notice title=VirusTotal::No API key configured - the installer was NOT scanned."
  exit 0
}
$file = Get-Item $Path
$sha = (Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLower()
$headers = @{ "x-apikey" = $key }
$uploadUrl = "https://www.virustotal.com/api/v3/files"
if ($file.Length -gt 32MB) {
  $uploadUrl = (Invoke-RestMethod -Headers $headers -Uri "https://www.virustotal.com/api/v3/files/upload_url").data
}
$form = @{ file = $file }
$analysis = (Invoke-RestMethod -Method Post -Headers $headers -Uri $uploadUrl -Form $form).data.id
$deadline = (Get-Date).AddMinutes(20)
do {
  Start-Sleep -Seconds 30
  $a = Invoke-RestMethod -Headers $headers -Uri "https://www.virustotal.com/api/v3/analyses/$analysis"
} while ($a.data.attributes.status -ne "completed" -and (Get-Date) -lt $deadline)
if ($a.data.attributes.status -ne "completed") { Fail "analysis of $($file.Name) did not finish in 20 minutes" }
$s = $a.data.attributes.stats
$link = "https://www.virustotal.com/gui/file/$sha"
if (($s.malicious + $s.suspicious) -gt 0) {
  Fail "$($file.Name): $($s.malicious) malicious, $($s.suspicious) suspicious of $($s.malicious + $s.suspicious + $s.undetected + $s.harmless) engines — $link"
}
Write-Host "::notice title=VirusTotal::$($file.Name) clean: $($s.undetected) undetected, $($s.harmless) harmless, 0 detections. SHA-256 $sha — $link"
