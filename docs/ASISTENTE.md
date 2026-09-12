# Contexto documental del asistente

HanstlerS usa la documentación de la carpeta de trabajo como fuente de verdad
para responder y ejecutar tareas. En el primer turno de una conversación carga,
en este orden:

1. `AGENTS.md`
2. `README.md`
3. `docs/README.md`
4. Los demás archivos Markdown de `docs/`
5. Los README de componentes

El índice siempre incluye todos los documentos encontrados. El contenido se
limita a 120.000 caracteres y a 30.000 por archivo para no desplazar el
historial ni los resultados de herramientas. Cuando un documento no cabe
completo, el contexto le indica al agente que debe abrirlo con `read_file`
antes de trabajar en ese tema.

Se excluyen dependencias, entornos virtuales, salidas de build y carpetas de
control de versiones. El contexto se vuelve a construir cuando cambia la
carpeta de trabajo y se conserva en caché mientras el agente permanece en el
mismo proyecto.

Este mecanismo complementa, no reemplaza, el bucle de herramientas. El
asistente debe ejecutar la tarea con `read_file`, `write_file`, `run_command`,
`open_repo` y las demás herramientas disponibles; la documentación establece
las reglas y la arquitectura que debe respetar.
