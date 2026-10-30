import { expect, test, type Page } from '@playwright/test';

/* 端到端：Web 模式 + Mock 云。覆盖 首启干净 → 登录 → 充值 → 生成 → 收件箱 → 画布 → 素材库 → 成帖
 * 用例按顺序共享同一份服务端数据（登录态、余额、产出），所以前面的用例是后面用例的前置。 */

const errors: string[] = [];

async function open(page: Page) {
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('.composer-card')).toBeVisible();
}

/** 已登录就什么都不做；否则走一遍设备码登录（第二标签页在 Mock 云确认） */
/** 点遮罩关掉抽屉（不同抽屉页脚按钮不一样，遮罩是通用的） */
async function closeDrawer(page: Page) {
  await page.locator('.overlay').click({ position: { x: 8, y: 8 } });
  await expect(page.locator('.overlay')).toHaveCount(0);
}

async function ensureLogin(page: Page) {
  if (await page.locator('.balance-chip:not(.login)').count()) return;
  await page.locator('.balance-chip.login').click();
  await page.locator('.btn', { hasText: '开始登录' }).click();
  const href = await page.locator('.login-steps a').getAttribute('href');
  expect(href).toContain('/login?code=');
  const tab = await page.context().newPage();
  await tab.goto(href!);
  await tab.locator('input[name=phone]').fill('13800001111');
  await tab.locator('button', { hasText: '确认登录' }).click();
  await expect(tab.locator('h1', { hasText: '登录成功' })).toBeVisible();
  await tab.close();
  await expect(page.locator('.balance-chip:not(.login)')).toBeVisible({ timeout: 15_000 });
  await closeDrawer(page);
}

async function topup(page: Page, channel: '微信支付' | '支付宝' = '微信支付') {
  await page.locator('.balance-chip').click();
  await page.locator('.mini-tabs button', { hasText: channel }).click();
  await page.locator('.pack-card').first().click();
  await expect(page.locator('.pay-qr canvas, .pay-qr img').first()).toBeVisible();
  /* 轮询会刷新订单；二维码不能因为一次订单查询就变空白 */
  await page.waitForTimeout(2_600);
  await expect(page.locator('.pay-qr canvas, .pay-qr img').first()).toBeVisible();
  const href = await page.locator('.pay-tip a', { hasText: '打开收银台' }).getAttribute('href');
  const tab = await page.context().newPage();
  await tab.goto(href!);
  await tab.locator('button', { hasText: '模拟扫码支付' }).click();
  await expect(tab.locator('h1', { hasText: '支付成功' })).toBeVisible();
  await tab.close();
  await expect(page.locator('.pay-panel')).toHaveCount(0, { timeout: 15_000 });
  await closeDrawer(page);
}

async function generate(page: Page, count: '1 张' | '2 张' = '2 张') {
  await page.locator('.opt-pill', { hasText: count }).click();
  await page.locator('.composer-card textarea').first().fill('一杯放在窗边的热咖啡，晨光');
  await page.locator('.gen-btn').click();
}

test.afterEach(() => {
  expect(errors, `页面错误：${errors.join('\n')}`).toEqual([]);
});

test('首启是干净的：没有示例数据，生成入口引导登录', async ({ page }) => {
  await open(page);
  await expect(page.locator('#cvsWorld .cvs-el')).toHaveCount(0);
  await page.locator('.side-item', { hasText: '素材库' }).click();
  await expect(page.locator('.result-card')).toHaveCount(0);
  await page.locator('.side-item', { hasText: '创作' }).first().click();
  await expect(page.locator('.gen-btn', { hasText: '登录后生成' })).toBeVisible();
});

test('登录 → 支付宝扫码充值 → 余额到账', async ({ page }) => {
  await open(page);
  await ensureLogin(page);
  await expect(page.locator('.gen-btn', { hasText: '登录后生成' })).toHaveCount(0);
  await topup(page, '支付宝');
  /* 余额芯片显示数字（登录赠送 1 点 + 首充档位） */
  await expect(page.locator('.balance-chip:not(.login)')).toContainText(/\d/);
  /* 订单记录里能看到这一笔 */
  await page.locator('.balance-chip').click();
  await expect(page.locator('.drawer-body', { hasText: '支付宝' })).toBeVisible();
  await closeDrawer(page);
});

