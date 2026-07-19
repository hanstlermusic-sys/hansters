'use strict';
const { app, BrowserWindow, session } = require('electron');
const path = require('path');

// CANDADO DE INSTANCIA ÚNICA: si HanstlerS ya está abierto, enfoca esa ventana
// en vez de abrir otra (evita que se abran dos ventanas a la vez).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {

// Arranca el servidor interno de HanstlerS (el mismo server.js) dentro de Electron.
process.env.HANSTLERS_PORT = process.env.HANSTLERS_PORT || '8717';
process.env.HANSTLERS_ELECTRON = '1';
require(path.join(__dirname, 'server.js'));

let mainWindow = null;

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

function createWindow() {
  if (mainWindow) { mainWindow.focus(); return; }
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

  mainWindow.on('closed', () => { mainWindow = null; });

  // Conceder permiso de micrófono automáticamente (para dictado por voz).
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(true);
  });

  const load = () => mainWindow.loadURL('http://127.0.0.1:' + process.env.HANSTLERS_PORT);
  let tries = 0;
  const tryLoad = () => {
    load().catch(() => { if (tries++ < 30 && mainWindow) setTimeout(tryLoad, 200); });
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

}
