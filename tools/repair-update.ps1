# Repara una actualizacion de HanstlerS que no llego a aplicarse.
#
# Sintoma que resuelve: pulsas actualizar, la app se reinicia y sigue en la
# version vieja. Este script hace el ciclo completo sin depender del boton,
# y sobre todo VERIFICA al final que la version en disco es la esperada.
#
#   powershell -ExecutionPolicy Bypass -File tools\repair-update.ps1
#
param(
  [switch]$SkipTests,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
function Paso($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Bien($m) { Write-Host "    $m" -ForegroundColor Green }
function Mal($m)  { Write-Host "    $m" -ForegroundColor Red }
function Nota($m) { Write-Host "    $m" -ForegroundColor DarkGray }

$repo = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $repo 'package.json'))) {
  Mal "No encuentro el repo. Ejecuta este script desde tools\ dentro del repositorio."
  exit 1
}
Set-Location $repo
Nota "repo: $repo"

$exePath = Join-Path $env:LOCALAPPDATA 'Programs\HanstlerS\HanstlerS.exe'
function VersionInstalada {
  if (-not (Test-Path $exePath)) { return '' }
  $v = (Get-Item $exePath).VersionInfo.ProductVersion
  if ($v -and $v -match '^(\d+\.\d+\.\d+)') { return $Matches[1] }
  return $v
}

$antes = VersionInstalada
Nota "version instalada ahora: $(if($antes){$antes}else{'(no instalada)'})"

Paso 'Trayendo los ultimos cambios'
# Solo los archivos SEGUIDOS por git: las carpetas sin trackear (otros proyectos
# dentro de la carpeta, restos de builds) no estorban a un pull, y contarlas
# bloqueaba la actualizacion con un error que no habia forma de resolver.
$sucio = @(git status --porcelain --untracked-files=no) | Where-Object { $_.Trim() }
if ($sucio) {
  Nota "Hay $($sucio.Count) archivo(s) seguidos por git con cambios locales:"
  $sucio | Select-Object -First 10 | ForEach-Object { Nota "  $_" }
  # package-lock.json lo reescribe npm install solo; descartarlo es seguro.
  $soloLock = -not ($sucio | Where-Object { $_ -notmatch 'package-lock\.json$' })
  if ($soloLock) {
    Nota 'Solo cambio package-lock.json (lo reescribe npm). Lo descarto.'
    git checkout -- package-lock.json
  } else {
    Mal 'Guarda o descarta esos cambios antes de continuar (git stash).'
    exit 1
  }
} else {
  Nota 'sin cambios locales que estorben'
}
$rama = (git rev-parse --abbrev-ref HEAD).Trim()
git pull --ff-only origin $rama
if ($LASTEXITCODE -ne 0) { Mal 'git pull fallo.'; exit 1 }

$esperada = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
Bien "version en el repo: $esperada"
if ($antes -eq $esperada -and -not $SkipBuild) {
  Nota 'La version instalada ya coincide con el repo.'
}

Paso 'Dependencias'
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Mal 'npm install fallo.'; exit 1 }

if (-not $SkipTests) {
  Paso 'Pruebas'
  npm test
  if ($LASTEXITCODE -ne 0) { Mal 'Las pruebas fallaron. No instalo un build roto.'; exit 1 }
  Bien 'Pruebas en verde.'
}

$setup = Join-Path $repo "dist-electron\HanstlerS Setup $esperada.exe"
if (-not $SkipBuild) {
  Paso "Compilando $esperada"
  $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  npm run dist
  if ($LASTEXITCODE -ne 0) { Mal 'La compilacion fallo.'; exit 1 }
}
if (-not (Test-Path $setup)) {
  Mal "No existe el instalador de la version $esperada."
  Nota 'Instaladores presentes:'
  Get-ChildItem (Join-Path $repo 'dist-electron\*.exe') -EA SilentlyContinue |
    ForEach-Object { Nota "  $($_.Name)" }
  exit 1
}
Bien "instalador: $(Split-Path $setup -Leaf)"

Paso 'Cerrando HanstlerS'
# Si queda una instancia abierta, el instalador puede terminar con codigo 0 sin
# haber sustituido nada: justo el fallo silencioso que este script persigue.
$procs = Get-Process HanstlerS -ErrorAction SilentlyContinue
if ($procs) {
  $procs | ForEach-Object { Nota "  cerrando PID $($_.Id)"; Stop-Process -Id $_.Id -Force }
  Start-Sleep 3
} else { Nota 'no estaba abierta' }
if (Get-Process HanstlerS -ErrorAction SilentlyContinue) {
  Mal 'HanstlerS sigue abierta. Cierrala a mano y vuelve a ejecutar.'
  exit 1
}

Paso 'Instalando'
$p = Start-Process -FilePath $setup -ArgumentList '/S' -Wait -PassThru
Nota "el instalador termino con codigo $($p.ExitCode)"
Start-Sleep 3

Paso 'Verificando'
$despues = VersionInstalada
Nota "version en disco: $(if($despues){$despues}else{'(nada)'})"
if ($despues -ne $esperada) {
  Mal "NO se aplico: esperaba $esperada y hay $despues."
  Nota 'Causas tipicas: quedaba una instancia abierta, o el antivirus bloqueo el instalador.'
  Nota "Prueba a ejecutarlo a mano: $setup"
  exit 1
}
Bien "instalada la $despues"

Paso 'Arrancando y comprobando que responde'
Start-Process $exePath
$vivo = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep 3
  $ids = (Get-Process HanstlerS -EA SilentlyContinue).Id
  $puertos = Get-NetTCPConnection -State Listen -EA SilentlyContinue |
    Where-Object { $ids -contains $_.OwningProcess }
  foreach ($pt in $puertos) {
    try {
      $r = Invoke-RestMethod -Uri "http://127.0.0.1:$($pt.LocalPort)/healthz" -TimeoutSec 3
      if ($r.ok) { Bien "responde en el puerto $($pt.LocalPort)"; $vivo = $true; break }
    } catch { }
  }
  if ($vivo) { break }
}
if (-not $vivo) { Mal 'La app no respondio a /healthz. Abrela y revisa.'; exit 1 }

Write-Host "`n=== LISTO: HanstlerS $despues instalada y funcionando ===" -ForegroundColor Green
Nota 'Las conversaciones que fallaban se reparan solas al volver a escribir en ellas.'
