#!/usr/bin/env pwsh
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Args
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Continue'

$AskHome = Join-Path $HOME '.ask-cli'
$ConfigPath = Join-Path $AskHome 'config.json'
$HistoryPath = Join-Path $AskHome 'history.jsonl'
$ProfilesPath = Join-Path $AskHome 'project-profiles.json'

$script:AskCliVersion = '0.9.0'
$script:ResolvedCopilot = ''
$script:Invoker = $null
$script:Cfg = $null

# Marcador idempotente del bloque que ask-cli inyecta en AGENTS.md.
$script:GuardMarker = '<!-- ask-cli:execution-first -->'

# Codigo de salida reservado para "el modelo no verifico su trabajo".
$script:ExitVerificationFailed = 3

$RxCompiled = [System.Text.RegularExpressions.RegexOptions]::Compiled
$RxCompiledIC = [System.Text.RegularExpressions.RegexOptions]::Compiled -bor [System.Text.RegularExpressions.RegexOptions]::IgnoreCase

# Verbos que implican trabajo real sobre el sistema: si aparecen, exigimos evidencia de herramientas.
$script:ActionVerbRegex = [regex]::new(
  '\b(?:list[ae]|lista|enumera|valida|verifica|revisa|comprueba|diagnostica|analiza|audita|busca|encuentra|cuenta|ejecuta|corre|crea|genera|modifica|actualiza|arregla|corrige|implementa|refactoriza|escribe|borra|elimina|instala|prueba|testea|compila|lee|abre|inspecciona|list|check|verify|validate|review|inspect|analyze|audit|search|find|count|run|execute|create|generate|update|modify|fix|implement|refactor|write|delete|remove|install|test|build|compile|read|open)\w*\b',
  $RxCompiledIC)

# Afirmaciones de escritura: si el modelo dice esto sin escrituras registradas, alucino.
$script:ClaimedWriteRegex = [regex]::new(
  '\b(?:cre[eé]|cre[eé]e|creado|creada|modifiqu[eé]|modificado|modificada|actualic[eé]|actualizado|actualizada|escrib[ií]|escrito|guard[eé]|guardado|a[nñ]ad[ií]|agregu[eé]|agregado|elimin[eé]|borr[eé]|borrado|renombr[eé]|parche[eé]|apliqu[eé] el parche|created|updated|modified|wrote|written|added|removed|deleted|renamed|patched|saved)\b',
  $RxCompiledIC)

# Herramientas capaces de mutar el disco (incluye shells: pueden escribir sin que Copilot lo contabilice).
$script:WriteToolRegex = [regex]::new(
  '^(?:write|edit|create|replace|insert|str_replace|apply_patch|multi_edit|notebook_edit|save|delete|remove|move|rename|mkdir|bash|sh|shell|powershell|pwsh|cmd|terminal|run_command|execute_command)(?:[_-]\w+)*$',
  $RxCompiledIC)

# Evidencia de ejecucion del backend HanstlerS (provider vertex). No emite
# telemetria estructurada: anuncia cada herramienta dentro del propio texto como
#   "<icono> nombre(argumento) ..."
# y al terminar concatena " (check) <resumen>" en la MISMA linea. El resumen lleva
# el veredicto del post-check del servidor, que es lo que permite saber si fallo.
# Los caracteres se componen con [char] a proposito: mantiene el fuente en ASCII.
$script:VertexToolRegex = [regex]::new(
  '^(?:\S+\s+)?([a-z_][a-z0-9_]+)\((.*)\)\s*' + [char]0x2026 + '(.*)$',
  $RxCompiled)
# "post-check fallo" y "rollback automatico" se matchean por prefijo sin acento.
$script:VertexToolFailRegex = [regex]::new(
  'post-check\s+fall|rollback\s+autom|fall\S*\s+rollback',
  $RxCompiledIC)
# Solo estas herramientas de HanstlerS tocan archivos concretos: su argumento es
# una ruta. run_command tambien muta, pero su argumento es un comando, no un path.
$script:VertexFileToolRegex = [regex]::new(
  '^(?:write_file|apply_patch|delete_file|move_file)$',
  $RxCompiledIC)

# Ruido de PowerShell/Node que nunca aporta nada al usuario: se descarta siempre.
# Nota: PowerShell emite CategoryInfo/FullyQualifiedErrorId con prefijo "    + ", de ahi el \+? opcional.
$script:NoiseRegex = [regex]::new(
  '^\s*(?:node\.exe\s*:|[A-Za-z]:\\.*\\(?:cmd|powershell|node)\.exe\s*:|At line:\d+ char:\d+|En\s+l[ií]nea:\s*\d+|En\s+.+copilot\.ps1:|\+.*npm-loader\.js|\+\s*&\s|~{5,}\s*$|\+?\s*CategoryInfo\b|\+?\s*FullyQualifiedErrorId\b|System\.Management\.Automation\.RemoteException\s*$)',
  $RxCompiled)

# Telemetria util (creditos, tokens, diff, resume): oculta por defecto, visible con --verbose.
$script:TelemetryRegex = [regex]::new(
  '^\s*(?:Changes\s+\+\d+\s+-\d+\s*$|AI Credits\b|Tokens\b|Resume\s+copilot\s+--resume=)',
  $RxCompiled)

$script:ResumeRegex = [regex]::new('--resume=([0-9a-fA-F-]{8,})', $RxCompiled)

function Ensure-AskHome {
  if (-not (Test-Path $AskHome)) { New-Item -ItemType Directory -Path $AskHome | Out-Null }
}

function Write-Utf8NoBom([string]$path, [string]$content) {
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($path, $content, $enc)
}

function ConvertTo-BoolValue($value, [bool]$fallback) {
  if ($null -eq $value) { return $fallback }
  if ($value -is [bool]) { return $value }
  $s = ([string]$value).Trim().ToLower()
  if ($s -in @('1', 'true', 'on', 'yes', 'si')) { return $true }
  if ($s -in @('0', 'false', 'off', 'no')) { return $false }
  return $fallback
}

function ConvertTo-IntValue($value, [int]$fallback) {
  if ($null -eq $value) { return $fallback }
  $n = 0
  if ([int]::TryParse([string]$value, [ref]$n)) { return $n }
  return $fallback
}

function Default-Config {
  return @{
    provider = 'copilot'
    model = 'auto'
    vertexModel = 'vertex-gemini-pro'
    mode = 'trusted' # trusted|safe
    dir = ''
    output = 'text' # text|json
    lastResume = ''
    lastVertexConvId = ''
    copilotPath = ''      # cache de la ruta resuelta de copilot.cmd
    allowTools = 'view,glob,rg'
    denyTools = ''        # se aplica tambien en modo trusted
    agent = ''
    timeoutSec = 180
    historyMax = 2000
    maxCredits = 0
    retry = $true
    verify = $true
    agentMode = 'interactive' # interactive|plan|autopilot
    effort = ''
    assistedApproval = $false
    maxContinues = 0
    noAskUser = $false
    qualityGate = $false
    verifyCommand = ''
    loopThreshold = 3     # llamadas identicas consecutivas que se consideran bucle
    hanstlersUrl = 'http://127.0.0.1:8717'  # backend del provider vertex (local, opcional)
    autoStartHanstlers = $true  # si el backend no responde, arrancar la app en vez de fallar
    startTimeoutSec = 60        # cuanto esperar a que el backend recien abierto responda
    guard = 'auto'   # auto|always|off
  }
}

# Escritura de propiedades tolerante al tipo del envelope (hashtable o PSCustomObject).
function Set-Prop($obj, [string]$name, $value) {
  if ($null -eq $obj) { return }
  if ($obj -is [System.Collections.IDictionary]) { $obj[$name] = $value; return }
  $obj | Add-Member -NotePropertyName $name -NotePropertyValue $value -Force
}

# Acceso a propiedades de JSON tolerante a Set-StrictMode.
function Get-Prop($obj, [string]$name) {
  if ($null -eq $obj) { return $null }
  if ($obj -is [System.Collections.IDictionary]) {
    if ($obj.Contains($name)) { return $obj[$name] }
    return $null
  }
  if (-not $obj.PSObject) { return $null }
  $p = $obj.PSObject.Properties[$name]
  if ($null -eq $p) { return $null }
  return $p.Value
}

function Load-Config {
  Ensure-AskHome
  $cfg = Default-Config
  if (Test-Path $ConfigPath) {
    try {
      $raw = Get-Content $ConfigPath -Raw
      if ($raw) {
        $obj = ConvertFrom-Json $raw -ErrorAction Stop
        foreach ($p in $obj.PSObject.Properties) {
          if ($cfg.ContainsKey($p.Name) -and $null -ne $p.Value) {
            if ($p.Value -is [bool] -or $p.Value -is [int] -or $p.Value -is [long] -or $p.Value -is [double]) {
              $cfg[$p.Name] = $p.Value
            } else {
              $cfg[$p.Name] = [string]$p.Value
            }
          }
        }
      }
    } catch {}
  }
  return $cfg
}

function Save-Config($cfg) {
  Ensure-AskHome
  Write-Utf8NoBom $ConfigPath ($cfg | ConvertTo-Json -Depth 6)
}

function Convert-ObjectToHashtable($obj) {
  if ($null -eq $obj) { return $null }
  if ($obj -is [string] -or $obj -is [ValueType]) { return $obj }
  if ($obj -is [System.Collections.IDictionary]) {
    $h = @{}
    foreach ($k in $obj.Keys) { $h[[string]$k] = Convert-ObjectToHashtable $obj[$k] }
    return $h
  }
  if ($obj -is [System.Collections.IEnumerable] -and -not ($obj -is [string])) {
    $arr = @()
    foreach ($it in $obj) { $arr += ,(Convert-ObjectToHashtable $it) }
    return $arr
  }
  if ($obj.PSObject -and $obj.PSObject.Properties) {
    $h2 = @{}
    foreach ($p in $obj.PSObject.Properties) { $h2[$p.Name] = Convert-ObjectToHashtable $p.Value }
    return $h2
  }
  return $obj
}

function Load-Profiles {
  Ensure-AskHome
  if (-not (Test-Path $ProfilesPath)) { return @{} }
  try {
    $raw = Get-Content $ProfilesPath -Raw
    if (-not $raw) { return @{} }
    $obj = ConvertFrom-Json $raw
    $h = Convert-ObjectToHashtable $obj
    if ($h -is [System.Collections.IDictionary]) { return $h }
  } catch {}
  return @{}
}

function Save-Profiles($profiles) {
  Ensure-AskHome
  Write-Utf8NoBom $ProfilesPath ($profiles | ConvertTo-Json -Depth 8)
}

function Resolve-FullPath([string]$pathInput) {
  if ($pathInput) { return [System.IO.Path]::GetFullPath($pathInput) }
  return [System.IO.Path]::GetFullPath((Get-Location).Path)
}

