# Lay the sidecar under src-tauri/sidecar/ for the Windows bundle (LT-513).
#
#   pwsh sidecar/build/windows.ps1 [-PythonVersion 3.12.10]
#
# Embeddable CPython zip from python.org (its SHA-256 checked against the
# value pinned below), pip bootstrapped into it, the runtime installed with
# --require-hashes from requirements.txt, then the sidecar package copied
# in. No PyInstaller, no UPX, no self-extracting anything: a folder that
# tauri.conf.json ships as a resource and Rust spawns by absolute path.
param(
  [string]$PythonVersion = "3.12.10",
  [string]$PythonSha256 = ""   # set from python.org's published checksum before a release; the script refuses to continue without it
)
$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$out = Join-Path $root "src-tauri\sidecar"
if ($PythonSha256 -eq "") { throw "pass -PythonSha256 with python.org's published checksum for the embeddable zip" }

$zip = Join-Path $env:TEMP "python-$PythonVersion-embed-amd64.zip"
Invoke-WebRequest -Uri "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip" -OutFile $zip
$got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if ($got -ne $PythonSha256.ToLower()) { throw "embeddable zip checksum $got is not $PythonSha256" }

if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Path $out | Out-Null
Expand-Archive -Path $zip -DestinationPath $out
# The embeddable build ignores site-packages unless its ._pth says so.
$pth = Get-ChildItem $out -Filter "python*._pth" | Select-Object -First 1
Add-Content -Path $pth.FullName -Value "Lib\site-packages"
Add-Content -Path $pth.FullName -Value "import site"

$getpip = Join-Path $env:TEMP "get-pip.py"
Invoke-WebRequest -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile $getpip
& (Join-Path $out "python.exe") $getpip --no-warn-script-location
& (Join-Path $out "python.exe") -m pip install --no-deps --require-hashes --no-warn-script-location -r (Join-Path $root "sidecar\requirements.txt")
& (Join-Path $out "python.exe") -m pip uninstall -y pip setuptools wheel 2>$null
Copy-Item -Recurse (Join-Path $root "sidecar\coreview_sidecar") (Join-Path $out "coreview_sidecar")
Get-ChildItem -Recurse $out -Include "__pycache__" -Directory | Remove-Item -Recurse -Force
Get-ChildItem -Recurse $out -Include "*.pyc" | Remove-Item -Force

& (Join-Path $out "python.exe") -m coreview_sidecar --version 2>$null
Write-Host "sidecar laid under $out; every .exe/.dll/.pyd in it is signed by the release workflow (signCommand)"
