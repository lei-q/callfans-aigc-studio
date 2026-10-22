import type {
  AestheticItem,
  CreateJobBody,
  DevicePollReply,
  DeviceStartReply,
  Job,
  MediaType,
  OptimizeReply,
  OrderDto,
  PackDto,
  PayChannel,
  Post,
  Project,
  RefInput,
  Result,
  SettingsPatch,
  UploadReply,
} from '@aigc/shared';
import {
  EDIT_DEF,
  MAX_REFS,
  POST_PLATFORMS,
  SEED_PROMPTS,
  TYPES,
  affordable,
  agentParamText,
  paramsBrief,
  resoOf,
  unitPrice,
  uid,
} from '@aigc/shared';
import { api } from '../lib/api';
import { copyText, downloadText, downloadUrl, pickFiles, renderEditedImage, resultDownloadUrl, thumbOf } from '../lib/util';
import { cloneEditDefaults, getState, setState, type DrawerType, type Page, type State } from './index';
import { fixParams } from './data';
import { boardOf, canvasItems, inScope, jobById, libResults, modelOf, resultById, wsShort } from './selectors';
import { toast, toastError } from './toast';

/* ============================================================================
   动作：原型 ACTIONS 表一一迁过来，写操作先乐观更新再调服务端。
   ========================================================================== */

/* ---------------- 导航 ---------------- */

export function goStudio(type?: MediaType) {
  setState((s) => {
    s.page = 'studio';
    s.studioTab = 'gen';
    if (type) s.type = type;
  });
}

export function switchPage(page: Page) {
  setState((s) => {
    s.page = page;
    s.wsMenu = false;
  });
}

export function pickType(type: MediaType) {
  setState((s) => {
    s.type = type;
    s.page = 'studio';
    s.optimize = null;
    s.studioTab = 'gen';
  });
}

export function pickWs(id: string) {
  setState((s) => {
    s.ws = id;
    s.wsMenu = false;
    s.canvasSel = [];
    s.linkSel = null;
    s.cvsMenu = null;
    s.cvsPop = null;
    s.diverge = null;
    s.platforms = null;
    s.libSelect = [];
  });
}

export function openDrawer(type: DrawerType, id?: string) {
  setState((s) => {
    s.drawer = { type, id };
  });
}
export function closeDrawer() {
  setState((s) => {
    s.drawer = null;
    s.newKeySecret = null;
  });
}

export function openQueue(onlyFailed = false) {
  setState((s) => {
    s.queueFilter = onlyFailed ? 'failed' : 'all';
    s.drawer = { type: 'queue' };
  });
}

export function openLibraryType(type: MediaType) {
  setState((s) => {
    s.page = 'library';
    s.libTab = 'lib';
    s.libFilter = type;
    s.libSearch = '';
  });
}

export function helpJump(act: string) {
  setState((s) => {
    s.drawer = null;
    if (act === 'fail') {
      s.page = 'jobs';
      s.jobFilter = 'failed';
    } else if (act === 'quota') s.drawer = { type: 'topup' };
    else if (act === 'api') s.page = 'api';
    else if (act === 'jobs') {
      s.page = 'jobs';
      s.jobFilter = 'all';
    } else if (act === 'settings') s.page = 'settings';
    else s.page = 'studio';
  });
  if (act !== 'quota') toast('info', '已跳转到相关入口');
}

/* ---------------- 生成表单 ---------------- */

export function setParam(key: string, val: unknown) {
  setState((s) => {
    const t = s.type;
    const p = s.params[t] as unknown as Record<string, unknown>;
    p[key] = val;
    if (t === 'audio' && key === 'use') {
      if (val === 'tts') p.dur = 30;
      if (val === 'music') p.dur = 60;
      if (val === 'sfx') p.dur = 5;
      fixParams(s);
    }
  });
}

export function changeModel(id: string) {
  setState((s) => {
    const p = s.params[s.type];
    p.model = id;
    const m = s.models.find((x) => x.id === id);
    if (s.type === 'video' && m?.durs?.length && p.dur && !m.durs.includes(p.dur)) {
      p.dur = m.durs.filter((d) => d <= (p.dur || 5)).pop() || m.durs[0];
    }
  });
  const s = getState();
  const m = modelOf(s, id);
  toast('info', `已切换模型：${m.name}`, `单价 ${m.price} 点 / ${m.basis}`);
}

export const setPrompt = (v: string) => setState((s) => void (s.prompt[s.type] = v));
export const setNegative = (v: string) => setState((s) => void (s.negative[s.type] = v));
export const toggleAdv = () => setState((s) => void (s.adv = !s.adv));

