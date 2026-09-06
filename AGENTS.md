# AGENTS.md — Guía para asistentes / agentes

Este archivo le dice a los agentes de código (IA) cómo trabajar en este
repositorio. Léelo completo antes de tocar nada.

## Qué es HanstlerS

Asistente de escritorio (Electron + Node) con servidor local (`server.js`),
interfaz en `public/`, actualizador propio (`updater.js`) y utilidades en
`tools/`. Se instala en `%LOCALAPPDATA%\Programs\HanstlerS`.

## Repositorio oficial

- El repo oficial es **`hanstlermusic-sys/hansters`**, y es el `origin`: todo
  commit y push va ahí (`git push origin main`).
- El remoto `microsoft` (`cezumbad_microsoft/hansters`) queda solo como
  respaldo histórico. Es una cuenta EMU: no acepta empujar desde la cuenta
  personal y tiene los runners de Actions deshabilitados por política.
- Los commits se firman como `Hanstler <hanstlermusic@gmail.com>`. No usar
  otras identidades: GitHub vincula el commit al perfil por el email, y otro
  correo aparece como un autor suelto sin enlace.

La identidad y el destino están fijados en la configuración local del repo
(`user.name`, `user.email`, `remote.origin.url` y un `credential.helper` que
pide el token de `hanstlermusic-sys`). Si `git push` pide credenciales o
falla con 403, revisa esa configuración antes de inventar rutas alternas.

## Copias locales

Existen varias copias de trabajo del mismo repo en esta máquina
(`~\hansters`, `~\Documents\HanstlerS`, `~\Documents\HansterS`). Tras
publicar un cambio, actualiza las demás con `git pull origin main` para que
no queden atrasadas y parezca que el cambio "no se aplicó".

## Reglas de seguridad

- No commitear secretos, tokens ni claves. Los archivos de configuración con
  credenciales viven fuera del repo (`~\.hanstlers\`).
- No commitear repos anidados ni carpetas de otros proyectos.
- No romper lo que ya funciona: cambios quirúrgicos y verificados.
