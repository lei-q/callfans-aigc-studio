import { useState } from 'react';
import type { ToolInfoDto } from '@aigc/shared';
import { Icon } from './common';
import { api } from '../lib/api';
import { copyText } from '../lib/util';
import { toast } from '../store/toast';

/** 从接口错误里取出缺失工具的信息（服务端 501 时带 tool 字段） */
export const toolOfError = (e: unknown): ToolInfoDto | null => ((e as { body?: { tool?: ToolInfoDto } })?.body?.tool as ToolInfoDto) || null;

const sysOf = () => (/Mac/i.test(navigator.platform) ? 'mac' : /Win/i.test(navigator.platform) ? 'win' : 'linux') as 'mac' | 'win' | 'linux';
const SYS_NAME = { mac: 'macOS', win: 'Windows', linux: 'Linux' };

/* 安装指引：不随包分发的工具没装时，告诉用户装什么、怎么装、装好后怎么生效。 */
export function ToolGuide({ tool, onFound }: { tool: ToolInfoDto; onFound?: () => void }) {
  const [sys, setSys] = useState(sysOf());
  const [busy, setBusy] = useState(false);
  const recheck = async () => {
    setBusy(true);
    try {
      const { tools } = await api.get<{ tools: ToolInfoDto[] }>('/api/tools');
      if (tools.find((t) => t.name === tool.name)?.found) {
        toast('success', `已找到 ${tool.title}`);
        onFound?.();
      } else toast('warn', `还是没找到 ${tool.title}`, '装好后可能需要重新打开本应用，让它拿到新的命令行路径');
    } finally {
      setBusy(false);
    }
  };
  const cmds = tool.install[sys];
  return (
    <div className="tool-guide">
      <div className="tg-head">
        <Icon name="alert" />
        <b>{tool.badEnv ? `${tool.env} 指向的文件不存在` : `这台电脑还没有安装 ${tool.title}`}</b>
        <span className="tiny dim">用于{tool.purpose}</span>
      </div>
      <div className="tg-tabs">
        {(['mac', 'win', 'linux'] as const).map((k) => (
          <button key={k} className={`btn sm ${sys === k ? 'primary' : 'ghost'}`} onClick={() => setSys(k)}>
            {SYS_NAME[k]}
          </button>
        ))}
      </div>
      <div className="tg-cmds">
        {cmds.map((c) => (
          <div key={c} className="tg-cmd">
            <code>{c}</code>
            {!c.startsWith('或：') && (
              <button className="btn sm ghost" onClick={() => copyText(c) && toast('success', '已复制命令')}>
                复制
              </button>
            )}
          </div>
        ))}
      </div>
      {tool.install.note && <div className="tiny dim">{tool.install.note}</div>}
      <div className="tiny dim">已经装在别的位置？设置环境变量 <code>{tool.env}</code> 指向它，然后重新打开本应用。</div>
      <div>
        <button className="btn sm primary" onClick={() => void recheck()} disabled={busy}>
          <Icon name="refresh" />
          {busy ? '检测中…' : '我装好了，重新检测'}
        </button>
      </div>
    </div>
  );
}
