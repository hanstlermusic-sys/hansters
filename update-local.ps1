# Actualiza la instalacion local de HanstlerS con el build mas reciente de dist-electron.
# Uso:  powershell -ExecutionPolicy Bypass -File update-local.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$setup = Get-ChildItem (Join-Path $root 'dist-electron') -Filter 'HanstlerS Setup *.exe' -ErrorAction SilentlyContinue |
         Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) {
  Write-Host 'No hay instalador. Ejecuta primero:  npm run dist' -ForegroundColor Yellow
  exit 1
}

Write-Host "Instalador: $($setup.Name)" -ForegroundColor Cyan
Write-Host 'Cerrando HanstlerS...' -ForegroundColor Cyan
Get-Process -Name HanstlerS -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force }
Start-Sleep -Seconds 3

Write-Host 'Instalando...' -ForegroundColor Cyan
Start-Process -FilePath $setup.FullName -ArgumentList '/S' -Wait
Start-Sleep -Seconds 3

$exe = "$env:LOCALAPPDATA\Programs\HanstlerS\HanstlerS.exe"
if (Test-Path $exe) {
  Write-Host 'Abriendo HanstlerS...' -ForegroundColor Green
  Start-Process $exe
  Start-Sleep -Seconds 8
  try {
    $st = Invoke-RestMethod -Uri 'http://127.0.0.1:8717/api/state' -TimeoutSec 10
    $ok = $st.features.PSObject.Properties.Name -contains 'vertexAgentTools'
    if ($ok) { Write-Host 'OK: el runtime nuevo esta activo (vertexAgentTools presente).' -ForegroundColor Green }
    else { Write-Host 'AVISO: el runtime no expone vertexAgentTools.' -ForegroundColor Yellow }
  } catch { Write-Host 'La app aun esta arrancando; revisa la ventana.' -ForegroundColor Yellow }
} else {
  Write-Host 'No se encontro HanstlerS.exe instalado.' -ForegroundColor Red
}
