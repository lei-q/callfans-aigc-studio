import type { AudioUse, MediaType, ResKey } from './types';

export const TYPES: Record<MediaType, { key: MediaType; name: string; ic: string; hint: string; unit: string }> = {
  image: { key: 'image', name: '图像', ic: 'image', hint: '主视觉 / 商品图 / 场景图', unit: '张' },
  video: { key: 'video', name: '视频', ic: 'video', hint: '短片 / 空镜 / 产品动效', unit: '条' },
  audio: { key: 'audio', name: '音频', ic: 'audio', hint: '配音 / 音乐 / 音效', unit: '条' },
};
export const TYPE_KEYS: MediaType[] = ['image', 'video', 'audio'];

export const PROJECT_DOTS = ['#F97316', '#4F46E5', '#7C5CFC', '#059669', '#E11D48', '#0EA5E9', '#D97706'];

export const RATIOS = ['1:1', '4:5', '16:9', '9:16'];
export const VIDEO_RATIOS: [string, string][] = [['9:16', '竖版 9:16'], ['16:9', '横版 16:9'], ['1:1', '方形 1:1']];

/** 分辨率档位：画质在这里就是分辨率，倍率直接进单价 */
export const RESOS: { k: ResKey; n: string; mul: number; px: string; edge: number }[] = [
  { k: '1080p', n: '1080p', mul: 0.6, px: '1080 × 1080', edge: 1080 },
  { k: '2k', n: '2K', mul: 1, px: '2048 × 2048', edge: 2048 },
  { k: '4k', n: '4K', mul: 2.2, px: '4096 × 4096', edge: 4096 },
];
export const resoOf = (k?: string) => RESOS.find((x) => x.k === k) || RESOS[1];
export const resRank = (k?: string) => RESOS.findIndex((x) => x.k === k);

export const VIDEO_RES = ['480p', '720p', '1080p'];
export const CAMS = ['固定', '推近', '拉远', '环绕', '跟随'];
export const VOICES = [
  { k: 'lan', n: '岚 · 温和女声', upstream: 'nova' },
  { k: 'mu', n: '牧 · 沉稳男声', upstream: 'onyx' },
  { k: 'qi', n: '琪 · 明快女声', upstream: 'shimmer' },
  { k: 'ava', n: 'Ava · 英文女声', upstream: 'alloy' },
];
export const MOODS = [
  { k: 'morning', n: '清晨专注' },
  { k: 'night', n: '深夜氛围' },
  { k: 'upbeat', n: '轻快活力' },
  { k: 'warm', n: '品牌温暖' },
];
export const AU_DURS = [{ k: 15, n: '15 秒' }, { k: 30, n: '30 秒' }, { k: 60, n: '60 秒' }];
export const SFX_DURS = [{ k: 5, n: '5 秒' }, { k: 8, n: '8 秒' }];
export const AUDIO_USES: [AudioUse, string, string][] = [['tts', '配音', 'mic'], ['music', '音乐', 'audio'], ['sfx', '音效', 'zap']];
export const LANGS = ['中文', '英文', '中英混读'];