function Get-ActiveProfileRecord($cfg, [string]$dir) {
  $profiles = Load-Profiles
  $target = $dir
  if (-not $target) { $target = $cfg.dir }
  if (-not $target) { $target = (Get-Location).Path }
  $full = Resolve-FullPath $target
  $bestKey = ''
  $bestLen = -1
  foreach ($k in $profiles.Keys) {
    $pk = Resolve-FullPath ([string]$k)
    if ($full.Length -lt $pk.Length) { continue }
    $prefix = $full.Substring(0, $pk.Length)
    if ($prefix.ToLower() -ne $pk.ToLower()) { continue }
    if ($full.Length -gt $pk.Length) {
      $nextChar = $full.Substring($pk.Length, 1)
      if ($nextChar -ne '\') { continue }
    }
    if ($pk.Length -gt $bestLen) {
      $bestLen = $pk.Length
      $bestKey = $k
    }
  }
  if (-not $bestKey) { return $null }
  return @{
    key = [string]$bestKey
    profile = $profiles[$bestKey]
  }
}

function Get-ActiveProfile($cfg, [string]$dir) {
  $rec = Get-ActiveProfileRecord $cfg $dir
  if ($null -eq $rec) { return $null }
  return $rec.profile
}

function Resolve-Settings($cfg, [hashtable]$opts) {
  $prof = Get-ActiveProfile $cfg $opts.dir
  $out = @{}
  $out.provider = if ($opts.provider) { $opts.provider } elseif ($prof -and $prof.provider) { [string]$prof.provider } else { [string]$cfg.provider }
  $out.model = if ($opts.model) { $opts.model } elseif ($prof -and $prof.model) { [string]$prof.model } else { [string]$cfg.model }
  $out.vertexModel = if ($opts.vertexModel) { $opts.vertexModel } elseif ($prof -and $prof.vertexModel) { [string]$prof.vertexModel } else { [string]$cfg.vertexModel }
  $out.mode = if ($opts.mode) { $opts.mode } elseif ($prof -and $prof.mode) { [string]$prof.mode } else { [string]$cfg.mode }
  $out.output = if ($opts.output) { $opts.output } else { [string]$cfg.output }
  $out.dir = if ($opts.dir) { $opts.dir } elseif ($prof -and $prof.dir) { [string]$prof.dir } else { [string]$cfg.dir }
  $out.allowTools = if ($opts.allowTools) { [string]$opts.allowTools } elseif ($prof -and $prof.allowTools) { [string]$prof.allowTools } else { [string]$cfg.allowTools }
  if (-not $out.allowTools) { $out.allowTools = 'view,glob,rg' }
  # denyTools se ACUMULA (perfil + config + CLI): una denegacion nunca debe perderse
  # por especificar otra en una capa distinta.
  $denyParts = @()
  if ($cfg.denyTools) { $denyParts += [string]$cfg.denyTools }
  if ($prof -and $prof.denyTools) { $denyParts += [string]$prof.denyTools }
  if ($opts.denyTools) { $denyParts += [string]$opts.denyTools }
  $out.denyTools = ConvertTo-ToolList $denyParts
  $out.timeoutSec = if ((ConvertTo-IntValue $opts.timeoutSec 0) -gt 0) { ConvertTo-IntValue $opts.timeoutSec 180 } else { ConvertTo-IntValue $cfg.timeoutSec 180 }
  if ($out.timeoutSec -le 0) { $out.timeoutSec = 180 }
  $out.agent = if ($opts.agent) { [string]$opts.agent } elseif ($prof -and $prof.agent) { [string]$prof.agent } else { [string]$cfg.agent }
  $out.maxCredits = if ((ConvertTo-IntValue $opts.maxCredits 0) -gt 0) { ConvertTo-IntValue $opts.maxCredits 0 } else { ConvertTo-IntValue $cfg.maxCredits 0 }
  $out.guard = if ($prof -and $prof.guard) { [string]$prof.guard } else { [string]$cfg.guard }
  if (-not $out.guard) { $out.guard = 'auto' }

  $out.agentMode = if ($opts.agentMode) { [string]$opts.agentMode } elseif ($prof -and (Get-Prop $prof 'agentMode')) { [string](Get-Prop $prof 'agentMode') } else { [string](Get-Prop $cfg 'agentMode') }
  if (-not $out.agentMode) { $out.agentMode = 'interactive' }
  if ($script:ValidAgentMode -notcontains $out.agentMode) { throw "agentMode invalido: '$($out.agentMode)'. Validos: $($script:ValidAgentMode -join ', ')" }

  $out.effort = if ($opts.effort) { [string]$opts.effort } elseif ($prof -and (Get-Prop $prof 'effort')) { [string](Get-Prop $prof 'effort') } else { [string](Get-Prop $cfg 'effort') }
  if ($out.effort -and $script:ValidEffort -notcontains $out.effort) { throw "effort invalido: '$($out.effort)'. Validos: $($script:ValidEffort -join ', ')" }

  $out.assistedApproval = if ($null -ne $opts.assistedApproval) { ConvertTo-BoolValue $opts.assistedApproval $false } else { ConvertTo-BoolValue (Get-Prop $cfg 'assistedApproval') $false }
  $out.noAskUser = if ($null -ne $opts.noAskUser) { ConvertTo-BoolValue $opts.noAskUser $false } else { ConvertTo-BoolValue (Get-Prop $cfg 'noAskUser') $false }
  $out.maxContinues = if ((ConvertTo-IntValue $opts.maxContinues 0) -gt 0) { ConvertTo-IntValue $opts.maxContinues 0 } else { ConvertTo-IntValue (Get-Prop $cfg 'maxContinues') 0 }
  $out.qualityGate = if ($null -ne $opts.qualityGate) { ConvertTo-BoolValue $opts.qualityGate $false } else { ConvertTo-BoolValue (Get-Prop $cfg 'qualityGate') $false }
  # Sin estas dos, Get-HanstlersUrl y Get-ToolLoop caian siempre al valor por
  # defecto y las claves de config.json no tenian ningun efecto.
  $out.hanstlersUrl = if (Get-Prop $opts 'hanstlersUrl') { [string](Get-Prop $opts 'hanstlersUrl') } elseif ($prof -and (Get-Prop $prof 'hanstlersUrl')) { [string](Get-Prop $prof 'hanstlersUrl') } else { [string](Get-Prop $cfg 'hanstlersUrl') }
  $out.loopThreshold = if ((ConvertTo-IntValue (Get-Prop $opts 'loopThreshold') 0) -gt 0) { ConvertTo-IntValue (Get-Prop $opts 'loopThreshold') 3 } else { ConvertTo-IntValue (Get-Prop $cfg 'loopThreshold') 3 }
  if ($out.loopThreshold -lt 2) { $out.loopThreshold = 3 }

  $out.verifyCommand = if ($opts.verifyCommand) { [string]$opts.verifyCommand } elseif ($prof -and (Get-Prop $prof 'verifyCommand')) { [string](Get-Prop $prof 'verifyCommand') } else { [string](Get-Prop $cfg 'verifyCommand') }

  return $out
}

function Apply-ProfilePolicy($cfg, [hashtable]$opts, [hashtable]$settings) {
  $profile = Get-ActiveProfile $cfg ''
  if (-not $profile -and $opts.dir) { $profile = Get-ActiveProfile $cfg $opts.dir }
  if (-not $profile) { return @{ settings = $settings; profile = $null } }
  $isStrict = $true
  if ($null -ne $profile.strict) {
    try { $isStrict = [bool]$profile.strict } catch { $isStrict = $true }
  }
  if (-not $isStrict) { return @{ settings = $settings; profile = $profile } }
  if ($opts.forceProfileOverride) { return @{ settings = $settings; profile = $profile } }

  $profileDir = [System.IO.Path]::GetFullPath([string]$profile.dir)
  if ($opts.dir) {
    $requestedDir = [System.IO.Path]::GetFullPath([string]$opts.dir)
    $reqLow = $requestedDir.ToLower()
    $profLow = $profileDir.ToLower()
    $inside = $reqLow.StartsWith($profLow) -and ($reqLow.Length -eq $profLow.Length -or $reqLow.Substring($profLow.Length,1) -eq '\')
    if (-not $inside) {
      throw "Perfil estricto activo: no puedes cambiar --dir fuera de $profileDir (usa --force-profile-override)."
    }
  }
  if ($opts.provider -and $opts.provider -ne [string]$profile.provider) {
    throw "Perfil estricto activo: provider bloqueado en '$($profile.provider)' (usa --force-profile-override)."
  }
  if ($opts.mode -and $opts.mode -ne [string]$profile.mode) {
    throw "Perfil estricto activo: mode bloqueado en '$($profile.mode)' (usa --force-profile-override)."
  }
  if ($opts.model) {
    $expectedModel = if ([string]$profile.provider -eq 'vertex') { [string]$profile.vertexModel } else { [string]$profile.model }
    if ($opts.model -ne $expectedModel) {
      throw "Perfil estricto activo: model bloqueado en '$expectedModel' (usa --force-profile-override)."
    }
  }
  if ($opts.vertexModel -and [string]$profile.provider -eq 'vertex' -and $opts.vertexModel -ne [string]$profile.vertexModel) {
    throw "Perfil estricto activo: vertexModel bloqueado en '$($profile.vertexModel)' (usa --force-profile-override)."
  }

  $settings.provider = [string]$profile.provider
  $settings.model = [string]$profile.model
  $settings.vertexModel = [string]$profile.vertexModel
  $settings.mode = [string]$profile.mode
  $settings.dir = $profileDir
  return @{ settings = $settings; profile = $profile }
}

function Get-CopilotCmd {
  if ($script:ResolvedCopilot -and (Test-Path $script:ResolvedCopilot)) { return $script:ResolvedCopilot }
  $cached = ''
  if ($script:Cfg -and $script:Cfg.ContainsKey('copilotPath')) { $cached = [string]$script:Cfg.copilotPath }
  if ($cached -and (Test-Path $cached)) {
    $script:ResolvedCopilot = $cached
    return $cached
  }
  $found = ''
  foreach ($name in @('copilot.cmd', 'copilot')) {
    $c = Get-Command $name -ErrorAction SilentlyContinue
    if ($c -and $c.Path) { $found = $c.Path; break }
  }
  if (-not $found) { throw "Copilot CLI no encontrado en PATH." }
  $script:ResolvedCopilot = $found
  if ($script:Cfg -and $script:Cfg.ContainsKey('copilotPath') -and ([string]$script:Cfg.copilotPath) -ne $found) {
    $script:Cfg.copilotPath = $found
    try { Save-Config $script:Cfg } catch {}
  }
  return $found
}

# copilot.cmd es un shim npm que pasa por cmd.exe, y cmd.exe TRUNCA los argumentos
# en el primer salto de linea: el prompt multilinea perderia todo despues del guard.
# Por eso resolvemos el entrypoint real (node + npm-loader.js) y lo invocamos directo.
function Get-CopilotInvoker {
  if ($null -ne $script:Invoker) { return $script:Invoker }
  $cmdPath = Get-CopilotCmd
  $inv = @{ exe = $cmdPath; prefix = @(); multiline = $false }
  try {
    $dir = Split-Path -Parent $cmdPath
    $js = Join-Path $dir 'node_modules\@github\copilot\npm-loader.js'
    if (Test-Path $js) {
      $node = Join-Path $dir 'node.exe'
      if (-not (Test-Path $node)) {
        $nc = Get-Command 'node' -ErrorAction SilentlyContinue
        $node = if ($nc -and $nc.Path) { $nc.Path } else { '' }
      }
      if ($node) { $inv = @{ exe = $node; prefix = @($js); multiline = $true } }
    }
  } catch {}
  $script:Invoker = $inv
  return $inv
}

# Fallback para el shim .cmd: aplana el prompt para que cmd.exe no lo trunque.
function ConvertTo-SingleLinePrompt([string]$text) {
  return ((([string]$text) -replace "`r`n", "`n") -replace "`n+", ' | ').Trim()
}

function Get-GuardText {
  return @'
- Ejecuta herramientas/comandos cuando el usuario pida listar, validar, revisar, comprobar o diagnosticar algo.
- No respondas solo con recomendaciones si la tarea requiere datos reales del sistema o archivos.
- Si un intento falla por permisos, prueba una alternativa de lectura/consulta no destructiva y reporta resultado real.
- No preguntes "¿procedo?" ni pidas confirmación para tareas normales; actúa y entrega resultado.
- FLUIDEZ: avanza de corrido hasta completar la tarea; no te detengas para pedir pasos intermedios.
- Si faltan detalles menores, asume la opción razonable y continúa.
- Solo haz preguntas si falta un dato crítico imposible de inferir o si la acción es destructiva/irreversible.
- No afirmes haber leído, ejecutado o modificado algo que no ejecutaste realmente con una herramienta.
'@
}

function Get-AgentsFilePath([string]$dir) {
  $target = if ($dir) { $dir } else { (Get-Location).Path }
  return (Join-Path (Resolve-FullPath $target) 'AGENTS.md')
}

# Si el guard ya vive en AGENTS.md, Copilot lo carga como instruccion cacheada
# y anteponerlo en cada prompt seria pagar los mismos tokens dos veces.
function Test-HasPersistentGuard([string]$dir) {
  try {
    $p = Get-AgentsFilePath $dir
    if (-not (Test-Path $p)) { return $false }
    return ((Get-Content $p -Raw -ErrorAction SilentlyContinue) -like ('*' + $script:GuardMarker + '*'))
  } catch { return $false }
}

function Build-ExecutionFirstPrompt([string]$prompt, [hashtable]$settings) {
  $mode = 'auto'
  if ($settings -and $settings.ContainsKey('guard') -and $settings.guard) { $mode = [string]$settings.guard }
  if ($mode -eq 'off') { return $prompt }
  if ($mode -eq 'auto') {
    $dir = if ($settings) { [string]$settings.dir } else { '' }
    if (Test-HasPersistentGuard $dir) { return $prompt }
  }
  return ("INSTRUCCION OPERATIVA:`n" + (Get-GuardText) + "`n`nTAREA:`n" + $prompt)
}

function Is-NonOperationalCopilotReply([string]$text) {
  $t = [string]$text
  if (-not $t.Trim()) { return $true }
  # Una respuesta larga ya representa trabajo real: nunca vale la pena pagar un segundo round-trip.
  if ($t.Length -gt 400) { return $false }
  $low = $t.ToLower()
  if ($low -match '^\s*listo[,.\s]*entendido') { return $true }
  if ($low -match '^\s*entendido\.\s*estoy listo y operativo') { return $true }
  if ($low -match '^\s*qué necesitas|^\s*que necesitas|^\s*what do you need') { return $true }
  if ($low -match 'disponibles:\s*`?todos`?\s*y\s*`?todo_deps`?') { return $true }
  if ($low -match 'estado:\s*\n?-?\s*cwd:') { return $true }
  return $false
}

function Append-History([hashtable]$entry) {
  Ensure-AskHome
  $line = ($entry | ConvertTo-Json -Depth 8 -Compress)
  Add-Content -Path $HistoryPath -Value $line -Encoding UTF8
  $max = 2000
  if ($script:Cfg) { $max = ConvertTo-IntValue $script:Cfg.historyMax 2000 }
  if ($max -le 0) { return }
  # Chequeo por tamano: evita releer el archivo completo en cada invocacion.
  try {
    $info = Get-Item $HistoryPath -ErrorAction SilentlyContinue
    if ($info -and $info.Length -gt 2MB) {
      $keep = @(Get-Content $HistoryPath -Tail $max -ErrorAction SilentlyContinue)
      Write-Utf8NoBom $HistoryPath (($keep -join "`n") + "`n")
    }
  } catch {}
}

function Get-LastResume {
  if (-not (Test-Path $HistoryPath)) { return '' }
  $lines = @(Get-Content $HistoryPath -Tail 200 -ErrorAction SilentlyContinue)
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    try {
      $obj = $lines[$i] | ConvertFrom-Json
      if ($obj.resume) { return [string]$obj.resume }
    } catch {}
  }
  return ''
}

function Get-ToolSummary($data) {
  $a = Get-Prop $data 'arguments'
  if ($null -eq $a) { return '' }
  foreach ($k in @('command', 'pattern', 'path', 'filePath', 'file_path', 'query', 'url', 'description')) {
    $v = Get-Prop $a $k
    if ($v) {
      $s = ([string]$v) -replace '\s+', ' '
      if ($s.Length -gt 90) { $s = $s.Substring(0, 90) + '...' }
      return $s
    }
  }
  return ''
}

function Test-IsActionableTask([string]$prompt) {
  return $script:ActionVerbRegex.IsMatch([string]$prompt)
}

# Deteccion de bucle improductivo: el agente repite la MISMA llamada con los
# MISMOS argumentos una y otra vez sin que cambie nada. Cada llamada "tiene
# exito", asi que ningun otro gate lo ve: la corrida parece sana mientras gira
# en falso hasta agotar iteraciones.
#
# Se exigen repeticiones CONSECUTIVAS a proposito. Repetir un comando identico
# separado por otras llamadas es normal y productivo (el ciclo test -> parche ->
# test ejecuta la misma suite varias veces, pero con un apply_patch en medio).
# Lo anomalo es la repeticion inmediata, sin nada entre medias que pudiera
# haber cambiado el resultado.
function Get-ToolLoop($toolCalls, [int]$threshold) {
  $none = @{ found = $false; name = ''; summary = ''; count = 0 }
  $limit = if ($threshold -gt 1) { $threshold } else { 3 }
  # Solo se juzga el turno MAS RECIENTE. El reintento arrastra las llamadas del
  # turno anterior para no perder evidencia, pero si el agente ya salio del
  # bucle no debe seguir penalizado por haber caido en el antes.
  # El @() va FUERA del pipeline: Where-Object devuelve un escalar cuando filtra
  # a un solo elemento, y bajo Set-StrictMode acceder a .Count sobre un escalar
  # lanza excepcion.
  $calls = @(@($toolCalls) | Where-Object { -not (Get-Prop $_ 'prior') })
  if ($calls.Count -lt $limit) { return $none }

  $bestName = ''; $bestSummary = ''; $best = 0
  $runName = ''; $runSummary = ''; $run = 0
  $prev = [string]$null
  foreach ($t in $calls) {
    $name = [string](Get-Prop $t 'name')
    $summary = [string](Get-Prop $t 'summary')
    $sig = $name + "`0" + $summary
    if ($sig -eq $prev) {
      $run++
    } else {
      $run = 1; $prev = $sig; $runName = $name; $runSummary = $summary
    }
    if ($run -gt $best) { $best = $run; $bestName = $runName; $bestSummary = $runSummary }
  }

  if ($best -ge $limit) {
    return @{ found = $true; name = $bestName; summary = $bestSummary; count = $best }
  }
  return $none
}

function Test-HasWriteTool($toolCalls) {
  foreach ($t in $toolCalls) {
    if ($script:WriteToolRegex.IsMatch([string]$t.name)) { return $true }
  }
  return $false
}

# Reconstruye las llamadas a herramientas a partir del texto del stream de
# HanstlerS, para que la ruta vertex pueda pasar por los mismos gates que la de
# Copilot en vez de declararse verificada a ciegas.
function Get-VertexToolCalls([string]$text) {
  $calls = New-Object System.Collections.Generic.List[object]
  $files = New-Object System.Collections.Generic.List[string]
  $failed = 0
  # Se devuelven ARRAYS, no List[object]: bajo Set-StrictMode estricto de
  # PowerShell 5.1 la expresion @($lista).Count lanza "Argument types do not
  # match", y ese es justo el patron que usan los gates para contar llamadas.
  if ([string]::IsNullOrWhiteSpace($text)) {
    return @{ calls = @(); failed = 0; filesModified = @() }
  }
  $check = [string][char]0x2713
  foreach ($line in ($text -split "`r?`n")) {
    $m = $script:VertexToolRegex.Match($line)
    if (-not $m.Success) { continue }
    $name = $m.Groups[1].Value
    $arg = $m.Groups[2].Value.Trim()
    $tail = $m.Groups[3].Value
    # Sin la marca de exito la llamada quedo a medias (la corrida se corto):
    # no se cuenta como fallo, pero tampoco como escritura confirmada.
    $done = $tail.Contains($check)
    $ok = $done -and (-not $script:VertexToolFailRegex.IsMatch($tail))
    if ($done -and -not $ok) { $failed++ }
    # Misma forma que la ruta de Copilot (id/name/summary/success): el resto
    # del script lee esos campos y con StrictMode un campo ausente lanza.
    $calls.Add(@{ id = ''; name = $name; summary = $arg; success = $ok })
    if ($ok -and $arg -and $script:VertexFileToolRegex.IsMatch($name) -and -not $files.Contains($arg)) {
      $files.Add($arg)
    }
  }
  return @{ calls = $calls.ToArray(); failed = $failed; filesModified = $files.ToArray() }
}

# Verificacion determinista: no juzga el estilo de la prosa, sino la evidencia
# de ejecucion que Copilot CLI emite en el JSONL.
function Test-ResponseVerification([hashtable]$res, [string]$prompt, [int]$loopThreshold) {
  $issues = [System.Collections.Generic.List[string]]::new()
  $actionable = Test-IsActionableTask $prompt
  $toolCount = @($res.toolCalls).Count
  $text = [string]$res.text

  if ($actionable -and $toolCount -eq 0) {
    $issues.Add('La tarea pedia accion pero no se ejecuto ninguna herramienta (0 llamadas registradas).')
  }
  if ($toolCount -gt 0 -and $res.toolFailed -eq $toolCount) {
    $issues.Add("Todas las llamadas a herramientas fallaron ($($res.toolFailed)/$toolCount).")
  }
  if ($script:ClaimedWriteRegex.IsMatch($text) -and
      @($res.filesModified).Count -eq 0 -and
      -not (Test-HasWriteTool $res.toolCalls)) {
    $issues.Add('La respuesta afirma haber creado o modificado algo, pero no hay ninguna escritura registrada.')
  }
  if (-not $text.Trim() -and $toolCount -eq 0) {
    $issues.Add('Respuesta vacia y sin ejecucion.')
  }

  $loop = Get-ToolLoop $res.toolCalls $loopThreshold
  if ($loop.found) {
    $what = $loop.name + $(if ($loop.summary) { '(' + $loop.summary + ')' } else { '' })
    $issues.Add("Bucle improductivo: se repitio $what $($loop.count) veces seguidas con los mismos argumentos, sin nada en medio que pudiera cambiar el resultado.")
  }

  return @{ ok = ($issues.Count -eq 0); issues = $issues; actionable = $actionable; loop = $loop }
}

function Build-VerificationFeedback([hashtable]$verification, [hashtable]$res) {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.AppendLine('VERIFICACION FALLIDA. Esto es lo que quedo registrado de tu turno anterior:')
  [void]$sb.AppendLine(('- Herramientas ejecutadas: ' + @($res.toolCalls).Count))
  foreach ($t in $res.toolCalls) {
    [void]$sb.AppendLine(('  * ' + $t.name + ' -> ' + $(if ($t.success -eq $false) { 'FALLO' } else { 'ok' })))
  }
  [void]$sb.AppendLine(('- Archivos modificados: ' + $(if (@($res.filesModified).Count -gt 0) { ($res.filesModified -join ', ') } else { 'ninguno' })))
  [void]$sb.AppendLine('')
  [void]$sb.AppendLine('Problemas detectados:')
  foreach ($i in $verification.issues) { [void]$sb.AppendLine(('- ' + $i)) }
  [void]$sb.AppendLine('')

  # Ante un bucle, la orden generica ("ejecuta las herramientas necesarias") es
  # contraproducente: es justo lo que el agente cree estar haciendo. Hay que
  # prohibir explicitamente la llamada repetida y forzar un cambio de enfoque.
  $loop = Get-Prop $verification 'loop'
  if ($loop -and (Get-Prop $loop 'found')) {
    $what = [string](Get-Prop $loop 'name')
    [void]$sb.AppendLine(('NO vuelvas a llamar a ' + $what + ' con los mismos argumentos: ya lo hiciste y el resultado no cambio.'))
    [void]$sb.AppendLine('Estas repitiendo un paso en vez de avanzar. Haz una de estas tres cosas:')
    [void]$sb.AppendLine('1. Usa la informacion que YA obtuviste para dar el siguiente paso distinto.')
    [void]$sb.AppendLine('2. Si el resultado no te sirve, cambia de herramienta o de argumentos.')
    [void]$sb.Append('3. Si estas bloqueado, DETENTE y explica que te falta y que alternativas hay. No repetir es mas util que insistir.')
    return $sb.ToString()
  }

  [void]$sb.AppendLine('Ejecuta ahora las herramientas necesarias y responde con los resultados reales obtenidos.')
  [void]$sb.Append('No describas lo que harias: hazlo.')
  return $sb.ToString()
}

# Semantica real de Copilot CLI (verificada empiricamente):
#   --allow-tool      pre-aprueba (evita el prompt) pero NO restringe el catalogo.
#   --available-tools SOLO estas herramientas quedan disponibles para el modelo.
#   --deny-tool       prohibe, pero --allow-all-tools tiene precedencia sobre el.
#   --excluded-tools  quita del catalogo; es el unico que funciona junto a --allow-all-tools.
# Por eso una denegacion se emite por partida doble: --deny-tool cubre el flujo de
# permisos y --excluded-tools garantiza que la herramienta ni siquiera se ofrezca.
function Build-PermissionArgs([hashtable]$settings) {
  $a = @()
  $deny = ConvertTo-ToolList $settings.denyTools
  if ($settings.mode -eq 'trusted') {
    $a += '--allow-all-tools'
  } else {
    $allow = ConvertTo-ToolList $settings.allowTools
    if (-not $allow) { $allow = 'view,glob,rg' }
    $a += ('--available-tools=' + $allow)
    $a += ('--allow-tool=' + $allow)
  }
  if ($deny) {
    $a += ('--deny-tool=' + $deny)
    $a += ('--excluded-tools=' + $deny)
  }
  return $a
}

# Flags que gobiernan la autonomia del agente. Nota: --assisted-approval se ignora
# en silencio sin --experimental, asi que los emitimos siempre juntos.
function Build-AgentArgs([hashtable]$settings) {
  $a = @()
  $agentMode = [string]$settings.agentMode
  if ($agentMode -and $agentMode -ne 'interactive') { $a += @('--mode', $agentMode) }
  if ($agentMode -eq 'autopilot') {
    $mc = ConvertTo-IntValue $settings.maxContinues 0
    if ($mc -gt 0) { $a += @('--max-autopilot-continues', [string]$mc) }
  }
  $effort = [string]$settings.effort
  if ($effort) { $a += @('--effort', $effort) }
  if (ConvertTo-BoolValue $settings.assistedApproval $false) {
    $a += @('--experimental', '--assisted-approval')
  }
  if (ConvertTo-BoolValue $settings.noAskUser $false) { $a += '--no-ask-user' }
  return $a
}

$script:ValidEffort = @('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max')
$script:ValidAgentMode = @('interactive', 'plan', 'autopilot')

# Comandos de verificacion por stack. El orden importa: se elige el primer marcador
# que exista, de mas especifico a mas generico.
#
# Las busquedas recursivas EXCLUYEN directorios de dependencias y artefactos: un
# *.Tests.ps1 dentro de node_modules pertenece a un tercero, no al proyecto, y
# detectarlo elegiria el stack equivocado (ademas de recorrer arboles enormes).
$script:VendorDirRegex = [regex]::new(
  '(^|[\\/])(node_modules|\.git|\.venv|venv|__pycache__|bin|obj|dist|build|target|vendor|packages|\.tox|site-packages)([\\/]|$)',
  [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)

function Find-ProjectFile([string]$dir, [string[]]$include) {
  $found = Get-ChildItem $dir -Recurse -Include $include -File -ErrorAction SilentlyContinue |
    Where-Object { -not $script:VendorDirRegex.IsMatch($_.FullName.Substring($dir.Length)) } |
    Select-Object -First 1
  return [bool]$found
}

# Un package.json NO implica que haya tests. npm crea por defecto un script test
# que solo imprime "no test specified" y sale con 1, y muchos proyectos ni lo
# definen. Detectar node por la mera presencia del fichero hacia que el gate
# fallara SIEMPRE en esos repos: cada corrida terminaba en exit 3 por un fallo
# que el agente no podia arreglar. Sin script util, es preferible omitir el gate
# (y avisar) que bloquear el trabajo.
function Test-HasNpmTest([string]$dir) {
  $pkg = Join-Path $dir 'package.json'
  if (-not (Test-Path $pkg)) { return $false }
  try {
    $json = Get-Content $pkg -Raw -ErrorAction Stop | ConvertFrom-Json
    $scripts = Get-Prop $json 'scripts'
    if ($null -eq $scripts) { return $false }
    $t = [string](Get-Prop $scripts 'test')
    if (-not $t) { return $false }
    # El placeholder que genera 'npm init' no ejecuta nada.
    if ($t -match 'no test specified') { return $false }
    return $true
  } catch { return $false }
}

$script:QualityProbes = @(
  @{ name = 'pester';  marker = { param($d) Find-ProjectFile $d @('*.Tests.ps1') }
     cmd = 'Invoke-Pester -Path . -Output None -CI' }
  @{ name = 'node';    marker = { param($d) Test-HasNpmTest $d }
     cmd = 'npm test --silent' }
  @{ name = 'python';  marker = { param($d) (Test-Path (Join-Path $d 'pytest.ini')) -or (Test-Path (Join-Path $d 'pyproject.toml')) -or (Test-Path (Join-Path $d 'setup.cfg')) -or (Test-Path (Join-Path $d 'tests')) -or @(Get-ChildItem $d -Filter 'test_*.py' -File -ErrorAction SilentlyContinue | Select-Object -First 1).Count -gt 0 }
     cmd = 'python -m pytest -q' }
  @{ name = 'dotnet';  marker = { param($d) Find-ProjectFile $d @('*.sln', '*.csproj') }
     cmd = 'dotnet test --nologo -v q' }
  @{ name = 'go';      marker = { param($d) Test-Path (Join-Path $d 'go.mod') }
     cmd = 'go test ./...' }
  @{ name = 'rust';    marker = { param($d) Test-Path (Join-Path $d 'Cargo.toml') }
     cmd = 'cargo test --quiet' }
)

function Get-QualityCommand([string]$dir, [string]$override) {
  if ($override) { return @{ name = 'custom'; cmd = $override } }
  $d = if ($dir) { $dir } else { (Get-Location).Path }
  if (-not (Test-Path $d)) { return $null }
  foreach ($probe in $script:QualityProbes) {
    try { if (& $probe.marker $d) { return @{ name = $probe.name; cmd = $probe.cmd } } } catch {}
  }
  return $null
}

# Ejecuta la suite real del proyecto. "El modelo dijo que pasan" no es evidencia:
# esto la produce.
#
# Se ejecuta en un PROCESO HIJO a proposito. Invoke-Expression en el proceso actual
# no permite decidir el exito de forma fiable: $LASTEXITCODE solo lo actualizan los
# ejecutables nativos, asi que con cmdlets (Invoke-Pester) arrastra el valor de un
# comando anterior y produce falsos verdes. Un proceso hijo siempre tiene exit code
# real, aisla el estado de la sesion y ademas hace aplicable el timeout.
function Invoke-QualityGate([string]$dir, [string]$command, [int]$timeoutSec) {
  $d = if ($dir) { $dir } else { (Get-Location).Path }
  $limit = if ($timeoutSec -gt 0) { $timeoutSec } else { 600 }
  $host_ = if (Get-Command 'pwsh' -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }
  $outFile = Join-Path ([System.IO.Path]::GetTempPath()) ('askcli-q-' + [Guid]::NewGuid().ToString('N') + '.out')
  $errFile = $outFile + '.err'
  # ErrorActionPreference=Stop hace que un cmdlet que escribe error termine con exit != 0;
  # sin el, Write-Error saldria como exito.
  # ProgressPreference=SilentlyContinue evita que la barra de progreso se serialice
  # en el stream de error (ver Format-GateOutput).
  $inner = '$ErrorActionPreference=''Stop''; $ProgressPreference=''SilentlyContinue''; $global:LASTEXITCODE=0; try { ' + $command + ' } catch { Write-Error $_; exit 1 }; exit $LASTEXITCODE'
  # -EncodedCommand en vez de -Command: pasar el comando como argumento suelto lo
  # somete a un segundo parseo que destroza comillas y ampersands (un verifyCommand
  # como: pytest -k "not slow"  llegaria roto). Base64 UTF-16LE viaja intacto.
  $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($inner))
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $p = Start-Process -FilePath $host_ -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded) `
      -WorkingDirectory $d -NoNewWindow -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    # Tocar .Handle fuerza a .NET a cachear el handle del proceso; sin esto,
    # .ExitCode queda vacio despues de que el proceso termina y todo parece fallar.
    $null = $p.Handle
    if (-not $p.WaitForExit($limit * 1000)) {
      try { $p.Kill() } catch {}
      $sw.Stop()
      return @{ ok = $false; exitCode = 124; timedOut = $true; command = $command; ms = $sw.ElapsedMilliseconds
                output = ("La verificacion excedio el timeout de " + $limit + "s y fue abortada.") }
    }
    $sw.Stop()
    $exit = $p.ExitCode
    $lines = @()
    foreach ($f in @($outFile, $errFile)) {
      if (Test-Path $f) { $lines += @(Get-Content $f -ErrorAction SilentlyContinue) }
    }
    $lines = @(Format-GateOutput $lines)
    # Solo interesa la cola: es donde viven los fallos y los resumenes.
    $tail = if ($lines.Count -gt 40) { $lines[-40..-1] } else { $lines }
    return @{ ok = ($exit -eq 0); exitCode = $exit; timedOut = $false; command = $command
              ms = $sw.ElapsedMilliseconds; output = (($tail -join [Environment]::NewLine).Trim()) }
  } catch {
    $sw.Stop()
    return @{ ok = $false; exitCode = 1; timedOut = $false; command = $command; ms = $sw.ElapsedMilliseconds
              output = ('No se pudo ejecutar la verificacion: ' + $_.Exception.Message) }
  } finally {
    Remove-Item $outFile, $errFile -Force -ErrorAction SilentlyContinue
  }
}

# El stream de error de un powershell hijo NO es texto plano: viene serializado
# como CLIXML (#< CLIXML seguido de <Objs ...>). Sin limpiarlo, esa sopa de XML
# es lo que se le envia al agente como "salida real" del fallo: cientos de tokens
# de ruido que ademas ocultan el mensaje que de verdad importa.
function Format-GateOutput($lines) {
  $out = [System.Collections.Generic.List[string]]::new()
  foreach ($ln in @($lines)) {
    $s = [string]$ln
    if ($s -match '^#<\s*CLIXML') { continue }
    if ($s -match '<Objs\s+Version=') {
      # Rescatar el texto real que el XML lleva dentro (mensajes de error).
      foreach ($m in [regex]::Matches($s, '<S(?:\s[^>]*)?>(.*?)</S>')) {
        $t = $m.Groups[1].Value
        if (-not $t) { continue }
        # CLIXML escapa cualquier caracter problematico como _xHHHH_ (incluido el
        # propio guion bajo, que viaja como _x005F_). Decodificar solo _x000D_ y
        # _x000A_ dejaba el resto corrupto: MARCADOR_UNICO_XYZ llegaba como
        # MARCADOR_UNICO_x005F_XYZ. Se decodifican todas las secuencias.
        $t = [regex]::Replace($t, '_x([0-9A-Fa-f]{4})_', {
          param($mm)
          $ch = [char][Convert]::ToInt32($mm.Groups[1].Value, 16)
          if ($ch -eq "`r" -or $ch -eq "`n") { ' ' } else { [string]$ch }
        })
        $t = [System.Net.WebUtility]::HtmlDecode($t).Trim()
        if ($t) { $out.Add($t) }
      }
      continue
    }
    $out.Add($s)
  }
  return $out.ToArray()
}

function Build-QualityFeedback([hashtable]$gate) {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.AppendLine('LA VERIFICACION DEL PROYECTO HA FALLADO.')
  [void]$sb.AppendLine(('Comando ejecutado: ' + $gate.command))
  [void]$sb.AppendLine(('Codigo de salida: ' + $gate.exitCode))
  [void]$sb.AppendLine('')
  [void]$sb.AppendLine('Salida real:')
  [void]$sb.AppendLine('---')
  [void]$sb.AppendLine($gate.output)
  [void]$sb.AppendLine('---')
  [void]$sb.AppendLine('')
  [void]$sb.AppendLine('Corrige la causa raiz y vuelve a ejecutar la suite hasta que pase.')
  [void]$sb.Append('No modifiques ni desactives los tests para forzar un verde: arregla el codigo.')
  return $sb.ToString()
}

function ConvertTo-ToolList($value) {
  if ($null -eq $value) { return '' }
  $items = @()
  foreach ($v in @($value)) {
    foreach ($part in ([string]$v -split ',')) {
      $t = $part.Trim()
      if ($t) { $items += $t }
    }
  }
  return (($items | Select-Object -Unique) -join ',')
}

function Invoke-CopilotPrompt([string]$prompt, [hashtable]$settings, [hashtable]$opts, [string]$sessionId, [string]$resumeId) {
  $inv = Get-CopilotInvoker
  $exe = [string]$inv.exe
  $cargs = @() + $inv.prefix
  if ($settings.dir) { $cargs += @('-C', $settings.dir) }
  if ($settings.model) { $cargs += @('--model', $settings.model) }
  if ($settings.agent) { $cargs += @('--agent', [string]$settings.agent) }
  # --resume y --allow-tool declaran valor OPCIONAL en Copilot CLI: solo enlazan con la forma "=".
  if ($resumeId) { $cargs += ("--resume=" + $resumeId) }
  elseif ($sessionId) { $cargs += @('--session-id', $sessionId) }
  foreach ($a in $opts.attachments) { $cargs += @('--attachment', [string]$a) }
  foreach ($d in $opts.addDirs) { $cargs += @('--add-dir', [string]$d) }
  $cargs += Build-PermissionArgs $settings
  $cargs += Build-AgentArgs $settings
  $maxCredits = ConvertTo-IntValue $settings.maxCredits 0
  if ($maxCredits -gt 0) { $cargs += @('--max-ai-credits', [string]$maxCredits) }

  $usageFile = Join-Path ([System.IO.Path]::GetTempPath()) ("askcli-usage-" + [Guid]::NewGuid().ToString() + ".json")
  $cargs += @('--usage-output-file', $usageFile)
  # Siempre pedimos JSONL: es la unica forma de saber que se ejecuto de verdad.
  $cargs += @('--no-color', '--output-format', 'json')
  foreach ($p in $opts.passthrough) { $cargs += [string]$p }
  $finalPrompt = if ($inv.multiline) { $prompt } else { ConvertTo-SingleLinePrompt $prompt }
  $cargs += @('--prompt', $finalPrompt)

  $rawLines = [System.Collections.Generic.List[string]]::new()
  $toolCalls = [System.Collections.Generic.List[object]]::new()
  $textSb = New-Object System.Text.StringBuilder
  # Hashtable compartida: las asignaciones directas no cruzan el scope de ForEach-Object.
  $meta = @{ sessionId = ''; exitCode = $null; failed = 0; filesModified = @(); premium = 0; apiMs = 0; sessionMs = 0; linesAdded = 0; linesRemoved = 0; model = '' }
  $verbose = [bool]$opts.verbose
  $stream = ($settings.output -ne 'json') -and (-not $opts.noStream)

  & $exe @cargs 2>&1 | ForEach-Object {
    $line = [string]$_
    $rawLines.Add($line)
    if (-not $line.StartsWith('{')) {
      if ($verbose -and -not $script:NoiseRegex.IsMatch($line) -and $line.Trim()) {
        if ($stream) { Write-Host $line } else { [Console]::Error.WriteLine($line) }
      }
      return
    }
    $ev = $null
    try { $ev = $line | ConvertFrom-Json } catch { return }
    $etype = [string](Get-Prop $ev 'type')
    $data = Get-Prop $ev 'data'

    switch ($etype) {
      'assistant.message_delta' {
        $d = [string](Get-Prop $data 'deltaContent')
        if ($d) {
          [void]$textSb.Append($d)
          if ($stream) { Write-Host -NoNewline $d }
        }
      }
      'assistant.reasoning_delta' {
        if ($stream -and $verbose) {
          $d = [string](Get-Prop $data 'deltaContent')
          if ($d) { Write-Host -NoNewline $d -ForegroundColor DarkGray }
        }
      }
      'tool.execution_start' {
        $entry = @{
          id = [string](Get-Prop $data 'toolCallId')
          name = [string](Get-Prop $data 'toolName')
          summary = (Get-ToolSummary $data)
          success = $null
        }
        $toolCalls.Add($entry)
        if ($stream) {
          Write-Host ''
          Write-Host ('  > ' + $entry.name + $(if ($entry.summary) { ': ' + $entry.summary } else { '' })) -ForegroundColor DarkCyan
        }
      }
      'tool.execution_complete' {
        $id = [string](Get-Prop $data 'toolCallId')
        $ok = Get-Prop $data 'success'
        $okBool = ($null -eq $ok) -or [bool]$ok
        foreach ($t in $toolCalls) { if ($t.id -eq $id) { $t.success = $okBool } }
        if (-not $okBool) {
          $meta.failed = $meta.failed + 1
          if ($stream) { Write-Host '    (fallo)' -ForegroundColor DarkYellow }
        }
      }
      'result' {
        $meta.sessionId = [string](Get-Prop $ev 'sessionId')
        $ec = Get-Prop $ev 'exitCode'
        if ($null -ne $ec) { $meta.exitCode = [int]$ec }
        $u = Get-Prop $ev 'usage'
        if ($u) {
          $meta.premium = ConvertTo-IntValue (Get-Prop $u 'premiumRequests') 0
          $meta.apiMs = ConvertTo-IntValue (Get-Prop $u 'totalApiDurationMs') 0
          $meta.sessionMs = ConvertTo-IntValue (Get-Prop $u 'sessionDurationMs') 0
          $cc = Get-Prop $u 'codeChanges'
          if ($cc) {
            $meta.linesAdded = ConvertTo-IntValue (Get-Prop $cc 'linesAdded') 0
            $meta.linesRemoved = ConvertTo-IntValue (Get-Prop $cc 'linesRemoved') 0
            $fm = Get-Prop $cc 'filesModified'
            if ($fm) { $meta.filesModified = @($fm) }
          }
        }
      }
    }
  }
  $nativeExit = $LASTEXITCODE
  if ($stream -and $textSb.Length -gt 0) { Write-Host '' }

  try {
    if (Test-Path $usageFile) {
      $usageObj = (Get-Content $usageFile -Raw) | ConvertFrom-Json
      $meta.model = [string](Get-Prop $usageObj 'currentModel')
      Remove-Item $usageFile -Force -ErrorAction SilentlyContinue
    }
  } catch {}

  $exitCode = if ($null -ne $meta.exitCode) { $meta.exitCode } elseif ($null -ne $nativeExit) { $nativeExit } else { 0 }

  return @{
    code = $exitCode
    text = $textSb.ToString().Trim()
    resume = $(if ($meta.sessionId) { $meta.sessionId } else { $sessionId })
    route = $meta.model
    raw = ($rawLines -join [Environment]::NewLine)
    streamed = ($stream -and $textSb.Length -gt 0)
    toolCalls = $toolCalls
    toolFailed = $meta.failed
    filesModified = $meta.filesModified
    usage = @{
      premiumRequests = $meta.premium
      apiMs = $meta.apiMs
      sessionMs = $meta.sessionMs
      linesAdded = $meta.linesAdded
      linesRemoved = $meta.linesRemoved
    }
  }
}

# El backend del provider vertex es un servicio LOCAL y OPCIONAL (HanstlerS).
# No existe en una maquina limpia, asi que la URL es configurable y su ausencia
# no debe presentarse como un problema salvo que se vaya a usar de verdad.
function Get-HanstlersUrl($settings) {
  $u = [string](Get-Prop $settings 'hanstlersUrl')
  if (-not $u) { $u = 'http://127.0.0.1:8717' }
  return $u.TrimEnd('/')
}

# Comprueba si el backend local responde. Barato y con timeout corto: se usa
# antes de cada prompt de vertex, no puede costar segundos.
function Test-HanstlersUp([string]$baseUrl, [int]$timeoutSec = 3) {
  try {
    $null = Invoke-RestMethod -Uri ($baseUrl.TrimEnd('/') + '/healthz') -TimeoutSec $timeoutSec
    return $true
  } catch { return $false }
}

# Localiza el ejecutable instalado de HanstlerS.
function Find-HanstlersExe {
  $cands = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\HanstlerS\HanstlerS.exe'),
    (Join-Path ${env:ProgramFiles} 'HanstlerS\HanstlerS.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'HanstlerS\HanstlerS.exe')
  ) | Where-Object { $_ }
  foreach ($c in $cands) { if (Test-Path $c) { return $c } }
  return ''
}

# Descubre en que puerto escucha HanstlerS de verdad. Sirve para diagnosticar
# el fallo mas comun: hanstlersUrl apuntando a un puerto que ya no se usa.
function Find-HanstlersPort {
  try {
    $pids = @(Get-Process -Name 'HanstlerS' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    if (-not $pids) { return '' }
    $conns = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
             Where-Object { $pids -contains $_.OwningProcess }
    foreach ($c in ($conns | Sort-Object LocalPort)) {
      if (Test-HanstlersUp ("http://127.0.0.1:" + $c.LocalPort) 2) { return [string]$c.LocalPort }
    }
  } catch {}
  return ''
}

# provider=vertex depende del backend local. Si no esta arriba, ask-cli moria
# con "Error conectando" y habia que abrir la app a mano. Ahora la arranca y
# espera a que responda: el usuario no deberia notar la diferencia.
function Ensure-HanstlersUp([string]$baseUrl, [hashtable]$settings, [hashtable]$opts) {
  if (Test-HanstlersUp $baseUrl 3) { return @{ ok = $true; started = $false } }
  # Un unico sondeo de 3s da falsos negativos cuando el backend esta ocupado
  # sirviendo otra peticion (visto en vivo: HanstlerS respondia /healthz pero
  # ask-cli lo daba por muerto y perdia 60s "arrancandolo"). Se confirma.
  Start-Sleep -Milliseconds 400
  if (Test-HanstlersUp $baseUrl 10) { return @{ ok = $true; started = $false } }

  # Solo tiene sentido levantar la app si el backend es el local.
  if ($baseUrl -notmatch '^https?://(127\.0\.0\.1|localhost)(:|/|$)') {
    return @{ ok = $false; started = $false; error = "El backend remoto $baseUrl no responde." }
  }
  if (-not (ConvertTo-BoolValue (Get-Prop $settings 'autoStartHanstlers') $true)) {
    return @{ ok = $false; started = $false; error = "HanstlerS no responde en $baseUrl y autoStartHanstlers esta desactivado." }
  }

  $exe = Find-HanstlersExe
  if (-not $exe) {
    return @{ ok = $false; started = $false; error = "HanstlerS no responde en $baseUrl y no encontre HanstlerS.exe instalado." }
  }

  # Si el proceso YA corre pero la URL no contesta, arrancarlo otra vez no
  # arregla nada: lo que falla es hanstlersUrl (puerto equivocado). Avisar al
  # momento en vez de esperar el timeout completo para nada.
  $yaCorre = @(Get-Process -Name 'HanstlerS' -ErrorAction SilentlyContinue).Count -gt 0
  if ($yaCorre) {
    $puerto = Find-HanstlersPort
    if ($puerto -and ($baseUrl -notmatch (':' + $puerto + '\b'))) {
      return @{ ok = $false; started = $false; resuelto = $true; error = "HanstlerS ya esta abierto pero escucha en http://127.0.0.1:$puerto, no en $baseUrl. Corrigelo con: ask-cli config set hanstlersUrl http://127.0.0.1:$puerto" }
    }
    return @{ ok = $false; started = $false; resuelto = $true; error = "HanstlerS ya esta abierto pero no responde en $baseUrl. Revisa hanstlersUrl (ask-cli config show) o reinicia la app." }
  }

  Write-Notice "HanstlerS no esta abierto; lo arranco..." $settings 'DarkGray'
  try { Start-Process -FilePath $exe -WindowStyle Minimized | Out-Null }
  catch { return @{ ok = $false; started = $false; error = "No pude arrancar HanstlerS: $($_.Exception.Message)" } }

  $espera = ConvertTo-IntValue (Get-Prop $settings 'startTimeoutSec') 60
  if ($espera -le 0) { $espera = 60 }
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $espera) {
    Start-Sleep -Milliseconds 1000
    if (Test-HanstlersUp $baseUrl 3) {
      Write-Notice ("HanstlerS listo en " + [math]::Round($sw.Elapsed.TotalSeconds, 1) + "s.") $settings 'DarkGray'
      return @{ ok = $true; started = $true }
    }
  }
  return @{ ok = $false; started = $true; error = "Arranque HanstlerS pero no respondio en $espera s." }
}

function Invoke-VertexPrompt([string]$prompt, [hashtable]$settings, [hashtable]$opts, [hashtable]$cfg) {
  $model = if ($opts.model) { $opts.model } else { $settings.vertexModel }
  if (-not $model) { $model = 'vertex-gemini-pro' }
  $baseUrl = Get-HanstlersUrl $settings
  $convId = if ($opts.resume) { $opts.resume } else { ('askcli-' + [Guid]::NewGuid().ToString()) }

  # Sin backend no hay ruta vertex: se levanta antes de gastar el prompt.
  $up = Ensure-HanstlersUp $baseUrl $settings $opts
  if (-not $up.ok) {
    # La pista depende de donde vive el backend: sugerir el .exe local cuando
    # hanstlersUrl apunta a otra maquina solo confunde.
    $esLocal = ($baseUrl -match '^https?://(127\.0\.0\.1|localhost)(:|/|$)')
    $exe = if ($esLocal) { Find-HanstlersExe } else { '' }
    $pista = if (Get-Prop $up 'resuelto') {
      # El error ya trae el comando exacto para arreglarlo; anadir mas confunde.
      ''
    } elseif ($exe) {
      " Abrelo a mano: $exe"
    } elseif ($esLocal) {
      " Instala HanstlerS o usa --provider copilot."
    } else {
      " Revisa que HanstlerS este abierto en esa maquina y que el puerto sea alcanzable, o usa --provider copilot."
    }
    return @{ code = 1; text = ([string]$up.error + $pista); resume = $convId; route = ''; raw = ''; streamed = $false }
  }
  $body = @{
    message = $prompt
    model = $model
    convId = $convId
  } | ConvertTo-Json -Depth 6
  $response = $null
  $reader = $null
  $event = ''
  $route = ''
  $acc = ''
  $errText = ''
  $doneCode = 0
  $rawLines = New-Object System.Collections.Generic.List[string]
  $printedStream = $false

  try {
    $req = [System.Net.HttpWebRequest]::Create(($baseUrl.TrimEnd('/') + '/api/chat'))
    $req.Method = 'POST'
    $req.ContentType = 'application/json'
    $timeoutMs = (ConvertTo-IntValue $settings.timeoutSec 180) * 1000
    if ($timeoutMs -le 0) { $timeoutMs = 180000 }
    $req.Timeout = $timeoutMs
    $req.ReadWriteTimeout = $timeoutMs
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    $req.ContentLength = $bytes.Length
    $reqStream = $req.GetRequestStream()
    $reqStream.Write($bytes, 0, $bytes.Length)
    $reqStream.Dispose()
    $response = $req.GetResponse()
    $reader = [System.IO.StreamReader]::new($response.GetResponseStream())
    while (-not $reader.EndOfStream) {
      $line = $reader.ReadLine()
      if ($null -eq $line) { continue }
      $rawLines.Add($line)
      if ($line -like 'event:*') {
        $event = ($line -replace '^event:\s*', '').Trim()
        continue
      }
      if ($line -notlike 'data:*') { continue }
      $dataRaw = ($line -replace '^data:\s*', '').Trim()
      if ($event -eq 'chunk') {
        $chunkText = ''
        try { $chunkText = [string]($dataRaw | ConvertFrom-Json) } catch { $chunkText = $dataRaw }
        $acc += $chunkText
        if ($settings.output -ne 'json' -and -not $opts.noStream) {
          Write-Host -NoNewline $chunkText
          $printedStream = $true
        }
      } elseif ($event -eq 'route') {
        try { $obj = $dataRaw | ConvertFrom-Json; if ($obj.model) { $route = [string]$obj.model } } catch {}
      } elseif ($event -eq 'status') {
        if (-not $opts.quiet -and $settings.output -ne 'json' -and -not $opts.noStream) {
          try { $statusText = [string]($dataRaw | ConvertFrom-Json); if ($statusText) { Write-Host ("`n[status] " + $statusText) } } catch {}
        }
      } elseif ($event -eq 'error') {
        try { $errText = [string]($dataRaw | ConvertFrom-Json) } catch { $errText = $dataRaw }
      } elseif ($event -eq 'done') {
        try {
          $objDone = $dataRaw | ConvertFrom-Json
          if ($null -ne $objDone.code) { $doneCode = [int]$objDone.code }
        } catch {}
      }
    }
  } catch [System.Net.WebException] {
    $statusCode = 0
    $errBody = ''
    if ($_.Exception.Response) {
      try {
        $resp = $_.Exception.Response
        $statusCode = [int]$resp.StatusCode
        $rdr = [System.IO.StreamReader]::new($resp.GetResponseStream())
        $errBody = $rdr.ReadToEnd()
        $rdr.Dispose()
      } catch {}
    }
    $msg = if ($statusCode -gt 0) {
      "HTTP $statusCode desde HanstlerS ($baseUrl). Mira la ventana de HanstlerS para el detalle."
    } else {
      "Se corto la conexion con HanstlerS ($baseUrl) a mitad de la respuesta. Comprueba que siga abierto y reintenta."
    }
    return @{ code = 1; text = $msg; resume = $convId; route = $route; raw = $errBody; streamed = $printedStream }
  } catch {
    return @{ code = 1; text = "Fallo hablando con HanstlerS ($baseUrl): $($_.Exception.Message)"; resume = $convId; route = $route; raw = $_.Exception.Message; streamed = $printedStream }
  } finally {
    if ($printedStream -and $settings.output -ne 'json' -and -not $opts.noStream) { Write-Host '' }
    if ($reader) { try { $reader.Dispose() } catch {} }
    if ($response) { try { $response.Dispose() } catch {} }
  }

  $raw = ($rawLines -join "`n")
  if ($errText) { return @{ code = 1; text = $errText; resume = $convId; route = $route; raw = $raw; streamed = $printedStream } }
  return @{ code = $doneCode; text = $acc.Trim(); resume = $convId; route = $route; raw = $raw; streamed = $printedStream }
}

