const { contextBridge, ipcRenderer, webUtils } = require('electron');

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('promptStudioWindow', {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    setAlwaysOnTop: (flag) => ipcRenderer.invoke('window:set-always-on-top', flag),
  });

  contextBridge.exposeInMainWorld('electronAPI', {
    // ── Clipboard write ───────────────────────────────────────────────────
    copyImage : (uploadPath)  => ipcRenderer.invoke('clipboard:copy-image',  uploadPath),
    copyText  : (text)        => ipcRenderer.invoke('clipboard:copy-text',   text),
    copyFiles : (uploadPaths) => ipcRenderer.invoke('clipboard:copy-files',  uploadPaths),
    pickFolder : (options)     => ipcRenderer.invoke('dialog:pick-folder', options),
    // ── Native file drag-out (TODO2) ──────────────────────────────────────
    startFileDrag: (uploadPathOrPaths) =>
      ipcRenderer.sendSync('drag:start', uploadPathOrPaths),
    startLocalFileDrag: (absPathOrPaths) => ipcRenderer.send('drag:start-local', absPathOrPaths),
    // ── Open URL in system default browser ──────────────────────
    openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
    getPathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return '';
      }
    },
    // ── Audio folder scan ────────────────────────────────────────
    scanAudioFolder: (folderPath) => ipcRenderer.invoke('folder:scan-audio', folderPath),
  });
} else {
  contextBridge.exposeInMainWorld('assetBrowserDesktop', {
    startLocalFileDrag: (absPathOrPaths) => ipcRenderer.send('drag:start-local', absPathOrPaths),
  });
}