export async function optimizePrompt() {
  const s = getState();
  const t = s.type;
  const cur = s.prompt[t].trim();
  if (!cur) {
    toast('info', '先写一句想法', '哪怕只写「秋季新品海报」也行，我来补细节');
    return;
  }
  setState((st) => void (st.optimizing = true));
  try {
    const r = await api.post<OptimizeReply>('/api/assist/optimize', { type: t, prompt: cur });
    setState((st) => void (st.optimize = r));
    if (r.mode === 'expand') toast('ai', r.llm ? '已用对话模型补成完整提示词' : '已把这句话补成完整提示词', r.llm ? '看一眼，不满意就点「忽略」' : r.reason || '看一眼，不满意就点「忽略」');
    else toast('ai', '给了几条可加的细节', r.llm ? '挑不挑都行，不改也能直接生成' : r.reason || '挑不挑都行，不改也能直接生成');
  } catch (e) {
    toastError(e);
  } finally {
    setState((st) => void (st.optimizing = false));
  }
}

export function applyOptimize() {
  setState((s) => {
    const o = s.optimize;
    if (!o) return;
    const t = s.type;
    if (o.mode === 'expand') s.prompt[t] = o.result;
    else s.prompt[t] = `${s.prompt[t].trim().replace(/[。.]+$/, '')}。${o.add}`;
    if (o.neg && !s.negative[t].trim()) s.negative[t] = o.neg;
    s.optimize = null;
  });
  toast('success', '已应用', '提示词已更新，可以直接生成');
}
export const dismissOptimize = () => setState((s) => void (s.optimize = null));

export function clearPrompt() {
  const s = getState();
  if (!s.prompt[s.type].trim()) {
    toast('info', '本来就是空的', '写一句想做什么就能生成');
    return;
  }
  setState((st) => {
    st.prompt[st.type] = '';
    st.optimize = null;
  });
}

export function copyPrompt() {
  const s = getState();
  const p = s.prompt[s.type].trim();
  if (!p) {
    toast('info', '还没有内容', '先写一句再复制');
    return;
  }
  copyText(p);
  toast('success', '已复制提示词', '粘贴到任何地方都能用');
}

export function cycleRef(i: number) {
  let w = 0.6;
  setState((s) => {
    const r = s.refs[s.type][i];
    if (!r) return;
    const order = [0.3, 0.6, 0.9];
    r.w = order[(order.indexOf(r.w) + 1) % order.length] || 0.6;
    w = r.w;
  });
  toast('info', `参考强度 ${w}`, '数值越高越贴近参考图，越低越自由');
}
export const removeRef = (i: number) => setState((s) => void s.refs[s.type].splice(i, 1));

/** 结果 → 参考素材：图像用原件，视频音频用封面 */
export const refOfResult = (r: Result, w: number, from?: RefInput['from']): RefInput => ({
  src: r.type === 'image' ? r.src : thumbOf(r) || r.src,
  w,
  from,
  rid: r.id,
  t: r.title,
});

export function addRefItem(rid: string) {
  const s = getState();
  const r = resultById(s, rid);
  if (!r) return;
  const t = s.type;
  if (s.refs[t].length >= MAX_REFS) {
    toast('warn', '最多 4 项', '先移除一项再加');
    return;
  }
  if (s.refs[t].some((x) => x.rid === rid)) {
    toast('info', '已经在参考里了');
    return;
  }
  setState((st) => void st.refs[t].push(refOfResult(r, 0.6, 'library')));
  toast('success', '已加入参考', '生成时它会作为参考图影响结果');
}

/** 系列一致性：生成时把基准塞进参考素材与参数 */
function anchorInto(s: State, t: MediaType) {
  const a = boardOf(s).anchor;
  if (!a || a.params.type !== t) return;
  const it = canvasItems(s).find((i) => i.id === a.cvsId);
  if (!it) return;
  const src = it.type === 'image' ? it.src || it.thumb : it.thumb || it.src;
  if (src && !s.refs[t].some((r) => r.src === src) && s.refs[t].length < MAX_REFS) {
    s.refs[t].unshift({ src, w: 0.75, from: 'anchor', rid: it.rid, t: it.t });
  }
  const { type: _t, ...params } = a.params;
  Object.assign(s.params[t], params);
}

export const estCost = (s: State) => unitPrice(s.type, s.params[s.type], modelOf(s, s.params[s.type].model));

export function jobBody(s: State, t: MediaType): CreateJobBody {
  const p = s.params[t];
  const base = { type: t, ws: s.ws, model: p.model, prompt: s.prompt[t], negative: s.negative[t] || undefined, refs: s.refs[t] };
  if (t === 'image') return { ...base, ratio: p.ratio, count: p.count, res: p.res, seed: p.seed || undefined, format: p.format, refWeight: p.refWeight };
  if (t === 'video') return { ...base, ratio: p.ratio, dur: p.dur, cam: p.cam, fps: p.fps, loop: p.loop, firstFrame: p.firstFrame, vres: p.vres };
  return { ...base, use: p.use, dur: p.dur, voice: p.voice, mood: p.mood, lang: p.lang, volume: p.volume };
}