# Los avisos de progreso nunca deben ir a stdout en modo --json: contaminarian
# el envelope y romperian cualquier consumidor que haga ConvertFrom-Json.
function Write-Notice([string]$msg, [hashtable]$settings, [string]$color = 'Yellow') {
  if ($settings -and $settings.output -eq 'json') {
    [Console]::Error.WriteLine($msg)
  } else {
    Write-Host $msg -ForegroundColor $color
  }
}

function Invoke-AskPrompt([string]$prompt, [hashtable]$settings, [hashtable]$opts, [hashtable]$cfg) {
  $isVertex = ($settings.provider -eq 'vertex')
  $effective = Build-ExecutionFirstPrompt $prompt $settings

  if ($isVertex) {
    # Los flags desconocidos solo tienen sentido como passthrough a Copilot CLI.
    # En la ruta Vertex se descartan, y hacerlo en silencio convertia cualquier
    # errata (--modell) en una opcion que el usuario cree aplicada y no lo esta.
    if (@($opts.passthrough).Count -gt 0) {
      $ignorados = (@($opts.passthrough) | Where-Object { $_ -like '--*' }) -join ', '
      if ($ignorados) {
        Write-Notice "Aviso: en modo vertex se ignoran estos flags: $ignorados (solo aplican a --provider copilot). Revisa si hay una errata." $settings 'DarkYellow'
      }
    }
    $res = Invoke-VertexPrompt $effective $settings $opts $cfg
    if ((ConvertTo-BoolValue $opts.retry $true) -and (ConvertTo-BoolValue $cfg.retry $true) -and
        ($res.code -eq 0) -and (Is-NonOperationalCopilotReply $res.text)) {
      $res = Invoke-VertexPrompt ($effective + "`n`nREINTENTO OBLIGATORIO: ejecuta la tarea ahora, no pidas más datos intermedios.") $settings $opts $cfg
    }
    if ($res.resume) { $cfg.lastVertexConvId = $res.resume }

    # HanstlerS no expone telemetria estructurada, pero SI ejecuta herramientas
    # por esta ruta (reenruta a su agente cuando la tarea es de ejecucion). La
    # evidencia viaja incrustada en el texto, asi que se reconstruye desde ahi.
    # Antes se devolvia verified=$true sin comprobar nada: el envelope afirmaba
    # que la corrida estaba verificada cuando ningun gate la habia mirado.
    $vt = Get-VertexToolCalls ([string]$res.text)
    $res.toolCalls = $vt.calls
    $res.toolFailed = $vt.failed
    $res.filesModified = $vt.filesModified
    $res.usage = @{ premiumRequests = 0; apiMs = 0; sessionMs = 0; linesAdded = 0; linesRemoved = 0 }
    Set-Prop $res 'quality' $null

    $wantVerify = (ConvertTo-BoolValue $opts.verify $true) -and (ConvertTo-BoolValue $cfg.verify $true)
    $wantRetry = (ConvertTo-BoolValue $opts.retry $true) -and (ConvertTo-BoolValue $cfg.retry $true)
    $loopThreshold = ConvertTo-IntValue (Get-Prop $settings 'loopThreshold') 3
    $verification = @{ ok = $true; issues = @(); actionable = $false; loop = @{ found = $false } }

    if ($wantVerify -and $res.code -eq 0) {
      $verification = Test-ResponseVerification $res $prompt $loopThreshold
      if ((-not $verification.ok) -and $wantRetry -and $res.resume) {
        if (-not $opts.quiet) {
          Write-Notice '[ask-cli] verificacion fallida, reintentando con evidencia:' $settings
          foreach ($i in $verification.issues) { Write-Notice ('  - ' + $i) $settings }
        }
        # El reintento reusa el convId: HanstlerS conserva el transcript del
        # agente por conversacion, asi que el reintento continua el trabajo en
        # vez de empezar de cero.
        $retryOpts = @{}
        foreach ($k in $opts.Keys) { $retryOpts[$k] = $opts[$k] }
        $retryOpts.resume = $res.resume
        $retryRes = Invoke-VertexPrompt (Build-VerificationFeedback $verification $res) $settings $retryOpts $cfg
        if ($retryRes.code -eq 0) {
          $rt = Get-VertexToolCalls ([string]$retryRes.text)
          # Las llamadas del turno anterior se conservan como evidencia pero se
          # marcan 'prior': la deteccion de bucle solo juzga el turno nuevo.
          $merged = @($rt.calls)
          foreach ($t in $res.toolCalls) { Set-Prop $t 'prior' $true; $merged += $t }
          $retryRes.toolCalls = $merged
          $retryRes.toolFailed = $rt.failed + $res.toolFailed
          $retryRes.filesModified = if (@($rt.filesModified).Count -eq 0) { $res.filesModified } else { $rt.filesModified }
          $retryRes.usage = $res.usage
          Set-Prop $retryRes 'quality' $null
          $res = $retryRes
          $verification = Test-ResponseVerification $res $prompt $loopThreshold
        }
      }
    }

    $res.verified = [bool]$verification.ok
    $res.issues = @($verification.issues)
    # code != 0 significa que no hubo respuesta que verificar. El default
    # optimista de $verification hacia que un fallo saliera con verified=$true.
    if ($res.code -ne 0) {
      $res.verified = $false
      if (@($res.issues).Count -eq 0) {
        $res.issues = @("La invocacion fallo (exit $($res.code)); no se verifico nada.")
      }
    }
    return $res
  }

  # Fijamos el UUID de sesion por adelantado: el reintento reusa la misma sesion
  # (conserva contexto y aprovecha el prompt cache en vez de repagarlo).
  $sessionId = if ($opts.resume) { '' } else { [Guid]::NewGuid().ToString() }
  $resumeId = [string]$opts.resume

  $res = Invoke-CopilotPrompt $effective $settings $opts $sessionId $resumeId

  # Algunos modelos (entre ellos el default "auto") rechazan --effort y abortan
  # la corrida entera. Degradamos en vez de fallar: el trabajo importa mas que el flag.
  if ($res.code -ne 0 -and $settings.effort -and
      ([string]$res['raw'] -match 'does not support reasoning effort')) {
    if (-not $opts.quiet) {
      Write-Notice ("[ask-cli] el modelo '" + $settings.model + "' no admite --effort " + $settings.effort + "; reintentando sin ese flag") $settings
    }
    $degraded = @{}
    foreach ($k in $settings.Keys) { $degraded[$k] = $settings[$k] }
    $degraded.effort = ''
    $settings = $degraded
    $res = Invoke-CopilotPrompt $effective $settings $opts ([Guid]::NewGuid().ToString()) $resumeId
  }

  $wantVerify = (ConvertTo-BoolValue $opts.verify $true) -and (ConvertTo-BoolValue $cfg.verify $true)
  $wantRetry = (ConvertTo-BoolValue $opts.retry $true) -and (ConvertTo-BoolValue $cfg.retry $true)
  $loopThreshold = ConvertTo-IntValue (Get-Prop $settings 'loopThreshold') 3
  $verification = @{ ok = $true; issues = @(); actionable = $false; loop = @{ found = $false } }

  if ($wantVerify -and $res.code -eq 0) {
    $verification = Test-ResponseVerification $res $prompt $loopThreshold
    if ((-not $verification.ok) -and $wantRetry -and $res.resume) {
      if (-not $opts.quiet) {
        Write-Notice '[ask-cli] verificacion fallida, reintentando con evidencia:' $settings
        foreach ($i in $verification.issues) { Write-Notice ('  - ' + $i) $settings }
      }
      $feedback = Build-VerificationFeedback $verification $res
      $retryRes = Invoke-CopilotPrompt $feedback $settings $opts '' $res.resume
      if ($retryRes.code -eq 0) {
        # El reintento continua la misma sesion: acumulamos la evidencia de ambos turnos.
        # Se marcan como 'prior' para que la deteccion de bucle juzgue solo el turno nuevo.
        foreach ($t in $res.toolCalls) { Set-Prop $t 'prior' $true; $retryRes.toolCalls.Add($t) }
        $retryRes.toolFailed = $retryRes.toolFailed + $res.toolFailed
        if (@($retryRes.filesModified).Count -eq 0) { $retryRes.filesModified = $res.filesModified }
        $res = $retryRes
        $verification = Test-ResponseVerification $res $prompt $loopThreshold
      }
    }
  }

  $res.verified = [bool]$verification.ok
  $res.issues = @($verification.issues)

  # Gate de calidad: solo tiene sentido si realmente se toco codigo.
  Set-Prop $res 'quality' $null
  $touched = (@($res.filesModified).Count -gt 0) -or (Test-HasWriteTool $res.toolCalls)
  $wantQuality = (ConvertTo-BoolValue (Get-Prop $opts 'quality') $true) -and (ConvertTo-BoolValue (Get-Prop $settings 'qualityGate') $false)
  if ($wantQuality -and $res.code -eq 0 -and $touched) {
    $qc = Get-QualityCommand (Get-Prop $settings 'dir') ([string](Get-Prop $settings 'verifyCommand'))
    if ($null -eq $qc) {
      if (-not $opts.quiet) { Write-Notice '[ask-cli] gate de calidad: no se detecto suite de tests, se omite' $settings 'DarkGray' }
    } else {
      if (-not $opts.quiet) { Write-Notice ("[ask-cli] gate de calidad (" + $qc.name + "): " + $qc.cmd) $settings 'DarkCyan' }
      $gate = Invoke-QualityGate (Get-Prop $settings 'dir') $qc.cmd $settings.timeoutSec

      if (-not $gate.ok -and $wantRetry -and $res.resume) {
        if (-not $opts.quiet) { Write-Notice '[ask-cli] la suite falla, devolviendo el error al agente...' $settings }
        $fix = Invoke-CopilotPrompt (Build-QualityFeedback $gate) $settings $opts '' $res.resume
        if ($fix.code -eq 0) {
          foreach ($t in $res.toolCalls) { Set-Prop $t 'prior' $true; $fix.toolCalls.Add($t) }
          $fix.toolFailed = $fix.toolFailed + $res.toolFailed
          if (@($fix.filesModified).Count -eq 0) { $fix.filesModified = $res.filesModified }
          $res = $fix
          # Re-verificar en vez de asumir el exito: que la suite acabe en verde no
          # borra que el agente afirmara haber hecho algo que no hizo. Asignar
          # verified=$true a ciegas descartaba issues legitimos del turno anterior.
          if ($wantVerify) {
            $verification = Test-ResponseVerification $res $prompt $loopThreshold
            $res.verified = [bool]$verification.ok
            $res.issues = @($verification.issues)
          } else {
            $res.verified = $true
            $res.issues = @()
          }
          $gate = Invoke-QualityGate (Get-Prop $settings 'dir') $qc.cmd $settings.timeoutSec
        }
      }

      Set-Prop $res 'quality' $gate
      if (-not $gate.ok) {
        $res.verified = $false
        $res.issues = @($res.issues) + ("La suite del proyecto falla (" + $qc.cmd + ", exit " + $gate.exitCode + ").")
      }
    }
  }

  # Coherencia del envelope: si la invocacion fallo (code != 0) no hay nada que
  # verificar. Devolver verified=$true junto a ok=$false confundia a cualquier
  # consumidor que mirase solo verified.
  if ((Get-Prop $res 'code') -ne 0) {
    $res.verified = $false
    if (@($res.issues).Count -eq 0) {
      $res.issues = @("La invocacion fallo (exit $($res.code)); no se verifico nada.")
    }
  }

  if ($res.resume) { $cfg.lastResume = $res.resume }
  return $res
}
function Show-Help {
@'
ask-cli - Wrapper avanzado para Copilot CLI + Vertex (HanstlerS)

Uso:
  ask-cli run "pregunta..." [opciones]
  ask-cli chat [--provider copilot] [--model <id>] [--resume <sessionId>]
  ask-cli resume [sessionId] [--provider copilot|vertex]
  ask-cli sessions [list|clear] [n]
  ask-cli model show
  ask-cli model set <id>
  ask-cli auth status|login|logout
  ask-cli doctor
  ask-cli install
  ask-cli uninstall
  ask-cli version
  ask-cli init-instructions [ruta]
  ask-cli project init [ruta] [--provider ...] [--model ...] [--strict-profile|--relaxed-profile]
  ask-cli project show [ruta]
  ask-cli project strict on|off [ruta]
  ask-cli config show
  ask-cli config set <clave> <valor>

Opciones:
  --provider copilot|vertex   Backend a usar.
  --model <id>                Modelo (copilot) o modelo directo.
  --vertex-model <id>         Modelo para provider vertex.
  --dir <ruta>                Directorio de trabajo (-C en Copilot CLI).
  --add-dir <ruta>            Directorio extra de contexto (repetible).
  --attach <ruta>             Adjunto (repetible).
  --resume <id>               Reanuda sesion.
  --allow-tool <lista>        Herramientas disponibles en modo safe (restringe el catalogo).
  --deny-tool <lista>         Herramientas prohibidas (acumulable; aplica tambien en trusted).
  --agent <nombre>            Agente custom de Copilot CLI.
  --max-credits <n>           Limite de AI credits premium por sesion.
  --timeout <seg>             Timeout de red del provider vertex.
  --json                      Salida JSON (desactiva streaming).
  --quiet                     Sin mensajes accesorios.
  --verbose                   Muestra razonamiento y telemetria detallada.
  --no-stream                 Desactiva streaming incremental.
  --no-retry                  No reintenta ante verificacion fallida.
  --no-verify                 Desactiva la verificacion determinista de ejecucion.
  --safe | --trusted          Atajos de modo de permisos.

Autonomia del agente:
  --dev                       Modo dev autonomo: autopilot + trusted + effort high
                              + gate de calidad. Es el atajo recomendado.
  --autopilot                 El agente ejecuta el ciclo completo sin intervencion.
  --plan                      Solo planifica, no ejecuta cambios.
  --agent-mode <m>            interactive|plan|autopilot.
  --effort <nivel>            none|minimal|low|medium|high|xhigh|max.
  --max-continues <n>         Iteraciones maximas de autopilot (default Copilot: 5).
  --assisted-approval         Juez de aprobacion de Copilot (experimental; NO es
                              una barrera de seguridad fiable, ver README).
  --no-ask-user               Prohibe al agente hacer preguntas (falla en vez de preguntar).

Gate de calidad:
  --quality                   Ejecuta la suite real del proyecto tras tocar codigo.
  --verify-cmd <cmd>          Comando de verificacion explicito (implica --quality).
  --no-quality                Desactiva el gate aunque este activo en config.
  --force-profile-override    Ignora un perfil estricto.
  --                          Todo lo que siga es prompt literal.

Verificacion anti-alucinacion:
  Se analiza el JSONL de Copilot CLI (--output-format json) en vez de adivinar sobre la prosa:
    1. Tarea accionable sin ninguna herramienta ejecutada  -> fallo
    2. Afirma haber escrito/creado archivos pero no hubo write-tool ni codeChanges -> fallo
    3. Toda herramienta ejecutada fallo -> fallo
  Ante fallo se reintenta sobre la MISMA sesion (--resume) reusando el prompt cache.
  Exit code 3 si sigue sin verificar. Usa --no-verify para desactivarlo.

Notas:
  - Modo safe: --available-tools + --allow-tool (default view,glob,rg). Restringe de verdad
    el catalogo: --allow-tool por si solo NO limita, solo evita el prompt de confirmacion.
  - Modo trusted: --allow-all-tools, respetando --deny-tool si se especifica.
  - Sintaxis granular soportada por Copilot CLI: --deny-tool 'shell(git push)'
  - Flags --* no reconocidos se reenvian tal cual a Copilot CLI (passthrough), p.ej. MCP.
  - Provider vertex usa HanstlerS local API en http://127.0.0.1:8717/api/chat.
  - Perfil estricto bloquea provider/model/mode/dir del proyecto; usa --force-profile-override.
  - `init-instructions` mueve el guard a AGENTS.md (cacheado por Copilot) y ahorra tokens por llamada.
  - Claves de config: provider, model, vertexModel, mode, dir, output, copilotPath,
    allowTools, denyTools, timeoutSec, historyMax, retry, verify, guard, agent, maxCredits.
'@ | Write-Host
}

