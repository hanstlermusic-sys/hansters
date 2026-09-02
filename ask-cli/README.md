# ask-cli

Version actual: **0.9.0**

CLI en PowerShell que habla con el servidor local de HanstlerS
(`http://127.0.0.1:8717` por defecto) para ejecutar tareas de agente,
sesiones, perfiles de proyecto, etc.

## Novedades 0.9.0

- **La ruta `vertex` ya no muere si HanstlerS esta cerrado**: ask-cli detecta que
  el backend no responde, abre la app y espera a que este lista antes de gastar
  el prompt. Se controla con `autoStartHanstlers` (por defecto `true`) y
  `startTimeoutSec` (por defecto `60`).
- **Diagnostico del error mas comun**: si HanstlerS ya esta abierto pero
  `hanstlersUrl` apunta a otro puerto, ask-cli descubre el puerto real y te da
  el comando exacto para corregirlo, en vez de esperar el timeout completo
  (de ~64 s a ~3 s).
- `ask-cli doctor` comprueba la ruta Vertex de punta a punta: estado del
  backend, si la API key esta configurada, el modelo en uso y si el vigia de
  modelos propone uno mejor.
- `config set` castea bien los booleanos y enteros nuevos: antes claves como
  `autoStartHanstlers` se guardaban como texto (`"false"` es truthy y el flag
  no se apagaba nunca).
- En modo `vertex` los flags desconocidos ya no se tragan en silencio: se avisa
  de cuales se ignoran, para cazar erratas como `--modell`.
- El envelope JSON es coherente: si la corrida falla (`code != 0`) sale
  `verified: false` con el motivo en `issues`, en vez de `ok:false` + `verified:true`.
- Errores de red contra HanstlerS con mensaje accionable (distingue HTTP N de
  conexion cortada a media respuesta).

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
