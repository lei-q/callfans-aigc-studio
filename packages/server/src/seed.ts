import type { AestheticItem, Board, CanvasItem, Job, Project, Result, Wallet } from '@aigc/shared';
import { DEFAULT_DAILY_FREE, dayKey } from '@aigc/shared';
import { sampleSrc, sampleThumb } from './providers/mock-catalog';
import type { Store } from './store';

/* ============================================================================
   首次启动的示例数据：沿用原型里的三个项目、示例任务、素材与画板。
   时间按「现在往前推」生成，保证今天 / 昨天的分组自然成立。
   ========================================================================== */

const MIN = 60_000;

export function seedDemo(store: Store, now = Date.now()) {
  const ago = (m: number) => now - m * MIN;

  const projects: Project[] = [
    { id: 'w1', name: '咖啡店 · 春季新品', dot: '#F97316', used: 2.88, createdAt: ago(3000) },
    { id: 'w2', name: '旅拍 · 短视频', dot: '#4F46E5', used: 17.55, createdAt: ago(2990) },
    { id: 'w3', name: '播客 · 片头与配乐', dot: '#7C5CFC', used: 1.8, createdAt: ago(2980) },
  ];

  const r = (
    id: string, job: string, type: Result['type'], ws: string, title: string, f: string, ratio: string,
    model: string, seed: number, at: number, status: Result['status'], tags: string[], dur: number,
    home: Result['home'], cam?: string,
  ): Result => ({
    id, job, type, ws, title, src: sampleSrc(f), thumb: sampleThumb(f), simulated: type !== 'image',
    ratio, model, seed, createdAt: at, status, tags, dur, home, cam,
  });

  const results: Result[] = [
    r('r1', 'j1', 'image', 'w1', '主视觉 A · 暖橙商品图', 'img-01-coffee-poster', '1:1', 'm-img-u2', 88213, ago(20), 'adopted', ['暖调', '商品图'], 0, 'canvas'),
    r('r2', 'j1', 'image', 'w1', '主视觉 B · 香薰静物', 'img-02-aroma-scene', '1:1', 'm-img-u2', 88214, ago(20), 'new', ['低饱和', '静物'], 0, 'library'),
    r('r3', 'j1', 'image', 'w1', '主视觉 C · 可颂平铺', 'img-03-pastry-flatlay', '1:1', 'm-img-u2', 88215, ago(20), 'new', ['美食', '平铺'], 0, 'library'),
    r('r4', 'j1', 'image', 'w1', '主视觉 D · 包装立图', 'img-04-package-mockup', '1:1', 'm-img-u2', 88216, ago(20), 'fav', ['包装', '影棚'], 0, 'canvas'),
    r('r5', 'j2', 'video', 'w2', '竖版首帧 · 街头跟拍', 'video-01-street-vertical', '9:16', 'm-vid-c1', 51204, ago(95), 'new', ['9:16', '推近'], 5, 'canvas', '推近'),
    r('r6', 'j3', 'video', 'w2', '横版空镜 · 航拍海岸', 'video-02-seaside-wide', '16:9', 'm-vid-c1', 50987, ago(120), 'new', ['16:9', '环绕'], 8, 'canvas', '环绕'),
    r('r7', 'j5', 'video', 'w1', '产品动效 · 水花循环', 'video-03-studio-loop', '16:9', 'm-vid-f1', 47310, ago(168), 'new', ['16:9', '固定'], 3, 'draft', '固定'),
    r('r8', 'j6', 'audio', 'w3', '片头 · 深夜电台 30s', 'audio-01-night-radio', '1:1', 'm-aud-tts', 30112, ago(250), 'adopted', ['岚 · 温和女声', '深夜'], 30, 'draft'),
    r('r9', 'j7', 'audio', 'w3', '音乐 · 清晨氛围 60s', 'audio-02-ambient-dawn', '1:1', 'm-aud-mus', 30555, ago(282), 'new', ['清晨专注', '60 BPM'], 60, 'canvas'),
    r('r10', 'j8', 'audio', 'w3', '音效 · 品牌标识 5s', 'audio-03-brand-stinger', '1:1', 'm-aud-sfx', 31240, ago(320), 'new', ['音效', '5 秒'], 5, 'library'),
  ];

  const base = { refs: [], charged: false, results: [] as string[] };
  const jobs: Job[] = [
    { ...base, id: 'j1', name: '春季新品 · 主视觉 4 张', type: 'image', ws: 'w1', model: 'm-img-u2', ratio: '1:1', count: 4, res: '2k',
      prompt: '暖橙主色背景，哑光纸杯与咖啡豆居中，顶部柔光，奶油色高光，留出标题安全区', refs: [{ src: sampleThumb('img-03-pastry-flatlay'), w: 0.6 }],
      cost: 1.2, status: 'succeeded', durText: '2 分 10 秒', createdAt: ago(22), finishedAt: ago(20), results: ['r1', 'r2', 'r3', 'r4'] },
    { ...base, id: 'j2', name: '旅拍短片 · 竖版 5s 首帧', type: 'video', ws: 'w2', model: 'm-vid-c1', ratio: '9:16', dur: 5, cam: '推近',
      prompt: '城市街头跟拍，人物手持咖啡杯，黄金时刻逆光，浅景深，胶片颗粒', refs: [{ src: sampleThumb('video-02-seaside-wide'), w: 0.5 }],
      cost: 4, status: 'succeeded', durText: '3 分 40 秒', createdAt: ago(99), finishedAt: ago(95), results: ['r5'] },
    { ...base, id: 'j3', name: '旅拍空镜 · 横版 8s', type: 'video', ws: 'w2', model: 'm-vid-c1', ratio: '16:9', dur: 8, cam: '环绕',
      prompt: '航拍缓慢推近海岸线，清晨薄雾，冷暖分层，真实光影', cost: 6.4, status: 'succeeded', durText: '6 分 05 秒', createdAt: ago(126), finishedAt: ago(120), results: ['r6'] },
    { ...base, id: 'j5', name: '产品动效 · 水花循环 3s', type: 'video', ws: 'w1', model: 'm-vid-f1', ratio: '16:9', dur: 3, cam: '固定',
      prompt: '水珠缓慢落在亮橙色表面，深色影棚，边缘光，微距，首尾可循环', cost: 0.75, status: 'succeeded', durText: '48 秒', createdAt: ago(169), finishedAt: ago(168), results: ['r7'] },
    { ...base, id: 'j6', name: '深夜电台 · 片头 30s', type: 'audio', ws: 'w3', model: 'm-aud-tts', use: 'tts', dur: 30, voice: 'lan', lang: '中文',
      prompt: '深夜电台片头：低沉男声导读，语气亲近，舒缓弦乐垫底，句间留白 0.4 秒', cost: 0.5, status: 'succeeded', durText: '35 秒', createdAt: ago(251), finishedAt: ago(250), results: ['r8'] },
    { ...base, id: 'j7', name: '清晨专注 · 背景音乐 60s', type: 'audio', ws: 'w3', model: 'm-aud-mus', use: 'music', dur: 60, mood: 'morning',
      prompt: '钢琴与轻电子，60 BPM，无明显旋律尖峰，适合口播垫底，可循环', cost: 1.2, status: 'succeeded', durText: '1 分 10 秒', createdAt: ago(283), finishedAt: ago(282), results: ['r9'] },
    { ...base, id: 'j8', name: '品牌标识音 5s', type: 'audio', ws: 'w3', model: 'm-aud-sfx', use: 'sfx', dur: 5,
      prompt: '木质敲击 + 上扬泛音，收尾干净无混响尾巴', cost: 0.1, status: 'succeeded', durText: '12 秒', createdAt: ago(321), finishedAt: ago(320), results: ['r10'] },
    { ...base, id: 'j10', name: '春季新品 · 大幅面 2 张', type: 'image', ws: 'w1', model: 'm-img-u2', ratio: '1:1', count: 2, res: '4k',
      prompt: '暖橙背景，哑光纸杯居中，大幅面输出，材质细节清晰', cost: 1.32, status: 'failed', createdAt: ago(88),
      fail: { code: 'E-PRM-04', reason: '4K（4096 × 4096）超出 Aurora-Image U2 上限 2K', fix: '改用 Aurora-Image X1，或降到 2K' } },
    { ...base, id: 'j11', name: '横版宣传片 12s', type: 'video', ws: 'w2', model: 'm-vid-c1', ratio: '16:9', dur: 12, cam: '环绕',
      prompt: '航拍环绕雪山与湖面，日出金光，长镜头', cost: 9.6, status: 'failed', createdAt: ago(158),
      fail: { code: 'E-DUR-02', reason: '时长 12s 超过 Muse-Video C1 上限 8s', fix: '按时长上限 8s 重试，或拆成两段各 6s' } },
    { ...base, id: 'j12', name: '冬季热饮预热 · 场景图 4 张', type: 'image', ws: 'w1', model: 'm-img-u2', ratio: '4:5', count: 4, res: '2k',
      prompt: '冬季窗边热饮场景，毛毯与书本，暖光，浅景深', cost: 1.2, status: 'canceled', createdAt: ago(335) },
    { ...base, id: 'j13', name: '昨日 · 门店实拍风格 6 张', type: 'image', ws: 'w1', model: 'm-img-f2', ratio: '1:1', count: 6, res: '1080p',
      prompt: '门店实拍：吧台、拉花、豆仓，自然光，真实随手感', cost: 0.29, status: 'succeeded', durText: '52 秒', createdAt: ago(60 * 22), finishedAt: ago(60 * 22 - 1) },
    { ...base, id: 'j14', name: '昨日 · 竖版预告 9:16', type: 'video', ws: 'w2', model: 'm-vid-c1', ratio: '9:16', dur: 8, cam: '跟随',
      prompt: '竖版跟拍预告：人物上车、关门、车窗反光，节奏偏快', cost: 6.4, status: 'succeeded', durText: '6 分 20 秒', createdAt: ago(60 * 23 + 30), finishedAt: ago(60 * 23 + 24) },
  ];

  const media = (id: string, type: CanvasItem['type'], f: string, t: string, rid: string, x: number, y: number): CanvasItem => ({
    id, kind: 'media', type, src: sampleSrc(f), thumb: sampleThumb(f), t, rid, x, y,
  });
  const boards: Record<string, Board> = {
    w1: {
      items: [
        media('c1', 'image', 'img-01-coffee-poster', '主视觉 · 暖橙商品图', 'r1', 40, 40),
        media('c2', 'video', 'video-01-street-vertical', '竖版 · 街头跟拍', 'r5', 232, 40),
        media('c4', 'image', 'img-04-package-mockup', 'mockup · 包装立图', 'r4', 232, 250),
      ],
      links: [], view: { x: 40, y: 40, k: 1 }, anchor: null,
    },
    w2: { items: [media('c6', 'video', 'video-02-seaside-wide', '横版 · 航拍海岸', 'r6', 40, 40)], links: [], view: { x: 40, y: 40, k: 1 }, anchor: null },
    w3: { items: [media('c10', 'audio', 'audio-02-ambient-dawn', '音乐 · 清晨氛围', 'r9', 232, 40)], links: [], view: { x: 40, y: 40, k: 1 }, anchor: null },
  };

  const aes = (id: string, f: string, t: string, note: string, tags: string[], from: string, at: number): AestheticItem => ({
    id, key: `s:${id}`, kind: 'image', src: sampleThumb(f), t, note, tags, from, createdAt: at,
  });
  const aesthetic: AestheticItem[] = [
    aes('a1', 'img-01-coffee-poster', '暖橙商品图 · 主视觉', '低饱和暖橙，留白足', ['暖调', '商品图'], '咖啡店 · 春季新品', ago(2400)),
    aes('a2', 'img-02-aroma-scene', '香薰静物 · 侧光', '侧光 + 浅景深，质感好', ['静物', '自然光'], '咖啡店 · 春季新品', ago(2300)),
    aes('a3', 'video-02-seaside-wide', '航拍海岸 · 冷暖分层', '大留白、低饱和，做空镜参考', ['空镜', '冷调'], '旅拍 · 短视频', ago(1200)),
    aes('a4', 'img-04-package-mockup', '包装立图 · 影棚', '硬光 + 干净背景', ['影棚', '包装'], '咖啡店 · 春季新品', ago(1100)),
  ];

  const wallet: Wallet = {
    balance: 18.6,
    spent: { image: 2.88, video: 17.55, audio: 1.8 },
    dailyFree: DEFAULT_DAILY_FREE,
    dailyUsed: 0,
    dailyDate: dayKey(now),
    firstTopupDone: false,
  };

  projects.forEach((p) => store.projects.put(p));
  jobs.forEach((j) => store.jobs.put(j));
  results.forEach((x) => store.results.put(x));
  Object.entries(boards).forEach(([ws, b]) => store.saveBoard(ws, b));
  aesthetic.forEach((a) => store.aesthetic.put(a));
  store.wallet = wallet;
}

/** 不要示例数据时，至少给一个空项目 */
export function seedEmpty(store: Store, now = Date.now()) {
  store.projects.put({ id: 'w1', name: '我的第一个项目', dot: '#F97316', used: 0, createdAt: now });
}
