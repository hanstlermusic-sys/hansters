# HanstlerS

Tu asistente personal basado en GitHub Copilot CLI: chat con voz, selector de carpeta y agente hanstler-dev.

Descarga el instalador todo-en-uno en Releases (instala Node + Copilot CLI + la app).

## Vertex / Gemini rapido (con auth key)

Ahora HanstlerS acepta configuracion por **API key** (sin depender de `gcloud auth`).

1. Crea este archivo:
   `C:\Users\cezumbad\.hanstlers\vertex.json`
2. Pega:

```json
{
  "apiKey": "TU_GOOGLE_API_KEY",
  "region": "us-central1",
  "modelPro": "gemini-3.7-flash",
  "modelFlash": "gemini-3.5-flash"
}
```

> El archivo debe guardarse **en UTF-8 sin BOM**. Un BOM invisible al principio
> hacia que la configuracion no se pudiera leer y Vertex quedara "sin configurar"
> en silencio, desviando la conversacion a otro modelo. Ya se tolera al leer.

> Los modelos `gemini-2.5-*` estan retirados (`404: no longer available to new
> users`). Si tu `vertex.json` todavia los nombra, actualizalo.

Con eso, los modelos `vertex-auto`, `vertex-gemini-pro` y `vertex-gemini-flash` quedan operativos.
`vertex-claude-opus-5` sigue requiriendo GCP + ADC (`gcloud auth application-default login`).

## Router automatico de modelos

En `Automatico`, HanstlerS enruta por tipo de tarea:

- Preguntas generales: `gemini-3.5-flash` (respaldo `gpt-5.4-mini`).
- Desarrollo de codigo: `gpt-5.3-codex` (respaldo `claude-opus-5`).
- Tareas bloqueadas o nuevo desarrollo desde cero: `claude-opus-5`.

Si detecta tarea operativa web/portal y hay Azure BYOK configurado, mantiene
la ruta `azure-agent` para ejecutar acciones en servidor local.

## Mock API local

Servidor aparte que inventa respuestas JSON para desarrollar frontend o
backend sin depender de APIs externas (PayPal, R2, licencias...). Vive en su
propio puerto: si falla, el chat no se entera.

Se activa con la bandera `mockApi` (apagada por defecto). Lo más cómodo es
**pedírselo al asistente en lenguaje natural**, sin acordarse de puertos ni de
`curl`:

> dame un mock de la API de pagos de PayPal en la ruta `/api/paypal/order`

El agente enciende el servidor, deja la bandera activada para la próxima vez y
responde con la URL lista para pegar en el código. También entiende «apaga el
mock», «qué mocks tengo» o «que `/api/license/check` devuelva expirado».

A mano, si se prefiere:

```powershell
curl.exe -s -X POST http://127.0.0.1:8717/api/mock/start
curl.exe -s http://127.0.0.1:8717/api/mock/status
```

Luego cualquier ruta contra `http://127.0.0.1:8718` devuelve un JSON creíble,
generado con Gemini Flash y **cacheado en disco** (`~\.hanstlers\mocks`), de
modo que la segunda llamada es instantánea y no gasta cuota:

```powershell
curl.exe -s http://127.0.0.1:8718/api/paypal/order
```

Parámetros de control para forzar los casos difíciles de reproducir de verdad:

- `?__scenario=rechazado` — cambia la respuesta y usa su propia caché.
- `?__status=500` — fuerza el código HTTP y devuelve una forma de error.

La paginación normal (`?page=2`) **no** parte la caché: la forma es la misma.

Rutas de control del propio mock:

- `GET /__mock/health` — estado y número de respuestas cacheadas.
- `GET /__mock/list` — qué hay cacheado.
- `POST /__mock/clear` — vacía la caché.
- `POST /__mock/seed` — fija una respuesta a mano con
  `{ path, data, method?, scenario?, status? }`.

Si Vertex no está configurado o se cae, el mock **sigue respondiendo** con un
respaldo local deducido del nombre del recurso (plural → lista, singular →
objeto). Ese respaldo no se cachea cuando hay IA disponible, para que la
siguiente llamada vuelva a intentarlo.

El puerto se cambia con `HANSTLERS_MOCK_PORT`.

## Mirroring a Enterprise (EMU compatible)

Para trabajar con una cuenta EMU (`cezumbad_microsoft`) sin perder el repo fuente
personal, este repo incluye el workflow:

- `.github/workflows/mirror-enterprise.yml`

Este flujo empuja `branches` y `tags` al remoto enterprise usando una conexion
llamada `mirroring`.

1. Crea el repo destino en un namespace compatible con tu usuario EMU
   (ejemplo activo: `cezumbad_microsoft/hansters`).
2. Agrega el secret `MIRROR_SSH_PRIVATE_KEY` en este repo fuente (llave privada
   SSH con permiso de escritura en el repo mirror).
3. Verifica la conexion local:

```powershell
git remote add mirroring https://github.com/cezumbad_microsoft/hansters.git
git remote -v
```

Cuando hagas push a `main`, el workflow sincroniza automaticamente al mirror.

### Vertex con herramientas (modo agente)

Gemini ya no solo conversa: **ejecuta**. Cuando la peticion es una tarea de
ejecucion (crear o correr codigo, tocar archivos, abrir una web), la ruta Vertex
usa el mismo bucle de agente que Azure y hereda sus mismas protecciones:
confirmacion de comandos peligrosos, post-check, rollback automatico y transcript
por conversacion.

- Antes, esas peticiones se desviaban al agente de Azure y respondia otro modelo.
  Ahora se quedan en Vertex (`reason: explicit-vertex-agent-tools`).
- Se controla con la opcion `vertexAgentTools` (activada por defecto). Si se
  desactiva, se vuelve al comportamiento anterior.
- Cuando Vertex falla y se usa el respaldo, ahora se explica **por que** en el
  chat, en vez de solo cambiar la insignia del modelo.


### Vertex se comporta igual que el agente de Azure

Antes un heuristico de texto decidia si Vertex usaba herramientas o solo
conversaba, asi que peticiones como "abre el repo X" caian en chat plano y el
modelo se limitaba a describir el plan. Ahora **toda** peticion a un modelo
Gemini de Vertex entra al bucle de agente (mismas herramientas, mismo gating,
mismo post-check y rollback). `vertex-claude-opus-5` sigue en chat plano.

## Abrir un repo con clonado automatico

El panel de repos ya no solo pone una etiqueta `GitHub - owner/repo`: al elegir
un repo se **clona en disco** (o se hace `git pull` si ya estaba) y la carpeta de
trabajo pasa a apuntar ahi, que es lo que el agente necesita para leer y editar.

Tambien puedes pedirlo hablando, sin tocar la UI:

- "abre el repo hanstlermusic-sys/hansters"
- "trabaja en hansters y arregla el boton de voz"
- "clona https://github.com/owner/repo y corre los tests"

El agente llama a la herramienta `open_repo`, que acepta `owner/repo`, la URL de
GitHub, la URL ssh, o solo el nombre (lo resuelve con la GitHub CLI contra tu
cuenta). Los clones nuevos van a `~\Documents\HanstlerS\<repo>`; si ya existe una
copia en `~\Documents\HanstlerS`, `~\Documents` o `~`, se reutiliza en vez de
clonar de nuevo. Los comandos corren sin prompts interactivos
(`GIT_TERMINAL_PROMPT=0`), asi que un repo sin acceso falla con un mensaje claro
en lugar de colgarse esperando credenciales. Para repos privados se reintenta con
`gh repo clone`, que usa tu sesion de la GitHub CLI.
