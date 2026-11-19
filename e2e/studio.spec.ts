import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  /* 首屏不预填示例提示词 */
  await expect(page.locator('.composer-card .prompt-input')).toHaveValue('');
  /* 未登录时三种创作都要提示登录或切自定义渠道，而不是只提示音频 */
  for (const label of ['图像创作', '视频创作', '音频创作']) {
    await page.locator('.side-item', { hasText: label }).click();
    const note = page.locator('.composer-card .channel-note');
    await expect(note).toContainText('登录后才能用平台点数生成');
    await expect(note.locator('.btn', { hasText: '去登录' })).toBeVisible();
  }
  await page.locator('.side-item', { hasText: '素材库' }).click();
  await expect(page.locator('.result-card')).toHaveCount(0);
  await page.locator('.side-item', { hasText: '创作' }).first().click();
  await expect(page.locator('.gen-btn', { hasText: '登录后生成' })).toBeVisible();
});

test('登录 → 支付宝扫码充值 → 余额到账', async ({ page }) => {
  await open(page);
  await ensureLogin(page);
  /* 余额每 10 秒自动向账号服务查一次 */
  const refresh = await page.waitForResponse((r) => r.url().endsWith('/api/billing/wallet/refresh') && r.request().method() === 'POST', { timeout: 16_000 });
  expect(refresh.ok()).toBeTruthy();
  await expect(page.locator('.gen-btn', { hasText: '登录后生成' })).toHaveCount(0);
  await topup(page, '支付宝');
  /* 余额芯片显示数字（登录赠送 1 点 + 首充档位） */
  await expect(page.locator('.balance-chip:not(.login)')).toContainText(/\d/);
  /* 订单记录里能看到这一笔 */
  await page.locator('.balance-chip').click();
  await expect(page.locator('.drawer-body', { hasText: '支付宝' })).toBeVisible();
  await closeDrawer(page);
});

