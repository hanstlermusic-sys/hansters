# ask-cli

CLI en PowerShell que habla con el servidor local de HanstlerS
(`http://127.0.0.1:8717` por defecto) para ejecutar tareas de agente,
sesiones, perfiles de proyecto, etc.

## Instalar / actualizar en una PC

Desde la raiz del repo (`hansters`), tras `git pull`:

```powershell
.\ask-cli\install.ps1
```

Esto copia `ask-cli.ps1` y `ask-cli.cmd` a `%USERPROFILE%\.ask-cli\bin\`
(crea la carpeta si no existe) sin tocar tu `config.json` ni `history.jsonl`
locales.

## Version actual

Ver con:

```powershell
ask-cli version
```

## Notas

- El modelo Vertex por defecto (`vertex-gemini-pro`) usa `gemini-3.7-flash`,
  configurado en `C:\Users\<usuario>\.hanstlers\vertex.json` (no se versiona:
  cada PC guarda ahi su propia API key). Ver `../README.md` para el formato.
- `ask-cli.ps1` no hardcodea modelos: delega la resolucion al servidor
  HanstlerS (`server.js`), asi que actualizar el modelo solo requiere
  editar `vertex.json` en cada maquina.
