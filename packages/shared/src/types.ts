/* ============================================================================
   领域类型：服务端与前端共用的一份数据合同
   ========================================================================== */

export type MediaType = 'image' | 'video' | 'audio';
export type ResKey = '1080p' | '2k' | '4k';
export type AudioUse = 'tts' | 'music' | 'sfx';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
/** 产出的位置：收件箱 → 画布 → 素材库，没被取用的沉入草稿箱 */
export type ResultHome = 'inbox' | 'canvas' | 'library' | 'draft';
/** 产出的选中状态 */
export type ResultStatus = 'new' | 'adopted' | 'fav';

/** 项目：个人按项目分类，没有成员与配额 */
export interface Project {
  id: string;
  name: string;
  dot: string;
  used: number;
  createdAt: number;
}

/** 模型渠道：模型经过渠道层统一接入、路由与计费。每个 Provider 实例就是一个渠道 */
export interface Channel {
  id: string;
  name: string;
  note: string;
  kind: 'mock' | 'gateway';
  /** 当前是否可用（TreeCloud 没配 Key 时不可用） */
  ready: boolean;
}

export interface ModelInfo {
  /** 本地模型 ID。Mock 渠道沿用原型 ID，TreeCloud 渠道为 `tc:<上游 ID>` */
  id: string;
  name: string;
  type: MediaType;
  /** 单价（点 / basis），可在设置里覆盖 */
  price: number;
  basis: string;
  status: 'on' | 'off';
  channel: string;
  /** 上游公开模型 ID */
  upstream?: string;
  /** 图像：分辨率上限；未知时不做本地校验 */
  maxRes?: ResKey;
  /** 视频：可选时长与上限 */
  durs?: number[];
  maxDur?: number;
  ratios?: string[];
  /** 音频：支持的用途 */
  uses?: AudioUse[];
  /** 图像能力（来自上游 capabilities.limits） */
  maxOutputs?: number;
  imageSizes?: string[];
  maxInputImages?: number;
  /** 估算耗时：图像为秒/张，视频为秒/秒 */
  secPer?: number;
  note: string;
  caps: string[];
  limit: string;
  sample?: string;
}

export interface JobParams {
  ratio?: string;
  count?: number;
  res?: ResKey;
  dur?: number;
  cam?: string;
  /** 视频清晰度（上游 resolution） */
  vres?: string;
  use?: AudioUse;
  voice?: string;
  mood?: string;
  lang?: string;
  seed?: string;
  format?: string;
  fps?: number;
  loop?: boolean;
  volume?: number;
  firstFrame?: boolean;
  refWeight?: number;
}

export interface RefInput {
  /** 素材地址（本机服务的 URL 路径） */
  src: string;
  /** 参考强度 */
  w: number;
  from?: 'canvas' | 'library' | 'anchor';
  rid?: string;
  t?: string;
}

export interface JobFail {
  code: string;
  reason: string;
  fix: string;
}

export interface Job extends JobParams {
  id: string;
  name: string;
  type: MediaType;
  ws: string;
  model: string;
  prompt: string;
  negative?: string;
  refs: RefInput[];
  cost: number;
  status: JobStatus;
  progress?: number;
  eta?: string;
  queueNote?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  durText?: string;
  results: string[];
  /** 是否已扣费：保证「取消 → 重跑」的净支出正好是一次费用 */
  charged: boolean;
  usedFree?: number;
  fail?: JobFail;
  fixed?: boolean;
  fixLog?: string[];
  divergeAxis?: string;
  platform?: string;
  /** 从画布哪个元素发散 / 适配出来的，产出拖进画布时自动连回 */
  fromCvsId?: string;
  upstreamTaskId?: string;
  requestId?: string;
  source?: 'web' | 'api';
  /** API 调用用的本地 Key */
  keyId?: string;
}

export interface ResultEdit {
  css?: string;
  ops?: Record<string, unknown>;
}

export interface Result {
  id: string;
  /** 来源任务；编辑器保存的产出没有来源任务 */
  job: string | null;
  type: MediaType;
  ws: string;
  title: string;
  /** 原件地址 */
  src: string;
  /** 缩略图 / 封面；没有时前端按类型画占位 */
  thumb?: string;
  mime?: string;
  /** 演示素材：视频与音频只有封面，播放是模拟的 */
  simulated?: boolean;
  ratio: string;
  model: string;
  seed: number;
  createdAt: number;
  status: ResultStatus;
  tags: string[];
  note?: string;
  dur: number;
  cam?: string;
  home: ResultHome;
  isNew?: boolean;
  edit?: ResultEdit;
}

export interface Wallet {
  balance: number;
  spent: Record<MediaType, number>;
  dailyFree: number;
  dailyUsed: number;
  /** 当日免费额度对应的日期（YYYY-MM-DD），跨天自动重置 */
  dailyDate: string;
  firstTopupDone: boolean;
}