test('充值：自定义金额可以是任意正整数', async ({ page }) => {
  await open(page);
  await ensureLogin(page);
  await page.locator('.balance-chip').click();
  await page.locator('.pack-custom input').fill('37');
  await page.locator('.pack-custom .btn').click();
  await expect(page.locator('.pay-panel')).toBeVisible();
  await expect(page.locator('.pay-panel')).toContainText('到账 37 点');
  await expect(page.locator('.pay-panel')).toContainText('¥37.00');
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

test('任务记录：产出可以直接放回画布（未取用的 / 已沉入草稿箱的都行）', async ({ page }) => {
  await open(page);
  await ensureLogin(page);
  await generate(page, '2 张');
  await expect(page.locator('.cvs-inbox-card')).toHaveCount(2, { timeout: 30_000 });
  const before = await page.locator('#cvsWorld .cvs-el').count();

  await page.locator('.side-item', { hasText: '任务记录' }).click();
  const row = page.locator('.jobs-table .t-row').first();
  await row.click();
  await expect(row).toHaveClass(/open/);
  await page.locator('.sub-toolbar button', { hasText: '全部放进画布' }).first().click();

  /* 回到工作台，两张都在画布上 */
  await expect(page.locator('#cvsWorld .cvs-el')).toHaveCount(before + 2);
});

test('音频创作：配音模型能选到，音乐 / 音效没有模型时给出明确提示', async ({ page }) => {
  await open(page);
  await ensureLogin(page);
  await page.locator('.side-item', { hasText: '音频创作' }).click();
  /* 平台配音模型必须出现在模型下拉里，而不是「当前账号下没有可用的音频模型」 */
  await expect(page.locator('.composer-card .form-select').first()).toContainText('TTS');
  await expect(page.locator('.composer-card .channel-note')).toHaveCount(0);
  /* 平台没有音乐模型：切换用途后给提示，不能静默失败 */
  await page.locator('.composer-card .opt-pill', { hasText: '音乐' }).click();
  await expect(page.locator('.composer-card .channel-note')).toContainText('没有可用的音频模型');
  await page.locator('.side-item', { hasText: '图像创作' }).click();
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

  /* 空白处直接拖是平移画布，不会选中任何元素 */
  await page.mouse.move(box.x + 6, box.y + 6);
  await page.mouse.down();
  await page.mouse.move(box.x + 30, box.y + 30, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator('#cvsWorld .cvs-el.sel')).toHaveCount(0);
  await page.keyboard.press('f');

  /* 按住 Alt（Windows）/ Command（Mac）在空白处拖出选框，框住全部元素 */
  const mod = process.platform === 'darwin' ? 'Meta' : 'Alt';
  await page.mouse.move(box.x + 6, box.y + 6);
  await page.keyboard.down(mod);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 6, box.y + box.height - 6, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up(mod);
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

test('素材库：批量下载；打包成帖、写配文、手机预览、导出 zip', async ({ page }) => {
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
  /* 批量下载：选中的产出打成一个 zip */
  const [zipDl] = await Promise.all([page.waitForEvent('download'), page.locator('.lib-pack-bar .btn', { hasText: '批量下载' }).click()]);
  expect(zipDl.suggestedFilename()).toMatch(/\.zip$/);
  const zipPath = await zipDl.path();
  const head = fs.readFileSync(zipPath!).subarray(0, 4).toString('hex');
  expect(head).toBe('504b0304');
  await page.locator('.btn', { hasText: '打包成帖' }).click();
  await expect(page.locator('.drawer-title', { hasText: '帖子草稿' })).toBeVisible();
  await page.locator('.post-body').fill('今天上新两款春季饮品。');
  /* 每图配文、手机预览 */
  await page.locator('.post-cap input').nth(1).fill('窗边的第一杯');
  await page.locator('.btn', { hasText: '手机预览' }).click();
  await expect(page.locator('.phone')).toContainText('今天上新两款春季饮品。');
  await expect(page.locator('.phone')).toContainText('窗边的第一杯');
  /* 设为封面：第二张的按钮点了，顺序里它排到第一 */
  await page.locator('.post-cap .btn', { hasText: '设为封面' }).first().click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('.drawer-foot .btn', { hasText: '导出 zip' }).click()]);
  expect(dl.suggestedFilename()).toMatch(/\.zip$/);
  await page.locator('.drawer-foot .btn', { hasText: '保存' }).first().click();
  await expect(page.locator('.post-card')).toHaveCount(1);
});

test('任务记录：打开不报错，能展开任务', async ({ page }) => {
  await open(page);
  await ensureLogin(page);
  await page.locator('.side-item', { hasText: '任务记录' }).click();
  await expect(page.locator('.page-title')).toHaveText('任务记录');
  const row = page.locator('.jobs-table .t-row').first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(row).toHaveClass(/open/);
});

test('失败任务：可以手动从任务记录移除', async ({ page }) => {
  await open(page);
  await ensureLogin(page);
  /* 参数超限会在本地直接记一条失败任务，不提交云端 */
  const created = await page.evaluate(async () => {
    const b = (await (await fetch('/api/bootstrap')).json()) as { projects: { id: string }[] };
    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aigc-client': '1' },
      body: JSON.stringify({ jobs: [{ type: 'image', ws: b.projects[0].id, model: 'cloud:g-img-1', prompt: '移除测试用失败任务', refs: [], ratio: '1:1', count: 1, res: '4k' }] }),
    });
    return (await res.json()) as { jobs: { status: string }[] };
  });
  expect(created.jobs[0].status).toBe('failed');

  await page.locator('.side-item', { hasText: '任务记录' }).click();
  const row = page.locator('.jobs-table .t-row', { hasText: '移除测试用失败任务' });
  await expect(row).toBeVisible();
  await row.locator('button', { hasText: '移除' }).click();
  await row.locator('button', { hasText: '再点一次移除' }).click();
  await expect(page.locator('.jobs-table .t-row', { hasText: '移除测试用失败任务' })).toHaveCount(0);
});

