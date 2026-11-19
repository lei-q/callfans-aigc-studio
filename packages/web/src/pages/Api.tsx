import { useEffect, useState } from 'react';
import type { ApiKey } from '@aigc/shared';
import { DangerButton, Icon } from '../components/common';
import { api } from '../lib/api';
import { copyText, downloadText } from '../lib/util';
import { useStore } from '../store';
import { toast, toastError } from '../store/toast';
import { timeLabel } from '@aigc/shared';

/* ============================================================================
   API 接入：本机 OpenAPI 的 Key 管理 + 给外部 Agent（Claude / Cursor…）的一键配置。
   完整 Key 只在创建时返回一次，所以 mcp.json / .env 里的 Key 只有刚创建时才是真值，
   之后下载的配置里是占位符，由用户自己粘贴。
   ========================================================================== */

export function ApiPage() {
  const s = useStore();
  const keys = s.apiKeys;
  const [fresh, setFresh] = useState<{ id: string; secret: string } | null>(null);
  const [mcpPath, setMcpPath] = useState<string | null | undefined>(undefined);
  const [pick, setPick] = useState('');
  const origin = window.location.origin;

  useEffect(() => {
    api
      .get<{ path: string | null }>('/api/mcp/info')
      .then((r) => setMcpPath(r.path))
      .catch(() => setMcpPath(null));
  }, []);

  const create = async () => {
    try {
      const r = await api.post<{ key: ApiKey; secret: string }>('/api/keys', {});
      setFresh({ id: r.key.id, secret: r.secret });
      setPick(r.key.id);
      toast('success', 'Key 已创建', '完整 Key 只显示这一次，马上复制或下载配置');
    } catch (e) {
      toastError(e, '创建 Key 失败');
    }
  };
  const patch = (id: string, body: Partial<Pick<ApiKey, 'on' | 'name'>>) => void api.patch(`/api/keys/${id}`, body).catch((e) => toastError(e));
  const remove = (id: string) => {
    void api.del(`/api/keys/${id}`).catch((e) => toastError(e));
    if (fresh?.id === id) setFresh(null);
  };

  const chosen = keys.find((k) => k.id === pick) || keys.find((k) => k.on);
  const secret = chosen && fresh && fresh.id === chosen.id ? fresh.secret : '<创建 Key 时显示的完整 Key>';
  const models = s.settings?.models.cloud;
  const env = {
    AIGC_BASE_URL: origin,
    AIGC_API_KEY: secret,
    AIGC_PROJECT_ID: s.ws,
    AIGC_IMAGE_MODEL: models?.image || '',
    AIGC_VIDEO_MODEL: models?.video || '',
  };
  const mcpJson = JSON.stringify(
    { mcpServers: { 'aigc-studio': { command: 'node', args: [mcpPath || '<aigc-studio 的 packages/mcp/index.mjs 绝对路径>'], env } } },
    null,
    2,
  );
  const dotenv = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const desktop = !!window.aigcDesktop;
  const curl = `curl ${origin}/openapi/v1/canvas/context \\\n  -H "Authorization: Bearer ${secret}"`;

  return (
    <div className="page">
      <div className="toolbar">
        <div className="page-title-block">
          <span className="page-title">API 接入</span>
          <span className="page-sub">让外部 Agent 读画布、调模型；和网页共用同一份点数，失败不扣费</span>
        </div>
        <span className="grow" />
        <button className="btn primary" onClick={() => void create()}>
          <Icon name="plus" />
          创建 Key
        </button>
      </div>

      {fresh && (
        <div className="alert-bar" style={{ margin: '0 0 14px' }}>
          <Icon name="shield" />
          <span>
            <b>新 Key（只显示这一次）</b>
            <br />
            <span className="num">{fresh.secret}</span>
          </span>
          <span className="right">
            <button className="btn sm ghost" onClick={() => copyText(fresh.secret) && toast('success', '已复制 Key')}>
              <Icon name="copy" />
              复制
            </button>
          </span>
        </div>
      )}

      <div className="catalog-sec">
        <div className="catalog-sec-name">我的 Key</div>
        <div className="card table-card">
          <div className="key-head">
            <span>名称</span>
            <span>Key</span>
            <span>创建</span>
            <span>最近使用</span>
            <span className="th-right">操作</span>
          </div>
          {keys.length ? (
            keys.map((k) => (
              <div key={k.id} className={`key-row ${k.on ? '' : 'off'}`}>
                <span className="kr-name">{k.name}</span>
                <span className="kr-key">{k.masked}</span>
                <span className="tiny dim">{timeLabel(k.createdAt)}</span>
                <span className="tiny dim">{k.lastUsedAt ? timeLabel(k.lastUsedAt) : '从未'}</span>
                <span className="row-actions">
                  <button className="btn sm ghost" onClick={() => patch(k.id, { on: !k.on })}>
                    {k.on ? '停用' : '启用'}
                  </button>
                  <DangerButton className="btn sm danger-ghost" label="删除" confirmLabel="再点一次" onConfirm={() => remove(k.id)} />
                </span>
              </div>
            ))
          ) : (
            <div className="key-row">
              <span className="tiny dim">还没有 Key。点右上角「创建 Key」。</span>
            </div>
          )}
        </div>
      </div>

      <div className="catalog-sec">
        <div className="catalog-sec-name">一键配置（MCP）</div>
        <div className="card set-card">
          <div className="set-actions">
            <select className="form-select" value={chosen?.id || ''} onChange={(e) => setPick(e.target.value)} disabled={!keys.length}>
              {keys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name} · {k.masked}
                </option>
              ))}
            </select>
            <button className="btn ghost" disabled={!chosen} onClick={() => downloadText('mcp.json', mcpJson, 'application/json')}>
              <Icon name="download" />
              下载 mcp.json
            </button>
            <button className="btn ghost" disabled={!chosen} onClick={() => downloadText('.env', dotenv, 'text/plain')}>
              <Icon name="download" />
              下载 .env
            </button>
          </div>
          <div className="tiny dim">
            {fresh && chosen?.id === fresh.id ? '配置里已带上刚创建的完整 Key。' : '完整 Key 只在创建时显示，这份配置里的 Key 是占位符，请自己替换。'}
            配置包含 AIGC_BASE_URL、AIGC_API_KEY、AIGC_PROJECT_ID（当前项目）、AIGC_IMAGE_MODEL、AIGC_VIDEO_MODEL。
            {desktop && ' 桌面版的本机端口每次启动会变，端口变了要重新下载配置；想固定端口请用 Web 服务方式运行。'}
            {mcpPath === null && ' 没有在安装目录里找到 MCP 服务脚本，请把 packages/mcp/index.mjs 的绝对路径填进 args。'}
          </div>
        </div>
        <div className="card code-card">
          <div className="code-head">
            <b>mcp.json</b>
            <span className="grow" />
            <button className="btn sm ghost" onClick={() => copyText(mcpJson) && toast('success', '已复制 mcp.json')}>
              <Icon name="copy" />
              复制
            </button>
          </div>
          <pre className="code-block">{mcpJson}</pre>
          <div className="code-foot">
            <Icon name="link" />
            <span>
              工具：list_models · generate_image · generate_video · get_canvas_context · get_job。把它放进 Claude Desktop / Claude Code / Cursor 的 MCP 配置里。
            </span>
          </div>
        </div>
      </div>

      <div className="catalog-sec">
        <div className="catalog-sec-name">直接调用</div>
        <div className="card code-card">
          <div className="code-head">
            <b>读取画布上下文</b>
            <span className="grow" />
            <button className="btn sm ghost" onClick={() => copyText(curl) && toast('success', '已复制')}>
              <Icon name="copy" />
              复制
            </button>
          </div>
          <pre className="code-block">{curl}</pre>
          <div className="code-foot">
            <Icon name="link" />
            <span>
              其余接口：GET /openapi/v1/models · POST /openapi/v1/images/generations · POST /openapi/v1/jobs · GET /openapi/v1/jobs/:id。画布上下文里的 src 是本机地址，外部要能访问本机服务。
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
