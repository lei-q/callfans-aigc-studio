/* ============================================================================
   Fast-SSO 账号服务：C 端注册、找回密码、账号配置。
   登录与充值复用 cloud.ts 的会话 / 钱包 / 档位 / 订单类型。
   ========================================================================== */

/** 账号服务提供方：fastsso = 生产账号中心；mock = 仓库内的开发用 Mock 云 */
export type AccountProvider = 'fastsso' | 'mock';

export interface AccountConfig {
  provider: AccountProvider;
  /** OIDC issuer，例如 https://sso.callfansai.com/realms/consumer */
  issuer: string;
  /** identity-api 根，例如 https://account.callfansai.com/api/v1 */
  apiBase: string;
  /** 平台模型网关（LiteLLM）根，例如 https://api.callfansai.com */
  gatewayBase: string;
  /** Keycloak 客户端 ID */
  clientId: string;
  /** 登记过的回环回调，必须逐字符一致 */
  redirectUri: string;
}

/* ---------------- 平台模型清单（api.callfansai.com/models） ---------------- */

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
}

export interface PlatformModelsReply {
  gatewayBase: string;
  models: PlatformModelInfo[];
  /** 用户选定的辅助模型；空串 = 自动 */
  selected: string;
  /** 实际会用的模型（自动选或已选）；null = 清单里没有可用的对话模型 */
  chatModel: string | null;
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