test('模型与价格：只保留平台渠道，不显示自定义渠道与密钥输入', async ({ page }) => {
  await open(page);
  await page.locator('.side-item', { hasText: '模型与价格' }).click();
  await expect(page.locator('.page-title')).toHaveText('模型与价格');
  await expect(page.locator('.catalog-sec-name', { hasText: '渠道' })).toBeVisible();
  const plat = page.locator('.set-choice', { hasText: '平台渠道' });
  await expect(plat).toBeVisible();
  await expect(plat).toContainText('使用中');
  /* 自定义渠道与 Base URL / API Key 输入都已隐藏 */
  await expect(page.locator('.set-choice', { hasText: '自定义渠道' })).toHaveCount(0);
  await expect(page.locator('.set-card .form-label', { hasText: 'API Key' })).toHaveCount(0);
  await expect(page.locator('.set-card .form-label', { hasText: 'Base URL' })).toHaveCount(0);
  /* 图像 / 视频 / 音频模型都在 */
  await expect(page.locator('.catalog-sec-name', { hasText: '图像模型' })).toBeVisible();
  await expect(page.locator('.catalog-sec-name', { hasText: '音频模型' })).toBeVisible();
  await expect(page.locator('.catalog-sec-name', { hasText: '文本模型' })).toBeVisible();
  await page.locator('.side-item', { hasText: '设置' }).click();
  await expect(page.locator('.catalog-sec-name', { hasText: '直连' })).toHaveCount(0);
});

test('导航：API 接入是独立入口，设置页改叫「账号」', async ({ page }) => {
  await open(page);
  await expect(page.locator('.side-item', { hasText: 'API 接入' })).toHaveCount(1);
  await page.locator('.side-item', { hasText: '模型与价格' }).click();
  await expect(page.locator('.page-title')).toHaveText('模型与价格');
  await expect(page.locator('.catalog-sec-name', { hasText: '用量与账单' })).toBeVisible();
  /* 模型价格长表放在页面最下方 */
  const secs = await page.locator('.catalog-sec-name').allTextContents();
  expect(secs[secs.length - 1]).toBe('模型价格');
  await page.locator('.side-item', { hasText: '设置' }).click();
  await expect(page.locator('.catalog-sec-name').first()).toHaveText('账号');
  await expect(page.locator('.catalog-sec-name', { hasText: '并发数' })).toBeVisible();
  /* 预估单价只影响本地展示，没有实际扣费作用，已移除 */
  await expect(page.locator('.catalog-sec-name', { hasText: '预估单价' })).toHaveCount(0);
  await expect(page.locator('.snap-row', { hasText: '账号服务' })).toHaveCount(0);
  await expect(page.locator('.snap-row', { hasText: '接口根' })).toHaveCount(0);
});

