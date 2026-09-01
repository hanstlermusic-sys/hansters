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
  "modelPro": "gemini-2.5-pro",
  "modelFlash": "gemini-2.5-flash"
}
```

Con eso, los modelos `vertex-auto`, `vertex-gemini-pro` y `vertex-gemini-flash` quedan operativos.
`vertex-claude-opus-5` sigue requiriendo GCP + ADC (`gcloud auth application-default login`).
