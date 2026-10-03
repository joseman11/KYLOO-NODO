@echo off
rem Arranque manual de Nodo (sin servicio), para pruebas. Cierra con Ctrl+C.
if "%NODO_DATA_DIR%"=="" set NODO_DATA_DIR=%ProgramData%\Nodo
if "%PORT%"=="" set PORT=3003
"%~dp0node.exe" --disable-warning=ExperimentalWarning "%~dp0app\server.mjs"