function Parse-Options([string[]]$tokens) {
  $opts = @{
    provider = ''
    model = ''
    vertexModel = ''
    mode = ''
    output = ''
    dir = ''
    resume = ''
    attachments = @()
    addDirs = @()
    passthrough = @()
    allowTools = ''
    denyTools = ''
    agent = ''
    maxCredits = 0
    timeoutSec = 0
    quiet = $false
    noStream = $false
    verbose = $false
    retry = $true
    verify = $true
    quality = $true
    agentMode = ''
    effort = ''
    assistedApproval = $null
    maxContinues = 0
    noAskUser = $null
    qualityGate = $null
    verifyCommand = ''
    dev = $false
    forceProfileOverride = $false
    strictProfile = ''
    prompt = @()
  }
  $i = 0
  while ($i -lt $tokens.Count) {
    $t = [string]$tokens[$i]
    switch ($t) {
      '--provider' { $i++; if ($i -lt $tokens.Count) { $opts.provider = [string]$tokens[$i] } }
      '--model'    { $i++; if ($i -lt $tokens.Count) { $opts.model = [string]$tokens[$i] } }
      '--vertex-model' { $i++; if ($i -lt $tokens.Count) { $opts.vertexModel = [string]$tokens[$i] } }
      '--mode'     { $i++; if ($i -lt $tokens.Count) { $opts.mode = [string]$tokens[$i] } }
      '--dir'      { $i++; if ($i -lt $tokens.Count) { $opts.dir = [string]$tokens[$i] } }
      '--resume'   { $i++; if ($i -lt $tokens.Count) { $opts.resume = [string]$tokens[$i] } }
      '--attach'   { $i++; if ($i -lt $tokens.Count) { $opts.attachments += [string]$tokens[$i] } }
      '--add-dir'  { $i++; if ($i -lt $tokens.Count) { $opts.addDirs += [string]$tokens[$i] } }
      '--allow-tool' { $i++; if ($i -lt $tokens.Count) { $opts.allowTools = [string]$tokens[$i] } }
      '--deny-tool' { $i++; if ($i -lt $tokens.Count) { $opts.denyTools = ConvertTo-ToolList @($opts.denyTools, $tokens[$i]) } }
      '--agent'    { $i++; if ($i -lt $tokens.Count) { $opts.agent = [string]$tokens[$i] } }
      '--agent-mode' { $i++; if ($i -lt $tokens.Count) { $opts.agentMode = [string]$tokens[$i] } }
      '--autopilot' { $opts.agentMode = 'autopilot' }
      '--plan'      { $opts.agentMode = 'plan' }
      '--effort'    { $i++; if ($i -lt $tokens.Count) { $opts.effort = [string]$tokens[$i] } }
      '--assisted-approval' { $opts.assistedApproval = $true }
      '--max-continues' { $i++; if ($i -lt $tokens.Count) { $opts.maxContinues = ConvertTo-IntValue $tokens[$i] 0 } }
      '--no-ask-user' { $opts.noAskUser = $true }
      '--quality'   { $opts.qualityGate = $true }
      '--no-quality' { $opts.quality = $false }
      '--verify-cmd' { $i++; if ($i -lt $tokens.Count) { $opts.verifyCommand = [string]$tokens[$i]; $opts.qualityGate = $true } }
      # --dev: autonomia maxima con red de seguridad real (tests del proyecto).
      '--dev' {
        $opts.dev = $true
        $opts.agentMode = 'autopilot'
        $opts.qualityGate = $true
        if (-not $opts.mode) { $opts.mode = 'trusted' }
        if (-not $opts.effort) { $opts.effort = 'high' }
        if ((ConvertTo-IntValue $opts.maxContinues 0) -le 0) { $opts.maxContinues = 15 }
      }
      '--max-credits' { $i++; if ($i -lt $tokens.Count) { $opts.maxCredits = ConvertTo-IntValue $tokens[$i] 0 } }
      '--timeout'  { $i++; if ($i -lt $tokens.Count) { $opts.timeoutSec = ConvertTo-IntValue $tokens[$i] 0 } }
      '--json'     { $opts.output = 'json' }
      '--quiet'    { $opts.quiet = $true }
      '--verbose'  { $opts.verbose = $true }
      '--no-stream' { $opts.noStream = $true }
      '--no-retry' { $opts.retry = $false }
      '--retry'    { $opts.retry = $true }
      '--no-verify' { $opts.verify = $false }
      '--verify'   { $opts.verify = $true }
      '--safe'     { $opts.mode = 'safe' }
      '--trusted'  { $opts.mode = 'trusted' }
      '--force-profile-override' { $opts.forceProfileOverride = $true }
      '--strict-profile' { $opts.strictProfile = 'strict' }
      '--relaxed-profile' { $opts.strictProfile = 'relaxed' }
      default {
        if ($t -eq '--') {
          # Todo lo que sigue es prompt literal.
          $i++
          while ($i -lt $tokens.Count) { $opts.prompt += [string]$tokens[$i]; $i++ }
        } elseif ($t.StartsWith('--')) {
          # Flag desconocido: se reenvia tal cual a Copilot CLI (passthrough).
          $opts.passthrough += $t
          if (($i + 1) -lt $tokens.Count -and -not ([string]$tokens[$i + 1]).StartsWith('-')) {
            $i++
            $opts.passthrough += [string]$tokens[$i]
          }
        } else {
          $opts.prompt += $t
        }
      }
    }
    $i++
  }
  return $opts
}