/* ---------------- 画布 ---------------- */

export type CanvasKind = 'media' | 'web' | 'post' | 'file' | 'draw' | 'node' | 'text' | 'group';
export type TextSize = 'sm' | 'md' | 'lg';

export interface CanvasItem {
  id: string;
  kind: CanvasKind;
  x: number;
  y: number;
  w?: number;
  h?: number;
  /** 高宽比 */
  ar?: number;
  z?: number;
  rot?: number;
  flipH?: boolean;
  flipV?: boolean;
  op?: number;
  /* 素材 */
  type?: MediaType;
  src?: string;
  thumb?: string;
  t?: string;
  rid?: string;
  local?: boolean;
  link?: boolean;
  seed?: number;
  dur?: number;
  /* 网页 / 帖子 */
  url?: string;
  cover?: string;
  platform?: string;
  isVideo?: boolean;
  author?: string;
  like?: string;
  save?: string;
  cmt?: string;
  vdur?: string;
  site?: string;
  desc?: string;
  /* 文档 */
  ftype?: string;
  bytes?: number;
  /* 手绘 */
  color?: string;
  lw?: number;
  pts?: [number, number][];
  /* 节点 / 文字 */
  text?: string;
  size?: TextSize;
  /** 导图：由哪个素材展开出来的 */
  mm?: string;
  mmAxis?: string;
}

export interface CanvasLink {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export interface CanvasView {
  x: number;
  y: number;
  k: number;
}

export interface StyleAnchor {
  cvsId: string;
  params: { type: MediaType } & JobParams;
}

export interface Board {
  items: CanvasItem[];
  links: CanvasLink[];
  view: CanvasView;
  anchor: StyleAnchor | null;
}

/* ---------------- 审美库 / 帖子 ---------------- */

export interface AestheticItem {
  id: string;
  /** 去重键：r:结果id / f:文件名:大小 / w:url / c:画布元素 */
  key: string;
  kind: 'image' | 'video' | 'audio' | 'web';
  src: string;
  url?: string;
  t: string;
  note?: string;
  tags: string[];
  from?: string;
  createdAt: number;
}

export interface Post {
  id: string;
  ws: string;
  title: string;
  body: string;
  items: string[];
  platform: string;
  updatedAt: number;
}

/* ---------------- API 接入 ---------------- */

export interface ApiKey {
  id: string;
  name: string;
  channel: string;
  /** 掩码后的 Key，完整值只在创建时返回一次 */
  masked: string;
  createdAt: number;
  lastUsedAt?: number;
  on: boolean;
}

export interface ApiUsage {
  id: string;
  at: number;
  model: string;
  n: number;
  pts: number;
  keyId: string;
}

/* ---------------- 设置 ---------------- */

export type ProviderId = 'mock' | 'treecloud';
export type RunMode = 'desktop' | 'web';

export interface Settings {
  provider: {
    active: ProviderId;
    concurrency: number;
    treecloud: {
      baseUrl: string;
      hasKey: boolean;
      keyHint?: string;
      lastCheck?: { ok: boolean; at: number; message: string };
    };
  };
  chat: {
    enabled: boolean;
    model: string;
    /** 当前 Key 可用的对话模型 */
    available: string[];
  };
  /** 按模型覆盖单价（点） */
  prices: Record<string, number>;
  runtime: {
    mode: RunMode;
    host: string;
    port: number;
    lan: boolean;
    hasToken: boolean;
  };
}

export interface AppInfo {
  version: string;
  mode: RunMode;
  dataDir: string;
  platform: string;
  /** 运行在 Electron 桌面壳里 */
  desktop: boolean;
}

export interface Bootstrap {
  app: AppInfo;
  projects: Project[];
  jobs: Job[];
  results: Result[];
  wallet: Wallet;
  boards: Record<string, Board>;
  aesthetic: AestheticItem[];
  posts: Post[];
  models: ModelInfo[];
  channels: Channel[];
  settings: Settings;
  apiKeys: ApiKey[];
  apiUsage: ApiUsage[];
  ui: Record<string, unknown>;
}

/** 服务端推送的事件 */
export type ServerEvent =
  | { type: 'job'; job: Job }
  | { type: 'result'; result: Result }
  | { type: 'result.deleted'; id: string }
  | { type: 'wallet'; wallet: Wallet }
  | { type: 'project'; project: Project }
  | { type: 'project.deleted'; id: string }
  | { type: 'models'; models: ModelInfo[]; channels: Channel[] }
  | { type: 'settings'; settings: Settings }
  | { type: 'api'; apiKeys: ApiKey[]; apiUsage: ApiUsage[] }
  | { type: 'notice'; level: 'info' | 'success' | 'warn' | 'ai'; title: string; desc?: string };
