<#
  Instala o actualiza Nodo {{VERSION}} como servicio de Windows.
  Ejecutar como Administrador, desde la carpeta del paquete:
      powershell -ExecutionPolicy Bypass -File install.ps1 [-Port 3003] [-InstallDir "C:\Program Files\Nodo"]

  - Los datos (base, fotos, respaldos y registros) viven en %ProgramData%\Nodo y NUNCA se tocan al actualizar.
  - Volver a ejecutarlo actualiza el programa y conserva el puerto elegido antes.
#>
param(
  [int]$Port = 0,
  [string]$InstallDir = (Join-Path $env:ProgramFiles "Nodo"),
  [switch]$NoBrowser
)
$ErrorActionPreference = "Stop"
$ServiceName = "NodoServer"
$DataDir = Join-Path $env:ProgramData "Nodo"
$Source = $PSScriptRoot

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Ejecuta este script como Administrador (clic derecho en PowerShell > Ejecutar como administrador)."
}

Write-Host "Nodo {{VERSION}}"

# Puerto: el indicado, o el que ya tenía la instalación anterior, o 3003
$xmlPath = Join-Path $InstallDir "nodo-service.xml"
if ($Port -eq 0) {
  $Port = 3003
  if (Test-Path $xmlPath) {
    $m = [regex]::Match((Get-Content $xmlPath -Raw), 'name="PORT"\s+value="(\d+)"')
    if ($m.Success) { $Port = [int]$m.Groups[1].Value }
  }
}

# Carpetas de datos
New-Item -ItemType Directory -Force -Path $DataDir, (Join-Path $DataDir "logs"), (Join-Path $DataDir "backups") | Out-Null

# Si ya está instalado, se detiene antes de cambiar los archivos
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing -and $existing.Status -ne "Stopped") {
  Write-Host "Deteniendo el servicio actual..."
  Stop-Service -Name $ServiceName -Force
  $existing.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(30))
}

# Copiar el programa (el paquete puede ejecutarse desde cualquier carpeta)
if ((Resolve-Path $Source).Path -ne $InstallDir) {
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Remove-Item (Join-Path $InstallDir "app") -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item -Path (Join-Path $Source "*") -Destination $InstallDir -Recurse -Force
}

# Puerto en la configuración del servicio
$xml = (Get-Content $xmlPath -Raw) -replace 'name="PORT"\s+value="\d+"', ('name="PORT" value="' + $Port + '"')
Set-Content -Path $xmlPath -Value $xml -Encoding UTF8

# Registrar el servicio (solo la primera vez)
$serviceExe = Join-Path $InstallDir "nodo-service.exe"
if (-not $existing) {
  & $serviceExe install
  if ($LASTEXITCODE -ne 0) { throw "No se pudo registrar el servicio de Windows (código $LASTEXITCODE)." }
}

# Firewall: solo desde la red local, en cualquier perfil (los equipos de un local suelen quedar como «Pública»)
Remove-NetFirewallRule -DisplayName "Nodo" -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "Nodo" -Direction Inbound -Protocol TCP -LocalPort $Port -RemoteAddress LocalSubnet -Action Allow -Profile Any | Out-Null

# Arrancar y esperar a que responda
Write-Host "Iniciando el servicio..."
Start-Service -Name $ServiceName
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
    if ($r.ok) { $ok = $true; break }
  } catch { }
  Start-Sleep -Seconds 1
}
if (-not $ok) { throw "El servicio no respondió en 30 segundos. Revisa los registros en $DataDir\logs" }

$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
  Select-Object -ExpandProperty IPAddress

Write-Host ""
Write-Host "Nodo está funcionando." -ForegroundColor Green
Write-Host "  En este equipo:  http://localhost:$Port"
foreach ($ip in $ips) { Write-Host "  Desde las tablets: http://${ip}:$Port" }
Write-Host "  Datos y registros: $DataDir"
Write-Host ""
Write-Host "Recomendado: asigna una IP fija a este equipo en el router o en Windows."
if (-not $NoBrowser) { Start-Process "http://localhost:$Port" }
