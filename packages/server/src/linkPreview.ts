import dns from 'node:dns/promises';
import net from 'node:net';
import type { LinkPreview } from '@aigc/shared';
import { hostOf } from '@aigc/shared';
import type { Core } from './core';

/* ============================================================================
   链接预览：服务端抓 og:title / og:image。前端拿不到跨域页面的标题和封面，
   这一步本来就该由服务端完成。抓不到的字段留空，不编示例数据。
   ========================================================================== */

function isPrivateIp(ip: string) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const x = ip.toLowerCase();
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || x.startsWith('::ffff:127.') || x.startsWith('::ffff:10.') || x.startsWith('::ffff:192.168.');
}

/** 只抓公网地址，避免被当成探测内网的跳板 */
export async function assertPublicUrl(raw: string) {
  const u = new URL(raw);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只支持 http / https 链接');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (!addrs.length || addrs.some(isPrivateIp)) throw new Error('不抓取内网地址');
  return u;
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .trim();

function meta(html: string, keys: string[]) {
  for (const k of keys) {
    const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]*content=["']([^"']+)["']`, 'i');
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${k}["']`, 'i');
    const m = re1.exec(html) || re2.exec(html);
    if (m) return decode(m[1]);
  }
  return undefined;
}

async function fetchLimited(url: string, maxBytes: number, accept: string) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 AIGCStudio/1.0',
      Accept: accept,
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return { buf: Buffer.concat(chunks), type: (res.headers.get('content-type') || '').split(';')[0].trim(), finalUrl: res.url || url };
}

export async function linkPreview(core: Core, url: string): Promise<LinkPreview> {
  const u = await assertPublicUrl(url);
  const out: LinkPreview = { url, site: hostOf(url) };
  const page = await fetchLimited(u.toString(), 1.5 * 1024 * 1024, 'text/html,application/xhtml+xml');
  if (!/html|xml/.test(page.type)) return out;
  const html = page.buf.toString('utf8');
  out.title = meta(html, ['og:title', 'twitter:title']) || (/<title[^>]*>([^<]{1,200})<\/title>/i.exec(html)?.[1] ? decode(/<title[^>]*>([^<]{1,200})<\/title>/i.exec(html)![1]) : undefined);
  out.desc = meta(html, ['og:description', 'description', 'twitter:description'])?.slice(0, 200);
  out.site = meta(html, ['og:site_name']) || out.site;
  out.author = meta(html, ['author', 'article:author', 'og:article:author']);
  const img = meta(html, ['og:image', 'og:image:url', 'twitter:image', 'twitter:image:src']);
  if (img) {
    try {
      const abs = new URL(img, page.finalUrl).toString();
      await assertPublicUrl(abs);
      const got = await fetchLimited(abs, 6 * 1024 * 1024, 'image/*');
      if (got.type.startsWith('image/') && got.buf.length > 200) {
        /* 封面存一份到本机：平台图片常有防盗链，也会过期 */
        const saved = await core.saveMedia(got.buf, got.type, 'uploads');
        out.image = saved.src;
      }
    } catch {
      /* 封面抓不到就算了，用户可以自己补 */
    }
  }
  return out;
}
