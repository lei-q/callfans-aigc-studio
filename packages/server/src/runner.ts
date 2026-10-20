import type { CreateJobBody, Job, ModelInfo, Result } from '@aigc/shared';
import {
  affordable,
  applyFix,
  chargeJob,
  durationText,
  ensureDaily,
  refundJob,
  resultTags,
  TYPES,
  uid,
  unitPrice,
  validateJob,
} from '@aigc/shared';
import type { Core } from './core';
import type { ProviderOutput, RunContext } from './providers/types';
import { ProviderError } from './providers/types';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

/* ============================================================================
   任务调度：创建即扣费、按渠道限并发排队、失败与取消一律退回。
   演示渠道一次只跑一个（和原型节奏一致），TreeCloud 按设置的并发数。
   ========================================================================== */

export class JobRunner {
  private running = new Map<string, AbortController>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly core: Core) {}

  private get store() {
    return this.core.store;
  }

  start() {
    this.recover();
    this.timer = setInterval(() => this.pump(), 400);
    this.pump();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const ac of this.running.values()) ac.abort();
  }

  /* ---------------- 持久化与推送 ---------------- */

  private save(job: Job) {
    this.store.jobs.put(job);
    this.core.events.emit({ type: 'job', job });
  }

  private saveWallet() {
    const w = this.store.wallet;
    this.core.events.emit({ type: 'wallet', wallet: w });
  }

  private project(ws: string) {
    return this.store.projects.get(ws);
  }

  private persistProject(p: ReturnType<JobRunner['project']>) {
    if (!p) return;
    this.store.projects.put(p);
    this.core.events.emit({ type: 'project', project: p });
  }

  /* ---------------- 创建 ---------------- */

  private siblings(model: ModelInfo) {
    return this.core.models().filter((m) => m.channel === model.channel);
  }

  private buildJob(body: CreateJobBody, source: Job['source'], keyId?: string): { job: Job; model: ModelInfo } {
    if (!this.project(body.ws)) throw new HttpError(400, '项目不存在');
    const model = this.core.modelById(body.model);
    if (!model) throw new HttpError(400, '模型不存在', '到「设置」里刷新模型列表');
    if (model.type !== body.type) throw new HttpError(400, `${model.name} 不是${TYPES[body.type].name}模型`);
    if (model.status !== 'on') throw new HttpError(400, `${model.name} 当前不可用`);
    if (!this.core.providerOf(model).channel().ready) throw new HttpError(400, '该渠道还没有配置好', '到「设置」里填入 TreeCloud API Key');
    const prompt = (body.prompt || '').trim();
    if (!prompt) throw new HttpError(400, '提示词为空', '至少描述主体与用途');
    const { type, ws, negative, refs, name, divergeAxis, platform, fromCvsId, model: _m, prompt: _p, ...params } = body;
    const job: Job = {
      ...params,
      id: uid('j'),
      name: name || autoName(type, prompt, params.count, params.dur),
      type,
      ws,
      model: model.id,
      prompt,
      negative: negative || undefined,
      refs: (refs || []).slice(0, 4),
      cost: unitPrice(type, params, model),
      status: 'queued',
      queueNote: '即将开始',
      createdAt: Date.now(),
      results: [],
      charged: false,
      divergeAxis,
      platform,
      fromCvsId,
      source,
      keyId,
    };
    return { job, model };
  }

  /** 创建一批任务（发散 / 适配按方向逐个建）。总价超出余额时整批拒绝 */
  createMany(bodies: CreateJobBody[], source: Job['source'] = 'web', keyId?: string): Job[] {
    if (!bodies.length) throw new HttpError(400, '没有要创建的任务');
    const built = bodies.map((b) => this.buildJob(b, source, keyId));
    const w = ensureDaily(this.store.wallet);
    const valid = built.filter(({ job, model }) => {
      job.fail = validateJob(job.type, job, model, this.siblings(model)) || undefined;
      return !job.fail;
    });
    const total = valid.reduce((n, x) => n + x.job.cost, 0);
    if (valid.length && !affordable(w, total)) {
      throw new HttpError(402, '点数不足', `需要 ${Math.round(total * 10) / 10} 点，当前余额 ${w.balance} 点`);
    }
    const out: Job[] = [];
    for (const { job } of built) {
      if (job.fail) {
        /* 参数校验不通过：直接记一条失败任务，不扣费，方便「修复 → 重试」 */
        job.status = 'failed';
        delete job.queueNote;
        this.save(job);
        this.core.events.notice('warn', '任务未通过参数校验', `${job.fail.code} · ${job.fail.reason}`);
      } else {
        const p = this.project(job.ws);
        chargeJob(w, job, p);
        this.persistProject(p);
        this.save(job);
      }
      out.push(job);
    }
    this.store.wallet = w;
    this.saveWallet();
    this.refreshNotes();
    this.pump();
    return out;
  }

  create(body: CreateJobBody, source: Job['source'] = 'web', keyId?: string) {
    return this.createMany([body], source, keyId)[0];
  }

  /* ---------------- 取消 / 重试 / 修复 ---------------- */

  cancel(id: string) {
    const job = this.store.jobs.get(id);
    if (!job) throw new HttpError(404, '任务不存在');
    if (job.status !== 'queued' && job.status !== 'running') throw new HttpError(400, '只能取消排队中或生成中的任务');
    const ac = this.running.get(id);
    job.status = 'canceled';
    delete job.eta;
    delete job.queueNote;
    if (ac) {
      ac.abort();
      this.running.delete(id);
      const model = this.core.modelById(job.model);
      if (model) void this.core.providerOf(model).cancel?.(job);
    }
    const w = this.store.wallet;
    const p = this.project(job.ws);
    const refunded = refundJob(w, job, p);
    this.store.wallet = w;
    this.persistProject(p);
    this.save(job);
    this.saveWallet();
    this.refreshNotes();
    return { job, refunded };
  }

  private requeue(job: Job, note: string) {
    const model = this.core.modelById(job.model);
    if (!model) throw new HttpError(400, '模型不存在', '到「设置」里刷新模型列表');
    const fail = validateJob(job.type, job, model, this.siblings(model));
    if (fail) throw new HttpError(400, fail.reason, fail.fix);
    const w = ensureDaily(this.store.wallet);
    if (!job.charged && !affordable(w, job.cost)) throw new HttpError(402, '点数不足', `需要 ${job.cost} 点，当前余额 ${w.balance} 点`);
    job.status = 'queued';
    job.progress = 0;
    job.queueNote = note;
    delete job.fail;
    delete job.eta;
    delete job.upstreamTaskId;
    delete job.startedAt;
    delete job.finishedAt;
    delete job.durText;
    const p = this.project(job.ws);
    chargeJob(w, job, p);
    this.store.wallet = w;
    this.persistProject(p);
    this.save(job);
    this.saveWallet();
    this.refreshNotes();
    this.pump();
    return job;
  }

  retry(id: string) {
    const job = this.store.jobs.get(id);
    if (!job) throw new HttpError(404, '任务不存在');
    if (job.status !== 'failed' && job.status !== 'canceled') throw new HttpError(400, '只有失败或已取消的任务可以重跑');
    return this.requeue(job, '重新排队');
  }

  fix(id: string) {
    const job = this.store.jobs.get(id);
    if (!job || !job.fail) throw new HttpError(404, '没有需要修复的失败任务');
    const model = this.core.modelById(job.model);
    if (!model) throw new HttpError(400, '模型不存在', '到「设置」里刷新模型列表');
    const log = applyFix(job, model);
    job.fixLog = log;
    job.fixed = true;
    this.requeue(job, '按建议修复后重新排队');
    return { job, log };
  }

  /* ---------------- 调度 ---------------- */

  /** 排队提示：每个渠道各排各的。排在第一位时保留「重新排队」这类说明 */
  private refreshNotes() {
    const queued = this.store.jobs
      .all()
      .filter((j) => j.status === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt);
    const byChannel = new Map<string, number>();
    for (const j of queued) {
      const ch = this.core.modelById(j.model)?.channel || 'mock';
      const idx = byChannel.get(ch) || 0;
      byChannel.set(ch, idx + 1);
      const custom = j.queueNote && !/^前面 \d+ 个任务$/.test(j.queueNote);
      const note = idx === 0 ? (custom ? j.queueNote : '即将开始') : `前面 ${idx} 个任务`;
      if (j.queueNote !== note) {
        j.queueNote = note;
        this.save(j);
      }
    }
  }

  pump() {
    const all = this.store.jobs.all();
    const queued = all.filter((j) => j.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);
    if (!queued.length) return;
    for (const provider of this.core.providers()) {
      const runningHere = [...this.running.keys()].filter((id) => {
        const j = this.store.jobs.get(id);
        const m = j && this.core.modelById(j.model);
        return m && this.core.providerOf(m) === provider;
      }).length;
      let room = provider.concurrency() - runningHere;
      for (const job of queued) {
        if (room <= 0) break;
        if (this.running.has(job.id)) continue;
        const model = this.core.modelById(job.model);
        if (!model) {
          this.failJob(job, new ProviderError('E-MOD-04', '模型不存在或已下架', '到「设置」里刷新模型列表后换一个模型重试'));
          continue;
        }
        if (this.core.providerOf(model) !== provider) continue;
        room -= 1;
        void this.exec(job, model, false);
      }
    }
    this.refreshNotes();
  }

  private ctxFor(job: Job, ac: AbortController): RunContext {
    let lastEmit = 0;
    return {
      signal: ac.signal,
      progress: (p, eta) => {
        if (job.status !== 'running') return;
        job.progress = Math.round(p);
        if (eta) job.eta = eta;
        const now = Date.now();
        if (now - lastEmit > 250 || p >= 100) {
          lastEmit = now;
          this.core.events.emit({ type: 'job', job });
        }
      },
      save: (buf, mime) => this.core.saveMedia(buf, mime),
      resolveRef: (src) => this.core.resolveRef(src),
      setUpstream: (taskId, requestId) => {
        if (taskId) job.upstreamTaskId = taskId;
        if (requestId) job.requestId = requestId;
        this.save(job);
      },
    };
  }

  private async exec(job: Job, model: ModelInfo, resume: boolean) {
    const ac = new AbortController();
    this.running.set(job.id, ac);
    job.status = 'running';
    job.progress = resume ? job.progress || 4 : 4;
    job.startedAt = resume ? job.startedAt || Date.now() : Date.now();
    job.eta = '生成中…';
    delete job.queueNote;
    this.save(job);
    if (!resume) this.core.events.notice('info', '开始生成', `${job.name} · ${model.name}`);
    const provider = this.core.providerOf(model);
    try {
      const ctx = this.ctxFor(job, ac);
      const outs = resume && provider.resume ? await provider.resume(job, model, ctx) : await provider.run(job, model, ctx);
      if (job.status !== 'running') return;
      this.finish(job, outs);
    } catch (e) {
      if (ac.signal.aborted || job.status !== 'running') return;
      this.failJob(job, e);
    } finally {
      this.running.delete(job.id);
      setTimeout(() => this.pump(), 0);
    }
  }

  private failJob(job: Job, e: unknown) {
    const fail =
      e instanceof ProviderError
        ? e.toFail()
        : { code: 'E-UPS-50', reason: `生成失败：${(e as Error)?.message || String(e)}`, fix: '稍后重试' };
    job.status = 'failed';
    job.fail = fail;
    delete job.eta;
    delete job.queueNote;
    job.finishedAt = Date.now();
    const w = this.store.wallet;
    const p = this.project(job.ws);
    const refunded = refundJob(w, job, p);
    this.store.wallet = w;
    this.persistProject(p);
    this.save(job);
    this.saveWallet();
    this.core.events.notice('warn', '生成失败', `${job.name} · ${fail.reason}${refunded ? `，已退回 ${job.cost} 点` : ''}`);
  }

  /** 新一批来了：上一批还在收件箱、没被拖进画布的，自动沉入草稿箱 */
  settleInbox(ws: string) {
    let n = 0;
    for (const r of this.store.results.all()) {
      if (r.home === 'inbox' && r.ws === ws) {
        r.home = 'draft';
        this.store.results.put(r);
        this.core.events.emit({ type: 'result', result: r });
        n += 1;
      }
    }
    return n;
  }

  private finish(job: Job, outs: ProviderOutput[]) {
    const settled = this.settleInbox(job.ws);
    const now = Date.now();
    const titleBase = job.divergeAxis
      ? `发散 · ${job.divergeAxis}`
      : job.platform
        ? `适配 · ${job.platform}`
        : job.prompt.replace(/\s+/g, ' ').slice(0, 14);
    const tags = resultTags(job);
    const results: Result[] = outs.map((o, i) => ({
      id: uid('r'),
      job: job.id,
      type: job.type,
      ws: job.ws,
      title: o.title || `${titleBase}${outs.length > 1 ? ` #${i + 1}` : ''}`,
      src: o.src,
      thumb: o.thumb,
      mime: o.mime,
      simulated: o.simulated,
      ratio: job.ratio || '1:1',
      model: job.model,
      seed: o.seed ?? 40000 + Math.floor(Math.random() * 50000),
      createdAt: now + i,
      status: 'new',
      tags: job.divergeAxis ? [job.divergeAxis, ...tags].slice(0, 3) : tags,
      dur: job.type === 'image' ? 0 : o.dur ?? job.dur ?? 5,
      cam: job.cam,
      home: 'inbox',
      isNew: true,
    }));
    for (const r of results) {
      this.store.results.put(r);
      this.core.events.emit({ type: 'result', result: r });
    }
    job.status = 'succeeded';
    job.progress = 100;
    delete job.eta;
    job.finishedAt = now;
    job.durText = durationText(now - (job.startedAt || now));
    job.results = results.map((r) => r.id);
    this.save(job);
    if (job.source === 'api') {
      const usage = { id: uid('u'), at: now, model: job.model, n: results.length, pts: job.cost, keyId: job.keyId || '' };
      this.store.apiUsage.put(usage);
      this.core.events.emit({
        type: 'api',
        apiKeys: this.store.apiKeys.all().map(({ hash: _h, ...k }) => k),
        apiUsage: this.store.apiUsage.all().sort((a, b) => b.at - a.at).slice(0, 200),
      });
    }
    this.core.events.notice(
      'success',
      '生成完成',
      `${job.name} · 产出 ${results.length} 项，已送到画布顶部${settled ? `；上一批 ${settled} 项未取用，已进草稿箱` : ''}`,
    );
  }

  /* ---------------- 重启恢复 ---------------- */

  private recover() {
    for (const job of this.store.jobs.all()) {
      if (job.status !== 'running') continue;
      const model = this.core.modelById(job.model);
      if (!model) {
        this.failJob(job, new ProviderError('E-MOD-04', '模型不存在或已下架', '到「设置」里刷新模型列表后换一个模型重试'));
        continue;
      }
      if (model.channel === 'mock') {
        /* 演示渠道：重新排队，已扣的费用保留，不会重复扣 */
        job.status = 'queued';
        job.progress = 0;
        job.queueNote = '应用重启后重新排队';
        this.save(job);
      } else if (job.type === 'video' && job.upstreamTaskId) {
        void this.exec(job, model, true);
      } else {
        this.failJob(job, new ProviderError('E-NET-03', '应用退出时请求还没完成，结果未知', '为避免重复计费不会自动重试；可到 TreeCloud 控制台核对后手动重试'));
      }
    }
  }
}

function autoName(type: Job['type'], prompt: string, count?: number, dur?: number) {
  const head = prompt.replace(/\s+/g, ' ').slice(0, 14) || `${TYPES[type].name}生成`;
  return `${head} · ${type === 'image' ? `${count || 1} 张` : `${dur || 5}s`}`;
}