function Write-AskResult([hashtable]$res, [hashtable]$settings, [hashtable]$opts) {
  if ($settings.output -eq 'json') {
    $tools = @()
    foreach ($t in $res.toolCalls) { $tools += @{ name = $t.name; summary = $t.summary; success = $t.success } }
    @{
      ok = ($res.code -eq 0 -and $res.verified)
      provider = $settings.provider
      resume = $res.resume
      route = [string]$res['route']
      verified = $res.verified
      issues = @($res.issues)
      tools = $tools
      filesModified = @($res.filesModified)
      quality = Get-Prop $res 'quality'
      usage = $res['usage']
      text = $res.text
    } | ConvertTo-Json -Depth 8
    return
  }

  if ($res.text -and -not ($res['streamed'] -eq $true)) { $res.text | Write-Host }
  if ($opts.quiet) { return }

  $toolCount = @($res.toolCalls).Count
  if ($toolCount -gt 0 -or @($res.filesModified).Count -gt 0) {
    $parts = @("$toolCount herramienta(s)")
    if ($res.toolFailed -gt 0) { $parts += "$($res.toolFailed) fallida(s)" }
    if (@($res.filesModified).Count -gt 0) { $parts += "$(@($res.filesModified).Count) archivo(s) modificado(s)" }
    $u = $res['usage']
    if ($u -and $u.premiumRequests -gt 0) { $parts += "$($u.premiumRequests) premium request(s)" }
    Write-Host ('[ask-cli] ' + ($parts -join ' | ')) -ForegroundColor DarkGray
  }
  if (-not $res.verified) {
    Write-Host '[ask-cli] SIN VERIFICAR:' -ForegroundColor Red
    foreach ($i in $res.issues) { Write-Host ('  - ' + $i) -ForegroundColor Red }
  }
  $q = Get-Prop $res 'quality'
  if ($q) {
    if ($q.ok) {
      Write-Host ("[ask-cli] calidad OK: " + $q.command + " (" + $q.ms + " ms)") -ForegroundColor Green
    } else {
      Write-Host ("[ask-cli] CALIDAD FALLIDA: " + $q.command + " (exit " + $q.exitCode + ")") -ForegroundColor Red
      foreach ($l in ($q.output -split "`n" | Select-Object -Last 12)) { Write-Host ('  ' + $l.TrimEnd()) -ForegroundColor DarkRed }
    }
  }
  if ($res.resume) { Write-Host ("resume: " + $res.resume) -ForegroundColor DarkGray }
}

