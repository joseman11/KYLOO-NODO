<#
  Desinstala Nodo {{VERSION}}: detiene y quita el servicio, la regla de firewall y el programa.
  Los datos (%ProgramData%\Nodo) se CONSERVAN, salvo que se indique -PurgeData.
      powershell -ExecutionPolicy Bypass -File uninstall.ps1 [-PurgeData]
#>
param(
  [string]$InstallDir = (Join-Path $env:ProgramFiles "Nodo"),
  [switch]$PurgeData
)
$ErrorActionPreference = "Stop"
$ServiceName = "NodoServer"
$DataDir = Join-Path $env:ProgramData "Nodo"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Ejecuta este script como Administrador."
}

$serviceExe = Join-Path $InstallDir "nodo-service.exe"
if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
  if (Test-Path $serviceExe) { & $serviceExe uninstall }
}
Remove-NetFirewallRule -DisplayName "Nodo" -ErrorAction SilentlyContinue
Remove-Item -Path $InstallDir -Recurse -Force -ErrorAction SilentlyContinue

if ($PurgeData) {
  $answer = Read-Host "Se borrarán TODOS los datos de Nodo en $DataDir (ventas, menú, usuarios, respaldos). Escribe BORRAR para confirmar"
  if ($answer -ceq "BORRAR") { Remove-Item -Path $DataDir -Recurse -Force; Write-Host "Datos eliminados." }
  else { Write-Host "No se borró nada." }
} else {
  Write-Host "Nodo se desinstaló. Los datos se conservaron en $DataDir"
}
