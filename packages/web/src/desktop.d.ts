import type { UpdateState } from '@aigc/shared';

/* 桌面端 preload 暴露的少量能力；Web 模式（浏览器）下没有这个对象 */
declare global {
  interface Window {
    aigcDesktop?: {
      relaunch(): void;
      openPath(p: string): void;
      openExternal(url: string): void;
      mode: 'desktop' | 'web';
      update?: {
        getState(): Promise<UpdateState | null>;
        check(): Promise<UpdateState | null>;
        download(): Promise<UpdateState | null>;
        dismiss(): void;
        onState(cb: (s: UpdateState) => void): void;
        offState(): void;
      };
    };
  }
}

export {};