test('生成 → 收件箱 → 放进画布 → 保存到素材库', async ({ page }) => {
  await open(page);
  await ensureLogin(page);
  await generate(page, '2 张');
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

test('画布：框选、右键对齐、连线、撤销，刷新后仍在', async ({ page }) => {
  await open(page);
  await ensureLogin(page);

  /* 没有种子数据：先生成两张并都放进画布 */
  await generate(page, '2 张');
  const cards = page.locator('.cvs-inbox-card');
  await expect(cards.first()).toBeVisible({ timeout: 30_000 });
  while (await cards.count()) {
    await cards.first().locator('.cvs-inbox-add').click();
  }

  const vp = page.locator('#cvsViewport');
  const box = (await vp.boundingBox())!;
  await page.keyboard.press('f');

  /* 空白处拖出选框，框住全部元素 */
  await page.mouse.move(box.x + 6, box.y + 6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 6, box.y + box.height - 6, { steps: 8 });
  await page.mouse.up();
  const n = await page.locator('#cvsWorld .cvs-el').count();
  expect(n).toBeGreaterThanOrEqual(2);
  await expect(page.locator('#cvsWorld .cvs-el.sel')).toHaveCount(n);

  /* 生成的图本来排成一行、顶部已对齐：先把第二张拖下去，后面的对齐才是一次真实改动 */
  const els = page.locator('#cvsWorld .cvs-el.cvs-media');
  await els.nth(1).click(); // 先单选：框选后全部处于选中状态，直接拖会整体平移
  const b1 = (await els.nth(1).boundingBox())!;
  await page.mouse.move(b1.x + b1.width / 2, b1.y + b1.height / 2);
  await page.mouse.down();
  await page.mouse.move(b1.x + b1.width / 2, b1.y + b1.height / 2 + 70, { steps: 6 });
  await page.mouse.up();

  /* 选两个连起来 */
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
  await ensureLogin(page);

  /* 前面的用例只存了一张：再生成一批，全部放进画布并保存，保证素材库至少两项 */
  await generate(page, '2 张');
  const cards = page.locator('.cvs-inbox-card');
  await expect(cards.first()).toBeVisible({ timeout: 30_000 });
  while (await cards.count()) {
    await cards.first().locator('.cvs-inbox-add').click();
  }
  await page.keyboard.press('ControlOrMeta+a');
  await page.locator('.cvs-foot .btn', { hasText: '保存到素材库' }).click();
  await expect(page.locator('.cvs-foot .btn', { hasText: '保存到素材库' })).toHaveCount(0);

  await page.locator('.side-item', { hasText: '素材库' }).click();
  const picks = page.locator('.result-card .rc-pick');
  await expect(picks.nth(1)).toBeVisible();
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

test('模型与价格：自定义渠道搬到这里，设置页不再有直连', async ({ page }) => {
  await open(page);
  await page.locator('.side-item', { hasText: '模型与价格' }).click();
  await expect(page.locator('.page-title')).toHaveText('模型与价格');
  await expect(page.locator('.catalog-sec-name', { hasText: '渠道' })).toBeVisible();
  const card = page.locator('.set-choice', { hasText: '自定义渠道' });
  await expect(card).toContainText('未配置');
  /* 没有单独的开关：填好 Base URL 与 Key 保存即自动启用 */
  await expect(page.locator('.set-choice', { hasText: '启用直连' })).toHaveCount(0);
  await expect(page.locator('.set-card .form-label', { hasText: 'API Key' })).toBeVisible();
  await page.locator('.side-item', { hasText: '设置' }).click();
  await expect(page.locator('.catalog-sec-name', { hasText: '直连' })).toHaveCount(0);
});

test('导航：API 接入不再展示本地密钥，设置页改叫「账号」', async ({ page }) => {
  await open(page);
  await page.locator('.side-item', { hasText: 'API 接入' }).click();
  await expect(page.locator('.page-title')).toHaveText('API 接入');
  await expect(page.locator('.catalog-sec-name', { hasText: '密钥' })).toHaveCount(0);
  await expect(page.locator('.catalog-sec-name', { hasText: '快速开始' })).toHaveCount(0);
  await page.locator('.side-item', { hasText: '设置' }).click();
  await expect(page.locator('.catalog-sec-name').first()).toHaveText('账号');
  await expect(page.locator('.snap-row', { hasText: '账号服务' })).toHaveCount(0);
  await expect(page.locator('.snap-row', { hasText: '接口根' })).toHaveCount(0);
});
