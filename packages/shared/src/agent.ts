import { TYPES, hostOf, postPlatformOf } from './constants';
import type { AudioUse, CanvasItem, CanvasLink, JobParams, MediaType, ResKey } from './types';

/* ============================================================================
   Agent：读画板，理需求，出提示词
   它的依据是画板上真实存在的东西：产出的原始提示词、标题、网页与文档、连线、
   分组和用户亲手写的字。这里只做规则推断，配置了 chat 模型时由服务端再润色。
   ========================================================================== */

const AGENT_STOP = /^(的|了|和|与|在|是|有|把|被|用|给|让|一个|一张|我们|你们|他们|这个|那个|可以|需要|想要|以及|并且|然后|因为|所以)$/;
const SPLIT = /[，,。.；;：:\s、]+/;

export interface PromptSource {
  prompt: string;
  type: MediaType;
  model?: string;
  ratio?: string;
  res?: ResKey;
  dur?: number;
  cam?: string;
  use?: AudioUse;
}

export interface AgentInput {
  items: CanvasItem[];
  links: CanvasLink[];
  scoped: boolean;
  /** 顺着 rid → result → job 拿到当时的提示词与参数 */
  resolve: (rid: string) => PromptSource | null;
  fallbackType: MediaType;
}

export interface AgentResult {
  scoped: boolean;
  counts: {
    media: number;
    webs: number;
    files: number;
    draws: number;
    posts: number;
    prompts: number;
    links: number;
    nodes: number;
    groups: number;
  };
  typeText: string;
  topWords: string[];
  guess: string;
  draft: string;
  mainType: MediaType;
  params: JobParams;
  notes: string[];
  postLines: string[];
  posts: { platform: string; like?: string }[];
  nodeTexts: string[];
  hubName: string;
  linkCount: number;
  linkLabels: string[];
  /** 由 LLM 润色过 */
  enhanced?: boolean;
  understanding?: string;
}

