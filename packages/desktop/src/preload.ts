import { contextBridge, ipcRenderer } from 'electron';
import type { UpdateState } from '@aigc/shared';

/* 只暴露少量明确的能力，页面拿不到 Node 与 Electron 本体 */
contextBridge.exposeInMainWorld('aigcDesktop', {
  mode: 'desktop',
  relaunch: () => ipcRenderer.send('app:relaunch'),
  openPath: (p: string) => ipcRenderer.send('app:open-path', p),
  openExternal: (url: string) => ipcRenderer.send('app:open-external', url),
  chooseMode: (mode: 'desktop' | 'web') => ipcRenderer.send('choose-mode', mode),
  update: {
    getState: (): Promise<UpdateState | null> => ipcRenderer.invoke('update:state'),
    check: (): Promise<UpdateState | null> => ipcRenderer.invoke('update:check'),
    download: (): Promise<UpdateState | null> => ipcRenderer.invoke('update:download'),
    dismiss: () => ipcRenderer.send('update:dismiss'),
    onState: (cb: (s: UpdateState) => void) => {
      const handler = (_e: unknown, s: UpdateState) => cb(s);
      ipcRenderer.on('update:state', handler);
    },
    offState: () => ipcRenderer.removeAllListeners('update:state'),
  },
});
