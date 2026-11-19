import { useEffect, useRef, useState } from 'react';
import type { ProbeLike } from './linkTypes';
import type { Result, TaskDto, ToolInfoDto } from '@aigc/shared';
import { Icon } from '../components/common';
import { ToolGuide, toolOfError } from '../components/ToolGuide';
import { api } from '../lib/api';
import { getState, setState, useStore } from '../store';
import { toast, toastError } from '../store/toast';
import { keepResult } from './ops';

/* 链接下载视频：粘贴视频链接 → 解析标题 / 时长 → 下载到本机并放进画布。
   依赖 yt-dlp（不随包分发）：没装时直接展示安装指引。 */
export function LinkDlModal() {
  const open = useStore((s) => s.linkDl);
  const [url, setUrl] = useState('');
  const [probe, setProbe] = useState<ProbeLike | null>(null);
  const [missing, setMissing] = useState<ToolInfoDto | null>(null);
  const [busy, setBusy] = useState('');
  const [task, setTask] = useState<TaskDto | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  useEffect(() => {
    if (open) void api.get<{ tools: ToolInfoDto[] }>('/api/tools').then((r) => setMissing(r.tools.find((t) => t.name === 'ytdlp' && !t.found) || null)).catch(() => {});
  }, [open]);
  if (!open) return null;
  const close = () => {
    if (task?.status === 'running') void api.post(`/api/link/download/${task.id}/cancel`).catch(() => {});
    setState((st) => void (st.linkDl = false));
    setTask(null);
    setProbe(null);
  };
  const guard = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      const t = toolOfError(e);
      if (t) setMissing(t);
      else toastError(e, '链接处理失败');
      return null;
    }
  };
  const doProbe = async () => {
    setBusy('解析中…');
    setProbe(null);
    const r = await guard(() => api.post<ProbeLike>('/api/link/probe', { url }));
    setBusy('');
    if (r) setProbe(r);
  };
  const poll = (id: string) => {
    api
      .get<{ task: TaskDto<{ result: Result }> }>(`/api/link/download/${id}`)
      .then(({ task: t }) => {
        setTask(t);
        if (t.status === 'running') timer.current = setTimeout(() => poll(id), 1000);
        else if (t.status === 'done' && t.result) {
          const r = t.result.result;
          setState((st) => void (!st.results.some((x) => x.id === r.id) && st.results.unshift(r)));
          keepResult(r.id, undefined, { quiet: true });
          toast('success', '已下载并放进画布', r.title);
          setState((st) => void (st.linkDl = false));
          setTask(null);
          setProbe(null);
          setUrl('');
        } else if (t.status === 'failed') toast('warn', '下载失败', t.error);
      })
      .catch(() => (timer.current = setTimeout(() => poll(id), 2000)));
  };
  const download = async () => {
    const r = await guard(() => api.post<{ task: TaskDto }>('/api/link/download', { url, ws: getState().ws, title: probe?.title }));
    if (r) {
      setTask(r.task);
      poll(r.task.id);
    }
  };
  const running = task?.status === 'running';
  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && !running && close()}>
      <div className="modal-card linkdl-modal">
        <div className="modal-head">
          <Icon name="link" />
          <b>链接下载视频</b>
          <span className="grow" />
          <button className="icon-btn" onClick={close}>
            <Icon name="x" />
          </button>
        </div>
        <div className="vtool-body">
          {missing && <ToolGuide tool={missing} onFound={() => setMissing(null)} />}
          <div className="snap-new">
            <input className="form-input" autoFocus placeholder="粘贴视频链接（B 站、抖音、YouTube 等 yt-dlp 支持的网站）" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && url && void doProbe()} />
            <button className="btn sm ghost" disabled={!url.trim() || !!busy || running || !!missing} onClick={() => void doProbe()}>
              解析
            </button>
          </div>
          {busy && <div className="tiny dim">{busy}</div>}
          {probe && (
            <div className="check-line ok">
              <Icon name="film" />
              <div>
                <b>{probe.title}</b>
                <div className="tiny dim">
                  {probe.site || ''} {probe.uploader ? `· ${probe.uploader}` : ''} {probe.duration ? `· ${Math.round(probe.duration)} 秒` : ''}
                </div>
              </div>
            </div>
          )}
          {task && (
            <div className="check-line info">
              <Icon name={task.status === 'failed' ? 'alert' : 'download'} />
              <div className="grow">
                <b>{task.status === 'failed' ? '下载失败' : task.stage}</b>
                <div className="tiny dim">{task.status === 'failed' ? task.error : `${Math.round(task.progress)}%`}</div>
              </div>
            </div>
          )}
          <div className="tiny dim">只下载你有权使用的内容；下载的视频保存在本机，不会上传。仅支持单个视频（不下载整个列表）。</div>
        </div>
        <div className="modal-foot">
          <span className="grow" />
          <button className="btn sm ghost" onClick={close}>
            {running ? '取消下载' : '关闭'}
          </button>
          <button className="btn sm primary" disabled={!url.trim() || running || !!missing} onClick={() => void download()}>
            <Icon name="download" />
            下载到画布
          </button>
        </div>
      </div>
    </div>
  );
}