export async function gen() {
  const s0 = getState();
  if (s0.genLock) return;
  const t = s0.type;
  if (!s0.prompt[t].trim()) {
    toast('warn', '提示词为空', '至少描述主体与用途，或补充一段基础描述');
    return;
  }
  const m = modelOf(s0, s0.params[t].model);
  if (m.status !== 'on') {
    toast('warn', '这个模型当前不可用', '换一个模型，或到「设置」里刷新模型列表');
    return;
  }
  setState((s) => {
    s.genLock = true;
    anchorInto(s, t);
  });
  setTimeout(() => setState((s) => void (s.genLock = false)), 900);
  try {
    const { jobs } = await api.post<{ jobs: Job[] }>('/api/jobs', { jobs: [jobBody(getState(), t)] });
    const j = jobs[0];
    if (j && j.status !== 'failed') {
      const n = getState().jobs.filter((x) => x.status === 'queued' || x.status === 'running').length;
      toast('info', '已加入生成队列', `${j.name} · 队列当前 ${Math.max(n, 1)} 个任务，可在顶栏「队列」查看`);
    }
  } catch (e) {
    toastError(e, '没能加入队列');
    if ((e as { status?: number }).status === 402 || (e as { status?: number }).status === 403) openDrawer((e as { status?: number }).status === 402 ? 'topup' : 'account');
  }
}

/** 沿用这条的参数再来一次：提示词、模型、比例、分辨率 / 时长全部回填 */
export function reuseParams(rid: string) {
  const s = getState();
  const r = resultById(s, rid);
  const j = r ? jobById(s, r.job) : undefined;
  if (!r || !j) {
    toast('info', '这条没有可沿用的参数', '它是在编辑器里改出来的');
    return;
  }
  const t = r.type;
  setState((st) => {
    st.type = t;
    st.page = 'studio';
    st.studioTab = 'gen';
    st.prompt[t] = j.prompt;
    st.optimize = null;
    st.cvsPop = null;
    const p = st.params[t];
    if (t === 'image') Object.assign(p, { model: j.model, ratio: j.ratio || '1:1', count: j.count || 4, res: j.res || '2k' });
    else if (t === 'video') Object.assign(p, { model: j.model, ratio: j.ratio || '9:16', dur: j.dur || 5, cam: j.cam || '固定' });
    else Object.assign(p, { model: j.model, use: j.use || 'tts', dur: j.dur || 30, voice: j.voice || p.voice, mood: j.mood || p.mood });
    fixParams(st);
  });
  toast('success', '参数已回填，可以直接生成', `${TYPES[t].name} · ${paramsBrief(j)} · 预计 ${estCost(getState())} 点`);
}

/** 变体：把该结果设为参考素材并回填提示词 */
export function makeVariant(rid: string) {
  const s = getState();
  const r = resultById(s, rid);
  if (!r) return;
  const j = jobById(s, r.job);
  setState((st) => {
    st.type = r.type;
    if (j) st.prompt[r.type] = j.prompt;
    const refs = st.refs[r.type].filter((x) => x.rid !== r.id);
    refs.unshift(refOfResult(r, r.type === 'image' ? 0.6 : 0.5));
    st.refs[r.type] = refs.slice(0, MAX_REFS);
    st.optimize = null;
    st.page = 'studio';
    st.studioTab = 'gen';
    st.drawer = null;
  });
  toast('ai', '已回填为参考素材', `${j ? '提示词已替换为来源任务的描述，' : ''}参考素材已换成「${r.title}」`);
}

export function copyPromptOf(rid: string) {
  const s = getState();
  const r = resultById(s, rid);
  const j = r ? jobById(s, r.job) : undefined;
  if (!j) {
    toast('info', '这条没有原始提示词', '它是在编辑器里改出来的');
    return;
  }
  copyText(j.prompt);
  toast('success', '已复制提示词', '粘贴到任何地方都能用');
}

/* ---------------- 任务 ---------------- */

export async function cancelJob(id: string) {
  try {
    const { job, refunded } = await api.post<{ job: Job; refunded: boolean }>(`/api/jobs/${id}/cancel`);
    toast('info', '任务已取消', refunded ? `已退回 ${job.cost} 点` : '该任务未扣费，无需退回');
  } catch (e) {
    toastError(e);
  }
}

export async function retryJob(id: string) {
  try {
    const { job } = await api.post<{ job: Job }>(`/api/jobs/${id}/retry`);
    toast('info', '已重新排队', `${job.name} · 参数不变，重新扣除 ${job.cost} 点`);
  } catch (e) {
    toastError(e);
  }
}

