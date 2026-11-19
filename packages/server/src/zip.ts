import fs from 'node:fs';
import { crc32 } from 'node:zlib';
import { Readable } from 'node:stream';

/* ============================================================================
   流式 ZIP 打包（只存不压）：图片 / 视频本来就是压缩过的，再压没有收益；
   用「数据描述符」边读边写，不需要先扫一遍算 CRC，也不会把大文件读进内存。
   单文件与总大小都限制在 4GB 以内（不做 ZIP64）。
   ========================================================================== */

export interface ZipEntry {
  /** 压缩包里的文件名（UTF-8，可含中文；可带 images/ 这样的子目录） */
  name: string;
  /** 磁盘上的源文件；和 data 二选一 */
  file?: string;
  /** 直接给内容（比如导出时生成的 Markdown） */
  data?: Buffer;
}

export const ZIP_MAX_BYTES = 3.5 * 1024 ** 3;

function dosTime(d: Date) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** 重名文件加 (2)(3)；名字里的路径分隔符等替换掉，防止压出目录穿越 */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    // eslint-disable-next-line no-control-regex
    const clean = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').slice(0, 120) || 'file';
    const dot = clean.lastIndexOf('.');
    const stem = dot > 0 ? clean.slice(0, dot) : clean;
    const ext = dot > 0 ? clean.slice(dot) : '';
    const key = clean.toLowerCase();
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    return n === 1 ? clean : `${stem} (${n})${ext}`;
  });
}

export function zipStream(entries: ZipEntry[]): Readable {
  async function* gen() {
    const central: Buffer[] = [];
    let offset = 0;
    for (const e of entries) {
      const name = Buffer.from(e.name, 'utf8');
      const mtime = e.file ? (await fs.promises.stat(e.file)).mtime : new Date();
      const { time, date } = dosTime(mtime);
      const flags = 0x0808; // bit3 = 数据描述符，bit11 = 文件名 UTF-8
      const head = Buffer.alloc(30);
      head.writeUInt32LE(0x04034b50, 0);
      head.writeUInt16LE(20, 4);
      head.writeUInt16LE(flags, 6);
      head.writeUInt16LE(0, 8); // 存储
      head.writeUInt16LE(time, 10);
      head.writeUInt16LE(date, 12);
      head.writeUInt16LE(name.length, 26);
      const localOffset = offset;
      yield head;
      yield name;
      offset += head.length + name.length;

      let crc = 0;
      let size = 0;
      const source: AsyncIterable<Buffer> | Buffer[] = e.data ? [e.data] : (fs.createReadStream(e.file!) as AsyncIterable<Buffer>);
      for await (const chunk of source) {
        crc = crc32(chunk, crc);
        size += chunk.length;
        offset += chunk.length;
        yield chunk;
      }
      const desc = Buffer.alloc(16);
      desc.writeUInt32LE(0x08074b50, 0);
      desc.writeUInt32LE(crc >>> 0, 4);
      desc.writeUInt32LE(size, 8);
      desc.writeUInt32LE(size, 12);
      yield desc;
      offset += desc.length;

      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(flags, 8);
      c.writeUInt16LE(0, 10);
      c.writeUInt16LE(time, 12);
      c.writeUInt16LE(date, 14);
      c.writeUInt32LE(crc >>> 0, 16);
      c.writeUInt32LE(size, 20);
      c.writeUInt32LE(size, 24);
      c.writeUInt16LE(name.length, 28);
      c.writeUInt32LE(localOffset, 42);
      central.push(c, name);
    }
    const cdSize = central.reduce((n, b) => n + b.length, 0);
    for (const b of central) yield b;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cdSize, 12);
    end.writeUInt32LE(offset, 16);
    yield end;
  }
  return Readable.from(gen(), { objectMode: false });
}
