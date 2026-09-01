<#
  Instala/actualiza ask-cli en esta PC copiando bin\ask-cli.ps1 y bin\ask-cli.cmd
  a %USERPROFILE%\.ask-cli\bin\. No toca config.json ni history.jsonl existentes.

  Uso (desde la raiz del repo, tras git pull):
    .\ask-cli\install.ps1
#>

$ErrorActionPreference = 'Stop'

$srcDir = Join-Path $PSScriptRoot 'bin'
$destDir = Join-Path $HOME '.ask-cli\bin'

if (-not (Test-Path $srcDir)) {
  throw "No se encontro $srcDir. Corre este script desde el repo hansters."
}

New-Item -ItemType Directory -Path $destDir -Force | Out-Null

Copy-Item (Join-Path $srcDir 'ask-cli.ps1') (Join-Path $destDir 'ask-cli.ps1') -Force
Copy-Item (Join-Path $srcDir 'ask-cli.cmd') (Join-Path $destDir 'ask-cli.cmd') -Force

$verLine = Select-String -Path (Join-Path $destDir 'ask-cli.ps1') -Pattern "AskCliVersion = '([^']+)'" | Select-Object -First 1
$ver = if ($verLine) { $verLine.Matches[0].Groups[1].Value } else { 'desconocida' }

Write-Host "ask-cli instalado/actualizado en $destDir (version $ver)."

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$destDir*") {
  Write-Host "Aviso: $destDir no esta en tu PATH de usuario."
  Write-Host "Para agregarlo:"
  Write-Host "  [Environment]::SetEnvironmentVariable('Path', `$env:Path + ';$destDir', 'User')"
}
