# Registra 003 para arrancar automáticamente con Windows (tarea programada, sin dependencias extra).
# Ejecutar como Administrador:  powershell -ExecutionPolicy Bypass -File scripts\install-windows-service.ps1
param(
  [int]$Port = 3003,
  [string]$DataDir = "$PSScriptRoot\..\data"
)
$root = Resolve-Path "$PSScriptRoot\.."
$node = (Get-Command node).Source
$dataDir = New-Item -ItemType Directory -Force $DataDir | Select-Object -ExpandProperty FullName

# Compila la PWA y prepara la base si es la primera vez
Push-Location $root
pnpm --filter "@003/web" build
if (-not (Test-Path "$dataDir\003.sqlite")) { $env:DB_FILE = "$dataDir\003.sqlite"; pnpm --filter "@003/server" seed }
Pop-Location

$cmd = "`$env:PORT='$Port'; `$env:DB_FILE='$dataDir\003.sqlite'; Set-Location '$root\apps\server'; & '$node' --import tsx src/main.ts *>> '$dataDir\server.log'"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -Command `"$cmd`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName "003-comandas" -Action $action -Trigger $trigger -Settings $settings -User "SYSTEM" -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName "003-comandas"

# Regla de firewall para que las tablets de la red local lleguen al puerto
New-NetFirewallRule -DisplayName "003 comandas" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Private -ErrorAction SilentlyContinue | Out-Null
Write-Host "003 instalado. Abre http://<IP-de-este-equipo>:$Port desde las tablets."
