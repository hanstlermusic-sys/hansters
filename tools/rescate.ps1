# Rescate de un PC que se quedo en una version vieja de HanstlerS.
#
# Para que existe: el ultimo paso de la actualizacion (cerrar la app, instalar y
# relanzar) corre en un script aparte, y hasta la 1.0.18 se lanzaba con
# spawn({ detached: true }). Medido: con detached ese script arranca 0 de 5
# veces. Es decir, no se ejecutaba nunca: el boton hacia pull, npm install y
# compilaba durante minutos, la app se cerraba... y no se instalaba nada.
#
# El problema es que ese fallo esta EN EL CODIGO QUE EJECUTA EL BOTON, asi que
# un PC afectado no puede arreglarse a si mismo con el boton: hay que instalar
# una version sana una sola vez. Eso es lo que hace este script.
#
# No compila nada: descarga el instalador ya hecho del release de GitHub.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File tools\rescate.ps1
#   powershell -ExecutionPolicy Bypass -File tools\rescate.ps1 -Version 1.0.19

param(
  [string]$Version = "1.0.19"
)

$ErrorActionPreference = "Stop"
$repo = "hanstlermusic-sys/hansters"
$exe  = Join-Path $env:LOCALAPPDATA "Programs\hanstlers\HanstlerS.exe"

function Paso($m) { Write-Host ""; Write-Host "==> $m" -ForegroundColor Cyan }
function Bien($m) { Write-Host "    OK  $m" -ForegroundColor Green }
function Mal($m)  { Write-Host "    !!  $m" -ForegroundColor Red }

Write-Host "=== Rescate de HanstlerS -> $Version ===" -ForegroundColor White

Paso "Version actual"
if (Test-Path $exe) {
  $antes = (Get-Item $exe).VersionInfo.ProductVersion
  Write-Host "    instalada ahora: $antes"
  if ($antes -like "$Version*") {
    Bien "ya tienes la $Version instalada. No hay nada que rescatar."
    exit 0
  }
} else {
  $antes = "(ninguna)"
  Write-Host "    no encuentro HanstlerS instalado; se instalara desde cero"
}

Paso "Descargando el instalador $Version"
$destino = Join-Path $env:TEMP "HanstlerS-Setup-$Version.exe"
if (Test-Path $destino) { Remove-Item $destino -Force -ErrorAction SilentlyContinue }
$url = "https://github.com/$repo/releases/download/v$Version/HanstlerS.Setup.$Version.exe"
Write-Host "    $url"
try {
  $wc = New-Object System.Net.WebClient
  $wc.DownloadFile($url, $destino)
} catch {
  Mal "no se pudo descargar: $($_.Exception.Message)"
  Write-Host "    Comprueba que tienes internet, o descargalo a mano desde:"
  Write-Host "    https://github.com/$repo/releases"
  exit 1
}
if (-not (Test-Path $destino)) { Mal "la descarga no dejo el archivo"; exit 1 }
$mb = [math]::Round((Get-Item $destino).Length / 1MB, 1)
if ($mb -lt 20) {
  Mal "el archivo descargado pesa solo $mb MB: no parece el instalador"
  exit 1
}
Bien "descargado ($mb MB)"

Paso "Cerrando HanstlerS"
$vivos = Get-Process -Name HanstlerS -ErrorAction SilentlyContinue
if ($vivos) {
  Write-Host "    cerrando $(($vivos | Measure-Object).Count) proceso(s)"
  $vivos | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 3
}
if (Get-Process -Name HanstlerS -ErrorAction SilentlyContinue) {
  Mal "HanstlerS sigue abierto; cierralo a mano y vuelve a ejecutar esto"
  exit 1
}
Bien "cerrado"

Paso "Instalando (silencioso, tarda un poco)"
$p = Start-Process -FilePath $destino -ArgumentList "/S" -Wait -PassThru
Write-Host "    el instalador termino con codigo $($p.ExitCode)"
Start-Sleep -Seconds 3

Paso "Comprobando que de verdad quedo instalada"
if (-not (Test-Path $exe)) { Mal "no encuentro $exe"; exit 1 }
$ahora = (Get-Item $exe).VersionInfo.ProductVersion
Write-Host "    antes: $antes"
Write-Host "    ahora: $ahora"
if ($ahora -notlike "$Version*") {
  Mal "sigue en $ahora. Prueba a ejecutar el instalador a mano:"
  Write-Host "    $destino"
  exit 1
}
Bien "instalada la $ahora"

Paso "Abriendo HanstlerS"
Start-Process $exe
Start-Sleep -Seconds 12

Paso "Comprobando que responde"
$ok = $false
foreach ($i in 1..10) {
  try {
    $r = Invoke-RestMethod "http://127.0.0.1:8717/healthz" -TimeoutSec 3
    if ($r.ok) { $ok = $true; break }
  } catch {}
  Start-Sleep -Seconds 3
}
if ($ok) { Bien "HanstlerS responde en el puerto 8717" }
else { Write-Host "    (no contesto todavia; dale unos segundos y mira la ventana)" -ForegroundColor Yellow }

Write-Host ""
Write-Host "=== LISTO: HanstlerS $ahora ===" -ForegroundColor Green
Write-Host "A partir de aqui el boton de actualizar ya funciona por si solo."
