import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/* MCP stdio 服务：起一个假的创作台 OpenAPI，真的 spawn index.mjs 走一遍协议 */

const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.mjs');
let srv: http.Server;
let base = '';
const seen: { method: string; url: string; auth: string; body: string }[] = [];
let polls = 0;

beforeAll(async () => {
  srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method || '', url: req.url || '', auth: String(req.headers.authorization || ''), body });
      const send = (code: number, j: unknown) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(j));
      if (req.headers.authorization !== 'Bearer sk-local-test') return send(401, { error: 'API Key 无效' });
      if (req.url === '/openapi/v1/models') return send(200, { object: 'list', data: [{ id: 'cloud:img-x', type: 'image' }, { id: 'cloud:vid-x', type: 'video' }] });
      if (req.url?.startsWith('/openapi/v1/canvas/context')) return send(200, { project: 'w1', summary: '项目：2 个元素', items: [], links: [] });
      if (req.method === 'POST' && req.url === '/openapi/v1/jobs') return send(200, { id: 'j1', status: 'queued', results: [] });
      if (req.url === '/openapi/v1/jobs/j1') {
        polls += 1;
        return send(200, polls < 2 ? { id: 'j1', status: 'running', results: [] } : { id: 'j1', status: 'succeeded', results: [{ id: 'r1', type: 'image', url: 'http://x/a.png' }] });
      }
      return send(404, { error: '不存在' });
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
});
afterAll(() => srv.close());

function session(env: Record<string, string>) {
  const p = spawn(process.execPath, [entry], { env: { ...process.env, AIGC_BASE_URL: base, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map<number, (m: Record<string, any>) => void>();
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const m = JSON.parse(line);
      waiting.get(m.id)?.(m);
    }
  });
  let n = 0;
  return {
    call: (method: string, params?: unknown) =>
      new Promise<Record<string, any>>((resolve) => {
        const id = ++n;
        waiting.set(id, resolve);
        p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      }),
    notify: (method: string) => p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`),
    close: () => p.kill(),
  };
}

describe('MCP stdio 服务', () => {
  it('握手 + 工具清单：五个工具齐全', async () => {
    const s = session({ AIGC_API_KEY: 'sk-local-test' });
    const init = await s.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(init.result.serverInfo.name).toBe('aigc-studio');
    expect(init.result.capabilities.tools).toBeDefined();
    s.notify('notifications/initialized');
    const list = await s.call('tools/list');
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(['list_models', 'generate_image', 'generate_video', 'get_canvas_context', 'get_job']);
    s.close();
  });

  it('get_canvas_context / list_models 带 Bearer Key 调用本机 OpenAPI', async () => {
    const s = session({ AIGC_API_KEY: 'sk-local-test', AIGC_PROJECT_ID: 'w1' });
    const ctx = await s.call('tools/call', { name: 'get_canvas_context', arguments: {} });
    expect(JSON.parse(ctx.result.content[0].text).summary).toContain('2 个元素');
    expect(seen.at(-1)).toMatchObject({ url: '/openapi/v1/canvas/context?project=w1', auth: 'Bearer sk-local-test' });
    const models = await s.call('tools/call', { name: 'list_models', arguments: {} });
    expect(JSON.parse(models.result.content[0].text).data).toHaveLength(2);
    s.close();
  });

  it('generate_image：提交任务后轮询到完成，带回结果地址；默认模型取清单第一个图像模型', async () => {
    polls = 0;
    const s = session({ AIGC_API_KEY: 'sk-local-test' });
    const r = await s.call('tools/call', { name: 'generate_image', arguments: { prompt: '一杯咖啡', ratio: '4:5', wait_seconds: 30 } });
    const out = JSON.parse(r.result.content[0].text);
    expect(out.status).toBe('succeeded');
    expect(out.results[0].url).toBe('http://x/a.png');
    const post = seen.filter((x) => x.method === 'POST' && x.url === '/openapi/v1/jobs').at(-1)!;
    expect(JSON.parse(post.body)).toMatchObject({ type: 'image', model: 'cloud:img-x', prompt: '一杯咖啡', ratio: '4:5', count: 1 });
    s.close();
  }, 20_000);

  it('出错时返回 isError 和原因（Key 无效 / 没配 Key / 未知工具）', async () => {
    const bad = session({ AIGC_API_KEY: 'sk-local-wrong' });
    const r1 = await bad.call('tools/call', { name: 'get_job', arguments: { id: 'j1' } });
    expect(r1.result.isError).toBe(true);
    expect(r1.result.content[0].text).toContain('API Key 无效');
    const unknown = await bad.call('tools/call', { name: 'nope', arguments: {} });
    expect(unknown.error.code).toBe(-32602);
    bad.close();
    const none = session({ AIGC_API_KEY: '' });
    const r2 = await none.call('tools/call', { name: 'list_models', arguments: {} });
    expect(r2.result.content[0].text).toContain('AIGC_API_KEY');
    none.close();
  });
});
