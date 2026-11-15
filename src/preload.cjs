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
  addShelf: paths => ipcRenderer.invoke('shelf-add', paths),
  removeShelf: id => ipcRenderer.invoke('shelf-remove', id),
  openShelf: id => ipcRenderer.invoke('shelf-open', id),
  dragShelf: id => ipcRenderer.send('shelf-drag', id),
  dockDrag: action => ipcRenderer.invoke('dock-drag', action),
  edgePanel: mode => ipcRenderer.invoke('edge-panel', mode),
  minimizeToTray: () => ipcRenderer.invoke('minimize-to-tray'),
  hide: () => ipcRenderer.invoke('hide'),
  backup: action => ipcRenderer.invoke('backup', action),
  updates: () => ipcRenderer.invoke('updates'),
  on: (event, callback) => {
    if (['state', 'search-focus', 'edge-open', 'edge-autofold', 'dock-landed', 'tray-motion', 'update-status', 'shelf-changed', 'shelf-error'].includes(event)) {
      ipcRenderer.on(event, (_event, value) => callback(value));
    }
  }
});
