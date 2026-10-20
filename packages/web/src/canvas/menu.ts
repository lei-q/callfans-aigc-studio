import { pickFiles } from '../lib/util';
import { getState } from '../store';
import { boardOf, canvasItems, canvasLinks, canvasSelItems, savedToLib } from '../store/selectors';
import * as op from './ops';

export type MenuEntry = { sep: true } | { label: string } | { t: string; k?: string; danger?: boolean; run: () => void };

/* 右键菜单：跟着选择变化，只列真的用得上的项，不给点了没反应的入口 */
export function menuItems(): MenuEntry[] {
  const s = getState();
  if (s.linkSel) {
    const l = canvasLinks(s).find((x) => x.id === s.linkSel);
    if (l) {
      return [
        { t: '给这条线写个名字', run: () => op.linkLabelStart(l.id) },
        ...(l.label ? [{ t: '清除名字', run: op.linkLabelClear }] : []),
        { sep: true },
        { t: '删除这条线', k: 'Del', danger: true, run: op.linkRemove },
      ];
    }
  }
  const sel = canvasSelItems(s);
  const n = sel.length;
  const many = n > 1;
  const one = n === 1 ? sel[0] : null;
  const isMedia = !!one && one.kind === 'media';
  const isGroup = !!one && one.kind === 'group';
  const isText = !!one && one.kind === 'text';
  const items: MenuEntry[] = [];
  if (!n) {
    items.push({ t: '全选', k: 'Ctrl A', run: op.selectAll });
    items.push({ t: '适应窗口', k: 'F', run: () => op.fitAll() });
    items.push({ t: '整理成网格', run: op.arrange });
    items.push({ sep: true });
    items.push({ t: '从电脑选文件', run: () => void uploadFromMenu() });
    items.push({ t: s.cvsPen.on ? '关闭画笔' : '手绘标注', k: 'B', run: op.togglePen });
    items.push({ t: '新建节点', run: op.newNode });
    items.push({ t: '新建文字', run: op.newText });
    items.push({ t: '把画板上的东西归为一组', run: op.groupAll });
    if (canvasItems(s).length) {
      items.push({ sep: true });
      items.push({ t: s.canvasConfirm ? '再点一次确认清空' : '清空画板', danger: true, run: op.canvasClear });
    }
    return items;
  }
  items.push({ t: '复制一份', k: 'Ctrl D', run: op.duplicateSel });
  if (isMedia) items.push({ t: '以此发散', run: op.divergeOpen });
  if (isMedia && one.type === 'image') items.push({ t: '适配多平台尺寸', run: op.platformsOpen });
  if (isMedia) items.push({ t: boardOf(s).anchor?.cvsId === one.id ? '取消风格基准' : '设为风格基准', run: () => op.anchorToggle(one.id) });
  if (n === 2) items.push({ t: '把这两个连起来', run: op.linkPair });
  if (many) items.push({ t: '归为一组', run: op.groupSelection });
  if (isMedia) items.push({ t: '展开为导图', run: op.mindmap });
  if (one) items.push({ t: '从这里连线', run: () => op.linkStart(one.id) });
  if (one && (one.kind === 'media' || one.kind === 'web' || one.kind === 'post')) items.push({ t: '收进审美库', run: () => void op.keepAesthetic(one.id) });
  if (one?.rid) items.push({ t: '查看生成参数', run: op.menuParams });
  if (one?.rid && !savedToLib(s, one.rid)) items.push({ t: '保存到素材库', run: op.saveSelToLib });
  if ((one?.kind === 'web' || one?.kind === 'post') && one.url) items.push({ t: '在浏览器打开', run: () => window.open(one.url, '_blank', 'noopener') });
  items.push({ sep: true });
  if (many) {
    items.push({ label: '对齐' });
    items.push({ t: '左对齐', run: () => op.align('left') });
    items.push({ t: '水平居中', run: () => op.align('hcenter') });
    items.push({ t: '右对齐', run: () => op.align('right') });
    items.push({ t: '顶对齐', run: () => op.align('top') });
    items.push({ t: '垂直居中', run: () => op.align('vcenter') });
    items.push({ t: '底对齐', run: () => op.align('bottom') });
    items.push({ label: '分布' });
    items.push({ t: '水平均分', run: () => op.distribute('h') });
    items.push({ t: '垂直均分', run: () => op.distribute('v') });
  }
  if (isText) {
    items.push({ label: '字号' });
    items.push({ t: '小（备注）', run: () => op.textSize('sm') });
    items.push({ t: '中（正文）', run: () => op.textSize('md') });
    items.push({ t: '大（标题）', run: () => op.textSize('lg') });
  }
  /* 分组被强制压在最底层，改层级不会有任何变化，所以不给这两个入口 */
  if (!isGroup) {
    items.push({ label: '层级' });
    items.push({ t: '置顶', run: () => op.reorder('front') });
    items.push({ t: '置底', run: () => op.reorder('back') });
  }
  if (!isGroup) {
    items.push({ label: '变换' });
    items.push({ t: '水平翻转', run: () => op.flip('h') });
    items.push({ t: '垂直翻转', run: () => op.flip('v') });
    items.push({ t: '顺时针转 90°', run: () => op.rotate(90) });
    items.push({ t: '逆时针转 90°', run: () => op.rotate(-90) });
    items.push({ label: '透明度' });
    items.push({ t: '半透明（描摹用）', run: () => op.opacity(0.35) });
    items.push({ t: '恢复不透明', run: () => op.opacity(1) });
    items.push({ t: '恢复原状', run: op.resetEl });
  }
  items.push({ sep: true });
  items.push({ t: `移除${many ? ` ${n} 个` : ''}元素`, k: 'Del', danger: true, run: op.deleteSel });
  return items;
}

async function uploadFromMenu() {
  const files = await pickFiles('image/*,video/*,audio/*,.pdf,.doc,.docx,.txt,.md,.csv,.ppt,.pptx,.xls,.xlsx', true);
  if (files.length) await op.addLocalFiles(files, null, null);
}

export { uploadFromMenu };