export async function fixJob(id: string) {
  try {
    const { log } = await api.post<{ job: Job; log: string[] }>(`/api/jobs/${id}/fix`);
    toast('success', '已按建议修复并排队', log.length ? `已调整：${log.join(' · ')}` : '参数已按建议调整，可在任务行核对');
  } catch (e) {
    toastError(e);
  }
}

export const toggleJob = (id: string) => setState((s) => void (s.expanded[id] = !s.expanded[id]));

export function openJob(id: string) {
  setState((s) => {
    s.expanded[id] = true;
    s.page = 'jobs';
    s.drawer = null;
  });
}

export function goJobs() {
  setState((s) => {
    s.drawer = null;
    s.page = 'jobs';
    s.jobFilter = 'all';
  });
}

/* ---------------- 产出 ---------------- */

export async function patchResult(id: string, patch: Partial<Pick<Result, 'home' | 'status' | 'title' | 'note' | 'tags' | 'isNew'>>) {
  setState((s) => {
    const r = s.results.find((x) => x.id === id);
    if (r) Object.assign(r, patch);
  });
  try {
    await api.patch(`/api/results/${id}`, patch);
  } catch (e) {
    toastError(e, '没能保存');
  }
}

export function openResult(id: string) {
  const r = resultById(getState(), id);
  if (r?.isNew) void patchResult(id, { isNew: false });
  openDrawer('result', id);
}

export function adoptResult(id: string) {
  const r = resultById(getState(), id);
  if (!r) return;
  const status = r.status === 'adopted' ? 'new' : 'adopted';
  void patchResult(id, { status });
  toast(status === 'adopted' ? 'success' : 'info', status === 'adopted' ? '已采用' : '已取消采用', r.title);
}

export function adoptAll(jobId: string) {
  const s = getState();
  const j = jobById(s, jobId);
  if (!j) return;
  j.results.forEach((id) => void patchResult(id, { status: 'adopted' }));
  toast('success', '本批结果已全部采用', `${j.name} · ${j.results.length} 项`);
}

export async function addToAesthetic(entry: Omit<AestheticItem, 'id' | 'createdAt'>, quiet = false) {
  try {
    const { item } = await api.post<{ item: AestheticItem }>('/api/aesthetic', entry);
    setState((s) => void s.aesthetic.unshift(item));
    if (!quiet) toast('success', '已收进审美库', `${item.t} · 在「审美库」里长期留着`);
    return true;
  } catch (e) {
    if ((e as { status?: number }).status === 409) toast('info', '已经在审美库里了', entry.t);
    else toastError(e);
    return false;
  }
}

export async function removeAesthetic(id: string, quiet = false) {
  const a = getState().aesthetic.find((x) => x.id === id);
  setState((s) => void (s.aesthetic = s.aesthetic.filter((x) => x.id !== id)));
  try {
    await api.del(`/api/aesthetic/${id}`);
    if (!quiet) toast('info', '已移出审美库', a ? a.t : '');
  } catch (e) {
    toastError(e);
  }
}

/** 收藏：同时进审美库（跨项目长期留着） */
export async function favResult(id: string) {
  const s = getState();
  const r = resultById(s, id);
  if (!r) return;
  const key = `r:${r.id}`;
  const existing = s.aesthetic.find((a) => a.key === key);
  if (existing) {
    await removeAesthetic(existing.id, true);
    if (r.status === 'fav') void patchResult(id, { status: 'new' });
    toast('info', '已移出审美库', r.title);
    return;
  }
  const ok = await addToAesthetic(
    {
      key,
      kind: r.type,
      src: thumbOf(r) || r.src,
      t: r.title,
      note: (r.tags || []).slice(0, 2).join(' · '),
      tags: r.tags || [],
      from: wsShort(s, r.ws).name,
    },
    true,
  );
  if (ok) {
    void patchResult(id, { status: 'fav' });
    toast('success', '已收进审美库', `${r.title} · 在「审美库」里长期留着`);
  }
}

export function downloadResult(id: string) {
  const r = resultById(getState(), id);
  if (!r) return;
  downloadUrl(resultDownloadUrl(r));
  toast('success', '已开始下载', `${r.title} · 产出可直接商用`);
}

export async function deleteResult(id: string) {
  const r = resultById(getState(), id);
  if (!r) return;
  setState((s) => {
    s.results = s.results.filter((x) => x.id !== id);
    s.drawer = null;
  });
  try {
    await api.del(`/api/results/${id}`);
    toast('info', '已删除该产出', '任务历史仍保留记录');
  } catch (e) {
    toastError(e);
  }
}

export function draftToLib(id: string) {
  const r = resultById(getState(), id);
  if (!r) return;
  void patchResult(id, { home: 'library', isNew: false });
  toast('success', '已存进素材库', `${r.title} · 从草稿箱移出`);
}

