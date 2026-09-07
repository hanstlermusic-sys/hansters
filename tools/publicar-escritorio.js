#!/usr/bin/env node
// Deja el instalador recien compilado en el Escritorio y borra los builds
// viejos de dist-electron.
//
// El updater sigue leyendo dist-electron (por eso no se cambia la salida de
// electron-builder), pero ahi se acumulaban decenas de .exe de 78 MB. Se
// conserva solo el de la version actual; las anteriores estan en git.
const fs = require('fs');
const path = require('path');
const os = require('os');

const raiz = path.join(__dirname, '..');
const version = require(path.join(raiz, 'package.json')).version;
const nombre = `HanstlerS Setup ${version}.exe`;
const dir = path.join(raiz, 'dist-electron');
const origen = path.join(dir, nombre);

if (!fs.existsSync(origen)) {
  console.error(`No se encontro ${nombre} en dist-electron.`);
  process.exit(1);
}

const escritorio = path.join(os.homedir(), 'Desktop');
const destino = path.join(escritorio, nombre);
fs.copyFileSync(origen, destino);
console.log(`Instalador: ${destino}`);

// en el Escritorio y en dist-electron solo se queda la version actual
for (const [carpeta, conservar] of [[escritorio, destino], [dir, origen]]) {
  for (const f of fs.readdirSync(carpeta)) {
    if (!/^HanstlerS Setup .+\.exe$/.test(f)) continue;
    const ruta = path.join(carpeta, f);
    if (ruta === conservar) continue;
    try {
      fs.unlinkSync(ruta);
      console.log(`  borrado ${ruta}`);
    } catch (e) {
      console.warn(`  no se pudo borrar ${ruta}: ${e.message}`);
    }
  }
}
