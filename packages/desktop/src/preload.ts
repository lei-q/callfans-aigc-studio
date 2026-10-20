import { contextBridge, ipcRenderer } from 'electron';

/* 只暴露少量明确的能力，页面拿不到 Node 与 Electron 本体 */
contextBridge.exposeInMainWorld('aigcDesktop', {
  mode: 'desktop',
  relaunch: () => ipcRenderer.send('app:relaunch'),
  openPath: (p: string) => ipcRenderer.send('app:open-path', p),
  openExternal: (url: string) => ipcRenderer.send('app:open-external', url),
  chooseMode: (mode: 'desktop' | 'web') => ipcRenderer.send('choose-mode', mode),
});