export function openInEditor(id: string) {
  const s = getState();
  const r = resultById(s, id);
  if (!r) return;
  setState((st) => {
    st.type = r.type;
    st.editPick[r.type] = r.id;
    const ops = cloneEditDefaults();
    if (r.type !== 'image') {
      (ops[r.type] as { in: number; out: number }).in = 0;
      (ops[r.type] as { in: number; out: number }).out = r.dur || (r.type === 'video' ? 5 : 30);
    }
    st.editOps[r.type] = ops[r.type] as never;
    st.page = 'studio';
    st.studioTab = 'edit';
    st.drawer = null;
  });
  toast('ai', '已在编辑器中打开', `${r.title} · ${s.projects.find((p) => p.id === r.ws)?.name || ''}`);
}

export async function saveMeta(id: string, title: string, note: string, tagsRaw: string) {
  const tags = tagsRaw.split(/[\s,，、]+/).filter(Boolean);
  const r = resultById(getState(), id);
  await patchResult(id, { title: title.trim() || r?.title, note: note.trim(), tags });
  closeDrawer();
  toast('success', '已保存', '标题、说明、标签都跟着这条产出走了');
}

/* ---------------- 素材库 / 帖子 ---------------- */

export function libSel(id: string) {
  setState((s) => {
    s.libSelect = s.libSelect.includes(id) ? s.libSelect.filter((x) => x !== id) : [...s.libSelect, id];
  });
}

async function savePost(p: Post) {
  try {
    await api.put(`/api/posts/${p.id}`, { ws: p.ws, title: p.title, body: p.body, items: p.items, platform: p.platform });
  } catch (e) {
    toastError(e, '帖子没能保存');
  }
}

function updatePost(id: string, fn: (p: Post) => void) {
  let out: Post | undefined;
  setState((s) => {
    const p = s.posts.find((x) => x.id === id);
    if (!p) return;
    fn(p);
    p.updatedAt = Date.now();
    out = JSON.parse(JSON.stringify(p));
  });
  if (out) void savePost(out);
}

export function libPack() {
  const s = getState();
  const ids = s.libSelect.filter((id) => resultById(s, id));
  if (ids.length < 2) {
    toast('info', '至少选 2 项', '打包成帖是把几张图组成一条内容');
    return;
  }
  const first = resultById(s, ids[0])!;
  const p: Post = { id: uid('P'), ws: first.ws, title: first.title, body: '', items: ids, platform: 'xhs', updatedAt: Date.now() };
  setState((st) => {
    st.posts.unshift(p);
    st.libSelect = [];
    st.libTab = 'post';
    st.drawer = { type: 'post', id: p.id };
  });
  void savePost(p);
  toast('success', '已打包成帖子草稿', `${ids.length} 张配图 · 补上标题和正文就能用`);
}

export function postNew() {
  const s = getState();
  const p: Post = { id: uid('P'), ws: s.ws, title: '', body: '', items: [], platform: 'xhs', updatedAt: Date.now() };
  setState((st) => {
    st.posts.unshift(p);
    st.libTab = 'post';
    st.drawer = { type: 'post', id: p.id };
  });
  void savePost(p);
}

export function postSave(id: string, title: string, body: string) {
  updatePost(id, (p) => {
    p.title = title.trim() || '未命名帖子';
    p.body = body;
  });
  closeDrawer();
  const p = getState().posts.find((x) => x.id === id);
  toast('success', '帖子已保存', `${p?.items.length || 0} 张配图 · ${(p?.body || '').length} 字`);
}

export async function postDel(id: string) {
  setState((s) => {
    s.posts = s.posts.filter((x) => x.id !== id);
    s.drawer = null;
  });
  try {
    await api.del(`/api/posts/${id}`);
    toast('info', '帖子已删除', '素材库里的产出不受影响');
  } catch (e) {
    toastError(e);
  }
}

export const postPlatform = (id: string, k: string) => updatePost(id, (p) => void (p.platform = k));
export const postItemAdd = (id: string, rid: string) => updatePost(id, (p) => void (!p.items.includes(rid) && p.items.push(rid)));
export const postItemDel = (id: string, rid: string) => updatePost(id, (p) => void (p.items = p.items.filter((x) => x !== rid)));
export function postItemShift(id: string, rid: string, dir: -1 | 1) {
  updatePost(id, (p) => {
    const i = p.items.indexOf(rid);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= p.items.length) return;
    p.items.splice(j, 0, p.items.splice(i, 1)[0]);
  });
}
/** 拖到谁身上就排在谁前面 */
export function postItemMove(id: string, from: string, to: string) {
  if (from === to) return;
  updatePost(id, (p) => {
    const fi = p.items.indexOf(from);
    const ti = p.items.indexOf(to);
    if (fi < 0 || ti < 0) return;
    p.items.splice(fi, 1);
    p.items.splice(ti, 0, from);
  });
}

