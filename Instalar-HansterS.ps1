# ============================================================
#  Instalar-HansterS.ps1  -  Tu asistente personal (Copilot CLI)
#  Ejecuta:  powershell -ExecutionPolicy Bypass -File .\Instalar-HansterS.ps1
# ============================================================
$ErrorActionPreference = "Stop"
$root = Join-Path $env:USERPROFILE "HansterS"
Write-Host "Instalando HansterS en $root" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path (Join-Path $root "public") | Out-Null

# ---- Comprobar Node ----
try { $nv = & node --version } catch { $nv = $null }
if (-not $nv) { Write-Host "ERROR: Node.js no esta instalado. Instalalo con: winget install OpenJS.NodeJS.LTS" -ForegroundColor Red; exit 1 }
Write-Host "Node detectado: $nv" -ForegroundColor Green

function Expand-B64Gzip($b64){
  $bytes=[Convert]::FromBase64String($b64)
  $ms=New-Object System.IO.MemoryStream(,$bytes)
  $gz=New-Object System.IO.Compression.GzipStream($ms,[System.IO.Compression.CompressionMode]::Decompress)
  $out=New-Object System.IO.MemoryStream
  $gz.CopyTo($out); $gz.Close()
  return $out.ToArray()
}
$data = @{}
$data["server.js"] = "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"
$data["public/index.html"] = "H4sIAAAAAAAEAHVVvY7cNhDuDeQd5ljZ8O0q7lxI25wv2CKwDZxTuBxRcyueKZIhKW3WhZF0qdzYpWEjQGDARaq8Qe5N/AR5BA+p/ZEXtxXJGeqbme8bjsqzJ88uXrx8fglt7PTih3tlWkGjWVWCgsgWwiatHUUE2aIPFCvxy4ufZo8FFHuPwY4qMShaO+ujAGlNJMM316qJbdXQoCTN8uEclFFRoZ4FiZqqR/Mft0hRRU2LJZoQyV+VxXhmh1bmFXjSlQhxoym0RByj9XRdiWI0zWUIW5hil3Ntmw2vALkK8qCaSkTravQi29nTqAGkxhAqUXs0zc7BruDQ7HzarqxYLMsiGQ9Xjr+eRfotHiASSPTWrCZFbQ3TKx1qvYg9YFAhsUbgyAdrUPP17NwHLDjiLvXpfpKIXDciV5o3mcNKXKB3SaeGIHqs8YareXMKAWVU1oQJFXUfozUZtY5mdm0107kHv9S0Uh7kIYbzdkMycpD/P737A7bRy2LEOYlraL0HfdrTgKmPBuYCpbr914jF1w+fITnsEdShklF98nzIxw7ViM+9G+9SvQsrqO1EtO+YGDCmZllOqTrSva9rTWLx319Lq/EMruzmtOpzuNRqxRr0d7EF6L2qETbQqI6ADPza337ZCoadDXN43lNjQRM38waoUZwdfyVbNdhwDnRDsk8maTvuRhv4Uh/4nJprlTurlLahRZsS0+Rn/DDLIpvmd/dWWSQGd2xeW9+NbNrO2UCHd3SkZKckK7lxlAhKHrHnO3tGjZdYa87ufqNkyppHBwz29YPUNW//PpY4PS30hDmGMq7nEeDtmiEfCXAaJbW5Lbkfg2QeCSy4XgeEhAYOPUKbA379/TPA/Uumw49mMoNCfw5XrbqODyeOgJplYYn07T+GkDPjqbTN40TlwRG+OlH7zjdW/3NSkR082YLrKUTesubMAHBYTCy8//OYhUm0QKbZBQp93al4eJG5IH4vH7+nsSySgjs1E00uQvCSxyg6N78JqcDRnCfpdoLyoxp/EN8Ai4KIijIGAAA="
$data["public/styles.css"] = "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"
$data["public/app.js"] = "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"

foreach ($k in $data.Keys) {
  $dest = Join-Path $root $k
  $dir = Split-Path $dest -Parent
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  [System.IO.File]::WriteAllBytes($dest, (Expand-B64Gzip $data[$k]))
  Write-Host "  escrito $k" -ForegroundColor DarkGray
}

# ---- Lanzador oculto (VBS): inicia el servidor y abre la ventana de la app ----
$vbs = @'
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = root
' Iniciar el servidor Node oculto (si el puerto ya esta ocupado, node saldra solo)
sh.Run "cmd /c node """ & root & "\server.js""", 0, False
WScript.Sleep 1600
url = "http://127.0.0.1:8717"
edge1 = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
edge2 = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
If fso.FileExists(edge1) Then
  sh.Run """" & edge1 & """ --app=" & url & " --window-size=1120,780", 1, False
ElseIf fso.FileExists(edge2) Then
  sh.Run """" & edge2 & """ --app=" & url & " --window-size=1120,780", 1, False
Else
  sh.Run url, 1, False
End If
'@
Set-Content -Path (Join-Path $root "HansterS.vbs") -Value $vbs -Encoding ascii

# ---- Acceso directo en el Escritorio ----
$desktop = [Environment]::GetFolderPath("Desktop")
if (-not $desktop -or -not (Test-Path $desktop)) { $desktop = Join-Path $env:USERPROFILE "Desktop" }
if (-not (Test-Path $desktop)) { New-Item -ItemType Directory -Force -Path $desktop | Out-Null }
$lnk = Join-Path $desktop "HansterS.lnk"
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = "wscript.exe"
$sc.Arguments = '"' + (Join-Path $root "HansterS.vbs") + '"'
$sc.WorkingDirectory = $root
$sc.IconLocation = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe,0"
$sc.Description = "HansterS - tu asistente personal"
$sc.Save()

Write-Host "" 
Write-Host "== HansterS instalado ==" -ForegroundColor Green
Write-Host "Abrelo con el acceso directo HansterS en tu Escritorio (doble clic)." -ForegroundColor Cyan
Write-Host "Requisito: tener el CLI de Copilot instalado y con sesion (copilot /login)." -ForegroundColor DarkGray
$open = Read-Host "Abrir HansterS ahora? (s/n)"
if ($open -eq "s") { Start-Process "wscript.exe" -ArgumentList ('"' + (Join-Path $root "HansterS.vbs") + '"') }

