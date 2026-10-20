import { expect, test, type Page } from '@playwright/test';

/* 端到端：Web 模式 + 演示渠道。覆盖产出流转、失败修复、画布核心操作、持久化与成帖 */

const errors: string[] = [];

async function open(page: Page) {
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.composer-card')).toBeVisible();
}

test.afterEach(() => {
  expect(errors, `页面错误：${errors.join('\n')}`).toEqual([]);
});

test('生成 → 收件箱 → 放进画布 → 保存到素材库', async ({ page }) => {
  await open(page);
  await page.locator('.opt-pill', { hasText: '2 张' }).click();
  await page.locator('.gen-btn').click();
  const cards = page.locator('.cvs-inbox-card');
  await expect(cards).toHaveCount(2, { timeout: 30_000 });

  const before = await page.locator('#cvsWorld .cvs-el').count();
  await cards.first().locator('.cvs-inbox-add').click();
  await expect(page.locator('#cvsWorld .cvs-el')).toHaveCount(before + 1);
  await expect(cards).toHaveCount(1);

  /* 新放进来的元素在最后：选中后保存到素材库 */
  await page.locator('#cvsWorld .cvs-el.cvs-media').last().click();
  await page.locator('.cvs-foot .btn', { hasText: '保存到素材库' }).click();
  await expect(page.locator('#cvsWorld .cvs-el.cvs-media.saved')).not.toHaveCount(0);

  /* 下一批生成时，上一批没取用的沉入草稿箱 */
  await page.locator('.gen-btn').click();
  await expect(page.locator('.toast', { hasText: '已进草稿箱' })).toBeVisible({ timeout: 30_000 });
  await page.locator('.side-item', { hasText: '素材库' }).click();
  await page.locator('.lib-tabs button', { hasText: '草稿箱' }).click();
  await expect(page.locator('.result-card.draft')).not.toHaveCount(0);
});

test('失败任务按建议修复并重新计价', async ({ page }) => {
  await open(page);
  await page.locator('.opt-pill', { hasText: '4K' }).click();
  await page.locator('.gen-btn').click();
  await expect(page.locator('.toast', { hasText: '任务未通过参数校验' })).toBeVisible();
  await page.locator('.todo-chip.danger').click();
  const row = page.locator('.queue-row', { hasText: '4 张' }).first();
  await row.locator('.btn', { hasText: '修复' }).click();
  await expect(page.locator('.toast', { hasText: '4K → 2K' })).toBeVisible();
});

test('画布：框选、右键对齐、连线、撤销，刷新后仍在', async ({ page }) => {
  await open(page);
  const vp = page.locator('#cvsViewport');
  const box = (await vp.boundingBox())!;
  await page.keyboard.press('f');

  /* 空白处拖出选框，框住全部元素 */
  await page.mouse.move(box.x + 6, box.y + 6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 6, box.y + box.height - 6, { steps: 8 });
  await page.mouse.up();
  const n = await page.locator('#cvsWorld .cvs-el').count();
  await expect(page.locator('#cvsWorld .cvs-el.sel')).toHaveCount(n);

  /* 选两个连起来 */
  const els = page.locator('#cvsWorld .cvs-el.cvs-media');
  await els.nth(0).click();
  await els.nth(1).click({ modifiers: ['Shift'] });
  await els.nth(1).click({ button: 'right' });
  await page.locator('.cvs-menu-item', { hasText: '把这两个连起来' }).click();
  await expect(page.locator('#cvsLinks path.cvs-link')).toHaveCount(1);

  /* 全选后右键顶对齐 */
  await page.keyboard.press('ControlOrMeta+a');
  await page.locator('#cvsWorld .cvs-el.sel').first().click({ button: 'right' });
  await page.locator('.cvs-menu-item', { hasText: '顶对齐' }).click();
  await expect(page.locator('.toast', { hasText: '已对齐' })).toBeVisible();

  /* 撤销两步（先撤对齐、再撤连线），再重做一步 */
  await page.mouse.click(box.x + box.width - 20, box.y + box.height - 20);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('#cvsLinks path.cvs-link')).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('#cvsLinks path.cvs-link')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(page.locator('#cvsLinks path.cvs-link')).toHaveCount(1);

  /* 新建文字并写字 */
  await page.mouse.click(box.x + box.width - 30, box.y + box.height - 30, { button: 'right' });
  await page.locator('.cvs-menu-item', { hasText: '新建文字' }).click();
  await page.keyboard.type('主视觉走暖橙');
  await page.mouse.click(box.x + 20, box.y + box.height - 20);
  await expect(page.locator('.cvs-text-body', { hasText: '主视觉走暖橙' })).toBeVisible();

  /* 画板持久化：等防抖写回后刷新 */
  await page.waitForTimeout(800);
  await page.reload();
  await expect(page.locator('.composer-card')).toBeVisible();
  await expect(page.locator('#cvsLinks path.cvs-link')).toHaveCount(1);
  await expect(page.locator('.cvs-text-body', { hasText: '主视觉走暖橙' })).toBeVisible();

  /* Agent 读到文字与连线 */
  await page.locator('.agent-fab').click();
  await expect(page.locator('.agent-panel')).toContainText('主视觉走暖橙');
  await expect(page.locator('.agent-panel')).toContainText('条连线');
});

test('素材库打包成帖并导出 Markdown', async ({ page }) => {
  await open(page);
  await page.locator('.side-item', { hasText: '素材库' }).click();
  const picks = page.locator('.result-card .rc-pick');
  await expect(picks).not.toHaveCount(0);
  await page.locator('.fchip', { hasText: '全部项目' }).click();
  await picks.nth(0).click();
  await picks.nth(1).click();
  await page.locator('.btn', { hasText: '打包成帖' }).click();
  await expect(page.locator('.drawer-title', { hasText: '帖子草稿' })).toBeVisible();
  await page.locator('.post-body').fill('今天上新两款春季饮品。');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('.drawer-foot .btn', { hasText: '导出 Markdown' }).click()]);
  expect(dl.suggestedFilename()).toMatch(/\.md$/);
  await page.locator('.drawer-foot .btn', { hasText: '保存' }).first().click();
  await expect(page.locator('.post-card')).toHaveCount(1);
});

test('设置页：未填 Key 时不能切到 TreeCloud', async ({ page }) => {
  await open(page);
  await page.locator('.side-item', { hasText: '设置' }).click();
  await page.locator('.set-choice', { hasText: 'TreeCloud' }).click();
  await expect(page.locator('.toast', { hasText: '先填入 TreeCloud API Key' })).toBeVisible();
  await expect(page.locator('.set-choice.on', { hasText: '演示渠道' })).toBeVisible();
});
