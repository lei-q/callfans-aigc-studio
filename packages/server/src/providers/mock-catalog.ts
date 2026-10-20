import type { MediaType, ModelInfo } from '@aigc/shared';

/** 演示渠道的模型：沿用原型里的 8 个模型与价目 */
export const MOCK_MODELS: ModelInfo[] = [
  {
    id: 'm-img-u2', name: 'Aurora-Image U2', type: 'image', price: 0.3, basis: '张', status: 'on', channel: 'mock', maxRes: '2k', secPer: 40,
    note: '高保真主视觉，最高 2K，支持参考图与局部重绘', caps: ['参考图', '局部重绘', '最高 2K', '约 40 秒/张'], limit: '比例 1:1 / 4:5 / 16:9 / 9:16',
    sample: '生成 4 张标准图约 1.2 点', maxInputImages: 4,
  },
  {
    id: 'm-img-f2', name: 'Aurora-Image F2', type: 'image', price: 0.08, basis: '张', status: 'on', channel: 'mock', maxRes: '1080p', secPer: 4,
    note: '快速草稿与批量试色，最高 1080p，出图约 4 秒', caps: ['快速', '批量', '最高 1080p'], limit: '比例 1:1 / 4:5 / 16:9',
    sample: '生成 4 张草图约 0.32 点', maxInputImages: 4,
  },
  {
    id: 'm-img-x1', name: 'Aurora-Image X1', type: 'image', price: 0.45, basis: '张', status: 'on', channel: 'mock', maxRes: '4k', secPer: 90,
    note: '大幅面输出，支持 4K 与材质控制', caps: ['支持 4K', '材质控制', '参考图', '约 90 秒/张'], limit: '比例 1:1 / 4:5 / 16:9 / 9:16',
    sample: '生成 4 张约 1.8 点', maxInputImages: 4,
  },
  {
    id: 'm-vid-c1', name: 'Muse-Video C1', type: 'video', price: 0.8, basis: '秒', status: 'on', channel: 'mock', durs: [3, 5, 8], maxDur: 8, secPer: 44,
    note: '电影级运镜与光影，支持首帧参考', caps: ['首帧参考', '5 种运镜', '≤8 秒', '24fps'], limit: '时长 3 / 5 / 8 秒',
    sample: '一条 5 秒片约 4 点',
  },
  {
    id: 'm-vid-f1', name: 'Muse-Video F1', type: 'video', price: 0.25, basis: '秒', status: 'on', channel: 'mock', durs: [3, 5], maxDur: 5, secPer: 6,
    note: '低成本动效与循环素材，出片约 30 秒', caps: ['快速', '循环点', '≤5 秒'], limit: '时长 3 / 5 秒',
    sample: '一条 3 秒循环约 0.75 点',
  },
  {
    id: 'm-aud-tts', name: 'Vocal-TTS V3', type: 'audio', price: 0.5, basis: '30 秒', status: 'on', channel: 'mock', uses: ['tts'],
    note: '多音色配音，支持中英日与停顿控制', caps: ['32 音色', '中/英/日', '停顿控制'], limit: '单条 ≤ 120 秒',
    sample: '一条 30 秒配音约 0.5 点',
  },
  {
    id: 'm-aud-mus', name: 'Score-Music M1', type: 'audio', price: 0.6, basis: '30 秒', status: 'on', channel: 'mock', uses: ['music'],
    note: '情绪音乐，可指定 BPM、乐器与循环点', caps: ['情绪', 'BPM', '可循环'], limit: '单条 ≤ 180 秒',
    sample: '一条 60 秒配乐约 1.2 点',
  },
  {
    id: 'm-aud-sfx', name: 'Foley-SFX S2', type: 'audio', price: 0.1, basis: '条', status: 'on', channel: 'mock', uses: ['sfx'],
    note: '短音效与标识音，适合片头与转场', caps: ['1–8 秒', '批量', '低延迟'], limit: '单条 ≤ 8 秒',
    sample: '一条音效约 0.1 点',
  },
];

/** 示意产物池：由 GPT Image 2.5 生成的本地素材 */
export const ASSET_POOL: Record<MediaType, { f: string; t: string }[]> = {
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

export const sampleSrc = (f: string) => `/samples/results/${f}.png`;
export const sampleThumb = (f: string) => `/samples/thumbs/${f}.webp`;
