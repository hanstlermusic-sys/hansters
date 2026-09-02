# Actualizar HanstlerS en otra PC

Pasos, en orden, en la PC destino.

## 1. Traer el codigo

```powershell
cd $env:USERPROFILE\Documents\HanstlerS
git pull origin main
npm install
```

## 2. Sincronizar ask-cli (v0.7.0)

```powershell
.\ask-cli\install.ps1
ask-cli version     # debe imprimir 0.7.0
ask-cli doctor
```

## 3. Configurar Vertex

Crear/editar `%USERPROFILE%\.hanstlers\vertex.json`. **Debe ser UTF-8 SIN BOM**
(un BOM rompe `JSON.parse` y HanstlerS se desvia a Azure en silencio).

```json
{
  "apiKey": "<tu-api-key>",
  "modelPro": "gemini-3.7-flash",
  "modelFlash": "gemini-3.5-flash",
  "region": "us-central1"
}
```

Escribirlo sin BOM desde PowerShell:

```powershell
$json = '{ "apiKey": "...", "modelPro": "gemini-3.7-flash", "modelFlash": "gemini-3.5-flash", "region": "us-central1" }'
[System.IO.File]::WriteAllText("$env:USERPROFILE\.hanstlers\vertex.json", $json, (New-Object System.Text.UTF8Encoding($false)))
```

Verificar que no tiene BOM:

```powershell
$b = Get-Content "$env:USERPROFILE\.hanstlers\vertex.json" -Encoding Byte -TotalCount 3
($b[0] -eq 239 -and $b[1] -eq 187 -and $b[2] -eq 191)   # debe dar False
```

> No uses modelos `gemini-2.5-*`: estan retirados y devuelven 404.

## 4. Variable de entorno (sin fallback silencioso a Copilot)

```powershell
[Environment]::SetEnvironmentVariable('HANSTLERS_VERTEX_ALLOW_COPILOT_FALLBACK','false','User')
```

## 5. Compilar e instalar la app

```powershell
npm test          # deben pasar 41/41
npm run dist
.\update-local.ps1
```

Si `npm run dist` falla con
`Cannot create symbolic link ... winCodeSign`, es que Windows no permite
symlinks sin permisos. Solucion: pre-poblar la cache.

```powershell
$c = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign"
# tras un intento fallido queda una carpeta numerica ya extraida:
$src = Get-ChildItem $c -Directory | Where-Object { $_.Name -match '^\d+$' } | Select-Object -First 1
Copy-Item $src.FullName "$c\winCodeSign-2.6.0" -Recurse -Force
npm run dist
```

## 6. Verificacion final

```powershell
(Invoke-RestMethod http://127.0.0.1:8717/api/state).features.vertexAgentTools
```

Debe devolver un valor (no vacio). Si no aparece la clave, la app sigue
corriendo un `app.asar` viejo: repite el paso 5.

## Errores HTTP 400 en Vertex: causas conocidas

| Sintoma | Causa | Estado |
|---|---|---|
| 400 al usar herramientas | `functionCall` reconstruido pierde el `thoughtSignature` de Gemini 3.x | Resuelto: se guardan `_geminiParts` crudas |
| 400 tras varias herramientas | numero de `functionResponse` != `functionCall` del turno previo | Resuelto: resultados paralelos en un solo turno `user` |
| Vertex "no responde" y contesta Azure | BOM en `vertex.json` | Resuelto: validar sin BOM |
| 404 de modelo | `gemini-2.5-*` retirado | Resuelto: usar `gemini-3.7-flash` |
| Herramientas ausentes | `app.asar` desactualizado | Resuelto: `update-local.ps1` |
