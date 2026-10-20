import { setState, type Toast } from './index';

let seq = 1;

export function toast(type: Toast['type'], title: string, desc = '') {
  const id = seq++;
  setState((s) => {
    s.toasts.push({ id, type, title, desc });
    if (s.toasts.length > 6) s.toasts.splice(0, s.toasts.length - 6);
  });
  setTimeout(() => {
    setState((s) => {
      const t = s.toasts.find((x) => x.id === id);
      if (t) t.out = true;
    });
    setTimeout(() => setState((s) => void (s.toasts = s.toasts.filter((x) => x.id !== id))), 220);
  }, 4200);
}

/** API 报错统一转成 toast */
export function toastError(e: unknown, fallback = '操作失败') {
  const err = e as { message?: string; detail?: string };
  toast('warn', err?.message || fallback, err?.detail || '');
}