test('画布：本地图片裁切成多个比例、本地视频取帧，成品摆在下面并连回原图', async ({ page }) => {
  const { execFileSync, spawnSync } = await import('node:child_process');
  test.skip(spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0, '本机没有 ffmpeg');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-e2e-media-'));
  const png = path.join(dir, 'photo.png');
  const mp4 = path.join(dir, 'clip.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=800x600:rate=1', '-frames:v', '1', png]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=3', '-pix_fmt', 'yuv420p', mp4]);

  await open(page);
  const vp = page.locator('#cvsViewport');
  const box = (await vp.boundingBox())!;
  /* 前面的用例在画布上留了东西：先清空，右键才落在空白处 */
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  const before = await page.locator('#cvsWorld .cvs-el.cvs-media').count();
  expect(before).toBe(0);
  await page.mouse.click(box.x + box.width - 30, box.y + box.height - 30, { button: 'right' });
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.cvs-menu-item', { hasText: '从电脑选文件' }).click()]);
  await chooser.setFiles([png, mp4]);
  await expect(page.locator('#cvsWorld .cvs-el.cvs-media')).toHaveCount(before + 2, { timeout: 20_000 });

  /* 图片：裁切成默认的 3 个比例 */
  const img = page.locator('#cvsWorld .cvs-el.cvs-media', { has: page.locator('img') }).first();
  await img.click({ button: 'right', position: { x: 6, y: 6 } });
  await page.locator('.cvs-menu-item', { hasText: '裁切 / 平台尺寸' }).click();
  await expect(page.locator('.crop-modal')).toBeVisible();
  await expect(page.locator('.crop-box')).toBeVisible();
  await page.locator('.crop-modal .btn.primary', { hasText: '裁出 3 张' }).click();
  await expect(page.locator('.crop-modal')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('#cvsWorld .cvs-el.cvs-media')).toHaveCount(before + 5);
  await expect(page.locator('#cvsLinks path.cvs-link')).toHaveCount(3);
  /* 成品进了素材库，画幅是裁出来的比例 */
  const results = await page.evaluate(async () => ((await (await fetch('/api/bootstrap')).json()) as { results: { title: string; ratio: string; tags: string[] }[] }).results);
  const crops = results.filter((r) => r.tags.includes('裁切'));
  expect(crops.map((r) => r.ratio).sort()).toEqual(['16:9', '1:1', '4:5']);

  /* 视频：取当前画面 */
  const vid = page.locator('#cvsWorld .cvs-el.cvs-media', { has: page.locator('video') }).first();
  await vid.click({ button: 'right' });
  await page.locator('.cvs-menu-item', { hasText: '视频工具' }).click();
  await expect(page.locator('.vtool-modal')).toBeVisible();
  await page.locator('.vtool-modal .btn', { hasText: '取当前画面' }).click();
  await expect(page.locator('.toast', { hasText: '已取帧' })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#cvsWorld .cvs-el.cvs-media')).toHaveCount(before + 6);
});

test('画布：批注改图、改参数再生成、并排对比', async ({ page }) => {
  await open(page);
  await ensureLogin(page);
  await generate(page, '2 张');
  const cards = page.locator('.cvs-inbox-card');
  await expect(cards.first()).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  while (await cards.count()) await cards.first().locator('.cvs-inbox-add').click();
  const media = page.locator('#cvsWorld .cvs-el.cvs-media');
  await expect(media.first()).toBeVisible();
  const total0 = await media.count();
  const jobsOf = async () => ((await page.evaluate(async () => (await (await fetch('/api/bootstrap')).json()).jobs)) as { name: string; prompt: string; refs: { src: string }[]; fromCvsId?: string }[]);

  /* 批注改图：框一处、写改法、提交；任务带原图 + 示意图两张参考图，新图连回原图 */
  await media.first().click({ button: 'right', position: { x: 8, y: 8 } });
  await page.locator('.cvs-menu-item', { hasText: '批注改图' }).click();
  await expect(page.locator('.annot-modal')).toBeVisible();
  const stage = page.locator('.annot-stage');
  await expect(stage).toBeVisible();
  const sb = (await stage.boundingBox())!;
  await page.mouse.move(sb.x + sb.width * 0.05, sb.y + sb.height * 0.05);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width * 0.25, sb.y + sb.height * 0.25, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('.annot-row')).toHaveCount(1);
  await page.locator('.annot-row input').fill('把杯子换成红色');
  await page.locator('.annot-modal .btn.primary', { hasText: '按批注生成' }).click();
  await expect(page.locator('.annot-modal')).toHaveCount(0, { timeout: 20_000 });
  await expect.poll(async () => (await jobsOf()).some((j) => j.name === '批注改图 · 1 处')).toBe(true);
  const aj = (await jobsOf()).find((j) => j.name === '批注改图 · 1 处')!;
  expect(aj.prompt).toContain('把杯子换成红色');
  expect(aj.prompt).toContain('画面左上');
  expect(aj.refs).toHaveLength(2);
  expect(aj.fromCvsId).toBeTruthy();

  /* 批注缓存：没提交的批注关掉再打开还在，并且元素上有角标 */
  await media.first().click({ button: 'right', position: { x: 8, y: 8 } });
  await page.locator('.cvs-menu-item', { hasText: '批注改图' }).click();
  await page.locator('.annot-tools .btn', { hasText: '点选' }).click();
  const sb2 = (await page.locator('.annot-stage').boundingBox())!;
  await page.mouse.click(sb2.x + sb2.width * 0.7, sb2.y + sb2.height * 0.7);
  await expect(page.locator('.annot-row')).toHaveCount(1);
  await page.locator('.annot-modal .icon-btn').first().click();
  await expect(media.first().locator('.cvs-annot-n')).toHaveText(/✎ 1/);

  /* 改参数再生成 */
  await media.first().click({ button: 'right', position: { x: 8, y: 8 } });
  await page.locator('.cvs-menu-item', { hasText: '改参数再生成' }).click();
  await expect(page.locator('.regen-modal')).toBeVisible();
  await page.locator('.regen-modal select').nth(1).selectOption('16:9');
  await page.locator('.regen-modal .btn.primary', { hasText: '重新生成' }).click();
  await expect(page.locator('.regen-modal')).toHaveCount(0, { timeout: 20_000 });
  await expect.poll(async () => (await jobsOf()).some((j) => j.name.startsWith('改参数 · 比例'))).toBe(true);

  /* 并排对比：选中两个，采用其中一个 */
  await page.keyboard.press('ControlOrMeta+a');
  await media.first().click({ button: 'right', position: { x: 8, y: 8 } });
  await page.locator('.cvs-menu-item', { hasText: /并排对比/ }).click();
  await expect(page.locator('.compare-modal .compare-cell')).not.toHaveCount(0);
  expect(await page.locator('.compare-modal .compare-cell').count()).toBeGreaterThanOrEqual(2);
  await page.locator('.compare-modal .btn', { hasText: '采用这个' }).first().click();
  await expect(page.locator('.compare-modal .btn', { hasText: '已采用' })).toHaveCount(1);
  void total0;
});