export function postText(s: State, p: Post) {
  const items = p.items.map((id) => resultById(s, id)).filter((r): r is Result => !!r);
  const plat = POST_PLATFORMS.find((x) => x.k === p.platform);
  const origin = window.location.origin;
  const lines = [`# ${p.title || '未命名帖子'}`, ''];
  if (p.body) lines.push(p.body, '');
  if (items.length) {
    lines.push('---', '');
    items.forEach((r) => {
      lines.push(`![${r.title}](${r.src.startsWith('/') ? origin + r.src : r.src})`);
      if (r.note) lines.push(`*${r.note}*`);
      lines.push('');
    });
  }
  lines.push('---', `目标平台：${plat ? plat.n : '未指定'} · 配图 ${items.length} 张`);
  return lines.join('\n');
}

export function postCopy(id: string, title?: string, body?: string) {
  const s = getState();
  const p = s.posts.find((x) => x.id === id);
  if (!p) return;
  copyText(postText(s, { ...p, title: title ?? p.title, body: body ?? p.body }));
  toast('success', '正文已复制', '标题、正文、配图说明都在里面');
}

export function postExport(id: string, title?: string, body?: string) {
  const s = getState();
  const p = s.posts.find((x) => x.id === id);
  if (!p) return;
  const full = { ...p, title: title ?? p.title, body: body ?? p.body };
  downloadText(`${(full.title || 'post').replace(/[\\/:*?"<>|]/g, '_')}.md`, postText(s, full));
  toast('success', '已导出 Markdown', '图片地址指向本机服务，可以在浏览器里直接打开');
}

/* ---------------- 审美库：从电脑收藏 ---------------- */

export async function uploadFiles(files: File[]): Promise<UploadReply[]> {
  const fd = new FormData();
  files.forEach((f) => fd.append('file', f, f.name));
  const { files: out } = await api.upload<{ files: UploadReply[] }>('/api/files', fd);
  return out;
}

export async function aestheticAddFile() {
  const files = await pickFiles('image/*', true);
  if (!files.length) return;
  try {
    const ups = await uploadFiles(files);
    let n = 0;
    for (let i = 0; i < ups.length; i++) {
      const f = files[i];
      const ok = await addToAesthetic(
        {
          key: `f:${f.name}:${f.size}`,
          kind: 'image',
          src: ups[i].url,
          t: f.name.replace(/\.[^.]+$/, '').slice(0, 40) || '外部收藏',
          note: '',
          tags: ['外部收藏'],
          from: '本地文件',
        },
        true,
      );
      if (ok) n += 1;
    }
    if (n) toast('success', `已收藏 ${n} 张`, '图片已存进本机，原文件删了也还在');
  } catch (e) {
    toastError(e);
  }
}

/* ---------------- 钱包 ---------------- */

export const canAfford = (s: State, cost: number) => affordable(s.wallet, cost);

/* ---------------- 账号：设备码登录 ---------------- */

export async function loginStart() {
  setState((st) => {
    st.loginError = null;
    st.loginFlow = null;
  });
  try {
    const r = await api.post<DeviceStartReply>('/api/auth/login', {});
    setState((st) => void (st.loginFlow = { ...r, startedAt: Date.now() }));
    window.open(r.loginUrl, '_blank', 'noopener');
    void loginPollLoop();
  } catch (e) {
    setState((st) => void (st.loginError = (e as Error).message));
    toastError(e, '发起登录失败');
  }
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;
export function loginPollLoop() {
  if (pollTimer) clearTimeout(pollTimer);
  const step = async () => {
    const flow = getState().loginFlow;
    if (!flow) return;
    if (Date.now() - flow.startedAt > flow.expiresIn * 1000) {
      setState((st) => void (st.loginError = '登录链接已过期，请重新发起'));
      setState((st) => void (st.loginFlow = null));
      return;
    }
    let r: DevicePollReply | null = null;
    try {
      r = await api.post<DevicePollReply>('/api/auth/poll', { deviceCode: flow.deviceCode });
    } catch {
      /* 网络抖动：继续轮询 */
    }
    if (r?.status === 'approved') {
      setState((st) => {
        st.loginFlow = null;
        st.loginError = null;
      });
      toast('success', '登录成功', '点数已跟你的账号绑定，换设备也不会丢');
      return;
    }
    if (r?.status === 'expired' || r?.status === 'denied') {
      setState((st) => {
        st.loginFlow = null;
        st.loginError = r?.status === 'denied' ? '登录被拒绝' : '登录链接已过期';
      });
      return;
    }
    pollTimer = setTimeout(step, (r ? 2 : flow.interval) * 1000);
  };
  pollTimer = setTimeout(step, 1500);
}

export function loginCancel() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  setState((st) => void (st.loginFlow = null));
  api.post('/api/auth/cancel').catch(() => {});
}

export async function logout() {
  try {
    await api.post('/api/auth/logout');
    toast('info', '已退出登录', '本机的项目与素材保留在这台电脑上');
  } catch (e) {
    toastError(e);
  }
}

