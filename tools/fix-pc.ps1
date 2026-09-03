# Diagnostica y arregla una PC que se quedo clavada en una version vieja.
# No depende del boton: hace el ciclo entero y VERIFICA el resultado en disco.
# Uso:  powershell -ExecutionPolicy Bypass -File tools\fix-pc.ps1
$ErrorActionPreference = 'Continue'

function Titulo($t) { Write-Host ""; Write-Host "== $t ==" -ForegroundColor Cyan }
function Nota($t)   { Write-Host "   $t" }
function Malo($t)   { Write-Host "   $t" -ForegroundColor Red }
function Bien($t)   { Write-Host "   $t" -ForegroundColor Green }

$repo = Split-Path -Parent $PSScriptRoot
$exe  = Join-Path $env:LOCALAPPDATA 'Programs\HanstlerS\HanstlerS.exe'

Titulo "Diagnostico"
Nota "Repo: $repo"
if (-not (Test-Path (Join-Path $repo '.git'))) { Malo "No es un repo git. Abortando."; exit 1 }

$verRepo = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
$verApp  = if (Test-Path $exe) { (Get-Item $exe).VersionInfo.ProductVersion } else { '(no instalada)' }
Nota "Version en el codigo   : $verRepo"
Nota "Version instalada      : $verApp"

$sucio = @(git -C $repo status --porcelain --untracked-files=no)
if ($sucio.Count) { Nota "Cambios locales        : $($sucio.Count) -> los aparto" } else { Nota "Cambios locales        : ninguno" }

# Que dijo el ultimo intento
$jobFile = Join-Path $env:USERPROFILE '.hanstlers\update-job.json'
if (Test-Path $jobFile) {
  try {
    $j = Get-Content $jobFile -Raw | ConvertFrom-Json
    if ($j.ok -eq $false) { Malo "Ultimo intento FALLO en '$($j.step)': $($j.error)" }
    elseif ($j.pendiente) { Nota "Ultimo intento lanzo el instalador de la $($j.expectedVersion)" }
  } catch {}
}
$applyLog = Join-Path $env:USERPROFILE '.hanstlers\update-apply.log'
if (Test-Path $applyLog) {
  Nota "Ultimas lineas del instalador:"
  Get-Content $applyLog -Tail 5 | ForEach-Object { Write-Host "     $_" -ForegroundColor DarkGray }
}

Titulo "Traer el codigo"
if ($sucio.Count) { git -C $repo stash push --quiet -m "fix-pc $(Get-Date -f s)"; Nota "Apartados con git stash (recuperables con: git stash pop)" }
git -C $repo pull --ff-only origin main
if ($LASTEXITCODE -ne 0) { Malo "El pull fallo. Resuelvelo a mano y vuelve a ejecutar."; exit 1 }
$verRepo = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
Bien "Codigo ahora en la $verRepo"

Titulo "Dependencias"
Push-Location $repo
npm install --no-audit --no-fund 2>&1 | Select-Object -Last 2
# npm reescribe el lock aunque no cambie nada; si se queda modificado bloquea
# el siguiente arranque limpio.
if (@(git -C $repo status --porcelain -- package-lock.json).Count) {
  git -C $repo checkout -- package-lock.json
  Nota "package-lock.json devuelto a como estaba (lo reescribe npm, no tu)"
}

Titulo "Compilar"
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
npm run dist 2>&1 | Select-Object -Last 3
$setup = Join-Path $repo "dist-electron\HanstlerS Setup $verRepo.exe"
if (-not (Test-Path $setup)) {
  Malo "No se genero el instalador de la $verRepo."
  Malo "Mira el error de arriba: sin instalador no se puede continuar."
  Pop-Location; exit 1
}
Bien "Instalador listo: $(Split-Path $setup -Leaf)"
Pop-Location

Titulo "Instalar"
Get-Process HanstlerS -ErrorAction SilentlyContinue | ForEach-Object {
  Nota "Cerrando HanstlerS (PID $($_.Id))"; Stop-Process -Id $_.Id -Force
}
Start-Sleep -Seconds 3
$p = Start-Process $setup -ArgumentList '/S' -Wait -PassThru
Nota "Instalador termino con codigo $($p.ExitCode)"
Start-Sleep -Seconds 4

Titulo "Verificacion"
$verFinal = if (Test-Path $exe) { (Get-Item $exe).VersionInfo.ProductVersion } else { '' }
$corta = $verFinal
if ($corta -match '^(\d+\.\d+\.\d+)') { $corta = $Matches[1] }
Nota "Version en disco: $verFinal (esperaba $verRepo)"
if ($corta -ne $verRepo) {
  Malo "NO se aplico. La app sigue en la $corta."
  Malo "Causa habitual: quedo un HanstlerS.exe abierto. Cierralo todo y repite."
  exit 1
}
Bien "Instalada la $verRepo correctamente"

Start-Process $exe
Start-Sleep -Seconds 10
$puertos = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName -eq 'HanstlerS' } |
  Select-Object -ExpandProperty LocalPort -Unique
$vivo = $false
foreach ($pt in $puertos) {
  try {
    $h = Invoke-RestMethod "http://127.0.0.1:$pt/healthz" -TimeoutSec 5
    if ($h.ok) { Bien "Responde en el puerto $pt"; $vivo = $true }
  } catch {}
}
if (-not $vivo) { Nota "Aun no responde; puede tardar unos segundos mas en arrancar." }
Write-Host ""
Bien "LISTO. HanstlerS $verRepo instalada y en marcha."
