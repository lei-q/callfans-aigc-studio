import { z } from 'zod';

/* 请求体校验：只放行已知字段，客户端塞进来的多余字段一律丢掉 */

const mediaType = z.enum(['image', 'video', 'audio']);

export const refSchema = z.object({
  src: z.string().min(1).max(30_000_000),
  w: z.number().min(0).max(1),
  from: z.enum(['canvas', 'library', 'anchor']).optional(),
  rid: z.string().optional(),
  t: z.string().max(200).optional(),
});

export const createJobSchema = z.object({
  type: mediaType,
  ws: z.string().min(1),
  model: z.string().min(1),
  prompt: z.string().max(8000),
  negative: z.string().max(2000).optional(),
  refs: z.array(refSchema).max(4).default([]),
  name: z.string().max(80).optional(),
  divergeAxis: z.string().max(20).optional(),
  platform: z.string().max(20).optional(),
  fromCvsId: z.string().max(64).optional(),
  ratio: z.string().max(10).optional(),
  count: z.number().int().min(1).max(8).optional(),
  res: z.enum(['1080p', '2k', '4k']).optional(),
  dur: z.number().min(1).max(600).optional(),
  cam: z.string().max(10).optional(),
  vres: z.string().max(10).optional(),
  use: z.enum(['tts', 'music', 'sfx']).optional(),
  voice: z.string().max(20).optional(),
  mood: z.string().max(20).optional(),
  lang: z.string().max(20).optional(),
  seed: z.string().max(20).optional(),
  format: z.string().max(10).optional(),
  fps: z.number().optional(),
  loop: z.boolean().optional(),
  volume: z.number().optional(),
  firstFrame: z.boolean().optional(),
  refWeight: z.number().optional(),
});

export const createJobsSchema = z.object({ jobs: z.array(createJobSchema).min(1).max(12) });

export const patchResultSchema = z.object({
  home: z.enum(['inbox', 'canvas', 'library', 'draft']).optional(),
  status: z.enum(['new', 'adopted', 'fav']).optional(),
  title: z.string().max(120).optional(),
  note: z.string().max(2000).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  isNew: z.boolean().optional(),
});

export const saveEditedSchema = z.object({
  sourceId: z.string(),
  title: z.string().max(120),
  tags: z.array(z.string().max(40)).max(10),
  edit: z.object({ css: z.string().max(500).optional(), ops: z.record(z.string(), z.unknown()) }),
  dataUrl: z.string().max(60_000_000).optional(),
});

const canvasItem = z
  .object({
    id: z.string().min(1).max(64),
    kind: z.enum(['media', 'web', 'post', 'file', 'draw', 'node', 'text', 'group']),
    x: z.number(),
    y: z.number(),
  })
  .passthrough();

export const boardSchema = z.object({
  items: z.array(canvasItem).max(5000),
  links: z.array(z.object({ id: z.string(), from: z.string(), to: z.string(), label: z.string().max(24).optional() })).max(10000),
  view: z.object({ x: z.number(), y: z.number(), k: z.number() }),
  anchor: z
    .object({ cvsId: z.string(), params: z.object({ type: mediaType }).passthrough() })
    .nullable()
    .default(null),
});

export const projectSchema = z.object({ name: z.string().min(1).max(40), dot: z.string().max(20).optional() });

export const aestheticSchema = z.object({
  key: z.string().min(1).max(2000),
  kind: z.enum(['image', 'video', 'audio', 'web']),
  src: z.string().min(1).max(20_000_000),
  url: z.string().max(2000).optional(),
  t: z.string().max(120),
  note: z.string().max(500).optional(),
  tags: z.array(z.string().max(40)).max(10).default([]),
  from: z.string().max(60).optional(),
});

export const postSchema = z.object({
  ws: z.string(),
  title: z.string().max(120),
  body: z.string().max(20000),
  items: z.array(z.string()).max(40),
  platform: z.string().max(20),
});

export const orderSchema = z.object({
  packId: z.string().min(1).max(64),
  channel: z.enum(['huifu', 'wechat', 'alipay']),
  /** 幂等键：网络超时重试要复用同一个值；换档位 / 渠道时换新值 */
  idempotencyKey: z.string().min(8).max(100),
});

/* ---------------- Fast-SSO 注册 / 找回 ---------------- */

const identifier = z.string().min(3).max(200);

export const registerStartSchema = z.object({ identifier });

export const registerCompleteSchema = z.object({
  challengeId: z.string().min(1).max(100),
  identifier,
  code: z.string().regex(/^\d{6}$/, '验证码是 6 位数字'),
  password: z.string().min(10).max(128),
  displayName: z.string().max(40).optional(),
  consents: z.object({
    termsVersion: z.string().min(1).max(40),
    privacyVersion: z.string().min(1).max(40),
    marketing: z.boolean(),
  }),
});

export const forgotSchema = z.object({ identifier });

export const resetPasswordSchema = z.object({
  challengeId: z.string().min(1).max(100),
  identifier,
  code: z.string().regex(/^\d{6}$/, '验证码是 6 位数字'),
  newPassword: z.string().min(10).max(128),
});

export const settingsSchema = z.object({
  cloud: z.object({ baseUrl: z.union([z.string().url().max(200), z.literal('')]) }).optional(),
  runner: z.object({ concurrency: z.number().int().min(1).max(8) }).optional(),
  direct: z
    .object({
      enabled: z.boolean().optional(),
      baseUrl: z.string().url().max(200).optional(),
      apiKey: z.string().min(8).max(300).optional(),
      clearKey: z.boolean().optional(),
    })
    .optional(),
  platform: z.object({ chatModel: z.string().max(200).optional() }).optional(),
  prices: z.record(z.string(), z.number().min(0).max(1000).nullable()).optional(),
  runtime: z
    .object({
      mode: z.enum(['desktop', 'web']).optional(),
      host: z.string().max(100).optional(),
      port: z.number().int().min(1024).max(65535).optional(),
      lan: z.boolean().optional(),
      token: z.string().min(6).max(100).optional(),
      clearToken: z.boolean().optional(),
    })
    .optional(),
});

export const optimizeSchema = z.object({ type: mediaType, prompt: z.string().min(1).max(4000) });

export const agentSchema = z.object({
  mainType: mediaType,
  facts: z.array(z.string().max(500)).max(30),
  prompts: z.array(z.string().max(2000)).max(20),
  nodeTexts: z.array(z.string().max(500)).max(30),
  draft: z.string().max(2000),
});

export const keySchema = z.object({ name: z.string().min(1).max(40).optional(), channel: z.enum(['cloud', 'direct']).optional() });
export const keyPatchSchema = z.object({ on: z.boolean().optional(), name: z.string().min(1).max(40).optional() });
