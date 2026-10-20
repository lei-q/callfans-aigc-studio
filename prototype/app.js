'use strict';
/* ============================================================================
   AIGC 创作台 · 交互原型 v0.8 —— 交互逻辑
   结构：工具 → 数据 → 状态 → 派生 → 渲染（顶栏/侧栏/创作台/任务/领域页）
        → 队列与画廊 → 抽屉/模态/Toast → 动作 → 模拟器 → 事件 → 初始化
   说明：原型不接入真实模型，生成过程、播放、进度均为本地模拟；
        产出图片由 GPT Image 2.5 生成，存放于 assets/，仅用于演示画廊与交付流程。
   ========================================================================== */

/* ============================ 1. 工具 ============================ */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
const FILL_ICONS = new Set(['play', 'pause', 'more']);
const icon = (name, cls = '') =>
  `<svg class="ic ${FILL_ICONS.has(name) ? 'fill' : ''} ${cls}"><use href="#i-${name}"/></svg>`;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/* 复制到剪贴板：原型跑在 file:// 或本地服务上，Clipboard API 可能不可用，回退到 textarea */
function copyText(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text); return true; }
  } catch (_) { /* 继续回退 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (_) { return false; }
}

const nowTime = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const round1 = (n) => Math.round(n * 10) / 10;
/* 确定性伪随机：同一种子得到同一波形，便于原型稳定复现 */
function seededSeries(seed, n, min, max) {
  let x = seed % 2147483647; if (x <= 0) x += 2147483646;
  const out = [];
  for (let i = 0; i < n; i++) { x = (x * 16807) % 2147483647; out.push(min + (x / 2147483647) * (max - min)); }
  return out;
}

/* ============================ 2. 数据 ============================ */
const TYPES = {
  image: { key: 'image', name: '图像', ic: 'image', hint: '主视觉 / 商品图 / 场景图', unit: '张', modeCls: '' },
  video: { key: 'video', name: '视频', ic: 'video', hint: '短片 / 空镜 / 产品动效', unit: '条', modeCls: 'mode-video' },
  audio: { key: 'audio', name: '音频', ic: 'audio', hint: '配音 / 音乐 / 音效', unit: '条', modeCls: 'mode-audio' },
};

/* 项目：个人也可以按项目拆分，但不是团队空间，没有配额与成员概念 */
const WORKSPACES = [
  { id: 'w1', name: '咖啡店 · 春季新品', dot: '#F97316', used: 2.88 },
  { id: 'w2', name: '旅拍 · 短视频', dot: '#4F46E5', used: 17.55 },
  { id: 'w3', name: '播客 · 片头与配乐', dot: '#7C5CFC', used: 1.8 },
];

/* 模型渠道：模型不是直连各家原厂的，而是经过渠道层统一接入、路由与计费。
   前台不暴露渠道品牌，只在「API 接入」这类面向专业用户的页面标注来源与规格。 */
const CHANNELS = [
  { id: 'ch-gw', name: '聚合网关', note: '统一入口，多供应商自动路由与故障切换', kind: 'gateway' },
  { id: 'ch-direct', name: '官方直连', note: '直连原厂，延迟更低、规格更完整', kind: 'direct' },
];
const channelOf = (id) => CHANNELS.find((c) => c.id === id) || CHANNELS[0];

const MODELS = [
  { id: 'm-img-u2', name: 'Aurora-Image U2', type: 'image', price: 0.3, basis: '张', status: 'on', ch: 'ch-gw', maxRes: '2k',
    note: '高保真主视觉，最高 2K，支持参考图与局部重绘', caps: ['参考图', '局部重绘', '最高 2K', '约 40 秒/张'], limit: '比例 1:1 / 4:5 / 16:9 / 9:16' },
  { id: 'm-img-f2', name: 'Aurora-Image F2', type: 'image', price: 0.08, basis: '张', status: 'on', ch: 'ch-gw', maxRes: '1080p',
    note: '快速草稿与批量试色，最高 1080p，出图约 4 秒', caps: ['快速', '批量', '最高 1080p'], limit: '比例 1:1 / 4:5 / 16:9' },
  { id: 'm-vid-c1', name: 'Muse-Video C1', type: 'video', price: 0.8, basis: '秒', status: 'on', ch: 'ch-direct',
    note: '电影级运镜与光影，支持首帧参考', caps: ['首帧参考', '5 种运镜', '≤8 秒', '24fps'], limit: '时长 3 / 5 / 8 秒' },
  { id: 'm-vid-f1', name: 'Muse-Video F1', type: 'video', price: 0.25, basis: '秒', status: 'on', ch: 'ch-gw',
    note: '低成本动效与循环素材，出片约 30 秒', caps: ['快速', '循环点', '≤5 秒'], limit: '时长 3 / 5 秒' },
  { id: 'm-aud-tts', name: 'Vocal-TTS V3', type: 'audio', price: 0.5, basis: '30 秒', status: 'on', ch: 'ch-gw',
    note: '多音色配音，支持中英日与停顿控制', caps: ['32 音色', '中/英/日', '停顿控制'], limit: '单条 ≤ 120 秒' },
  { id: 'm-aud-mus', name: 'Score-Music M1', type: 'audio', price: 0.6, basis: '30 秒', status: 'on', ch: 'ch-gw',
    note: '情绪音乐，可指定 BPM、乐器与循环点', caps: ['情绪', 'BPM', '可循环'], limit: '单条 ≤ 180 秒' },
  { id: 'm-aud-sfx', name: 'Foley-SFX S2', type: 'audio', price: 0.1, basis: '条', status: 'on', ch: 'ch-gw',
    note: '短音效与标识音，适合片头与转场', caps: ['1–8 秒', '批量', '低延迟'], limit: '单条 ≤ 8 秒' },
  { id: 'm-img-x1', name: 'Aurora-Image X1', type: 'image', price: 0.45, basis: '张', status: 'on', ch: 'ch-direct', maxRes: '4k',
    note: '大幅面输出，支持 4K 与材质控制', caps: ['支持 4K', '材质控制', '参考图', '约 90 秒/张'], limit: '比例 1:1 / 4:5 / 16:9 / 9:16' },
];

const RATIOS = [{ k: '1:1', n: '1:1' }, { k: '4:5', n: '4:5' }, { k: '16:9', n: '16:9' }, { k: '9:16', n: '9:16' }];
/* 分辨率档位：画质在这里就是分辨率，倍率直接进单价 */
const RESOS = [
  { k: '1080p', n: '1080p', mul: 0.6, px: '1080 × 1080' },
  { k: '2k', n: '2K', mul: 1, px: '2048 × 2048' },
  { k: '4k', n: '4K', mul: 2.2, px: '4096 × 4096' },
];
const resoOf = (k) => RESOS.find((x) => x.k === k) || RESOS[1];
const resRank = (k) => RESOS.findIndex((x) => x.k === k);
const CAMS = ['固定', '推近', '拉远', '环绕', '跟随'];
const VOICES = [{ k: 'lan', n: '岚 · 温和女声' }, { k: 'mu', n: '牧 · 沉稳男声' }, { k: 'qi', n: '琪 · 明快女声' }, { k: 'ava', n: 'Ava · 英文女声' }];
const MOODS = [{ k: 'morning', n: '清晨专注' }, { k: 'night', n: '深夜氛围' }, { k: 'upbeat', n: '轻快活力' }, { k: 'warm', n: '品牌温暖' }];
const AU_DURS = [{ k: 15, n: '15 秒' }, { k: 30, n: '30 秒' }, { k: 60, n: '60 秒' }];
const SFX_DURS = [{ k: 5, n: '5 秒' }, { k: 8, n: '8 秒' }];

const PROMPT_OPTIMIZE = {
  image: {
    expand: '真实摄影质感，柔和自然光与极轻落地阴影，主体居中并留出标题安全区，浅景深，材质细节清晰',
    add: '顶部柔光 + 浅景深 f/2.0 + 微距质感细节，中心构图，留出文字安全区',
    neg: '模糊, 多余文字, 低分辨率, 结构变形, 水印',
    note: '补充光线与镜头信息，并补上通用负面词，出图稳定性更高。',
  },
  video: {
    expand: '缓慢推近运镜，黄金时刻光线，浅景深，轻微电影颗粒，画面稳定无抖动，首尾衔接自然',
    add: '缓慢推近运镜，6 秒时长，24fps，轻微电影颗粒，首尾衔接自然',
    neg: '画面抖动, 闪烁, 结构错位, 肢体畸变',
    note: '补充运镜与帧率约束，可减少帧间跳变和结构漂移。',
  },
  audio: {
    expand: '语速中等偏慢，语气自然亲近，句间留白 0.4 秒，底噪干净，峰值控制在 -3dB',
    add: '语速中等，句间留白 0.4 秒，底噪 -28dB，峰值 -3dB',
    neg: '爆音, 齿音过重, 音量跳变, 背景嗡鸣',
    note: '补充朗读与混音约束，导出后可直接进入剪辑。',
  },
};

/* 描述偏短时走「扩写」，而不是只追加术语；这是新手最容易卡住的一步 */
const EXPAND_THRESHOLD = 24;
/* 首屏预填的示例提示词：用于给用户一个「这是示例，可以直接改」的标识 */
const SEED_PROMPTS = {
  image: '暖橙主色背景，哑光纸杯与咖啡豆居中，顶部柔光，奶油色高光，留出标题安全区',
  video: '城市街头跟拍，人物手持咖啡杯，黄金时刻逆光，浅景深，胶片颗粒',
  audio: '深夜电台片头：低沉男声导读，语气亲近，舒缓弦乐垫底，句间留白 0.4 秒',
};
const isThinPrompt = (type) => State.prompt[type].trim().length < EXPAND_THRESHOLD;
const PARAM_NOTE = `<div class="param-note">${icon('check')}<span>以下为推荐值，不改也能直接生成；对结果不满意时再回来调整。</span></div>`;

/* ===== 审美库：跨项目、跨来源的长期收藏 =====
   素材库装「这个项目产出的、要交付的东西」；审美库装「我个人认可的、代表我品味的东西」。
   两者不同：审美库跨项目、能收外部内容（本地图 / 网页），并且长期存在。 */
const AESTHETIC_KEY = 'aigc-studio-aesthetic-v1';
const AESTHETIC_SEED = [
  { id: 'a1', kind: 'image', src: 'assets/thumbs/img-01-coffee-poster.webp', t: '暖橙商品图 · 主视觉', note: '低饱和暖橙，留白足', tags: ['暖调', '商品图'], from: '咖啡店 · 春季新品', at: '10-15' },
  { id: 'a2', kind: 'image', src: 'assets/thumbs/img-02-aroma-scene.webp', t: '香薰静物 · 侧光', note: '侧光 + 浅景深，质感好', tags: ['静物', '自然光'], from: '咖啡店 · 春季新品', at: '10-15' },
  { id: 'a3', kind: 'image', src: 'assets/thumbs/video-02-seaside-wide.webp', t: '航拍海岸 · 冷暖分层', note: '大留白、低饱和，做空镜参考', tags: ['空镜', '冷调'], from: '旅拍 · 短视频', at: '10-16' },
  { id: 'a4', kind: 'image', src: 'assets/thumbs/img-04-package-mockup.webp', t: '包装立图 · 影棚', note: '硬光 + 干净背景', tags: ['影棚', '包装'], from: '咖啡店 · 春季新品', at: '10-16' },
];

function loadAesthetic() {
  try {
    const raw = localStorage.getItem(AESTHETIC_KEY);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) return list;
    }
  } catch (_) { /* 存储不可用就用种子 */ }
  return JSON.parse(JSON.stringify(AESTHETIC_SEED));
}
function saveAesthetic() {
  try {
    localStorage.setItem(AESTHETIC_KEY, JSON.stringify(State.aesthetic));
  } catch (_) { /* 超配额就静默放弃，原型不阻塞 */ }
}
const aestheticHas = (key) => State.aesthetic.some((a) => a.key === key);

/* 收进审美库：生成产出引用素材路径，外部内容压缩成缩略图存下来 */
function addToAesthetic(entry) {
  if (!entry || !entry.src) return false;
  if (aestheticHas(entry.key)) { toast('info', '已经在审美库里了', entry.t); return false; }
  State.aesthetic.unshift(entry);
  saveAesthetic();
  return true;
}

/* 把任意图片源压成一张小缩略图，用于长期保存外部内容 */
function shrinkToThumb(src, cb) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    const max = 420;
    const scale = Math.min(1, max / Math.max(img.naturalWidth || max, img.naturalHeight || max));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round((img.naturalWidth || max) * scale));
    cv.height = Math.max(1, Math.round((img.naturalHeight || max) * scale));
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    try { cb(cv.toDataURL('image/jpeg', 0.72)); } catch (_) { cb(null); }
  };
  img.onerror = () => cb(null);
  img.src = src;
}

/* ===== 画布：参考图暂存区，按项目隔离 ===== */
const CANVAS_SEED = {
  w1: [
    { id: 'c1', kind: 'media', type: 'image', f: 'img-01-coffee-poster', t: '主视觉 · 暖橙商品图', rid: 'r1', x: 40, y: 40 },
    { id: 'c2', kind: 'media', type: 'video', f: 'video-01-street-vertical', t: '竖版 · 街头跟拍', rid: 'r5', x: 232, y: 40 },
    { id: 'c4', kind: 'media', type: 'image', f: 'img-04-package-mockup', t: 'mockup · 包装立图', rid: 'r4', x: 232, y: 250 },
  ],
  w2: [
    { id: 'c6', kind: 'media', type: 'video', f: 'video-02-seaside-wide', t: '横版 · 航拍海岸', rid: 'r6', x: 40, y: 40 },
  ],
  w3: [
    { id: 'c10', kind: 'media', type: 'audio', f: 'audio-02-ambient-dawn', t: '音乐 · 清晨氛围', rid: 'r9', x: 232, y: 40 },
  ],
};

/* ===== 基础编辑：三大类各自的处理项（本地模拟，不产生真实文件） ===== */
const EDIT_FILTERS = [
  { k: 'none', n: '原图' },
  { k: 'warm', n: '暖调', css: 'sepia(.22) saturate(1.12) hue-rotate(-6deg)' },
  { k: 'cool', n: '冷调', css: 'hue-rotate(10deg) saturate(1.06) brightness(1.02)' },
  { k: 'mono', n: '黑白', css: 'grayscale(1) contrast(1.06)' },
  { k: 'film', n: '胶片', css: 'contrast(1.12) saturate(.92) sepia(.08)' },
];
const EDIT_CROPS = ['原图', '1:1', '4:5', '16:9', '9:16'];
const EDIT_DEF = {
  image: { filter: 'none', flipH: false, flipV: false, brightness: 0, contrast: 0, saturate: 0, crop: '原图' },
  video: { in: 0, out: 5, speed: 1, mute: false, cover: '首帧', caption: '' },
  audio: { in: 0, out: 30, volume: 100, fadeIn: 0, fadeOut: 0, denoise: false, norm: true },
};
const cloneEdit = () => ({
  image: { ...EDIT_DEF.image },
  video: { ...EDIT_DEF.video },
  audio: { ...EDIT_DEF.audio },
});
const editCss = (ops) => {
  const f = EDIT_FILTERS.find((x) => x.k === ops.filter);
  const parts = [`brightness(${100 + ops.brightness}%)`, `contrast(${100 + ops.contrast}%)`, `saturate(${100 + ops.saturate}%)`];
  if (f && f.css) parts.push(f.css);
  const tf = [];
  if (ops.flipH) tf.push('scaleX(-1)');
  if (ops.flipV) tf.push('scaleY(-1)');
  return `filter:${parts.join(' ')};${tf.length ? `transform:${tf.join(' ')};` : ''}`;
};
const trimOf = (type, ops, cur) => {
  const total = (cur && cur.dur) || (type === 'video' ? 5 : 30);
  const gap = type === 'video' ? 0.5 : 1;
  const a = clamp(ops.in, 0, Math.max(0, total - gap));
  const b = clamp(ops.out, a + gap, total);
  return { a, b, total, len: round1(b - a) };
};

/* 结果素材池：由 GPT Image 2.5 生成的示意产物 */
const ASSET_POOL = {
  image: [
    { f: 'img-01-coffee-poster', t: '主视觉 · 暖橙商品图' },
    { f: 'img-02-aroma-scene', t: '场景图 · 香薰静物' },
    { f: 'img-03-pastry-flatlay', t: '平铺 · 可颂与莓果' },
    { f: 'img-04-package-mockup', t: 'mockup · 包装立图' },
  ],
  video: [
    { f: 'video-01-street-vertical', t: '竖版 · 街头跟拍' },
    { f: 'video-02-seaside-wide', t: '横版 · 航拍空镜' },
    { f: 'video-03-studio-loop', t: '动效 · 水花循环' },
  ],
  audio: [
    { f: 'audio-01-night-radio', t: '片头 · 深夜电台' },
    { f: 'audio-02-ambient-dawn', t: '音乐 · 清晨氛围' },
    { f: 'audio-03-brand-stinger', t: '音效 · 品牌标识' },
  ],
};

const RESULTS = [
  { id: 'r1', job: 'j1', type: 'image', ws: 'w1', title: '主视觉 A · 暖橙商品图', asset: 'img-01-coffee-poster', ratio: '1:1', model: 'm-img-u2', seed: 88213, time: '16:20', status: 'adopted', tags: ['暖调', '商品图'], dur: 0, home: 'canvas' },
  { id: 'r2', job: 'j1', type: 'image', ws: 'w1', title: '主视觉 B · 香薰静物', asset: 'img-02-aroma-scene', ratio: '1:1', model: 'm-img-u2', seed: 88214, time: '16:20', status: 'new', tags: ['低饱和', '静物'], dur: 0, home: 'library' },
  { id: 'r3', job: 'j1', type: 'image', ws: 'w1', title: '主视觉 C · 可颂平铺', asset: 'img-03-pastry-flatlay', ratio: '1:1', model: 'm-img-u2', seed: 88215, time: '16:20', status: 'new', tags: ['美食', '平铺'], dur: 0, home: 'library' },
  { id: 'r4', job: 'j1', type: 'image', ws: 'w1', title: '主视觉 D · 包装立图', asset: 'img-04-package-mockup', ratio: '1:1', model: 'm-img-u2', seed: 88216, time: '16:20', status: 'fav', tags: ['包装', '影棚'], dur: 0, home: 'canvas' },
  { id: 'r5', job: 'j2', type: 'video', ws: 'w2', title: '竖版首帧 · 街头跟拍', asset: 'video-01-street-vertical', ratio: '9:16', model: 'm-vid-c1', seed: 51204, time: '15:05', status: 'new', tags: ['9:16', '推近'], dur: 5, cam: '推近', home: 'canvas' },
  { id: 'r6', job: 'j3', type: 'video', ws: 'w2', title: '横版空镜 · 航拍海岸', asset: 'video-02-seaside-wide', ratio: '16:9', model: 'm-vid-c1', seed: 50987, time: '14:40', status: 'new', tags: ['16:9', '环绕'], dur: 8, cam: '环绕', home: 'canvas' },
  { id: 'r7', job: 'j5', type: 'video', ws: 'w1', title: '产品动效 · 水花循环', asset: 'video-03-studio-loop', ratio: '16:9', model: 'm-vid-f1', seed: 47310, time: '13:52', status: 'new', tags: ['16:9', '固定'], dur: 3, cam: '固定', home: 'draft' },
  { id: 'r8', job: 'j6', type: 'audio', ws: 'w3', title: '片头 · 深夜电台 30s', asset: 'audio-01-night-radio', ratio: '1:1', model: 'm-aud-tts', seed: 30112, time: '12:30', status: 'adopted', tags: ['岚 · 温和女声', '深夜'], dur: 30, home: 'draft' },
  { id: 'r9', job: 'j7', type: 'audio', ws: 'w3', title: '音乐 · 清晨氛围 60s', asset: 'audio-02-ambient-dawn', ratio: '1:1', model: 'm-aud-mus', seed: 30555, time: '11:58', status: 'new', tags: ['清晨专注', '60 BPM'], dur: 60, home: 'canvas' },
  { id: 'r10', job: 'j8', type: 'audio', ws: 'w3', title: '音效 · 品牌标识 5s', asset: 'audio-03-brand-stinger', ratio: '1:1', model: 'm-aud-sfx', seed: 31240, time: '11:20', status: 'new', tags: ['音效', '5 秒'], dur: 5, home: 'library' },
];

const JOBS = [
  { id: 'j1', name: '春季新品 · 主视觉 4 张', type: 'image', ws: 'w1', model: 'm-img-u2', ratio: '1:1', count: 4, res: '2k',
    prompt: '暖橙主色背景，哑光纸杯与咖啡豆居中，顶部柔光，奶油色高光，留出标题安全区', refs: 1, cost: 1.2, status: 'succeeded', durText: '2 分 10 秒', time: '16:20', dateKey: 'today', results: ['r1', 'r2', 'r3', 'r4'] },
  { id: 'j2', name: '旅拍短片 · 竖版 5s 首帧', type: 'video', ws: 'w2', model: 'm-vid-c1', ratio: '9:16', dur: 5, cam: '推近',
    prompt: '城市街头跟拍，人物手持咖啡杯，黄金时刻逆光，浅景深，胶片颗粒', refs: 1, cost: 4, status: 'succeeded', durText: '3 分 40 秒', time: '15:05', dateKey: 'today', results: ['r5'] },
  { id: 'j3', name: '旅拍空镜 · 横版 8s', type: 'video', ws: 'w2', model: 'm-vid-c1', ratio: '16:9', dur: 8, cam: '环绕',
    prompt: '航拍缓慢推近海岸线，清晨薄雾，冷暖分层，真实光影', refs: 0, cost: 6.4, status: 'succeeded', durText: '6 分 05 秒', time: '14:40', dateKey: 'today', results: ['r6'] },
  { id: 'j5', name: '产品动效 · 水花循环 3s', type: 'video', ws: 'w1', model: 'm-vid-f1', ratio: '16:9', dur: 3, cam: '固定',
    prompt: '水珠缓慢落在亮橙色表面，深色影棚，边缘光，微距，首尾可循环', refs: 0, cost: 0.75, status: 'succeeded', durText: '48 秒', time: '13:52', dateKey: 'today', results: ['r7'] },
  { id: 'j6', name: '深夜电台 · 片头 30s', type: 'audio', ws: 'w3', model: 'm-aud-tts', use: 'tts', dur: 30, voice: 'lan', lang: '中文',
    prompt: '深夜电台片头：低沉男声导读，语气亲近，舒缓弦乐垫底，句间留白 0.4 秒', refs: 0, cost: 0.5, status: 'succeeded', durText: '35 秒', time: '12:30', dateKey: 'today', results: ['r8'] },
  { id: 'j7', name: '清晨专注 · 背景音乐 60s', type: 'audio', ws: 'w3', model: 'm-aud-mus', use: 'music', dur: 60, mood: 'morning',
    prompt: '钢琴与轻电子，60 BPM，无明显旋律尖峰，适合口播垫底，可循环', refs: 0, cost: 1.2, status: 'succeeded', durText: '1 分 10 秒', time: '11:58', dateKey: 'today', results: ['r9'] },
  { id: 'j8', name: '品牌标识音 5s', type: 'audio', ws: 'w3', model: 'm-aud-sfx', use: 'sfx', dur: 5,
    prompt: '木质敲击 + 上扬泛音，收尾干净无混响尾巴', refs: 0, cost: 0.1, status: 'succeeded', durText: '12 秒', time: '11:20', dateKey: 'today', results: ['r10'] },
  { id: 'j4', name: '春季限定 · 产品动效 3s', type: 'video', ws: 'w1', model: 'm-vid-f1', ratio: '16:9', dur: 3, cam: '推近',
    prompt: '水珠沿杯身缓慢下滑，深色影棚，边缘光勾勒轮廓，微距，循环衔接', refs: 0, cost: 0.75, status: 'running', progress: 62, eta: '约 1 分钟', time: '16:35', dateKey: 'today', results: [] },
  { id: 'j9', name: '门店场景图 4 张', type: 'image', ws: 'w1', model: 'm-img-f2', ratio: '4:5', count: 4, res: '1080p',
    prompt: '门店午后场景：窗边座位、木质吧台、暖光吊灯，生活方式摄影', refs: 0, cost: 0.19, status: 'queued', queueNote: '前面 1 个任务', time: '16:38', dateKey: 'today', results: [] },
  { id: 'j10', name: '春季新品 · 大幅面 2 张', type: 'image', ws: 'w1', model: 'm-img-u2', ratio: '1:1', count: 2, res: '4k',
    prompt: '暖橙背景，哑光纸杯居中，大幅面输出，材质细节清晰', refs: 0, cost: 1.32, status: 'failed', time: '15:12', dateKey: 'today',
    fail: { code: 'E-PRM-04', reason: '4K（4096×4096）超出 Aurora-Image U2 上限 2K', fix: '改用 Aurora-Image X1，或降到 2K' }, results: [] },
  { id: 'j11', name: '横版宣传片 12s', type: 'video', ws: 'w2', model: 'm-vid-c1', ratio: '16:9', dur: 12, cam: '环绕',
    prompt: '航拍环绕雪山与湖面，日出金光，长镜头', refs: 0, cost: 9.6, status: 'failed', time: '14:02', dateKey: 'today',
    fail: { code: 'E-DUR-02', reason: '时长 12s 超过当前模型上限 8s（排队 4 分钟后失败）', fix: '按时长上限 8s 重试，或拆成两段各 6s' }, results: [] },
  { id: 'j12', name: '冬季热饮预热 · 场景图 4 张', type: 'image', ws: 'w1', model: 'm-img-u2', ratio: '4:5', count: 4, res: '2k',
    prompt: '冬季窗边热饮场景，毛毯与书本，暖光，浅景深', refs: 0, cost: 1.2, status: 'canceled', time: '11:05', dateKey: 'today', results: [] },
  { id: 'j13', name: '昨日 · 门店实拍风格 6 张', type: 'image', ws: 'w1', model: 'm-img-f2', ratio: '1:1', count: 6, res: '1080p',
    prompt: '门店实拍：吧台、拉花、豆仓，自然光，真实随手感', refs: 0, cost: 0.29, status: 'succeeded', durText: '52 秒', time: '昨天 18:40', dateKey: 'yesterday', results: [] },
  { id: 'j14', name: '昨日 · 竖版预告 9:16', type: 'video', ws: 'w2', model: 'm-vid-c1', ratio: '9:16', dur: 8, cam: '跟随',
    prompt: '竖版跟拍预告：人物上车、关门、车窗反光，节奏偏快', refs: 0, cost: 6.4, status: 'succeeded', durText: '6 分 20 秒', time: '昨天 17:12', dateKey: 'yesterday', results: [] },
];

/* 钱包：点数余额制。1 点 = ¥1，没有订阅、没有日配额、点数不过期。
   每日免费点数当日有效、不累积，生成时优先抵扣。 */
const WALLET = {
  balance: 18.6,
  spent: { image: 2.88, video: 17.55, audio: 1.8 },
  dailyFree: 0.5,
  dailyUsed: 0,
  firstTopupDone: false,
  giftClaimed: true,
};

const HELP_TOPICS = [
  { t: '写不出提示词', d: '先写一句大白话，按右上「帮我写详细」补成完整提示词', act: 'studio' },
  { t: '定不好画质', d: '分辨率选 1080p / 2K / 4K，注意每个模型有上限，选超了会失败', act: 'studio' },
  { t: '想先摆一摆参考图', d: '右侧画布可以拖入任意图片，拖空白框选、空格拖平移', act: 'studio' },
  { t: '处理失败任务', d: '顶栏「失败」只看失败任务，点「修复」按建议重试', act: 'fail' },
  { t: '复用已有产出', d: '素材库里卡片「变体」可回填参考图继续生成', act: 'studio' },
  { t: '充值点数', d: '顶栏余额芯片点一下，10 元起充，首充翻倍', act: 'quota' },
  { t: '接到自己的工具里', d: '侧栏「API 接入」创建 Key，与网页共用余额', act: 'api' },
  { t: '查看历史任务', d: '任务记录里按状态筛选，点行展开看产出', act: 'jobs' },
  { t: '编辑已有素材', d: '素材库卡片或详情里点「在编辑器中打开」', act: 'studio' },
];

/* ============================ 3. 状态 ============================ */
const State = {
  page: 'studio',            /* studio | jobs | domain */
  domain: null,              /* library | models */
  ws: 'w1',
  wsMenu: false,
  studioTab: 'gen',          /* gen | edit */
  type: 'image',
  editPick: { image: null, video: null, audio: null },
  editOps: cloneEdit(),
  canvas: JSON.parse(JSON.stringify(CANVAS_SEED)),
  canvasSel: [],
  canvasOpen: true,          /* 右侧画布面板是否展开 */
  cvsView: {},               /* 每个项目的画布视口：{x, y, k} */
  dragId: null,              /* 正在拖进画布的产出 id */
  cvsPop: null,              /* 画布上的生成参数浮层 {rid, sx, sy} */
  cvsFull: false,            /* 画布专注模式：隐藏左侧表单 */
  cvsSpace: false,           /* 按住空格：拖动变成平移画布 */
  cvsMenu: null,             /* 画布右键菜单 {x, y} */
  cvsPen: { on: false, color: '#4F46E5', lw: 3 },   /* 手绘标注 */
  agent: { open: false, result: null },              /* Agent 画板分析 */
  aesthetic: loadAesthetic(),        /* 审美库：跨项目的长期收藏 */
  aestheticFilter: 'all',            /* all | image | video | web */
  diverge: null,                     /* 发散面板：{srcId, axes: []} */
  platforms: null,                   /* 多平台适配面板：{srcId, picks: []} */
  cvsLinks: {},                      /* 每个项目的连线：[{id, from, to}] */
  linkSel: null,                     /* 选中的连线 id */
  linkFrom: null,                    /* 正在连线的起点元素 id */
  styleAnchor: null,                 /* 系列一致性：钉住的风格基准 */
  genLock: false,
  task: null,
  apiLang: 'curl',
  apiKeys: [
    { id: 'k1', name: '生产环境', ch: 'ch-gw', key: 'sk-live-8f3a······c21', created: '10-02 14:20', lastUsed: '今天 21:12', on: true },
    { id: 'k2', name: '本地脚本', ch: 'ch-direct', key: 'sk-test-24b7······90e', created: '10-08 09:41', lastUsed: '昨天 23:05', on: true },
  ],
  apiUsage: [
    { t: '21:12', model: 'm-img-f2', n: 12, pts: 0.96 },
    { t: '20:47', model: 'm-img-u2', n: 4, pts: 1.2 },
    { t: '18:03', model: 'm-aud-tts', n: 2, pts: 1 },
  ],
  queueFilter: 'all',        /* all | failed */
  libScope: 'ws',            /* ws | all */
  editScope: 'ws',           /* ws | all */
  canvasConfirm: false,
  prompt: {
    image: '暖橙主色背景，哑光纸杯与咖啡豆居中，顶部柔光，奶油色高光，留出标题安全区',
    video: '城市街头跟拍，人物手持咖啡杯，黄金时刻逆光，浅景深，胶片颗粒',
    audio: '深夜电台片头：低沉男声导读，语气亲近，舒缓弦乐垫底，句间留白 0.4 秒',
  },
  negative: { image: '', video: '', audio: '' },
  optimize: null,            /* AI 优化建议待应用 */
  refs: { image: [{ f: 'img-03-pastry-flatlay', w: 0.6 }], video: [{ f: 'video-02-seaside-wide', w: 0.5 }], audio: [] },
  adv: false,
  refScope: 'ws',
  params: {
    image: { model: 'm-img-u2', ratio: '1:1', count: 4, res: '2k', seed: '', refWeight: 0.6, format: 'PNG' },
    video: { model: 'm-vid-c1', ratio: '9:16', dur: 5, cam: '推近', fps: 24, firstFrame: true, loop: false },
    audio: { model: 'm-aud-tts', use: 'tts', dur: 30, voice: 'lan', mood: 'morning', lang: '中文', volume: 80 },
  },
  jobs: JOBS.map((j) => ({ ...j, charged: ['running', 'queued'].includes(j.status) })),
  results: RESULTS.map((r) => ({ ...r })),
  wallet: JSON.parse(JSON.stringify(WALLET)),
  expanded: {},
  jobFilter: 'all',          /* all | failed | running */
  drawer: null,              /* {type:'result'|'help'|'queue'|'ref-add'|'topup', id} */
  play: { id: null, t: 0 },
  playing: {},
  assetCursor: { image: 0, video: 0, audio: 0 },
  libFilter: 'all',
  libTab: 'lib',
  libSearch: '',
  libSelect: [],             /* 素材库里勾选的产出 id，用来打包成帖 */
  posts: [],                 /* 帖子草稿 [{id, ws, title, body, items:[rid], platform, time}] */
  postDrag: null,            /* 帖子里正在拖动的配图 id */
  formOpen: true,            /* 左侧生成表单是否展开。收起后就是纯画布 */
  editTextId: null,          /* 正在编辑文字的元素 id（节点或文字） */
  linkLabelEdit: null,       /* 正在改名字的连线 id */
  history: {},               /* 每个项目的撤销栈（存快照字符串） */
  future: {},                /* 每个项目的重做栈 */
  agentPos: null,            /* Agent 悬浮面板被拖到哪儿了；null = 默认右下角 */
  agentDock: false,          /* Agent 是否停靠在右侧 */
  seq: 100,
};

/* ============================ 4. 派生 ============================ */
const wsOf = (id) => WORKSPACES.find((w) => w.id === id) || WORKSPACES[0];
const wsShort = (id) => { const w = wsOf(id); return { name: w.name.split(' · ')[0], dot: w.dot }; };
const modelOf = (id) => MODELS.find((m) => m.id === id) || MODELS[0];
const resultById = (id) => State.results.find((r) => r.id === id);
const jobById = (id) => State.jobs.find((j) => j.id === id);
const modelsOf = (type) => MODELS.filter((m) => m.type === type);
const resultsOfJob = (j) => j.results.map(resultById).filter(Boolean);
const spentTotal = () => round1(State.wallet.spent.image + State.wallet.spent.video + State.wallet.spent.audio);
const balance = () => round1(State.wallet.balance);
const dailyFreeLeft = () => round1(Math.max(0, State.wallet.dailyFree - State.wallet.dailyUsed));
const thumbPath = (r) => `assets/thumbs/${r.asset}.webp`;
const fullPath = (r) => `assets/results/${r.asset}.png`;
const refThumb = (f) => `assets/thumbs/${f}.webp`;

/* 单价与预估消耗 */
function unitPrice(type, p) {
  const m = modelOf(p.model);
  if (type === 'image') {
    return round1(m.price * resoOf(p.res).mul * (p.count || 1));
  }
  if (type === 'video') return round1(m.price * (p.dur || 5));
  if (p.use === 'sfx') return m.price;
  return round1(m.price * Math.max(1, Math.ceil((p.dur || 30) / 30)));
}
const estCost = () => unitPrice(State.type, State.params[State.type]);
const costEnough = () => estCost() <= round1(balance() + dailyFreeLeft());

/* 计费口径：任务创建即扣费；取消（排队或生成中）一律退回；重跑重新扣费。
   用 charged 标记保证「取消 → 重跑」的净支出正好等于一次费用，不会双重扣费。 */
function chargeJob(j) {
  if (j.charged) return false;
  /* 先用当日免费点数抵扣，剩余从余额扣 */
  const free = Math.min(dailyFreeLeft(), j.cost);
  if (free > 0) {
    State.wallet.dailyUsed = round1(State.wallet.dailyUsed + free);
    j.usedFree = free;
  }
  State.wallet.balance = round1(State.wallet.balance - (j.cost - free));
  State.wallet.spent[j.type] = round1(State.wallet.spent[j.type] + j.cost);
  wsOf(j.ws).used = round1(wsOf(j.ws).used + j.cost);
  j.charged = true;
  return true;
}
function refundJob(j) {
  if (!j.charged) return false;
  if (j.usedFree) {
    State.wallet.dailyUsed = Math.max(0, round1(State.wallet.dailyUsed - j.usedFree));
    j.usedFree = 0;
  }
  State.wallet.balance = round1(State.wallet.balance + (j.cost - (j.usedFree || 0)));
  State.wallet.spent[j.type] = Math.max(0, round1(State.wallet.spent[j.type] - j.cost));
  wsOf(j.ws).used = Math.max(0, round1(wsOf(j.ws).used - j.cost));
  j.charged = false;
  return true;
}

/* 只重绘主区并保留输入焦点（防连点解锁一类的局部刷新用） */
function renderMainKeepFocus() {
  const a = document.activeElement;
  const key = a && a.dataset ? a.dataset.input : null;
  const sel = a && a.selectionStart != null ? a.selectionStart : null;
  renderMain();
  if (key) {
    const el = document.querySelector(`[data-input="${key}"]`);
    if (el) {
      el.focus();
      if (sel != null) { try { el.setSelectionRange(sel, sel); } catch (_) { } }
    }
  }
}

/* 预计耗时：把"要等多久"提前说清楚，降低生成后的等待焦虑（本地模拟） */
function estTime(type, p) {
  const m = modelOf(p.model);
  let sec;
  if (type === 'image') {
    const per = m.id === 'm-img-f2' ? 4 : 40;
    const qmul = p.res === '4k' ? 2.2 : p.res === '1080p' ? 0.7 : 1;
    sec = per * (p.count || 1) * qmul;
  } else if (type === 'video') {
    sec = (m.id === 'm-vid-f1' ? 6 : 44) * (p.dur || 5);
  } else {
    sec = p.use === 'sfx' ? 10 : Math.round((p.dur || 30) * 1.2);
  }
  sec = Math.max(5, Math.round(sec / 5) * 5);
  return sec < 60 ? `约 ${sec} 秒` : `约 ${Math.round(sec / 60)} 分钟`;
}

const queueJobs = () => State.jobs.filter((j) => ['running', 'queued', 'failed'].includes(j.status));
const runningJob = () => State.jobs.find((j) => j.status === 'running');
const failJobs = () => State.jobs.filter((j) => j.status === 'failed');
const sortByTime = (a, b) => (a.dateKey === b.dateKey ? (a.time < b.time ? 1 : -1) : a.dateKey === 'today' ? -1 : 1);
const wsJobs = () => State.jobs.filter((j) => j.ws === State.ws);

/* 产出的三段流转：收件箱（最新生成）→ 画布（拖入后加工）→ 素材库（确认保存）；
   没被拖进画布的收件箱内容在下一次生成时自动沉入草稿箱。 */
const inboxResults = () => State.results.filter((r) => r.home === 'inbox' && r.ws === State.ws);
const libResults = () => State.results.filter((r) => r.home === 'library');
const draftResults = () => State.results.filter((r) => r.home === 'draft');
const inScope = (r) => State.libScope === 'all' || r.ws === State.ws;
const scopeLib = () => libResults().filter(inScope);
const scopePosts = () => State.posts.filter((p) => State.libScope === 'all' || p.ws === State.ws);
const nowHHMM = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const scopeDraft = () => draftResults().filter(inScope);
const savedToLib = (rid) => {
  const r = resultById(rid);
  return !!r && r.home === 'library';
};

/* 新一批生成前调用：上一批还在收件箱、没被拖进画布的，视为废弃 */
function settleInbox(ws) {
  let n = 0;
  State.results.forEach((r) => {
    if (r.home === 'inbox' && (!ws || r.ws === ws)) { r.home = 'draft'; n += 1; }
  });
  return n;
}

const filteredResults = () => State.results.filter((r) => {
  if (r.home !== 'library') return false;
  if (State.libScope === 'ws' && r.ws !== State.ws) return false;
  if (State.libFilter === 'image' || State.libFilter === 'video' || State.libFilter === 'audio') return r.type === State.libFilter;
  if (State.libFilter === 'adopted') return r.status === 'adopted';
  if (State.libFilter === 'fav') return r.status === 'fav';
  return true;
}).filter((r) => {
  if (!State.libSearch) return true;
  const j = jobById(r.job);
  const hay = `${r.title} ${j ? j.prompt : ''} ${r.tags.join(' ')}`.toLowerCase();
  return hay.includes(State.libSearch.toLowerCase());
});

const chipOf = (st) => {
  const map = {
    succeeded: ['success', '成功'], running: ['info', '生成中'], queued: ['warn', '排队中'],
    failed: ['danger', '失败'], canceled: ['neutral', '已取消'],
  };
  const [cls, label] = map[st] || map.queued;
  return `<span class="chip ${cls}"><span class="cdot"></span>${label}</span>`;
};
const typeChip = (t) => `<span class="chip ${t === 'image' ? 'brand' : t === 'video' ? 'ai' : 'info'}">${icon(TYPES[t].ic)}${TYPES[t].name}</span>`;
const jobIconCls = (t) => (t === 'image' ? 'violet' : t === 'video' ? 'blue' : 'amber');
const promptBrief = (j) => (j.prompt.length > 44 ? j.prompt.slice(0, 44) + '…' : j.prompt);

function paramsBrief(j) {
  if (j.type === 'image') return `${j.ratio} · ${j.count} 张 · ${resoOf(j.res).n}`;
  if (j.type === 'video') return `${j.ratio} · ${j.dur}s · ${j.cam}`;
  const v = j.use === 'tts' ? (VOICES.find((x) => x.k === j.voice) || {}).n
    : j.use === 'music' ? (MOODS.find((x) => x.k === j.mood) || {}).n : '短音效';
  return `${j.use === 'tts' ? '配音' : j.use === 'music' ? '音乐' : '音效'} · ${j.dur}s · ${v}`;
}

const todos = () => ({
  fail: failJobs().length,
  queue: State.jobs.filter((j) => j.status === 'running' || j.status === 'queued').length,
});

/* ============================ 5. 顶栏 ============================ */
function renderTopbar() {
  const w = wsOf(State.ws);
  const menu = State.wsMenu ? `
    <div class="ws-menu">
      <div class="wm-head">切换项目</div>
      ${WORKSPACES.map((x) => {
    const f = State.jobs.filter((j) => j.ws === x.id && j.status === 'failed').length;
    return `<button data-action="pick-ws" data-id="${x.id}" class="${x.id === State.ws ? 'active' : ''}">
          <span class="ws-dot" style="background:${x.dot}"></span>${esc(x.name)}
          <span class="wm-meta">${f ? `<span class="text-red">失败 ${f}</span>` : '<span class="dim">正常</span>'} <span class="dim">· 已用 ${x.used} 点</span></span>
        </button>`;
  }).join('')}
      <div style="height:1px;background:var(--border);margin:5px 4px"></div>
      <div class="wm-sum">个人账户 · 余额 ${balance()} 点 · 累计消耗 ${spentTotal()} 点</div>
    </div>` : '';

  $('#contextBar').innerHTML = `
    <div class="context-bar">
      <div class="ws-select">
        <button class="ws-btn" data-action="toggle-ws-menu">
          <span class="ws-dot" style="background:${w.dot}"></span>${esc(w.name)}${icon('chev-down')}
        </button>
        ${menu}
      </div>
    </div>`;

  const t = todos();
  const chips = [];
  if (t.fail) chips.push(`<button class="todo-chip danger pulse" data-action="todo-fail">
    <span class="tdot"></span><span class="tnum num">${t.fail}</span><span class="tlabel">失败</span></button>`);
  if (t.queue) chips.push(`<button class="todo-chip info" data-action="todo-queue">
    <span class="tdot"></span><span class="tnum num">${t.queue}</span><span class="tlabel">队列</span></button>`);
  if (!chips.length) chips.push(`<span class="todo-chip all-clear"><span class="tdot"></span>没有进行中的任务</span>`);
  $('#todoGroup').innerHTML = chips.join('');

  const bal = balance();
  const low = bal < 3;
  const bc = $('#balanceChip');
  bc.className = `balance-chip ${low ? 'low' : ''}`;
  bc.innerHTML = `${icon('coins')}<span class="bc-num num">${bal}</span><span class="bc-unit">点</span>
    <span class="bc-topup">${low ? '去充值' : '充值'}</span>`;
}

/* ============================ 6. 侧栏 ============================ */
function renderSidebar() {
  const openJobs = State.jobs.filter((j) => j.status === 'running' || j.status === 'queued').length;
  $('#sidebar').innerHTML = `
    <div class="side-sec">
      <div class="side-sec-title">创作</div>
      ${Object.values(TYPES).map((x) => {
    const active = State.page === 'studio' && State.type === x.key;
    const n = libResults().filter((r) => r.type === x.key && r.ws === State.ws).length;
    return `<button class="side-item ${active ? 'active' : ''}" data-action="pick-type" data-type="${x.key}">
          ${icon(x.ic)}<span class="side-label">${x.name}创作</span>
          <span class="side-badge num">${n}</span></button>`;
  }).join('')}
    </div>
    <div class="side-sec">
      <div class="side-sec-title">我的</div>
      <button class="side-item ${State.page === 'jobs' ? 'active' : ''}" data-action="switch-page" data-page="jobs">
        ${icon('list')}<span class="side-label">任务记录</span>
        ${openJobs ? `<span class="side-badge blue num">${openJobs}</span>` : ''}</button>
      <button class="side-item ${State.domain === 'library' ? 'active' : ''}" data-action="open-domain" data-domain="library">
        ${icon('inbox')}<span class="side-label">素材库</span>
        <span class="side-badge num">${libResults().length}</span></button>
      <button class="side-item ${State.page === 'aesthetic' ? 'active' : ''}" data-action="open-aesthetic">
        ${icon('star')}<span class="side-label">审美库</span>
        <span class="side-badge num">${State.aesthetic.length}</span></button>
    </div>
    <div class="side-sec">
      <div class="side-sec-title">开发与计费</div>
      <button class="side-item ${State.page === 'api' ? 'active' : ''}" data-action="open-api">
        ${icon('cpu')}<span class="side-label">API 接入</span></button>
      <button class="side-item ${State.domain === 'models' ? 'active' : ''}" data-action="open-domain" data-domain="models">
        ${icon('coins')}<span class="side-label">模型与价格</span></button>
    </div>
    <div class="side-spacer"></div>
    <div class="side-foot">${icon('coins')}<span>1 点 = ¥1 · 按次扣费 · 点数不过期；原型内的生成、播放与扣费为本地模拟。</span></div>`;
}

/* ============================ 7. 主区 ============================ */
function renderMain() {
  if (State.page === 'jobs') { $('#main').innerHTML = renderJobsPage(); return; }
  if (State.page === 'domain') { $('#main').innerHTML = renderDomain(); return; }
  if (State.page === 'api') { $('#main').innerHTML = renderApi(); return; }
  if (State.page === 'aesthetic') { $('#main').innerHTML = renderAesthetic(); return; }
  $('#main').innerHTML = renderStudio();
}

function renderStudio() {
  const T = TYPES[State.type];
  const editing = State.studioTab === 'edit';
  return `<div class="page">
    <div class="studio-head">
      <span class="task-ic ${jobIconCls(State.type)}">${icon(T.ic)}</span>
      <div class="page-title-block">
        <span class="page-title">${T.name}创作</span>
        <span class="page-sub">${editing ? '选一条已有产出做基础处理，保存后成为新产出' : T.hint + ' · 写一句提示词就能生成'}</span>
      </div>
      <span class="grow"></span>
      <button class="btn ghost" data-action="open-library-type">${icon('inbox')}${T.name}素材 ${libResults().filter((r) => r.type === State.type && r.ws === State.ws).length}</button>
      <button class="btn ghost" data-action="open-queue">${icon('clock')}队列${queueJobs().length ? ` ${queueJobs().length}` : ''}</button>
      <div class="studio-tabs">
        <button class="${editing ? '' : 'on'}" data-action="set-studio-tab" data-tab="gen">${icon('wand')}生成</button>
        <button class="${editing ? 'on' : ''}" data-action="set-studio-tab" data-tab="edit">${icon('crop')}编辑</button>
      </div>
    </div>
    ${editing ? `<div class="solo-col">${renderEditPage()}</div>`
      : `<div class="studio-split ${State.canvasOpen ? '' : 'cvs-closed'} ${State.cvsFull ? 'cvs-full' : ''} ${State.formOpen ? '' : 'form-closed'}">
        <div class="split-main">${State.formOpen ? renderComposer() : formStrip()}</div>
        <div class="split-side" id="canvasHost">${canvasPanel()}</div>
      </div>
      ${agentDockHTML()}`}
  </div>`;
}

/* ---------- 6.8 系列一致性：把一张图钉成风格基准 ----------
   一次活动要出 9 张风格统一的图，靠「每次重新描述」是做不到的。
   钉一个基准之后，后续每次生成都自动带上它作参考，并沿用它的参数。 */
const anchorItem = () => {
  const a = State.styleAnchor;
  if (!a) return null;
  return canvasItems().find((i) => i.id === a.cvsId) || null;
};

function anchorBarHTML() {
  const a = State.styleAnchor;
  if (!a) return '';
  const it = anchorItem();
  if (!it) return '';
  const p = State.params[State.type];
  return `<div class="anchor-bar">
    <span class="anchor-thumb"><img src="${esc(cvsSrc(it))}" alt="" /></span>
    <div class="anchor-txt">
      <b>${icon('bookmark')}风格基准 · ${esc(it.t)}</b>
      <span>每次生成都会带上它作参考，参数沿用 ${anchorParamText(a)}</span>
    </div>
    <span class="grow"></span>
    <button class="btn sm ghost" data-action="anchor-apply">${icon('refresh')}应用参数</button>
    <button class="btn sm ghost" data-action="anchor-toggle" data-id="${it.id}">${icon('x')}取消</button>
  </div>`;
}

const anchorParamText = (a) => {
  if (!a || !a.params) return '';
  if (a.params.type === 'image') return `${a.params.ratio} · ${resoOf(a.params.res).n}`;
  if (a.params.type === 'video') return `${a.params.ratio} · ${a.params.dur}s`;
  return `${a.params.dur}s`;
};

/* 生成时把基准塞进参考素材与参数，用户不用每次手动加 */
function anchorInto(p, type) {
  const a = State.styleAnchor;
  const it = anchorItem();
  if (!a || !it || a.params.type !== type) return;
  if (it.f && !State.refs[type].some((r) => r.f === it.f)) {
    if (State.refs[type].length < 4) State.refs[type].unshift({ f: it.f, w: 0.75, from: 'anchor' });
  }
  Object.assign(p, a.params);
}

/* ---------- 6.9 平台尺寸：一条内容要发几个地方 ---------- */
const PLATFORMS = [
  { k: 'xhs', n: '小红书', ratio: '3:4', note: '封面 3:4，竖版信息流', ic: 'image' },
  { k: 'douyin', n: '抖音', ratio: '9:16', note: '全屏竖版，主体居中', ic: 'video' },
  { k: 'wechat', n: '公众号', ratio: '16:9', note: '头图横版，左右留白', ic: 'link' },
  { k: 'weibo', n: '微博', ratio: '4:3', note: '横版信息流', ic: 'send' },
  { k: 'square', n: '方图通用', ratio: '1:1', note: '头像 / 商品卡 / 多平台兜底', ic: 'grid' },
];

/* ---------- 7.0 发散：从一个想法展开多个方向 ----------
   和「变体」的区别：变体是同一方向再采样几张，发散是沿不同轴各试一个方向。
   创意发散要的是方差，不是精度。 */
const DIVERGE_AXES = [
  { k: 'style', n: '换风格', d: '主体不变，换一种视觉语言', add: '改为手绘插画风格，笔触松弛、边缘不规则' },
  { k: 'light', n: '换光线', d: '主体不变，换一种打光', add: '改为冷调侧光，明暗对比更强，阴影更硬' },
  { k: 'angle', n: '换视角', d: '主体不变，换一个机位', add: '改为俯拍平铺视角，画面更规整、留白更均匀' },
  { k: 'scene', n: '换场景', d: '主体放进不同环境', add: '放进自然光下的生活场景，加入环境元素与人物痕迹' },
  { k: 'subject', n: '换主体', d: '风格不变，换一个主体', add: '主体换为同品类的其他对象，保持原有色调、光线与构图' },
  { k: 'format', n: '换画幅', d: '同一画面换一种构图', add: '改为竖版构图，主体偏上，下方留出大片文字安全区' },
];

/* 单个方向的花费：和正式生成同一套单价算法 */
function divergeUnitCost(type) {
  const p = State.params[type];
  const m = modelOf(p.model);
  if (type === 'image') return round1(m.price * resoOf(p.res).mul);
  if (type === 'video') return round1(m.price * (p.dur || 5));
  if (p.use === 'sfx') return m.price;
  return round1(m.price * Math.max(1, Math.ceil((p.dur || 30) / 30)));
}

function divergeSource() {
  const d = State.diverge;
  if (!d) return null;
  return canvasItems().find((i) => i.id === d.srcId) || null;
}

/* 从来源元素拼出一条基础提示词：优先用它的原始提示词，其次用标题 */
function divergeBase(it) {
  if (it && it.rid) {
    const r = resultById(it.rid);
    const j = r ? jobById(r.job) : null;
    if (j && j.prompt) return j.prompt;
  }
  return (it && it.t) || '';
}

/* 平台适配：同一画面按各平台比例重新生成一版。
   不是裁剪——裁剪会把主体裁掉，这里是为每个比例重新构图。 */
function platformPanel() {
  const d = State.platforms;
  if (!d) return '';
  const it = canvasItems().find((i) => i.id === d.srcId);
  if (!it) return '';
  const picked = d.picks.length;
  const unit = divergeUnitCost(it.type);
  const cost = round1(unit * picked);
  return `<div class="diverge-panel">
    <div class="diverge-head">
      <span class="diverge-ic">${icon('crop')}</span>
      <div class="diverge-title"><b>适配多平台</b><span>从「${esc(it.t)}」按各平台比例各出一版</span></div>
      <span class="grow"></span>
      <button class="icon-btn" data-action="platforms-close">${icon('x')}</button>
    </div>
    <div class="diverge-body">
      <div class="diverge-base">${icon('pen')}<span>${esc(divergeBase(it).slice(0, 70))}${divergeBase(it).length > 70 ? '…' : ''}</span></div>
      <div class="diverge-axes">
        ${PLATFORMS.map((pf) => `<button class="diverge-axis ${d.picks.includes(pf.k) ? 'on' : ''}"
          data-action="platforms-toggle" data-val="${pf.k}">
          <span class="da-check">${d.picks.includes(pf.k) ? icon('check') : ''}</span>
          <span class="da-main"><b>${icon(pf.ic)}${pf.n} · ${pf.ratio}</b><span>${pf.note}</span></span>
        </button>`).join('')}
      </div>
      <div class="diverge-note">${icon('alert')}<span>每个比例都是**重新构图**，不是把原图裁一刀——裁剪会把主体切掉，重出才能保证每个尺寸都成立。</span></div>
    </div>
    <div class="diverge-foot">
      <span class="diverge-cost">${picked ? `${picked} 个平台 · 约 ${cost} 点` : '先选平台'}</span>
      <span class="grow"></span>
      <button class="btn sm ghost" data-action="platforms-close">取消</button>
      <button class="btn sm primary ${picked ? '' : 'disabled'}" data-action="platforms-run">${icon('wand')}开始适配</button>
    </div>
  </div>`;
}

function divergePanel() {
  const d = State.diverge;
  if (!d) return '';
  const it = divergeSource();
  if (!it) return '';
  const picked = d.axes.length;
  const cost = round1(picked * divergeUnitCost(it.type));
  return `<div class="diverge-panel">
    <div class="diverge-head">
      <span class="diverge-ic">${icon('sparkles')}</span>
      <div class="diverge-title"><b>发散</b><span>从「${esc(it.t)}」沿不同方向各试一个</span></div>
      <span class="grow"></span>
      <button class="icon-btn" data-action="diverge-close">${icon('x')}</button>
    </div>
    <div class="diverge-body">
      <div class="diverge-base">${icon('pen')}<span>${esc(divergeBase(it).slice(0, 70))}${divergeBase(it).length > 70 ? '…' : ''}</span></div>
      <div class="diverge-axes">
        ${DIVERGE_AXES.map((a) => `<button class="diverge-axis ${d.axes.includes(a.k) ? 'on' : ''}"
          data-action="diverge-toggle" data-val="${a.k}">
          <span class="da-check">${d.axes.includes(a.k) ? icon('check') : ''}</span>
          <span class="da-main"><b>${a.n}</b><span>${a.d}</span></span>
        </button>`).join('')}
      </div>
      <div class="diverge-note">${icon('alert')}<span>发散出来的是不同方向，不是同一张图的多次采样——要精度用「变体」，要可能性用发散。</span></div>
    </div>
    <div class="diverge-foot">
      <span class="diverge-cost">${picked ? `${picked} 个方向 · 约 ${cost} 点` : '先选方向'}</span>
      <span class="grow"></span>
      <button class="btn sm ghost" data-action="diverge-close">取消</button>
      <button class="btn sm primary ${picked ? '' : 'disabled'}" data-action="diverge-run">${icon('wand')}开始发散</button>
    </div>
  </div>`;
}

/* ---------- 7.1 Agent：读画板，理需求，出提示词 ----------
   Agent 不是凭空聊天，它的依据是画板上的东西：产出的原始提示词、参考图的标题、
   网页与文档的存在。把这些汇总成「你在做什么」和「可以怎么写」。 */
const AGENT_STOP = /^(的|了|和|与|在|是|有|把|被|用|给|让|一个|一张|我们|你们|他们|这个|那个|可以|需要|想要|以及|并且|然后|因为|所以)$/;

/* Agent 的分析范围：有选中就只看选中的，没有才看整块画板。
   画板允许有冗余信息——那正是「暂存」的意义，但生成/发散时不该被它干扰。 */
function agentScope() {
  const sel = canvasSelItems();
  if (sel.length) return { items: sel, scoped: true };
  return { items: canvasItems(), scoped: false };
}

function agentReadBoard() {
  const scope = agentScope();
  const items = scope.items;
  const media = items.filter((i) => i.kind === 'media');
  const webs = items.filter((i) => i.kind === 'web');
  const files = items.filter((i) => i.kind === 'file');
  const draws = items.filter((i) => i.kind === 'draw');
  const posts = items.filter((i) => i.kind === 'post');
  const nodes = items.filter((i) => i.kind === 'node');
  const groups = items.filter((i) => i.kind === 'group');

  /* 连线：谁连谁。被连最多的那个就是这组的枢纽——它通常是基准 */
  const idSet = new Set(items.map((i) => i.id));
  const links = canvasLinks().filter((l) => idSet.has(l.from) && idSet.has(l.to));
  const inDeg = {};
  links.forEach((l) => { inDeg[l.to] = (inDeg[l.to] || 0) + 1; });
  const hub = Object.keys(inDeg).sort((a, b) => inDeg[b] - inDeg[a])[0] || null;
  const hubItem = hub ? items.find((i) => i.id === hub) : null;
  /* 节点用的是 text，素材用的是 t，取名字要兼容 */
  const hubName = hubItem ? (hubItem.t || hubItem.text || '未命名元素') : '';
  /* 节点文字是用户亲手写的，比从历史提示词里统计高频词可靠 */
  /* 节点和文字都是用户亲手写的话，Agent 一视同仁地读 */
  const nodeTexts = items
    .filter((i) => i.kind === 'node' || i.kind === 'text')
    .map((i) => (i.text || '').trim()).filter(Boolean);

  /* 有来源任务的元素，能读到当时那条提示词——这是最可靠的需求信号 */
  const prompts = [];
  media.forEach((i) => {
    if (!i.rid) return;
    const r = resultById(i.rid);
    const j = r ? jobById(r.job) : null;
    if (j && j.prompt) prompts.push({ p: j.prompt, t: i.t, type: j.type, model: j.model, ratio: j.ratio, res: j.res, dur: j.dur, cam: j.cam, use: j.use });
  });

  /* 先定主流类型：画板上最多的那种，后面所有推断都以它为准 */
  const types = {};
  media.forEach((i) => { types[i.type] = (types[i.type] || 0) + 1; });
  const mainType = Object.keys(types).sort((a, b) => types[b] - types[a])[0] || State.type;
  /* 聚焦同类型的提示词；同类型不足两条时再放宽，避免只靠一条过度拟合 */
  const sameType = prompts.filter((x) => x.type === mainType);
  const focus = sameType.length >= 2 ? sameType : prompts;

  /* 关键词频次：从提示词里挑出反复出现的词，用来判断「在做什么」 */
  const freq = {};
  focus.forEach(({ p }) => {
    p.split(/[，,。.；;：:\s、]+/).forEach((seg) => {
      const w = seg.trim();
      if (w.length < 2 || w.length > 8 || AGENT_STOP.test(w)) return;
      freq[w] = (freq[w] || 0) + 1;
    });
  });
  const topWords = Object.keys(freq).sort((a, b) => freq[b] - freq[a]).slice(0, 6);

  const typeText = Object.keys(types).map((k) => `${types[k]} 张${TYPES[k].name}`).join('、');

  /* 需求理解：节点文字最优先（用户亲手写的），其次才是提示词高频词 */
  const nodeKeywords = [];
  nodeTexts.forEach((t) => {
    t.split(/[，,。.；;：:\s、]+/).forEach((w) => {
      const x = w.trim();
      if (x.length >= 2 && x.length <= 8 && !AGENT_STOP.test(x)) nodeKeywords.push(x);
    });
  });
  const subjects = nodeKeywords.length ? nodeKeywords.slice(0, 3) : topWords.slice(0, 3);
  const guess = subjects.length
    ? subjects.join(' · ')
    : (media[0] && media[0].t) || (files[0] && files[0].t) || '还没有足够的线索';

  /* 建议提示词：把画板上出现过的描述综合成一条新的 */
  let draft = '';
  if (nodeTexts.length) {
    /* 用户亲手写的节点文字最准，直接作为提示词主干 */
    draft = nodeTexts.slice(0, 3).join('，');
  }
  if (focus.length) {
    const base = focus.map((x) => x.p).join('。');
    const parts = [];
    const seen = new Set();
    base.split(/[，,。.；;]+/).forEach((cl) => {
      const w = cl.trim();
      if (w.length < 2 || w.length > 14) return;
      const key = w.slice(0, 4);
      if (seen.has(key)) return;
      seen.add(key);
      parts.push(w);
    });
    draft = parts.slice(0, 7).join('，');
  } else if (!draft && media.length) {
    draft = media.map((i) => i.t).filter(Boolean).slice(0, 4).join('，');
  }

  /* 参数建议：跟随画板上最主流的那个类型 */
  const paramSrc = prompts.find((x) => x.type === mainType);
  const params = {};
  if (mainType === 'image') {
    params.ratio = (paramSrc && paramSrc.ratio) || '1:1';
    params.count = 4;
    params.res = (paramSrc && paramSrc.res) || '2k';
  } else if (mainType === 'video') {
    params.ratio = (paramSrc && paramSrc.ratio) || '9:16';
    params.dur = (paramSrc && paramSrc.dur) || 5;
    params.cam = (paramSrc && paramSrc.cam) || '推近';
  } else {
    params.use = (paramSrc && paramSrc.use) || 'tts';
    params.dur = (paramSrc && paramSrc.dur) || 30;
  }

  const notes = [];
  if (groups.length) notes.push(`${groups.length} 个分组：${groups.map((g) => g.t || '未命名').join('、')}`);
  const namedLinks = links.filter((l) => l.label);
  if (links.length) notes.push(`${links.length} 条连线${hubName ? `，枢纽是「${hubName}」（被连 ${inDeg[hub]} 次）` : ''}`);
  if (namedLinks.length) {
    notes.push(`${namedLinks.length} 条线写了名字：${namedLinks.map((l) => `「${l.label}」`).join('、')}`);
  }
  if (nodeTexts.length) notes.push(`${nodeTexts.length} 处写着：${nodeTexts.map((t) => `「${t}」`).join('、')}`);
  if (webs.length) notes.push(`${webs.length} 个网页参考（${webs.map((w) => cvsHost(w.url)).join('、')}）`);
  if (files.length) notes.push(`${files.length} 份文档`);
  if (draws.length) notes.push(`${draws.length} 处手绘标注`);
  /* 社媒帖子单独说，因为运营真正关心的是它——「这条为什么爆」 */
  const postLines = posts.map((p) => {
    const pf = postPlatformOf(p.url);
    return `${pf ? pf.n : '链接'}「${p.t}」${p.like ? ` · ${p.like} 赞` : ''}`;
  });

  return {
    scoped: scope.scoped,
    counts: { media: media.length, webs: webs.length, files: files.length, draws: draws.length, posts: posts.length, prompts: prompts.length, links: links.length, nodes: nodes.length, groups: groups.length },
    typeText, topWords, guess, draft, mainType, params, notes, prompts, postLines, posts,
    nodeTexts, hubItem, hubName, linkCount: links.length, linkLabels: namedLinks.map((l) => l.label),
  };
}

function agentPanel() {
  const a = State.agent;
  if (!a || !a.open || !a.result) return '';
  const r = a.result;
  const total = r.counts.media + r.counts.webs + r.counts.files + r.counts.draws + r.counts.posts;
  return `<div class="agent-head" data-agent-drag>
      <span class="agent-av">${icon('sparkles')}</span>
      <div class="agent-title"><b>Agent · ${r.scoped ? '选区分析' : '画板分析'}</b>
        <span>${r.scoped ? `只看你圈定的 ${total} 个元素` : `基于整块画板的 ${total} 个元素`}</span></div>
      <span class="grow"></span>
      <button class="icon-btn" data-action="agent-open" title="重新分析">${icon('refresh')}</button>
      <button class="icon-btn" data-action="agent-dock" title="${State.agentDock ? '取消停靠' : '停靠到右侧'}">${icon(State.agentDock ? 'expand' : 'grid')}</button>
      <button class="icon-btn" data-action="agent-close" title="收起">${icon('x')}</button>
    </div>
    <div class="agent-body">
      ${!total ? `<div class="agent-empty">${r.scoped ? '选中的东西里没有可读的内容。' : '画板还是空的。'}先把参考图、社媒帖子或文档放上去，Agent 才有东西可读。</div>` : `
      <div class="agent-sec">
        <div class="agent-sec-t">${icon('layers')}我看到的</div>
        <ul class="agent-list">
          ${r.counts.media ? `<li>${r.typeText}${r.counts.prompts ? `，其中 ${r.counts.prompts} 张能追溯到原始提示词` : '，都还没有来源记录'}</li>` : ''}
          ${r.postLines.map((n) => `<li>参考了 ${esc(n)}</li>`).join('')}
          ${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}
        </ul>
      </div>
      <div class="agent-sec">
        <div class="agent-sec-t">${icon('target')}需求理解</div>
        <div class="agent-guess">${(() => {
      const kws = [...new Set([...(r.nodeTexts || []).map((t) => t.slice(0, 8)), ...r.topWords])].slice(0, 6);
      return kws.map((w) => `<span class="agent-kw">${esc(w)}</span>`).join('');
    })()}</div>
        <div class="agent-text">${r.counts.prompts
      ? `${r.scoped ? '你圈定的这块里，' : ''}产出来自 ${r.counts.prompts} 次生成，反复出现的是「${esc(r.guess)}」，看起来这是你要的主方向。`
      : `目前只能从元素标题判断方向：${esc(r.guess)}。补几张有来源的产出，我能读得更准。`}</div>
      ${r.posts && r.posts.length ? `<div class="agent-text">你圈定的范围里有 ${r.posts.length} 条平台内容参考（${r.posts.map((p) => {
        const pf = postPlatformOf(p.url);
        return `${pf ? pf.n : '链接'} ${p.like ? p.like + ' 赞' : ''}`.trim();
      }).join('、')}）。照着这些方向做一版的话，我可以先按它们的结构给提示词。</div>` : ''}
      ${r.linkCount ? `<div class="agent-text">${r.hubName
      ? `范围里有 ${r.linkCount} 条连线，${esc(r.hubName)} 被连得最多，看起来它是这一组的基准。`
      : `范围里有 ${r.linkCount} 条连线，我在按这个结构理解你的意图。`}${(r.linkLabels || []).length ? `你给线写了「${esc(r.linkLabels.join('」「'))}」——这些关系我会照着理解。` : ''}${(r.nodeTexts || []).length ? `另外你在画板上写了「${esc(r.nodeTexts.join('」「'))}」——这几点我会直接带上。` : ''}</div>` : ''}
      </div>
      ${r.draft ? `<div class="agent-sec">
        <div class="agent-sec-t">${icon('pen')}建议提示词</div>
        <div class="agent-draft">${esc(r.draft)}</div>
        <div class="agent-params">${icon('cpu')}按画板主流类型选了「${TYPES[r.mainType].name}」· ${agentParamText(r.mainType, r.params)}</div>
      </div>` : ''}
      `}
    </div>
    ${r.draft ? `<div class="agent-foot">
      <button class="btn sm primary" data-action="agent-apply">${icon('wand')}用它去生成</button>
      <button class="btn sm ghost" data-action="agent-copy">${icon('copy')}复制提示词</button>
      <span class="grow"></span>
      ${r.scoped ? `<button class="btn sm ghost" data-action="agent-scope-all">改用整个画板</button>` : ''}
    </div>` : ''}`;
}

/* Agent 现在是浮在画布上的，不再占表单的纵向空间。
   收起时是一颗悬浮球，展开时是浮层面板，可以拖动，也可以停靠到右侧。 */
function agentDockHTML() {
  const a = State.agent;
  const docked = State.agentDock;
  if (!a || !a.open) {
    const n = State.canvasSel.length;
    const pos = (!docked && State.agentPos) ? `left:${State.agentPos.x}px;top:${State.agentPos.y}px` : '';
    return `<button class="agent-fab ${docked ? 'docked' : ''} ${State.agentPos && !docked ? 'placed' : ''}"
      data-action="agent-open" style="${pos}" title="${n ? `分析选中的 ${n} 个元素` : '让 Agent 看一遍画板'}">
      <span class="agent-av">${icon('sparkles')}</span>
      <span class="af-t">${n ? `分析选中 ${n}` : 'Agent'}</span>
      ${n ? `<span class="af-dot"></span>` : ''}
    </button>`;
  }
  const placed = !docked && State.agentPos;
  const pos = placed ? `left:${State.agentPos.x}px;top:${State.agentPos.y}px` : '';
  return `<div class="agent-float ${docked ? 'docked' : ''} ${placed ? 'placed' : ''}" style="${pos}">
    <div class="agent-panel">${agentPanel()}</div>
  </div>`;
}

function agentParamText(type, p) {
  if (type === 'image') return `${p.ratio} · ${p.count} 张 · ${resoOf(p.res).n}`;
  if (type === 'video') return `${p.ratio} · ${p.dur} 秒 · ${p.cam}`;
  return `${p.dur} 秒 · ${p.use === 'music' ? '音乐' : p.use === 'sfx' ? '音效' : '配音'}`;
}

/* ---------- 7.1 创作面板 ---------- */
function renderComposer() {
  const t = State.type;
  const p = State.params[t];
  const T = TYPES[t];
  const cost = estCost();
  const enough = costEnough();
  const opt = State.optimize;
  const plen = State.prompt[t].trim().length;
  const thin = isThinPrompt(t);
  const seeded = State.prompt[t] === SEED_PROMPTS[t];

  return `<section class="card composer-card">
    <div class="composer-head">
      <span class="task-ic ${jobIconCls(t)}">${icon(T.ic)}</span>
      <div>
        <div class="ch-title">新建生成 · ${T.name}</div>
        <div class="ch-sub">写提示词 → 调整必要参数 → 进队列</div>
      </div>
      <span class="grow"></span>
      <button class="icon-btn" data-action="toggle-form" title="收起生成表单，只留画布（[）">${icon('chev-left')}</button>
    </div>
    <div class="composer-body">

      <div class="field-block">
        ${anchorBarHTML()}
        <div class="field-head">
          <span class="field-label">${icon('pen')}提示词</span>
          ${seeded ? `<span class="chip outline">${icon('sparkles')}示例内容，可直接改或清空</span>` : ''}
          ${opt ? `<span class="ai-suggest">${icon('sparkles')}优化建议待应用</span>` : ''}
          <span class="grow"></span>
          <button class="btn sm ai" data-action="ai-optimize">${icon('sparkles')}${thin ? '帮我写详细' : '补充细节'}</button>
        </div>
        <div class="prompt-box">
          <textarea class="prompt-input" data-input="prompt" placeholder="描述画面 / 镜头 / 声音：主体、场景、光线、材质、运镜、语气…">${esc(State.prompt[t])}</textarea>
          <div class="prompt-foot">
            <button class="btn sm ghost" data-action="clear-prompt">${icon('x')}清空</button>
            <button class="btn sm ghost" data-action="copy-prompt">${icon('copy')}复制</button>
            <span class="prompt-count" id="promptCount">${plen} 字 · ${thin ? '写一句大白话就行，点右上「帮我写详细」' : '描述已足够完整'}</span>
          </div>
        </div>
        ${opt ? renderOptimizeBox(opt) : ''}
      </div>

      <div class="field-block ref-block" data-ref-drop>
        <div class="field-head"><span class="field-label">${icon('upload')}参考素材</span>
          <span class="field-hint">${State.refs[t].length} / 4 · 从画布拖过来，或点缩略图切换参考强度</span></div>
        <div class="ref-row">
          ${State.refs[t].map((r, i) => `
            <div class="ref-thumb" data-action="cycle-ref" data-idx="${i}" title="点击调整参考强度">
              <img src="${refThumb(r.f)}" alt="参考素材" />
              <span class="rf-weight">${r.w.toFixed(2)}</span>
              ${r.from === 'canvas' ? `<span class="rf-from">画布</span>` : ''}
              <span class="rf-x" data-action="remove-ref" data-idx="${i}">${icon('x')}</span>
            </div>`).join('')}
          ${State.refs[t].length < 4 ? `<button class="ref-add" data-action="add-ref" title="添加参考素材">${icon('plus')}</button>` : ''}
        </div>
        <div class="ref-note">${icon('shield')}初始为示例素材，可以换成你自己的图；参考图只用于本次生成，不会进入素材库。</div>
      </div>

      ${renderParams(t, p)}

      <div class="adv-toggle ${State.adv ? 'open' : ''}" data-action="toggle-adv">
        ${icon('chev-right')}高级参数${State.adv ? '' : (t === 'image' ? '（负面提示 · 种子 · 导出格式）' : t === 'video' ? '（负面提示 · 帧率 · 循环点）' : '（负面提示 · 输出音量）')}
      </div>
      ${State.adv ? renderAdv(t, p) : ''}

      <div class="cost-row">
        <div class="cost-box"><span class="ck">本次消耗</span><span class="cv num" style="color:${enough ? 'var(--t1)' : 'var(--red)'}">${cost} 点</span></div>
        <div class="cost-sep"></div>
        <div class="cost-box"><span class="ck">余额</span><span class="cv num">${balance()}</span></div>
        <div class="cost-sep"></div>
        <div class="cost-box"><span class="ck">预计耗时</span><span class="cv num" style="font-size:14px">${estTime(t, p)}</span></div>
        <span class="grow"></span>
        <span class="tiny dim">${dailyFreeLeft() > 0
      ? `今日免费 ${dailyFreeLeft()} 点优先抵扣`
      : '1 点 = ¥1 · 生成失败自动退回'}</span>
      </div>

      ${State.genLock
      ? `<button class="btn primary gen-btn" disabled style="opacity:.7">${icon('check')}已加入队列</button>`
      : enough
        ? `<button class="btn primary gen-btn" data-action="gen">${icon('send')}生成${t === 'image' ? ` ${p.count} 张` : ` ${p.dur}s`} · ${cost} 点</button>`
        : `<button class="btn primary gen-btn" data-action="open-topup" style="background:var(--amber)">${icon('coins')}点数不足 · 去充值</button>`}
      <div class="tiny dim">生成后进入队列，可继续写下一条，不必等待完成。</div>
    </div>
  </section>`;
}

function renderOptimizeBox(opt) {
  const expand = opt.mode === 'expand';
  return `<div class="diff-box" style="margin-top:8px">
    <div class="diff-row"><span class="diff-key">${expand ? '改写后' : '优化方向'}</span>
      <span class="diff-val">${expand
      ? `<span class="diff-new">${esc(opt.result)}</span>`
      : `<span class="diff-plain">${esc(opt.note)}</span>`}</span></div>
    ${expand ? '' : `<div class="diff-row"><span class="diff-key">建议追加</span>
      <span class="diff-val"><span class="diff-new">+ ${esc(opt.add)}</span></span></div>`}
    <div class="diff-row"><span class="diff-key">建议负面词</span>
      <span class="diff-val"><span class="diff-plain">${esc(opt.neg)}</span></span></div>
    <div class="diff-row"><span class="diff-key">操作</span>
      <span class="diff-val">
        <button class="btn sm primary" data-action="apply-optimize">${icon('check')}${expand ? '用这段提示词' : '应用到提示词'}</button>
        <button class="btn sm ghost" data-action="dismiss-optimize">忽略</button>
      </span></div>
  </div>`;
}

function renderParams(t, p) {
  if (t === 'image') {
    return `<div class="field-block">
      ${PARAM_NOTE}
      <div class="field-head"><span class="field-label">${icon('cpu')}模型</span><span class="field-hint">${esc(modelOf(p.model).note)}</span></div>
      ${modelSelect(t, p.model)}
      <div class="form-row"><span class="form-label">比例</span>
        <div class="opt-pills">${RATIOS.map((r) => `<button class="opt-pill ${p.ratio === r.k ? 'on' : ''}" data-action="set-param" data-key="ratio" data-val="${r.k}">${icon('crop')}${r.n}</button>`).join('')}</div></div>
      <div class="form-row"><span class="form-label">数量</span>
        <div class="opt-pills">${[1, 2, 4].map((n) => `<button class="opt-pill ${p.count === n ? 'on' : ''}" data-action="set-param" data-key="count" data-val="${n}">${n} 张</button>`).join('')}</div></div>
      <div class="form-row"><span class="form-label">分辨率<span class="fl-hint">该模型最高 ${resoOf(modelOf(p.model).maxRes).n}</span></span>
        <div class="opt-pills">${RESOS.map((q) => `<button class="opt-pill ${p.res === q.k ? 'on' : ''}" data-action="set-param" data-key="res" data-val="${q.k}" title="${q.px}">${q.n}${q.mul !== 1 ? ` ×${q.mul}` : ''}</button>`).join('')}</div></div>
    </div>`;
  }
  if (t === 'video') {
    return `<div class="field-block">
      ${PARAM_NOTE}
      <div class="field-head"><span class="field-label">${icon('cpu')}模型</span><span class="field-hint">${esc(modelOf(p.model).note)}</span></div>
      ${modelSelect(t, p.model)}
      <div class="form-row"><span class="form-label">比例</span>
        <div class="opt-pills">${[['9:16', '竖版 9:16'], ['16:9', '横版 16:9'], ['1:1', '方形 1:1']].map(([k, n]) => `<button class="opt-pill ${p.ratio === k ? 'on' : ''}" data-action="set-param" data-key="ratio" data-val="${k}">${n}</button>`).join('')}</div></div>
      <div class="form-row"><span class="form-label">时长<span class="fl-hint">上限见模型说明</span></span>
        <div class="opt-pills">${(p.model === 'm-vid-f1' ? [3, 5] : [3, 5, 8]).map((d) => `<button class="opt-pill ${p.dur === d ? 'on' : ''}" data-action="set-param" data-key="dur" data-val="${d}">${d} 秒</button>`).join('')}</div></div>
      <div class="form-row"><span class="form-label">运镜</span>
        <div class="opt-pills">${CAMS.map((c) => `<button class="opt-pill ${p.cam === c ? 'on' : ''}" data-action="set-param" data-key="cam" data-val="${c}">${icon('camera')}${c}</button>`).join('')}</div></div>
      <div class="form-row"><span class="form-label">首帧参考</span>
        <div class="opt-pills">
          <button class="opt-pill ${p.firstFrame ? 'on' : ''}" data-action="set-param" data-key="firstFrame" data-val="1">使用参考图作首帧</button>
          <button class="opt-pill ${!p.firstFrame ? 'on' : ''}" data-action="set-param" data-key="firstFrame" data-val="0">纯文生视频</button>
        </div></div>
    </div>`;
  }
  const isTts = p.use === 'tts'; const isMusic = p.use === 'music';
  return `<div class="field-block">
    ${PARAM_NOTE}
    <div class="field-head"><span class="field-label">${icon('cpu')}模型</span><span class="field-hint">${esc(modelOf(p.model).note)}</span></div>
    ${modelSelect(t, p.model)}
    <div class="form-row"><span class="form-label">用途</span>
      <div class="opt-pills">
        ${[['tts', '配音', 'mic'], ['music', '音乐', 'audio'], ['sfx', '音效', 'zap']].map(([k, n, ic]) =>
    `<button class="opt-pill ${p.use === k ? 'on' : ''}" data-action="set-param" data-key="use" data-val="${k}">${icon(ic)}${n}</button>`).join('')}
      </div></div>
    <div class="form-row"><span class="form-label">时长</span>
      <div class="opt-pills">${(p.use === 'sfx' ? SFX_DURS : AU_DURS).map((d) => `<button class="opt-pill ${p.dur === d.k ? 'on' : ''}" data-action="set-param" data-key="dur" data-val="${d.k}">${d.n}</button>`).join('')}</div></div>
    ${isTts ? `<div class="form-row"><span class="form-label">音色</span>${voiceSelect(p.voice)}</div>
    <div class="form-row"><span class="form-label">语言</span>
      <div class="opt-pills">${['中文', '英文', '中英混读'].map((l) => `<button class="opt-pill ${p.lang === l ? 'on' : ''}" data-action="set-param" data-key="lang" data-val="${l}">${icon('globe')}${l}</button>`).join('')}</div></div>` : ''}
    ${isMusic ? `<div class="form-row"><span class="form-label">情绪</span>${moodSelect(p.mood)}</div>` : ''}
  </div>`;
}

function modelSelect(type, cur) {
  return `<select class="form-select" data-change="model">
    ${modelsOf(type).map((m) => `<option value="${m.id}" ${m.id === cur ? 'selected' : ''} ${m.status === 'off' ? 'disabled' : ''}>${esc(m.name)} · ${m.price} 点/${m.basis}${m.status === 'off' ? '（未开放）' : ''}</option>`).join('')}
  </select>`;
}
function voiceSelect(cur) {
  return `<select class="form-select" data-change="voice">${VOICES.map((v) => `<option value="${v.k}" ${v.k === cur ? 'selected' : ''}>${esc(v.n)}</option>`).join('')}</select>`;
}
function moodSelect(cur) {
  return `<select class="form-select" data-change="mood">${MOODS.map((m) => `<option value="${m.k}" ${m.k === cur ? 'selected' : ''}>${esc(m.n)}</option>`).join('')}</select>`;
}

function renderAdv(t, p) {
  return `<div class="adv-body">
    <div class="form-row" style="flex-direction:column;align-items:stretch;gap:6px">
      <span class="form-label">负面提示<span class="fl-hint">不想出现的元素，逗号分隔；留空即可</span></span>
      <textarea class="prompt-input neg-input" data-input="negative" placeholder="例如：模糊, 多余文字, 水印">${esc(State.negative[t])}</textarea>
    </div>
    ${t === 'image' ? `
      <div class="form-row"><span class="form-label">随机种子<span class="fl-hint">留空则每次随机</span></span>
        <input class="form-input" data-input="seed" value="${esc(p.seed)}" placeholder="例如 88213" /></div>
      <div class="form-row"><span class="form-label">参考强度</span>
        <div class="opt-pills">${[0.3, 0.6, 0.9].map((v) => `<button class="opt-pill ${p.refWeight === v ? 'on' : ''}" data-action="set-param" data-key="refWeight" data-val="${v}">${v}</button>`).join('')}</div></div>
      <div class="form-row"><span class="form-label">导出格式</span>
        <div class="opt-pills">${['PNG', 'JPG', 'WEBP'].map((f) => `<button class="opt-pill ${p.format === f ? 'on' : ''}" data-action="set-param" data-key="format" data-val="${f}">${f}</button>`).join('')}</div></div>` : ''}
    ${t === 'video' ? `
      <div class="form-row"><span class="form-label">帧率</span>
        <div class="opt-pills">${[24, 30].map((f) => `<button class="opt-pill ${p.fps === f ? 'on' : ''}" data-action="set-param" data-key="fps" data-val="${f}">${f} fps</button>`).join('')}</div></div>
      <div class="form-row"><span class="form-label">循环点</span>
        <div class="opt-pills">
          <button class="opt-pill ${p.loop ? 'on' : ''}" data-action="set-param" data-key="loop" data-val="1">生成可无缝循环</button>
          <button class="opt-pill ${!p.loop ? 'on' : ''}" data-action="set-param" data-key="loop" data-val="0">普通片段</button>
        </div></div>` : ''}
    ${t === 'audio' ? `
      <div class="form-row"><span class="form-label">输出音量</span>
        <div class="opt-pills">${[60, 80, 100].map((v) => `<button class="opt-pill ${p.volume === v ? 'on' : ''}" data-action="set-param" data-key="volume" data-val="${v}">${v}%</button>`).join('')}</div></div>` : ''}
  </div>`;
}

/* ---------- 7.2 画布：右侧无限画布 ----------
   参考图需要一块随手可取的地方，而且不该受面板大小限制——
   所以它是一块真正可以平移缩放的无限画布：拖空白框选、空格拖平移、滚轮缩放、元素自由摆放。
   选中元素后可带去生成。 */
const canvasItems = () => State.canvas[State.ws] || (State.canvas[State.ws] = []);
const canvasHas = (resultId) => canvasItems().some((i) => i.rid === resultId);
const canvasSelItems = () => canvasItems().filter((i) => State.canvasSel.includes(i.id));
const canvasAssetPath = (f) => `assets/thumbs/${f}.webp`;

const CVS_W = 168;           /* 素材默认宽度 */
const CVS_W_TEXT = 240;      /* 文字的初始逻辑宽度（渲染后会被实测值覆盖） */
const TEXT_MAX_W = 420;      /* 文字多长开始换行。短句就贴着字走，长段落到这里折行 */
const CVS_W_MIN = 64;        /* 缩放到多小 */
const CVS_W_MAX = 720;       /* 放大到多大 */
const CVS_AR = 0.68;         /* 未知比例时的默认高宽比 */
const CVS_K_MIN = 0.35;
const CVS_K_MAX = 2.6;
const cvsItemW = (i) => Math.round(i.w || (i.kind === 'text' ? CVS_W_TEXT : CVS_W));
const cvsItemAR = (i) => i.ar || CVS_AR;
/* 社媒帖子：运营的核心参考物。画板能接住一条笔记，Agent 才有「爆款长什么样」的上下文。
   抓不到真实数据（跨域），用示例数据把结构立起来，并明确标注是示例。 */
const POST_PLATFORMS = [
  { k: 'xhs', n: '小红书', re: /(^|\.)xiaohongshu\.com|xhslink\.com/i, color: '#FF2442', label: '图文笔记', ic: 'image' },
  { k: 'douyin', n: '抖音', re: /(^|\.)douyin\.com|iesdouyin\.com/i, color: '#161823', label: '短视频', ic: 'video' },
  { k: 'weibo', n: '微博', re: /(^|\.)weibo\.(com|cn)/i, color: '#E6162D', label: '微博', ic: 'send' },
  { k: 'wechat', n: '公众号', re: /mp\.weixin\.qq\.com/i, color: '#07C160', label: '图文推送', ic: 'link' },
  { k: 'bili', n: 'B 站', re: /(^|\.)bilibili\.com|b23\.tv/i, color: '#00A1D6', label: '视频', ic: 'film' },
  { k: 'zhihu', n: '知乎', re: /(^|\.)zhihu\.com/i, color: '#0084FF', label: '回答 / 文章', ic: 'user' },
];
/* 视频平台：和图文帖子分开——运营看视频参考时看的是「时长 + 播放量」，字段不一样 */
const VIDEO_PLATFORMS = [
  { k: 'youtube', n: 'YouTube', re: /(^|\.)youtube\.com|youtu\.be/i, color: '#FF0000', label: '视频', ic: 'video' },
  { k: 'vimeo', n: 'Vimeo', re: /(^|\.)vimeo\.com/i, color: '#1AB7EA', label: '视频', ic: 'video' },
  { k: 'tencent', n: '腾讯视频', re: /(^|\.)v\.qq\.com/i, color: '#FF7F00', label: '视频', ic: 'film' },
  { k: 'youku', n: '优酷', re: /(^|\.)youku\.com/i, color: '#1E90FF', label: '视频', ic: 'film' },
];
const videoPlatformOf = (url) => VIDEO_PLATFORMS.find((x) => x.re.test(url || '')) || null;
/* 直链视频文件：唯一能在画布上真正播放的链接类型 */
const VIDEO_FILE_RE = /\.(mp4|webm|ogv|mov|m4v)([?#]|$)/i;
const isDirectVideo = (url) => VIDEO_FILE_RE.test(url || '');

const postPlatformOf = (url) => POST_PLATFORMS.find((x) => x.re.test(url || '')) || videoPlatformOf(url);

/* 示例数据：原型不联网，用一组稳定的假数据把「爆款参考」这个结构表达出来 */
const POST_SAMPLES = {
  xhs: [
    { t: '秋冬热饮杯怎么拍？5 个机位一次讲清', a: '橙野咖啡研究所', like: '2.3w', save: '1.1w', cmt: '386' },
    { t: '咖啡店探店拍照姿势合集｜附参数', a: '拿铁不加糖', like: '8.7k', save: '5.2k', cmt: '142' },
  ],
  douyin: [
    { t: '一杯咖啡的 15 秒｜治愈系运镜', a: '橙野咖啡', like: '12.4w', save: '3.1w', cmt: '902' },
  ],
  weibo: [
    { t: '#咖啡日常# 秋季新品终于上了', a: '橙野咖啡官方', like: '3.6k', save: '421', cmt: '88' },
  ],
  wechat: [
    { t: '一杯好咖啡的背后，是 37 次杯测', a: '橙野咖啡', like: '1.2k', save: '876', cmt: '45' },
  ],
  bili: [
    { t: '把咖啡店拍成电影｜幕后记录', a: '橙野影像', like: '5.8w', save: '2.2w', cmt: '1.4k' },
  ],
  zhihu: [
    { t: '开一家咖啡店，视觉上最容易踩的坑', a: '匿名用户', like: '2.1k', save: '3.3k', cmt: '214' },
  ],
};
const VIDEO_SAMPLES = {
  youtube: [{ t: 'How we shoot coffee ads — behind the scenes', a: 'Studio North', like: '84w', save: '—', cmt: '2.1w', dur: '12:40' }],
  vimeo: [{ t: 'Coffee — a short film', a: 'Marta R.', like: '1.2w', save: '—', cmt: '340', dur: '03:18' }],
  tencent: [{ t: '秋季新品广告片 30s', a: '橙野咖啡', like: '3.4w', save: '—', cmt: '902', dur: '00:30' }],
  youku: [{ t: '一杯咖啡的旅程', a: '橙野咖啡', like: '1.1w', save: '—', cmt: '210', dur: '05:06' }],
};
const postSampleOf = (k) => {
  const list = VIDEO_SAMPLES[k] || POST_SAMPLES[k] || [{ t: '参考内容', a: '未知来源', like: '—', save: '—', cmt: '—' }];
  return list[Math.floor(Math.random() * list.length)];
};

/* 画布里的音频元素用一条静音波形表示，不依赖真实解码 */
function cvsAudioWave(i) {
  const bars = 26;
  const series = seededSeries(i.seed || 4207, bars, 26, 96);
  return `<div class="cvs-audio-wave">${series.map((v) => `<i style="height:${v.toFixed(0)}%"></i>`).join('')}</div>`;
}

/* 外部拖进来的图用 blob，素材库的用缩略图路径 */
const cvsSrc = (i) => i.src || canvasAssetPath(i.f);
/* 旋转与翻转合到一个 transform；透明度用于描摹垫底 */
function cvsTransform(i) {
  const parts = [];
  if (i.rot) parts.push(`rotate(${i.rot}deg)`);
  if (i.flipH || i.flipV) parts.push(`scale(${i.flipH ? -1 : 1}, ${i.flipV ? -1 : 1})`);
  return parts.join(' ');
}
const cvsOpacity = (i) => (i.op != null ? i.op : 1);
/* ---------- 连线：表达元素之间的关系 ----------
   Agent 最需要的是「谁和谁有关」，因为关系比元素本身更能说明意图。 */
const canvasLinks = () => State.cvsLinks[State.ws] || (State.cvsLinks[State.ws] = []);
const linkHas = (from, to) => canvasLinks().some((l) => l.from === from && l.to === to);

function cvsElCenter(i) {
  return { x: i.x + cvsItemW(i) / 2, y: i.y + cvsItemH(i) / 2 };
}
/* 拖动过程中状态还没写回，位置要从 DOM 现读 */
function cvsElCenterLive(i) {
  const n = document.querySelector(`#cvsWorld .cvs-el[data-id="${i.id}"]`);
  if (n && n.style.left) {
    return { x: parseFloat(n.style.left) + cvsItemW(i) / 2, y: parseFloat(n.style.top) + cvsItemH(i) / 2 };
  }
  return cvsElCenter(i);
}
/* 二次贝塞尔在 t=0.5 的位置：0.25·起点 + 0.5·控制点 + 0.25·终点 */
function cvsLinkMid(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const off = Math.min(56, len * 0.16);
  const cx = (a.x + b.x) / 2 + (-dy / len) * off;
  const cy = (a.y + b.y) / 2 + (dx / len) * off;
  return { x: 0.25 * a.x + 0.5 * cx + 0.25 * b.x, y: 0.25 * a.y + 0.5 * cy + 0.25 * b.y };
}

function cvsLinkPath(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const off = Math.min(56, len * 0.16);
  const nx = -dy / len;
  const ny = dx / len;
  return `M ${a.x} ${a.y} Q ${mx + nx * off} ${my + ny * off} ${b.x} ${b.y}`;
}

/* 线的 SVG 内容。内联进画布 HTML，这样 renderMain / paintCanvas 都会带上 */
function cvsLinksHTML(live) {
  const items = canvasItems();
  const center = live ? cvsElCenterLive : cvsElCenter;
  return `<defs>
      <marker id="cvsArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
      </marker>
    </defs>
    ${canvasLinks().map((l) => {
    const a = items.find((x) => x.id === l.from);
    const b = items.find((x) => x.id === l.to);
    if (!a || !b) return '';
    const sel = State.linkSel === l.id;
    const ca = center(a);
    const cb = center(b);
    const d = cvsLinkPath(ca, cb);
    /* 两条同形状的 path：细的负责看，粗的透明层负责点得中 */
    return `<path class="cvs-link-hit" data-link="${l.id}" d="${d}" />
      <path class="cvs-link ${sel ? 'sel' : ''}" data-link="${l.id}"
        d="${d}" marker-end="url(#cvsArrow)" />`;
  }).join('')}`;
}

/* 线名单独一层，画在元素上面。
   线本身在元素下面（卡片要能压住线才清爽），但名字是内容，
   被卡片盖住就白写了——所以它必须浮在上面。 */
function cvsLinkLabelsHTML(live) {
  const items = canvasItems();
  const center = live ? cvsElCenterLive : cvsElCenter;
  return canvasLinks().map((l) => {
    if (!l.label || State.linkLabelEdit === l.id) return '';
    const a = items.find((x) => x.id === l.from);
    const b = items.find((x) => x.id === l.to);
    if (!a || !b) return '';
    const mid = cvsLinkMid(center(a), center(b));
    const w = Math.max(30, l.label.length * 11 + 14);
    return `<g class="cvs-link-tag" data-link="${l.id}">
        <rect x="${mid.x - w / 2}" y="${mid.y - 11}" width="${w}" height="22" rx="11" />
        <text x="${mid.x}" y="${mid.y + 4}" text-anchor="middle">${esc(l.label)}</text>
      </g>`;
  }).join('');
}

/* 拖动中只刷内容，不重建节点——要跟得上手指 */
function cvsSyncLinks(live) {
  const svg = document.getElementById('cvsLinks');
  if (svg) svg.innerHTML = cvsLinksHTML(live);
  const top = document.getElementById('cvsLinksTop');
  if (top) top.innerHTML = cvsLinkLabelsHTML(live);
}

/* 元素在画布上的显示层级：z 越大越靠上，未设置时按数组顺序 */
function cvsZ(i) {
  if (i.z != null) return i.z;
  return 100 + canvasItems().indexOf(i);
}
const cvsSorted = () => canvasItems().slice().sort((a, b) => cvsZ(a) - cvsZ(b));
/* 包围盒：框选、适应窗口、对齐分布都要用 */
function cvsBounds(items) {
  const list = items && items.length ? items : canvasItems();
  if (!list.length) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  list.forEach((i) => {
    const w = cvsItemW(i);
    const h = cvsItemH(i);
    x1 = Math.min(x1, i.x);
    y1 = Math.min(y1, i.y);
    x2 = Math.max(x2, i.x + w);
    y2 = Math.max(y2, i.y + h);
  });
  return { x1, y1, x2, y2, w: x2 - x1, h: y2 - y1 };
}

function cvsView() {
  return State.cvsView[State.ws] || (State.cvsView[State.ws] = { x: 40, y: 40, k: 1 });
}
const cvsNextSpot = () => {
  const n = canvasItems().length;
  return { x: 40 + (n % 4) * (CVS_W + 24), y: 40 + Math.floor(n / 4) * 210 };
};
const CVS_H_WEB = 96;        /* 网页卡片高度 */
const CVS_H_FILE = 92;       /* 文档卡片高度 */
const CVS_H_POST = 132;      /* 社媒帖子卡片高度 */
/* 不同类型的元素高度算法不一样：图片按比例，卡片和笔迹按自身尺寸 */
const CVS_H_NODE = 76;       /* 节点默认高度 */
/* 文字的三档：备注 / 正文 / 标题。字大行高就大，高度跟着档位走 */
const TEXT_H = { sm: 40, md: 64, lg: 96 };
const TEXT_SIZE_NAME = { sm: '小（备注）', md: '中（正文）', lg: '大（标题）' };
const cvsItemH = (i) => {
  if (i.kind === 'web') return CVS_H_WEB + (i.cover ? 76 : 0);
  if (i.kind === 'post') return CVS_H_POST + (i.cover ? 76 : 0);
  if (i.kind === 'file') return CVS_H_FILE;
  if (i.kind === 'draw') return Math.max(24, i.h || 60);
  if (i.kind === 'group') return Math.max(120, i.h || 260);
  if (i.kind === 'node') return Math.max(44, i.h || CVS_H_NODE);
  if (i.kind === 'text') return Math.max(30, i.h || TEXT_H[i.size || 'md'] || TEXT_H.md);
  return Math.round(cvsItemW(i) * cvsItemAR(i)) + 2;
};
/* 分组永远在最底层，不遮元素 */
const cvsLayer = (i) => (i.kind === 'group' ? -1000 + cvsZ(i) % 500 : cvsZ(i));
/* 几何包含：元素是否落在分组里 */
/* 画板上能写字的两种元素：节点（结构件）和文字（标注件）。
   两者都是「双击进编辑、失焦即保存」，平时 textarea 是只读的，
   这样单击拖动不会误触输入。 */
const isTextEl = (i) => !!i && (i.kind === 'node' || i.kind === 'text');
const isEditingText = (i) => !!i && State.editTextId === i.id;

const inGroup = (it, g) => it.x + cvsItemW(it) > g.x && it.x < g.x + cvsItemW(g)
  && it.y + cvsItemH(it) > g.y && it.y < g.y + cvsItemH(g);

/* 文档类型：从 MIME 和扩展名判断，只用来选图标与文案 */
const FILE_KINDS = [
  { k: 'pdf', re: /pdf/, n: 'PDF', ic: 'bookmark' },
  { k: 'doc', re: /word|officedocument|msword|rtf/, n: '文档', ic: 'list' },
  { k: 'sheet', re: /sheet|excel|csv/, n: '表格', ic: 'chart' },
  { k: 'slide', re: /presentation|powerpoint/, n: '演示', ic: 'film' },
  { k: 'text', re: /^text\/|markdown|json/, n: '文本', ic: 'pen' },
];
const fileKindOf = (f) => {
  const hay = `${f.type || ''} ${f.name || ''}`.toLowerCase();
  return FILE_KINDS.find((x) => x.re.test(hay)) || { k: 'other', n: '文件', ic: 'box' };
};
const humanSize = (n) => {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};
const cvsHost = (url) => {
  try { return new URL(url).host.replace(/^www\./, ''); } catch (_) { return '链接'; }
};
/* 旋转、翻转、透明度、复制 */
function cvsTransformApply(fn, label) {
  const sel = canvasSelItems();
  if (!sel.length) { toast('info', '先选中元素', '单击或框选都可以'); return; }
  sel.forEach(fn);
  paintCanvas();
  if (label) toast('success', label, `${sel.length} 个元素`);
}

/* 层级：画布上元素重叠是常态，得能压住别人也得能被压住 */
function cvsReorder(mode) {
  const sel = canvasSelItems();
  if (!sel.length) return;
  const all = canvasItems();
  const zs = all.map(cvsZ);
  const top = Math.max(...zs);
  const bottom = Math.min(...zs);
  if (mode === 'front') sel.forEach((i, k) => { i.z = top + 1 + k; });
  else if (mode === 'back') sel.forEach((i, k) => { i.z = bottom - 1 - k; });
  else if (mode === 'up') sel.forEach((i) => { i.z = cvsZ(i) + 1; });
  else if (mode === 'down') sel.forEach((i) => { i.z = cvsZ(i) - 1; });
  paintCanvas();
  toast('info', mode === 'front' ? '已置顶' : mode === 'back' ? '已置底' : mode === 'up' ? '已上移一层' : '已下移一层');
}

/* 多选后的对齐与分布：把一批图排整齐，比一个个拖快得多 */
function cvsAlign(mode) {
  const sel = canvasSelItems();
  if (sel.length < 2) return;
  const b = cvsBounds(sel);
  sel.forEach((i) => {
    const w = cvsItemW(i);
    const h = cvsItemH(i);
    if (mode === 'left') i.x = b.x1;
    else if (mode === 'hcenter') i.x = Math.round(b.x1 + (b.w - w) / 2);
    else if (mode === 'right') i.x = b.x2 - w;
    else if (mode === 'top') i.y = b.y1;
    else if (mode === 'vcenter') i.y = Math.round(b.y1 + (b.h - h) / 2);
    else if (mode === 'bottom') i.y = b.y2 - h;
  });
  paintCanvas();
  toast('success', '已对齐', `${sel.length} 个元素`);
}

function cvsDistribute(axis) {
  const sel = canvasSelItems();
  if (sel.length < 3) { toast('info', '至少要选 3 个', '两个元素之间没有「中间」可分布'); return; }
  const list = sel.slice().sort((a, b) => (axis === 'h' ? a.x - b.x : a.y - b.y));
  const first = list[0];
  const last = list[list.length - 1];
  if (axis === 'h') {
    const span = (last.x + cvsItemW(last)) - first.x;
    const total = list.reduce((n, i) => n + cvsItemW(i), 0);
    const gap = (span - total) / (list.length - 1);
    let cur = first.x;
    list.forEach((i) => { i.x = Math.round(cur); cur += cvsItemW(i) + gap; });
  } else {
    const span = (last.y + cvsItemH(last)) - first.y;
    const total = list.reduce((n, i) => n + cvsItemH(i), 0);
    const gap = (span - total) / (list.length - 1);
    let cur = first.y;
    list.forEach((i) => { i.y = Math.round(cur); cur += cvsItemH(i) + gap; });
  }
  paintCanvas();
  toast('success', axis === 'h' ? '已水平均分' : '已垂直均分', `${list.length} 个元素`);
}

/* 让全部内容刚好铺满视口——PureRef 的 Fit All，铺开之后一键看全 */
function cvsFitAll(padding) {
  const vp = document.getElementById('cvsViewport');
  if (!vp) return;
  const b = cvsBounds();
  if (!b) { State.cvsView[State.ws] = { x: 40, y: 40, k: 1 }; syncCvsView(); return; }
  const pad = padding == null ? 56 : padding;
  const vw = vp.clientWidth - pad * 2;
  const vh = vp.clientHeight - pad * 2;
  const k = clamp(Math.min(vw / b.w, vh / b.h), CVS_K_MIN, CVS_K_MAX);
  const v = cvsView();
  v.k = Math.round(k * 100) / 100;
  v.x = Math.round(pad + (vw - b.w * v.k) / 2 - b.x1 * v.k);
  v.y = Math.round(pad + (vh - b.h * v.k) / 2 - b.y1 * v.k);
  syncCvsView();
}

/* 按当前视口宽度把所有元素排成规整网格——「整理思路」最常用的一步 */
function cvsArrange() {
  const items = canvasItems();
  if (!items.length) { toast('info', '画布是空的', '先往里面丢点东西'); return; }
  const vp = document.getElementById('cvsViewport');
  const v = cvsView();
  const usable = vp ? Math.max(240, vp.clientWidth / v.k - 80) : 900;
  const gap = 20;
  let x = 40, y = 40, rowH = 0;
  items.forEach((it) => {
    const w = cvsItemW(it);
    const h = cvsItemH(it);
    if (x > 40 && x + w > 40 + usable) { x = 40; y += rowH + gap; rowH = 0; }
    it.x = Math.round(x);
    it.y = Math.round(y);
    x += w + gap;
    rowH = Math.max(rowH, h);
  });
  renderMain();
  if (State.canvasOpen) syncCvsView();
  toast('success', '已整理', `${items.length} 个元素排成网格`);
}

function canvasPanel() {
  const items = canvasItems();
  const media = items.filter((i) => i.kind !== 'draw').length;
  const sel = State.canvasSel.length;
  const v = cvsView();

  if (!State.canvasOpen) {
    return `<div class="cvs-panel closed">
      <button class="cvs-rail" data-action="toggle-canvas" title="展开画布">
        ${icon('layers')}<span class="cvs-rail-txt">画布</span>
        ${items.length ? `<span class="cvs-rail-n num">${items.length}</span>` : ''}
        ${icon('chev-left', 'cvs-rail-arrow')}
      </button>
    </div>`;
  }

  return `<div class="cvs-panel">
    <div class="cvs-head">
      <span class="cvs-head-ic">${icon('layers')}</span>
      <div class="cvs-head-txt">
        <b>画布</b>
        <span>${items.length ? `${media} 个素材` : '把图片丢进来，随手可用'}</span>
      </div>
      <span class="grow"></span>
      <span class="cvs-sel-chip" id="cvsSelChip"${sel ? '' : ' style="display:none"'}>${sel ? `已选 ${sel} 项` : ''}</span>
      <button class="icon-btn" data-action="undo" title="撤销（Ctrl+Z）"
        ${(State.history[State.ws] || []).length ? '' : 'disabled'}>${icon('undo')}</button>
      <button class="icon-btn" data-action="redo" title="重做（Ctrl+Shift+Z）"
        ${(State.future[State.ws] || []).length ? '' : 'disabled'}>${icon('redo')}</button>
      <button class="icon-btn" data-action="cvs-upload" title="从电脑选文件">${icon('upload')}</button>
      <button class="icon-btn ${State.cvsPen.on ? 'on' : ''}" data-action="cvs-pen" title="手绘标注（B）">${icon('pen')}</button>
      <button class="icon-btn" data-action="cvs-save-board" title="保存画板">${icon('download')}</button>
      <button class="icon-btn" data-action="cvs-load-board" title="导入画板">${icon('upload')}</button>
      <button class="icon-btn" data-action="cvs-arrange" title="整理成网格">${icon('grid')}</button>
      <button class="icon-btn" data-action="cvs-fit" title="适应窗口（F）">${icon('expand')}</button>
      <button class="icon-btn" data-action="cvs-reset-view" title="回到原点（0）">${icon('target')}</button>
      <button class="icon-btn" data-action="${State.cvsFull ? 'cvs-full-off' : 'cvs-full'}"
        title="${State.cvsFull ? '退出专注' : '专注模式'}">${icon(State.cvsFull ? 'expand' : 'expand')}</button>
      ${State.cvsFull ? '' : `<button class="icon-btn" data-action="toggle-canvas" title="收起画布">${icon('chev-right')}</button>`}
    </div>
    ${inboxBarHTML()}
    ${State.cvsPen.on ? `<div class="cvs-penbar">
      <span class="cvs-penbar-label">${icon('pen')}画笔</span>
      ${PEN_COLORS.map((c) => `<button class="cvs-swatch ${State.cvsPen.color === c ? 'on' : ''}"
        data-action="cvs-pen-color" data-val="${c}" style="background:${c}" title="${c}"></button>`).join('')}
      <span class="cvs-penbar-sep"></span>
      ${[2, 4, 7].map((w) => `<button class="cvs-lw ${State.cvsPen.lw === w ? 'on' : ''}"
        data-action="cvs-pen-width" data-val="${w}" title="${w}px"><i style="height:${w}px"></i></button>`).join('')}
      <span class="grow"></span>
      <span class="tiny dim">拖动即可标注 · 按 B 或 Esc 退出</span>
    </div>` : ''}
    <div class="cvs-viewport" id="cvsViewport">
      <div class="cvs-grid" id="cvsGrid" style="background-size:${26 * v.k}px ${26 * v.k}px, ${26 * v.k}px ${26 * v.k}px, ${130 * v.k}px ${130 * v.k}px, ${130 * v.k}px ${130 * v.k}px;background-position:${v.x}px ${v.y}px"></div>
      <div class="cvs-world" id="cvsWorld" style="transform:translate(${v.x}px, ${v.y}px) scale(${v.k})">
        <svg class="cvs-links" id="cvsLinks" viewBox="-2000 -2000 8000 8000">${cvsLinksHTML()}</svg>
        ${cvsSorted().map(canvasItemHTML).join('')}
        <svg class="cvs-links cvs-links-top" id="cvsLinksTop" viewBox="-2000 -2000 8000 8000">${cvsLinkLabelsHTML()}</svg>
      </div>
      ${cvsPopHTML()}
      ${cvsLinkLabelHTML()}
      ${cvsMenuHTML()}
      ${!items.length ? `<div class="cvs-blank">
        <div class="cvs-blank-ic">${icon('layers')}</div>
        <div class="cvs-blank-t">画布还空着</div>
        <div class="cvs-blank-d">从素材库把产出拖过来，或者直接拖本地文件、<b>Ctrl+V</b> 贴截图。<br>
          粘贴网址和帖子链接也能放进来自动识别。<b>右键</b>是全部操作。</div>
      </div>` : ''}
    </div>
    ${State.linkFrom ? `<div class="cvs-hint-bar">${icon('link')}<span>连线中 · 点一个元素把它连过来</span>
      <span class="grow"></span><button class="btn sm ghost" data-action="cvs-link-cancel">取消</button></div>` : ''}
    ${divergePanel()}
    ${platformPanel()}
    <div id="cvsFootHost">${canvasBarHTML()}</div>
  </div>`;
}

/* 收件箱：最新一批生成结果停在这里，用户决定留哪张——拖进画布，或者不管它 */
function inboxBarHTML() {
  const list = inboxResults();
  if (!list.length) return '';
  return `<div class="cvs-inbox" id="cvsInbox">
    <div class="cvs-inbox-head">
      ${icon('inbox')}<b>最新生成</b>
      <span class="cvs-inbox-n num">${list.length} 项</span>
      <span class="grow"></span>
      <span class="cvs-inbox-hint">拖进画布留用，不拖的下次生成时进草稿箱</span>
      <button class="btn sm ghost" data-action="cvs-drop-inbox">${icon('trash')}全部不收</button>
    </div>
    <div class="cvs-inbox-strip">
      ${list.map((r) => `<div class="cvs-inbox-card" draggable="true" data-drag="${r.id}" title="${esc(r.title)} · 拖进画布">
        <img src="${thumbPath(r)}" alt="" draggable="false" style="${r.edit && r.edit.css ? r.edit.css : ''}" />
        <span class="cvs-kind k-${r.type}">${icon(TYPES[r.type].ic)}</span>
        <button class="cvs-inbox-add" data-action="cvs-keep" data-id="${r.id}" title="放进画布">${icon('plus')}</button>
      </div>`).join('')}
    </div>
  </div>`;
}

/* 把一条产出放进画布：收件箱里算「留用」，草稿箱里算「捞回来」 */
function cvsKeep(rid) {
  const r = resultById(rid);
  if (!r) return;
  if (canvasHas(rid)) { toast('info', '已经在画布上了', r.title); return; }
  const from = r.home;
  const spot = cvsNextSpot();
  const newId = `c${++State.seq}`;
  canvasItems().push({ id: newId, kind: 'media', type: r.type, f: r.asset, t: r.title, rid, x: spot.x, y: spot.y });
  /* 从某张图发散/适配出来的，拖进来时自动连回源元素——产出天然有结构 */
  const j = jobById(r.job);
  if (j && j.fromCvsId && canvasItems().some((x) => x.id === j.fromCvsId)) {
    canvasLinks().push({ id: `L${++State.seq}`, from: j.fromCvsId, to: newId });
  }
  if (from === 'inbox' || from === 'draft') r.home = 'canvas';
  State.canvasOpen = true;
  renderAll();
  toast('success', from === 'draft' ? '已从草稿箱捞回画布' : '已放进画布', `${r.title} · 满意后可以保存到素材库`);
}

function canvasItemHTML(i) {
  const on = State.canvasSel.includes(i.id);
  const w = cvsItemW(i);
  const saved = i.rid && savedToLib(i.rid);
  const tf = cvsTransform(i);
  const common = `left:${i.x}px;top:${i.y}px;width:${w}px;z-index:${cvsLayer(i)}${tf ? `;transform:${tf}` : ''}${cvsOpacity(i) < 1 ? `;opacity:${cvsOpacity(i)}` : ''}`;
  const ops = `<div class="cvs-el-ops">
      ${i.rid ? `<button class="cvs-op cvs-param" data-action="cvs-params" data-id="${i.rid}" title="查看生成时的参数">${icon('cpu')}</button>` : ''}
      ${i.url ? `<button class="cvs-op" data-action="cvs-open-link" data-url="${esc(i.url)}" title="在浏览器打开">${icon('link')}</button>` : ''}
      <button class="cvs-op" data-action="cvs-keep-aes" data-id="${i.id}" title="收进审美库">${icon('star')}</button>
      ${(i.kind === 'web' || i.kind === 'post') ? `<button class="cvs-op" data-action="cvs-cover" data-id="${i.id}" title="${i.cover ? '换封面' : '补一张封面'}">${icon('upload')}</button>` : ''}
      <button class="cvs-op cvs-del" data-action="canvas-remove" data-id="${i.id}" title="移除">${icon('x')}</button>
    </div>
    <span class="cvs-grip" data-grip="${i.id}" title="拖动改大小"></span>`;

  /* 网页卡片：记住「我在参考哪个页面」，标题由用户自己起 */
  if (i.kind === 'web') {
    return `<div class="cvs-el cvs-web ${on ? 'sel' : ''}" data-id="${i.id}" style="${common};height:${i.cover ? CVS_H_WEB + 76 : CVS_H_WEB}px">
      ${i.cover ? `<div class="cvs-cover"><img src="${esc(i.cover)}" alt="" /></div>` : ''}
      <div class="cvs-web-bar"><span class="cvs-web-fav">${icon('globe')}</span>
        <span class="cvs-web-host">${esc(cvsHost(i.url))}</span></div>
      <div class="cvs-web-body">
        <div class="cvs-web-title">${esc(i.t || '未命名页面')}</div>
        <div class="cvs-web-url">${esc(i.url)}</div>
      </div>
      ${ops}
    </div>`;
  }

  /* 分组：虚线容器 + 可写组名，永远垫在元素下面 */
  if (i.kind === 'group') {
    return `<div class="cvs-el cvs-group ${on ? 'sel' : ''}" data-id="${i.id}"
        style="left:${i.x}px;top:${i.y}px;width:${w}px;height:${cvsItemH(i)}px;z-index:${cvsLayer(i)}">
      <div class="cvs-group-head" data-group-head="${i.id}">
        ${icon('grid')}<span class="cvs-group-name" data-group-name="${i.id}" contenteditable="true"
          spellcheck="false">${esc(i.t || '未命名分组')}</span>
        <span class="grow"></span>
        <span class="cvs-group-n num">${canvasItems().filter((x) => x.kind !== 'group' && inGroup(x, i)).length}</span>
        <button class="cvs-op cvs-del" data-action="canvas-remove" data-id="${i.id}" title="解散分组">${icon('x')}</button>
      </div>
    </div>`;
  }

  /* 节点：思维导图的构件。和便签的区别是它天生要参与结构——创建后引导连线 */
  if (i.kind === 'node') {
    return `<div class="cvs-el cvs-node ${on ? 'sel' : ''}" data-id="${i.id}"
        style="left:${i.x}px;top:${i.y}px;width:${w}px;height:${cvsItemH(i)}px;z-index:${cvsZ(i)}">
      <textarea class="cvs-node-text" data-node-id="${i.id}"${isEditingText(i) ? '' : ' readonly'}
        placeholder="双击写字…">${esc(i.text || '')}</textarea>
      ${ops}
    </div>`;
  }

  /* 文字：就是文字。不画框、不铺底、不给手柄，宽度由内容决定。
     宽高由渲染后实测写回（见 cvsMeasureText），所以框选、分组、连线端点依然准确。
     和节点的区别：节点是结构件（卡片 + 引导连线），文字只负责解释。 */
  if (i.kind === 'text') {
    return `<div class="cvs-el cvs-text size-${i.size || 'md'} ${on ? 'sel' : ''} ${isEditingText(i) ? 'editing' : ''}"
        data-id="${i.id}"
        style="left:${i.x}px;top:${i.y}px;max-width:${TEXT_MAX_W}px;z-index:${cvsLayer(i)}${tf ? `;transform:${tf}` : ''}${cvsOpacity(i) < 1 ? `;opacity:${cvsOpacity(i)}` : ''}">
      <div class="cvs-text-body" data-text-id="${i.id}"${isEditingText(i) ? ' contenteditable="true"' : ''}>${esc(i.text || '')}</div>
    </div>`;
  }

  /* 社媒帖子卡片：运营看的是「这条为什么爆」，所以数据比标题更重要 */
  if (i.kind === 'post') {
    const pf = videoPlatformOf(i.url) || postPlatformOf(i.url) || { n: '链接', color: '#8A90A2', label: '网页', ic: 'link' };
    return `<div class="cvs-el cvs-post ${on ? 'sel' : ''}" data-id="${i.id}" style="${common};height:${CVS_H_POST}px">
      ${i.cover ? `<div class="cvs-cover"><img src="${esc(i.cover)}" alt="" /></div>` : ''}
      <div class="cvs-post-bar" style="background:${pf.color}1A;color:${pf.color}">
        <span class="cvs-post-pf" style="background:${pf.color}">${icon(pf.ic)}</span>
        <b>${esc(pf.n)}</b><span class="cvs-post-kind">${esc(pf.label)}</span>
        <span class="grow"></span>
        <span class="cvs-post-demo">示例</span>
      </div>
      <div class="cvs-post-body">
        <div class="cvs-post-title">${esc(i.t)}</div>
        <div class="cvs-post-author">@${esc(i.author || '未知来源')}</div>
        <div class="cvs-post-stats">
          ${i.isVideo && i.dur ? `<span>${icon('clock')}${esc(i.dur)}</span>` : ''}
          <span>${icon('star')}${esc(i.like || '—')}</span>
          ${i.isVideo ? '' : `<span>${icon('bookmark')}${esc(i.save || '—')}</span>`}
          <span>${icon('send')}${esc(i.cmt || '—')}</span>
        </div>
      </div>
      ${ops}
    </div>`;
  }

  /* 文档卡片：不解析内容，只标记「这里有份资料」 */
  if (i.kind === 'file') {
    const fk = FILE_KINDS.find((x) => x.k === i.ftype) || { n: '文件', ic: 'box' };
    return `<div class="cvs-el cvs-file ${on ? 'sel' : ''}" data-id="${i.id}" style="${common};height:${CVS_H_FILE}px">
      <span class="cvs-file-ic">${icon(fk.ic)}</span>
      <div class="cvs-file-body">
        <div class="cvs-file-name" title="${esc(i.t)}">${esc(i.t)}</div>
        <div class="cvs-file-meta">${fk.n}${i.size ? ` · ${humanSize(i.size)}` : ''}</div>
      </div>
      ${ops}
    </div>`;
  }

  /* 手绘笔迹：一条独立元素，可整体拖动与删除 */
  if (i.kind === 'draw') {
    const pts = (i.pts || []).map(([px, py]) => `${px},${py}`).join(' ');
    return `<div class="cvs-el cvs-draw ${on ? 'sel' : ''}" data-id="${i.id}" style="${common};height:${cvsItemH(i)}px">
      <svg class="cvs-draw-svg" viewBox="0 0 ${w} ${cvsItemH(i)}" preserveAspectRatio="none">
        <polyline points="${pts}" fill="none" stroke="${esc(i.color || '#4F46E5')}"
          stroke-width="${i.lw || 3}" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      ${ops}
    </div>`;
  }

  return `<div class="cvs-el cvs-media ${on ? 'sel' : ''} ${saved ? 'saved' : ''}" data-id="${i.id}" style="${common}">
    ${i.type === 'video' && i.src
      ? `<video class="cvs-video" src="${esc(i.src)}" muted playsinline preload="metadata"
           style="aspect-ratio:${cvsItemAR(i)}"></video><span class="cvs-play">${icon('play')}</span>`
      : i.type === 'audio'
        ? `<div class="cvs-audio" style="height:${Math.round(cvsItemW(i) * cvsItemAR(i))}px">${cvsAudioWave(i)}</div>`
        : `<img src="${cvsSrc(i)}" alt="${esc(i.t)}" draggable="false" style="aspect-ratio:${cvsItemAR(i)}" />`}
    <span class="cvs-kind k-${i.type}">${icon(TYPES[i.type].ic)}</span>
    ${i.local ? `<span class="cvs-kind k-local" title="本地文件">${icon('upload')}</span>` : ''}
    ${i.link ? `<span class="cvs-kind k-local" title="链接视频">${icon('link')}</span>` : ''}
    ${saved ? `<span class="cvs-saved">${icon('check')}已存素材库</span>` : ''}
    <span class="cvs-cap">${esc(i.t || '未命名')}</span>
    ${ops}
  </div>`;
}

function canvasRemove(id) {
  State.canvas[State.ws] = canvasItems().filter((i) => i.id !== id);
  State.canvasSel = State.canvasSel.filter((x) => x !== id);
  /* 元素没了，挂在它身上的线也留不住 */
  State.cvsLinks[State.ws] = canvasLinks().filter((l) => l.from !== id && l.to !== id);
}

/* 生成参数浮层：只说清「这张是怎么来的」，不做成又一个详情页 */
function cvsPopHTML() {
  const pop = State.cvsPop;
  if (!pop) return '';
  const r = resultById(pop.rid);
  if (!r) return '';
  const j = jobById(r.job);
  const rows = [];
  rows.push(['标题', r.title]);
  rows.push(['模型', modelOf(r.model).name]);
  if (j) {
    rows.push(['提示词', j.prompt, 'prompt']);
    rows.push(['参数', paramsBrief(j)]);
    if (j.refs) rows.push(['参考图', `${j.refs} 项`]);
    rows.push(['消耗', `${j.cost} 点`]);
    rows.push(['来源任务', j.name]);
    rows.push(['完成时间', `${j.dateKey === 'today' ? '今天' : '昨天'} ${j.time}`]);
  } else {
    rows.push(['来源', '在编辑器中修改后保存']);
    rows.push(['改动', (r.tags || []).join(' · ') || '—']);
    rows.push(['时间', r.time]);
  }
  rows.push(['随机种子', String(r.seed)]);
  return `<div class="cvs-pop" style="left:${pop.sx}px;top:${pop.sy}px">
    <div class="cvs-pop-head">
      ${icon('cpu')}<b>生成参数</b>
      <span class="grow"></span>
      <button class="icon-btn" data-action="close-cvs-pop">${icon('x')}</button>
    </div>
    <div class="cvs-pop-body">
      ${rows.map(([k, v, kind]) => `<div class="cvs-pop-row ${kind === 'prompt' ? 'wide' : ''}">
        <span class="cpk">${k}</span><span class="cpv ${kind === 'prompt' ? 'prompt' : ''}">${esc(v)}</span></div>`).join('')}
    </div>
    <div class="cvs-pop-foot">
      ${j ? `<button class="btn sm ghost" data-action="copy-prompt-of" data-id="${r.id}">${icon('copy')}复制提示词</button>
      <button class="btn sm primary" data-action="reuse-params" data-id="${r.id}">${icon('wand')}按这套再来一次</button>` : ''}
      <span class="grow"></span>
      <button class="icon-btn" data-action="open-result" data-id="${r.id}" title="完整详情">${icon('more')}</button>
    </div>
  </div>`;
}

function canvasBarHTML() {
  const sel = canvasSelItems();
  const zoomChip = `<span class="cvs-zoom num" id="cvsZoom">${Math.round(cvsView().k * 100)}%</span>`;
  if (!sel.length) {
    return `<div class="cvs-foot">
      <span class="cvs-foot-hint">${icon('target')}从素材库拖进来 · 拖空白框选 · 空格拖平移 · 滚轮缩放 · 右键更多</span>
      <span class="grow"></span>${zoomChip}
    </div>`;
  }
  /* 「带去做X」只吃素材。选中的全是文字/节点/分组时，这几个按钮没有意义 */
  const hasMedia = sel.some((i) => i.kind === 'media');
  const unsaved = sel.filter((i) => i.rid && !savedToLib(i.rid)).length;
  return `<div class="cvs-foot on">
    <span class="cvs-foot-count">已选 <b class="num">${sel.length}</b> 项</span>
    ${zoomChip}
    <button class="btn sm ghost cvs-clear" data-action="canvas-clear-sel">${icon('x')}取消选择</button>
    <div class="cvs-use-row">
      ${hasMedia ? Object.values(TYPES).map((x) => `<button class="btn sm soft" data-action="canvas-use" data-type="${x.key}">
        ${icon(x.ic)}带去做${x.name}</button>`).join('') : ''}
      ${unsaved ? `<span class="cvs-use-sep"></span>
      <button class="btn sm primary" data-action="cvs-save-lib">${icon('check')}保存到素材库${unsaved > 1 ? ` ${unsaved} 项` : ''}</button>` : ''}
      ${sel.length === 1 && sel[0].kind === 'media' ? `<span class="cvs-use-sep"></span>
      <button class="btn sm ai" data-action="diverge-open">${icon('sparkles')}发散</button>
      <button class="btn sm ghost" data-action="platforms-open">${icon('crop')}适配平台</button>` : ''}
    </div>
  </div>`;
}

/* 只重绘画布面板，不打断左侧表单输入 */
function paintCanvas() {
  const host = document.getElementById('canvasHost');
  if (!host) return;
  host.innerHTML = canvasPanel();
  cvsClampMenu();
  /* 文字是内容决定宽度的，量完再画线，端点才对得上 */
  cvsMeasureText();
  cvsSyncLinks();
  scheduleCanvasSave();
  historyTick();
}

/* 文字的宽高由内容决定，所以渲染完要把实测值写回数据。
   不写回的话，框选、分组、连线端点都还在用旧的估计值。 */
function cvsMeasureText() {
  const world = document.getElementById('cvsWorld');
  if (!world) return false;
  let dirty = false;
  canvasItems().forEach((i) => {
    if (i.kind !== 'text') return;
    const n = world.querySelector(`.cvs-el[data-id="${i.id}"]`);
    if (!n) return;
    const w = Math.ceil(n.offsetWidth);
    const h = Math.ceil(n.offsetHeight);
    if (w && h && (i.w !== w || i.h !== h)) { i.w = w; i.h = h; dirty = true; }
  });
  return dirty;
}

/* 只更新选中态：拖动期间不能重绘节点，否则会打断手势 */
/* 面板开着的时候，选区一变就重算——否则结论和范围对不上 */
function agentResync() {
  if (!State.agent || !State.agent.open) return;
  State.agent = { open: true, result: agentReadBoard() };
  renderMain();
}

function paintCvsSel() {
  const world = document.getElementById('cvsWorld');
  if (world) {
    world.querySelectorAll('.cvs-el').forEach((n) => n.classList.toggle('sel', State.canvasSel.includes(n.dataset.id)));
  }
  const foot = document.getElementById('cvsFootHost');
  if (foot) foot.innerHTML = canvasBarHTML();
  const chip = document.getElementById('cvsSelChip');
  if (chip) {
    const n = State.canvasSel.length;
    chip.textContent = n ? `已选 ${n} 项` : '';
    chip.style.display = n ? '' : 'none';
  }
}

/* 选区提交后（框选松手 / 单击切换）刷新 Agent 的范围 */
function afterSelChange() {
  if (State.agent && State.agent.open) agentResync();
}

/* 视口变换：平移缩放只改 transform，不走重渲染 */
function syncCvsView(live) {
  const world = live && live.world ? live.world : document.getElementById('cvsWorld');
  const grid = live && live.grid ? live.grid : document.getElementById('cvsGrid');
  const zoom = live && live.zoom != null ? live.zoom : document.getElementById('cvsZoom');
  if (!world) return;
  const v = cvsView();
  world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
  if (grid) {
    grid.style.backgroundSize = `${26 * v.k}px ${26 * v.k}px, ${26 * v.k}px ${26 * v.k}px, ${130 * v.k}px ${130 * v.k}px, ${130 * v.k}px ${130 * v.k}px`;
    grid.style.backgroundPosition = `${v.x}px ${v.y}px`;
  }
  if (zoom) zoom.textContent = `${Math.round(v.k * 100)}%`;
}

/* ---------- 7.4 基础编辑 ---------- */
const editPool = (type) => libResults().filter((r) => r.type === type
  && (State.editScope === 'all' || r.ws === State.ws));
const editPicked = (type) => {
  /* 先按 id 全局查找：从素材库跳进来的素材可能不属于当前空间，仍要保持选中 */
  const id = State.editPick[type];
  if (id) {
    const hit = State.results.find((r) => r.id === id);
    if (hit) return hit;
  }
  const pool = editPool(type);
  return pool[0] || null;
};

/* 把入点/出点收敛到当前素材的合法范围，保证滑块、数值与时间轴一致 */
function normalizeEditOps(t) {
  if (t === 'image') return;
  const cur = editPicked(t);
  const ops = State.editOps[t];
  const total = (cur && cur.dur) || (t === 'video' ? 5 : 30);
  const gap = t === 'video' ? 0.5 : 1;
  ops.in = clamp(ops.in, 0, Math.max(0, total - gap));
  ops.out = clamp(ops.out, ops.in + gap, total);
}

function renderEditPage() {
  const t = State.type;
  normalizeEditOps(t);
  const pool = editPool(t);
  const cur = editPicked(t);
  return `<div class="edit-grid">
    <div class="edit-col">
      <section class="card composer-card">
        <div class="composer-head">
          <span class="task-ic ${jobIconCls(t)}">${icon('crop')}</span>
          <div>
            <div class="ch-title">基础编辑 · ${TYPES[t].name}</div>
            <div class="ch-sub">只做简单处理，保存后生成一条新产出，原素材不受影响</div>
          </div>
        </div>
        <div class="composer-body">
          ${editSourcePicker(t, pool, cur)}
          ${editOpsPanel(t, cur)}
          <div class="edit-foot">
            <button class="btn ghost" data-action="edit-reset">${icon('refresh')}重置参数</button>
            <span class="grow"></span>
            <button class="btn primary" data-action="edit-save">${icon('check')}保存为新产出</button>
          </div>
        </div>
      </section>
    </div>
    <div class="edit-col">
      <section class="card">
        <div class="edit-stage-head">
          <span class="field-label">${icon('eye')}预览</span>
          <span class="grow"></span>
          <span class="tiny dim">${cur ? esc(cur.title) : ''}</span>
        </div>
        <div class="edit-stage" id="editStage">${editStageHTML(t, cur, State.editOps[t])}</div>
      </section>
    </div>
  </div>`;
}

/* 添加参考素材：从素材库里挑一条，和容器尺寸无关，只取缩略图 */
function refAddDrawer() {
  const pool = libResults().filter((r) => r.type === State.type
    && (State.refScope === 'all' || r.ws === State.ws));
  const picked = State.refs[State.type].map((x) => x.f);
  return `<div class="drawer-head">
    <span class="task-ic violet">${icon('image')}</span>
    <div class="dh-title-block">
      <div class="dh-title">添加参考素材</div>
      <div class="dh-sub">${TYPES[State.type].name} · ${pool.length} 项可选 · 最多 4 项</div>
    </div>
    <span class="grow"></span>
    <button class="icon-btn" data-action="close-drawer">${icon('x')}</button>
  </div>
  <div class="drawer-body">
    <div class="field-head" style="margin-bottom:10px">
      <span class="field-hint">当前项目 / 全部项目</span>
      <span class="grow"></span>
      ${[['ws', '当前项目'], ['all', '全部项目']].map(([k, n]) =>
      `<button class="fchip ${State.refScope === k ? 'on' : ''}" data-action="set-ref-scope" data-val="${k}">${n}</button>`).join('')}
    </div>
    ${pool.length ? `<div class="cvs-pick">${pool.map((r) => {
      const added = picked.includes(r.asset);
      const full = State.refs[State.type].length >= 4;
      return `<button class="cvs-pick-item ${added || full ? 'added' : ''}" data-action="${added || full ? 'noop' : 'add-ref-item'}" data-f="${r.asset}">
        <img src="${thumbPath(r)}" alt="" style="${r.edit && r.edit.css ? r.edit.css : ''}" />
        <span class="cpi-meta"><span class="cpi-name">${esc(r.title)}</span>
        <span class="cpi-act">${added ? '已加入' : full ? '已满 4 项' : '+ 添加'}</span></span>
        <span class="st-ws"><i style="background:${wsShort(r.ws).dot}"></i>${esc(wsShort(r.ws).name)}</span>
      </button>`;
    }).join('')}</div>` : `<div class="empty-state"><div class="es-ic">${icon('image')}</div>
      <div class="es-title">还没有可用的素材</div>
      <div class="es-desc">先到「生成」产出一条，或在素材库切到「全部项目」看看。</div></div>`}
  </div>`;
}

function editSourcePicker(t, pool, cur) {
  return `<div class="field-block">
    <div class="field-head"><span class="field-label">${icon('layers')}选择素材</span>
      <span class="field-hint">${pool.length} 项 · 点缩略图切换</span>
      <span class="grow"></span>
      ${[['ws', '当前空间'], ['all', '全部空间']].map(([k, n]) =>
      `<button class="fchip ${State.editScope === k ? 'on' : ''}" data-action="set-edit-scope" data-val="${k}">${n}</button>`).join('')}
    </div>
    ${pool.length ? `<div class="src-strip">
      ${pool.slice(0, 12).map((r) => `<button class="src-thumb ${cur && cur.id === r.id ? 'on' : ''}" data-action="edit-pick" data-id="${r.id}" title="${esc(r.title)} · ${esc(wsOf(r.ws).name)}">
        <img src="${thumbPath(r)}" alt="" style="${r.edit && r.edit.css ? r.edit.css : ''}" />
        <span class="st-name">${esc(r.title)}</span>
        <span class="st-ws"><i style="background:${wsShort(r.ws).dot}"></i>${esc(wsShort(r.ws).name)}</span>
      </button>`).join('')}
    </div>` : `<div class="tiny dim">${State.editScope === 'ws' ? `「${esc(wsShort(State.ws).name)}」还没有${TYPES[t].name}产出，可切到「全部空间」，或先到「生成」产出一条。` : `还没有${TYPES[t].name}产出，先到「生成」产出一条。`}</div>`}
  </div>`;
}

function rangeRow(label, key, val, min, max, unit, step) {
  return `<div class="form-row"><span class="form-label">${label}</span>
    <div class="edit-slider">
      <input type="range" min="${min}" max="${max}" step="${step || 1}" value="${val}" data-input="e-${key}" />
      <span class="esv num" data-readout="${key}" data-unit="${unit}">${val}${unit}</span>
    </div></div>`;
}

function editOpsPanel(t, cur) {
  const ops = State.editOps[t];
  if (t === 'image') {
    return `<div class="field-block">
        <div class="field-head"><span class="field-label">${icon('palette')}滤镜</span>
          <span class="field-hint">直接作用在画面色调上</span></div>
        <div class="opt-pills">${EDIT_FILTERS.map((f) => `<button class="opt-pill ${ops.filter === f.k ? 'on' : ''}" data-action="edit-op" data-key="filter" data-val="${f.k}">${f.n}</button>`).join('')}</div>
      </div>
      <div class="field-block">
        <div class="field-head"><span class="field-label">${icon('refresh')}翻转</span></div>
        <div class="opt-pills">
          <button class="opt-pill ${ops.flipH ? 'on' : ''}" data-action="edit-op" data-key="flipH" data-val="1">水平翻转</button>
          <button class="opt-pill ${ops.flipV ? 'on' : ''}" data-action="edit-op" data-key="flipV" data-val="1">垂直翻转</button>
        </div>
      </div>
      <div class="field-block">
        <div class="field-head"><span class="field-label">${icon('crop')}明暗与色彩</span>
          <span class="field-hint">0 为保持原样</span></div>
        ${rangeRow('亮度', 'brightness', ops.brightness, -50, 50, '%')}
        ${rangeRow('对比度', 'contrast', ops.contrast, -50, 50, '%')}
        ${rangeRow('饱和度', 'saturate', ops.saturate, -50, 50, '%')}
      </div>
      <div class="field-block">
        <div class="field-head"><span class="field-label">${icon('expand')}裁剪比例</span>
          <span class="field-hint">决定导出规格</span></div>
        <div class="opt-pills">${EDIT_CROPS.map((c) => `<button class="opt-pill ${ops.crop === c ? 'on' : ''}" data-action="edit-op" data-key="crop" data-val="${c}">${c}</button>`).join('')}</div>
      </div>`;
  }
  const clip = trimOf(t, ops, cur);
  if (t === 'video') {
    return `<div class="field-block">
        <div class="field-head"><span class="field-label">${icon('film')}裁剪时长</span>
        <span class="field-hint" data-trim-hint>保留 ${clip.len}s / 共 ${clip.total}s</span></div>
        ${rangeRow('入点', 'in', ops.in, 0, clip.total, 's', 0.5)}
        ${rangeRow('出点', 'out', ops.out, 0, clip.total, 's', 0.5)}
      </div>
      <div class="field-block">
        <div class="field-head"><span class="field-label">${icon('zap')}变速</span></div>
        <div class="opt-pills">${[0.5, 1, 1.5, 2].map((v) => `<button class="opt-pill ${ops.speed === v ? 'on' : ''}" data-action="edit-op" data-key="speed" data-val="${v}">${v}x</button>`).join('')}</div>
      </div>
      <div class="field-block">
        <div class="field-head"><span class="field-label">${icon('volume')}声音与封面</span></div>
        <div class="opt-pills">
          <button class="opt-pill ${ops.mute ? 'on' : ''}" data-action="edit-op" data-key="mute" data-val="1">静音</button>
          ${['首帧', '中间', '末帧'].map((c) => `<button class="opt-pill ${ops.cover === c ? 'on' : ''}" data-action="edit-op" data-key="cover" data-val="${c}">封面 ${c}</button>`).join('')}
        </div>
      </div>
      <div class="field-block">
        <div class="field-head"><span class="field-label">${icon('pen')}叠加字幕</span>
          <span class="field-hint">留空则不加</span></div>
        <input class="form-input" data-input="e-caption" value="${esc(ops.caption)}" placeholder="例如：春天第一杯冷萃" />
      </div>`;
  }
  return `<div class="field-block">
      <div class="field-head"><span class="field-label">${icon('waveform')}裁剪时长</span>
        <span class="field-hint" data-trim-hint>保留 ${clip.len}s / 共 ${clip.total}s</span></div>
      ${rangeRow('入点', 'in', ops.in, 0, clip.total, 's')}
      ${rangeRow('出点', 'out', ops.out, 0, clip.total, 's')}
    </div>
    <div class="field-block">
      <div class="field-head"><span class="field-label">${icon('volume')}音量与包络</span></div>
      ${rangeRow('音量', 'volume', ops.volume, 0, 150, '%', 5)}
      ${rangeRow('淡入', 'fadeIn', ops.fadeIn, 0, 3, 's', 0.5)}
      ${rangeRow('淡出', 'fadeOut', ops.fadeOut, 0, 3, 's', 0.5)}
    </div>
    <div class="field-block">
      <div class="field-head"><span class="field-label">${icon('shield')}清理</span></div>
      <div class="opt-pills">
        <button class="opt-pill ${ops.denoise ? 'on' : ''}" data-action="edit-op" data-key="denoise" data-val="1">降噪</button>
        <button class="opt-pill ${ops.norm ? 'on' : ''}" data-action="edit-op" data-key="norm" data-val="1">响度标准化 -3dB</button>
      </div>
    </div>`;
}

/* 编辑页的试看/试听条：复用全局模拟播放，进度条与时间码由 playbackTick 驱动 */
function editPlayRow(cur) {
  const playing = !!State.playing[cur.id];
  const total = cur.dur || (cur.type === 'video' ? 5 : 30);
  const t = playing ? State.play.t : 0;
  return `<div class="edit-play-row">
    <button class="sc-btn" data-action="toggle-play" data-id="${cur.id}" title="${playing ? '暂停' : '播放'}（本地模拟）">${icon(playing ? 'pause' : 'play')}</button>
    <div class="stage-track"><i data-playbar="${cur.id}" style="width:${((t / total) * 100).toFixed(1)}%"></i></div>
    <span class="stage-time" data-playtime="${cur.id}">${mmss(t)} / ${mmss(total)}</span>
  </div>`;
}

function editReadout(t, ops) {
  const sgn = (n) => (n > 0 ? `+${n}` : `${n}`);
  const items = t === 'image'
    ? [`滤镜 ${(EDIT_FILTERS.find((f) => f.k === ops.filter) || {}).n}`, `亮度 ${sgn(ops.brightness)}`, `对比度 ${sgn(ops.contrast)}`, `饱和度 ${sgn(ops.saturate)}`, `裁剪 ${ops.crop}`]
    : t === 'video'
      ? [`变速 ${ops.speed}x`, ops.mute ? '已静音' : '保留原声', `封面 ${ops.cover}`, ops.caption ? '含字幕' : '无字幕']
      : [`音量 ${ops.volume}%`, `淡入 ${ops.fadeIn}s`, `淡出 ${ops.fadeOut}s`, ops.denoise ? '已降噪' : '未降噪', ops.norm ? '响度标准化' : '不标准化'];
  return `<div class="edit-readout">${items.map((x) => `<span class="er-chip">${esc(x)}</span>`).join('')}</div>`;
}

function editStageHTML(t, cur, ops) {
  if (!cur) {
    return `<div class="empty-state"><div class="es-ic">${icon('image')}</div>
      <div class="es-title">还没有可编辑的${TYPES[t].name}</div>
      <div class="es-desc">先切换到「生成」产出一条，再回来做基础处理。</div></div>`;
  }
  const css = editCss(ops);
  const src = fullPath(cur);
  if (t === 'image') {
    const crop = ops.crop === '原图' ? (cur.ratio || '1:1') : ops.crop;
    return `<div class="es-media">
        <div class="es-cropframe" style="aspect-ratio:${crop.replace(':', ' / ')}">
          <img src="${src}" alt="${esc(cur.title)}" style="${css}" />
        </div>
      </div>
      <div class="trim-labels"><span>原图 ${esc(cur.ratio || '1:1')}</span>
        <span class="num">导出比例 ${esc(crop)}</span></div>
      ${editReadout(t, ops)}`;
  }
  if (t === 'video') {
    const clip = trimOf(t, ops, cur);
    const pos = ops.cover === '首帧' ? 'center top' : ops.cover === '末帧' ? 'center bottom' : 'center';
    return `${editPlayRow(cur)}
      <div class="es-media">
        <img src="${src}" alt="${esc(cur.title)}" style="object-position:${pos};${css}" />
        ${ops.caption ? `<span class="es-caption">${esc(ops.caption)}</span>` : ''}
        <span class="es-flag">${ops.mute ? icon('volume') + '已静音' : icon('volume') + '保留原声'}</span>
      </div>
      <div class="trim-wrap">
        <div class="trim-bar"><i class="trim-seg" style="left:${(clip.a / clip.total) * 100}%;width:${(clip.len / clip.total) * 100}%"></i></div>
        <div class="trim-labels"><span>0s</span>
          <span class="num">保留 ${mmss(clip.a)} – ${mmss(clip.b)} · ${clip.len}s</span>
          <span>${clip.total}s</span></div>
      </div>${editReadout(t, ops)}`;
  }
  const clip = trimOf(t, ops, cur);
  const bars = seededSeries(cur.seed, 64, 22, 100);
  return `${editPlayRow(cur)}
    <div class="edit-wave">
      ${bars.map((v) => `<i style="height:${v.toFixed(0)}%"></i>`).join('')}
      <div class="ew-sel" style="left:${(clip.a / clip.total) * 100}%;width:${(clip.len / clip.total) * 100}%"></div>
    </div>
    <div class="trim-labels"><span>0s</span>
      <span class="num">保留 ${mmss(clip.a)} – ${mmss(clip.b)} · ${clip.len}s</span>
      <span>${clip.total}s</span></div>
    ${editReadout(t, ops)}`;
}

/* 拖动滑块时只刷新预览，避免整页重绘打断拖拽 */
function syncEditStage() {
  const t = State.type;
  const el = $('#editStage');
  if (el) el.innerHTML = editStageHTML(t, editPicked(t), State.editOps[t]);
  $$('[data-readout]').forEach((n) => {
    const v = State.editOps[t][n.dataset.readout];
    if (v !== undefined) n.textContent = `${v}${n.dataset.unit || ''}`;
  });
  const clip = (t !== 'image') ? trimOf(t, State.editOps[t], editPicked(t)) : null;
  const hint = $('[data-trim-hint]');
  if (hint && clip) hint.textContent = `保留 ${clip.len}s / 共 ${clip.total}s`;
}

function editTags(t, ops) {
  if (t === 'image') {
    const f = EDIT_FILTERS.find((x) => x.k === ops.filter) || EDIT_FILTERS[0];
    const tags = ['已编辑'];
    if (f.k !== 'none') tags.push(f.n);
    if (ops.crop !== '原图') tags.push(`裁剪 ${ops.crop}`);
    if (ops.brightness || ops.contrast || ops.saturate) tags.push('调过明暗');
    return tags.slice(0, 3);
  }
  if (t === 'video') return ['已编辑', `变速 ${ops.speed}x`, ops.mute ? '已静音' : '保留原声'];
  return ['已编辑', `音量 ${ops.volume}%`, ops.denoise ? '已降噪' : '原声'];
}

/* ---------- 7.5 生成队列（抽屉） ---------- */
function queueRow(j) {
  const bar = j.status === 'running'
    ? `<div class="qbar"><i style="width:${j.progress}%"></i></div>`
    : j.status === 'failed' ? ''
      : `<div class="qbar waiting"><i style="width:100%"></i></div>`;
  const right = j.status === 'running'
    ? `<div class="row-actions"><span class="tiny dim num qr-pct">${j.progress}%</span>
        <button class="btn sm ghost" data-action="cancel-job" data-id="${j.id}">取消</button></div>`
    : j.status === 'queued'
      ? `<div class="row-actions"><button class="btn sm ghost" data-action="cancel-job" data-id="${j.id}">取消</button></div>`
      : `<div class="row-actions">
          <button class="btn sm ai" data-action="retry-fix" data-id="${j.id}" title="按建议修复参数后重试">${icon('wand')}修复</button>
          <button class="btn sm ghost" data-action="retry-job" data-id="${j.id}" title="参数不变，直接重试">重试</button>
        </div>`;
  return `<div class="queue-row" id="q-${j.id}">
    <span class="task-ic ${jobIconCls(j.type)}">${icon(TYPES[j.type].ic)}</span>
    <div style="min-width:0">
      <div class="qr-name">${esc(j.name)}</div>
      <div class="qr-sub">${esc(modelOf(j.model).name)} · ${esc(paramsBrief(j))} · ${j.cost} 点</div>
    </div>
    <div>${bar}
      ${j.status === 'failed'
      ? `<div class="tiny text-red" style="margin-top:4px">${esc(j.fail.reason)}</div>`
      : `<div class="tiny dim" style="margin-top:4px">${esc(j.status === 'running' ? (j.eta || '生成中…') : (j.queueNote || '排队中'))}</div>`}
    </div>
    <div>${chipOf(j.status)}</div>
    <div>${right}</div>
  </div>`;
}

/* 充值与点数：个人版没有审批，想用就直接充，10 元起步 */
function topupDrawer() {
  const w = State.wallet;
  const packs = [
    { p: 10, tag: '入门', note: '先试几张图' },
    { p: 30, tag: '常用', note: '够做一组主视觉' },
    { p: 100, tag: '划算', note: '批量出素材更省心' },
  ];
  const double = !w.firstTopupDone;
  const free = dailyFreeLeft();
  return `<div class="drawer-head">
      <span class="task-ic amber">${icon('coins')}</span>
      <div class="grow">
        <div class="drawer-title">点数与充值</div>
        <div class="drawer-sub"><span>1 点 = ¥1 · 按次扣费 · 点数不过期</span></div>
      </div>
      <button class="icon-btn drawer-close" data-action="close-drawer">${icon('x')}</button>
    </div>
    <div class="drawer-body">
      <div class="d-section">
        <div class="wallet-card">
          <div>
            <div class="tiny dim">当前余额</div>
            <div class="wc-balance num">${balance()}<span>点</span></div>
          </div>
          <div class="wc-side">
            <div class="tiny dim">累计消耗 ${spentTotal()} 点</div>
            <div class="wc-split">
              <span><i style="background:var(--primary)"></i>图像 ${w.spent.image}</span>
              <span><i style="background:var(--ai)"></i>视频 ${w.spent.video}</span>
              <span><i style="background:var(--blue)"></i>音频 ${w.spent.audio}</span>
            </div>
          </div>
        </div>
      </div>

      ${free > 0
      ? `<div class="free-tip">${icon('sparkles')}<span>今日还有 <b class="num">${free} 点</b> 免费额度，生成时自动优先抵扣；每天 0 点重置，不累积。</span></div>`
      : `<div class="free-tip done">${icon('check')}<span>今日免费额度已用完，明天 0 点重置。</span></div>`}

      <div class="d-section">
        <div class="d-section-title">${icon('coins')}充值${double ? ' · 首充翻倍' : ''}</div>
        <div class="pack-grid">
          ${packs.map((k) => {
        const got = double ? k.p * 2 : k.p;
        return `<button class="pack-card ${k.p === 30 ? 'hot' : ''}" data-action="topup" data-p="${k.p}">
              ${k.p === 30 ? `<span class="pack-hot">最常用</span>` : ''}
              <span class="pack-tag">${k.tag}</span>
              <span class="pack-price num">¥${k.p}</span>
              <span class="pack-got num">得 ${got} 点${double ? '<i>首充翻倍</i>' : ''}</span>
              <span class="pack-note">${k.note}</span>
            </button>`;
      }).join('')}
        </div>
        ${double ? `<div class="tiny dim" style="margin-top:8px">${icon('sparkles')}首次充值翻倍，每人限一次</div>` : ''}
      </div>

      <div class="d-section">
        <div class="d-section-title">${icon('shield')}你会得到什么</div>
        <div class="d-card d-card-pad">
          <div class="snap-row"><span class="sk">计费方式</span><span class="sv">按次扣费，用多少扣多少，没有月费</span></div>
          <div class="snap-row"><span class="sk">失败处理</span><span class="sv">生成失败的点数自动退回</span></div>
          <div class="snap-row"><span class="sk">有效期</span><span class="sv">点数不过期，不会每月清零</span></div>
          <div class="snap-row"><span class="sk">商用</span><span class="sv">产出可直接商用，不需要额外授权费</span></div>
          <div class="snap-row"><span class="sk">API</span><span class="sv">网页与 API 共用同一份余额</span></div>
        </div>
      </div>
    </div>
    <div class="drawer-foot">
      <span class="tiny dim">${icon('shield')}原型内为模拟充值，不产生真实扣款</span>
      <span class="grow"></span>
      <button class="btn ghost" data-action="close-drawer">关闭</button>
    </div>`;
}

/* 添加素材到画布：抽屉里连续挑，挑完接着摆 */
/* 队列改为抽屉：只在需要时展开，不占操作区，也不怕任务变多 */
function queueDrawer() {
  const all = queueJobs();
  const running = all.filter((j) => j.status === 'running');
  const queued = all.filter((j) => j.status === 'queued');
  const failed = all.filter((j) => j.status === 'failed');
  const onlyFailed = State.queueFilter === 'failed';
  const title = onlyFailed ? '失败任务' : '生成队列';
  return `<div class="drawer-head">
      <span class="task-ic ${onlyFailed ? 'red' : 'violet'}">${icon(onlyFailed ? 'alert' : 'clock')}</span>
      <div class="grow">
        <div class="drawer-title">${title}</div>
        <div class="drawer-sub">
          <span>生成中 ${running.length}</span><span class="dim">·</span>
          <span>排队 ${queued.length}</span><span class="dim">·</span>
          <span>失败 ${failed.length}</span>
        </div>
      </div>
      <div class="mini-tabs" style="margin-right:8px">
        ${[['all', '全部'], ['failed', '只看失败']].map(([k, n]) =>
      `<button class="${State.queueFilter === k ? 'active' : ''}" data-action="set-queue-filter" data-val="${k}">${n}</button>`).join('')}
      </div>
      <button class="icon-btn drawer-close" data-action="close-drawer">${icon('x')}</button>
    </div>
    <div class="drawer-body">
      ${!all.length ? `<div class="empty-state">
        <div class="es-ic">${icon('clock')}</div>
        <div class="es-title">队列是空的</div>
        <div class="es-desc">在任意类型页写一句提示词就能开始生成，任务会排队执行。</div>
      </div>` : (onlyFailed && !failed.length) ? `<div class="empty-state">
        <div class="es-ic">${icon('check')}</div>
        <div class="es-title">没有失败任务</div>
        <div class="es-desc">当前没有需要处理的失败任务，切回「全部」可看队列里的其他任务。</div>
      </div>` : `<div class="qd-list">
        ${failed.map(queueRow).join('')}
        ${onlyFailed ? '' : running.map(queueRow).join('')}
        ${onlyFailed ? '' : queued.map(queueRow).join('')}
      </div>`}
    </div>
    <div class="drawer-foot">
      <span class="tiny dim">${icon('shield')}任务完成后会保留在「任务记录」，不会自动清理</span>
      <span class="grow"></span>
      <button class="btn primary" data-action="go-jobs">${icon('list')}查看全部任务</button>
    </div>`;
}

function resultCard(r, idx) {
  const playing = !!State.playing[r.id];
  const isMedia = r.type !== 'image';
  const adopted = r.status === 'adopted';
  const fav = r.status === 'fav';
  return `<article class="result-card ${adopted ? 'adopted' : ''}" data-action="open-result" data-id="${r.id}"
    draggable="true" data-drag="${r.id}" title="拖进画板当参考">
    <div class="rc-media ratio-${r.ratio.replace(':', '-')} ${playing ? 'playing' : ''}">
      <img src="${thumbPath(r)}" alt="${esc(r.title)}" ${r.edit && r.edit.css ? `style="${r.edit.css}"` : ''} />
      <div class="rc-shade"></div>
      <div class="rc-badges">
        <span class="rc-badge">${r.ratio}</span>
        ${r.isNew ? `<span class="rc-badge new">新</span>` : ''}
        ${(() => { const j = jobById(r.job); return j && j.divergeAxis ? `<span class="rc-badge pick">${icon('sparkles')}${esc(j.divergeAxis)}</span>` : ''; })()}
        ${isMedia ? `<span class="rc-badge ${r.type === 'video' ? 'violet' : 'blue'}">${icon(TYPES[r.type].ic)}${r.dur}s</span>` : ''}
        ${adopted ? `<span class="rc-badge green">${icon('check')}已采用</span>` : fav ? `<span class="rc-badge">${icon('star')}收藏</span>` : ''}
      </div>
      <div class="rc-ops">
        <button class="rc-op ${fav ? 'on' : ''}" data-action="fav-result" data-id="${r.id}" title="收藏">${icon('star')}</button>
        <button class="rc-op" data-action="open-in-editor" data-id="${r.id}" title="在编辑器中打开">${icon('crop')}</button>
        <button class="rc-op" data-action="variant-result" data-id="${r.id}" title="以此为参考生成变体">${icon('refresh')}</button>
        <button class="rc-op" data-action="download-result" data-id="${r.id}" title="下载">${icon('download')}</button>
        <button class="rc-op" data-action="lib-edit" data-id="${r.id}" title="编辑标题 / 说明 / 标签">${icon('pen')}</button>
      </div>
      <button class="rc-pick ${State.libSelect.includes(r.id) ? 'on' : ''}" data-action="lib-sel" data-id="${r.id}"
        title="选中以打包成帖">${icon(State.libSelect.includes(r.id) ? 'check' : 'plus')}</button>
      ${isMedia ? `<button class="rc-center-play" data-action="toggle-play" data-id="${r.id}" title="播放（模拟）">${icon(playing ? 'pause' : 'play')}</button>` : ''}
      ${isMedia ? `<div class="rc-now"><i data-playbar="${r.id}" style="width:0%"></i></div>` : ''}
      ${r.type === 'audio' ? waveHTML(r, 'rc-wave') : ''}
      ${isMedia ? `<span class="rc-dur" data-playtime="${r.id}">${mmss(playing ? State.play.t : r.dur)}</span>` : ''}
    </div>
    <div class="rc-foot">
      <div class="rc-line"><span class="rc-idx">#${idx}</span><span class="grow">${esc(r.title)}</span></div>
      <div class="rc-line"><span class="ws-mini"><i style="background:${wsShort(r.ws).dot}"></i>${esc(wsShort(r.ws).name)}</span><span class="tiny dim">${esc(modelOf(r.model).name)}</span></div>
      <div class="rc-line rc-tags">${(r.tags || []).filter((x) => x !== r.ratio).slice(0, 2).map((x) => `<span class="rc-tag">${esc(x)}</span>`).join('')}</div>
      <div class="rc-actions">
        <button class="btn sm ${adopted ? 'ghost' : 'primary'}" data-action="adopt-result" data-id="${r.id}">${adopted ? icon('check') + '已采用' : '采用'}</button>
        <button class="btn sm ghost" data-action="open-result" data-id="${r.id}">详情</button>
      </div>
    </div>
  </article>`;
}

/* 音频波形：按种子生成确定性柱形，播放进度着色 */
function waveHTML(r, cls, bars = 40) {
  const series = seededSeries(r.seed, bars, 22, 100);
  const pct = State.playing[r.id] ? clamp(State.play.t / (r.dur || 30), 0, 1) : 0;
  const played = Math.round(bars * pct);
  return `<div class="wave ${cls || ''}">${series.map((v, i) =>
    `<i class="${i < played ? 'play' : ''}" style="height:${v.toFixed(0)}%"></i>`).join('')}</div>`;
}

/* ==================== 6.9 素材库：编辑与打包成帖 ====================
   产出本身是原型里的种子数据，刷新会回到初始状态。
   但「我给它改的标题/说明/标签」和「我攒出来的帖子」是用户自己产出的东西，
   不该跟着刷新一起丢掉，所以单独存一份在本地。 */
const META_KEY = 'aigc-studio-meta-v1';
const POSTS_KEY = 'aigc-studio-posts-v1';

function loadMeta() {
  let m = {};
  try { m = JSON.parse(localStorage.getItem(META_KEY) || '{}') || {}; } catch (e) { m = {}; }
  State.results.forEach((r) => {
    const x = m[r.id];
    if (!x) return;
    if (typeof x.title === 'string' && x.title) r.title = x.title;
    if (typeof x.note === 'string') r.note = x.note;
    if (Array.isArray(x.tags)) r.tags = x.tags;
  });
}

function saveMeta() {
  const m = {};
  State.results.forEach((r) => {
    if (r.title || r.note || (r.tags && r.tags.length)) {
      m[r.id] = { title: r.title, note: r.note || '', tags: r.tags || [] };
    }
  });
  try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch (e) { /* 配额满了就算了 */ }
}

function loadPosts() {
  try {
    const p = JSON.parse(localStorage.getItem(POSTS_KEY) || '[]');
    if (Array.isArray(p)) State.posts = p;
  } catch (e) { State.posts = []; }
}

function savePosts() {
  try { localStorage.setItem(POSTS_KEY, JSON.stringify(State.posts)); } catch (e) { /* 同上 */ }
}

const postById = (id) => State.posts.find((x) => x.id === id);

/* 界面偏好：表单收没收起、Agent 停不停靠。这是「我怎么用这个工具」，刷新该记住 */
const UI_KEY = 'aigc-studio-ui-v1';
function loadUI() {
  try {
    const u = JSON.parse(localStorage.getItem(UI_KEY) || '{}') || {};
    if (typeof u.formOpen === 'boolean') State.formOpen = u.formOpen;
    if (typeof u.agentDock === 'boolean') State.agentDock = u.agentDock;
  } catch (e) { /* 读不出来就用默认 */ }
}
function saveUI() {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify({
      formOpen: State.formOpen, agentDock: State.agentDock,
    }));
  } catch (e) { /* 配额满了就算了 */ }
}

/* ==================== 6.10 画板持久化与撤销 ====================
   画板是这个工具真正的工作面，不能刷新一次就没了。
   素材库、帖子、界面偏好都记得住，画板没理由记不住。 */
const CANVAS_KEY = 'aigc-studio-canvas-v1';

function loadCanvas() {
  let m = {};
  try { m = JSON.parse(localStorage.getItem(CANVAS_KEY) || '{}') || {}; } catch (e) { m = {}; }
  let lostLocal = 0;
  Object.keys(m).forEach((ws) => {
    const b = m[ws];
    if (!b || !Array.isArray(b.items)) return;
    /* 本地拖进来的文件是 blob URL，刷新后必然失效，只能丢掉并如实告知 */
    const keep = b.items.filter((i) => !i.local);
    lostLocal += b.items.length - keep.length;
    State.canvas[ws] = keep;
    const ids = new Set(keep.map((i) => i.id));
    State.cvsLinks[ws] = (Array.isArray(b.links) ? b.links : [])
      .filter((l) => ids.has(l.from) && ids.has(l.to));
    /* 序号要接上，否则新建元素会和恢复的撞 id */
    keep.forEach((i) => {
      const n = parseInt(String(i.id).replace(/^[cLP]/, ''), 10);
      if (!isNaN(n) && n > State.seq) State.seq = n;
    });
  });
  return lostLocal;
}

function saveCanvas() {
  const out = {};
  Object.keys(State.canvas).forEach((ws) => {
    out[ws] = { items: State.canvas[ws] || [], links: State.cvsLinks[ws] || [] };
  });
  try { localStorage.setItem(CANVAS_KEY, JSON.stringify(out)); } catch (e) { /* 配额满了就算了 */ }
}

/* 拖一次会改很多次，攒一下再写 */
let canvasSaveTimer = null;
function scheduleCanvasSave() {
  clearTimeout(canvasSaveTimer);
  canvasSaveTimer = setTimeout(saveCanvas, 350);
}

/* 快照：只关心「画板上有什么」和「谁连谁」 */
const snapKey = () => JSON.stringify({
  i: State.canvas[State.ws] || [],
  l: State.cvsLinks[State.ws] || [],
});
const lastSnap = {};

function applySnap(k) {
  const b = JSON.parse(k);
  State.canvas[State.ws] = b.i;
  State.cvsLinks[State.ws] = b.l;
  State.canvasSel = [];
  State.linkSel = null;
  State.cvsMenu = null;
  renderMain();
  if (State.canvasOpen) syncCvsView();
}

/* 每次画布稳定下来比一次：和上一版不同就压栈。
   这样不用给每个动作都手写快照，拖动、批量对齐这类多步操作也只记一步。 */
function historyTick() {
  const ws = State.ws;
  const k = snapKey();
  if (lastSnap[ws] === undefined) { lastSnap[ws] = k; return; }
  if (k === lastSnap[ws]) return;
  const h = State.history[ws] = State.history[ws] || [];
  h.push(lastSnap[ws]);
  if (h.length > 40) h.shift();
  State.future[ws] = [];
  lastSnap[ws] = k;
}

/* 表单收起后留下的那条竖条。收起来之后整个页面只剩画布和顶栏 */
function formStrip() {
  const T = TYPES[State.type];
  return `<button class="form-strip" data-action="toggle-form" title="展开生成表单（[）">
    <span class="fs-ic">${icon(T.ic)}</span>
    <span class="fs-label">${T.name}生成</span>
    <span class="fs-go">${icon('chev-right')}</span>
  </button>`;
}

/* 编辑产出：标题 / 说明 / 标签。产出是模拟的，但「这条我打算怎么用」是用户自己的判断 */
function resultEditDrawer(id) {
  const r = resultById(id);
  if (!r) return '';
  const j = jobById(r.job);
  const T = TYPES[r.type];
  return `<div class="drawer-head">
    <div class="grow">
      <div class="drawer-title">编辑产出</div>
      <div class="drawer-sub"><span>${T.name} · ${esc(modelOf(r.model).name)} · ${r.ratio}</span></div>
    </div>
    <button class="icon-btn drawer-close" data-action="close-drawer">${icon('x')}</button>
  </div>
  <div class="drawer-body">
    <div class="edit-thumb"><img src="${thumbPath(r)}" alt="" /></div>
    <div class="field-block">
      <div class="field-head"><span class="field-label">标题</span></div>
      <input class="form-input" data-input="edit-title" value="${esc(r.title)}" placeholder="给它起个名字" />
    </div>
    <div class="field-block">
      <div class="field-head"><span class="field-label">说明</span></div>
      <textarea class="prompt-input" data-input="edit-note" placeholder="这条打算怎么用？发哪个平台、配什么文案…">${esc(r.note || '')}</textarea>
    </div>
    <div class="field-block">
      <div class="field-head"><span class="field-label">标签</span></div>
      <input class="form-input" data-input="edit-tags" value="${esc((r.tags || []).join(' '))}" placeholder="空格分隔，例如：春季 咖啡 暖橙" />
      <div class="field-hint">标签会显示在卡片上，也是 Agent 读画板时的关键词来源。</div>
    </div>
    ${j ? `<div class="field-block">
      <div class="field-head"><span class="field-label">原始提示词</span></div>
      <div class="readonly-box">${esc(j.prompt)}</div>
    </div>` : ''}
  </div>
  <div class="drawer-foot">
    <button class="btn primary" data-action="edit-meta-save">${icon('check')}保存</button>
    <button class="btn ghost" data-action="close-drawer">取消</button>
  </div>`;
}

/* 帖子草稿：标题 + 正文 + 配图序列。素材库攒够了就打包成一条能发的内容 */
function postDrawer(id) {
  const p = postById(id);
  if (!p) return '';
  const items = p.items.map(resultById).filter(Boolean);
  const inPost = new Set(p.items);
  const pool = libResults()
    .filter((r) => (State.libScope === 'all' || r.ws === State.ws) && !inPost.has(r.id))
    .slice(0, 16);
  const bodyLen = (p.body || '').length;
  return `<div class="drawer-head">
    <div class="grow">
      <div class="drawer-title">帖子草稿</div>
      <div class="drawer-sub"><span>${items.length} 张配图 · 正文 ${bodyLen} 字</span>
        <span>·</span><span>存在本地，刷新不会丢</span></div>
    </div>
    <button class="icon-btn drawer-close" data-action="close-drawer">${icon('x')}</button>
  </div>
  <div class="drawer-body">
    <div class="field-block">
      <div class="field-head"><span class="field-label">标题</span></div>
      <input class="form-input" data-input="post-title" value="${esc(p.title)}" placeholder="这篇要讲什么" />
    </div>
    <div class="field-block">
      <div class="field-head"><span class="field-label">正文</span><span class="grow"></span>
        <span class="field-hint">${bodyLen} 字</span></div>
      <textarea class="prompt-input post-body" data-input="post-body" placeholder="正文…">${esc(p.body)}</textarea>
    </div>
    <div class="field-block">
      <div class="field-head"><span class="field-label">配图顺序</span><span class="grow"></span>
        <span class="field-hint">可拖动排序</span></div>
      ${items.length ? `<div class="post-items">${items.map((r, i) => `
        <div class="post-item" draggable="true" data-postitem="${r.id}" title="${esc(r.title)}">
          <span class="pi-idx num">${i + 1}</span>
          <img src="${thumbPath(r)}" alt="" />
          <div class="pi-ops">
            <button class="pi-op" data-action="post-item-up" data-id="${r.id}" title="前移">${icon('chev-left')}</button>
            <button class="pi-op" data-action="post-item-down" data-id="${r.id}" title="后移">${icon('chev-right')}</button>
            <button class="pi-op danger" data-action="post-item-del" data-id="${r.id}" title="移除">${icon('x')}</button>
          </div>
        </div>`).join('')}</div>`
      : `<div class="field-hint">还没有配图，从下面挑几张。</div>`}
    </div>
    <div class="field-block">
      <div class="field-head"><span class="field-label">从素材库添加</span></div>
      ${pool.length ? `<div class="post-pool">${pool.map((r) => `
        <button class="post-pool-item" data-action="post-item-add" data-id="${r.id}" title="${esc(r.title)}">
          <img src="${thumbPath(r)}" alt="" /><span class="pp-add">${icon('plus')}</span>
        </button>`).join('')}</div>`
      : `<div class="field-hint">素材库里没有别的产出了。先回创作台生成几张。</div>`}
    </div>
    <div class="field-block">
      <div class="field-head"><span class="field-label">目标平台</span></div>
      <div class="plat-row">${POST_PLATFORMS.map((x) => `
        <button class="plat-chip ${p.platform === x.k ? 'on' : ''}" data-action="post-platform" data-val="${x.k}"
          style="${p.platform === x.k ? `--pc:${x.color}` : ''}">
          <i style="background:${x.color}"></i>${x.n}</button>`).join('')}</div>
      <div class="field-hint">只是记下这条打算发哪儿，方便导出时按平台组织。</div>
    </div>
  </div>
  <div class="drawer-foot">
    <button class="btn primary" data-action="post-save">${icon('check')}保存</button>
    <button class="btn ghost" data-action="post-copy">${icon('copy')}复制正文</button>
    <button class="btn ghost" data-action="post-export">${icon('download')}导出 Markdown</button>
    <span class="grow"></span>
    <button class="btn ghost danger" data-action="post-del">${icon('trash')}删除</button>
  </div>`;
}

/* 帖子的纯文本形态：导出与复制共用 */
function postText(p) {
  const items = p.items.map(resultById).filter(Boolean);
  const plat = POST_PLATFORMS.find((x) => x.k === p.platform);
  const lines = [`# ${p.title}`, ''];
  if (p.body) { lines.push(p.body, ''); }
  if (items.length) {
    lines.push('---', '');
    items.forEach((r, i) => {
      lines.push(`![${r.title}](assets/results/${r.asset}.png)`);
      if (r.note) lines.push(`*${r.note}*`);
      lines.push('');
    });
  }
  lines.push('---', `目标平台：${plat ? plat.n : '未指定'} · 配图 ${items.length} 张`);
  return lines.join('\n');
}

function downloadText(name, text) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* 素材库第三个分桶：帖子 */
function renderPosts() {
  const list = scopePosts().sort((a, b) => (b.time || '').localeCompare(a.time || ''));
  return `<div class="page">
    <div class="toolbar">
      <div class="page-title-block">
        <span class="page-title">素材库</span>
        <span class="page-sub">${State.libScope === 'all' ? '全部项目' : esc(wsShort(State.ws).name)} · ${list.length} 条帖子草稿</span>
      </div>
      <span class="grow"></span>
      <button class="btn primary sm" data-action="post-new">${icon('plus')}新建帖子</button>
      <div class="lib-tabs">
        <button data-action="set-lib-tab" data-val="lib">${icon('check')}素材库 <i class="num">${scopeLib().length}</i></button>
        <button data-action="set-lib-tab" data-val="draft">${icon('box')}草稿箱 <i class="num">${scopeDraft().length}</i></button>
        <button class="on" data-action="set-lib-tab" data-val="post">${icon('send')}帖子 <i class="num">${scopePosts().length}</i></button>
      </div>
    </div>
    <div class="draft-note">${icon('send')}<span><b>帖子</b>是素材库攒够之后打包出来的成品：标题 + 正文 + 配图序列。存在本地，可以导出 Markdown 或直接复制正文。</span></div>
    <div class="lib-filters">
      <span class="of-label">范围</span>
      ${[['ws', '当前项目'], ['all', '全部项目']].map(([k, n]) =>
    `<button class="fchip ${State.libScope === k ? 'on' : ''}" data-action="set-lib-scope" data-val="${k}">${n}</button>`).join('')}
      <span class="grow"></span>
      <span class="tiny dim">共 ${list.length} 条</span>
    </div>
    ${list.length ? `<div class="result-grid">${list.map((p, i) => postCard(p, i + 1)).join('')}</div>`
      : `<div class="empty-state"><div class="es-ic">${icon('send')}</div>
        <div class="es-title">还没有帖子草稿</div>
        <div class="es-desc">回「素材库」勾选两张以上的产出，点「打包成帖」，就能在这里继续补标题和正文。</div></div>`}
  </div>`;
}

function postCard(p, idx) {
  const items = p.items.map(resultById).filter(Boolean);
  const plat = POST_PLATFORMS.find((x) => x.k === p.platform);
  return `<article class="result-card post-card" data-action="post-open" data-id="${p.id}">
    <div class="pc-media">
      ${items.slice(0, 4).map((r, i) => `<span class="pc-cell pc-${Math.min(items.length, 4)}" style="--i:${i}">
        <img src="${thumbPath(r)}" alt="" /></span>`).join('')
      || `<span class="pc-empty">${icon('image')}</span>`}
      <span class="pc-count">${items.length} 图</span>
    </div>
    <div class="rc-foot">
      <div class="rc-line"><span class="rc-idx">#${idx}</span><span class="grow">${esc(p.title || '未命名帖子')}</span></div>
      <div class="rc-line">${plat ? `<span class="plat-mini"><i style="background:${plat.color}"></i>${plat.n}</span>` : ''}
        <span class="grow"></span><span class="tiny dim">${(p.body || '').length} 字 · ${esc(p.time || '')}</span></div>
      <div class="rc-line rc-tags">${esc((p.body || '').slice(0, 30))}${(p.body || '').length > 30 ? '…' : ''}</div>
      <div class="rc-actions">
        <button class="btn sm primary" data-action="post-open" data-id="${p.id}">${icon('pen')}编辑</button>
        <button class="btn sm ghost" data-action="post-export" data-id="${p.id}">导出</button>
      </div>
    </div>
  </article>`;
}

/* ---------- 7.4 任务记录 ---------- */
function renderJobsPage() {
  const all = wsJobs().sort(sortByTime);
  const jobs = all.filter((j) => State.jobFilter === 'failed' ? j.status === 'failed'
    : State.jobFilter === 'running' ? ['running', 'queued'].includes(j.status) : true);
  /* 只统计真正产生结果的消耗，失败与已取消不计入 */
  const totalCost = round1(jobs.filter((j) => j.status === 'succeeded').reduce((n, j) => n + j.cost, 0));
  return `<div class="page">
    <div class="toolbar">
      <div class="page-title-block">
        <span class="page-title">任务记录</span>
        <span class="page-sub">${esc(wsOf(State.ws).name)} · ${jobs.length} 个任务 · 实际消耗 ${totalCost} 点（不含失败与已取消）</span>
      </div>
      <span class="grow"></span>
      <div class="mini-tabs">
        ${[['all', '全部'], ['failed', '失败'], ['running', '进行中']].map(([k, n]) =>
    `<button class="${State.jobFilter === k ? 'active' : ''}" data-action="set-job-filter" data-val="${k}">${n}</button>`).join('')}
      </div>
      <button class="btn ghost" data-action="go-studio">${icon('wand')}回到创作台</button>
    </div>
    ${failJobs().length ? `<div class="alert-bar">
      ${icon('alert')}<span><b>${failJobs().length} 个任务失败</b>：多为参数超限或时长超限，展开行可直接「按建议重试」。</span>
      <span class="right"><button class="btn sm ai" data-action="set-job-filter" data-val="failed">${icon('filter')}只看失败</button></span>
    </div>` : ''}
    <div class="card table-card jobs-table">
      <div class="t-head">
        <span></span><span>任务</span><span>提示词 / 参数</span>
        <span>状态</span><span>耗时</span><span class="th-right">点数</span><span class="th-right">操作</span>
      </div>
      ${jobs.length ? jobs.map(jobRow).join('') : `<div class="empty-state"><div class="es-ic">${icon('list')}</div>
        <div class="es-title">这个范围内没有任务</div><div class="es-desc">换一个项目或筛选条件，或回创作台发起一次生成。</div></div>`}
      <div class="table-foot">
        <span>共 ${jobs.length} 个任务</span><span class="dim">·</span>
        <span>成功 ${jobs.filter((j) => j.status === 'succeeded').length} · 失败 ${jobs.filter((j) => j.status === 'failed').length} · 进行中 ${jobs.filter((j) => ['running', 'queued'].includes(j.status)).length}</span>
        <span class="right dim">原型数据为静态示例 + 本地模拟</span>
      </div>
    </div>
    <div class="table-note">${icon('alert')}<span>点任意一行可展开，查看失败原因、修复建议与该任务的产出。</span></div>
  </div>`;
}

function jobRow(j) {
  const open = !!State.expanded[j.id];
  return `<div class="t-row ${open ? 'open' : ''} ${j.status === 'failed' ? 'row-fail' : ''}" data-action="toggle-job" data-id="${j.id}">
    <span class="caret">${icon('chev-right')}</span>
    <div class="cell-task">
      <span class="task-ic ${jobIconCls(j.type)}">${icon(TYPES[j.type].ic)}</span>
      <div class="task-main">
        <div class="task-name"><span class="name-text">${esc(j.name)}</span>
          ${j.refs ? `<span class="chip outline">${icon('link')}参考 ${j.refs}</span>` : ''}
          ${j.fixed ? `<span class="chip success">${icon('check')}已修复${j.fixLog && j.fixLog.length ? ' · ' + esc(j.fixLog.join(' · ')) : ''}</span>` : ''}
          ${j.divergeAxis ? `<span class="chip ai">${icon('sparkles')}发散 · ${esc(j.divergeAxis)}</span>` : ''}</div>
        <div class="task-meta">${esc(modelOf(j.model).name)}<span class="dim">·</span>${esc(wsOf(j.ws).name)}<span class="dim">·</span>${j.time}${j.results.length ? `<span class="dim">·</span>产出 ${j.results.length} 项` : ''}</div>
      </div>
    </div>
    <div class="cell-detail"><span class="prompt-line">${esc(promptBrief(j))}</span>
      <span class="tiny dim">${esc(paramsBrief(j))}</span></div>
    <div>${chipOf(j.status)}${j.status === 'running' ? `<div class="qbar" style="margin-top:5px"><i style="width:${j.progress}%" id="jc-${j.id}"></i></div>` : ''}</div>
    <div class="cell-time"><span class="time-line">${esc(j.durText || (j.status === 'running' ? (j.progress + '%') : '——'))}</span>
      <span class="time-note">${j.status === 'failed' ? `<span class="fail-link">${esc(j.fail.code)}</span>` : j.status === 'queued' ? esc(j.queueNote || '排队中') : ''}</span></div>
    <div class="right num strong">${j.cost}</div>
    <div class="row-actions">
      ${j.status === 'failed' ? `<button class="btn sm ai" data-action="retry-fix" data-id="${j.id}">${icon('wand')}修复重试</button>` : ''}
      ${j.status === 'succeeded' ? `<button class="btn sm ghost" data-action="open-job" data-id="${j.id}">${j.results.length ? '看产出' : '详情'}</button>` : ''}
      ${j.status === 'running' || j.status === 'queued' ? `<button class="btn sm ghost" data-action="cancel-job" data-id="${j.id}">取消</button>` : ''}
      ${j.status === 'canceled' ? `<button class="btn sm ghost" data-action="retry-job" data-id="${j.id}">重跑</button>` : ''}
    </div>
  </div>
  ${open ? jobSubWrap(j) : ''}`;
}

function jobSubWrap(j) {
  const items = resultsOfJob(j);
  return `<div class="sub-wrap"><div class="sub-inner">
    ${j.status === 'failed' ? `<div class="alert-bar" style="margin-bottom:10px">${icon('alert')}
      <span><b>${esc(j.fail.code)}</b> · ${esc(j.fail.reason)}<br><span class="tiny">修复建议：${esc(j.fail.fix)}</span></span>
      <span class="right">
        <button class="btn sm ai" data-action="retry-fix" data-id="${j.id}">${icon('wand')}按建议重试</button>
        <button class="btn sm ghost" data-action="retry-job" data-id="${j.id}">原样重试</button>
      </span></div>` : ''}
    <div class="sub-toolbar">
      <span class="hint">${items.length ? `产出 ${items.length} 项 · 采用 ${items.filter((r) => r.status === 'adopted').length} 项`
      : j.status === 'running' ? '生成中，产出会在完成后自动出现在这里。'
        : j.status === 'queued' ? '排队中，尚未开始生成。'
          : j.status === 'canceled' ? '任务已取消，可重跑。' : '该任务没有产出。'}</span>
      <span class="grow"></span>
      ${items.length ? `<button class="btn sm ghost" data-action="adopt-all" data-id="${j.id}">${icon('check')}全部采用</button>
      <button class="btn sm ghost" data-action="open-domain" data-domain="library">${icon('inbox')}在素材库查看</button>` : ''}
    </div>
    ${items.length ? `<div class="sub-table">
      ${items.map((r, i) => `<div class="sub-row">
        <img class="sub-thumb" src="${thumbPath(r)}" alt="" />
        <div><div class="strong">#${i + 1} ${esc(r.title)}</div>
          <div class="tiny dim">${esc(modelOf(r.model).name)} · 种子 ${r.seed} · ${r.ratio}${r.dur ? ` · ${r.dur}s` : ''}</div></div>
        <div>${r.status === 'adopted' ? '<span class="chip success"><span class="cdot"></span>已采用</span>'
      : r.status === 'fav' ? '<span class="chip warn"><span class="cdot"></span>收藏</span>'
        : '<span class="chip neutral"><span class="cdot"></span>待选</span>'}</div>
        <div class="tiny dim">${j.type === 'image' ? '图片' : j.type === 'video' ? '视频' : '音频'}</div>
        <div class="row-actions">
          <button class="icon-btn" data-action="download-result" data-id="${r.id}" title="下载">${icon('download')}</button>
          <button class="icon-btn" data-action="open-result" data-id="${r.id}" title="详情">${icon('eye')}</button>
        </div>
      </div>`).join('')}
    </div>` : ''}
  </div></div>`;
}

/* ============================ 8. 领域页 ============================ */
function renderDomain() {
  if (State.domain === 'library') return renderLibrary();
  return renderModels();
}

/* 素材库页有两个桶：素材库（确认保存的）和草稿箱（生成后没取用的） */
function renderLibrary() {
  if (State.libTab === 'draft') return renderDrafts();
  if (State.libTab === 'post') return renderPosts();
  const list = filteredResults();
  const all = libResults().filter((r) => State.libScope === 'all' || r.ws === State.ws);
  const count = (k) => all.filter((r) => k === 'all' ? true
    : k === 'adopted' ? r.status === 'adopted'
      : k === 'fav' ? r.status === 'fav' : r.type === k).length;
  return `<div class="page">
    <div class="toolbar">
      <div class="page-title-block">
        <span class="page-title">素材库</span>
        <span class="page-sub">${State.libScope === 'all' ? '全部项目' : esc(wsShort(State.ws).name)} · ${all.length} 项已保存</span>
      </div>
      <span class="grow"></span>
      <div class="lib-tabs">
        <button class="on" data-action="set-lib-tab" data-val="lib">${icon('check')}素材库 <i class="num">${scopeLib().length}</i></button>
        <button data-action="set-lib-tab" data-val="draft">${icon('box')}草稿箱 <i class="num">${scopeDraft().length}</i></button>
        <button data-action="set-lib-tab" data-val="post">${icon('send')}帖子 <i class="num">${scopePosts().length}</i></button>
      </div>
    </div>
    <div class="lib-stats">
      ${[['全部产出', all.length, '项'], ['已采用', count('adopted'), '项'], ['收藏', count('fav'), '项'],
    ['图像 / 视频 / 音频', `${count('image')} / ${count('video')} / ${count('audio')}`, '']]
      .map(([k, v, u]) => `<div class="lib-stat"><span class="k">${k}</span><span class="v num">${v}<i>${u}</i></span></div>`).join('')}
    </div>
    <div class="lib-filters">
      <span class="of-label">范围</span>
      ${[['ws', '当前项目'], ['all', '全部项目']].map(([k, n]) =>
      `<button class="fchip ${State.libScope === k ? 'on' : ''}" data-action="set-lib-scope" data-val="${k}">${n}</button>`).join('')}
      <span class="tf-sep"></span>
      <span class="of-label">类型与状态</span>
      ${[['all', '全部'], ['image', '图像'], ['video', '视频'], ['audio', '音频'], ['adopted', '已采用'], ['fav', '收藏']].map(([k, n]) =>
    `<button class="fchip ${State.libFilter === k ? 'on' : ''}" data-action="set-lib-filter" data-val="${k}">${n} <i class="num">${count(k)}</i></button>`).join('')}
      <span class="tf-sep"></span>
      <div class="search-mini">${icon('search')}<input placeholder="搜索标题 / 提示词 / 标签" data-input="lib-search" value="${esc(State.libSearch)}" /></div>
      <span class="grow"></span>
      <span class="tiny dim">共 ${list.length} 项匹配</span>
    </div>
    ${State.libSelect.length ? `<div class="lib-pack-bar">
      <span class="lpb-n">已选 <b class="num">${State.libSelect.length}</b> 项</span>
      <span class="tiny dim">选 ≥2 项就能打包成一条帖子</span>
      <span class="grow"></span>
      <button class="btn sm ghost" data-action="lib-sel-clear">清空选择</button>
      <button class="btn sm primary" data-action="lib-pack"${State.libSelect.length < 2 ? ' disabled' : ''}>${icon('send')}打包成帖</button>
    </div>` : ''}
    ${list.length ? `<div class="result-grid">${list.map((r, i) => resultCard(r, i + 1)).join('')}</div>`
      : `<div class="empty-state"><div class="es-ic">${icon('inbox')}</div>
        <div class="es-title">没有匹配的产出</div><div class="es-desc">调整筛选条件或清空搜索词，也可以切到「全部项目」。</div></div>`}
    <div class="table-note">${icon('link')}<span>卡片上的「变体」会把该结果设为参考素材并回填提示词，直接继续生成。</span></div>
  </div>`;
}

/* 草稿箱：生成后没被拖进画布的内容。不是删除，只是没被选中 */
function renderDrafts() {
  const all = draftResults().filter((r) => State.libScope === 'all' || r.ws === State.ws).sort(sortByTime);
  const list = all.filter((r) => {
    if (State.libFilter === 'image' || State.libFilter === 'video' || State.libFilter === 'audio') return r.type === State.libFilter;
    return true;
  }).filter((r) => {
    if (!State.libSearch) return true;
    const j = jobById(r.job);
    const hay = `${r.title} ${j ? j.prompt : ''} ${r.tags.join(' ')}`.toLowerCase();
    return hay.includes(State.libSearch.toLowerCase());
  });
  const c = (k) => k === 'all' ? all.length : all.filter((r) => r.type === k).length;
  return `<div class="page">
    <div class="toolbar">
      <div class="page-title-block">
        <span class="page-title">素材库</span>
        <span class="page-sub">${State.libScope === 'all' ? '全部项目' : esc(wsShort(State.ws).name)} · ${libResults().length} 项已保存</span>
      </div>
      <span class="grow"></span>
      <div class="lib-tabs">
        <button data-action="set-lib-tab" data-val="lib">${icon('check')}素材库 <i class="num">${scopeLib().length}</i></button>
        <button class="on" data-action="set-lib-tab" data-val="draft">${icon('box')}草稿箱 <i class="num">${scopeDraft().length}</i></button>
        <button data-action="set-lib-tab" data-val="post">${icon('send')}帖子 <i class="num">${scopePosts().length}</i></button>
      </div>
    </div>
    <div class="draft-note">${icon('box')}<span><b>草稿箱</b>存放生成后没被拖进画布的内容。它们没有删除——想用的话「捞回画布」再加工，或者直接「存进素材库」。</span></div>
    <div class="lib-filters">
      <span class="of-label">范围</span>
      ${[['ws', '当前项目'], ['all', '全部项目']].map(([k, n]) =>
      `<button class="fchip ${State.libScope === k ? 'on' : ''}" data-action="set-lib-scope" data-val="${k}">${n}</button>`).join('')}
      <span class="tf-sep"></span>
      <span class="of-label">类型</span>
      ${[['all', '全部'], ['image', '图像'], ['video', '视频'], ['audio', '音频']].map(([k, n]) =>
      `<button class="fchip ${State.libFilter === k ? 'on' : ''}" data-action="set-lib-filter" data-val="${k}">${n} <i class="num">${c(k)}</i></button>`).join('')}
      <span class="tf-sep"></span>
      <div class="search-mini">${icon('search')}<input placeholder="搜索标题 / 提示词 / 标签" data-input="lib-search" value="${esc(State.libSearch)}" /></div>
      <span class="grow"></span>
      <span class="tiny dim">共 ${list.length} 项</span>
    </div>
    ${list.length ? `<div class="result-grid">${list.map((r) => draftCard(r)).join('')}</div>`
      : `<div class="empty-state"><div class="es-ic">${icon('check')}</div>
        <div class="es-title">草稿箱是空的</div><div class="es-desc">生成之后没拖进画布的内容会落到这里，不用手动清理。</div></div>`}
  </div>`;
}

function draftCard(r) {
  const isMedia = r.type !== 'image';
  return `<article class="result-card draft">
    <div class="rc-media ratio-${r.ratio.replace(':', '-')}">
      <img src="${thumbPath(r)}" alt="${esc(r.title)}" style="${r.edit && r.edit.css ? r.edit.css : ''}" />
      <div class="rc-shade"></div>
      <div class="rc-badges">
        <span class="rc-badge">${r.ratio}</span>
        <span class="rc-badge">${icon('box')}草稿</span>
        ${isMedia ? `<span class="rc-badge ${r.type === 'video' ? 'violet' : 'blue'}">${icon(TYPES[r.type].ic)}${r.dur}s</span>` : ''}
      </div>
      <div class="rc-ops">
        <button class="rc-op" data-action="cvs-keep" data-id="${r.id}" title="捞回画布">${icon('layers')}</button>
        <button class="rc-op" data-action="draft-to-lib" data-id="${r.id}" title="存进素材库">${icon('check')}</button>
        <button class="rc-op" data-action="download-result" data-id="${r.id}" title="下载">${icon('download')}</button>
      </div>
    </div>
    <div class="rc-foot">
      <div class="rc-line"><span class="grow" title="${esc(r.title)}">${esc(r.title)}</span></div>
      <div class="rc-line"><span class="ws-mini"><i style="background:${wsShort(r.ws).dot}"></i>${esc(wsShort(r.ws).name)}</span><span class="tiny dim">${esc(modelOf(r.model).name)}</span></div>
      <div class="rc-line rc-tags">${(r.tags || []).filter((x) => x !== r.ratio).slice(0, 2).map((x) => `<span class="rc-tag">${esc(x)}</span>`).join('')}</div>
      <div class="rc-actions">
        <button class="btn sm ghost" data-action="cvs-keep" data-id="${r.id}">${icon('layers')}捞回画布</button>
        <button class="btn sm primary" data-action="draft-to-lib" data-id="${r.id}">${icon('check')}存进素材库</button>
      </div>
    </div>
  </article>`;
}

/* 价格把「点」换算成一眼能懂的花费，比抽象单价更有用 */
const MODEL_SAMPLE = {
  'm-img-u2': '生成 4 张标准图约 1.2 点',
  'm-img-f2': '生成 4 张草图约 0.32 点',
  'm-img-x1': '生成 4 张约 1.8 点',
  'm-vid-c1': '一条 5 秒片约 4 点',
  'm-vid-f1': '一条 3 秒循环约 0.75 点',
  'm-aud-tts': '一条 30 秒配音约 0.5 点',
  'm-aud-mus': '一条 60 秒配乐约 1.2 点',
  'm-aud-sfx': '一条音效约 0.1 点',
};

/* ---------- 审美库：长期积累的那一层 ----------
   不是「我的产出归档」，而是「我认可的东西」——可以来自任何项目，也可以来自外部。 */
function renderAesthetic() {
  const all = State.aesthetic;
  const list = all.filter((a) => State.aestheticFilter === 'all' || a.kind === State.aestheticFilter);
  const c = (k) => (k === 'all' ? all.length : all.filter((a) => a.kind === k).length);
  const kinds = { image: '图片', video: '视频', web: '网页' };
  return `<div class="page">
    <div class="toolbar">
      <div class="page-title-block">
        <span class="page-title">审美库</span>
        <span class="page-sub">${all.length} 件藏品 · 跨项目、跨来源，长期积累你自己的判断标准</span>
      </div>
      <span class="grow"></span>
      <button class="btn ghost" data-action="aesthetic-add-file">${icon('upload')}从电脑收藏</button>
    </div>
    <div class="aes-note">${icon('star')}<span><b>审美库和素材库不是一回事。</b>
      素材库装这个项目产出的、要交付的东西；审美库装你个人认可的、代表你品味的东西——跨项目、可以是外部内容、长期留着。
      它的用途是：看得多了，你才知道自己要什么。</span></div>
    <div class="lib-filters">
      <span class="of-label">类型</span>
      ${[['all', '全部'], ['image', '图片'], ['video', '视频'], ['web', '网页']].map(([k, n]) =>
      `<button class="fchip ${State.aestheticFilter === k ? 'on' : ''}" data-action="set-aes-filter" data-val="${k}">${n} <i class="num">${c(k)}</i></button>`).join('')}
      <span class="grow"></span>
      <span class="tiny dim">共 ${list.length} 件</span>
    </div>
    ${list.length ? `<div class="aes-grid">${list.map(aesCard).join('')}</div>`
      : `<div class="empty-state"><div class="es-ic">${icon('star')}</div>
        <div class="es-title">审美库还是空的</div>
        <div class="es-desc">在画板或素材库里点收藏，就会收到这里；也可以直接从电脑收藏图片。</div></div>`}
    <div class="table-note">${icon('link')}<span>收藏时会顺手存一份缩略图，所以外部图片也能长期留在库里。</span></div>
  </div>`;
}

function aesCard(a) {
  const isWeb = a.kind === 'web';
  return `<article class="aes-card">
    <div class="aes-media">
      ${isWeb
      ? `<div class="aes-web">${icon('globe')}<span>${esc(cvsHost(a.url || a.src))}</span></div>`
      : `<img src="${esc(a.src)}" alt="${esc(a.t)}" />`}
      <div class="aes-shade"></div>
      <button class="aes-del" data-action="aes-remove" data-id="${a.id}" title="移出审美库">${icon('x')}</button>
    </div>
    <div class="aes-body">
      <div class="aes-title" title="${esc(a.t)}">${esc(a.t)}</div>
      ${a.note ? `<div class="aes-note-line">${esc(a.note)}</div>` : ''}
      <div class="aes-meta">
        ${(a.tags || []).slice(0, 2).map((t) => `<span class="mini-tag">${esc(t)}</span>`).join('')}
        <span class="grow"></span>
        <span class="tiny dim">${esc(a.from || '外部收藏')} · ${esc(a.at || '')}</span>
      </div>
    </div>
  </article>`;
}

/* ---------- API 接入：给专业用户的第二入口 ----------
   网页与 API 共用同一份点数余额，不额外收费；调用失败不扣费。 */
const API_SNIPPETS = {
  curl: `curl https://api.proma.ai/v1/images \\
  -H "Authorization: Bearer $PROMA_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "aurora-image-u2",
    "prompt": "暖橙主色背景，哑光纸杯居中，顶部柔光，留出标题安全区",
    "size": "2048x2048",
    "n": 4
  }'`,
  python: `from proma import Proma

client = Proma(api_key="sk-live-xxxxxxxx")

res = client.images.generate(
    model="aurora-image-u2",
    prompt="暖橙主色背景，哑光纸杯居中，顶部柔光，留出标题安全区",
    size="2048x2048",
    n=4,
)

for img in res.data:
    print(img.url)`,
  node: `import Proma from "proma";

const client = new Proma({ apiKey: process.env.PROMA_API_KEY });

const res = await client.images.generate({
  model: "aurora-image-u2",
  prompt: "暖橙主色背景，哑光纸杯居中，顶部柔光，留出标题安全区",
  size: "2048x2048",
  n: 4,
});

console.log(res.data.map((d) => d.url));`,
};

function renderApi() {
  const usedN = State.apiUsage.reduce((n, u) => n + u.n, 0);
  const usedPts = round1(State.apiUsage.reduce((n, u) => n + u.pts, 0));
  return `<div class="page">
    <div class="toolbar">
      <div class="page-title-block">
        <span class="page-title">API 接入</span>
        <span class="page-sub">用同一份余额按量计费，不额外收费 · 适合接进 agent、脚本或批量工具</span>
      </div>
      <span class="grow"></span>
      <button class="btn primary" data-action="open-topup">${icon('coins')}充值点数</button>
    </div>

    <div class="api-wallet">
      ${icon('coins')}
      <div>
        <div class="aw-balance">${balance()}<span>点</span></div>
        <div class="tiny dim">网页与 API 共用这一份余额 · 今日调用 ${usedN} 次，消耗 ${usedPts} 点</div>
      </div>
      <span class="grow"></span>
      <span class="chip success">${icon('check')}计费互通</span>
    </div>

    <div class="catalog-sec">
      <div class="catalog-sec-name">密钥</div>
      <div class="card table-card">
        <div class="key-head">
          <span>名称</span><span>Key</span><span>创建时间</span><span>最近调用</span><span class="th-right">操作</span>
        </div>
        ${State.apiKeys.map((k) => `<div class="key-row ${k.on ? '' : 'off'}">
          <span class="kr-name">${esc(k.name)}<span class="ch-chip">${esc(channelOf(k.ch).name)}</span></span>
          <span class="kr-key">${esc(k.key)}</span>
          <span class="tiny dim">${esc(k.created)}</span>
          <span class="tiny dim">${esc(k.lastUsed || '从未调用')}</span>
          <div class="row-actions">
            <button class="btn sm ghost" data-action="api-copy">${icon('copy')}复制</button>
            <button class="btn sm ghost" data-action="api-toggle" data-id="${k.id}">${k.on ? '停用' : '启用'}</button>
            <button class="btn sm ghost" data-action="api-delete" data-id="${k.id}">${icon('trash')}删除</button>
          </div>
        </div>`).join('')}
        <div class="key-row key-new">
          <button class="btn sm primary" data-action="api-create-key">${icon('plus')}创建新 Key</button>
          <span class="tiny dim">Key 只在创建时完整展示一次；原型内为演示数据</span>
        </div>
      </div>
    </div>

    <div class="catalog-sec">
      <div class="catalog-sec-name">按量价格</div>
      <div class="card table-card price-table">
        <div class="key-head"><span>模型</span><span>单价</span><span>常见用法</span><span class="th-right">约合</span></div>
        ${MODELS.map((m) => `<div class="key-row">
          <span class="kr-name">${esc(m.name)}<span class="ch-chip">${esc(channelOf(m.ch).name)}</span></span>
          <span>${m.price} 点 / ${m.basis}</span>
          <span class="tiny dim">${esc(MODEL_SAMPLE[m.id] || '')}</span>
          <span class="right tiny dim">¥${m.price}</span>
        </div>`).join('')}
      </div>
      <div class="table-note">${icon('shield')}<span>调用失败不扣费；超出并发上限返回 429；按量计费，没有月费与最低消费。</span></div>
    </div>

    <div class="catalog-sec">
      <div class="catalog-sec-name">用量与账单</div>
      <div class="card table-card">
        <div class="key-head"><span>时间</span><span>模型</span><span>次数</span><span class="th-right">消耗</span></div>
        ${State.apiUsage.map((u) => `<div class="key-row">
          <span class="num">${esc(u.t)}</span>
          <span>${esc(modelOf(u.model).name)}</span>
          <span class="num">${u.n} 次</span>
          <span class="right num">${u.pts} 点</span>
        </div>`).join('')}
        <div class="key-row key-sum">
          <span class="tiny dim">今日合计</span><span></span>
          <span class="num tiny dim">${usedN} 次</span>
          <span class="right num">${usedPts} 点</span>
        </div>
      </div>
    </div>

    <div class="catalog-sec">
      <div class="catalog-sec-name">快速开始</div>
      <div class="card code-card">
        <div class="code-head">
          <span class="field-label">${icon('cpu')}示例代码</span>
          <span class="grow"></span>
          <div class="mini-tabs">
            ${['curl', 'python', 'node'].map((l) => `<button class="${State.apiLang === l ? 'active' : ''}" data-action="api-lang" data-val="${l}">${l}</button>`).join('')}
          </div>
          <button class="btn sm ghost" data-action="api-copy-code">${icon('copy')}复制</button>
        </div>
        <pre class="code-block">${esc(API_SNIPPETS[State.apiLang])}</pre>
        <div class="code-foot">${icon('link')}<span>把 Key 放进环境变量 <b>PROMA_API_KEY</b>，不要写死在代码里。</span></div>
      </div>
    </div>

    <div class="catalog-sec">
      <div class="catalog-sec-name">渠道</div>
      <div class="card table-card">
        <div class="key-head ch-head"><span>渠道</span><span>说明</span><span class="th-right">覆盖模型</span></div>
        ${CHANNELS.map((c) => `<div class="key-row ch-row">
          <span class="kr-name">${esc(c.name)}</span>
          <span class="tiny dim">${esc(c.note)}</span>
          <span class="right num">${MODELS.filter((m) => m.ch === c.id).length} 个</span>
        </div>`).join('')}
      </div>
      <div class="table-note">${icon('shield')}<span>Key 按渠道签发：换渠道要换 Key。同一能力可能有多条渠道可选，按延迟与成本自行取舍。</span></div>
      </div>
    </div>
  </div>`;
}

function renderModels() {
  return `<div class="page">
    <div class="toolbar">
      <div class="page-title-block">
        <span class="page-title">模型与价格</span>
        <span class="page-sub">按次计费，没有订阅 · 1 点 = ¥1 · 当前余额 ${balance()} 点</span>
      </div>
      <span class="grow"></span>
      <button class="btn primary" data-action="open-topup">${icon('coins')}充值点数</button>
    </div>
    <div class="promise-row">
      <div class="promise"><span class="pm-ic">${icon('check')}</span><b>不订阅</b><span>用多少扣多少，没有月费</span></div>
      <div class="promise"><span class="pm-ic">${icon('refresh')}</span><b>失败自动退回</b><span>生成失败的点数原路退回</span></div>
      <div class="promise"><span class="pm-ic">${icon('clock')}</span><b>点数不过期</b><span>不会每月清零</span></div>
      <div class="promise"><span class="pm-ic">${icon('shield')}</span><b>可商用</b><span>产出可直接商用</span></div>
    </div>
    ${['image', 'video', 'audio'].map((t) => `
      <div class="catalog-sec">
        <div class="catalog-sec-name">${TYPES[t].name}模型</div>
        <div class="model-grid">
          ${modelsOf(t).map((m) => `
            <div class="card model-card">
              <div class="model-top">
                <span class="task-ic ${jobIconCls(t)}">${icon('cpu')}</span>
                <div><div class="model-name">${esc(m.name)}</div><div class="model-id">约 ¥${m.price} / ${m.basis}</div></div>
                <div class="model-price"><div class="p num">${m.price}</div><div class="u">点 / ${m.basis}</div></div>
              </div>
              <div class="small t2">${esc(m.note)}</div>
              <div class="model-caps">${m.caps.map((c) => `<span class="cap-chip">${esc(c)}</span>`).join('')}</div>
              <div class="tiny dim">限制：${esc(m.limit)}</div>
              <div class="model-foot">
                ${m.status === 'on' ? `<span class="chip success"><span class="cdot"></span>可用</span>` : `<span class="chip neutral"><span class="cdot"></span>未开放</span>`}
                <span class="grow"></span>
                <span class="tiny dim">${esc(MODEL_SAMPLE[m.id] || '')}</span>
              </div>
            </div>`).join('')}
        </div>
      </div>`).join('')}
    <div class="table-note">${icon('link')}<span>要批量调用？到「API 接入」创建 Key，用同一份余额按量计费，不额外收费。</span></div>
  </div>`;
}

/* ============================ 9. 抽屉 / 模态 / Toast ============================ */
function renderDrawer() {
  const d = State.drawer;
  const el = $('#drawer');
  document.body.classList.toggle('drawer-open', !!d);
  if (!d) { el.hidden = true; $('#overlay').hidden = true; return; }
  el.innerHTML = d.type === 'result' ? resultDrawer(d.id)
    : d.type === 'help' ? helpDrawer()
      : d.type === 'queue' ? queueDrawer()
        : d.type === 'ref-add' ? refAddDrawer()
          : d.type === 'edit' ? resultEditDrawer(d.id)
            : d.type === 'post' ? postDrawer(d.id)
              : topupDrawer();
  el.hidden = false;
  $('#overlay').hidden = false;
}

function resultDrawer(id) {
  const r = resultById(id);
  if (!r) return '';
  const j = jobById(r.job);
  const playing = !!State.playing[r.id];
  const isMedia = r.type !== 'image';
  return `
    <div class="drawer-head">
      <span class="task-ic ${jobIconCls(r.type)}">${icon(TYPES[r.type].ic)}</span>
      <div class="grow">
        <div class="drawer-title">${esc(r.title)}</div>
        <div class="drawer-sub">${typeChip(r.type)}<span>${esc(modelOf(r.model).name)}</span><span class="dim">·</span><span>${r.time}</span><span class="dim">·</span><span>${esc(wsOf(r.ws).name)}</span></div>
      </div>
      <button class="icon-btn drawer-close" data-action="close-drawer">${icon('x')}</button>
    </div>
    <div class="drawer-body">
      <div class="d-section">
        <div class="stage">
          <div class="stage-media ${playing ? 'playing' : ''}">
            <img src="${fullPath(r)}" alt="${esc(r.title)}" ${r.edit && r.edit.css ? `style="${r.edit.css}"` : ''} />
          </div>
          ${isMedia ? `<div class="stage-ctrl">
            <button class="sc-btn" data-action="toggle-play" data-id="${r.id}">${icon(playing ? 'pause' : 'play')}</button>
            <div class="stage-track"><i data-playbar="${r.id}" style="width:0%"></i></div>
            <span class="stage-time" data-playtime="${r.id}">${mmss(playing ? State.play.t : r.dur)} / ${mmss(r.dur)}</span>
            ${r.type === 'audio' ? icon('volume') : icon('film')}
          </div>` : ''}
        </div>
        <div class="tiny dim" style="margin-top:6px">${isMedia
      ? '播放为本地模拟：原型内不含真实音视频文件，进度与时间码用于演示交互。'
      : '图片由 GPT Image 2.5 生成，作为示意产物用于演示画廊与交付流程。'}</div>
      </div>

      <div class="d-section">
        <div class="summary-strip">
          <div class="summary-cell"><span class="k">模型</span><span class="v" style="font-size:12.5px">${esc(modelOf(r.model).name)}</span></div>
          <div class="summary-cell"><span class="k">比例 / 时长</span><span class="v num">${r.ratio}${r.dur ? ` · ${r.dur}s` : ''}</span></div>
          <div class="summary-cell"><span class="k">随机种子</span><span class="v num">${r.seed}</span></div>
          <div class="summary-cell"><span class="k">状态</span><span class="v" style="font-size:12.5px">${r.status === 'adopted' ? '已采用' : r.status === 'fav' ? '收藏' : '待选'}</span></div>
        </div>
      </div>

      ${r.type === 'audio' ? `<div class="d-section">
        <div class="d-section-title">${icon('waveform')}波形</div>
        <div class="d-card d-card-pad">${waveHTML(r, 'wave-lg', 56)}</div>
      </div>` : ''}

      <div class="d-section">
        <div class="d-section-title">${icon('pen')}提示词</div>
        <div class="d-card d-card-pad">
          <div class="prompt-quote">${esc(j ? j.prompt : '——')}</div>
          <div class="flex mt8">
            <button class="btn sm ghost" data-action="copy-prompt-of" data-id="${r.id}">${icon('copy')}复制提示词</button>
            <button class="btn sm ghost" data-action="variant-result" data-id="${r.id}">${icon('refresh')}以此为参考生成变体</button>
          </div>
        </div>
      </div>

      <div class="d-section">
        <div class="d-section-title">${icon('link')}参数与来源</div>
        <div class="d-card d-card-pad">
          <div class="snap-row"><span class="sk">来源任务</span><span class="sv">${j ? esc(j.name) + ' · ' + esc(paramsBrief(j)) : '——'}</span></div>
          <div class="snap-row"><span class="sk">参考素材</span><span class="sv">${j && j.refs ? `本次引用了 ${j.refs} 张参考图（含权重）` : '纯文生（无参考）'}</span></div>
          <div class="snap-row"><span class="sk">点数消耗</span><span class="sv">${j ? j.cost + ' 点（任务级）' : '——'} · 失败自动退回</span></div>
          <div class="snap-row"><span class="sk">标签</span><span class="sv">${r.tags.map((t) => `<span class="cap-chip">${esc(t)}</span>`).join(' ')}</span></div>
        </div>
      </div>

      <div class="d-section">
        <div class="ai-note">
          <div class="ai-note-head">${icon('sparkles')}AI 质检小结</div>
          <ul>
            <li>${r.type === 'image' ? '构图与主体清晰，主体约占画面 38%，已留出标题安全区。'
      : r.type === 'video' ? `${esc(r.cam || '固定')}运镜连续性良好，未检出帧间跳变。`
        : '响度峰值 -3dB，未检出爆音与音量跳变。'}</li>
            <li>${r.type === 'audio' ? '人声与底噪分离度较高，可直接叠加口播使用。'
      : '色调、构图与主体表现稳定，可继续沿用当前提示词与参数。'}</li>
            <li>用途：${r.ws === 'w2' ? '商用短视频素材，建议保留拍摄授权记录。' : '商用素材，可直接用于投放。'}</li>
          </ul>
          <div class="flex wrap" style="margin-top:9px">
            <span class="chip brand">${icon('link')}来源任务</span>
          </div>
        </div>
      </div>
    </div>
    <div class="drawer-foot">
      <button class="btn ${r.status === 'adopted' ? 'ghost' : 'primary'}" data-action="adopt-result" data-id="${r.id}">
        ${icon('check')}${r.status === 'adopted' ? '已采用' : '采用这项'}</button>
      <button class="btn ghost" data-action="fav-result" data-id="${r.id}">${icon('star')}${r.status === 'fav' ? '已收藏' : '收藏'}</button>
      <button class="btn ghost" data-action="open-in-editor" data-id="${r.id}">${icon('crop')}在编辑器中打开</button>
      <button class="btn ghost" data-action="download-result" data-id="${r.id}">${icon('download')}下载原件</button>
      <button class="btn ghost" data-action="add-to-canvas" data-id="${r.id}">${icon('layers')}加入画布</button>
      <span class="grow"></span>
      <button class="btn danger-ghost" data-action="delete-result" data-id="${r.id}">${icon('trash')}删除</button>
    </div>`;
}

function helpDrawer() {
  return `
    <div class="drawer-head">
      <span class="task-ic violet">${icon('compass')}</span>
      <div class="grow">
        <div class="drawer-title">使用地图</div>
        <div class="drawer-sub">四步走完一次生成，以及常见异常的处理入口</div>
      </div>
      <button class="icon-btn drawer-close" data-action="close-drawer">${icon('x')}</button>
    </div>
    <div class="drawer-body">
      <div class="d-section">
        <div class="d-section-title">${icon('target')}推荐动线</div>
        <div class="d-card d-card-pad">
          <div class="pb-steps">
            <span class="pb-step"><b>1</b> 选任务或类型</span>${icon('chev-right', 'pb-arrow')}
            <span class="pb-step"><b>2</b> 写提示词 / 帮我写详细</span>${icon('chev-right', 'pb-arrow')}
            <span class="pb-step"><b>3</b> 确认点数与参数</span>${icon('chev-right', 'pb-arrow')}
            <span class="pb-step"><b>4</b> 生成 → 查看本批 → 下载</span>
          </div>
        </div>
      </div>
      <div class="d-section">
        <div class="d-section-title">${icon('zap')}快捷入口</div>
        <div class="help-list">
          ${HELP_TOPICS.map((h) => `<button data-action="help-jump" data-jump="${h.act}">
            <b>${esc(h.t)}</b><span>${esc(h.d)}</span></button>`).join('')}
        </div>
      </div>
      <div class="d-section">
        <div class="d-section-title">${icon('alert')}约定与边界</div>
        <div class="ai-note">
          <div class="ai-note-head">${icon('shield')}原型说明</div>
          <ul>
            <li>生成、进度、播放与计费均为本地模拟，不调用真实模型。</li>
            <li>产出图片由 GPT Image 2.5 生成，仅用于演示画廊与交付流程。</li>
            <li>失败触发规则：所选分辨率超过模型上限，或视频时长超出模型上限。</li>
            <li>点数余额与价格表由真实系统按账户返回；本原型为演示数据。</li>
          </ul>
        </div>
      </div>
    </div>
    <div class="drawer-foot">
      <button class="btn ghost" data-action="go-studio">${icon('wand')}开始一次生成</button>
      <span class="grow"></span>
      <button class="btn primary" data-action="close-drawer">知道了</button>
    </div>`;
}

function toast(type, title, desc = '') {
  const layer = $('#toastLayer');
  const map = { ai: 'sparkles', success: 'check', info: 'bell', warn: 'alert' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${icon(map[type] || 'bell')}<div><div class="t-title">${esc(title)}</div>${desc ? `<div class="t-desc">${esc(desc)}</div>` : ''}</div>`;
  layer.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 220); }, 4200);
}

/* ============================ 10. 动作 ============================ */
function goStudio(type) {
  State.page = 'studio'; State.domain = null; State.studioTab = 'gen';
  if (type) State.type = type;
  renderAll();
}

function startJob(job) {
  State.jobs.unshift(job);
  renderAll();
  toast('info', '已加入生成队列', `${job.name} · 队列当前 ${queueJobs().length} 个任务，可在顶栏「队列」查看`);
}

function createJobFromComposer() {
  const t = State.type; const p = State.params[t]; const T = TYPES[t];
  anchorInto(p, t);
  const cost = estCost();
  const ws = wsOf(State.ws);
  const id = `j${++State.seq}`;
  const name = (State.prompt[t].slice(0, 14) || T.name + '生成')
    + ` · ${t === 'image' ? p.count + ' 张' : p.dur + 's'}`;
  const job = {
    id, name, type: t, ws: State.ws, model: p.model, prompt: State.prompt[t],
    refs: State.refs[t].length, cost, status: 'queued', queueNote: '即将开始',
    time: nowTime(), dateKey: 'today', results: [],
  };
  if (t === 'image') Object.assign(job, { ratio: p.ratio, count: p.count, res: p.res });
  if (t === 'video') Object.assign(job, { ratio: p.ratio, dur: p.dur, cam: p.cam });
  if (t === 'audio') Object.assign(job, { use: p.use, dur: p.dur, voice: p.voice, mood: p.mood, lang: p.lang });

  /* 演示规则：参数超限直接失败，用来演示「失败 → 修复 → 重试」闭环 */
  const m = modelOf(p.model);
  const resOver = t === 'image' && resRank(p.res) > resRank(m.maxRes);
  const durOver = t === 'video' && ((p.model === 'm-vid-f1' && p.dur > 5) || p.dur > 8);
  if (resOver || durOver) {
    job.status = 'failed';
    delete job.queueNote;
    job.fail = resOver
      ? { code: 'E-PRM-04', reason: `${resoOf(p.res).n} 超出 ${m.name} 上限 ${resoOf(m.maxRes).n}`, fix: `改用 Aurora-Image X1，或降到 ${resoOf(m.maxRes).n}` }
      : { code: 'E-DUR-02', reason: `时长 ${p.dur}s 超过 ${m.name} 上限`, fix: '按时长上限重试，或拆成两段' };
    State.jobs.unshift(job);
    renderAll();
    toast('warn', '任务未通过参数校验', `${job.fail.code} · ${job.fail.reason}`);
    return;
  }
  chargeJob(job);
  startJob(job);
}

/* 新产出的差异标签：让用户一眼看出两张结果差在哪，而不是只看到"新生成" */
function resultTags(job) {
  if (job.type === 'image') {
    return [`${resoOf(job.res).n}`, job.refs ? '参考图生成' : '纯文生'];
  }
  if (job.type === 'video') {
    return [job.cam || '固定', job.refs ? '首帧参考' : '纯文生'];
  }
  const use = job.use === 'tts' ? '配音' : job.use === 'music' ? '音乐' : '音效';
  if (job.use === 'tts') {
    const v = VOICES.find((x) => x.k === job.voice) || VOICES[0];
    return [use, (v.n.split(' · ')[1] || v.n)];
  }
  if (job.use === 'music') {
    const m = MOODS.find((x) => x.k === job.mood) || MOODS[0];
    return [use, m.n];
  }
  return [use, '短音效'];
}

function finishJob(job) {
  /* 新一批来了，上一批没被拖进画布的收件箱内容自动沉入草稿箱 */
  const settled = settleInbox(job.ws);
  job.status = 'succeeded';
  job.progress = 100;
  delete job.eta;
  job.durText = `${Math.floor(Math.random() * 50) + 25} 秒`;
  const pool = ASSET_POOL[job.type];
  const n = job.type === 'image' ? (job.count || 1) : 1;
  const ids = [];
  for (let i = 0; i < n; i++) {
    const a = pool[State.assetCursor[job.type] % pool.length];
    State.assetCursor[job.type] += 1;
    const rid = `r${++State.seq}`;
    State.results.unshift({
      id: rid, job: job.id, type: job.type, ws: job.ws, title: a.t, asset: a.f,
      ratio: job.ratio || '1:1', model: job.model, seed: 40000 + ((State.seq * 137) % 50000),
      time: nowTime(), status: 'new', dur: job.type === 'image' ? 0 : (job.dur || 5), cam: job.cam,
      isNew: true, home: 'inbox', tags: resultTags(job),
    });
    ids.push(rid);
  }
  job.results = ids;
  renderAll();
  toast('success', '生成完成',
    `${job.name} · 产出 ${ids.length} 项，已送到画布顶部`
    + (settled ? `；上一批 ${settled} 项未取用，已进草稿箱` : ''));
}

/* 派生变体：把该结果设为参考素材并回填提示词 */
function makeVariant(id) {
  const r = resultById(id);
  if (!r) return;
  const j = jobById(r.job);
  State.type = r.type;
  if (j) State.prompt[r.type] = j.prompt;
  const refs = State.refs[r.type].filter((x) => x.f !== r.asset);
  refs.unshift({ f: r.asset, w: r.type === 'image' ? 0.6 : 0.5 });
  State.refs[r.type] = refs.slice(0, 4);
  State.optimize = null;
  goStudio(r.type);
  toast('ai', '已回填为参考素材', `提示词已替换为来源任务的描述，参考素材已换成「${r.title}」`);
}

const ACTIONS = {
  'switch-page': (el) => { State.page = el.dataset.page; State.domain = null; renderAll(); },
  'go-studio': () => goStudio(),
  'open-domain': (el) => { State.domain = el.dataset.domain; State.page = 'domain'; renderAll(); },
  'toggle-ws-menu': () => { State.wsMenu = !State.wsMenu; renderTopbar(); },
  'pick-ws': (el) => { State.ws = el.dataset.id; State.wsMenu = false; renderAll(); },
  'pick-type': (el) => {
    State.type = el.dataset.type; State.page = 'studio'; State.domain = null;
    State.optimize = null; State.studioTab = 'gen'; renderAll();
  },
  'set-studio-tab': (el) => { State.studioTab = el.dataset.tab; renderAll(); },
  'set-param': (el) => {
    const t = State.type; const p = State.params[t]; const k = el.dataset.key;
    let v = el.dataset.val;
    if (['count', 'dur', 'fps', 'volume', 'refWeight'].includes(k)) v = Number(v);
    if (['firstFrame', 'loop'].includes(k)) v = v === '1';
    p[k] = v;
    if (t === 'audio' && k === 'use') {
      if (v === 'tts') { p.model = 'm-aud-tts'; p.dur = 30; }
      if (v === 'music') { p.model = 'm-aud-mus'; p.dur = 60; }
      if (v === 'sfx') { p.model = 'm-aud-sfx'; p.dur = 5; }
    }
    renderMain();
  },
  'gen': () => {
    if (State.genLock) return;
    if (!State.prompt[State.type].trim()) {
      toast('warn', '提示词为空', '至少描述主体与用途，或补充一段基础描述');
      return;
    }
    State.genLock = true;
    createJobFromComposer();
    renderMainKeepFocus();
    setTimeout(() => { State.genLock = false; renderMainKeepFocus(); }, 900);
  },
  'open-topup': () => { State.drawer = { type: 'topup' }; renderDrawer(); },
  'topup': (el) => {
    const amount = Number(el.dataset.p) || 0;
    const double = !State.wallet.firstTopupDone;
    const got = double ? amount * 2 : amount;
    State.wallet.balance = round1(State.wallet.balance + got);
    if (double) State.wallet.firstTopupDone = true;
    renderAll(); renderDrawer();
    toast('success', `已到账 ${got} 点`, double ? `首充翻倍：充 ${amount} 得 ${got}` : `当前余额 ${balance()} 点`);
  },
  'cancel-job': (el) => {
    const j = jobById(el.dataset.id);
    if (!j) return;
    const refunded = refundJob(j);
    j.status = 'canceled';
    delete j.eta;
    renderAll();
    toast('info', '任务已取消', refunded ? `已退回 ${j.cost} 点` : '该任务未扣费，无需退回');
  },
  'retry-job': (el) => {
    const j = jobById(el.dataset.id);
    if (!j) return;
    j.status = 'queued'; j.progress = 0; j.queueNote = '重新排队';
    delete j.fail; delete j.eta;
    chargeJob(j);
    renderAll();
    toast('info', '已重新排队', `${j.name} · 参数不变，重新扣除 ${j.cost} 点`);
  },
  'retry-fix': (el) => {
    const j = jobById(el.dataset.id);
    if (!j || !j.fail) return;
    const log = [];
    if (j.fail.code === 'E-PRM-04') {
      const mx = modelOf(j.model).maxRes;
      log.push(`${resoOf(j.res).n} → ${resoOf(mx).n}`);
      j.res = mx;
      /* 降了分辨率就按新价重算，不能按失败时的高价继续收 */
      j.cost = round1(modelOf(j.model).price * resoOf(j.res).mul * (j.count || 1));
    }
    if (j.fail.code === 'E-DUR-02') {
      const cap = j.model === 'm-vid-f1' ? 5 : 8;
      const before = j.dur;
      j.dur = Math.min(j.dur, cap);
      j.cost = round1(modelOf(j.model).price * j.dur);
      if (before !== j.dur) log.push(`时长 ${before}s → ${j.dur}s`);
    }
    /* 任务名不再残留超限标记 */
    j.name = j.name.replace(/（\s*4096\s*）/g, '').replace(/4K/gi, '').trim();
    j.fixLog = log;
    j.status = 'queued'; j.progress = 0; j.queueNote = '按建议修复后重新排队'; j.fixed = true;
    delete j.fail;
    chargeJob(j);
    renderAll();
    toast('success', '已按建议修复并排队', log.length ? `已调整：${log.join(' · ')}` : '参数已按建议调整，可在任务行核对');
  },
  'toggle-play': (el) => togglePlay(el.dataset.id),
  'open-result': (el) => {
    const r = resultById(el.dataset.id);
    if (r && r.isNew) { delete r.isNew; renderMain(); }
    State.drawer = { type: 'result', id: el.dataset.id };
    renderDrawer();
  },
  'open-in-editor': (el) => {
    const r = resultById(el.dataset.id);
    if (!r) return;
    State.type = r.type;
    State.editPick[r.type] = r.id;
    State.editOps[r.type] = { ...EDIT_DEF[r.type] };
    if (r.type !== 'image') {
      State.editOps[r.type].in = 0;
      State.editOps[r.type].out = r.dur || (r.type === 'video' ? 5 : 30);
    }
    State.page = 'studio'; State.domain = null; State.studioTab = 'edit';
    State.drawer = null;
    renderAll(); renderDrawer();
    toast('ai', '已在编辑器中打开', `${r.title} · ${wsOf(r.ws).name}`);
  },
  'open-job': (el) => {
    const j = jobById(el.dataset.id);
    if (!j) return;
    State.expanded[j.id] = true;
    State.page = 'jobs'; State.domain = null;
    renderAll();
  },
  'toggle-job': (el) => { State.expanded[el.dataset.id] = !State.expanded[el.dataset.id]; renderAll(); },
  'set-job-filter': (el) => { State.jobFilter = el.dataset.val; renderAll(); },
  'adopt-result': (el) => {
    const r = resultById(el.dataset.id);
    if (!r) return;
    r.status = r.status === 'adopted' ? 'new' : 'adopted';
    renderAll();
    toast(r.status === 'adopted' ? 'success' : 'info', r.status === 'adopted' ? '已采用' : '已取消采用', r.title);
  },
  'adopt-all': (el) => {
    const j = jobById(el.dataset.id);
    if (!j) return;
    resultsOfJob(j).forEach((r) => { r.status = 'adopted'; });
    renderAll();
    toast('success', '本批结果已全部采用', `${j.name} · ${j.results.length} 项`);
  },
  'fav-result': (el) => {
    const r = resultById(el.dataset.id);
    if (!r) return;
    const key = `r:${r.id}`;
    if (aestheticHas(key)) {
      State.aesthetic = State.aesthetic.filter((a) => a.key !== key);
      r.status = r.status === 'fav' ? 'new' : r.status;
      saveAesthetic();
      renderAll();
      toast('info', '已移出审美库', r.title);
      return;
    }
    const ok = addToAesthetic({
      id: `a${++State.seq}`, key, kind: r.type, src: thumbPath(r), t: r.title,
      note: (r.tags || []).slice(0, 2).join(' · '), tags: r.tags || [],
      from: wsShort(r.ws).name, at: nowTime(),
    });
    if (ok) {
      r.status = 'fav';
      renderAll();
      toast('success', '已收进审美库', `${r.title} · 在「审美库」里长期留着`);
    }
  },
  'aes-remove': (el) => {
    const a = State.aesthetic.find((x) => x.id === el.dataset.id);
    State.aesthetic = State.aesthetic.filter((x) => x.id !== el.dataset.id);
    saveAesthetic();
    renderMain();
    renderSidebar();
    toast('info', '已移出审美库', a ? a.t : '');
  },
  'set-aes-filter': (el) => { State.aestheticFilter = el.dataset.val; renderMain(); },
  'open-aesthetic': () => { State.page = 'aesthetic'; State.domain = null; renderAll(); },
  'aesthetic-add-file': () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.multiple = true;
    inp.addEventListener('change', () => {
      const files = [...(inp.files || [])];
      if (!files.length) return;
      let n = 0;
      files.forEach((f) => {
        const url = URL.createObjectURL(f);
        shrinkToThumb(url, (dataUrl) => {
          URL.revokeObjectURL(url);
          if (!dataUrl) return;
          const ok = addToAesthetic({
            id: `a${++State.seq}`, key: `f:${f.name}:${f.size}`, kind: 'image', src: dataUrl,
            t: f.name.replace(/\.[^.]+$/, '').slice(0, 40) || '外部收藏',
            note: '', tags: ['外部收藏'], from: '本地文件', at: nowTime(),
          });
          if (ok) n += 1;
          if (n) { renderMain(); renderSidebar(); }
        });
      });
      setTimeout(() => {
        if (n) toast('success', `已收藏 ${n} 张`, '缩略图已存进审美库，原图不必留在库里');
      }, 600);
    });
    inp.click();
  },
  'variant-result': (el) => makeVariant(el.dataset.id),
  'download-result': (el) => {
    const r = resultById(el.dataset.id);
    if (!r) return;
    toast('success', '已开始下载', `${r.title} · 原型内为模拟下载，商用授权已包含`);
  },
  'delete-result': (el) => {
    const r = resultById(el.dataset.id);
    if (!r) return;
    State.results = State.results.filter((x) => x.id !== r.id);
    State.jobs.forEach((j) => { j.results = j.results.filter((x) => x !== r.id); });
    State.drawer = null;
    renderAll();
    toast('info', '已删除该产出', '任务历史仍保留记录');
  },
  'set-lib-filter': (el) => { State.libFilter = el.dataset.val; renderAll(); },
  'set-lib-tab': (el) => { State.libTab = el.dataset.val; State.libFilter = 'all'; renderAll(); },
  /* ---------- 素材库：编辑产出 ---------- */
  'lib-edit': (el) => { State.drawer = { type: 'edit', id: el.dataset.id }; renderDrawer(); },
  'edit-meta-save': () => {
    const d = State.drawer;
    const r = d && resultById(d.id);
    if (!r) return;
    const val = (k) => { const n = document.querySelector(`[data-input="${k}"]`); return n ? n.value : ''; };
    const title = val('edit-title').trim();
    if (title) r.title = title;
    r.note = val('edit-note').trim();
    r.tags = val('edit-tags').split(/[\s,，、]+/).filter(Boolean);
    saveMeta();
    State.drawer = null;
    renderAll();
    toast('success', '已保存', '标题、说明、标签都跟着这条产出走了');
  },
  /* ---------- 素材库：打包成帖 ---------- */
  'lib-sel': (el) => {
    const id = el.dataset.id;
    State.libSelect = State.libSelect.includes(id)
      ? State.libSelect.filter((x) => x !== id)
      : [...State.libSelect, id];
    renderMain();
  },
  'lib-sel-clear': () => { State.libSelect = []; renderMain(); },
  'lib-pack': () => {
    const ids = State.libSelect.filter((id) => resultById(id));
    if (ids.length < 2) { toast('info', '至少选 2 项', '打包成帖是把几张图组成一条内容'); return; }
    const first = resultById(ids[0]);
    const id = `P${++State.seq}`;
    State.posts.unshift({
      id, ws: first.ws, title: first.title, body: '', items: ids.slice(),
      platform: 'xhs', time: nowHHMM(),
    });
    State.libSelect = [];
    savePosts();
    State.libTab = 'post';
    State.drawer = { type: 'post', id };
    renderAll();
    toast('success', '已打包成帖子草稿', `${ids.length} 张配图 · 补上标题和正文就能用`);
  },
  /* ---------- 帖子编辑器 ---------- */
  'post-new': () => {
    const id = `P${++State.seq}`;
    State.posts.unshift({
      id, ws: State.ws, title: '', body: '', items: [], platform: 'xhs', time: nowHHMM(),
    });
    savePosts();
    State.libTab = 'post';
    State.drawer = { type: 'post', id };
    renderAll();
  },
  'post-open': (el) => { State.drawer = { type: 'post', id: el.dataset.id }; renderDrawer(); },
  'post-save': () => {
    const d = State.drawer;
    const p = d && postById(d.id);
    if (!p) return;
    const val = (k) => { const n = document.querySelector(`[data-input="${k}"]`); return n ? n.value : ''; };
    p.title = val('post-title').trim() || '未命名帖子';
    p.body = val('post-body');
    p.time = nowHHMM();
    savePosts();
    State.drawer = null;
    renderAll();
    toast('success', '帖子已保存', `${p.items.length} 张配图 · ${(p.body || '').length} 字`);
  },
  'post-del': () => {
    const d = State.drawer;
    if (!d) return;
    State.posts = State.posts.filter((x) => x.id !== d.id);
    savePosts();
    State.drawer = null;
    renderAll();
    toast('info', '帖子已删除', '素材库里的产出不受影响');
  },
  'post-platform': (el) => {
    const d = State.drawer;
    const p = d && postById(d.id);
    if (!p) return;
    p.platform = el.dataset.val;
    savePosts();
    renderDrawer();
  },
  'post-item-add': (el) => {
    const d = State.drawer;
    const p = d && postById(d.id);
    if (!p || p.items.includes(el.dataset.id)) return;
    p.items.push(el.dataset.id);
    savePosts();
    renderDrawer();
  },
  'post-item-del': (el) => {
    const d = State.drawer;
    const p = d && postById(d.id);
    if (!p) return;
    p.items = p.items.filter((x) => x !== el.dataset.id);
    savePosts();
    renderDrawer();
  },
  'post-item-up': (el) => {
    const p = State.drawer && postById(State.drawer.id);
    if (!p) return;
    const i = p.items.indexOf(el.dataset.id);
    if (i <= 0) return;
    p.items.splice(i - 1, 0, p.items.splice(i, 1)[0]);
    savePosts();
    renderDrawer();
  },
  'post-item-down': (el) => {
    const p = State.drawer && postById(State.drawer.id);
    if (!p) return;
    const i = p.items.indexOf(el.dataset.id);
    if (i < 0 || i >= p.items.length - 1) return;
    p.items.splice(i + 1, 0, p.items.splice(i, 1)[0]);
    savePosts();
    renderDrawer();
  },
  'post-copy': () => {
    const p = State.drawer && postById(State.drawer.id);
    if (!p) return;
    copyText(postText(p));
    toast('success', '正文已复制', '标题、正文、配图说明都在里面');
  },
  'post-export': (el) => {
    const p = (el && el.dataset.id ? postById(el.dataset.id) : null)
      || (State.drawer && postById(State.drawer.id));
    if (!p) return;
    downloadText(`${(p.title || 'post').replace(/[\\/:*?"<>|]/g, '_')}.md`, postText(p));
    toast('success', '已导出 Markdown', '图片指向 assets/results，方便一起打包');
  },
  'draft-to-lib': (el) => {
    const r = resultById(el.dataset.id);
    if (!r) return;
    r.home = 'library'; r.isNew = false;
    renderAll();
    toast('success', '已存进素材库', `${r.title} · 从草稿箱移出`);
  },
  'todo-fail': () => { State.queueFilter = 'failed'; State.drawer = { type: 'queue' }; renderDrawer(); },
  'todo-queue': () => { State.queueFilter = 'all'; State.drawer = { type: 'queue' }; renderDrawer(); },
  'open-queue': () => { State.queueFilter = 'all'; State.drawer = { type: 'queue' }; renderDrawer(); },
  'set-queue-filter': (el) => { State.queueFilter = el.dataset.val; renderDrawer(); },
  'set-lib-scope': (el) => { State.libScope = el.dataset.val; renderAll(); },
  'set-edit-scope': (el) => { State.editScope = el.dataset.val; renderMain(); },
  /* ---- 生成页：提示词优化 / 参考素材 / 高级参数 ---- */
  'toggle-adv': () => { State.adv = !State.adv; renderMain(); },
  'ai-optimize': () => {
    const t = State.type;
    const cur = State.prompt[t].trim();
    if (!cur) { toast('info', '先写一句想法', '哪怕只写「秋季新品海报」也行，我来补细节'); return; }
    const cfg = PROMPT_OPTIMIZE[t];
    if (isThinPrompt(t)) {
      /* 太短：扩写成完整提示词 */
      State.optimize = { mode: 'expand', result: `${cur}。${cfg.expand}`, neg: cfg.neg, note: cfg.note };
      toast('ai', '已把这句话补成完整提示词', '看一眼，不满意就点「忽略」');
    } else {
      /* 已经够长：只补细节，不动用户的原话 */
      State.optimize = { mode: 'add', add: cfg.add, neg: cfg.neg, note: cfg.note, result: '' };
      toast('ai', '给了几条可加的细节', '挑不挑都行，不改也能直接生成');
    }
    renderMain();
  },
  'apply-optimize': () => {
    const o = State.optimize;
    if (!o) return;
    const t = State.type;
    if (o.mode === 'expand') {
      State.prompt[t] = o.result;
    } else {
      const base = State.prompt[t].trim().replace(/[。.]+$/, '');
      State.prompt[t] = `${base}。${o.add}`;
    }
    if (o.neg && !State.negative[t].trim()) State.negative[t] = o.neg;
    State.optimize = null;
    renderMain();
    toast('success', '已应用', '提示词已更新，可以直接生成');
  },
  'dismiss-optimize': () => { State.optimize = null; renderMain(); },
  'clear-prompt': () => {
    const t = State.type;
    if (!State.prompt[t].trim()) { toast('info', '本来就是空的', '写一句想做什么就能生成'); return; }
    State.prompt[t] = '';
    State.optimize = null;
    renderMain();
  },
  'copy-prompt': () => {
    const t = State.type;
    if (!State.prompt[t].trim()) { toast('info', '还没有内容', '先写一句再复制'); return; }
    toast('success', '已复制提示词', '原型内为模拟复制');
  },
  'copy-prompt-of': (el) => {
    const r = resultById(el.dataset.id);
    const j = r ? jobById(r.job) : null;
    if (!j) { toast('info', '这条没有原始提示词', '它是在编辑器里改出来的'); return; }
    copyText(j.prompt);
    toast('success', '已复制提示词', '粘贴到任何地方都能用');
  },
  /* 沿用这条的参数再来一次：提示词、模型、比例、分辨率/时长全部回填 */
  'reuse-params': (el) => {
    const r = resultById(el.dataset.id);
    const j = r ? jobById(r.job) : null;
    if (!r || !j) { toast('info', '这条没有可沿用的参数', '它是在编辑器里改出来的'); return; }
    const t = r.type;
    State.type = t;
    State.page = 'studio'; State.domain = null; State.studioTab = 'gen';
    State.prompt[t] = j.prompt;
    State.optimize = null;
    if (t === 'image') {
      Object.assign(State.params.image, {
        model: j.model, ratio: j.ratio || '1:1', count: j.count || 4, res: j.res || '2k',
      });
    } else if (t === 'video') {
      Object.assign(State.params.video, {
        model: j.model, ratio: j.ratio || '9:16', dur: j.dur || 5, cam: j.cam || '固定',
      });
    } else {
      Object.assign(State.params.audio, {
        model: j.model, use: j.use || 'tts', dur: j.dur || 30,
        voice: j.voice || State.params.audio.voice, mood: j.mood || State.params.audio.mood,
      });
    }
    State.cvsPop = null;
    renderAll();
    toast('success', '参数已回填，可以直接生成',
      `${TYPES[t].name} · ${paramsBrief(j)} · 预计 ${estCost()} 点`);
  },
  'cycle-ref': (el) => {
    const t = State.type;
    const i = Number(el.dataset.idx);
    const r = State.refs[t][i];
    if (!r) return;
    const order = [0.3, 0.6, 0.9];
    r.w = order[(order.indexOf(r.w) + 1) % order.length] || 0.6;
    renderMain();
    toast('info', `参考强度 ${r.w}`, '数值越高越贴近参考图，越低越自由');
  },
  'remove-ref': (el) => {
    const t = State.type;
    State.refs[t].splice(Number(el.dataset.idx), 1);
    renderMain();
  },
  'add-ref': () => { State.drawer = { type: 'ref-add' }; renderDrawer(); },
  'set-ref-scope': (el) => { State.refScope = el.dataset.val; renderDrawer(); },
  'add-ref-item': (el) => {
    const t = State.type;
    if (State.refs[t].length >= 4) { toast('warn', '最多 4 项', '先移除一项再加'); return; }
    const f = el.dataset.f;
    if (State.refs[t].some((x) => x.f === f)) { toast('info', '已经在参考里了'); return; }
    State.refs[t].push({ f, w: 0.6, from: 'library' });
    renderAll(); renderDrawer();
    toast('success', '已加入参考', '生成时它会作为参考图影响结果');
  },
  'noop': () => { },

  /* ---- 编辑页 ---- */
  'edit-pick': (el) => {
    const t = State.type;
    State.editPick[t] = el.dataset.id;
    State.editOps[t] = { ...EDIT_DEF[t] };
    normalizeEditOps(t);
    renderMain();
  },
  'edit-op': (el) => {
    const t = State.type;
    const ops = State.editOps[t];
    const key = el.dataset.key;
    const now = ops[key];
    const raw = el.dataset.val;
    if (typeof now === 'boolean') ops[key] = !now;
    else if (typeof now === 'number') ops[key] = Number(raw);
    else ops[key] = (now === raw && key === 'crop') ? '原图' : raw;
    normalizeEditOps(t);
    renderMain();
  },
  'edit-reset': () => {
    const t = State.type;
    State.editOps[t] = { ...EDIT_DEF[t] };
    normalizeEditOps(t);
    renderMain();
    toast('info', '已重置参数', '回到素材原始状态');
  },
  'edit-save': () => {
    const t = State.type;
    const cur = editPicked(t);
    if (!cur) { toast('warn', '先选一条素材', '左边缩略图里点一个'); return; }
    const ops = State.editOps[t];
    const changed = JSON.stringify(ops) !== JSON.stringify(EDIT_DEF[t]);
    if (!changed) { toast('info', '还没有做任何修改', '调整一下参数再保存'); return; }
    const r = {
      ...cur,
      id: `r${++State.seq}`,
      job: null,
      title: `${cur.title}（已编辑）`,
      time: nowTime(),
      dateKey: 'today',
      status: 'new',
      isNew: true,
      tags: editTags(t, ops),
      edit: { css: t === 'image' ? editCss(ops) : '' },
    };
    State.results.unshift(r);
    State.editPick[t] = r.id;
    State.editOps[t] = { ...EDIT_DEF[t] };
    renderAll();
    toast('success', '已保存为新产出', `${r.title} · 原素材没有被改动，可在素材库找到`);
  },

  'toggle-canvas': () => {
    State.canvasOpen = !State.canvasOpen;
    if (!State.canvasOpen) { State.canvasSel = []; State.cvsPop = null; }
    renderMain();
    if (State.canvasOpen) syncCvsView();
  },
  'cvs-keep': (el) => { cvsKeep(el.dataset.id); },
  'cvs-arrange': () => { cvsArrange(); },
  'cvs-pen': () => {
    State.cvsPen.on = !State.cvsPen.on;
    if (State.cvsPen.on) { State.cvsMenu = null; State.cvsPop = null; }
    renderMain();
    toast('info', State.cvsPen.on ? '画笔已开启' : '画笔已关闭',
      State.cvsPen.on ? '在画布上拖动即可标注，再点一次关闭' : '');
  },
  'cvs-pen-color': (el) => { State.cvsPen.color = el.dataset.val; renderMain(); },
  'cvs-pen-width': (el) => { State.cvsPen.lw = Number(el.dataset.val); renderMain(); },
  'cvs-open-link': (el) => { window.open(el.dataset.url, '_blank', 'noopener'); },
  'undo': () => {
    const ws = State.ws;
    const h = State.history[ws] || [];
    if (!h.length) { toast('info', '没有可撤销的操作'); return; }
    const cur = snapKey();
    const prev = h.pop();
    (State.future[ws] = State.future[ws] || []).push(cur);
    applySnap(prev);
    lastSnap[ws] = prev;
    toast('info', '已撤销', `还能撤 ${h.length} 步`);
  },
  'redo': () => {
    const ws = State.ws;
    const f = State.future[ws] || [];
    if (!f.length) { toast('info', '没有可重做的操作'); return; }
    const cur = snapKey();
    const next = f.pop();
    (State.history[ws] = State.history[ws] || []).push(cur);
    applySnap(next);
    lastSnap[ws] = next;
    toast('info', '已重做');
  },
  'cvs-new-text': () => {
    State.cvsMenu = null;
    const vp = document.getElementById('cvsViewport');
    const v = cvsView();
    const w = CVS_W_TEXT;
    const h = TEXT_H.md;
    const cx = vp ? (vp.clientWidth / 2 - v.x) / v.k - w / 2 : 40;
    const cy = vp ? (vp.clientHeight / 2 - v.y) / v.k - h / 2 : 40;
    const id = `c${++State.seq}`;
    canvasItems().push({
      id, kind: 'text', text: '', size: 'md',
      x: Math.round(cx), y: Math.round(cy), w, h,
    });
    State.canvasSel = [id];
    State.editTextId = id;
    paintCanvas();
    /* 建完直接进编辑，省一次双击 */
    setTimeout(() => {
      const box = document.querySelector(`.cvs-el[data-id="${id}"]`);
      const body = box && box.querySelector('.cvs-text-body');
      if (!body) return;
      body.setAttribute('contenteditable', 'true');
      box.classList.add('editing');
      body.focus();
    }, 30);
  },
  'cvs-text-size': (el) => {
    State.cvsMenu = null;
    const size = el.dataset.val;
    const sel = canvasSelItems().filter((i) => i.kind === 'text');
    if (!sel.length) return;
    sel.forEach((i) => { i.size = size; i.h = TEXT_H[size] || TEXT_H.md; });
    paintCanvas();
    toast('success', `字号：${TEXT_SIZE_NAME[size]}`, `${sel.length} 个文字`);
  },
  'cvs-new-node': () => {
    State.cvsMenu = null;
    const vp = document.getElementById('cvsViewport');
    const v = cvsView();
    const cx = vp ? (vp.clientWidth / 2 - v.x) / v.k - CVS_W / 2 : 40;
    const cy = vp ? (vp.clientHeight / 2 - v.y) / v.k - CVS_H_NODE / 2 : 40;
    const id = `c${++State.seq}`;
    canvasItems().push({ id, kind: 'node', text: '', x: Math.round(cx), y: Math.round(cy), w: 180, h: CVS_H_NODE });
    State.canvasSel = [id];
    State.linkFrom = id;
    paintCanvas();
    toast('info', '节点已建好，接着连一个目标', '点另一个元素把它连起来；按 Esc 只留节点');
  },
  'cvs-group-selection': () => {
    State.cvsMenu = null;
    const sel = canvasSelItems().filter((i) => i.kind !== 'group');
    if (sel.length < 2) { toast('info', '至少选两个元素', '分组是把一批相关的东西圈在一起'); return; }
    const pad = 26;
    const head = 30;
    const x1 = Math.min(...sel.map((i) => i.x)) - pad;
    const y1 = Math.min(...sel.map((i) => i.y)) - pad - head;
    const x2 = Math.max(...sel.map((i) => i.x + cvsItemW(i))) + pad;
    const y2 = Math.max(...sel.map((i) => i.y + cvsItemH(i))) + pad;
    const id = `c${++State.seq}`;
    canvasItems().unshift({
      id, kind: 'group', t: `${wsShort(State.ws).name} · 一组`,
      x: Math.round(x1), y: Math.round(y1), w: Math.round(x2 - x1), h: Math.round(y2 - y1 + head),
    });
    State.canvasSel = [];
    paintCanvas();
    toast('success', `已归为一组（${sel.length} 个）`, '拖分组标题栏可以整组移动，标题可以直接改');
  },
  'cvs-group-all': () => {
    State.cvsMenu = null;
    State.canvasSel = canvasItems().filter((i) => i.kind !== 'group').map((i) => i.id);
    renderMain();
    setTimeout(() => ACTIONS['cvs-group-selection'](), 60);
  },
  'cvs-mindmap': () => {
    State.cvsMenu = null;
    const it = canvasSelItems().find((i) => i.kind === 'media');
    if (!it) { toast('info', '先选中一个素材', '导图以它为中心展开'); return; }
    /* 再点一次 = 重新布局：先撤掉上一次由导图生成的节点，
       你自己手动加的不动，也不重复建。 */
    const old = canvasItems().filter((x) => x.kind === 'node' && x.mm === it.id);
    if (old.length) {
      const oldIds = new Set(old.map((x) => x.id));
      State.canvas[State.ws] = canvasItems().filter((x) => !oldIds.has(x.id));
      State.cvsLinks[State.ws] = canvasLinks()
        .filter((l) => !oldIds.has(l.from) && !oldIds.has(l.to));
    }
    const cx = it.x + cvsItemW(it) / 2;
    const cy = it.y + cvsItemH(it) / 2;
    const axes = DIVERGE_AXES;          /* 六个轴全用上，不再切掉换主体 / 换画幅 */
    const gap = 118;
    const startY = cy - ((axes.length - 1) * gap) / 2 - 27;
    const ids = [];
    axes.forEach((a, i) => {
      const nid = `c${++State.seq}`;
      canvasItems().push({
        id: nid, kind: 'node', text: a.n, w: 150, h: 54,
        mm: it.id, mmAxis: a.k,
        x: Math.round(cx + 240), y: Math.round(startY + i * gap),
      });
      ids.push(nid);
      canvasLinks().push({ id: `L${++State.seq}`, from: it.id, to: nid });
    });
    State.canvasSel = [it.id, ...ids];
    paintCanvas();
    toast('success', old.length ? '导图已重新展开' : '已展开为导图',
      `${axes.length} 个方向分支 · 节点文字可以直接改，再点一次会重新布局`);
  },
  'cvs-link-pair': () => {
    const sel = State.canvasSel;
    if (sel.length !== 2) { toast('info', '要选两个元素', '先框选或按住 Shift 点选两个'); return; }
    State.cvsMenu = null;
    if (linkHas(sel[0], sel[1]) || linkHas(sel[1], sel[0])) { toast('info', '这两个已经连过了'); return; }
    canvasLinks().push({ id: `L${++State.seq}`, from: sel[0], to: sel[1] });
    paintCanvas();
    toast('success', '已连线', '线表示关系，Agent 会读它来判断你的意图');
  },
  'cvs-link-start': (el) => {
    State.cvsMenu = null;
    State.linkFrom = el.dataset.id;
    paintCanvas();
    toast('info', '选一个目标元素', '点谁就连到谁；按 Esc 取消');
  },
  'cvs-link-label': () => {
    const id = State.linkSel;
    State.cvsMenu = null;
    if (!id) return;
    State.linkLabelEdit = id;
    paintCanvas();
    setTimeout(() => {
      const inp = document.querySelector('[data-input="link-label"]');
      if (inp) { inp.focus(); inp.select(); }
    }, 30);
  },
  'cvs-link-label-save': () => {
    const id = State.linkLabelEdit;
    const inp = document.querySelector('[data-input="link-label"]');
    const l = canvasLinks().find((x) => x.id === id);
    if (l) l.label = inp ? inp.value.trim().slice(0, 12) : '';
    State.linkLabelEdit = null;
    paintCanvas();
    if (l && l.label) toast('success', `线已命名：${l.label}`, 'Agent 读画板时会带上这个关系');
  },
  'cvs-link-label-clear': () => {
    const id = State.linkSel;
    State.cvsMenu = null;
    const l = canvasLinks().find((x) => x.id === id);
    if (l) l.label = '';
    paintCanvas();
  },
  'cvs-link-cancel': () => { State.linkFrom = null; paintCanvas(); },
  'cvs-link-remove': () => {
    State.cvsMenu = null;
    const id = State.linkSel;
    if (!id) return;
    State.cvsLinks[State.ws] = canvasLinks().filter((l) => l.id !== id);
    State.linkSel = null;
    paintCanvas();
    toast('info', '已删除连线');
  },
  'cvs-cover': (el) => {
    const it = canvasItems().find((x) => x.id === el.dataset.id);
    if (!it) return;
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.addEventListener('change', () => {
      const f = (inp.files || [])[0];
      if (!f) return;
      const url = URL.createObjectURL(f);
      /* 前端拿不到对方页面的 og:image（跨域），所以封面由用户自己补——
         运营的常见做法本来就是「截图 + 链接」，这里让两者落到同一张卡上 */
      shrinkToThumb(url, (dataUrl) => {
        URL.revokeObjectURL(url);
        if (!dataUrl) { toast('warn', '这张图用不了'); return; }
        it.cover = dataUrl;
        paintCanvas();
        toast('success', '封面已补上', '链接卡片现在有预览图了');
      });
    });
    inp.click();
  },
  'cvs-keep-aes': (el) => {
    State.cvsMenu = null;
    const it = canvasItems().find((x) => x.id === el.dataset.id);
    if (!it) return;
    if (it.kind === 'web' || it.kind === 'post') {
      const pf = postPlatformOf(it.url);
      const ok = addToAesthetic({
        id: `a${++State.seq}`, key: `w:${it.url}`, kind: 'web', src: it.url, url: it.url,
        t: it.t || cvsHost(it.url),
        note: pf ? `${pf.n}${pf.label}${it.like ? ` · ${it.like} 赞` : ''}` : '',
        tags: pf ? [pf.n, '爆款参考'] : ['网页参考'],
        from: wsShort(State.ws).name, at: nowTime(),
      });
      renderSidebar();
      toast(ok ? 'success' : 'info', ok ? '已收进审美库' : '已经在审美库里了', it.t || cvsHost(it.url));
      return;
    }
    if (it.kind === 'file') { toast('info', '文档暂不支持收藏', '审美库目前收图片、视频和网页'); return; }
    const src = cvsSrc(it);
    const base = {
      key: it.rid ? `r:${it.rid}` : `c:${it.id}`, kind: it.type, t: it.t,
      note: '', tags: [it.local ? '外部收藏' : '生成产出'],
      from: it.local ? '画板' : wsShort(State.ws).name, at: nowTime(),
    };
    if (it.rid) {
      const r = resultById(it.rid);
      if (r) { base.tags = r.tags || base.tags; base.note = (r.tags || []).slice(0, 2).join(' · '); }
    }
    /* 本地图片压成缩略图存下来，生成产出直接引用素材路径 */
    if (it.local) {
      shrinkToThumb(src, (dataUrl) => {
        if (!dataUrl) { toast('warn', '这张图存不下来', '可能是格式不支持'); return; }
        const ok = addToAesthetic({ ...base, id: `a${++State.seq}`, src: dataUrl });
        renderSidebar();
        toast(ok ? 'success' : 'info', ok ? '已收进审美库' : '已经在审美库里了', it.t);
      });
      return;
    }
    const ok = addToAesthetic({ ...base, id: `a${++State.seq}`, src });
    renderSidebar();
    toast(ok ? 'success' : 'info', ok ? '已收进审美库' : '已经在审美库里了', it.t);
  },
  'anchor-toggle': (el) => {
    State.cvsMenu = null;
    const id = el.dataset.id;
    if (State.styleAnchor && State.styleAnchor.cvsId === id) {
      State.styleAnchor = null;
      renderMain();
      toast('info', '已取消风格基准', '后续生成不再自动带上它');
      return;
    }
    const it = canvasItems().find((x) => x.id === id);
    if (!it || it.kind !== 'media') { toast('info', '只有素材能当风格基准'); return; }
    const p = State.params[it.type] || {};
    State.styleAnchor = {
      cvsId: id,
      params: it.type === 'image'
        ? { type: 'image', ratio: p.ratio || '1:1', res: p.res || '2k' }
        : it.type === 'video'
          ? { type: 'video', ratio: p.ratio || '9:16', dur: p.dur || 5, cam: p.cam || '固定' }
          : { type: 'audio', use: p.use || 'tts', dur: p.dur || 30 },
    };
    State.cvsMenu = null;
    renderMain();
    toast('success', '已设为风格基准', `${it.t} · 后续生成会自动带上它，保证系列一致`);
  },
  'anchor-apply': () => {
    const a = State.styleAnchor;
    if (!a) return;
    State.type = a.params.type;
    State.studioTab = 'gen';
    Object.assign(State.params[a.params.type], a.params);
    renderAll();
    toast('success', '已应用基准参数', anchorParamText(a));
  },
  'platforms-open': () => {
    const it = canvasSelItems()[0];
    if (!it) { toast('info', '先选中一个素材'); return; }
    if (it.kind !== 'media' || it.type !== 'image') {
      toast('info', '平台适配目前只支持图片', '视频和音频各平台的规格差异更大，后面单独做');
      return;
    }
    State.platforms = { srcId: it.id, picks: ['xhs', 'douyin', 'wechat'] };
    State.cvsMenu = null;
    renderMain();
  },
  'platforms-close': () => { State.platforms = null; renderMain(); },
  'platforms-toggle': (el) => {
    const d = State.platforms;
    if (!d) return;
    const k = el.dataset.val;
    d.picks = d.picks.includes(k) ? d.picks.filter((x) => x !== k) : [...d.picks, k];
    renderMain();
  },
  'platforms-run': () => {
    const d = State.platforms;
    const it = d ? canvasItems().find((i) => i.id === d.srcId) : null;
    if (!d || !it || !d.picks.length) return;
    const base = divergeBase(it);
    if (!base.trim()) { toast('warn', '这个元素没有可用的描述'); return; }
    const unit = divergeUnitCost(it.type);
    const total = round1(unit * d.picks.length);
    if (total > round1(balance() + dailyFreeLeft())) {
      toast('warn', '点数不够适配这么多平台', `需要 ${total} 点，当前余额 ${balance()} 点`);
      return;
    }
    const list = PLATFORMS.filter((pf) => d.picks.includes(pf.k));
    list.forEach((pf, i) => {
      const job = {
        fromCvsId: it.id,
        id: `j${++State.seq}`, name: `适配 · ${pf.n} ${pf.ratio}`, type: 'image', ws: State.ws,
        model: State.params.image.model, prompt: base, refs: it.f ? 1 : 0, cost: unit,
        ratio: pf.ratio, count: 1, res: State.params.image.res,
        status: 'queued', queueNote: i === 0 ? '即将开始' : `前面 ${i} 个任务`,
        time: nowTime(), dateKey: 'today', results: [], platform: pf.n,
      };
      chargeJob(job);
      State.jobs.unshift(job);
    });
    State.platforms = null;
    State.canvasSel = [];
    renderAll();
    toast('success', `已按 ${list.length} 个平台比例排队`, `${total} 点 · 每个比例重新构图，产出会落进「最新生成」`);
  },
  'diverge-open': () => {
    const sel = canvasSelItems();
    const it = sel[0];
    if (!it) { toast('info', '先选中一个元素', '单击画板上的图片或视频'); return; }
    if (it.kind === 'web' || it.kind === 'file' || it.kind === 'draw') {
      toast('info', '这个不能发散', '发散的对象是图片或视频素材');
      return;
    }
    /* 默认勾三个最常用的轴，用户可以直接开跑 */
    State.diverge = { srcId: it.id, axes: ['style', 'light', 'scene'] };
    State.cvsMenu = null;
    renderMain();
  },
  'diverge-close': () => { State.diverge = null; renderMain(); },
  'diverge-toggle': (el) => {
    const d = State.diverge;
    if (!d) return;
    const k = el.dataset.val;
    d.axes = d.axes.includes(k) ? d.axes.filter((x) => x !== k) : [...d.axes, k];
    renderMain();
  },
  'diverge-run': () => {
    const d = State.diverge;
    const it = d ? divergeSource() : null;
    if (!d || !it || !d.axes.length) return;
    const base = divergeBase(it);
    if (!base.trim()) { toast('warn', '这个元素没有可用的描述', '换一个来自生成的素材试试'); return; }
    const type = it.type;
    const unit = divergeUnitCost(type);
    const axes = DIVERGE_AXES.filter((a) => d.axes.includes(a.k));
    const totalCost = round1(unit * axes.length);
    if (totalCost > round1(balance() + dailyFreeLeft())) {
      toast('warn', '点数不够发散这么多方向', `需要 ${totalCost} 点，当前余额 ${balance()} 点`);
      return;
    }
    /* 参考图带上来源，让发散结果和原图保持血脉关系 */
    const refFile = it.f || null;
    axes.forEach((a, i) => {
      const job = {
        fromCvsId: it.id,
        id: `j${++State.seq}`,
        name: `发散 · ${a.n}`,
        type,
        ws: State.ws,
        model: State.params[type].model,
        prompt: `${base.replace(/[。.]+$/, '')}。${a.add}`,
        refs: refFile ? 1 : 0,
        cost: unit,
        status: 'queued',
        queueNote: i === 0 ? '即将开始' : `前面 ${i} 个任务`,
        time: nowTime(),
        dateKey: 'today',
        results: [],
        divergeAxis: a.n,
      };
      if (type === 'image') Object.assign(job, { ratio: State.params.image.ratio, count: 1, res: State.params.image.res });
      else if (type === 'video') Object.assign(job, { ratio: State.params.video.ratio, dur: State.params.video.dur, cam: State.params.video.cam });
      else Object.assign(job, { use: State.params.audio.use, dur: State.params.audio.dur });
      chargeJob(job);
      State.jobs.unshift(job);
    });
    State.diverge = null;
    State.canvasSel = [];
    renderAll();
    toast('success', `已沿 ${axes.length} 个方向发散`, `${totalCost} 点 · 产出会落到画板顶部的「最新生成」`);
  },
  'toggle-form': () => {
    State.formOpen = !State.formOpen;
    saveUI();
    renderMain();
    if (State.canvasOpen) syncCvsView();
    toast('info', State.formOpen ? '已展开生成表单' : '已收起，现在是纯画布', State.formOpen ? '' : '按 [ 或点左侧竖条可以展开');
  },
  'agent-dock': () => {
    State.agentDock = !State.agentDock;
    if (State.agentDock) State.agentPos = null;
    saveUI();
    renderMain();
  },
  'agent-open': () => {
    State.agent = { open: true, result: agentReadBoard() };
    renderMain();
  },
  'agent-scope-all': () => {
    State.canvasSel = [];
    State.agent = { open: true, result: agentReadBoard() };
    renderMain();
    paintCanvas();
  },
  'agent-close': () => { State.agent = { open: false, result: null }; renderMain(); },
  'agent-apply': () => {
    const a = State.agent;
    if (!a || !a.result || !a.result.draft) return;
    const t = a.result.mainType;
    State.type = t;
    State.studioTab = 'gen';
    State.prompt[t] = a.result.draft;
    State.optimize = null;
    Object.assign(State.params[t], a.result.params);
    State.agent = { open: false, result: null };
    renderAll();
    toast('success', '已按 Agent 的建议填好', `${TYPES[t].name} · ${agentParamText(t, a.result.params)}`);
  },
  'agent-copy': () => {
    const a = State.agent;
    if (!a || !a.result) return;
    copyText(a.result.draft);
    toast('success', '已复制提示词');
  },
  'cvs-save-board': () => {
    const ws = wsOf(State.ws);
    const items = canvasItems();
    if (!items.length) { toast('info', '画板是空的', '先往里面放点东西'); return; }
    const board = {
      kind: 'aigc-studio-board',
      version: 1,
      savedAt: new Date().toISOString(),
      project: { id: State.ws, name: ws.name },
      view: cvsView(),
      links: canvasLinks(),
      items: items.map((i) => ({
        id: i.id, kind: i.kind, type: i.type, t: i.t, x: i.x, y: i.y, w: i.w,
        ar: i.ar, rid: i.rid, f: i.f, url: i.url, ftype: i.ftype, size: i.size,
        color: i.color, lw: i.lw, pts: i.pts, rot: i.rot, flipH: i.flipH, flipV: i.flipV, z: i.z, op: i.op,
        local: i.local ? true : undefined,
      })),
    };
    const blob = new Blob([JSON.stringify(board, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `画板-${ws.name}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('success', '画板已保存', `${items.length} 个元素 · 本地文件（图片/视频/音频）需要重新拖入`);
  },
  'cvs-load-board': () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.addEventListener('change', () => {
      const f = (inp.files || [])[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const board = JSON.parse(reader.result);
          if (!board || board.kind !== 'aigc-studio-board' || !Array.isArray(board.items)) {
            toast('warn', '这不是画板文件', '请选择用「保存画板」导出的 JSON');
            return;
          }
          const dropped = board.items.filter((i) => i.local).length;
          State.canvas[State.ws] = board.items.filter((i) => !i.local).map((i) => ({ ...i, local: undefined }));
          if (board.view) State.cvsView[State.ws] = board.view;
          /* 旧文件没有 links 字段，照样能读 */
          const ids = new Set(State.canvas[State.ws].map((i) => i.id));
          State.cvsLinks[State.ws] = (board.links || []).filter((l) => ids.has(l.from) && ids.has(l.to));
          State.canvasSel = [];
          State.cvsPop = null;
          renderMain();
          if (State.canvasOpen) syncCvsView();
          toast('success', `已导入画板：${State.canvas[State.ws].length} 个元素`,
            dropped ? `有 ${dropped} 个本地文件无法恢复，需要重新拖进来` : '');
        } catch (err) {
          toast('warn', '画板文件读不出来', '文件可能损坏');
        }
      };
      reader.readAsText(f);
    });
    inp.click();
  },
  'cvs-fit': () => { cvsFitAll(); },
  'cvs-select-all': () => {
    State.canvasSel = canvasItems().map((i) => i.id);
    paintCanvas();
    if (State.canvasSel.length) toast('info', `已选中全部 ${State.canvasSel.length} 个元素`);
  },
  'cvs-align': (el) => { State.cvsMenu = null; cvsAlign(el.dataset.val); },
  'cvs-distribute': (el) => { State.cvsMenu = null; cvsDistribute(el.dataset.val); },
  'cvs-reorder': (el) => { State.cvsMenu = null; cvsReorder(el.dataset.val); },
  'cvs-flip': (el) => {
    State.cvsMenu = null;
    const axis = el.dataset.val;
    cvsTransformApply((i) => {
      if (axis === 'h') i.flipH = !i.flipH; else i.flipV = !i.flipV;
    }, axis === 'h' ? '已水平翻转' : '已垂直翻转');
  },
  'cvs-rotate': (el) => {
    State.cvsMenu = null;
    const d = Number(el.dataset.val);
    cvsTransformApply((i) => { i.rot = ((i.rot || 0) + d + 360) % 360; }, d > 0 ? '已顺时针转 90°' : '已逆时针转 90°');
  },
  'cvs-opacity': (el) => {
    State.cvsMenu = null;
    const op = Number(el.dataset.val);
    cvsTransformApply((i) => { i.op = op; }, op < 1 ? '已设为半透明' : '已恢复不透明');
  },
  'cvs-reset-el': () => {
    State.cvsMenu = null;
    cvsTransformApply((i) => {
      i.rot = 0; i.flipH = false; i.flipV = false; i.op = 1;
      /* 节点和分组的宽度不是素材默认宽，跟着重置会变形 */
      if (i.kind !== 'node' && i.kind !== 'group') i.w = CVS_W;
    }, '已恢复原状');
  },
  'cvs-duplicate': () => {
    State.cvsMenu = null;
    const sel = canvasSelItems();
    if (!sel.length) return;
    const added = [];
    const topIds = [];
    sel.forEach((i) => {
      const id = `c${++State.seq}`;
      topIds.push(id);
      added.push({ ...i, id, x: i.x + 26, y: i.y + 26 });
    });
    /* 复制分组时把成员一起带上，否则副本是个空框 */
    sel.filter((i) => i.kind === 'group').forEach((g) => {
      canvasItems()
        .filter((x) => x.kind !== 'group' && !sel.includes(x) && inGroup(x, g))
        .forEach((m) => added.push({ ...m, id: `c${++State.seq}`, x: m.x + 26, y: m.y + 26 }));
    });
    canvasItems().push(...added);
    State.canvasSel = topIds;
    paintCanvas();
    const extra = added.length - sel.length;
    toast('success', `已复制 ${sel.length} 个`, extra
      ? `含组内 ${extra} 个成员，副本在原位置右下角`
      : '副本在原位置右下角，可以直接拖走');
  },
  'cvs-delete-sel': () => {
    State.cvsMenu = null;
    const ids = State.canvasSel.slice();
    if (!ids.length) return;
    const hadGroup = ids.some((id) => {
      const i = canvasItems().find((x) => x.id === id);
      return i && i.kind === 'group';
    });
    ids.forEach((id) => canvasRemove(id));
    State.canvasSel = [];
    paintCanvas();
    toast('info', `已移除 ${ids.length} 个元素`,
      hadGroup ? '分组框移除了，组里的元素都还在画板上' : '素材库里的产出不受影响');
  },
  'cvs-menu-params': () => {
    State.cvsMenu = null;
    const it = canvasSelItems()[0];
    if (it && it.rid) ACTIONS['cvs-params']({ dataset: { id: it.rid } });
  },
  'cvs-full': () => { State.cvsFull = true; State.canvasOpen = true; renderMain(); syncCvsView(); },
  'cvs-full-off': () => { State.cvsFull = false; renderMain(); syncCvsView(); },
  'cvs-upload': () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*,video/*,audio/*,.pdf,.doc,.docx,.txt,.md,.csv,.ppt,.pptx,.xls,.xlsx';
    inp.multiple = true;
    inp.addEventListener('change', () => {
      const files = [...(inp.files || [])];
      if (files.length) cvsAddLocalFiles(files, null, null);
    });
    inp.click();
  },
  'cvs-params': (el) => {
    const vp = document.getElementById('cvsViewport');
    if (!vp) return;
    const rect = el.getBoundingClientRect();
    const vr = vp.getBoundingClientRect();
    /* 浮层贴着按钮右对齐，并且不越出画布 */
    const w = 312;
    let sx = rect.right - vr.left - w;
    sx = clamp(sx, 8, Math.max(8, vr.width - w - 8));
    let sy = rect.bottom - vr.top + 6;
    if (sy > vr.height - 220) sy = Math.max(8, rect.top - vr.top - 230);
    State.cvsPop = { rid: el.dataset.id, sx, sy };
    State.cvsMenu = null;
    paintCanvas();
  },
  'close-cvs-pop': () => { State.cvsPop = null; paintCanvas(); },
  'cvs-drop-inbox': () => {
    const list = inboxResults();
    if (!list.length) { toast('info', '当前项目没有待处理的产出'); return; }
    const n = settleInbox(State.ws);
    renderAll();
    toast('info', '已全部收进草稿箱', `${n} 项 · 想找回就去素材库的「草稿箱」`);
  },
  'cvs-save-lib': () => {
    const sel = canvasSelItems().filter((i) => i.rid && !savedToLib(i.rid));
    if (!sel.length) { toast('info', '没有需要保存的内容', '选中的都已经在素材库里了'); return; }
    let n = 0;
    sel.forEach((i) => {
      const r = resultById(i.rid);
      if (r && r.home !== 'library') { r.home = 'library'; r.isNew = false; n += 1; }
    });
    paintCanvas();
    renderSidebar();
    toast('success', `已保存 ${n} 项到素材库`, '画布上的元素不会消失，只是多了「已存素材库」标记');
  },
  'cvs-reset-view': () => {
    State.cvsView[State.ws] = { x: 40, y: 40, k: 1 };
    syncCvsView();
    toast('info', '画布已回到原点', '缩放回到 100%');
  },
  'open-api': () => { State.page = 'api'; State.domain = null; renderAll(); },
  'api-lang': (el) => { State.apiLang = el.dataset.val; renderMain(); },
  'api-copy': () => toast('info', '已复制 Key', '原型内为模拟复制'),
  'api-copy-code': () => toast('info', '已复制示例代码', `当前语言：${State.apiLang}`),
  'api-create-key': () => {
    const n = State.apiKeys.length + 1;
    const rnd = () => Math.random().toString(16).slice(2, 6);
    State.apiKeys.push({
      id: `k${++State.seq}`, name: `新 Key ${n}`, ch: 'ch-gw',
      key: `sk-live-${rnd()}······${rnd().slice(0, 3)}`, created: '刚刚', lastUsed: '', on: true,
    });
    renderAll();
    toast('success', '已创建新 Key', '完整 Key 只在创建时展示一次，原型内为演示数据');
  },
  'api-toggle': (el) => {
    const k = State.apiKeys.find((x) => x.id === el.dataset.id);
    if (!k) return;
    k.on = !k.on;
    renderAll();
    toast('info', k.on ? '已启用' : '已停用', `${k.name} · ${k.on ? '可以继续调用' : '使用该 Key 的调用会立即失败'}`);
  },
  'api-delete': (el) => {
    const k = State.apiKeys.find((x) => x.id === el.dataset.id);
    State.apiKeys = State.apiKeys.filter((x) => x.id !== el.dataset.id);
    renderAll();
    toast('info', '已删除 Key', k ? `${k.name} · 不可恢复` : '');
  },
  'canvas-remove': (el) => {
    canvasRemove(el.dataset.id);
    paintCanvas();
    toast('info', '已从画布移除', '素材库里的产出不受影响');
  },
  'canvas-clear-sel': () => { State.canvasSel = []; paintCanvas(); },
  'canvas-clear': () => {
    if (!State.canvasConfirm) {
      State.canvasConfirm = true;
      paintCanvas();
      setTimeout(() => { if (State.canvasConfirm) { State.canvasConfirm = false; paintCanvas(); } }, 3500);
      toast('warn', '再点一次确认清空', '只会清空当前项目的画布，素材库与产出不受影响');
      return;
    }
    State.canvasConfirm = false;
    State.canvas[State.ws] = [];
    State.cvsLinks[State.ws] = [];
    State.linkSel = null;
    State.canvasSel = [];
    State.cvsView[State.ws] = { x: 40, y: 40, k: 1 };
    paintCanvas();
    toast('info', '画布已清空', '只清空了当前项目的画布');
  },
  'canvas-use': (el) => {
    const type = el.dataset.type;
    const sel = canvasSelItems();
    if (!sel.length) return;
    const media = sel.filter((i) => i.kind === 'media');
    /* 画板上写的字也是你选中的东西。原先只挑素材，文字被无声丢掉，
       但 Agent 明明读得到——两边对不上，所以现在一并带进提示词。 */
    const texts = sel.filter((i) => (i.kind === 'text' || i.kind === 'node') && (i.text || '').trim());
    const prevRefs = State.refs[type].length;
    if (media.length) {
      State.refs[type] = media.slice(0, 4).map((i) => ({ f: i.f, w: type === 'image' ? 0.6 : 0.5, from: 'canvas' }));
    }
    let textNote = '';
    if (texts.length) {
      const joined = texts.map((i) => i.text.trim()).join('，');
      const cur = (State.prompt[type] || '').trim();
      const isSeed = !cur || cur === (SEED_PROMPTS[type] || '').trim();
      State.prompt[type] = isSeed ? joined : `${cur}，${joined}`;
      textNote = ` · ${texts.length} 处文字已写进提示词`;
    }
    State.type = type; State.page = 'studio'; State.domain = null; State.studioTab = 'gen';
    State.optimize = null;
    renderAll();
    toast('ai', '已把画布内容带过来',
      `${media.length ? `${media.length} 项素材作为参考` : '未选素材'}${textNote}`
      + `${media.length && prevRefs ? `（替换了原有 ${prevRefs} 项）` : ''}`);
  },
  'add-to-canvas': (el) => {
    const r = resultById(el.dataset.id);
    if (!r) return;
    if (canvasHas(r.id)) { toast('info', '已经在画布上了', r.title); return; }
    canvasItems().push({ id: `c${++State.seq}`, kind: 'media', type: r.type, f: r.asset, t: r.title, rid: r.id });
    State.canvasOpen = true;
    renderAll();
    toast('success', '已放进画布', `${r.title} · 展开画布选中它就能作为参考`);
  },
  'go-jobs': () => { State.drawer = null; State.page = 'jobs'; State.domain = null; State.jobFilter = 'all'; renderAll(); renderDrawer(); },
  'open-library-type': () => {
    State.page = 'domain'; State.domain = 'library'; State.libTab = 'lib';
    State.libFilter = State.type; State.libSearch = '';
    renderAll();
  },
  'open-help': () => { State.drawer = { type: 'help' }; renderDrawer(); },
  'close-drawer': () => { State.drawer = null; renderDrawer(); },
  'help-jump': (el) => {
    const j = el.dataset.jump;
    State.drawer = null;
    if (j === 'fail') { State.page = 'jobs'; State.domain = null; State.jobFilter = 'failed'; }
    else if (j === 'quota') { State.drawer = { type: 'topup' }; renderDrawer(); return; }
    else if (j === 'api') { State.page = 'api'; State.domain = null; }
    else if (j === 'jobs') { State.page = 'jobs'; State.domain = null; State.jobFilter = 'all'; }
    else { State.page = 'studio'; State.domain = null; }
    renderAll();
    toast('info', '已跳转到相关入口');
  },
};

/* ============================ 11. 模拟器 ============================ */
function tick() {
  const running = runningJob();
  const queued = State.jobs.filter((j) => j.status === 'queued');
  if (!running && queued.length) {
    const j = queued[0];
    j.status = 'running'; j.progress = 4; j.eta = '生成中…';
    delete j.queueNote;
    renderAll();
    toast('info', '开始生成', `${j.name} · ${modelOf(j.model).name}`);
  } else if (running) {
    const step = running.type === 'image' ? 9 : running.type === 'video' ? 6 : 12;
    running.progress = Math.min(100, running.progress + step);
    patchRunning(running);
    if (running.progress >= 100) finishJob(running);
  }
  if (State.play.id) playbackTick();
}

function patchRunning(j) {
  const row = document.getElementById(`q-${j.id}`);
  if (row) {
    const bar = row.querySelector('.qbar i');
    const pct = row.querySelector('.qr-pct');
    if (bar) bar.style.width = `${j.progress}%`;
    if (pct) pct.textContent = `${j.progress}%`;
  }
  const jc = document.getElementById(`jc-${j.id}`);
  if (jc) jc.style.width = `${j.progress}%`;
}

function togglePlay(id) {
  if (State.play.id === id) { stopPlay(); renderAll(); return; }
  stopPlay();
  const r = resultById(id);
  if (!r) return;
  State.play = { id, t: 0 };
  State.playing[id] = true;
  renderAll();
}

function stopPlay() {
  const id = State.play.id;
  if (id) delete State.playing[id];
  State.play = { id: null, t: 0 };
}

function playbackTick() {
  const id = State.play.id;
  const r = resultById(id);
  if (!r) { stopPlay(); return; }
  State.play.t = round1(State.play.t + 0.15);
  const total = r.dur || 5;
  if (State.play.t >= total) { stopPlay(); renderAll(); return; }
  const pct = clamp((State.play.t / total) * 100, 0, 100);
  $$(`[data-playbar="${id}"]`).forEach((el) => { el.style.width = `${pct}%`; });
  $$(`[data-playtime="${id}"]`).forEach((el) => {
    el.textContent = el.closest('.stage-ctrl, .edit-play-row')
      ? `${mmss(State.play.t)} / ${mmss(total)}` : mmss(State.play.t);
  });
  $$('.wave, .edit-wave').forEach((w) => {
    const items = [...w.querySelectorAll('i')];
    const played = Math.round(items.length * (State.play.t / total));
    items.forEach((it, i) => it.classList.toggle('play', i < played));
  });
}

/* ============================ 12. 事件与初始化 ============================ */
$('#overlay').addEventListener('click', () => { State.drawer = null; renderDrawer(); });

document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-action]');
  if (State.wsMenu && (!target || target.dataset.action !== 'toggle-ws-menu')) {
    State.wsMenu = false; renderTopbar();
  }
  if (!target) return;
  const fn = ACTIONS[target.dataset.action];
  if (fn) { e.preventDefault(); fn(target, e); }
});

/* Ctrl+V 直接贴截图：设计工作流里最高频的一步 */
document.addEventListener('paste', (e) => {
  if (State.page !== 'studio' || State.studioTab !== 'gen' || !State.canvasOpen) return;
  const cd = e.clipboardData;
  if (!cd) return;
  const items = cd.items ? [...cd.items] : [];
  const files = items.filter((it) => it.type && it.type.indexOf('image/') === 0)
    .map((it) => it.getAsFile()).filter(Boolean);
  if (files.length) { e.preventDefault(); cvsAddLocalFiles(files, null, null); return; }
  /* 纯文本链接也能贴 */
  const text = (cd.getData ? cd.getData('text/plain') : '').trim();
  if (/^https?:\/\/\S+$/i.test(text)) {
    e.preventDefault();
    cvsAddLink(text, null, null);
  }
});

/* 空格是 PureRef 的平移键，按住时光标变抓手 */
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !State.cvsSpace) {
    const t = e.target;
    if (!t || !/^(INPUT|TEXTAREA)$/.test(t.tagName)) { State.cvsSpace = true; document.body.classList.add('cvs-space'); e.preventDefault(); }
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && State.cvsSpace) { State.cvsSpace = false; document.body.classList.remove('cvs-space'); }
});
window.addEventListener('blur', () => { State.cvsSpace = false; document.body.classList.remove('cvs-space'); });

/* 画布快捷键：桌面软件的肌肉记忆，做软件就得有 */
document.addEventListener('keydown', (e) => {
  const inField = /^(INPUT|TEXTAREA)$/.test((e.target && e.target.tagName) || '');
  const onCanvas = State.page === 'studio' && State.studioTab === 'gen' && State.canvasOpen;
  if (!onCanvas || inField) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    ACTIONS['cvs-select-all']();
    return;
  }
  if (mod && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    ACTIONS['cvs-duplicate']();
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (State.linkSel) { e.preventDefault(); ACTIONS['cvs-link-remove'](); return; }
    if (!State.canvasSel.length) return;
    e.preventDefault();
    ACTIONS['cvs-delete-sel']();
    return;
  }
  if (e.key === 'f' || e.key === 'F') { e.preventDefault(); cvsFitAll(); return; }
  if (e.key === 'b' || e.key === 'B') { e.preventDefault(); ACTIONS['cvs-pen'](); return; }
  if (e.key === 'v' || e.key === 'V') {
    if (State.cvsPen.on) { State.cvsPen.on = false; renderMain(); }
    return;
  }
  if (e.key === '0') {
    const v = cvsView();
    v.k = 1; syncCvsView();
    return;
  }
  /* 方向键微调位置，按住 Shift 走大步 */
  if (e.key.startsWith('Arrow') && State.canvasSel.length) {
    e.preventDefault();
    const step = e.shiftKey ? 24 : 4;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    canvasSelItems().forEach((i) => { i.x += dx; i.y += dy; });
    const world = document.getElementById('cvsWorld');
    if (world) canvasSelItems().forEach((i) => {
      const n = world.querySelector(`.cvs-el[data-id="${i.id}"]`);
      if (n) { n.style.left = `${i.x}px`; n.style.top = `${i.y}px`; }
    });
    return;
  }
  /* 撤销 / 重做：画布类工具没有这个，用起来会一直提着心 */
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const k = e.key.toLowerCase();
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); ACTIONS['undo'](); return; }
    if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); ACTIONS['redo'](); return; }
    /* 正在打字时别抢 Ctrl+Z，浏览器自己会处理输入框里的撤销 */
    if (typing) return;
  }
  if (e.key === 'Escape' && State.linkLabelEdit) { State.linkLabelEdit = null; paintCanvas(); return; }
  if (e.key === 'Escape' && State.cvsMenu) { State.cvsMenu = null; paintCanvas(); return; }
  /* [ 收起/展开生成表单：想专注画布时不用去够鼠标 */
  if (e.key === '[' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (State.page === 'studio' && State.studioTab === 'gen') { ACTIONS['toggle-form'](); return; }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    /* 编辑中的文字最局部，先退它 */
    if (State.editTextId) {
      const t = document.querySelector(`textarea[data-node-id="${State.editTextId}"], .cvs-text-body[data-text-id="${State.editTextId}"]`);
      if (t) t.blur();
      else { State.editTextId = null; paintCanvas(); }
      return;
    }
    if (State.linkFrom) { State.linkFrom = null; paintCanvas(); return; }
    if (State.platforms) { State.platforms = null; renderMain(); return; }
    if (State.diverge) { State.diverge = null; renderMain(); return; }
    if (State.cvsPen.on) { State.cvsPen.on = false; renderMain(); return; }
    if (State.agent.open) { State.agent = { open: false, result: null }; renderMain(); return; }
    if (State.cvsPop) { State.cvsPop = null; paintCanvas(); return; }
    if (State.cvsFull) { State.cvsFull = false; renderMain(); syncCvsView(); return; }
    if (State.drawer) { State.drawer = null; renderDrawer(); }
    else if (State.wsMenu) { State.wsMenu = false; renderTopbar(); }
  }
});

/* 从电脑拖东西进来、或者直接粘贴——创意桌面要能接住任何素材 */
const CVS_MEDIA_RE = /^(image|video|audio)\//;
function cvsAddLocalFiles(files, clientX, clientY) {
  const vp = document.getElementById('cvsViewport');
  if (!vp || !files.length) return;
  const rect = vp.getBoundingClientRect();
  const v = cvsView();
  const cx = clientX == null ? rect.left + rect.width / 2 : clientX;
  const cy = clientY == null ? rect.top + rect.height / 2 : clientY;
  const counts = {};
  let idx = 0;
  [...files].forEach((f) => {
    const id = `c${++State.seq}`;
    const wx = Math.round((cx - rect.left - v.x) / v.k - CVS_W / 2) + idx * 26;
    const wy = Math.round((cy - rect.top - v.y) / v.k - 60) + idx * 26;
    const base = f.name.replace(/\.[^.]+$/, '').slice(0, 40) || '未命名';
    let item = null;

    if (CVS_MEDIA_RE.test(f.type || '')) {
      const type = f.type.split('/')[0];
      const src = URL.createObjectURL(f);
      item = {
        id, kind: 'media', type, src, local: true, t: base, x: wx, y: wy,
        seed: 4000 + ((State.seq * 137) % 9000),
        ar: type === 'image' ? CVS_AR : type === 'video' ? 0.62 : 0.5,
      };
      /* 拿到真实尺寸后再摆一次，图片和视频都适用 */
      if (type === 'image') {
        const probe = new Image();
        probe.onload = () => { if (probe.naturalWidth) { item.ar = probe.naturalHeight / probe.naturalWidth; paintCanvas(); } };
        probe.src = src;
      } else if (type === 'video') {
        const probe = document.createElement('video');
        probe.preload = 'metadata';
        probe.onloadedmetadata = () => {
          if (probe.videoWidth) { item.ar = probe.videoHeight / probe.videoWidth; item.dur = Math.round(probe.duration) || 0; paintCanvas(); }
        };
        probe.src = src;
      }
      counts[type] = (counts[type] || 0) + 1;
    } else {
      const fk = fileKindOf(f);
      item = { id, kind: 'file', ftype: fk.k, t: f.name.slice(0, 48), size: f.size, x: wx, y: wy };
      counts['文档'] = (counts['文档'] || 0) + 1;
    }
    canvasItems().push(item);
    idx += 1;
  });
  if (!idx) { toast('warn', '没有可以放的东西'); return; }
  State.canvasOpen = true;
  renderMain();
  const brief = Object.keys(counts).map((k) => `${counts[k]} 个${k === '文档' ? '文档' : k === 'image' ? '图片' : k === 'video' ? '视频' : '音频'}`).join(' · ');
  toast('success', `已放进画布：${brief}`, '本地文件不会上传，也不会进素材库');
}

/* 链接拖进来当网页卡片 */
function cvsAddLink(url, clientX, clientY) {
  const vp = document.getElementById('cvsViewport');
  if (!vp) return false;
  const clean = String(url || '').trim();
  if (!/^https?:\/\//i.test(clean)) return false;
  const rect = vp.getBoundingClientRect();
  const v = cvsView();
  const cx = clientX == null ? rect.left + rect.width / 2 : clientX;
  const cy = clientY == null ? rect.top + rect.height / 2 : clientY;
  const x = Math.round((cx - rect.left - v.x) / v.k - CVS_W / 2);

  /* 直链视频文件：用 <video> 内嵌，画布上直接能播——唯一能真预览的链接类型 */
  if (isDirectVideo(clean)) {
    const item = {
      id: `c${++State.seq}`, kind: 'media', type: 'video', src: clean, link: true,
      t: decodeURIComponent((clean.split('/').pop() || '').split('?')[0]).slice(0, 40) || '视频链接',
      x, y: Math.round((cy - rect.top - v.y) / v.k - 60),
    };
    canvasItems().push(item);
    State.canvasOpen = true;
    renderMain();
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => {
      if (probe.videoWidth) { item.ar = probe.videoHeight / probe.videoWidth; item.dur = Math.round(probe.duration) || 0; paintCanvas(); }
    };
    probe.src = clean;
    toast('success', '已放进画布：视频链接', '直链视频可以直接在画布上播放');
    return true;
  }

  /* 视频平台：落成带时长的视频卡片 */
  const vpf = videoPlatformOf(clean);
  if (vpf) {
    const smp = postSampleOf(vpf.k);
    canvasItems().push({
      id: `c${++State.seq}`, kind: 'post', url: clean, platform: vpf.k, isVideo: true,
      t: smp.t, author: smp.a, like: smp.like, save: smp.save, cmt: smp.cmt, dur: smp.dur,
      x, y: Math.round((cy - rect.top - v.y) / v.k - CVS_H_POST / 2),
    });
    State.canvasOpen = true;
    renderMain();
    toast('success', `已放进画布：${vpf.n}视频`, '数据为示例，封面可以自己补');
    return true;
  }

  const pf = postPlatformOf(clean);
  if (pf) {
    /* 认得出平台就落成帖子卡片——运营要的是「这条为什么爆」，不是一条裸链接 */
    const smp = postSampleOf(pf.k);
    canvasItems().push({
      id: `c${++State.seq}`, kind: 'post', url: clean, platform: pf.k,
      t: smp.t, author: smp.a, like: smp.like, save: smp.save, cmt: smp.cmt,
      x, y: Math.round((cy - rect.top - v.y) / v.k - CVS_H_POST / 2),
    });
    State.canvasOpen = true;
    renderMain();
    toast('success', `已放进画布：${pf.n}${pf.label}`, '数据为示例，标题和作者可以直接改');
    return true;
  }
  canvasItems().push({
    id: `c${++State.seq}`, kind: 'web', url: clean, t: cvsHost(clean),
    x, y: Math.round((cy - rect.top - v.y) / v.k - CVS_H_WEB / 2),
  });
  State.canvasOpen = true;
  renderMain();
  toast('success', '已放进画布', `${cvsHost(clean)} · 双击标题可以改成你自己的备注`);
  return true;
}

/* 拖拽放入画布：收件箱里的最新生成，拖到画布上就算留用 */
document.addEventListener('dragstart', (e) => {
  const card = e.target.closest('[data-drag]');
  if (!card) return;
  State.dragId = card.dataset.drag;
  document.body.classList.add('cvs-dragging');
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'copy';
    try { e.dataTransfer.setData('text/plain', card.dataset.drag); } catch (_) { /* 忽略 */ }
  }
});

document.addEventListener('dragend', () => {
  State.dragId = null;
  document.body.classList.remove('cvs-dragging');
  document.querySelectorAll('.cvs-viewport.drop-on').forEach((n) => n.classList.remove('drop-on'));
});

/* ---------- 帖子配图拖动排序 ----------
   和画布那套拖拽（[data-drag] 卡片 → 画板）是两件事，所以单独一组处理函数。
   它们只认抽屉里的 [data-postitem]，不会互相干扰。 */
document.addEventListener('dragstart', (e) => {
  const it = e.target.closest('[data-postitem]');
  if (!it) return;
  State.postDrag = it.dataset.postitem;
  it.classList.add('dragging');
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', it.dataset.postitem); } catch (_) { /* 忽略 */ }
  }
});

document.addEventListener('dragend', () => {
  if (!State.postDrag) return;
  State.postDrag = null;
  document.querySelectorAll('.post-item.dragging, .post-item.over')
    .forEach((n) => n.classList.remove('dragging', 'over'));
});

document.addEventListener('dragover', (e) => {
  const it = e.target.closest('[data-postitem]');
  if (!it || !State.postDrag) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.post-item.over').forEach((n) => n.classList.remove('over'));
  if (it.dataset.postitem !== State.postDrag) it.classList.add('over');
});

document.addEventListener('drop', (e) => {
  const it = e.target.closest('[data-postitem]');
  if (!it || !State.postDrag) return;
  e.preventDefault();
  const from = State.postDrag;
  const to = it.dataset.postitem;
  State.postDrag = null;
  if (from === to) return;
  const p = State.drawer && postById(State.drawer.id);
  if (!p) return;
  const fi = p.items.indexOf(from);
  const ti = p.items.indexOf(to);
  if (fi < 0 || ti < 0) return;
  /* 先摘出来再插到目标位置：拖到谁身上就排在谁前面 */
  p.items.splice(fi, 1);
  p.items.splice(ti, 0, from);
  savePosts();
  renderDrawer();
});

const hasFiles = (e) => {
  const dt = e.dataTransfer;
  if (!dt) return false;
  if (dt.files && dt.files.length) return true;
  return [...(dt.types || [])].includes('Files');
};
const hasLink = (e) => {
  const dt = e.dataTransfer;
  return !!dt && [...(dt.types || [])].includes('text/uri-list');
};

document.addEventListener('dragover', (e) => {
  const vp = e.target.closest('#cvsViewport');
  if (!vp) return;
  /* 外部文件也要放行，否则浏览器会用默认行为直接打开图片 */
  if (!State.dragId && !hasFiles(e) && !hasLink(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  vp.classList.add('drop-on');
  vp.classList.toggle('drop-file', (hasFiles(e) || hasLink(e)) && !State.dragId);
});

document.addEventListener('dragleave', (e) => {
  const vp = e.target.closest('#cvsViewport');
  if (!vp) return;
  if (!vp.contains(e.relatedTarget)) { vp.classList.remove('drop-on'); vp.classList.remove('drop-file'); }
});

document.addEventListener('drop', (e) => {
  const vp = e.target.closest('#cvsViewport');
  if (!vp) return;
  e.preventDefault();
  vp.classList.remove('drop-on');
  vp.classList.remove('drop-file');
  /* 外部文件优先：从电脑拖进来的图片 */
  const files = e.dataTransfer && e.dataTransfer.files ? [...e.dataTransfer.files] : [];
  if (files.length) { cvsAddLocalFiles(files, e.clientX, e.clientY); return; }
  /* 拖进来的链接当作网页卡片 */
  const link = e.dataTransfer && (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain'));
  if (link && /^https?:\/\//i.test(link.trim())) {
    if (cvsAddLink(link.trim(), e.clientX, e.clientY)) return;
  }
  const rid = State.dragId || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
  State.dragId = null;
  document.body.classList.remove('cvs-dragging');
  const r = resultById(rid);
  if (!r) return;
  if (canvasHas(rid)) { toast('info', '已经在画布上了', r.title); return; }
  /* 落点换算成画布世界坐标 */
  const rect = vp.getBoundingClientRect();
  const v = cvsView();
  const wx = Math.round((e.clientX - rect.left - v.x) / v.k - CVS_W / 2);
  const wy = Math.round((e.clientY - rect.top - v.y) / v.k - 60);
  const from = r.home;
  canvasItems().push({ id: `c${++State.seq}`, kind: 'media', type: r.type, f: r.asset, t: r.title, rid, x: wx, y: wy });
  if (from === 'inbox' || from === 'draft') r.home = 'canvas';
  renderAll();
  toast('success', from === 'draft' ? '已从草稿箱捞回画布' : '已放进画布', `${r.title} · 满意后可以保存到素材库`);
});

/* 无限画布交互：拖空白框选、空格拖平移、滚轮缩放、拖元素摆放、拖角缩放 */
let cvsAct = null;

/* 右键菜单：PureRef 主要靠它装操作，桌面软件的习惯 */
function cvsMenuItems() {
  /* 选中的是一条线：菜单换成线能做的事 */
  if (State.linkSel) {
    const l = canvasLinks().find((x) => x.id === State.linkSel);
    if (l) {
      return [
        { t: '给这条线写个名字', act: 'cvs-link-label' },
        ...(l.label ? [{ t: '清除名字', act: 'cvs-link-label-clear' }] : []),
        { sep: true },
        { t: '删除这条线', k: 'Del', act: 'cvs-link-remove', danger: true },
      ];
    }
  }
  const sel = canvasSelItems();
  const n = sel.length;
  const many = n > 1;
  const one = n === 1 ? sel[0] : null;
  /* 能做什么取决于元素是什么。菜单只列真的用得上的项，不给点了没反应的入口 */
  const isMedia = !!(one && one.kind === 'media');
  const hasSrc = !!(one && one.src);
  const isGroup = !!(one && one.kind === 'group');
  const isText = !!(one && one.kind === 'text');
  const items = [];
  if (!n) {
    items.push({ t: '全选', k: 'Ctrl A', act: 'cvs-select-all' });
    items.push({ t: '适应窗口', k: 'F', act: 'cvs-fit' });
    items.push({ t: '整理成网格', act: 'cvs-arrange' });
    items.push({ sep: true });
    items.push({ t: '从电脑选文件', act: 'cvs-upload' });
    items.push({ t: State.cvsPen.on ? '关闭画笔' : '手绘标注', k: 'B', act: 'cvs-pen' });
    items.push({ t: '新建节点', act: 'cvs-new-node' });
    items.push({ t: '新建文字', act: 'cvs-new-text' });
    items.push({ t: '把画板上的东西归为一组', act: 'cvs-group-all' });
    if (canvasItems().length) {
      items.push({ sep: true });
      items.push({ t: '清空画板', act: 'canvas-clear', danger: true });
    }
    return items;
  }
  items.push({ t: '复制一份', k: 'Ctrl D', act: 'cvs-duplicate' });
  if (isMedia) items.push({ t: '以此发散', act: 'diverge-open' });
  if (isMedia && one.type === 'image') items.push({ t: '适配多平台尺寸', act: 'platforms-open' });
  if (isMedia) {
    items.push({
      t: State.styleAnchor && State.styleAnchor.cvsId === one.id ? '取消风格基准' : '设为风格基准',
      act: 'anchor-toggle', v: one.id,
    });
  }
  if (n === 2) items.push({ t: '把这两个连起来', act: 'cvs-link-pair' });
  if (many) items.push({ t: '归为一组', act: 'cvs-group-selection' });
  if (isMedia) items.push({ t: '展开为导图', act: 'cvs-mindmap' });
  if (!many) items.push({ t: '从这里连线', act: 'cvs-link-start', v: one.id });
  if (hasSrc) items.push({ t: '收进审美库', act: 'cvs-keep-aes', v: one.id });
  /* 只有生成产出才有参数可看，别的类型不出现这一项 */
  if (!many && one.rid) items.push({ t: '查看生成参数', act: 'cvs-menu-params' });
  if (!many && one.rid && !savedToLib(one.rid)) items.push({ t: '保存到素材库', act: 'cvs-save-lib' });
  items.push({ sep: true });
  if (many) {
    items.push({ label: '对齐' });
    items.push({ t: '左对齐', act: 'cvs-align', v: 'left' });
    items.push({ t: '水平居中', act: 'cvs-align', v: 'hcenter' });
    items.push({ t: '右对齐', act: 'cvs-align', v: 'right' });
    items.push({ t: '顶对齐', act: 'cvs-align', v: 'top' });
    items.push({ t: '垂直居中', act: 'cvs-align', v: 'vcenter' });
    items.push({ t: '底对齐', act: 'cvs-align', v: 'bottom' });
    items.push({ label: '分布' });
    items.push({ t: '水平均分', act: 'cvs-distribute', v: 'h' });
    items.push({ t: '垂直均分', act: 'cvs-distribute', v: 'v' });
  }
  if (isText) {
    items.push({ label: '字号' });
    items.push({ t: '小（备注）', act: 'cvs-text-size', v: 'sm' });
    items.push({ t: '中（正文）', act: 'cvs-text-size', v: 'md' });
    items.push({ t: '大（标题）', act: 'cvs-text-size', v: 'lg' });
  }
  /* 分组被强制压在最底层，改层级不会有任何变化，所以不给这两个入口 */
  if (!isGroup) {
    items.push({ label: '层级' });
    items.push({ t: '置顶', act: 'cvs-reorder', v: 'front' });
    items.push({ t: '置底', act: 'cvs-reorder', v: 'back' });
  }
  items.push({ label: '变换' });
  items.push({ t: '水平翻转', act: 'cvs-flip', v: 'h' });
  items.push({ t: '垂直翻转', act: 'cvs-flip', v: 'v' });
  items.push({ t: '顺时针转 90°', act: 'cvs-rotate', v: '90' });
  items.push({ t: '逆时针转 90°', act: 'cvs-rotate', v: '-90' });
  items.push({ label: '透明度' });
  items.push({ t: '半透明（描摹用）', act: 'cvs-opacity', v: '0.35' });
  items.push({ t: '恢复不透明', act: 'cvs-opacity', v: '1' });
  items.push({ t: '恢复原状', act: 'cvs-reset-el' });
  items.push({ sep: true });
  items.push({ t: `移除${many ? ` ${n} 个` : ''}元素`, k: 'Del', act: 'cvs-delete-sel', danger: true });
  return items;
}

/* 菜单高度跟选项数量走，渲染完按实际高度把它挪回可视区 */
function cvsClampMenu() {
  const m = State.cvsMenu;
  const el = document.querySelector('.cvs-menu');
  const vp = document.getElementById('cvsViewport');
  if (!m || !el || !vp) return;
  const maxX = Math.max(6, vp.clientWidth - el.offsetWidth - 8);
  const maxY = Math.max(6, vp.clientHeight - el.offsetHeight - 8);
  const nx = Math.min(m.x, maxX);
  const ny = Math.min(m.y, maxY);
  if (nx !== m.x) { m.x = nx; el.style.left = `${nx}px`; }
  if (ny !== m.y) { m.y = ny; el.style.top = `${ny}px`; }
}

/* 给线写名字：一个贴在曲线中点的小输入框 */
function cvsLinkLabelHTML() {
  const id = State.linkLabelEdit;
  if (!id) return '';
  const l = canvasLinks().find((x) => x.id === id);
  if (!l) return '';
  const a = canvasItems().find((x) => x.id === l.from);
  const b = canvasItems().find((x) => x.id === l.to);
  if (!a || !b) return '';
  const v = cvsView();
  const mid = cvsLinkMid(cvsElCenter(a), cvsElCenter(b));
  const x = Math.round(mid.x * v.k + v.x);
  const y = Math.round(mid.y * v.k + v.y);
  return `<div class="cvs-link-input" style="left:${x}px;top:${y}px">
    <input data-input="link-label" value="${esc(l.label || '')}" placeholder="这条线是什么意思…" />
    <button class="btn sm primary" data-action="cvs-link-label-save">确定</button>
  </div>`;
}

function cvsMenuHTML() {
  const m = State.cvsMenu;
  if (!m) return '';
  const items = cvsMenuItems();
  return `<div class="cvs-menu" style="left:${m.x}px;top:${m.y}px">
    ${items.map((it) => it.sep
    ? '<div class="cvs-menu-sep"></div>'
    : it.label
      ? `<div class="cvs-menu-label">${esc(it.label)}</div>`
      : `<button class="cvs-menu-item ${it.danger ? 'danger' : ''}" data-action="${it.act}"${it.v ? ` data-val="${it.v}"` : ''}>
        <span>${esc(it.t)}</span>${it.k ? `<span class="cvs-menu-key">${it.k}</span>` : ''}</button>`).join('')}
  </div>`;
}

/* 手绘标注：画笔开启时，在画布上拖动画一条线，松手落成一个元素 */
const PEN_COLORS = ['#4F46E5', '#E11D48', '#F59E0B', '#059669', '#171A23'];

function cvsDrawStart(e) {
  const vp = document.getElementById('cvsViewport');
  if (!vp) return;
  const rect = vp.getBoundingClientRect();
  const v = cvsView();
  const pt = [(e.clientX - rect.left - v.x) / v.k, (e.clientY - rect.top - v.y) / v.k];
  cvsAct = { mode: 'draw', moved: false, pts: [pt], vp, sx: e.clientX, sy: e.clientY };
  document.body.classList.add('cvs-acting');
}

function cvsDrawMove(e) {
  const { vp, pts } = cvsAct;
  const rect = vp.getBoundingClientRect();
  const v = cvsView();
  pts.push([(e.clientX - rect.left - v.x) / v.k, (e.clientY - rect.top - v.y) / v.k]);
  let svg = document.getElementById('cvsPenPreview');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'cvsPenPreview';
    svg.setAttribute('class', 'cvs-pen-preview');
    vp.appendChild(svg);
  }
  const w = vp.clientWidth, h = vp.clientHeight;
  svg.setAttribute('viewBox', `${-v.x / v.k} ${-v.y / v.k} ${w / v.k} ${h / v.k}`);
  svg.innerHTML = `<polyline points="${pts.map(([x, y]) => `${x},${y}`).join(' ')}" fill="none"
    stroke="${State.cvsPen.color}" stroke-width="${State.cvsPen.lw}" stroke-linecap="round" stroke-linejoin="round" />`;
}

function cvsDrawEnd() {
  const act = cvsAct;
  cvsAct = null;
  document.body.classList.remove('cvs-acting');
  const prev = document.getElementById('cvsPenPreview');
  if (prev) prev.remove();
  if (!act || !act.moved || act.pts.length < 2) return;
  const xs = act.pts.map((p) => p[0]);
  const ys = act.pts.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  const w = Math.max(12, Math.round(Math.max(...xs) - x));
  const h = Math.max(12, Math.round(Math.max(...ys) - y));
  canvasItems().push({
    id: `c${++State.seq}`, kind: 'draw', color: State.cvsPen.color, lw: State.cvsPen.lw,
    pts: act.pts.map(([px, py]) => [Math.round(px - x), Math.round(py - y)]),
    x: Math.round(x), y: Math.round(y), w, h,
  });
  paintCanvas();
}

/* 框选：屏幕坐标 → 世界坐标，跟元素包围盒求交 */
function cvsMarqueeRect(act, ex, ey) {
  const vp = document.getElementById('cvsViewport');
  if (!vp) return null;
  const rect = vp.getBoundingClientRect();
  const v = cvsView();
  const sx = act.ox, sy = act.oy;
  const cx = clamp(ex - rect.left, 0, rect.width);
  const cy = clamp(ey - rect.top, 0, rect.height);
  return {
    sx, sy, cx, cy,
    x: Math.min(sx, cx), y: Math.min(sy, cy),
    w: Math.abs(cx - sx), h: Math.abs(cy - sy),
    wx1: (Math.min(sx, cx) - v.x) / v.k,
    wy1: (Math.min(sy, cy) - v.y) / v.k,
    wx2: (Math.max(sx, cx) - v.x) / v.k,
    wy2: (Math.max(sy, cy) - v.y) / v.k,
  };
}

function cvsPaintMarquee(act, ex, ey) {
  const r = cvsMarqueeRect(act, ex, ey);
  if (!r) return;
  let box = document.getElementById('cvsMarquee');
  if (!box) {
    box = document.createElement('div');
    box.id = 'cvsMarquee';
    box.className = 'cvs-marquee';
    const vp = document.getElementById('cvsViewport');
    if (vp) vp.appendChild(box);
  }
  box.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;
  /* 实时预览选中结果 */
  const hit = new Set(act.base);
  canvasItems().forEach((i) => {
    if (i.x < r.wx2 && i.x + cvsItemW(i) > r.wx1 && i.y < r.wy2 && i.y + cvsItemH(i) > r.wy1) hit.add(i.id);
  });
  State.canvasSel = [...hit];
  const world = document.getElementById('cvsWorld');
  if (world) world.querySelectorAll('.cvs-el').forEach((n) => n.classList.toggle('sel', hit.has(n.dataset.id)));
}

function cvsClearMarquee() {
  const box = document.getElementById('cvsMarquee');
  if (box) box.remove();
  const world = document.getElementById('cvsWorld');
  if (world) world.querySelectorAll('.cvs-el').forEach((n) => n.classList.remove('marquee-hit'));
}

function cvsApplyMarquee(act, ex, ey) {
  const r = cvsMarqueeRect(act, ex, ey);
  if (!r) return;
  const hit = new Set(act.base);
  canvasItems().forEach((i) => {
    if (i.x < r.wx2 && i.x + cvsItemW(i) > r.wx1 && i.y < r.wy2 && i.y + cvsItemH(i) > r.wy1) hit.add(i.id);
  });
  State.canvasSel = [...hit];
  paintCanvas();
  afterSelChange();
}

const refDropZoneAt = (x, y) => {
  const el = document.elementFromPoint(x, y);
  return el ? el.closest('[data-ref-drop]') : null;
};
const setRefDropHighlight = (zone) => {
  document.querySelectorAll('[data-ref-drop].hot').forEach((n) => { if (n !== zone) n.classList.remove('hot'); });
  if (zone) zone.classList.add('hot');
};

/* 把画布元素放进参考素材：类型要对得上，最多 4 项 */
function cvsToRefs(ids) {
  const t = State.type;
  const items = ids.map((id) => canvasItems().find((i) => i.id === id)).filter((i) => i && i.kind === 'media');
  if (!items.length) { toast('warn', '这里没有素材', '先选中一张图片'); return false; }
  const other = items.find((i) => i.type !== t);
  if (other) {
    toast('warn', `这是${TYPES[other.type].name}，当前在${TYPES[t].name}页`,
      `切到「${TYPES[other.type].name}创作」的生成页再拖一次`);
    return false;
  }
  const room = 4 - State.refs[t].length;
  if (room <= 0) { toast('warn', '参考素材已满 4 项', '先移除一项再加'); return false; }
  let n = 0;
  items.slice(0, room).forEach((i) => {
    if (State.refs[t].some((r) => r.f === i.f)) return;
    State.refs[t].push({ f: i.f, w: 0.6, from: 'canvas' });
    n += 1;
  });
  renderMain();
  if (!n) toast('info', '已经在参考里了', items[0].t);
  else toast('success', `已加入 ${n} 项参考素材`, '生成时它们会作为参考图影响结果');
  return true;
}

document.addEventListener('contextmenu', (e) => {
  const vp = e.target.closest('#cvsViewport');
  if (!vp) return;
  e.preventDefault();
  const el = e.target.closest('.cvs-el');
  const linkEl = e.target.closest('.cvs-link-hit, .cvs-link');
  if (linkEl) {
    /* 右键点在线上：选中的是线，不是元素 */
    State.linkSel = linkEl.dataset.link;
    State.canvasSel = [];
  } else if (el) {
    const id = el.dataset.id;
    State.linkSel = null;
    /* 右键点在没选中的元素上：先选中它，再出菜单 */
    if (!State.canvasSel.includes(id)) { State.canvasSel = [id]; paintCanvas(); }
  } else if (State.canvasSel.length || State.linkSel) {
    State.canvasSel = [];
    State.linkSel = null;
    paintCanvas();
  }
  const rect = vp.getBoundingClientRect();
  State.cvsPop = null;
  State.cvsMenu = { x: Math.max(6, e.clientX - rect.left), y: Math.max(6, e.clientY - rect.top) };
  paintCanvas();
});

document.addEventListener('mousedown', (e) => {
  const vp = e.target.closest('#cvsViewport');
  const inMenu = e.target.closest('.cvs-menu');
  const inPop = e.target.closest('.cvs-pop');
  /* 点别处关掉菜单与参数浮层。只摘 DOM 不整体重绘，免得打断马上要开始的拖拽 */
  if ((State.cvsMenu && !inMenu) || (State.cvsPop && !inPop)) {
    if (State.cvsMenu && !inMenu) State.cvsMenu = null;
    if (State.cvsPop && !inPop) State.cvsPop = null;
    const mm = document.querySelector('.cvs-menu');
    if (mm) mm.remove();
    const pp = document.querySelector('.cvs-pop');
    if (pp) pp.remove();
  }
  /* 点在菜单或浮层里：交给按钮自己的 click，绝不能落到下面的画布交互分支 */
  if (inMenu || inPop) return;
  /* 线名输入框：让光标正常工作，不要当成框选 */
  if (e.target.closest('.cvs-link-input')) return;
  /* 点别处收起线名输入框 */
  if (State.linkLabelEdit && !e.target.closest('.cvs-link-input')) {
    State.linkLabelEdit = null;
    paintCanvas();
  }
  /* 画笔与空格平移是「模式」，优先于一切元素操作。
     原先它们排在元素拖动之后，导致开着画笔在元素上拖会变成拖元素、
     按住空格在元素上拖也不会平移——提示条和文档写的都不是这样。
     按 PureRef 的规矩：进了模式就是模式，要操作元素先退出模式。 */
  if (vp && !e.target.closest('.cvs-menu, .cvs-pop')) {
    if (State.cvsPen.on) { e.preventDefault(); cvsDrawStart(e); return; }
    if (State.cvsSpace || e.button === 1) {
      const vv = cvsView();
      e.preventDefault();
      cvsAct = { mode: 'pan', sx: e.clientX, sy: e.clientY, ox: vv.x, oy: vv.y, moved: false };
      document.body.classList.add('cvs-acting');
      return;
    }
  }
  /* Agent 悬浮面板的拖动。它不在画布视口里，所以要在 vp 判断之前接住 */
  const aHead = e.target.closest('[data-agent-drag]');
  if (aHead && !e.target.closest('[data-action]')) {
    const box = aHead.closest('.agent-float');
    if (box) {
      const br = box.getBoundingClientRect();
      e.preventDefault();
      State.agentDock = false;
      cvsAct = {
        mode: 'agent', sx: e.clientX, sy: e.clientY, moved: false,
        dx: e.clientX - br.left, dy: e.clientY - br.top,
      };
      box.classList.remove('docked');
      box.classList.add('placed');
      document.body.classList.add('cvs-acting');
      return;
    }
  }
  if (!vp) return;
  const v = cvsView();
  const el = e.target.closest('.cvs-el');
  if (el) State.linkSel = null;

  /* 拖分组标题栏：整组一起移动 */
  const ghead = e.target.closest('[data-group-head]');
  if (ghead && !e.target.closest('[data-action]') && !e.target.closest('[contenteditable]')) {
    const g = canvasItems().find((x) => x.id === ghead.dataset.groupHead);
    if (!g) return;
    e.preventDefault();
    const origin = {};
    const members = canvasItems().filter((x) => x.kind !== 'group' && inGroup(x, g));
    [g, ...members].forEach((x) => { origin[x.id] = { x: x.x, y: x.y }; });
    cvsAct = { mode: 'move', sx: e.clientX, sy: e.clientY, k: v.k, origin, moved: false };
    document.body.classList.add('cvs-acting');
    return;
  }

  /* 点连线：选中它（在元素之前判断，因为线在底层） */
  const linkEl = e.target.closest('.cvs-link-hit, .cvs-link');
  if (linkEl) {
    State.linkSel = State.linkSel === linkEl.dataset.link ? null : linkEl.dataset.link;
    State.canvasSel = [];
    paintCanvas();
    return;
  }

  /* 连线模式：点谁就连到谁 */
  if (State.linkFrom) {
    const target = e.target.closest('.cvs-el');
    const from = State.linkFrom;
    State.linkFrom = null;
    if (target && target.dataset.id !== from) {
      if (linkHas(from, target.dataset.id)) { toast('info', '这两个已经连过了'); paintCanvas(); return; }
      canvasLinks().push({ id: `L${++State.seq}`, from, to: target.dataset.id });
      paintCanvas();
      toast('success', '已连线');
      return;
    }
    paintCanvas();
    return;
  }

  /* 右下角手柄：改元素尺寸 */
  const grip = e.target.closest('[data-grip]');
  if (grip) {
    const it = canvasItems().find((x) => x.id === grip.dataset.grip);
    if (!it) return;
    e.preventDefault();
    e.stopPropagation();
    cvsAct = { mode: 'resize', id: it.id, sx: e.clientX, sy: e.clientY, w0: cvsItemW(it), k: v.k, moved: false };
    document.body.classList.add('cvs-acting');
    return;
  }

  /* 正在编辑的文字：让光标正常工作，不要变成拖动 */
  if (el && State.editTextId === el.dataset.id && e.target.closest('textarea, .cvs-text-body')) return;

  if (el && !e.target.closest('[data-action="canvas-remove"]')) {
    const id = el.dataset.id;
    const it = canvasItems().find((x) => x.id === id);
    if (!it) return;
    const isSel = State.canvasSel.includes(id);
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (additive) {
      State.canvasSel = isSel ? State.canvasSel.filter((x) => x !== id) : [...State.canvasSel, id];
    } else if (!isSel) {
      State.canvasSel = [id];
    }
    paintCvsSel();
    afterSelChange();
    e.preventDefault();
    const origin = {};
    State.canvasSel.forEach((x) => {
      const o = canvasItems().find((y) => y.id === x);
      if (o) origin[x] = { x: o.x, y: o.y };
    });
    cvsAct = { mode: 'move', sx: e.clientX, sy: e.clientY, k: v.k, origin, moved: false };
    document.body.classList.add('cvs-acting');
    return;
  }

  e.preventDefault();
  /* 到这里只剩「在空白处拖」：左键框选 */
  const rect = vp.getBoundingClientRect();
  cvsAct = {
    mode: 'marquee', sx: e.clientX, sy: e.clientY, moved: false,
    ox: e.clientX - rect.left, oy: e.clientY - rect.top,
    additive: e.shiftKey || e.ctrlKey || e.metaKey,
    base: State.canvasSel.slice(),
  };
  document.body.classList.add('cvs-acting');
});

document.addEventListener('mousemove', (e) => {
  if (!cvsAct) return;
  cvsAct.ex = e.clientX;
  cvsAct.ey = e.clientY;
  if (cvsAct.mode === 'draw') {
    const d0 = Math.abs(e.clientX - cvsAct.sx) + Math.abs(e.clientY - cvsAct.sy);
    if (!cvsAct.moved && d0 < 3) return;
    cvsAct.moved = true;
    cvsDrawMove(e);
    return;
  }
  const dx = e.clientX - cvsAct.sx;
  const dy = e.clientY - cvsAct.sy;
  if (!cvsAct.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
  cvsAct.moved = true;
  if (cvsAct.mode === 'resize') {
    const n = document.querySelector(`#cvsWorld .cvs-el[data-id="${cvsAct.id}"]`);
    if (n) {
      /* 取长边位移，斜着拖也顺手 */
      const d = Math.abs(dx) > Math.abs(dy) ? dx : dy;
      n.style.width = `${Math.round(clamp(cvsAct.w0 + d / cvsAct.k, CVS_W_MIN, CVS_W_MAX))}px`;
    }
    return;
  }
  if (cvsAct.mode === 'pan') {
    const v = cvsView();
    v.x = cvsAct.ox + dx;
    v.y = cvsAct.oy + dy;
    syncCvsView();
    return;
  }
  if (cvsAct.mode === 'marquee') {
    cvsPaintMarquee(cvsAct, e.clientX, e.clientY);
    return;
  }
  if (cvsAct.mode === 'agent') {
    const box = document.querySelector('.agent-float');
    if (box) {
      const x = clamp(e.clientX - cvsAct.dx, 8, Math.max(8, window.innerWidth - box.offsetWidth - 8));
      const y = clamp(e.clientY - cvsAct.dy, 8, Math.max(8, window.innerHeight - 60));
      box.style.left = `${x}px`;
      box.style.top = `${y}px`;
      cvsAct.lastX = x;
      cvsAct.lastY = y;
    }
    return;
  }
  Object.keys(cvsAct.origin).forEach((id) => {
    const n = document.querySelector(`#cvsWorld .cvs-el[data-id="${id}"]`);
    if (!n) return;
    const o = cvsAct.origin[id];
    n.style.left = `${Math.round(o.x + dx / cvsAct.k)}px`;
    n.style.top = `${Math.round(o.y + dy / cvsAct.k)}px`;
  });
  cvsSyncLinks(true);
  setRefDropHighlight(refDropZoneAt(e.clientX, e.clientY));
});

/* 双击进入文字编辑：节点和文字卡片共用这套。
   单击仍然是「选中 / 拖动」，双击才是「写字」——和画布类工具的习惯一致。 */
document.addEventListener('dblclick', (e) => {
  const box = e.target.closest('.cvs-el');
  if (!box) return;
  const it = canvasItems().find((x) => x.id === box.dataset.id);
  if (!isTextEl(it)) return;
  e.preventDefault();
  State.editTextId = it.id;
  box.classList.add('editing');

  /* 文字：contenteditable，光标落到末尾 */
  if (it.kind === 'text') {
    const body = box.querySelector('.cvs-text-body');
    if (!body) return;
    body.setAttribute('contenteditable', 'true');
    body.focus();
    try {
      const r = document.createRange();
      r.selectNodeContents(body);
      r.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    } catch (_) { /* 忽略 */ }
    return;
  }

  /* 节点：只读 textarea 解锁 */
  const ta = box.querySelector('textarea');
  if (!ta) return;
  ta.removeAttribute('readonly');
  ta.focus();
  try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (_) { /* 忽略 */ }
});

/* 失焦即保存。重渲染导致的失焦也会走到这里，所以不会丢字 */
document.addEventListener('focusout', (e) => {
  const t = e.target;
  if (!t || !t.dataset) return;
  /* 文字：读 textContent，顺手量一次尺寸。
     这里不能整体重绘——重绘会把刚点下去的那一下吃掉。 */
  if (t.dataset.textId) {
    const it = canvasItems().find((x) => x.id === t.dataset.textId);
    const box = t.closest('.cvs-el');
    if (it) {
      it.text = t.textContent.trim();
      if (box) {
        const w = Math.ceil(box.offsetWidth);
        const h = Math.ceil(box.offsetHeight);
        if (w && h) { it.w = w; it.h = h; }
      }
    }
    if (State.editTextId === (it && it.id)) State.editTextId = null;
    t.removeAttribute('contenteditable');
    if (box) box.classList.remove('editing');
    cvsSyncLinks();
    return;
  }
  const id = t.dataset.nodeId;
  if (!id) return;
  const it = canvasItems().find((x) => x.id === id);
  if (it) it.text = t.value;
  if (State.editTextId === id) State.editTextId = null;
  t.setAttribute('readonly', 'readonly');
  const box = t.closest('.cvs-el');
  if (box) box.classList.remove('editing');
});

document.addEventListener('mouseup', (e) => {
  if (!cvsAct) return;
  if (cvsAct.mode === 'draw') { cvsDrawEnd(); return; }
  /* Agent 拖动：位置在移动时已经实时应用，这里只收尾并记下来 */
  if (cvsAct.mode === 'agent') {
    const moved = cvsAct.moved;
    const lx = cvsAct.lastX; const ly = cvsAct.lastY;
    cvsAct = null;
    document.body.classList.remove('cvs-acting');
    if (moved && lx != null) { State.agentPos = { x: lx, y: ly }; }
    return;
  }
  const act = cvsAct;
  if (e && e.clientX != null) { act.ex = e.clientX; act.ey = e.clientY; }
  cvsAct = null;
  document.body.classList.remove('cvs-acting');
  if (!act.moved) {
    if (act.mode === 'resize') return;
    if (act.mode === 'marquee') {
      cvsClearMarquee();
      if (!act.additive && State.canvasSel.length) { State.canvasSel = []; paintCanvas(); }
      return;
    }
    /* 点空白处取消选择 */
    if (act.mode === 'pan') {
      let dirty = false;
      if (State.canvasSel.length) { State.canvasSel = []; dirty = true; }
      if (State.cvsPop) { State.cvsPop = null; dirty = true; }
      if (dirty) paintCanvas();
    }
    return;
  }
  if (act.mode === 'marquee') {
    cvsClearMarquee();
    cvsApplyMarquee(act, act.ex, act.ey);
    return;
  }
  if (act.mode === 'resize') {
    const it = canvasItems().find((x) => x.id === act.id);
    const n = document.querySelector(`#cvsWorld .cvs-el[data-id="${act.id}"]`);
    if (it && n && act.moved) it.w = Math.round(parseFloat(n.style.width) || cvsItemW(it));
    paintCanvas();
    return;
  }
  if (act.mode === 'pan') return;
  /* 松手时落在参考素材区：加入参考，位置不动 */
  const zone = refDropZoneAt(act.ex, act.ey);
  if (zone) {
    setRefDropHighlight(null);
    zone.classList.remove('hot');
    cvsToRefs(Object.keys(act.origin));
    paintCanvas();
    return;
  }
  setRefDropHighlight(null);
  Object.keys(act.origin).forEach((id) => {
    const it = canvasItems().find((x) => x.id === id);
    const n = document.querySelector(`#cvsWorld .cvs-el[data-id="${id}"]`);
    if (!it || !n) return;
    it.x = Math.round(parseFloat(n.style.left) || 0);
    it.y = Math.round(parseFloat(n.style.top) || 0);
  });
});

/* 以鼠标位置为锚点缩放 */
document.addEventListener('wheel', (e) => {
  const vp = e.target.closest('#cvsViewport');
  if (!vp) return;
  e.preventDefault();
  const v = cvsView();
  const rect = vp.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  const k2 = Math.round(clamp(v.k * factor, CVS_K_MIN, CVS_K_MAX) * 100) / 100;
  if (k2 === v.k) return;
  v.x = mx - ((mx - v.x) / v.k) * k2;
  v.y = my - ((my - v.y) / v.k) * k2;
  v.k = k2;
  syncCvsView();
}, { passive: false });

/* 输入：轻量绑定，尽量不打断输入焦点 */
document.addEventListener('input', (e) => {
  const t = e.target;
  if (!t || !t.dataset) return;
  if (t.dataset.nodeId) {
    const it = canvasItems().find((x) => x.id === t.dataset.nodeId);
    if (it) it.text = t.value;
    return;
  }
  if (t.dataset.groupName) {
    const it = canvasItems().find((x) => x.id === t.dataset.groupName);
    if (it) it.t = t.textContent.trim().slice(0, 24) || '未命名分组';
    return;
  }
  if (t.dataset.textId) {
    const it = canvasItems().find((x) => x.id === t.dataset.textId);
    if (it) it.text = t.textContent;
    return;
  }
  if (t.dataset.noteId) {
    const it = canvasItems().find((x) => x.id === t.dataset.noteId);
    if (it) it.text = t.value;
    return;
  }
  const key = t.dataset.input;
  if (!key) return;
  if (key.startsWith('e-')) {
    const field = key.slice(2);
    const ops = State.editOps[State.type];
    ops[field] = ['brightness', 'contrast', 'saturate', 'in', 'out', 'volume', 'fadeIn', 'fadeOut'].includes(field)
      ? Number(t.value) : t.value;
    syncEditStage();
    return;
  }
  if (key === 'prompt') {
    State.prompt[State.type] = t.value;
    /* 输入时同步"字数提示 + 辅助按钮文案"，避免用户写完还不知道该点哪个 */
    const thin = t.value.trim().length < EXPAND_THRESHOLD;
    const c = $('#promptCount');
    if (c) c.textContent = `${t.value.trim().length} 字 · ${thin ? '写一句大白话就行，点右上「帮我写详细」' : '描述已足够完整'}`;
    const b = $('[data-action="ai-optimize"]');
    if (b) b.innerHTML = `${icon('sparkles')}${thin ? '帮我写详细' : '补充细节'}`;
  } else if (key === 'negative') {
    State.negative[State.type] = t.value;
  } else if (key === 'seed') {
    State.params.image.seed = t.value;
  } else if (key === 'lib-search') {
    State.libSearch = t.value;
    const composing = e.isComposing || t.isComposing;
    if (!composing) {
      renderAll();
      const el = $('[data-input="lib-search"]');
      if (el) { el.focus(); try { el.setSelectionRange(t.value.length, t.value.length); } catch (_) { } }
    }
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (!t || !t.dataset || !t.dataset.change) return;
  const k = t.dataset.change;
  const p = State.params[State.type];
  if (k === 'model') {
    p.model = t.value;
    if (State.type === 'video' && p.model === 'm-vid-f1' && p.dur > 5) p.dur = 5;
    renderMain();
    toast('info', `已切换模型：${modelOf(p.model).name}`, `单价 ${modelOf(p.model).price} 点 / ${modelOf(p.model).basis}`);
    return;
  }
  if (k === 'voice') { p.voice = t.value; renderMain(); return; }
  if (k === 'mood') { p.mood = t.value; renderMain(); return; }
});

function renderAll() {
  /* 重渲染会替换 DOM，先记录输入焦点与光标位置，渲染后恢复，
     避免队列在后台完成时抢走正在编辑的提示词焦点 */
  const a = document.activeElement;
  const key = a && a.dataset ? a.dataset.input : null;
  const sel = a && a.selectionStart != null ? a.selectionStart : null;
  renderTopbar();
  renderSidebar();
  renderMain();
  renderDrawer();
  scheduleCanvasSave();
  historyTick();
  if (key) {
    const el = document.querySelector(`[data-input="${key}"]`);
    if (el) {
      el.focus();
      if (sel != null) { try { el.setSelectionRange(sel, sel); } catch (_) { } }
    }
  }
}

(function init() {
  loadMeta();
  loadPosts();
  loadUI();
  const lostLocal = loadCanvas();
  const running = State.jobs.find((j) => j.status === 'running');
  if (running) running.eta = '约 1 分钟';
  renderAll();
  setInterval(tick, 700);
  setTimeout(() => {
    toast('ai', '欢迎来到 AIGC 创作台', '写一句提示词就能生成；完成后在「素材库」查看产出。');
    if (lostLocal) {
      toast('warn', `有 ${lostLocal} 个本地文件没能恢复`,
        '从电脑拖进来的图片是临时引用，刷新后就失效了。存进素材库的产出不受影响。');
    }
  }, 600);
})();