test('组图：锚点出多张、整批放进画布并成组，一致性检查；项目画板页', async ({ page }) => {
  await open(page);
  await ensureLogin(page);
  await generate(page, '1 张');
  const cards = page.locator('.cvs-inbox-card');
  await expect(cards.first()).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await cards.first().locator('.cvs-inbox-add').click();
  const media = page.locator('#cvsWorld .cvs-el.cvs-media');
  await expect(media).toHaveCount(1);

  await media.first().click({ button: 'right', position: { x: 8, y: 8 } });
  await page.locator('.cvs-menu-item', { hasText: '组图（以它为锚点）' }).click();
  await expect(page.locator('.group-modal')).toBeVisible();
  /* 默认 4 条轴：改一条的方案文字，再取消一条 → 3 张 */
  await page.locator('.group-axis.on input').first().fill('改为雪地场景，冷色调');
  await page.locator('.group-axis.on .ga-head').last().click();
  await page.locator('.group-modal .btn.primary', { hasText: '出 3 张' }).click();
  await expect(page.locator('.group-modal')).toHaveCount(0, { timeout: 20_000 });
  const jobs = await page.evaluate(async () => (await (await fetch('/api/bootstrap')).json()).jobs as { name: string; prompt: string; refs: unknown[]; batch?: string; fromCvsId?: string }[]);
  const gj = jobs.filter((j) => j.name.startsWith('组图 · '));
  expect(gj).toHaveLength(3);
  expect(new Set(gj.map((j) => j.batch)).size).toBe(1);
  expect(gj.every((j) => j.refs.length === 1 && j.fromCvsId)).toBe(true);
  expect(gj.some((j) => j.prompt.includes('改为雪地场景，冷色调'))).toBe(true);

  /* 整批放进画布并成组：3 张 + 锚点在一个分组里，连线 3 条 */
  await expect(cards).toHaveCount(3, { timeout: 40_000 });
  await page.locator('.cvs-inbox .btn', { hasText: '放进画布并成组' }).click();
  await expect(media).toHaveCount(4);
  await expect(page.locator('#cvsWorld .cvs-el.cvs-group')).toHaveCount(1);
  await expect(page.locator('#cvsLinks path.cvs-link')).toHaveCount(3);

  /* 一致性检查：规则本身在单测里逐条覆盖，这里只验证入口、弹层和结果渲染 */
  await page.keyboard.press('ControlOrMeta+a');
  await media.first().click({ button: 'right', position: { x: 8, y: 8 } });
  await page.locator('.cvs-menu-item', { hasText: '一致性检查' }).click();
  await expect(page.locator('.check-modal')).toBeVisible();
  await expect(page.locator('.check-line', { hasText: /模型(不)?一致/ })).toBeVisible();
  await expect(page.locator('.check-line', { hasText: /画幅(不)?一致/ })).toBeVisible();
  await expect(page.locator('.check-line', { hasText: '共用同一张参考图' })).toHaveCount(0); /* 锚点自己没有参考图，所以不是「全部共用」 */
  await page.locator('.check-modal .icon-btn').click();

  /* 项目画板页：当前项目卡片带元素数；新建项目后进入它的空画布 */
  await page.locator('.side-item', { hasText: '项目画板' }).click();
  await expect(page.locator('.page-title')).toHaveText('项目画板');
  await expect(page.locator('.proj-card.cur')).toContainText('5 个元素');
  await page.locator('.proj-new').click();
  await page.locator('.proj-new input').fill('新项目 E2E');
  await page.locator('.proj-new .btn.primary').click();
  await expect(page.locator('#cvsWorld .cvs-el')).toHaveCount(0);
  await page.locator('.side-item', { hasText: '项目画板' }).click();
  await expect(page.locator('.proj-card', { hasText: '新项目 E2E' })).toHaveCount(1);
});