function Get-AskExitCode([hashtable]$res) {
  if ($res.code -ne 0) { return $res.code }
  if (-not $res.verified) { return $script:ExitVerificationFailed }
  return 0
}

if ($env:ASKCLI_NO_MAIN -eq '1') { return }

if (-not $Args -or $Args.Count -eq 0) {
  Show-Help
  exit 0
}

$cfg = Load-Config
$script:Cfg = $cfg
$cmd = [string]$Args[0]

# Backward compatibility: ask-cli "pregunta"
if ($cmd -notin @('run','chat','resume','sessions','model','auth','doctor','install','uninstall','project','config','help','version','--version','-v','init-instructions')) {
  $opts = Parse-Options @($Args)
  $settings = Resolve-Settings $cfg $opts
  try {
    $policy = Apply-ProfilePolicy $cfg $opts $settings
    $settings = $policy.settings
  } catch {
    Write-Host $_.Exception.Message
    exit 1
  }
  $prompt = ($opts.prompt -join ' ').Trim()
  if (-not $prompt) { Show-Help; exit 1 }
  $res = Invoke-AskPrompt $prompt $settings $opts $cfg
  Save-Config $cfg
  Append-History @{
    ts = (Get-Date).ToString('s')
    provider = $settings.provider
    model = if ($settings.provider -eq 'vertex') { $settings.vertexModel } else { $settings.model }
    prompt = $prompt
    resume = $res.resume
    code = $res.code
    tools = @($res.toolCalls).Count
    verified = $res.verified
  }
  Write-AskResult $res $settings $opts
  exit (Get-AskExitCode $res)
}

