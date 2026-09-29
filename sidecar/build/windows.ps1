# Lay the sidecar under src-tauri/sidecar/ for the Windows bundle (LT-519).
#
#   pwsh sidecar/build/windows.ps1
#
# The embeddable CPython zip from python.org, its SHA-256 pinned below and
# checked before anything is unpacked; the runtime installed straight into
# its Lib\site-packages from requirements.txt with --require-hashes and
# wheels only, by the runner's own pip (so no pip, no get-pip.py and no
# build tools end up inside); then the sidecar package. No PyInstaller, no
# UPX, no self-extracting anything: a folder that tauri.sidecar.conf.json
# ships as a resource and Rust spawns by absolute path from the install
# directory. Signing is sign.ps1's job, after this and before `tauri build`.
#
# The pinned checksum: SHA-256 of the file as downloaded on 2026-09-29,
# whose MD5 (fe8ef205f2e9c3ba44d0cf9954e1abd3) and size (11,133,606 bytes)
# match what python.org publishes for it — python.org publishes MD5 only.
param(
  [string]$PythonVersion = "3.12.10",
  [string]$PythonSha256 = "4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3",
  [string]$Pip = "python"   # a CPython 3.12 with pip, used only to fetch and unpack wheels
)
$ErrorActionPreference = "Stop"
# Every failure is an annotation, readable without the job log (which needs admin rights).
trap { Write-Host "::error title=Sidecar layout::$($_.Exception.Message)"; exit 1 }
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$out = Join-Path $root "src-tauri\sidecar"
$tag = $PythonVersion.Split(".")[0] + $PythonVersion.Split(".")[1]   # "312"

$zip = Join-Path $env:RUNNER_TEMP "python-$PythonVersion-embed-amd64.zip"
if (-not $env:RUNNER_TEMP) { $zip = Join-Path $env:TEMP "python-$PythonVersion-embed-amd64.zip" }
Invoke-WebRequest -Uri "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip" -OutFile $zip
$got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if ($got -ne $PythonSha256.ToLower()) { throw "embeddable zip checksum $got is not the pinned $PythonSha256" }

if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Path $out | Out-Null
Expand-Archive -Path $zip -DestinationPath $out
Remove-Item $zip -Force

# The embeddable build reads sys.path from its ._pth and nothing else — not
# the working directory, not PYTHONPATH. Lib\site-packages is where the
# runtime and the sidecar package go, so it is the one line added.
$pth = Join-Path $out "python$tag._pth"
Add-Content -Path $pth -Value "Lib\site-packages"

$site = Join-Path $out "Lib\site-packages"
New-Item -ItemType Directory -Path $site | Out-Null
& $Pip -m pip install --disable-pip-version-check --no-compile --no-deps --require-hashes `
  --only-binary=:all: --platform win_amd64 --python-version $PythonVersion.Substring(0, 4) --implementation cp `
  --target $site -r (Join-Path $root "sidecar\requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "pip install failed ($LASTEXITCODE)" }
# Console scripts are useless here and are PEs nobody would sign.
if (Test-Path (Join-Path $site "bin")) { Remove-Item -Recurse -Force (Join-Path $site "bin") }

Copy-Item -Recurse (Join-Path $root "sidecar\coreview_sidecar") (Join-Path $site "coreview_sidecar")
Get-ChildItem -Recurse $out -Include "__pycache__" -Directory | Remove-Item -Recurse -Force

# The smoke test the installer relies on: the interpreter starts from its
# own folder and finds the package with nothing on PATH.
$version = & (Join-Path $out "python.exe") -m coreview_sidecar --version
if ($LASTEXITCODE -ne 0) { throw "the laid sidecar does not start" }
Write-Host "sidecar laid under $out — $version"
$pes = Get-ChildItem -Recurse $out -Include *.exe, *.dll, *.pyd
Write-Host "::notice title=Sidecar layout::$version laid under src-tauri\sidecar, $($pes.Count) PE files."