test('项目快照：保存 / 恢复为新项目（不覆盖当前）、批注刷新后还在、导出上下文包', async ({ page }) => {
  await open(page);
  await ensureLogin(page);
  await generate(page, '1 张');
  const cards = page.locator('.cvs-inbox-card');
  await expect(cards.first()).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await cards.first().locator('.cvs-inbox-add').click();
  const media = page.locator('#cvsWorld .cvs-el.cvs-media');
  await expect(media).toHaveCount(1);

  /* 标一处批注但不提交 → 刷新后角标还在（批注已落盘） */
  await media.first().click({ button: 'right', position: { x: 8, y: 8 } });
  await page.locator('.cvs-menu-item', { hasText: '批注改图' }).click();
  await page.locator('.annot-tools .btn', { hasText: '点选' }).click();
  const sb = (await page.locator('.annot-stage').boundingBox())!;
  await page.mouse.click(sb.x + sb.width * 0.5, sb.y + sb.height * 0.5);
  await page.locator('.annot-row input').fill('换成暖色调');
  await page.locator('.annot-modal .icon-btn').first().click();
  await page.waitForTimeout(1200);
  await page.reload();
  await expect(page.locator('.composer-card')).toBeVisible();
  await expect(page.locator('#cvsWorld .cvs-el.cvs-media .cvs-annot-n')).toHaveText(/✎ 1/);

  /* 手动快照 → 清空画板 → 恢复为新项目：新项目里有那 1 个元素，原项目仍是空的 */
  const box = (await page.locator('#cvsViewport').boundingBox())!;
  await page.mouse.click(box.x + box.width - 30, box.y + box.height - 30, { button: 'right' });
  await page.locator('.cvs-menu-item', { hasText: '项目快照' }).click();
  await page.locator('.snap-new input').fill('清空前');
  await page.locator('.snap-new .btn', { hasText: '保存快照' }).click();
  await expect(page.locator('.snap-row', { hasText: '清空前' })).toBeVisible();
  const [zip] = await Promise.all([page.waitForEvent('download'), page.locator('.snap-modal .btn', { hasText: '导出上下文包' }).click()]);
  expect(zip.suggestedFilename()).toMatch(/上下文包\.zip$/);
  expect(fs.readFileSync((await zip.path())!).subarray(0, 4).toString('hex')).toBe('504b0304');
  await page.locator('.snap-modal .icon-btn').first().click();

  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await expect(page.locator('#cvsWorld .cvs-el')).toHaveCount(0);
  await page.mouse.click(box.x + box.width - 30, box.y + box.height - 30, { button: 'right' });
  await page.locator('.cvs-menu-item', { hasText: '项目快照' }).click();
  await page.locator('.snap-row', { hasText: '清空前' }).locator('button', { hasText: '恢复为新项目' }).click();
  await expect(page.locator('#cvsWorld .cvs-el.cvs-media')).toHaveCount(1);
  await page.locator('.ws-btn').click();
  await expect(page.locator('.ws-btn')).toContainText('快照 清空前');
});

