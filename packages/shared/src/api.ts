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
  llm: boolean;
  /** 没有可用模型路由时的说明（此时为规则推断） */
  reason?: string;
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
  prices?: Record<string, number | null>;
  runtime?: { mode?: RunMode; host?: string; port?: number; lan?: boolean; token?: string; clearToken?: boolean };
}

export interface UploadReply {
  url: string;
  name: string;
  size: number;
  mime: string;
}

export type { AudioUse };
