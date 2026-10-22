import type { Store } from './store';

/* ============================================================================
   首次启动：保持干净。只建一个空项目，没有任何示例任务 / 产出 / 画板内容。
   用户的第一个项目、第一条产出，都应该是他自己做出来的。
   ========================================================================== */

export function seedClean(store: Store, now = Date.now()) {
  if (store.projects.size) return;
  store.projects.put({ id: 'w1', name: '我的第一个项目', dot: '#F97316', used: 0, createdAt: now });
}
