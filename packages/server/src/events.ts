import type { ServerEvent } from '@aigc/shared';

type Listener = (e: ServerEvent) => void;

/** 事件总线：任务进度、产出、钱包变化都从这里推给前端（SSE） */
export class EventHub {
  private listeners = new Set<Listener>();

  on(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(e: ServerEvent) {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* 某个连接断了不影响别人 */
      }
    }
  }

  notice(level: 'info' | 'success' | 'warn' | 'ai', title: string, desc?: string) {
    this.emit({ type: 'notice', level, title, desc });
  }
}