test('本机工具：没装 yt-dlp / whisper 时展示安装指引，而不是静默失败', async ({ page }) => {
  await open(page);
  const tools = (await page.evaluate(async () => (await (await fetch('/api/tools')).json()).tools)) as { name: string; found: boolean }[];
  const missing = (n: string) => !tools.find((t) => t.name === n)?.found;
  test.skip(!missing('ytdlp') || !missing('whisper'), '本机已装 yt-dlp / whisper，指引不会出现');

  /* 链接下载：弹层里直接是安装指引，「解析」不可点 */
  const box = (await page.locator('#cvsViewport').boundingBox())!;
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.mouse.click(box.x + box.width - 30, box.y + box.height - 30, { button: 'right' });
  await page.locator('.cvs-menu-item', { hasText: '从链接下载视频' }).click();
  await expect(page.locator('.linkdl-modal .tool-guide')).toContainText('yt-dlp');
  await expect(page.locator('.linkdl-modal .tool-guide code').first()).toContainText(/brew install yt-dlp|winget install yt-dlp|pipx install yt-dlp/);
  await expect(page.locator('.linkdl-modal .btn', { hasText: '下载到画布' })).toBeDisabled();
  await page.locator('.linkdl-modal .icon-btn').first().click();

  /* 设置页：本机工具区列出状态与指引 */
  await page.locator('.side-item', { hasText: '设置' }).click();
  await expect(page.locator('.catalog-sec-name', { hasText: '本机工具' })).toBeVisible();
  await expect(page.locator('.tool-guide', { hasText: 'whisper' })).toBeVisible();
  await expect(page.locator('.tool-guide', { hasText: 'openai-whisper' })).toContainText('pip');
});

test('Agent：能力卡、生成计划、改参数、确认后才建任务；计划失败如实报错', async ({ page }) => {
  await open(page);
  await ensureLogin(page);
  await generate(page, '1 张');
  const cards = page.locator('.cvs-inbox-card');
  await expect(cards.first()).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await cards.first().locator('.cvs-inbox-add').click();
  const media = page.locator('#cvsWorld .cvs-el.cvs-media');
  await expect(media).toHaveCount(1);
  const imgId = (await media.first().getAttribute('data-id'))!;
  await media.first().click({ position: { x: 8, y: 8 } });

  await page.locator('.agent-fab').click();
  await expect(page.locator('.agent-card')).toHaveCount(4);

  /* 能力卡：没选图时提示；选了图直接打开对应工具 */
  await page.locator('.agent-card', { hasText: '改这张图' }).click();
  await expect(page.locator('.annot-modal')).toBeVisible();
  await page.locator('.annot-modal .icon-btn').first().click();

  /* 计划失败：如实报错，目标文字保留 */
  await page.route('**/api/assist/plan', (r) => r.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: '模型没有给出可用的计划', detail: '稍后重试' }) }));
  await page.locator('.agent-sec textarea').first().fill('做一组春季饮品配图，再配一条短视频');
  await page.locator('.agent-sec .btn', { hasText: '生成计划' }).click();
  await expect(page.locator('.agent-sec .agent-hint')).toContainText('没有给出可用的计划');
  await expect(page.locator('.plan-step')).toHaveCount(0);

  /* 计划成功：改一步的比例、删一步，确认后任务带着参考图提交 */
  await page.unroute('**/api/assist/plan');
  await page.route('**/api/assist/plan', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        summary: '先出两张主图，再做短视频',
        steps: [
          { id: 's1', kind: 'image', title: '主图', prompt: '春日拿铁海报，窗边晨光', ratio: '4:5', count: 2, refIds: [imgId], why: '竖版适合信息流' },
          { id: 's2', kind: 'video', title: '短视频', prompt: '镜头推进，蒸汽升起', ratio: '9:16', count: 1, dur: 5, refIds: [] },
          { id: 's3', kind: 'image', title: '多余的一步', prompt: '删掉我', ratio: '1:1', count: 1, refIds: [] },
        ],
      }),
    }),
  );
  await page.locator('.agent-sec .btn', { hasText: '生成计划' }).click();
  await expect(page.locator('.plan-step')).toHaveCount(3);
  await expect(page.locator('.plan-step').first()).toContainText('AI 建议 · 竖版适合信息流');
  const before = (await page.evaluate(async () => (await (await fetch('/api/bootstrap')).json()).jobs.length)) as number;
  await page.locator('.plan-step').nth(2).locator('.icon-btn').click();
  await expect(page.locator('.plan-step')).toHaveCount(2);
  await page.locator('.plan-step').first().locator('select').nth(1).selectOption('16:9');
  /* 没点确认之前不建任务 */
  expect(await page.evaluate(async () => (await (await fetch('/api/bootstrap')).json()).jobs.length)).toBe(before);
  await page.locator('.plan-steps .btn', { hasText: '确认并生成' }).click();
  await expect.poll(async () => (await page.evaluate(async () => (await (await fetch('/api/bootstrap')).json()).jobs)).filter((j: { name: string }) => j.name.startsWith('Agent · ')).length).toBe(2);
  const jobs = (await page.evaluate(async () => (await (await fetch('/api/bootstrap')).json()).jobs)) as { name: string; ratio?: string; count?: number; dur?: number; type: string; refs: unknown[]; fromCvsId?: string }[];
  const main = jobs.find((j) => j.name === 'Agent · 主图')!;
  expect(main).toMatchObject({ type: 'image', ratio: '16:9', count: 2, fromCvsId: imgId });
  expect(main.refs).toHaveLength(1);
  const vid = jobs.find((j) => j.name === 'Agent · 短视频')!;
  expect(vid).toMatchObject({ type: 'video', ratio: '9:16', dur: 5 });
  expect(vid.refs).toHaveLength(1); /* 步骤没指定参考时，用选中的素材 */
});

