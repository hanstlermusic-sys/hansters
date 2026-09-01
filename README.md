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

