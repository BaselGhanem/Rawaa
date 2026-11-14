const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('rawaa', {
  load: () => ipcRenderer.invoke('load'),
  save: state => ipcRenderer.invoke('save', state),
  openApps: () => ipcRenderer.invoke('open-apps'),
  choose: kind => ipcRenderer.invoke('choose', kind),
  paths: paths => ipcRenderer.invoke('paths', paths),
  filePath: file => webUtils.getPathForFile(file),
  launch: id => ipcRenderer.invoke('launch', id),
  icon: id => ipcRenderer.invoke('icon', id),
  geometry: value => ipcRenderer.invoke('geometry', value),
  showSearch: () => ipcRenderer.invoke('show-search'),
  minimizeToTray: () => ipcRenderer.invoke('minimize-to-tray'),
  hide: () => ipcRenderer.invoke('hide'),
  backup: action => ipcRenderer.invoke('backup', action),
  updates: () => ipcRenderer.invoke('updates'),
  on: (event, callback) => {
    if (['state', 'search-focus', 'update-status'].includes(event)) {
      ipcRenderer.on(event, (_event, value) => callback(value));
    }
  }
});
