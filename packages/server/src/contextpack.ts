import type { Core } from './core';
import { HttpError } from './runner';
import { buildCanvasContext } from './context';
import { uniqueNames, zipStream } from './zip';
import type { Result, Snapshot, SnapshotMeta } from '@aigc/shared';
import { uid } from '@aigc/shared';

/* ============================================================================
   项目快照 + 上下文包：保留发散过程，并能打成一个 zip 交给外部 Agent。
   zip 内容：project.json（画布与元素）、provenance.json（每个产出怎么来的）、
   decisions.json（批注、方案轴、放弃的候选）、snapshots/（关键节点画板）、posts/（帖子草稿）。
   ========================================================================== */

const MAX_AUTO = 30;

export const metaOf = (s: Snapshot): SnapshotMeta => {
  const { board, ...rest } = s;
  return { ...rest, items: board.items.length, links: board.links.length };
};

export function takeSnapshot(core: Core, ws: string, name: string, auto: boolean): Snapshot {
  if (!core.store.projects.get(ws)) throw new HttpError(404, '项目不存在');
  const b = core.store.board(ws);
  const snap: Snapshot = { id: uid('s'), ws, name, auto, createdAt: Date.now(), board: { items: b.items, links: b.links, anchor: b.anchor } };
  core.store.snapshots.put(snap);
  if (auto) {
    const autos = core.store.snapshots
      .all()
      .filter((x) => x.ws === ws && x.auto)
      .sort((a, c) => c.createdAt - a.createdAt);
    for (const old of autos.slice(MAX_AUTO)) core.store.snapshots.del(old.id);
  }
  return snap;
}

/** 这个产出是怎么来的：任务、提示词、模型、参数、来源元素 */
function provenance(core: Core, ws: string) {
  const board = core.store.board(ws);
  const onBoard = new Map(board.items.filter((i) => i.rid).map((i) => [i.rid!, i.id]));
  return core.store.results
    .all()
    .filter((r) => r.ws === ws)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((r: Result) => {
      const j = r.job ? core.store.jobs.get(r.job) : undefined;
      return {
        resultId: r.id,
        title: r.title,
        type: r.type,
        home: r.home,
        status: r.status,
        canvasItem: onBoard.get(r.id) || null,
        createdAt: r.createdAt,
        file: r.src,
        edited: !!r.edit,
        editOps: r.edit?.ops,
        job: j
          ? {
              id: j.id,
              name: j.name,
              prompt: j.prompt,
              negative: j.negative || null,
              model: j.model,
              params: { ratio: j.ratio, count: j.count, res: j.res, dur: j.dur, vres: j.vres, cam: j.cam, seed: j.seed },
              refs: (j.refs || []).map((x) => ({ src: x.src, weight: x.w, from: x.from || null })),
              fromCanvasItem: j.fromCvsId || null,
              axis: j.divergeAxis || null,
              platform: j.platform || null,
              batch: j.batch || null,
            }
          : null,
      };
    });
}

/** 决策：批注、方案（发散 / 组图 / 适配 / 改参数的任务名与轴）、放弃的候选 */
function decisions(core: Core, ws: string) {
  const jobs = core.store.jobs.all().filter((j) => j.ws === ws);
  const plans = jobs
    .filter((j) => j.divergeAxis || j.platform || /^(组图|改参数|批注改图|发散|适配)/.test(j.name))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((j) => ({ job: j.id, name: j.name, axis: j.divergeAxis || null, platform: j.platform || null, fromCanvasItem: j.fromCvsId || null, prompt: j.prompt, status: j.status, producedResults: j.results }));
  const abandoned = core.store.results
    .all()
    .filter((r) => r.ws === ws && r.home === 'draft')
    .map((r) => ({ resultId: r.id, title: r.title, note: '生成后没有被拖进画布，沉入了草稿箱' }));
  return { annotations: core.store.annotations()[ws] || {}, plans, abandoned };
}

export function buildContextPack(core: Core, ws: string, base: string) {
  const project = core.store.projects.get(ws);
  if (!project) throw new HttpError(404, '项目不存在');
  const json = (v: unknown) => Buffer.from(JSON.stringify(v, null, 2), 'utf8');
  const snaps = core.store.snapshots.all().filter((s) => s.ws === ws).sort((a, b) => a.createdAt - b.createdAt);
  const snapNames = uniqueNames(snaps.map((s) => `${new Date(s.createdAt).toISOString().replace(/[:.]/g, '-')}-${s.name}.json`));
  const posts = core.store.posts.all().filter((p) => p.ws === ws);
  const postNames = uniqueNames(posts.map((p) => `${p.title || p.id}.json`));
  const entries = [
    { name: 'README.md', data: Buffer.from(`# ${project.name} · 项目上下文包\n\n- project.json：画布元素、连线、坐标（和 MCP 的 get_canvas_context 同一份）\n- provenance.json：每个产出的来历（提示词、模型、参数、参考图、来源元素）\n- decisions.json：批注、方案（发散 / 组图 / 适配 / 改参数）、被放弃的候选\n- snapshots/：关键节点的画板快照\n- posts/：帖子草稿\n\n文件里的 src 是本机地址（${base}），外部工具需要能访问本机服务，或由你先导出文件。\n导出时间：${new Date().toISOString()}\n`, 'utf8') },
    { name: 'project.json', data: json(buildCanvasContext(core, ws, base)) },
    { name: 'provenance.json', data: json(provenance(core, ws)) },
    { name: 'decisions.json', data: json(decisions(core, ws)) },
    ...snaps.map((s, i) => ({ name: `snapshots/${snapNames[i]}`, data: json(s) })),
    ...posts.map((p, i) => ({ name: `posts/${postNames[i]}`, data: json(p) })),
  ];
  return zipStream(entries);
}
