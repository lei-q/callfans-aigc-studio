import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GENERATION_TIMEOUT_MS, HTTP_WAIT_MS, gatewayAgent, gatewayRequest } from '../src/gatewayHttp';

/* 平台生成网关的 HTTP 客户端：走真实的本地 HTTP 服务（不 stub 全局 fetch），确认 JSON 与 multipart 都能正常发出 */

let srv: http.Server;
let base = '';
const seen: { url: string; type: string; auth: string; body: Buffer }[] = [];
beforeAll(async () => {
  srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url || '', type: String(req.headers['content-type'] || ''), auth: String(req.headers.authorization || ''), body: Buffer.concat(chunks) });
      res.writeHead(200, { 'content-type': 'application/json', 'x-litellm-call-id': 'abc' }).end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
});
afterAll(async () => {
  srv.close();
  await gatewayAgent.close();
});

describe('平台网关 HTTP 客户端', () => {
  it('生成超时是 20 分钟，底层 HTTP 等待上限比它多 1 分钟（先触发我们自己的超时）', () => {
    expect(GENERATION_TIMEOUT_MS).toBe(20 * 60_000);
    expect(HTTP_WAIT_MS).toBe(21 * 60_000);
  });

  it('JSON 请求：带上 Authorization 与 body', async () => {
    const res = await gatewayRequest(`${base}/v1/images/generations`, { method: 'POST', headers: { Authorization: 'Bearer sk-x', 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'm', prompt: 'p' }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-litellm-call-id')).toBe('abc');
    expect(await res.json()).toEqual({ ok: true });
    expect(seen.at(-1)).toMatchObject({ url: '/v1/images/generations', auth: 'Bearer sk-x' });
    expect(JSON.parse(seen.at(-1)!.body.toString())).toEqual({ model: 'm', prompt: 'p' });
  });

  it('multipart（参考图编辑走的路径）：字段与文件都能送到', async () => {
    const form = new FormData();
    form.append('model', 'gpt-image-2-c');
    form.append('prompt', '换成红色');
    form.append('image[]', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'reference-1.png');
    const res = await gatewayRequest(`${base}/v1/images/edits`, { method: 'POST', body: form });
    expect(res.status).toBe(200);
    const got = seen.at(-1)!;
    expect(got.type).toMatch(/^multipart\/form-data; boundary=/);
    const text = got.body.toString('latin1');
    expect(text).toContain('name="model"');
    expect(text).toContain('gpt-image-2-c');
    expect(text).toContain('name="image[]"; filename="reference-1.png"');
    expect(text).toContain('Content-Type: image/png');
  });

  it('AbortSignal 仍然有效（用户取消任务）', async () => {
    const slow = http.createServer(() => {});
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
    const port = (slow.address() as { port: number }).port;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await expect(gatewayRequest(`http://127.0.0.1:${port}/x`, { signal: ac.signal })).rejects.toThrow();
    slow.closeAllConnections();
    slow.close();
  });
});
