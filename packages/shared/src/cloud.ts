import type { AudioUse, MediaType, ResKey } from './types';

/* ============================================================================
   云端 API 合同：客户端、开发用 Mock 云、以及未来的真实云端共用这一份定义。
   完整说明见 docs/cloud-api-contract.md。
   约定：
   - 所有请求带 Authorization: Bearer <access_token>（登录 / 设备码端点除外）
   - 错误响应统一 { code, message, requestId? }，code 见 CloudErrorCode
   - 金额单位：人民币元（number，两位小数）；点数单位：点（1 点 = ¥1）
   ========================================================================== */

export const CLOUD_ERROR = {
  TOKEN_INVALID: 40101,
  BALANCE_NOT_ENOUGH: 40201,
  NOT_LOGGED_IN: 40301,
  NOT_FOUND: 40401,
  RATE_LIMITED: 42901,
  INTERNAL: 50001,
  UPSTREAM_FAILED: 50201,
} as const;
export type CloudErrorCode = (typeof CLOUD_ERROR)[keyof typeof CLOUD_ERROR];

export interface CloudErrorBody {
  code: number;
  message: string;
  requestId?: string;
}

/* ---------------- 服务元信息 ---------------- */

export interface CloudMeta {
  ok: true;
  name: string;
  version: string;
  payChannels: PayChannel[];
  loginMethods: string[];
}

/* ---------------- 认证：设备码流程（桌面与 Web 通用） ---------------- */

export interface DeviceStartBody {
  client: 'desktop' | 'web';
  deviceName?: string;
}
export interface DeviceStartReply {
  deviceCode: string;
  /** 用户在浏览器里打开完成登录 */
  loginUrl: string;
  /** 给客户端画二维码的内容（通常等于 loginUrl） */
  qrContent: string;
  expiresIn: number;
  interval: number;
}
export type DevicePollStatus = 'pending' | 'approved' | 'expired' | 'denied';
export interface DevicePollReply {
  status: DevicePollStatus;
  tokens?: CloudTokens;
  profile?: UserProfile;
}
export interface CloudTokens {
  accessToken: string;
  refreshToken: string;
  /** Unix 秒 */
  expiresAt: number;
}
export interface UserProfile {
  id: string;
  nickname: string;
  /** 掩码手机号，如 138****8000 */
  phoneMasked?: string;
  avatarUrl?: string;
  createdAt: number;
  tier?: string;
}

/* ---------------- 计费：钱包、档位、订单 ---------------- */

export interface WalletDto {
  balance: number;
  /** 今日剩余免费点数 */
  freeToday: number;
  updatedAt: number;
}

export type PayChannel = 'wechat' | 'alipay';

export interface PackDto {
  id: string;
  name: string;
  amountCny: number;
  points: number;
  /** 促销赠送点数（如首充翻倍） */
  bonusPoints?: number;
  tag?: string;
  note?: string;
  promo?: string;
}

export type OrderStatus = 'created' | 'paying' | 'paid' | 'closed' | 'refunded';
export interface OrderDto {
  id: string;
  packId: string;
  packName: string;
  channel: PayChannel;
  amountCny: number;
  points: number;
  status: OrderStatus;
  /** 扫码支付内容（微信 code_url / 支付宝 qr 串）；客户端本地渲染二维码 */
  qrContent?: string;
  /** 收银台页面（电脑网站支付 / 模拟支付） */
  cashierUrl?: string;
  createdAt: number;
  expireAt: number;
  paidAt?: number;
  channelTradeNo?: string;
}

/* ---------------- 网关：模型目录、生成任务、对话 ---------------- */

export interface GatewayModel {
  id: string;
  name: string;
  type: MediaType;
  /** 点数单价与计价单位，用于客户端预估 */
  price: number;
  basis: string;
  maxRes?: ResKey;
  durs?: number[];
  uses?: AudioUse[];
  caps: string[];
  limit: string;
  note: string;
}

export interface GatewayRef {
  /** 参考图 data URL（本地文件没有公网地址） */
  dataUrl: string;
  weight?: number;
}

export interface GatewayJobBody {
  type: MediaType;
  model: string;
  prompt: string;
  negative?: string;
  ratio?: string;
  count?: number;
  res?: ResKey;
  dur?: number;
  cam?: string;
  vres?: string;
  use?: AudioUse;
  voice?: string;
  mood?: string;
  lang?: string;
  seed?: number;
  fps?: number;
  loop?: boolean;
  firstFrame?: boolean;
  refs?: GatewayRef[];
  /** 客户端任务 ID，用于日志关联 */
  clientJobId?: string;
}

export interface GatewayResult {
  url: string;
  mime: string;
  thumbUrl?: string;
  seed?: number;
  dur?: number;
}

export type GatewayJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
export interface GatewayJob {
  id: string;
  status: GatewayJobStatus;
  progress?: number;
  /** 创建时冻结 / 结算的点数 */
  cost: number;
  balanceAfter?: number;
  fail?: { code: string; reason: string; fix: string };
  results?: GatewayResult[];
  createdAt: number;
  finishedAt?: number;
  requestId?: string;
}

export interface GatewayChatBody {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  /** 不填由云端选择 */
  model?: string;
}
export interface GatewayChatReply {
  text: string;
  model?: string;
  usage?: { input: number; output: number };
}

/* ---------------- 用量 ---------------- */

export interface UsageSummary {
  from: number;
  to: number;
  requests: number;
  points: number;
  byModel: { model: string; type: MediaType; requests: number; points: number }[];
  byDay: { day: string; points: number }[];
}
export interface UsageRequest {
  id: string;
  at: number;
  model: string;
  type: MediaType;
  status: 'succeeded' | 'failed' | 'canceled';
  points: number;
  tokens?: { input?: number; output?: number; cache?: number; image?: number };
  videoSeconds?: number;
  ttsChars?: number;
  requestId: string;
}

/* ---------------- 事件（SSE） ---------------- */

export type CloudEvent =
  | { type: 'wallet.updated'; wallet: WalletDto }
  | { type: 'order.updated'; order: OrderDto }
  | { type: 'job.updated'; job: GatewayJob };
