import { Agent, FormData as UndiciFormData, fetch as undiciFetch } from 'undici';

/* ============================================================================
   平台生成网关的 HTTP 客户端。
   Node 自带的 fetch 有两个写死的 5 分钟上限（等响应头 / 读响应体），和我们自己设的
   AbortSignal 超时无关；慢模型（比如 gpt-image-2-c）会先撞上它，只报一句 fetch failed。
   这里用 undici 自己的 fetch + 放宽到 21 分钟的 Agent，让「生成超时 20 分钟」真的是 20 分钟。
   ========================================================================== */

/** 图像 / 视频生成请求的整体超时：20 分钟 */
export const GENERATION_TIMEOUT_MS = 20 * 60_000;
/** 比整体超时多留 1 分钟，保证先触发我们自己的超时（报错信息更清楚），而不是 undici 的 */
export const HTTP_WAIT_MS = GENERATION_TIMEOUT_MS + 60_000;

export const gatewayAgent = new Agent({ headersTimeout: HTTP_WAIT_MS, bodyTimeout: HTTP_WAIT_MS, connectTimeout: 30_000 });

const nativeFetch = globalThis.fetch;

/** Node 全局的 FormData 对 undici 的 fetch 来说是「别家的」，直接传会被当成文本发出去（参考图编辑就坏了）：转成 undici 自己的 */
function asUndiciBody(body: RequestInit["body"]) {
  if (!(body instanceof FormData)) return body;
  const out = new UndiciFormData();
  for (const [k, v] of body.entries()) {
    if (typeof v === 'string') out.append(k, v);
    else out.append(k, v as unknown as Blob, (v as File).name || 'file');
  }
  return out as unknown as RequestInit["body"];
}

/**
 * 发请求。正常用 undici 的 fetch；测试里如果把全局 fetch 换成了假的（vi.stubGlobal），就走假的，
 * 这样既有的网关测试不用改。
 */
export const gatewayRequest = ((url: string, init: RequestInit = {}) =>
  globalThis.fetch !== nativeFetch
    ? globalThis.fetch(url, init)
    : (undiciFetch as unknown as typeof fetch)(url, { ...init, body: asUndiciBody(init.body), dispatcher: gatewayAgent } as RequestInit)) as typeof fetch;