/* ---------------- 充值：微信 / 支付宝在线支付 ---------------- */

export async function loadPacks() {
  setState((st) => void (st.packsLoading = true));
  try {
    const { packs } = await api.get<{ packs: PackDto[] }>('/api/billing/packs');
    setState((st) => void (st.packs = packs));
  } catch (e) {
    toastError(e, '没能拉到充值档位');
  } finally {
    setState((st) => void (st.packsLoading = false));
  }
}

export async function createOrder(packId: string, channel: PayChannel) {
  try {
    const { order } = await api.post<{ order: OrderDto }>('/api/billing/orders', { packId, channel });
    setState((st) => void (st.activeOrder = order));
    void pollOrder(order.id);
    return order;
  } catch (e) {
    toastError(e, '下单失败');
    return null;
  }
}

let orderTimer: ReturnType<typeof setTimeout> | null = null;
export function pollOrder(id: string) {
  if (orderTimer) clearTimeout(orderTimer);
  const step = async () => {
    const cur = getState().activeOrder;
    if (!cur || cur.id !== id) return;
    if (cur.status === 'paid' || cur.status === 'closed' || cur.status === 'refunded') return;
    if (Date.now() > cur.expireAt) {
      setState((st) => void (st.activeOrder = st.activeOrder && { ...st.activeOrder, status: 'closed' }));
      return;
    }
    try {
      const { order } = await api.get<{ order: OrderDto }>(`/api/billing/orders/${id}`);
      setState((st) => {
        st.activeOrder = order;
        const i = st.orders.findIndex((x) => x.id === order.id);
        if (i >= 0) st.orders[i] = order;
        else st.orders.unshift(order);
      });
      if (order.status === 'paid') {
        toast('success', '充值到账', `${order.points} 点 · ${order.packName}`);
        return;
      }
      if (order.status === 'closed' || order.status === 'refunded') return;
    } catch {
      /* 网络抖动：继续轮询 */
    }
    orderTimer = setTimeout(step, 2000);
  };
  orderTimer = setTimeout(step, 1500);
}

export function closeActiveOrder() {
  if (orderTimer) clearTimeout(orderTimer);
  orderTimer = null;
  setState((st) => void (st.activeOrder = null));
}

export async function loadOrders() {
  try {
    const { orders } = await api.get<{ orders: OrderDto[] }>('/api/billing/orders');
    setState((st) => void (st.orders = orders));
  } catch (e) {
    toastError(e, '没能拉到订单');
  }
}

/* ---------------- 项目 ---------------- */

export async function createProject(name: string) {
  try {
    const { project } = await api.post<{ project: Project }>('/api/projects', { name });
    setState((s) => {
      if (!s.projects.some((p) => p.id === project.id)) s.projects.push(project);
      if (!s.boards[project.id]) s.boards[project.id] = { items: [], links: [], view: { x: 40, y: 40, k: 1 }, anchor: null };
    });
    pickWs(project.id);
    toast('success', '项目已创建', project.name);
  } catch (e) {
    toastError(e);
  }
}

export async function renameProject(id: string, name: string) {
  try {
    await api.patch(`/api/projects/${id}`, { name });
    toast('success', '已重命名', name);
  } catch (e) {
    toastError(e);
  }
}

export async function deleteProject(id: string) {
  try {
    await api.del(`/api/projects/${id}`);
    toast('info', '项目已删除', '它的任务、产出、画板和帖子一并删除了');
  } catch (e) {
    toastError(e);
  }
}

/* ---------------- API Key ---------------- */

export async function apiCreateKey() {
  try {
    const { secret } = await api.post<{ secret: string }>('/api/keys', {});
    setState((s) => void (s.newKeySecret = secret));
    copyText(secret);
    toast('success', '已创建新 Key，并复制到剪贴板', '完整 Key 只在这一次展示，请妥善保存');
  } catch (e) {
    toastError(e);
  }
}
export async function apiToggle(id: string, on: boolean) {
  try {
    await api.patch(`/api/keys/${id}`, { on });
    toast('info', on ? '已启用' : '已停用', on ? '可以继续调用' : '使用该 Key 的调用会立即失败');
  } catch (e) {
    toastError(e);
  }
}
export async function apiDelete(id: string) {
  try {
    await api.del(`/api/keys/${id}`);
    toast('info', '已删除 Key', '不可恢复');
  } catch (e) {
    toastError(e);
  }
}

/* ---------------- 设置 ---------------- */

export async function patchSettings(patch: SettingsPatch, okMsg?: string) {
  try {
    const { settings } = await api.patch<{ settings: State['settings'] }>('/api/settings', patch);
    setState((s) => {
      s.settings = settings;
      fixParams(s);
    });
    if (okMsg) toast('success', okMsg);
    return true;
  } catch (e) {
    toastError(e);
    return false;
  }
}

