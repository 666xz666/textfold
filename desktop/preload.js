// What the page may ask of the app: open a page in the system browser (where the reader is already signed in to
// OpenRouter, ChatGPT and the rest), save a file where the reader chooses, and know that it runs inside the app.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  openExternal: (url) => ipcRenderer.invoke('open-external', String(url)),
  saveFile: (name, data) => ipcRenderer.invoke('save-file', String(name), String(data)),
  version: process.env.npm_package_version || '',
});
