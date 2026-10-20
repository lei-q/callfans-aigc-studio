import type { Result } from '@aigc/shared';
import { EDIT_FILTERS, type ImageEditOps } from '@aigc/shared';

/** 复制到剪贴板：Clipboard API 不可用时回退到 textarea */
export function copyText(text: string) {
  if (!text) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      void navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 继续回退 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function downloadUrl(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function downloadText(name: string, text: string, type = 'text/markdown;charset=utf-8') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

export const resultDownloadUrl = (r: Result) => `/api/download?src=${encodeURIComponent(r.src)}&name=${encodeURIComponent(r.title)}`;

/** 结果的缩略图：生成文件本身就是图时用原件 */
export const thumbOf = (r: Pick<Result, 'thumb' | 'src' | 'type'>) => r.thumb || (r.type === 'image' ? r.src : '');

export function pickFiles(accept: string, multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.multiple = multiple;
    inp.addEventListener('change', () => resolve([...(inp.files || [])]));
    inp.click();
  });
}

export function readText(file: File) {
  return new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

export function editCss(ops: ImageEditOps) {
  const f = EDIT_FILTERS.find((x) => x.k === ops.filter);
  const parts = [`brightness(${100 + ops.brightness}%)`, `contrast(${100 + ops.contrast}%)`, `saturate(${100 + ops.saturate}%)`];
  if (f && f.css) parts.push(f.css);
  return parts.join(' ');
}

export function editTransform(ops: ImageEditOps) {
  const tf: string[] = [];
  if (ops.flipH) tf.push('scaleX(-1)');
  if (ops.flipV) tf.push('scaleY(-1)');
  return tf.join(' ');
}

/** 结果卡片上沿用编辑参数的 CSS（旧数据只存了 css 字符串） */
export function cssOfEdit(css?: string): React.CSSProperties | undefined {
  if (!css) return undefined;
  const out: Record<string, string> = {};
  for (const part of css.split(';')) {
    const i = part.indexOf(':');
    if (i > 0) out[part.slice(0, i).trim().replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] = part.slice(i + 1).trim();
  }
  return out as React.CSSProperties;
}

/** 把图片按编辑参数真实渲染成一张新图（canvas），用于「保存为新产出」 */
export async function renderEditedImage(src: string, ops: ImageEditOps, srcRatio: string): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('图片加载失败'));
    im.src = src;
  });
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const ratio = ops.crop === '原图' ? srcRatio : ops.crop;
  const [rw, rh] = (ratio || `${iw}:${ih}`).split(':').map(Number);
  const target = rw && rh ? rw / rh : iw / ih;
  let sw = iw;
  let sh = ih;
  if (iw / ih > target) sw = Math.round(ih * target);
  else sh = Math.round(iw / target);
  const sx = Math.round((iw - sw) / 2);
  const sy = Math.round((ih - sh) / 2);
  const cv = document.createElement('canvas');
  cv.width = sw;
  cv.height = sh;
  const ctx = cv.getContext('2d')!;
  ctx.filter = editCss(ops);
  ctx.translate(ops.flipH ? sw : 0, ops.flipV ? sh : 0);
  ctx.scale(ops.flipH ? -1 : 1, ops.flipV ? -1 : 1);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  return cv.toDataURL('image/png');
}

export const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};
