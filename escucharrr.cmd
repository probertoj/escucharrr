@echo off
rem ============================================================================
rem  escucharrr - lanzador standalone (Windows)
rem  Doble clic para arrancar el servidor y abrir la app en el navegador.
rem
rem  Busca Node en este orden:
rem    1) node\node.exe   junto a este .cmd (Node portatil empaquetado -> standalone real)
rem    2) node.exe        en el PATH del sistema (modo desarrollo)
rem  node:sqlite exige Node >= 22.5; empaqueta Node 24 en node\ para distribuir.
rem  Ver packaging\README.md para armar la carpeta portatil y el .exe unico (SEA).
rem ============================================================================
setlocal
set "HERE=%~dp0"
set "NODE=%HERE%node\node.exe"
if not exist "%NODE%" set "NODE=node"

rem Abrir el navegador por defecto al arrancar (opt-in; el servidor lo respeta).
set "ESC_OPEN_BROWSER=1"

rem ffmpeg empaquetado (opcional): si existe bin\ffmpeg.exe, el servidor lo usa sin tocar el PATH.
if exist "%HERE%bin\ffmpeg.exe" set "ESC_FFMPEG=%HERE%bin\ffmpeg.exe"

where /q "%NODE%" 2>nul
"%NODE%" --version >nul 2>&1
if errorlevel 1 (
  echo No encuentro Node.js. Instala Node ^>= 22.5 ^(nodejs.org^) o coloca node\node.exe junto a este archivo.
  echo.
  pause
  exit /b 1
)

echo Iniciando escucharrr...
"%NODE%" "%HERE%app\server.js"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo El servidor termino con codigo %RC%. Revisa app\escucharrr-error.log si existe.
  pause
)
endlocal
