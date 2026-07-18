'use strict';
const { app, BrowserWindow, session } = require('electron');
const path = require('path');

// Arranca el servidor interno de HanstlerS (el mismo server.js) dentro de Electron.
process.env.HANSTLERS_PORT = process.env.HANSTLERS_PORT || '8717';
process.env.HANSTLERS_ELECTRON = '1';
require(path.join(__dirname, 'server.js'));

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 760,
    minHeight: 540,
    backgroundColor: '#0a0a12',
    title: 'HanstlerS',
    icon: path.join(__dirname, 'hanstlers.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Conceder permiso de micrófono automáticamente (para dictado por voz).
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(permission === 'media' || permission === 'microphone' ? true : true);
  });

  const load = () => mainWindow.loadURL('http://127.0.0.1:' + process.env.HANSTLERS_PORT);
  // Reintentar hasta que el servidor interno esté listo.
  let tries = 0;
  const tryLoad = () => {
    load().catch(() => { if (tries++ < 30) setTimeout(tryLoad, 200); });
  };
  setTimeout(tryLoad, 300);
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
