# Compila el motor nativo con MSVC (VS 2022 Build Tools).
# Sin dependencias externas: solo el compilador y el Windows SDK.
#   powershell -ExecutionPolicy Bypass -File engine\build.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) { throw "vswhere no encontrado; instala Visual Studio Build Tools con el workload de C++." }
$vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsPath) { throw "No se encontró el toolchain de C++ (VC.Tools). Instálalo desde el Visual Studio Installer." }

$vcvars = Join-Path $vsPath 'VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path $vcvars)) { throw "vcvars64.bat no encontrado en $vsPath" }

$src = Join-Path $here 'escucharrr-engine.cpp'
$exe = Join-Path $here 'escucharrr-engine.exe'

# cl necesita el entorno de vcvars; lo cargamos en un cmd y compilamos ahí.
$cmd = "`"$vcvars`" >nul && cl /nologo /EHsc /O2 /W3 /Fe:`"$exe`" `"$src`" ole32.lib avrt.lib /link /SUBSYSTEM:CONSOLE"
Push-Location $here
try {
  & cmd /c $cmd
  if ($LASTEXITCODE -ne 0) { throw "la compilación falló (cl salió $LASTEXITCODE)" }
} finally { Pop-Location }

# limpiamos el .obj intermedio
Get-ChildItem $here -Filter *.obj -ErrorAction SilentlyContinue | Remove-Item -Force
Write-Host "OK -> $exe"
