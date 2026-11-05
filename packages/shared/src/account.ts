/* ============================================================================
   Fast-SSO 账号服务：C 端注册、找回密码、账号配置。
   登录与充值复用 cloud.ts 的会话 / 钱包 / 档位 / 订单类型。
   ========================================================================== */

/** 账号服务提供方：fastsso = 生产账号中心；mock = 仓库内的开发用 Mock 云 */
export type AccountProvider = 'fastsso' | 'mock';

/**
 * 登录入口：
 * - consumer：个人账号（手机 / 邮箱），消费走个人积分；
 * - enterprise：企业员工账号，登录到租户，用量记在租户账户上。
 * 两种入口签发的是同一个应用客户端的令牌，差别在 Realm。
 */
export type AccountMode = 'consumer' | 'enterprise';

export interface AccountConfig {
  provider: AccountProvider;
  /** OIDC issuer，例如 https://sso.callfansai.com/realms/consumer */
  issuer: string;
  /**
   * 企业员工入口的 OIDC issuer，例如 .../realms/business。
   * 留空时由 consumer issuer 按 Realm 名替换推断。
   */
  enterpriseIssuer?: string;
  /** identity-api 根，例如 https://account.callfansai.com/api/v1 */
  apiBase: string;
  /** 平台模型网关（LiteLLM）根，例如 https://api.callfansai.com */
  gatewayBase: string;
  /** Keycloak 客户端 ID（两个 Realm 用同一个 clientId） */
  clientId: string;
  /** 企业 Realm 里的客户端 ID；留空沿用 clientId */
  enterpriseClientId?: string;
  /** 登记过的回环回调，必须逐字符一致 */
  redirectUri: string;
}

/** consumer issuer → business issuer（同域名，仅替换 Realm） */
export function enterpriseIssuerOf(config: AccountConfig): string {
  const explicit = config.enterpriseIssuer?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const issuer = config.issuer.replace(/\/+$/, '');
  const match = issuer.match(/^(.*)\/realms\/[^/]+$/);
  return match ? `${match[1]}/realms/business` : '';
}

export function enterpriseClientIdOf(config: AccountConfig): string {
  return config.enterpriseClientId?.trim() || config.clientId;
}

/* ---------------- 平台模型清单（api.callfansai.com/models） ---------------- */

/** 平台清单的 mode → 界面里的类型；平台用的是 image_generation / video_generation 这类写法 */
export function platformModeType(mode?: string): 'chat' | 'image' | 'video' | 'audio' | null {
  const m = (mode || '').toLowerCase();
  if (m === 'chat' || m === 'text' || m === 'llm') return 'chat';
  if (m.startsWith('image')) return 'image';
  if (m.startsWith('video')) return 'video';
  if (m.startsWith('audio') || m === 'tts' || m === 'speech') return 'audio';
  return null;
}

export interface PlatformModelInfo {
  id: string;
  /** openai = /v1/chat/completions；anthropic = /v1/messages */
  protocol?: string;
  mode?: string;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  /** 上游标价（USD / 百万 tokens，折扣前）；null = 该路由没配价 */
  inputPerMillion?: number | null;
  outputPerMillion?: number | null;
  /** 图像生成：每张多少美元；视频生成：按秒计价（可有分辨率档位） */
  perImage?: number | null;
  perVideoSecond?: number | null;
  perVideoSecondByResolution?: Record<string, number> | null;
}

export interface PlatformModelsReply {
  gatewayBase: string;
  /** 清单里的全部模型；按 mode 分组（chat / image / video / audio） */
  models: PlatformModelInfo[];
  at: number;
}

/* ---------------- 注册 / 找回 ---------------- */

export interface AccountDocuments {
  termsVersion: string;
  privacyVersion: string;
}

export interface RegisterStartReply {
  challengeId: string;
  channel: 'phone' | 'email';
  /** 掩码后的手机号 / 邮箱，可直接展示 */
  maskedIdentifier: string;
  /** ISO 时间 */
  expiresAt: string;
  resendAfterSeconds: number;
}

export interface RegisterCompleteBody {
  challengeId: string;
  identifier: string;
  code: string;
  password: string;
  displayName?: string;
  consents: {
    termsVersion: string;
    privacyVersion: string;
    marketing: boolean;
  };
}

export interface RegisterCompleteReply {
  userId: string;
  username: string;
  channel: 'phone' | 'email';
  createdAt: string;
}

export interface ForgotReply {
  challengeId: string;
  expiresAt: string;
  resendAfterSeconds: number;
}

export interface ResetPasswordBody {
  challengeId: string;
  identifier: string;
  code: string;
  newPassword: string;
}
