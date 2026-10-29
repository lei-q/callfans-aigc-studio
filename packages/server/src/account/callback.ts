import http from 'node:http';

/* ============================================================================
   登录回环回调：只在登录进行中监听 127.0.0.1:<port>，拿到 code 后立刻关闭。
   回调地址必须与 Fast-SSO 登记的 redirectUris 逐字符一致。
   ========================================================================== */

export interface CallbackResult {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
}

export interface CallbackReply {
  status: number;
  html: string;
}

export interface CallbackHandle {
  close(): Promise<void>;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export async function startCallbackServer(
  redirectUri: string,
  onResult: (r: CallbackResult) => Promise<CallbackReply>,
): Promise<CallbackHandle> {
  const u = new URL(redirectUri);
  if (u.protocol !== 'http:' || !LOOPBACK.has(u.hostname)) {
    throw new Error('登录回调必须是 http://127.0.0.1:端口/路径 形式的回环地址');
  }
  const port = Number(u.port || 80);

  let closed = false;
  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' }).end();
      return;
    }
    if (reqUrl.pathname !== u.pathname) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    const q = reqUrl.searchParams;
    void onResult({
      code: q.get('code') || undefined,
      state: q.get('state') || undefined,
      error: q.get('error') || undefined,
      errorDescription: q.get('error_description') || undefined,
    })
      .then((r) => {
        res.writeHead(r.status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(r.html);
      })
      .catch(() => {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('登录处理失败');
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') reject(new Error(`登录回调端口 ${port} 被占用：可能已有一次登录在进行，请稍后再试`));
      else reject(e);
    });
    server.listen(port, u.hostname === '[::1]' ? '::1' : u.hostname, () => resolve());
  });

  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      /* 没有连接时 close 立即回调；有 keep-alive 连接时也不能拖住 */
      setTimeout(resolve, 1000).unref?.();
    });
  };
  return { close };
}

export function callbackPage(opts: { ok: boolean; title: string; message: string }) {
  const color = opts.ok ? '#1f9d55' : '#d64545';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(opts.title)} · AIGC 创作台</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f7f5;color:#1e1e22;font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
  .card{background:#fff;border:1px solid #e7e7e3;border-radius:16px;padding:40px 44px;max-width:420px;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.06)}
  .dot{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;margin:0 auto 16px;background:${opts.ok ? '#e8f5ee' : '#fdecec'};color:${color};font-size:22px}
  h1{font-size:19px;margin:0 0 8px}
  p{margin:0;color:#6b6b73;font-size:14px}
</style></head><body><div class="card"><div class="dot">${opts.ok ? '✓' : '!'}</div><h1>${escapeHtml(opts.title)}</h1><p>${escapeHtml(opts.message)}</p></div></body></html>`;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}