switch ($cmd) {
  'help' {
    Show-Help
    exit 0
  }
  { $_ -in @('version','--version','-v') } {
    Write-Host ("ask-cli " + $script:AskCliVersion)
    exit 0
  }
  'run' {
    $opts = Parse-Options @($Args[1..($Args.Count-1)])
    $settings = Resolve-Settings $cfg $opts
    try {
      $policy = Apply-ProfilePolicy $cfg $opts $settings
      $settings = $policy.settings
    } catch {
      Write-Host $_.Exception.Message
      exit 1
    }
    $prompt = ($opts.prompt -join ' ').Trim()
    if (-not $prompt) { Write-Host "Falta prompt. Uso: ask-cli run `"tu pregunta`""; exit 1 }
    $res = Invoke-AskPrompt $prompt $settings $opts $cfg
    Save-Config $cfg
    Append-History @{
      ts = (Get-Date).ToString('s')
      provider = $settings.provider
      model = if ($settings.provider -eq 'vertex') { $settings.vertexModel } else { $settings.model }
      prompt = $prompt
      resume = $res.resume
      code = $res.code
      tools = @($res.toolCalls).Count
      verified = $res.verified
    }
    Write-AskResult $res $settings $opts
    exit (Get-AskExitCode $res)
  }
  'chat' {
    $opts = Parse-Options @($Args[1..($Args.Count-1)])
    $settings = Resolve-Settings $cfg $opts
    try {
      $policy = Apply-ProfilePolicy $cfg $opts $settings
      $settings = $policy.settings
    } catch {
      Write-Host $_.Exception.Message
      exit 1
    }
    if ($settings.provider -eq 'vertex') {
      Write-Host "Chat interactivo continuo no aplica para provider=vertex. Usa: ask-cli run ""prompt"" --provider vertex"
      exit 1
    }
    $cp = Get-CopilotInvoker
    $cpArgs = @() + $cp.prefix
    if ($settings.dir) { $cpArgs += @('-C', $settings.dir) }
    if ($settings.model) { $cpArgs += @('--model', $settings.model) }
    if ($opts.resume) { $cpArgs += ('--resume=' + $opts.resume) }
    $cpArgs += Build-PermissionArgs $settings
    foreach ($d in $opts.addDirs) { $cpArgs += @('--add-dir', [string]$d) }
    foreach ($p in $opts.passthrough) { $cpArgs += [string]$p }
    & $cp.exe @cpArgs
    exit $LASTEXITCODE
  }
  'init-instructions' {
    $target = if ($Args.Count -ge 2) { [string]$Args[1] } else { (Get-Location).Path }
    $path = Get-AgentsFilePath $target
    $block = $script:GuardMarker + "`n## Modo de ejecucion (ask-cli)`n`n" + (Get-GuardText) + "`n" + $script:GuardMarker
    if (Test-Path $path) {
      $existing = Get-Content $path -Raw
      if ($existing -like ('*' + $script:GuardMarker + '*')) {
        # Reemplaza el bloque anterior entre marcadores (idempotente).
        $pattern = [regex]::Escape($script:GuardMarker) + '[\s\S]*?' + [regex]::Escape($script:GuardMarker)
        $updated = [regex]::Replace($existing, $pattern, [System.Text.RegularExpressions.MatchEvaluator] { param($m) $block })
        Write-Utf8NoBom $path $updated
        Write-Host ("Bloque actualizado en: " + $path)
      } else {
        Write-Utf8NoBom $path ($existing.TrimEnd() + "`n`n" + $block + "`n")
        Write-Host ("Bloque anadido a: " + $path)
      }
    } else {
      Write-Utf8NoBom $path ("# AGENTS.md`n`n" + $block + "`n")
      Write-Host ("Creado: " + $path)
    }
    Write-Host "El guard ahora vive en las instrucciones cacheadas; ask-cli dejara de anteponerlo (guard=auto)."
    exit 0
  }
  'sessions' {
    $sub = if ($Args.Count -ge 2) { [string]$Args[1] } else { 'list' }
    if ($sub -eq 'clear') {
      if (Test-Path $HistoryPath) { Remove-Item $HistoryPath -Force }
      Write-Host 'Historial borrado.'
      exit 0
    }
    if ($sub -notin @('list')) { Write-Host 'Uso: ask-cli sessions [list|clear] [n]'; exit 1 }
    if (-not (Test-Path $HistoryPath)) { Write-Host 'Sin sesiones registradas.'; exit 0 }
    $n = if ($Args.Count -ge 3) { ConvertTo-IntValue $Args[2] 20 } else { 20 }
    if ($n -le 0) { $n = 20 }
    $lines = @(Get-Content $HistoryPath -Tail $n -ErrorAction SilentlyContinue)
    $rows = @()
    foreach ($l in $lines) {
      try { $rows += ($l | ConvertFrom-Json) } catch {}
    }
    if ($rows.Count -eq 0) { Write-Host 'Sin sesiones registradas.'; exit 0 }
    $rows |
      Select-Object ts, provider, model, code, resume,
        @{ n = 'prompt'; e = {
            $p = [string]$_.prompt
            if ($p.Length -gt 60) { $p.Substring(0, 60) + '...' } else { $p }
          } } |
      Format-Table -AutoSize
    exit 0
  }
  'resume' {
    $opts = Parse-Options @($Args[1..($Args.Count-1)])
    $id = ''
    if ($opts.prompt.Count -gt 0) { $id = [string]$opts.prompt[0] }
    if (-not $id) { $id = if ($opts.provider -eq 'vertex') { [string]$cfg.lastVertexConvId } else { [string]$cfg.lastResume } }
    if (-not $id) { $id = Get-LastResume }
    if (-not $id) { Write-Host "No hay sesión previa para reanudar."; exit 1 }
    if ($opts.provider -eq 'vertex') {
      Write-Host ("Reanuda Vertex usando: ask-cli run ""<prompt>"" --provider vertex --resume " + $id)
      exit 0
    }
    $cp = Get-CopilotInvoker
    $cpArgs = @() + $cp.prefix + @('--resume', $id)
    & $cp.exe @cpArgs
    exit $LASTEXITCODE
  }
  'model' {
    if ($Args.Count -lt 2 -or $Args[1] -eq 'show') {
      Write-Host ("provider=" + $cfg.provider)
      Write-Host ("model=" + $cfg.model)
      Write-Host ("vertexModel=" + $cfg.vertexModel)
      exit 0
    }
    if ($Args.Count -ge 3 -and $Args[1] -eq 'set') {
      $m = [string]$Args[2]
      if ($m -like 'vertex-*') { $cfg.provider = 'vertex'; $cfg.vertexModel = $m } else { $cfg.provider = 'copilot'; $cfg.model = $m }
      Save-Config $cfg
      Write-Host ("OK model=" + $m)
      exit 0
    }
    Write-Host "Uso: ask-cli model show | ask-cli model set <id>"
    exit 1
  }
  'auth' {
    $sub = if ($Args.Count -ge 2) { [string]$Args[1] } else { 'status' }
    $cp = Get-CopilotInvoker
    if ($sub -eq 'login') { $la = @() + $cp.prefix + @('login'); & $cp.exe @la; exit $LASTEXITCODE }
    if ($sub -eq 'logout') {
      $gh = Get-Command 'gh' -ErrorAction SilentlyContinue
      if ($gh) {
        & $gh.Path 'auth' 'logout' '--hostname' 'github.com' '--yes'
        exit $LASTEXITCODE
      }
      Write-Host "gh CLI no encontrado. Cierra sesión manualmente en GitHub CLI."
      exit 1
    }
    $gh2 = Get-Command 'gh' -ErrorAction SilentlyContinue
    if ($gh2) {
      & $gh2.Path 'auth' 'status'
      exit $LASTEXITCODE
    }
    Write-Host "gh CLI no encontrado para revisar estado."
    exit 1
  }
  'install' {
    # Instalacion portable: copia el CLI a $HOME\.ask-cli\bin y lo registra en el
    # PATH de usuario (no requiere admin). En otra maquina basta con clonar y
    # ejecutar esto para invocarlo como 'ask-cli' desde cualquier carpeta.
    $binDir = Join-Path $AskHome 'bin'
    $srcPs1 = $PSCommandPath
    if (-not $srcPs1) { $srcPs1 = $MyInvocation.MyCommand.Path }
    $srcDir = Split-Path -Parent $srcPs1
    $srcCmd = Join-Path $srcDir 'ask-cli.cmd'

    if ((Resolve-FullPath $srcDir) -eq (Resolve-FullPath $binDir)) {
      Write-Host "install: ya estas ejecutando la copia instalada; nada que hacer."
      exit 0
    }
    if (-not (Test-Path $srcCmd)) { Write-Host ("install: FAIL no se encontro " + $srcCmd); exit 1 }

    try {
      if (-not (Test-Path $binDir)) { New-Item -ItemType Directory -Path $binDir -Force | Out-Null }
      Copy-Item $srcPs1 (Join-Path $binDir 'ask-cli.ps1') -Force
      Copy-Item $srcCmd (Join-Path $binDir 'ask-cli.cmd') -Force
    } catch { Write-Host ("install: FAIL copiando: " + $_.Exception.Message); exit 1 }
    Write-Host ("install: copiado a " + $binDir)

    $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
    if (-not $userPath) { $userPath = '' }
    $entries = @($userPath -split ';' | Where-Object { $_ })
    if ($entries -contains $binDir) {
      Write-Host "install: PATH ya contenia la ruta"
    } else {
      try {
        [Environment]::SetEnvironmentVariable('PATH', (($entries + $binDir) -join ';'), 'User')
        Write-Host "install: anadido al PATH de usuario (abre una terminal nueva para usarlo)"
      } catch { Write-Host ("install: WARN no se pudo modificar el PATH: " + $_.Exception.Message) }
    }
    Write-Host "install: listo -> ask-cli doctor"
    exit 0
  }
  'uninstall' {
    $binDir = Join-Path $AskHome 'bin'
    if (Test-Path $binDir) {
      try { Remove-Item $binDir -Recurse -Force; Write-Host ("uninstall: eliminado " + $binDir) }
      catch { Write-Host ("uninstall: WARN no se pudo eliminar: " + $_.Exception.Message) }
    } else { Write-Host "uninstall: no estaba instalado" }
    $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
    if ($userPath) {
      $kept = @($userPath -split ';' | Where-Object { $_ -and $_ -ne $binDir })
      [Environment]::SetEnvironmentVariable('PATH', ($kept -join ';'), 'User')
      Write-Host "uninstall: PATH de usuario limpiado"
    }
    Write-Host ("uninstall: la config en " + $AskHome + " se conserva")
    exit 0
  }
  'doctor' {
    Write-Host ("=== ask-cli doctor (v" + $script:AskCliVersion + ") ===")
    Write-Host ("host: PowerShell " + $PSVersionTable.PSVersion)
    $pwsh = Get-Command 'pwsh' -ErrorAction SilentlyContinue
    if ($pwsh) { Write-Host ("pwsh7: OK (" + $pwsh.Path + ")") } else { Write-Host "pwsh7: WARN (no instalado; el arranque es mas lento en PS 5.1)" }
    try {
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      $cp = Get-CopilotCmd
      $sw.Stop()
      Write-Host ("copilot: OK (" + $cp + ") resuelto en " + $sw.ElapsedMilliseconds + " ms")
      $inv = Get-CopilotInvoker
      if ($inv.multiline) {
        Write-Host ("invoker: node directo (" + $inv.exe + ") - prompts multilinea OK")
      } else {
        Write-Host "invoker: WARN shim copilot.cmd (cmd.exe trunca en el primer salto de linea; los prompts se aplanan)"
      }
    } catch { Write-Host "copilot: FAIL"; exit 1 }
    $vtimeout = ConvertTo-IntValue $cfg.timeoutSec 180
    # El backend vertex es local y opcional: solo se sondea si el provider activo
    # lo va a usar. En una maquina limpia no existe, y anunciarlo como WARN daba
    # la impresion de que faltaba algo imprescindible.
    $docProvider = [string](Get-Prop $cfg 'provider')
    if ($docProvider -eq 'vertex') {
      $hUrl = Get-HanstlersUrl $cfg
      try {
        $state = Invoke-RestMethod -Uri ($hUrl + '/api/state') -TimeoutSec 5
        Write-Host ("hanstlers: OK model=" + $state.model + " (" + $hUrl + ")")
        try {
          $vst = Invoke-RestMethod -Uri ($hUrl + '/api/vertex/status') -TimeoutSec 5
          if ($vst.configured) {
            Write-Host ("vertex: OK auth=" + $vst.authMode + " modelo=" + $vst.models.pro)
          } else {
            Write-Host "vertex: FAIL sin API key ni projectId (revisa ~/.hanstlers/vertex.json)"
          }
          $mw = Invoke-RestMethod -Uri ($hUrl + '/api/vertex/models/status') -TimeoutSec 5
          if ($mw.pendiente) {
            Write-Host ("modelo: hay uno mejor disponible -> " + $mw.pendiente.a + " (" + $mw.pendiente.mejoraPct + "% mas rapido)")
          }
        } catch {}
      } catch {
        $exeDoc = Find-HanstlersExe
        $puertoReal = Find-HanstlersPort
        if ($puertoReal -and ($hUrl -notmatch (':' + $puertoReal + '\b'))) {
          Write-Host ("hanstlers: FAIL escucha en http://127.0.0.1:" + $puertoReal + " pero hanstlersUrl=" + $hUrl)
          Write-Host ("  arregla:  ask-cli config set hanstlersUrl http://127.0.0.1:" + $puertoReal)
        } elseif ($exeDoc -and (ConvertTo-BoolValue (Get-Prop $cfg 'autoStartHanstlers') $true)) {
          Write-Host ("hanstlers: cerrado, pero se arrancara solo al primer prompt (" + $exeDoc + ")")
        } elseif ($exeDoc) {
          Write-Host ("hanstlers: FAIL cerrado y autoStartHanstlers=off. Abrelo: " + $exeDoc)
        } else {
          Write-Host ("hanstlers: FAIL no responde en " + $hUrl + " y no encontre HanstlerS.exe instalado")
        }
      }
    } else {
      Write-Host "hanstlers: n/a (backend local opcional; solo lo usa provider=vertex)"
    }
    Write-Host ("timeoutSec: " + $vtimeout + " (aplica al provider vertex)")
    Write-Host ("verify: " + $(if (ConvertTo-BoolValue $cfg.verify $true) { 'ON (gates de ejecucion; exit 3 si falla)' } else { 'OFF' }))
    $docSettings = Resolve-Settings $cfg (Parse-Options @($Args | Select-Object -Skip 1))
    $permArgs = (Build-PermissionArgs $docSettings) -join ' '
    Write-Host ("permisos: modo=" + $docSettings.mode + " -> " + $permArgs)
    $agentArgs = (Build-AgentArgs $docSettings) -join ' '
    Write-Host ("agente: modo=" + $docSettings.agentMode + $(if ($agentArgs) { " -> " + $agentArgs } else { " (sin flags agenticos)" }))
    if ($docSettings.effort -and (-not $docSettings.model -or $docSettings.model -eq 'auto')) {
      Write-Host ("effort: WARN el modelo 'auto' no admite --effort; se degradara en ejecucion (fija --model para usarlo)")
    }
    $qDir = if ($docSettings.dir) { $docSettings.dir } else { (Get-Location).Path }
    $qc = Get-QualityCommand $qDir ([string]$docSettings.verifyCommand)
    if (-not (ConvertTo-BoolValue $docSettings.qualityGate $false)) {
      Write-Host ("calidad: OFF (activalo con --quality o --dev)" + $(if ($qc) { "; suite detectada: " + $qc.cmd } else { '' }))
    } elseif ($qc) {
      Write-Host ("calidad: ON stack=" + $qc.name + " -> " + $qc.cmd)
    } else {
      Write-Host "calidad: ON pero WARN sin suite detectada (define verifyCommand o --verify-cmd)"
    }
    Write-Host ("retry: " + $(if (ConvertTo-BoolValue $cfg.retry $true) { 'ON (reintento sobre la misma sesion)' } else { 'OFF' }))
    Write-Host ("anti-bucle: " + (ConvertTo-IntValue (Get-Prop $cfg 'loopThreshold') 3) + " llamadas identicas consecutivas")
    $gm = if ($cfg.guard) { [string]$cfg.guard } else { 'auto' }
    $gdir = (Get-Location).Path
    if (Test-HasPersistentGuard $gdir) {
      Write-Host ("guard: $gm - OK (persistente en " + (Get-AgentsFilePath $gdir) + "; 0 tokens extra por llamada)")
    } else {
      Write-Host ("guard: $gm - WARN (se antepone en cada prompt; usa 'ask-cli init-instructions' para cachearlo)")
    }
    Write-Host ("config: " + $ConfigPath)
    Write-Host ("history: " + $HistoryPath)
    if (Test-Path $HistoryPath) {
      $hi = Get-Item $HistoryPath
      Write-Host ("history size: " + [math]::Round($hi.Length / 1KB, 1) + " KB (rotacion a " + (ConvertTo-IntValue $cfg.historyMax 2000) + " lineas sobre 2 MB)")
    }
    # Portabilidad: que hace falta para que esto funcione en OTRA maquina.
    $binDir = Join-Path $AskHome 'bin'
    $inPath = ($env:PATH -split ';') -contains $binDir
    if ($inPath) {
      Write-Host ("instalacion: OK en PATH (" + $binDir + ")")
    } else {
      Write-Host ("instalacion: no instalado (ejecutas por ruta). Usa 'ask-cli install' para invocarlo como 'ask-cli' desde cualquier carpeta")
    }
    exit 0
  }
  'project' {
    if ($Args.Count -lt 2) { Write-Host "Uso: ask-cli project init|show|strict ..."; exit 1 }
    $sub = [string]$Args[1]
    if ($sub -eq 'show') {
      $target = if ($Args.Count -ge 3) { [string]$Args[2] } else { (Get-Location).Path }
      $rec = Get-ActiveProfileRecord $cfg $target
      if ($null -eq $rec) { Write-Host ("Sin perfil para: " + (Resolve-FullPath $target)); exit 1 }
      $rec.profile | ConvertTo-Json -Depth 8
      exit 0
    }
    if ($sub -eq 'strict') {
      if ($Args.Count -lt 3) { Write-Host "Uso: ask-cli project strict on|off [ruta]"; exit 1 }
      $flag = [string]$Args[2]
      $target = if ($Args.Count -ge 4) { [string]$Args[3] } else { (Get-Location).Path }
      $rec = Get-ActiveProfileRecord $cfg $target
      if ($null -eq $rec) { Write-Host ("Sin perfil para: " + (Resolve-FullPath $target)); exit 1 }
      $full = [string]$rec.key
      $profiles = Load-Profiles
      if ($flag -in @('on','true','1')) { $profiles[$full].strict = $true }
      elseif ($flag -in @('off','false','0')) { $profiles[$full].strict = $false }
      else { Write-Host "Valor inválido. Usa on|off."; exit 1 }
      Save-Profiles $profiles
      Write-Host ("Perfil actualizado: strict=" + [string]$profiles[$full].strict)
      exit 0
    }
    if ($sub -ne 'init') { Write-Host "Uso: ask-cli project init [ruta] [--provider ...] [--model ...]"; exit 1 }
    $rest = @()
    if ($Args.Count -gt 2) { $rest = @($Args[2..($Args.Count-1)]) }
    $opts = Parse-Options $rest
    $settings = Resolve-Settings $cfg $opts
    $target = if ($opts.prompt.Count -gt 0) { [string]$opts.prompt[0] } elseif ($opts.dir) { $opts.dir } else { (Get-Location).Path }
    $full = [System.IO.Path]::GetFullPath($target)
    $strictValue = $true
    if ($opts.strictProfile -eq 'relaxed') { $strictValue = $false }
    $profiles = Load-Profiles
    $profiles[$full] = @{
      dir = $full
      provider = $settings.provider
      model = $settings.model
      vertexModel = $settings.vertexModel
      mode = $settings.mode
      allowTools = $settings.allowTools
      strict = $strictValue
      updatedAt = (Get-Date).ToString('s')
    }
    Save-Profiles $profiles
    $cfg.dir = $full
    Save-Config $cfg
    Write-Host ("Perfil creado: " + $full + " (strict=" + [string]$strictValue + ")")
    exit 0
  }
  'config' {
    if ($Args.Count -lt 2 -or $Args[1] -eq 'show') {
      $cfg | ConvertTo-Json -Depth 4
      exit 0
    }
    if ($Args.Count -ge 4 -and $Args[1] -eq 'set') {
      $k = [string]$Args[2]
      $v = [string]$Args[3]
      if (-not ($cfg.ContainsKey($k))) { Write-Host ("Clave inválida: " + $k); exit 1 }
      if ($k -in @('timeoutSec','historyMax','startTimeoutSec','loopThreshold','maxCredits','maxContinues')) { $cfg[$k] = ConvertTo-IntValue $v (ConvertTo-IntValue $cfg[$k] 0) }
      elseif ($k -in @('retry','verify','autoStartHanstlers','assistedApproval','noAskUser','qualityGate')) { $cfg[$k] = ConvertTo-BoolValue $v $true }
      else { $cfg[$k] = $v }
      Save-Config $cfg
      Write-Host ("OK " + $k + "=" + [string]$cfg[$k])
      exit 0
    }
    Write-Host "Uso: ask-cli config show | ask-cli config set <key> <value>"
    exit 1
  }
  default {
    Show-Help
    exit 1
  }
}
