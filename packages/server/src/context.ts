import { cvsItemH, cvsItemW } from '@aigc/shared';
import type { CanvasItem } from '@aigc/shared';
import type { Core } from './core';
import { HttpError } from './runner';

/* ============================================================================
   画布上下文：把一块画板整理成外部 Agent / MCP 能读懂的 JSON。
   只导出真实存在的信息（元素、提示词、模型、连线、坐标），不编造；
   src 是本机地址，外部要能访问本机服务，或由调用方先导出文件。
   ========================================================================== */

export interface CanvasContext {
  project: string;
  name: string;
  generatedAt: number;
  summary: string;
  items: {
    id: string;
    kind: CanvasItem['kind'];
    type: CanvasItem['type'] | null;
    title: string;
    src: string | null;
    url: string | null;
    prompt: string | null;
    model: string | null;
    ratio: string | null;
    dur: number | null;
    text: string;
    x: number;
    y: number;
    w: number;
    h: number;
  }[];
  links: { from: string; to: string; label: string }[];
  note: string;
}

export function buildCanvasContext(core: Core, ws: string, base: string): CanvasContext {
  const project = core.store.projects.get(ws);
  if (!project) throw new HttpError(404, '项目不存在');
  const board = core.store.boards.get(ws);
  const items = board?.items || [];
  const links = board?.links || [];
  const abs = (src?: string) => (!src ? null : src.startsWith('/') ? `${base}${src}` : src);
  const out: CanvasContext['items'] = items.map((it) => {
    const r = it.rid ? core.store.results.get(it.rid) : undefined;
    const job = r?.job ? core.store.jobs.get(r.job) : undefined;
    return {
      id: it.id,
      kind: it.kind,
      type: it.kind === 'media' ? it.type || 'image' : null,
      title: it.t || r?.title || '',
      src: it.kind === 'media' || it.kind === 'file' ? abs(it.src) : null,
      url: it.url || null,
      prompt: job?.prompt || null,
      model: job?.model || null,
      ratio: r?.ratio || null,
      dur: it.dur ?? r?.dur ?? null,
      text: it.kind === 'node' || it.kind === 'text' ? it.text || '' : '',
      x: Math.round(it.x),
      y: Math.round(it.y),
      w: cvsItemW(it),
      h: cvsItemH(it),
    };
  });
  const media = out.filter((i) => i.kind === 'media').length;
  const groups = out.filter((i) => i.kind === 'group').length;
  return {
    project: ws,
    name: project.name,
    generatedAt: Date.now(),
    summary: `${project.name}：${out.length} 个元素（${media} 个素材、${groups} 个分组），${links.length} 条连线`,
    items: out,
    links: links.map((l) => ({ from: l.from, to: l.to, label: l.label || '' })),
    note: '坐标用于理解相对位置；src 是本机地址，外部 Agent 需要能访问本机服务，或由调用方先导出文件。',
  };
}
