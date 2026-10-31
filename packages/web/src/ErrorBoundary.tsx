import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Icon } from './components/common';

/* 兜底：渲染/提交阶段出错（比如浏览器扩展改写了 DOM 节点）时，给一个能继续用的出口。
   数据都在本机服务里，刷新就能回来，不至于整页白屏。 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  override state = { err: null as Error | null };

  static getDerivedStateFromError(err: Error) {
    return { err };
  }

  override componentDidCatch(err: Error, info: ErrorInfo) {
    console.error('界面渲染出错', err, info.componentStack);
  }

  override render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="boot-screen">
        <span className="brand-mark">
          <Icon name="sparkles" />
        </span>
        <b>界面出了点问题</b>
        <span>画布与产出都保存在本机，刷新一下就能继续。</span>
        <span className="tiny dim">{this.state.err.message}</span>
        <button className="btn primary" onClick={() => location.reload()}>
          刷新
        </button>
      </div>
    );
  }
}