export async function refreshModels() {
  try {
    const { settings } = await api.post<{ settings: State['settings'] }>('/api/settings/treecloud/refresh');
    setState((s) => {
      s.settings = settings;
      fixParams(s);
    });
    const c = settings?.direct.lastCheck;
    toast(c?.ok ? 'success' : 'warn', c?.ok ? '模型列表已刷新' : '连接失败', c?.message || '');
  } catch (e) {
    toastError(e);
  }
}

/* ---------------- 编辑器 ---------------- */

export const editPool = (s: State, type: MediaType) =>
  libResults(s).filter((r) => r.type === type && (s.editScope === 'all' || r.ws === s.ws));

export function editPicked(s: State, type: MediaType) {
  const id = s.editPick[type];
  if (id) {
    const hit = s.results.find((r) => r.id === id);
    if (hit) return hit;
  }
  return editPool(s, type)[0] || null;
}

export function editPick(id: string) {
  setState((s) => {
    const t = s.type;
    s.editPick[t] = id;
    s.editOps[t] = { ...EDIT_DEF[t] } as never;
    const r = s.results.find((x) => x.id === id);
    if (t !== 'image' && r) (s.editOps[t] as { out: number }).out = r.dur || (t === 'video' ? 5 : 30);
  });
}

export function editOp(key: string, raw: string) {
  setState((s) => {
    const ops = s.editOps[s.type] as unknown as Record<string, unknown>;
    const now = ops[key];
    if (typeof now === 'boolean') ops[key] = !now;
    else if (typeof now === 'number') ops[key] = Number(raw);
    else ops[key] = now === raw && key === 'crop' ? '原图' : raw;
  });
}

export function editInput(key: string, value: string) {
  setState((s) => {
    const ops = s.editOps[s.type] as unknown as Record<string, unknown>;
    ops[key] = typeof ops[key] === 'number' ? Number(value) : value;
  });
}

export function editReset() {
  setState((s) => {
    const t = s.type;
    s.editOps[t] = { ...EDIT_DEF[t] } as never;
    const cur = editPicked(s, t);
    if (t !== 'image' && cur) (s.editOps[t] as { out: number }).out = cur.dur || (t === 'video' ? 5 : 30);
  });
  toast('info', '已重置参数', '回到素材原始状态');
}

function editTags(s: State, t: MediaType) {
  if (t === 'image') {
    const o = s.editOps.image;
    const tags = ['已编辑'];
    if (o.filter !== 'none') tags.push(({ warm: '暖调', cool: '冷调', mono: '黑白', film: '胶片' } as Record<string, string>)[o.filter] || o.filter);
    if (o.crop !== '原图') tags.push(`裁剪 ${o.crop}`);
    if (o.brightness || o.contrast || o.saturate) tags.push('调过明暗');
    return tags.slice(0, 3);
  }
  if (t === 'video') return ['已编辑', `变速 ${s.editOps.video.speed}x`, s.editOps.video.mute ? '已静音' : '保留原声'];
  return ['已编辑', `音量 ${s.editOps.audio.volume}%`, s.editOps.audio.denoise ? '已降噪' : '原声'];
}

export async function editSave() {
  const s = getState();
  const t = s.type;
  const cur = editPicked(s, t);
  if (!cur) {
    toast('warn', '先选一条素材', '左边缩略图里点一个');
    return;
  }
  const ops = s.editOps[t];
  const def = { ...EDIT_DEF[t] } as Record<string, unknown>;
  if (t !== 'image') def.out = cur.dur || (t === 'video' ? 5 : 30);
  if (JSON.stringify(ops) === JSON.stringify(def)) {
    toast('info', '还没有做任何修改', '调整一下参数再保存');
    return;
  }
  try {
    let dataUrl: string | undefined;
    if (t === 'image') {
      dataUrl = await renderEditedImage(cur.src, s.editOps.image, cur.ratio);
    }
    const { result } = await api.post<{ result: Result }>('/api/results/edited', {
      sourceId: cur.id,
      title: `${cur.title.replace(/（已编辑）$/, '')}（已编辑）`,
      tags: editTags(s, t),
      edit: { ops: ops as unknown as Record<string, unknown> },
      dataUrl,
    });
    setState((st) => {
      if (!st.results.some((r) => r.id === result.id)) st.results.unshift(result);
      st.editPick[t] = result.id;
    });
    toast('success', '已保存为新产出', `${result.title} · 原素材没有被改动，可在素材库找到`);
  } catch (e) {
    toastError(e, '保存失败');
  }
}

/* ---------------- 杂项 ---------------- */

export const refPool = (s: State) => libResults(s).filter((r) => r.type === s.type && (s.refScope === 'all' || r.ws === s.ws));
export const agentParamLabel = agentParamText;
export { resoOf, SEED_PROMPTS, inScope };
