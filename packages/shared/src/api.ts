import type { AudioUse, ChannelId, JobParams, MediaType, ModelPicks, RefInput, ResultHome, ResultStatus, RunMode } from './types';

/* 前后端之间的请求体合同 */

export interface CreateJobBody extends JobParams {
  type: MediaType;
  ws: string;
  model: string;
  prompt: string;
  negative?: string;
  refs: RefInput[];
  name?: string;
  divergeAxis?: string;
  platform?: string;
  fromCvsId?: string;
}

export interface CreateJobsBody {
  jobs: CreateJobBody[];
}

export interface PatchResultBody {
  home?: ResultHome;
  status?: ResultStatus;
  title?: string;
  note?: string;
  tags?: string[];
  isNew?: boolean;
}

export interface SaveEditedBody {
  sourceId: string;
  title: string;
  tags: string[];
  edit: { css?: string; ops: Record<string, unknown> };
  /** 图像编辑：浏览器渲染出的新文件（data URL） */
  dataUrl?: string;
}

export interface OptimizeBody {
  type: MediaType;
  prompt: string;
}
export interface OptimizeReply {
  mode: 'expand' | 'add';
  result: string;
  add: string;
  neg: string;
  note: string;
  /** 恒为 true：内容只来自真实模型 */
  llm: boolean;
}

export interface AgentEnhanceBody {
  mainType: MediaType;
  facts: string[];
  prompts: string[];
  nodeTexts: string[];
  draft: string;
}
export interface AgentEnhanceReply {
  understanding: string;
  draft: string;
}

export interface LinkPreview {
  url: string;
  title?: string;
  site?: string;
  desc?: string;
  image?: string;
  author?: string;
}

export interface SettingsPatch {
  cloud?: { baseUrl?: string };
  runner?: { concurrency?: number };
  direct?: { enabled?: boolean; baseUrl?: string; apiKey?: string; clearKey?: boolean };
  channel?: ChannelId;
  models?: Partial<Record<ChannelId, Partial<ModelPicks>>>;
  runtime?: { mode?: RunMode; host?: string; port?: number; lan?: boolean; token?: string; clearToken?: boolean };
}

export interface UploadReply {
  url: string;
  name: string;
  size: number;
  mime: string;
}

export type { AudioUse };

/** 帖子文案（AI 写标题 / 正文 / 标签）：只调真实文本模型，失败明确报错 */
export interface PostCopyBody {
  platform: string;
  /** 已有的标题 / 正文（有就在此基础上改写，没有就从配图信息起草） */
  title?: string;
  body?: string;
  /** 每张配图的描述：标题、原始提示词、已写的配文 */
  images: { title: string; prompt?: string; caption?: string }[];
}
export interface PostCopyReply {
  title: string;
  body: string;
  tags: string[];
}