test('API 接入：创建 Key、下载 mcp.json（带完整 Key）、Key 能读画布上下文、停用后被拒', async ({ page }) => {
  await open(page);
  await ensureLogin(page);
  await page.locator('.side-item', { hasText: 'API 接入' }).click();
  await expect(page.locator('.page-title')).toHaveText('API 接入');
  await page.locator('.btn', { hasText: '创建 Key' }).click();
  const secret = (await page.locator('.alert-bar .num').first().textContent())!.trim();
  expect(secret).toMatch(/^sk-local-[0-9a-f]{36}$/);
  await expect(page.locator('.key-row', { hasText: 'sk-local-' })).toHaveCount(1);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('.btn', { hasText: '下载 mcp.json' }).click()]);
  expect(dl.suggestedFilename()).toBe('mcp.json');
  const cfg = JSON.parse(fs.readFileSync((await dl.path())!, 'utf8')) as { mcpServers: Record<string, { env: Record<string, string>; args: string[] }> };
  expect(cfg.mcpServers['aigc-studio'].env.AIGC_API_KEY).toBe(secret);
  expect(cfg.mcpServers['aigc-studio'].env.AIGC_BASE_URL).toContain('127.0.0.1');
  expect(cfg.mcpServers['aigc-studio'].args[0]).toMatch(/index\.mjs$/);
  /* 用这把 Key 真的能读到画布上下文 */
  const ctx = await page.evaluate(async (k) => (await fetch('/openapi/v1/canvas/context', { headers: { authorization: `Bearer ${k}` } })).json(), secret);
  expect(ctx.summary).toContain('个元素');
  /* 停用后被拒绝 */
  await page.locator('.key-row', { hasText: 'sk-local-' }).locator('button', { hasText: '停用' }).click();
  await expect(async () => {
    const st = await page.evaluate(async (k) => (await fetch('/openapi/v1/canvas/context', { headers: { authorization: `Bearer ${k}` } })).status, secret);
    expect(st).toBe(403);
  }).toPass();
});

test('项目切换器：新建项目的名称输入框不能被「创建」按钮挤没', async ({ page }) => {
  await open(page);
  await page.locator('.ws-btn').click();
  await page.locator('.wm-actions .btn', { hasText: '新建项目' }).click();
  const input = page.locator('.wm-new .form-input');
  await expect(input).toBeVisible();
  const box = await input.boundingBox();
  expect(box!.width).toBeGreaterThan(150);
  const create = page.locator('.wm-new .btn', { hasText: '创建' });
  await expect(create).toBeVisible();
  expect((await create.boundingBox())!.width).toBeLessThan(box!.width);
});
