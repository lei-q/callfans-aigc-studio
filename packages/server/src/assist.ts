import type { AgentEnhanceBody, AgentEnhanceReply, MediaType, OptimizeReply } from '@aigc/shared';
import { EXPAND_THRESHOLD, PROMPT_OPTIMIZE, TYPES } from '@aigc/shared';
import type { Core } from './core';
import type { ChatMessage } from './providers/types';

/* ============================================================================
   提示词辅助：配置了 TreeCloud 对话模型就用 LLM，否则走原型里的规则。
   LLM 失败时静默回退规则，不让「帮我写详细」这一步卡住。
   ========================================================================== */

export function ruleOptimize(type: MediaType, prompt: string): OptimizeReply {
  const cur = prompt.trim();
  const cfg = PROMPT_OPTIMIZE[type];
  if (cur.length < EXPAND_THRESHOLD) {
    return { mode: 'expand', result: `${cur}。${cfg.expand}`, add: '', neg: cfg.neg, note: cfg.note, llm: false };
  }
  return { mode: 'add', result: '', add: cfg.add, neg: cfg.neg, note: cfg.note, llm: false };
}

function chatModel(core: Core) {
  const s = core.store.settings;
  if (!s.chat.enabled || !s.chat.model) return null;
  if (!core.treecloud.channel().ready) return null;
  return s.chat.model;
}

/** 从模型回复里抠出第一个 JSON 对象 */
export function extractJson<T>(text: string): T | null {
  const m = /\{[\s\S]*\}/.exec(text.replace(/```json|```/g, ''));
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as T;
  } catch {
    return null;
  }
}

async function ask(core: Core, model: string, messages: ChatMessage[]) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 45_000);
  try {
    return await core.treecloud.chat(model, messages, ac.signal);
  } finally {
    clearTimeout(t);
  }
}

export async function optimizePrompt(core: Core, type: MediaType, prompt: string): Promise<OptimizeReply> {
  const fallback = ruleOptimize(type, prompt);
  const model = chatModel(core);
  if (!model) return fallback;
  const kind = TYPES[type].name;
  const expand = fallback.mode === 'expand';
  const sys =
    `你是 AIGC ${kind}提示词助手，服务社媒运营。用户只会写一句大白话。` +
    (expand
      ? `把它扩写成一条完整、可直接用于${kind}生成的中文提示词：保留用户原话在最前，补充主体、场景、光线、材质、构图${type === 'video' ? '、运镜与节奏' : type === 'audio' ? '、语气、语速与混音要求' : ''}，不超过 120 字。`
      : '用户的描述已经够长，不要改写原话，只给出一段可以追加在末尾的补充细节（不超过 50 字）。') +
    '同时给出通用负面词（逗号分隔）和一句话说明为什么这样补。' +
    (expand
      ? '只输出 JSON：{"result":"完整提示词","neg":"负面词","note":"说明"}'
      : '只输出 JSON：{"add":"追加内容","neg":"负面词","note":"说明"}');
  try {
    const text = await ask(core, model, [
      { role: 'system', content: sys },
      { role: 'user', content: prompt.trim() },
    ]);
    const j = extractJson<{ result?: string; add?: string; neg?: string; note?: string }>(text);
    if (!j) return fallback;
    if (expand && j.result?.trim()) {
      return { ...fallback, result: j.result.trim(), neg: j.neg?.trim() || fallback.neg, note: j.note?.trim() || fallback.note, llm: true };
    }
    if (!expand && j.add?.trim()) {
      return { ...fallback, add: j.add.trim().replace(/^[。，,]/, ''), neg: j.neg?.trim() || fallback.neg, note: j.note?.trim() || fallback.note, llm: true };
    }
  } catch {
    /* 回退规则 */
  }
  return fallback;
}

export async function enhanceAgent(core: Core, body: AgentEnhanceBody): Promise<AgentEnhanceReply | null> {
  const model = chatModel(core);
  if (!model) return null;
  const kind = TYPES[body.mainType].name;
  const sys =
    '你是社媒运营的创意 Agent。下面是用户画板选区里的真实信息：元素构成、产出的原始提示词、用户亲手写的文字（优先级最高）。' +
    `请据此用一两句话说出「用户在做什么、想要什么方向」，并写一条可直接用于${kind}生成的中文提示词（不超过 120 字，用户写的文字要体现进去）。` +
    '不要编造画板上没有的信息。只输出 JSON：{"understanding":"需求理解","draft":"建议提示词"}';
  const user = [
    `画板信息：${body.facts.join('；') || '无'}`,
    `原始提示词：${body.prompts.slice(0, 8).join(' / ') || '无'}`,
    `用户写的字：${body.nodeTexts.join(' / ') || '无'}`,
    `规则推断的草稿：${body.draft || '无'}`,
  ].join('\n');
  try {
    const text = await ask(core, model, [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ]);
    const j = extractJson<AgentEnhanceReply>(text);
    if (j && j.draft) return { understanding: (j.understanding || '').trim(), draft: j.draft.trim() };
  } catch {
    /* 回退规则 */
  }
  return null;
}
