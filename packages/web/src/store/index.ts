import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type {
  AestheticItem,
  AgentResult,
  ApiKey,
  ApiUsage,
  AppInfo,
  Board,
  Channel,
  EditOpsMap,
  Job,
  JobParams,
  MediaType,
  ModelInfo,
  OptimizeReply,
  Post,
  Project,
  RefInput,
  Result,
  Settings,
  Wallet,
} from '@aigc/shared';
import { EDIT_DEF, PEN_COLORS, SEED_PROMPTS } from '@aigc/shared';

export type Page = 'studio' | 'jobs' | 'library' | 'models' | 'aesthetic' | 'api' | 'settings';
export type DrawerType = 'result' | 'help' | 'queue' | 'ref-add' | 'topup' | 'edit' | 'post' | 'project';

export interface Toast {
  id: number;
  type: 'ai' | 'success' | 'info' | 'warn';
  title: string;
  desc?: string;
  out?: boolean;
}

export type StudioParams = JobParams & { model: string };

export interface State {
  /* ---------------- 数据 ---------------- */
  ready: boolean;
  online: boolean;
  bootError: string | null;
  app: AppInfo | null;
  projects: Project[];
  jobs: Job[];
  results: Result[];
  wallet: Wallet;
  boards: Record<string, Board>;
  aesthetic: AestheticItem[];
  posts: Post[];
  models: ModelInfo[];
  channels: Channel[];
  settings: Settings | null;
  apiKeys: ApiKey[];
  apiUsage: ApiUsage[];

  /* ---------------- 导航 ---------------- */
  page: Page;
  ws: string;
  wsMenu: boolean;
  studioTab: 'gen' | 'edit';
  type: MediaType;
  drawer: { type: DrawerType; id?: string } | null;

  /* ---------------- 生成表单 ---------------- */
  prompt: Record<MediaType, string>;
  negative: Record<MediaType, string>;
  refs: Record<MediaType, RefInput[]>;
  params: Record<MediaType, StudioParams>;
  optimize: OptimizeReply | null;
  optimizing: boolean;
  adv: boolean;
  genLock: boolean;

  /* ---------------- 列表筛选 ---------------- */
  queueFilter: 'all' | 'failed';
  jobFilter: 'all' | 'failed' | 'running';
  expanded: Record<string, boolean>;
  libTab: 'lib' | 'draft' | 'post';
  libFilter: string;
  libSearch: string;
  libScope: 'ws' | 'all';
  libSelect: string[];
  refScope: 'ws' | 'all';
  editScope: 'ws' | 'all';
  aestheticFilter: 'all' | 'image' | 'video' | 'web';
  apiLang: 'curl' | 'python' | 'node';
  newKeySecret: string | null;

  /* ---------------- 编辑器 ---------------- */
  editPick: Record<MediaType, string | null>;
  editOps: EditOpsMap;

  /* ---------------- 播放 ---------------- */
  play: { id: string | null; t: number };

  /* ---------------- 画布 ---------------- */
  canvasOpen: boolean;
  cvsFull: boolean;
  formOpen: boolean;
  canvasSel: string[];
  linkSel: string | null;
  linkFrom: string | null;
  cvsMenu: { x: number; y: number } | null;
  cvsPop: { rid: string; sx: number; sy: number } | null;
  cvsPen: { on: boolean; color: string; lw: number };
  editTextId: string | null;
  linkLabelEdit: string | null;
  diverge: { srcId: string; axes: string[] } | null;
  platforms: { srcId: string; picks: string[] } | null;
  agent: { open: boolean; result: AgentResult | null; loading: boolean };
  agentPos: { x: number; y: number } | null;
  agentDock: boolean;
  canvasConfirm: boolean;
  cvsSpace: boolean;
  dragRid: string | null;
  refDropHot: boolean;
  history: Record<string, string[]>;
  future: Record<string, string[]>;

  toasts: Toast[];
}

export const emptyWallet: Wallet = {
  balance: 0,
  spent: { image: 0, video: 0, audio: 0 },
  dailyFree: 0.5,
  dailyUsed: 0,
  dailyDate: '',
  firstTopupDone: false,
};

export const cloneEditDefaults = (): EditOpsMap => ({
  image: { ...EDIT_DEF.image },
  video: { ...EDIT_DEF.video },
  audio: { ...EDIT_DEF.audio },
});

export const initialState: State = {
  ready: false,
  online: true,
  bootError: null,
  app: null,
  projects: [],
  jobs: [],
  results: [],
  wallet: emptyWallet,
  boards: {},
  aesthetic: [],
  posts: [],
  models: [],
  channels: [],
  settings: null,
  apiKeys: [],
  apiUsage: [],

  page: 'studio',
  ws: '',
  wsMenu: false,
  studioTab: 'gen',
  type: 'image',
  drawer: null,

  prompt: { ...SEED_PROMPTS },
  negative: { image: '', video: '', audio: '' },
  refs: { image: [], video: [], audio: [] },
  params: {
    image: { model: 'm-img-u2', ratio: '1:1', count: 4, res: '2k', seed: '', refWeight: 0.6, format: 'PNG' },
    video: { model: 'm-vid-c1', ratio: '9:16', dur: 5, cam: '推近', fps: 24, firstFrame: true, loop: false, vres: '720p' },
    audio: { model: 'm-aud-tts', use: 'tts', dur: 30, voice: 'lan', mood: 'morning', lang: '中文', volume: 80 },
  },
  optimize: null,
  optimizing: false,
  adv: false,
  genLock: false,

  queueFilter: 'all',
  jobFilter: 'all',
  expanded: {},
  libTab: 'lib',
  libFilter: 'all',
  libSearch: '',
  libScope: 'ws',
  libSelect: [],
  refScope: 'ws',
  editScope: 'ws',
  aestheticFilter: 'all',
  apiLang: 'curl',
  newKeySecret: null,

  editPick: { image: null, video: null, audio: null },
  editOps: cloneEditDefaults(),

  play: { id: null, t: 0 },

  canvasOpen: true,
  cvsFull: false,
  formOpen: true,
  canvasSel: [],
  linkSel: null,
  linkFrom: null,
  cvsMenu: null,
  cvsPop: null,
  cvsPen: { on: false, color: PEN_COLORS[0], lw: 3 },
  editTextId: null,
  linkLabelEdit: null,
  diverge: null,
  platforms: null,
  agent: { open: false, result: null, loading: false },
  agentPos: null,
  agentDock: false,
  canvasConfirm: false,
  cvsSpace: false,
  dragRid: null,
  refDropHot: false,
  history: {},
  future: {},

  toasts: [],
};

export const useStore = create<State>()(immer(() => initialState));

export const getState = () => useStore.getState();
export const setState = (fn: (s: State) => void) => useStore.setState(fn);
