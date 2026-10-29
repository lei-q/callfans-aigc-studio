import crypto from 'node:crypto';

/* ============================================================================
   Fast-SSO 的 OIDC 客户端：Discovery、授权 URL、PKCE、令牌兑换 / 刷新、
   ID Token 验签（JWKS）。
   不引入第三方库：只支持 consumer Realm 实际会用的 RS256/RS384/RS512。
   ========================================================================== */

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  revocation_endpoint?: string;
}

export interface OidcTokens {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  refresh_expires_in?: number;
  token_type?: string;
  scope?: string;
}

export class OidcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function pkceChallenge(verifier: string) {
  return b64url(crypto.createHash('sha256').update(verifier).digest());
}

interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  n?: string;
  e?: string;
  use?: string;
}

export class OidcClient {
  private discoveryCache: { value: OidcDiscovery; at: number } | null = null;
  private jwksCache: { keys: Jwk[]; at: number } | null = null;
  private refreshing: Promise<OidcDiscovery> | null = null;

  constructor(
    private readonly issuer: string,
    private readonly clientId: string,
  ) {}

  async discovery(force = false): Promise<OidcDiscovery> {
    const now = Date.now();
    if (!force && this.discoveryCache && now - this.discoveryCache.at < 60 * 60_000) return this.discoveryCache.value;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const url = `${this.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) }).catch((e) => {
        throw new OidcError('unreachable', `连不上账号服务（${this.issuer}）：${(e as Error).message}`, 503);
      });
      if (!res.ok) throw new OidcError('discovery_failed', `账号服务返回 HTTP ${res.status}`, 503);
      const d = (await res.json()) as OidcDiscovery;
      if (!d.authorization_endpoint || !d.token_endpoint || !d.jwks_uri) throw new OidcError('discovery_invalid', '账号服务的 Discovery 文档缺字段', 502);
      /* iss 必须与配置一致，否则拿到的令牌后端不会认 */
      if (d.issuer && d.issuer.replace(/\/+$/, '') !== this.issuer.replace(/\/+$/, '')) {
        throw new OidcError('issuer_mismatch', `Discovery 的 issuer（${d.issuer}）与配置（${this.issuer}）不一致`, 502);
      }
      this.discoveryCache = { value: d, at: Date.now() };
      return d;
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /**
   * 授权码 + PKCE 的授权地址。scope 固定 openid profile email；
   * 桌面/移动端必须用系统浏览器打开，不能嵌入 WebView。
   */
  async authorizeUrl(params: { redirectUri: string; state: string; nonce: string; verifier: string; prompt?: string }) {
    const d = await this.discovery();
    const u = new URL(d.authorization_endpoint);
    u.searchParams.set('client_id', this.clientId);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', 'openid profile email');
    u.searchParams.set('redirect_uri', params.redirectUri);
    u.searchParams.set('state', params.state);
    u.searchParams.set('nonce', params.nonce);
    u.searchParams.set('code_challenge', pkceChallenge(params.verifier));
    u.searchParams.set('code_challenge_method', 'S256');
    if (params.prompt) u.searchParams.set('prompt', params.prompt);
    return u.toString();
  }

  async exchangeCode(params: { code: string; verifier: string; redirectUri: string }): Promise<OidcTokens> {
    const d = await this.discovery();
    return this.tokenRequest(d.token_endpoint, {
      grant_type: 'authorization_code',
      client_id: this.clientId,
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.verifier,
    });
  }

  async refresh(refreshToken: string): Promise<OidcTokens> {
    const d = await this.discovery();
    return this.tokenRequest(d.token_endpoint, {
      grant_type: 'refresh_token',
      client_id: this.clientId,
      refresh_token: refreshToken,
    });
  }

  /** 撤销 refresh token；access token 靠自然过期 */
  async revoke(token: string, hint: 'refresh_token' | 'access_token' = 'refresh_token') {
    try {
      const d = await this.discovery();
      const endpoint = d.revocation_endpoint;
      if (!endpoint) return;
      const body = new URLSearchParams({ client_id: this.clientId, token, token_type_hint: hint });
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      /* 撤销是尽力而为 */
    }
  }

  private async tokenRequest(endpoint: string, fields: Record<string, string>): Promise<OidcTokens> {
    const body = new URLSearchParams(fields);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    }).catch((e) => {
      throw new OidcError('unreachable', `连不上账号服务：${(e as Error).message}`, 503);
    });
    const text = await res.text();
    let data: (OidcTokens & { error?: string; error_description?: string }) | null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok || !data?.access_token) {
      throw new OidcError(data?.error || `token_http_${res.status}`, data?.error_description || data?.error || `令牌端点返回 HTTP ${res.status}`, res.status);
    }
    return data;
  }

  /**
   * 校验 ID Token：签名（JWKS）、iss、aud/azp、exp/nbf、nonce。
   * 返回 claims；不依赖 UserInfo。
   */
  async verifyIdToken(idToken: string, expected: { nonce?: string } = {}): Promise<Record<string, unknown>> {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new OidcError('invalid_id_token', 'ID Token 格式不正确', 401);
    const [h, p, s] = parts as [string, string, string];
    let header: { alg?: string; kid?: string };
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    } catch {
      throw new OidcError('invalid_id_token', 'ID Token 无法解析', 401);
    }
    const alg = header.alg || '';
    if (!['RS256', 'RS384', 'RS512'].includes(alg)) throw new OidcError('invalid_id_token', `不支持的 ID Token 签名算法：${alg}`, 401);
    const key = await this.publicKey(header.kid);
    const ok = crypto.verify(alg === 'RS256' ? 'RSA-SHA256' : alg === 'RS384' ? 'RSA-SHA384' : 'RSA-SHA512', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
    if (!ok) throw new OidcError('invalid_id_token', 'ID Token 签名校验失败', 401);

    const now = Math.floor(Date.now() / 1000);
    const skew = 60;
    if (claims.iss !== this.issuer) throw new OidcError('invalid_id_token', 'ID Token 的 issuer 不匹配', 401);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.clientId)) throw new OidcError('invalid_id_token', 'ID Token 的 aud 不包含本应用', 401);
    if (claims.azp && claims.azp !== this.clientId) throw new OidcError('invalid_id_token', 'ID Token 的 azp 不匹配', 401);
    if (typeof claims.exp !== 'number' || claims.exp < now - skew) throw new OidcError('invalid_id_token', 'ID Token 已过期', 401);
    if (typeof claims.nbf === 'number' && claims.nbf > now + skew) throw new OidcError('invalid_id_token', 'ID Token 还未生效', 401);
    if (expected.nonce && claims.nonce !== expected.nonce) throw new OidcError('invalid_id_token', 'ID Token 的 nonce 不匹配', 401);
    return claims;
  }

  private async publicKey(kid?: string): Promise<crypto.KeyObject> {
    const d = await this.discovery();
    const now = Date.now();
    let keys = this.jwksCache && now - this.jwksCache.at < 60 * 60_000 ? this.jwksCache.keys : null;
    if (!keys) {
      keys = await this.fetchJwks(d.jwks_uri);
      this.jwksCache = { keys, at: now };
    }
    let jwk = kid ? keys.find((k) => k.kid === kid) : keys[0];
    if (!jwk) {
      /* kid 轮换了：强制拉一次 */
      keys = await this.fetchJwks(d.jwks_uri);
      this.jwksCache = { keys: keys, at: Date.now() };
      jwk = kid ? keys.find((k) => k.kid === kid) : keys[0];
    }
    if (!jwk) throw new OidcError('invalid_id_token', 'JWKS 里找不到对应的签名密钥', 401);
    try {
      return crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: 'jwk' });
    } catch {
      throw new OidcError('invalid_id_token', '签名密钥无法解析', 401);
    }
  }

  private async fetchJwks(uri: string): Promise<Jwk[]> {
    const res = await fetch(uri, { signal: AbortSignal.timeout(10_000) }).catch((e) => {
      throw new OidcError('jwks_unreachable', `拉取 JWKS 失败：${(e as Error).message}`, 503);
    });
    if (!res.ok) throw new OidcError('jwks_unreachable', `JWKS 返回 HTTP ${res.status}`, 503);
    const body = (await res.json()) as { keys?: Jwk[] };
    return (body.keys || []).filter((k) => k.kty === 'RSA');
  }
}