export function agentReadBoard(input: AgentInput): AgentResult {
  const { items, scoped } = input;
  const media = items.filter((i) => i.kind === 'media');
  const webs = items.filter((i) => i.kind === 'web');
  const files = items.filter((i) => i.kind === 'file');
  const draws = items.filter((i) => i.kind === 'draw');
  const posts = items.filter((i) => i.kind === 'post');
  const nodes = items.filter((i) => i.kind === 'node');
  const groups = items.filter((i) => i.kind === 'group');

  /* 连线：被连最多的那个就是这组的枢纽，它通常是基准 */
  const idSet = new Set(items.map((i) => i.id));
  const links = input.links.filter((l) => idSet.has(l.from) && idSet.has(l.to));
  const inDeg: Record<string, number> = {};
  links.forEach((l) => {
    inDeg[l.to] = (inDeg[l.to] || 0) + 1;
  });
  const hub = Object.keys(inDeg).sort((a, b) => inDeg[b] - inDeg[a])[0] || null;
  const hubItem = hub ? items.find((i) => i.id === hub) : null;
  const hubName = hubItem ? hubItem.t || hubItem.text || '未命名元素' : '';

  /* 节点和文字都是用户亲手写的话，比从历史提示词里统计高频词可靠 */
  const nodeTexts = items
    .filter((i) => i.kind === 'node' || i.kind === 'text')
    .map((i) => (i.text || '').trim())
    .filter(Boolean);

  /* 有来源任务的元素，能读到当时那条提示词——这是最可靠的需求信号 */
  const prompts: PromptSource[] = [];
  media.forEach((i) => {
    if (!i.rid) return;
    const src = input.resolve(i.rid);
    if (src && src.prompt) prompts.push(src);
  });

  /* 先定主流类型：画板上最多的那种，后面所有推断都以它为准 */
  const types: Partial<Record<MediaType, number>> = {};
  media.forEach((i) => {
    if (i.type) types[i.type] = (types[i.type] || 0) + 1;
  });
  const mainType = ((Object.keys(types) as MediaType[]).sort((a, b) => (types[b] || 0) - (types[a] || 0))[0] ||
    input.fallbackType) as MediaType;
  /* 同类型不足两条时再放宽，避免只靠一条过度拟合 */
  const sameType = prompts.filter((x) => x.type === mainType);
  const focus = sameType.length >= 2 ? sameType : prompts;

  const freq: Record<string, number> = {};
  focus.forEach(({ prompt }) => {
    prompt.split(SPLIT).forEach((seg) => {
      const w = seg.trim();
      if (w.length < 2 || w.length > 8 || AGENT_STOP.test(w)) return;
      freq[w] = (freq[w] || 0) + 1;
    });
  });
  const topWords = Object.keys(freq)
    .sort((a, b) => freq[b] - freq[a])
    .slice(0, 6);

  const typeText = (Object.keys(types) as MediaType[]).map((k) => `${types[k]} 张${TYPES[k].name}`).join('、');

  /* 需求理解：节点文字最优先，其次才是提示词高频词 */
  const nodeKeywords: string[] = [];
  nodeTexts.forEach((t) => {
    t.split(SPLIT).forEach((w) => {
      const x = w.trim();
      if (x.length >= 2 && x.length <= 8 && !AGENT_STOP.test(x)) nodeKeywords.push(x);
    });
  });
  const subjects = nodeKeywords.length ? nodeKeywords.slice(0, 3) : topWords.slice(0, 3);
  const guess = subjects.length
    ? subjects.join(' · ')
    : media[0]?.t || files[0]?.t || '还没有足够的线索';

  /* 建议提示词：节点文字作为主干，再综合画板上出现过的描述 */
  const draftParts: string[] = [];
  const seen = new Set<string>();
  const pushPart = (w: string) => {
    const key = w.slice(0, 4);
    if (seen.has(key)) return;
    seen.add(key);
    draftParts.push(w);
  };
  nodeTexts.slice(0, 3).forEach(pushPart);
  if (focus.length) {
    focus
      .map((x) => x.prompt)
      .join('。')
      .split(/[，,。.；;]+/)
      .forEach((cl) => {
        const w = cl.trim();
        if (w.length < 2 || w.length > 14) return;
        pushPart(w);
      });
  } else if (!draftParts.length && media.length) {
    media
      .map((i) => i.t)
      .filter((t): t is string => !!t)
      .slice(0, 4)
      .forEach(pushPart);
  }
  const draft = draftParts.slice(0, 8).join('，');

  /* 参数建议：跟随画板上最主流的那个类型 */
  const paramSrc = prompts.find((x) => x.type === mainType);
  const params: JobParams = {};
  if (mainType === 'image') {
    params.ratio = paramSrc?.ratio || '1:1';
    params.count = 4;
    params.res = paramSrc?.res || '2k';
  } else if (mainType === 'video') {
    params.ratio = paramSrc?.ratio || '9:16';
    params.dur = paramSrc?.dur || 5;
    params.cam = paramSrc?.cam || '推近';
  } else {
    params.use = paramSrc?.use || 'tts';
    params.dur = paramSrc?.dur || 30;
  }

  const notes: string[] = [];
  if (groups.length) notes.push(`${groups.length} 个分组：${groups.map((g) => g.t || '未命名').join('、')}`);
  const namedLinks = links.filter((l) => l.label);
  if (links.length) notes.push(`${links.length} 条连线${hubName && hub ? `，枢纽是「${hubName}」（被连 ${inDeg[hub]} 次）` : ''}`);
  if (namedLinks.length) notes.push(`${namedLinks.length} 条线写了名字：${namedLinks.map((l) => `「${l.label}」`).join('、')}`);
  if (nodeTexts.length) notes.push(`${nodeTexts.length} 处写着：${nodeTexts.map((t) => `「${t}」`).join('、')}`);
  if (webs.length) notes.push(`${webs.length} 个网页参考（${webs.map((w) => hostOf(w.url)).join('、')}）`);
  if (files.length) notes.push(`${files.length} 份文档`);
  if (draws.length) notes.push(`${draws.length} 处手绘标注`);

  /* 社媒帖子单独说，因为运营真正关心的是它——「这条为什么爆」 */
  const postLines = posts.map((p) => {
    const pf = postPlatformOf(p.url);
    return `${pf ? pf.n : '链接'}「${p.t || hostOf(p.url)}」${p.like ? ` · ${p.like} 赞` : ''}`;
  });

  return {
    scoped,
    counts: {
      media: media.length,
      webs: webs.length,
      files: files.length,
      draws: draws.length,
      posts: posts.length,
      prompts: prompts.length,
      links: links.length,
      nodes: nodes.length,
      groups: groups.length,
    },
    typeText,
    topWords,
    guess,
    draft,
    mainType,
    params,
    notes,
    postLines,
    posts: posts.map((p) => ({ platform: postPlatformOf(p.url)?.n || '链接', like: p.like })),
    nodeTexts,
    hubName,
    linkCount: links.length,
    linkLabels: namedLinks.map((l) => l.label || ''),
  };
}
