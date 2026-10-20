import type { Channel, Job, JobFail, ModelInfo } from '@aigc/shared';

export interface ProviderOutput {
  src: string;
  thumb?: string;
  mime?: string;
  simulated?: boolean;
  title?: string;
  seed?: number;
  dur?: number;
}

export interface RunContext {
  signal: AbortSignal;
  /** 更新进度（0–100）与提示文案 */
  progress(p: number, eta?: string): void;
  /** 把生成结果落盘到 media 目录，返回可访问地址 */
  save(buf: Buffer, mime: string): Promise<{ src: string; mime: string }>;
  /** 参考素材 → data URL（上游接受 data URL 或公网 HTTPS） */
  resolveRef(src: string): Promise<{ dataUrl: string; mime: string } | null>;
  /** 记下上游任务 ID，应用重启后可以接着查 */
  setUpstream(taskId: string, requestId?: string): void;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Provider {
  readonly id: 'mock' | 'treecloud';
  channel(): Channel;
  models(): ModelInfo[];
  /** 并发上限 */
  concurrency(): number;
  run(job: Job, model: ModelInfo, ctx: RunContext): Promise<ProviderOutput[]>;
  /** 接着查重启前已经提交给上游的任务 */
  resume?(job: Job, model: ModelInfo, ctx: RunContext): Promise<ProviderOutput[]>;
  cancel?(job: Job): Promise<void>;
  chat?(model: string, messages: ChatMessage[], signal?: AbortSignal): Promise<string>;
}

/** 生成失败：带错误码、原因与修复建议，前端直接展示 */
export class ProviderError extends Error implements JobFail {
  constructor(
    readonly code: string,
    readonly reason: string,
    readonly fix: string,
  ) {
    super(`${code} ${reason}`);
  }

  toFail(): JobFail {
    return { code: this.code, reason: this.reason, fix: this.fix };
  }
}
