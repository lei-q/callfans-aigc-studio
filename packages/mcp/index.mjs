#!/usr/bin/env node
/* AIGC 创作台 MCP stdio 服务（零依赖）。
   外部 Agent（Claude Desktop / Claude Code / Cursor…）通过它读画布、列模型、提交生成任务。
   协议：MCP over stdio（每行一条 JSON-RPC 消息）。鉴权用创作台「API 接入」页创建的 sk-local- Key。

   环境变量：
     AIGC_BASE_URL     本机服务地址，默认 http://127.0.0.1:5780
     AIGC_API_KEY      必填，sk-local-…
     AIGC_PROJECT_ID   默认项目（不填用最早建的那个）
     AIGC_IMAGE_MODEL  默认图像模型（不填取模型列表里第一个可用的）
     AIGC_VIDEO_MODEL  默认视频模型
*/
import readline from 'node:readline';

const BASE = (process.env.AIGC_BASE_URL || 'http://127.0.0.1:5780').replace(/\/+$/, '');
const KEY = process.env.AIGC_API_KEY || '';
const PROJECT = process.env.AIGC_PROJECT_ID || '';
const VERSION = '0.2.0';

class ToolError extends Error {}

async function api(path, init = {}) {
  if (!KEY) throw new ToolError('没有配置 AIGC_API_KEY：到创作台「API 接入」页创建 Key，并下载 mcp.json / .env');
  let res;
  try {
    res = await fetch(BASE + path, {
      ...init,
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new ToolError(`连不上创作台（${BASE}）：${e.message}。确认创作台正在运行，并且 AIGC_BASE_URL 正确`);
  }
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg = (body && (body.error || body.message)) || `HTTP ${res.status}`;
    throw new ToolError(`${msg}${body?.detail ? `（${body.detail}）` : ''}`);
  }
  return body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = (s) => s === 'succeeded' || s === 'failed' || s === 'canceled';

async function pickModel(type, envModel, requested) {
  if (requested) return requested;
  if (envModel) return envModel;
  const list = await api('/openapi/v1/models');
  const m = (list.data || []).find((x) => x.type === type);
  if (!m) throw new ToolError(`没有可用的${type === 'image' ? '图像' : '视频'}模型：确认创作台已登录账号`);
  return m.id;
}

/** 提交任务并轮询：时限内完成就带回结果地址，没完成就带回 job id 让 Agent 稍后用 get_job 查 */
async function runJob(body, waitSeconds) {
  const job = await api('/openapi/v1/jobs', { method: 'POST', body: JSON.stringify(body) });
  const deadline = Date.now() + waitSeconds * 1000;
  let cur = job;
  while (!done(cur.status) && Date.now() < deadline) {
    await sleep(2000);
    cur = await api(`/openapi/v1/jobs/${encodeURIComponent(job.id)}`);
  }
  return { ...cur, waited: done(cur.status), note: done(cur.status) ? undefined : '还在生成，稍后用 get_job 查询结果；生成按平台实际用量计费，不要重复提交' };
}

const refsSchema = {
  type: 'array',
  description: '参考图（最多 4 张）：src 是图片地址（本机 /files/… 或 http(s) 地址），w 是 0–1 的参考强度',
  items: { type: 'object', properties: { src: { type: 'string' }, w: { type: 'number' } }, required: ['src'] },
};

const TOOLS = [
  {
    name: 'list_models',
    description: '列出当前账号可用的生成模型（id、类型、价格）。生成前先看一眼。',
    inputSchema: { type: 'object', properties: {} },
    run: async () => api('/openapi/v1/models'),
  },
  {
    name: 'generate_image',
    description: '生成图片。会等待结果最多 wait_seconds 秒；超时返回 job id，用 get_job 继续查。会消耗点数。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '中文提示词，写清主体、场景、光线、构图' },
        count: { type: 'integer', minimum: 1, maximum: 8, description: '张数，默认 1' },
        ratio: { type: 'string', description: '画幅，如 1:1 / 4:5 / 16:9 / 9:16' },
        res: { type: 'string', enum: ['1080p', '2k', '4k'] },
        model: { type: 'string', description: '模型 id，不填用 AIGC_IMAGE_MODEL 或第一个可用图像模型' },
        project: { type: 'string', description: '项目 id，不填用 AIGC_PROJECT_ID 或最早的项目' },
        refs: refsSchema,
        wait_seconds: { type: 'integer', description: '最多等多少秒，默认 120' },
      },
      required: ['prompt'],
    },
    run: async (a) => {
      const model = await pickModel('image', process.env.AIGC_IMAGE_MODEL, a.model);
      return runJob(
        { type: 'image', model, prompt: a.prompt, count: a.count || 1, ratio: a.ratio || '1:1', res: a.res || '2k', refs: a.refs || [], ...(a.project || PROJECT ? { ws: a.project || PROJECT } : {}) },
        a.wait_seconds || 120,
      );
    },
  },
  {
    name: 'generate_video',
    description: '生成视频。视频按秒计费且失败不退，请确认提示词后再调用。会等待结果最多 wait_seconds 秒；超时返回 job id，用 get_job 继续查。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        dur: { type: 'integer', minimum: 1, description: '时长（秒），默认 5' },
        ratio: { type: 'string', description: '画幅，如 9:16 / 16:9' },
        model: { type: 'string' },
        project: { type: 'string' },
        refs: refsSchema,
        wait_seconds: { type: 'integer', description: '最多等多少秒，默认 240' },
      },
      required: ['prompt'],
    },
    run: async (a) => {
      const model = await pickModel('video', process.env.AIGC_VIDEO_MODEL, a.model);
      return runJob(
        { type: 'video', model, prompt: a.prompt, dur: a.dur || 5, ratio: a.ratio || '16:9', refs: a.refs || [], ...(a.project || PROJECT ? { ws: a.project || PROJECT } : {}) },
        a.wait_seconds || 240,
      );
    },
  },
  {
    name: 'get_canvas_context',
    description: '读取一个项目画布的上下文：元素（类型、标题、提示词、模型、坐标）、分组、连线。用来理解用户在画布上摆了什么。src 是本机地址。',
    inputSchema: { type: 'object', properties: { project: { type: 'string', description: '项目 id，不填用 AIGC_PROJECT_ID 或最早的项目' } } },
    run: async (a) => api(`/openapi/v1/canvas/context${a.project || PROJECT ? `?project=${encodeURIComponent(a.project || PROJECT)}` : ''}`),
  },
  {
    name: 'get_job',
    description: '查询一个生成任务的状态和结果地址。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: async (a) => api(`/openapi/v1/jobs/${encodeURIComponent(a.id)}`),
  },
];

/* ---------------- JSON-RPC over stdio ---------------- */

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return;
  if (method === 'initialize') {
    return reply(id, { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'aigc-studio', version: VERSION } });
  }
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') {
    return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return fail(id, -32602, `没有这个工具：${params?.name}`);
    try {
      const out = await tool.run(params.arguments || {});
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
    } catch (e) {
      /* 工具自己的失败要让模型看到原因，而不是协议错误 */
      return reply(id, { isError: true, content: [{ type: 'text', text: e instanceof ToolError ? e.message : `出错了：${e.message}` }] });
    }
  }
  if (id !== undefined) fail(id, -32601, `不支持的方法：${method}`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return fail(null, -32700, '不是合法的 JSON');
  }
  handle(msg).catch((e) => msg.id !== undefined && fail(msg.id, -32603, e.message));
});
rl.on('close', () => process.exit(0));