export const PROMPT_OPTIMIZE: Record<MediaType, { expand: string; add: string; neg: string; note: string }> = {
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

/** 描述偏短时走「扩写」，而不是只追加术语；这是新手最容易卡住的一步 */
export const EXPAND_THRESHOLD = 24;

/** 首屏预填的示例提示词 */
export const SEED_PROMPTS: Record<MediaType, string> = {
  image: '暖橙主色背景，哑光纸杯与咖啡豆居中，顶部柔光，奶油色高光，留出标题安全区',
  video: '城市街头跟拍，人物手持咖啡杯，黄金时刻逆光，浅景深，胶片颗粒',
  audio: '深夜电台片头：低沉男声导读，语气亲近，舒缓弦乐垫底，句间留白 0.4 秒',
};

/** 多平台适配：每个比例重新构图，不是裁剪 */
export const PLATFORMS = [
  { k: 'xhs', n: '小红书', ratio: '3:4', note: '封面 3:4，竖版信息流', ic: 'image' },
  { k: 'douyin', n: '抖音', ratio: '9:16', note: '全屏竖版，主体居中', ic: 'video' },
  { k: 'wechat', n: '公众号', ratio: '16:9', note: '头图横版，左右留白', ic: 'link' },
  { k: 'weibo', n: '微博', ratio: '4:3', note: '横版信息流', ic: 'send' },
  { k: 'square', n: '方图通用', ratio: '1:1', note: '头像 / 商品卡 / 多平台兜底', ic: 'grid' },
];
export const PLATFORM_DEFAULT = ['xhs', 'douyin', 'wechat'];

/** 发散的六个方向轴 */
export const DIVERGE_AXES = [
  { k: 'style', n: '换风格', d: '主体不变，换一种视觉语言', add: '改为手绘插画风格，笔触松弛、边缘不规则' },
  { k: 'light', n: '换光线', d: '主体不变，换一种打光', add: '改为冷调侧光，明暗对比更强，阴影更硬' },
  { k: 'angle', n: '换视角', d: '主体不变，换一个机位', add: '改为俯拍平铺视角，画面更规整、留白更均匀' },
  { k: 'scene', n: '换场景', d: '主体放进不同环境', add: '放进自然光下的生活场景，加入环境元素与人物痕迹' },
  { k: 'subject', n: '换主体', d: '风格不变，换一个主体', add: '主体换为同品类的其他对象，保持原有色调、光线与构图' },
  { k: 'format', n: '换画幅', d: '同一画面换一种构图', add: '改为竖版构图，主体偏上，下方留出大片文字安全区' },
];
export const DIVERGE_DEFAULT = ['style', 'light', 'scene'];

/** 社媒平台：运营最核心的参考物 */
export const POST_PLATFORMS = [
  { k: 'xhs', n: '小红书', re: /(^|\.)xiaohongshu\.com|xhslink\.com/i, color: '#FF2442', label: '图文笔记', ic: 'image' },
  { k: 'douyin', n: '抖音', re: /(^|\.)douyin\.com|iesdouyin\.com/i, color: '#161823', label: '短视频', ic: 'video' },
  { k: 'weibo', n: '微博', re: /(^|\.)weibo\.(com|cn)/i, color: '#E6162D', label: '微博', ic: 'send' },
  { k: 'wechat', n: '公众号', re: /mp\.weixin\.qq\.com/i, color: '#07C160', label: '图文推送', ic: 'link' },
  { k: 'bili', n: 'B 站', re: /(^|\.)bilibili\.com|b23\.tv/i, color: '#00A1D6', label: '视频', ic: 'film' },
  { k: 'zhihu', n: '知乎', re: /(^|\.)zhihu\.com/i, color: '#0084FF', label: '回答 / 文章', ic: 'user' },
];
/** 视频平台：运营看视频参考时看的是「时长 + 播放量」 */
export const VIDEO_PLATFORMS = [
  { k: 'youtube', n: 'YouTube', re: /(^|\.)youtube\.com|youtu\.be/i, color: '#FF0000', label: '视频', ic: 'video' },
  { k: 'vimeo', n: 'Vimeo', re: /(^|\.)vimeo\.com/i, color: '#1AB7EA', label: '视频', ic: 'video' },
  { k: 'tencent', n: '腾讯视频', re: /(^|\.)v\.qq\.com/i, color: '#FF7F00', label: '视频', ic: 'film' },
  { k: 'youku', n: '优酷', re: /(^|\.)youku\.com/i, color: '#1E90FF', label: '视频', ic: 'film' },
];
export type PlatformDef = (typeof POST_PLATFORMS)[number];

export const videoPlatformOf = (url?: string): PlatformDef | null =>
  VIDEO_PLATFORMS.find((x) => x.re.test(url || '')) || null;
export const postPlatformOf = (url?: string): PlatformDef | null =>
  POST_PLATFORMS.find((x) => x.re.test(url || '')) || videoPlatformOf(url);
const VIDEO_FILE_RE = /\.(mp4|webm|ogv|mov|m4v)([?#]|$)/i;
export const isDirectVideo = (url?: string) => VIDEO_FILE_RE.test(url || '');
export const hostOf = (url?: string) => {
  try {
    return new URL(url || '').host.replace(/^www\./, '');
  } catch {
    return '链接';
  }
};

/** 文档类型：从 MIME 和扩展名判断，只用来选图标与文案 */
export const FILE_KINDS = [
  { k: 'pdf', re: /pdf/, n: 'PDF', ic: 'bookmark' },
  { k: 'doc', re: /word|officedocument\.wordprocessing|msword|rtf|\.docx?$/, n: '文档', ic: 'list' },
  { k: 'sheet', re: /sheet|excel|csv|\.xlsx?$/, n: '表格', ic: 'chart' },
  { k: 'slide', re: /presentation|powerpoint|\.pptx?$/, n: '演示', ic: 'film' },
  { k: 'text', re: /^text\/|markdown|json|\.(txt|md)$/, n: '文本', ic: 'pen' },
];
export const fileKindOf = (type: string, name: string) => {
  const hay = `${type || ''} ${name || ''}`.toLowerCase();
  return FILE_KINDS.find((x) => x.re.test(hay)) || { k: 'other', re: /$^/, n: '文件', ic: 'box' };
};

/* ---------------- 基础编辑 ---------------- */
export const EDIT_FILTERS = [
  { k: 'none', n: '原图', css: '' },
  { k: 'warm', n: '暖调', css: 'sepia(.22) saturate(1.12) hue-rotate(-6deg)' },
  { k: 'cool', n: '冷调', css: 'hue-rotate(10deg) saturate(1.06) brightness(1.02)' },
  { k: 'mono', n: '黑白', css: 'grayscale(1) contrast(1.06)' },
  { k: 'film', n: '胶片', css: 'contrast(1.12) saturate(.92) sepia(.08)' },
];
export const EDIT_CROPS = ['原图', '1:1', '4:5', '16:9', '9:16'];

export interface ImageEditOps {
  filter: string;
  flipH: boolean;
  flipV: boolean;
  brightness: number;
  contrast: number;
  saturate: number;
  crop: string;
}
export interface VideoEditOps {
  in: number;
  out: number;
  speed: number;
  mute: boolean;
  cover: string;
  caption: string;
}
export interface AudioEditOps {
  in: number;
  out: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  denoise: boolean;
  norm: boolean;
}
export interface EditOpsMap {
  image: ImageEditOps;
  video: VideoEditOps;
  audio: AudioEditOps;
}
export const EDIT_DEF: EditOpsMap = {
  image: { filter: 'none', flipH: false, flipV: false, brightness: 0, contrast: 0, saturate: 0, crop: '原图' },
  video: { in: 0, out: 5, speed: 1, mute: false, cover: '首帧', caption: '' },
  audio: { in: 0, out: 30, volume: 100, fadeIn: 0, fadeOut: 0, denoise: false, norm: true },
};

export const HELP_TOPICS = [
  { t: '写不出提示词', d: '先写一句大白话，按右上「帮我写详细」补成完整提示词', act: 'studio' },
  { t: '定不好画质', d: '分辨率选 1080p / 2K / 4K，注意每个模型有上限，选超了会失败', act: 'studio' },
  { t: '想先摆一摆参考图', d: '右侧画布可以拖入任意图片，拖空白框选、空格拖平移', act: 'studio' },
  { t: '处理失败任务', d: '顶栏「失败」只看失败任务，点「修复」按建议重试', act: 'fail' },
  { t: '复用已有产出', d: '素材库里卡片「变体」可回填参考图继续生成', act: 'studio' },
  { t: '充值点数', d: '顶栏账号芯片点一下，微信 / 支付宝扫码在线充值', act: 'quota' },
  { t: '查看用量与账单', d: '「模型与价格」里看模型清单、价格与近 7 天调用', act: 'models' },
  { t: '查看历史任务', d: '任务记录里按状态筛选，点行展开看产出', act: 'jobs' },
  { t: '登录账号', d: '登录后用平台模型润色提示词；图片 / 视频生成在「模型与价格」配置自定义渠道', act: 'account' },
];

export const PEN_COLORS = ['#4F46E5', '#E11D48', '#F59E0B', '#059669', '#171A23'];

export const MAX_REFS = 4;
export const DEFAULT_PORT = 5780;
export const TREECLOUD_BASE_URL = 'https://api.jtreecloud.com';
