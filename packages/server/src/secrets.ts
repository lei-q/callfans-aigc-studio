import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/* 本机密钥：用来加密保存在库里的 TreeCloud API Key。文件权限 0600，只有当前用户能读 */
export class Secrets {
  private key: Buffer;

  constructor(dataDir: string) {
    const file = path.join(dataDir, 'secret.key');
    if (fs.existsSync(file)) {
      this.key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
    } else {
      this.key = crypto.randomBytes(32);
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, this.key.toString('hex'), { mode: 0o600 });
    }
  }

  encrypt(plain: string) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `${iv.toString('hex')}.${c.getAuthTag().toString('hex')}.${enc.toString('hex')}`;
  }

  decrypt(blob: string | null | undefined): string | null {
    if (!blob) return null;
    try {
      const [iv, tag, enc] = blob.split('.');
      const d = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'hex'));
      d.setAuthTag(Buffer.from(tag, 'hex'));
      return Buffer.concat([d.update(Buffer.from(enc, 'hex')), d.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  encryptCloudTokens(t: { accessToken: string; refreshToken: string; expiresAt: number }) {
    return this.encrypt(JSON.stringify(t));
  }

  decryptCloudTokens(blob: string | null): { accessToken: string; refreshToken: string; expiresAt: number } | null {
    const raw = this.decrypt(blob);
    if (!raw) return null;
    try {
      const t = JSON.parse(raw) as { accessToken?: string; refreshToken?: string; expiresAt?: number };
      return t.accessToken && t.refreshToken ? { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt || 0 } : null;
    } catch {
      return null;
    }
  }
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
