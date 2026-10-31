// 批注 / 编辑层：高亮、下划线、删除线、文本框、便签、墨迹、形状、图章、签名、图片、文字编辑
import { state, setDirty } from './state.js';
import { toast, openModal, field, openMenu } from './ui.js';
import { t } from './i18n.js';
import { normalizePdfText } from './textfix.js';
import {
  pageWrap, pageOverlay, getViewport, updateOverlay, updateOverlays, goToPage,
  getPageImages, getPageImagesSync, renderPageToCanvas, ensurePageInfo, viewportElRef,
  scheduleSelHighlight
} from './viewer.js';

let seq = 1;
const NID = () => 'a' + (seq++) + '_' + Math.random().toString(36).slice(2, 7);

let drag = null;      // 当前拖拽状态
let selected = null;  // { page, id }

/* ---------------- 快照 / 撤销 ---------------- */
export function snapshot() {
  state.undo.push(JSON.stringify(state.annotations));
  if (state.undo.length > 80) state.undo.shift();
  state.redo = [];
}
export function undo() {
  if (!state.undo.length) return toast(t('没有可撤销的操作'));
  state.redo.push(JSON.stringify(state.annotations));
  state.annotations = JSON.parse(state.undo.pop());
  selected = null;
  setDirty(true);
  updateOverlays();
}
export function redo() {
  if (!state.redo.length) return toast(t('没有可重做的操作'));
  state.undo.push(JSON.stringify(state.annotations));
  state.annotations = JSON.parse(state.redo.pop());
  selected = null;
  setDirty(true);
  updateOverlays();
}

/* ---------------- 工具 ---------------- */
/* 插入文字可选的 4 种简单字体（同时决定屏幕上与写入 PDF 时的字形）
 * name 是中文原文，用作 i18n 的 key，渲染时用 t(name) 取当前语言的名称 */
export const TEXT_FONTS = [
  { id: 'hei', name: '黑体', css: '"Microsoft YaHei","微软雅黑",SimHei,"Heiti SC",sans-serif' },
  { id: 'kai', name: '楷体', css: 'KaiTi,"楷体",STKaiti,"Kaiti SC",serif' },
  { id: 'fang', name: '仿宋', css: 'FangSong,"仿宋",STFangsong,"Songti SC",serif' },
  { id: 'mono', name: '等宽', css: 'Consolas,"Courier New",Courier,monospace' }
];
export const TEXT_COLORS = ['#14161a', '#e4002b', '#e08d00', '#12a150', '#1565c0', '#7b1fa2', '#5b6472', '#ffffff'];
export const TEXT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 42, 48, 56, 64, 72];
export function fontCss(id) {
  const f = TEXT_FONTS.find((x) => x.id === id);
  return (f || TEXT_FONTS[0]).css;
}

const DRAW_TOOLS = new Set(['highlight', 'underline', 'strikeout', 'ink', 'shape']);
const PICK_TOOLS = new Set(['editText', 'note', 'stamp', 'signature', 'editImage', 'marquee']);
const TEXT_TOOLS = new Set(['insertText', 'text']);
const OBJECT_TOOLS = new Set(['editImage']);
/* 可自由拖动 / 缩放的「对象」类型（选中后显示四角手柄与「完成」按钮） */
const OBJECT_TYPES = new Set(['image', 'signature', 'stamp', 'shape', 'text', 'note', 'link']);
/* 原位置白底遮盖用「独立层」渲染的对象类型（避免遮住选中边框） */
const SIBLING_COVER = new Set(['image', 'signature', 'stamp']);
/* 拖拽方向锁 */
const MIN_SIZE = 16;

/* 模式变化钩子（app.js 注册，用于同步工具栏） */
let modeHook = null;
export function onModeChange(fn) { modeHook = fn; }

export function setTool(name, force = false) {
  if (state.mode !== 'edit') {
    toast(t('请先切换到「编辑」模式'));
    return;
  }
  if (state.rotation !== 0) {
    toast(t('请先复位视图旋转，再进行编辑'));
    return;
  }
  const prev = state.tool;
  commitActiveEditor();
  state.tool = (!force && state.tool === name) ? null : name;
  syncToolClasses();
  if (state.tool) selectAnnotation(null);
  updateHint();
  if (prev !== state.tool) refreshBlocks();
}

/** 文本块只在「编辑文字」模式下显示；开关工具时统一刷新 */
function refreshBlocks() {
  blockCache.clear();
  updateOverlays();
}

export function setMode(mode) {
  commitActiveEditor();
  clearMarquee();
  clearImagePick();
  const changed = state.mode !== mode;
  state.mode = mode;
  state.tool = null;
  syncToolClasses();
  selectAnnotation(null);
  updateHint();
  scheduleSelHighlight();      // 切换模式后重算选中高亮（编辑模式不显示）
  if (changed) refreshBlocks();
  if (modeHook) modeHook(mode);
}

function syncToolClasses() {
  const b = document.body;
  b.classList.toggle('edit-mode', state.mode === 'edit');
  const cur = state.tool;
  b.classList.toggle('tool-draw', DRAW_TOOLS.has(cur));
  b.classList.toggle('tool-text', TEXT_TOOLS.has(cur) || cur === 'editText');
  b.classList.toggle('tool-pick', PICK_TOOLS.has(cur));
  b.classList.toggle('tool-object', OBJECT_TOOLS.has(cur));
  b.classList.toggle('tool-link', cur === 'link');
  b.classList.toggle('tool-marquee', cur === 'marquee');
  document.querySelectorAll('.tbtn[data-tool]').forEach((el) => {
    el.classList.toggle('active', el.dataset.tool === state.tool);
  });
}

let hintEl = null;
function updateHint() {
  if (!hintEl) hintEl = document.getElementById('empty-hint');
  const cur = state.tool;
  if (!hintEl) return;
  const map = {
    editText: t('点页面里的文字即可就地修改；点空白处自动保存'),
    insertText: t('点击页面任意位置，输入新文字；可切换字体、字号与颜色'),
    text: t('点击页面任意位置，输入新文字；可切换字体、字号与颜色'),
    marquee: t('按住左键拖出一个方框（也可在其它工具下直接右键拖），松开后点「删除」确认'),

    editImage: t('点击 PDF 里的图片即可编辑：拖动、四角缩放、可替换图片内容；改完点「完成」或点空白处自动保存'),
    link: t('在页面上拖拽划出链接区域，然后填写网址或跳转页码'),
    highlight: t('选中文字后点击，或拖拽划出高亮区域'),
    underline: t('拖拽划出下划线区域'),
    strikeout: t('拖拽划出删除线区域'),
    ink: t('按住鼠标自由手写'),
    shape: t('拖拽绘制形状'),
    note: t('点击页面放置便签'),
    stamp: t('点击页面放置图章'),
    signature: t('点击页面放置签名')
  };
  if (cur && map[cur] && state.mode === 'edit') {
    hintEl.textContent = map[cur];
    hintEl.classList.remove('hidden');
  } else if (!cur && state.mode === 'edit') {
    // 无工具时的默认手感提示（左键浏览 / 右键框选）
    hintEl.textContent = t('点文字立刻编辑、点图片立刻编辑、左键按住拖动页面、右键按住拖出方框删除');
    hintEl.classList.remove('hidden');
  } else {
    hintEl.classList.add('hidden');
  }
}

export function initAnnotate() {
  const pages = document.getElementById('pages');
  pages.addEventListener('pointerdown', onPointerDown);
  // 右键拖拽 = 框选删除，必须屏蔽浏览器右键菜单（否则一松手就弹出菜单）
  pages.addEventListener('contextmenu', (e) => {
    if (e.target.closest && e.target.closest('.page-wrap')) e.preventDefault();
  });
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);

  document.addEventListener('mousedown', (e) => {
    if (e.target.closest && e.target.closest('.marquee-bar, .marquee-box')) return;
    if (!e.target.closest('.page-overlay .anno')) selectAnnotation(null);
    if (!e.target.closest('.page-wrap')) clearMarquee();
  }, true);

  // 点任意其它地方（含页面外、工具栏、侧栏）都立即提交正在编辑的文本 ——
  // 不依赖 blur 事件，保证「点空白处自动保存」在各种情况下都生效
  document.addEventListener('mousedown', (e) => {
    if (!activeEditor) return;
    if (e.target.closest && e.target.closest('.anno-text.editing')) return;
    commitActiveEditor();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.target.isContentEditable || /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && marqueeSel) {
      e.preventDefault();
      applyMarqueeDelete();
      return;
    }
    if (e.key === 'Escape' && marqueeSel) {
      e.preventDefault();
      clearMarquee();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
      e.preventDefault();
      removeAnnotation(selected.page, selected.id);
      return;
    }
    // 回车 / Esc 结束对象编辑
    if ((e.key === 'Enter' || e.key === 'Escape') && selected) {
      e.preventDefault();
      selectAnnotation(null);
    }
  });

  // 剪贴板粘贴图片
  document.addEventListener('paste', onPaste);

  // 浏览模式：右键菜单（复制文字 / 复制图片）
  pages.addEventListener('contextmenu', onViewContextMenu);
  // 浏览模式：Ctrl+C。选中了文字用系统自带复制；选中了图片则复制图片
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'c') return;
    if (state.mode === 'edit') return;
    if (e.target.isContentEditable || /INPUT|TEXTAREA/.test(e.target.tagName)) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && String(sel).trim()) return;   // 有文字选择 → 交给浏览器
    if (!pickedImage) return;
    e.preventDefault();
    copyPickedImage();
  });
}

/* ---------------- 浏览模式：选中 → 复制 ---------------- */
let pickedImage = null;      // { page, rect } 当前选中的原生图片
let imagePickEl = null;

function clearImagePick() {
  if (imagePickEl) { imagePickEl.remove(); imagePickEl = null; }
  pickedImage = null;
}

/** 在页面上把选中的图片用虚线框标出来（浏览模式，只读） */
function selectImageForCopy(page, im, quiet) {
  clearImagePick();
  const overlay = pageOverlay(page);
  if (!overlay) return;
  pickedImage = { page, rect: { ...im } };
  const s = userRectToScreen(page, im.x, im.y, im.w, im.h);
  const el = document.createElement('div');
  el.className = 'img-pick';
  el.style.left = s.left + 'px';
  el.style.top = s.top + 'px';
  el.style.width = s.width + 'px';
  el.style.height = s.height + 'px';
  overlay.appendChild(el);
  imagePickEl = el;
  if (!quiet) toast(t('已选中图片，按 Ctrl+C 复制'), 'ok');
}

/** 复制当前选中的图片到剪贴板 */
async function copyPickedImage() {
  const im = pickedImage && pickedImage.rect;
  if (!im || !state.pdfDoc) return false;
  const page = pickedImage.page;
  let dataUrl = null;
  try { dataUrl = await cropNativeImage(page, im, 2.5); } catch (e) { dataUrl = null; }
  if (!dataUrl) { toast(t('无法复制该图片'), 'err'); return false; }
  const r = await window.pdfmini.clipboard.writeImage(dataUrl);
  if (r && r.ok) toast(t('图片已复制到剪贴板'), 'ok');
  else toast(t('无法复制该图片'), 'err');
  return !!(r && r.ok);
}

/** 复制整页为图片 */
async function copyPageAsImage(page) {
  const n = page || state.currentPage;
  paintBusy(true);
  try {
    const canvas = await renderPageToCanvas(n, 2);
    const r = await window.pdfmini.clipboard.writeImage(canvas.toDataURL('image/png'));
    if (r && r.ok) toast(t('本页已复制为图片'), 'ok');
    else toast(t('无法复制该图片'), 'err');
  } catch (e) {
    toast(t('无法复制该图片'), 'err');
  } finally {
    paintBusy(false);
  }
}

/** 复制指定页的文字层内容 */
async function copyPageText(page) {
  const n = page || state.currentPage;
  try {
    const tc = await (await state.pdfDoc.getPage(n)).getTextContent();
    const txt = normalizePdfText(tc.items.map((it) => it.str || '').join(''))
      .replace(/[ \t]+\n/g, '\n')
      .trim();
    if (!txt) { toast(t('本页没有可复制的文字'), 'err'); return; }
    const r = await window.pdfmini.clipboard.writeText(txt);
    if (r && r.ok) toast(t('本页文字已复制'), 'ok');
  } catch (e) {
    toast(t('本页没有可复制的文字'), 'err');
  }
}

function paintBusy(on) { document.body.classList.toggle('busy', !!on); }

/** 浏览模式的右键菜单 */
async function onViewContextMenu(e) {
  if (state.mode === 'edit') return;              // 编辑模式下右键是「框选删除」
  const wrap = e.target.closest && e.target.closest('.page-wrap');
  if (!wrap) return;
  e.preventDefault();
  const page = Number(wrap.dataset.page);
  const { x, y } = cssPointInPage(e, wrap);
  const im = imageAt(page, x, y);
  const sel = window.getSelection();
  const hasText = !!(sel && !sel.isCollapsed && String(sel).trim());
  const items = [];
  if (hasText) items.push({ label: t('复制选中文字'), icon: 'text', onClick: () => { document.execCommand('copy'); toast(t('已复制选中文字'), 'ok'); } });
  if (im) {
    items.push({
      label: t('复制此图片'), icon: 'image',
      onClick: () => { selectImageForCopy(page, im, true); copyPickedImage(); }
    });
  }
  items.push({ label: t('复制本页文字'), icon: 'text', onClick: () => copyPageText(page) });
  items.push({ label: t('复制本页为图片'), icon: 'image', onClick: () => copyPageAsImage(page) });
  openMenu(makeAnchor(e.clientX, e.clientY), items, { minWidth: 190 });
}

/** 让 openMenu 能在鼠标位置弹出（openMenu 需要锚点元素的 rect） */
function makeAnchor(x, y) {
  const a = document.createElement('div');
  a.style.cssText = 'position:fixed;width:0;height:0;';
  a.getBoundingClientRect = () => ({ left: x, top: y, right: x, bottom: y, width: 0, height: 0 });
  return a;
}

/* ---------------- 坐标换算 ---------------- */
function toUser(n, cssX, cssY) {
  const vp = getViewport(n);
  if (!vp) return { x: 0, y: 0 };
  const p = vp.convertToPdfPoint(cssX, cssY);
  return { x: p[0], y: p[1] };
}
function userRectToScreen(n, x, y, w, h) {
  const vp = getViewport(n);
  if (!vp) return { left: 0, top: 0, width: 0, height: 0 };
  const p1 = vp.convertToViewportPoint(x, y);
  const p2 = vp.convertToViewportPoint(x + w, y + h);
  return {
    left: Math.min(p1[0], p2[0]), top: Math.min(p1[1], p2[1]),
    width: Math.abs(p2[0] - p1[0]), height: Math.abs(p2[1] - p1[1])
  };
}
function userPointToScreen(n, x, y) {
  const vp = getViewport(n);
  if (!vp) return { left: 0, top: 0 };
  const p = vp.convertToViewportPoint(x, y);
  return { left: p[0], top: p[1] };
}
function cssPointInPage(evt, wrap) {
  const r = wrap.getBoundingClientRect();
  return { x: evt.clientX - r.left, y: evt.clientY - r.top };
}

/* ---------------- 覆盖层绘制 ---------------- */
export function drawOverlay(n) {
  const overlay = pageOverlay(n);
  if (!overlay) return;
  // 该页正在就地编辑文本：重建 DOM 前先落盘，否则正在输入的内容会随元素被清掉而丢失
  if (activeEditor && activeEditor.page === n) commitActiveEditor();
  overlay.innerHTML = '';
  hideTextHover();
  closeTextBar();
  marqueeBoxEl = null; marqueeBarEl = null;      // innerHTML 已清空，旧引用失效
  imagePickEl = null;
  const sel = marqueeSel;
  const picked = pickedImage;
  if (!getViewport(n)) return;      // 该页尚未渲染，等渲染后再绘制
  const list = state.annotations[n] || [];
  // 先画「原位置白底遮盖」（原生图片被移走/替换后留在原处），
  // 作为独立层、位于所有对象之下 —— 这样它永远不会盖住对象的选中边框与缩放手柄
  for (const a of list) {
    if (!a.cover || !SIBLING_COVER.has(a.type)) continue;
    const cs = userRectToScreen(n, a.cover.x, a.cover.y, a.cover.w, a.cover.h);
    const cv = document.createElement('div');
    cv.className = 'anno-cover-el';
    cv.style.left = cs.left + 'px';
    cv.style.top = cs.top + 'px';
    cv.style.width = cs.width + 'px';
    cv.style.height = cs.height + 'px';
    overlay.appendChild(cv);
  }
  for (const a of list) overlay.appendChild(buildAnnoEl(n, a));
  overlay.dataset.page = String(n);
  if (selected && selected.page === n) selectAnnotation(selected, true);
  if (sel && sel.page === n) renderMarqueeEls(n, overlay, sel.css);   // 重建后把选区框与按钮挂回去
  if (picked && picked.page === n) selectImageForCopy(n, picked.rect, true); // 选中的图片同样恢复
}

function buildAnnoEl(n, a) {
  const el = document.createElement('div');
  el.className = 'anno';
  el.dataset.id = a.id;
  el.dataset.page = String(n);

  if (a.type === 'highlight' || a.type === 'underline' || a.type === 'strikeout') {
    const frag = document.createDocumentFragment();
    for (const r of a.rects) {
      const s = userRectToScreen(n, r.x, r.y, r.w, r.h);
      const d = document.createElement('div');
      d.style.position = 'absolute';
      d.style.left = s.left + 'px'; d.style.top = s.top + 'px';
      d.style.width = s.width + 'px'; d.style.height = s.height + 'px';
      if (a.type === 'highlight') {
        d.style.background = a.color; d.style.opacity = String(a.opacity ?? 0.42); d.style.mixBlendMode = 'multiply';
      } else if (a.type === 'underline') {
        d.style.borderBottom = `${Math.max(1, state.zoom * 1.2)}px solid ${a.color}`;
      } else {
        d.style.borderTop = `${Math.max(1, state.zoom * 1.2)}px solid ${a.color}`;
        d.style.top = (s.top + s.height / 2) + 'px'; d.style.height = '0px';
      }
      frag.appendChild(d);
    }
    el.style.cssText = 'left:0;top:0;width:100%;height:100%;pointer-events:none';
    el.appendChild(frag);
    return el;
  }

  if (a.type === 'ink') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const size = pageWrap(n).getBoundingClientRect();
    svg.setAttribute('width', size.width); svg.setAttribute('height', size.height);
    svg.style.cssText = 'left:0;top:0;pointer-events:none';
    for (const path of a.paths) {
      const pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
      pl.setAttribute('points', path.map((p) => {
        const s = userPointToScreen(n, p.x, p.y);
        return `${s.left.toFixed(1)},${s.top.toFixed(1)}`;
      }).join(' '));
      pl.setAttribute('fill', 'none');
      pl.setAttribute('stroke', a.color);
      pl.setAttribute('stroke-width', String(Math.max(1, a.width * state.zoom)));
      pl.setAttribute('stroke-linecap', 'round');
      pl.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(pl);
    }
    el.style.cssText = 'left:0;top:0;width:100%;height:100%;pointer-events:none';
    el.appendChild(svg);
    return el;
  }

  if (a.type === 'shape') {
    const s = userRectToScreen(n, a.x, a.y, a.w, a.h);
    const syn = pageWrap(n).getBoundingClientRect();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', syn.width); svg.setAttribute('height', syn.height);
    svg.style.cssText = 'left:0;top:0;pointer-events:none';
    let node;
    if (a.shape === 'ellipse') {
      node = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
      node.setAttribute('cx', s.left + s.width / 2); node.setAttribute('cy', s.top + s.height / 2);
      node.setAttribute('rx', s.width / 2); node.setAttribute('ry', s.height / 2);
    } else if (a.shape === 'line') {
      node = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      node.setAttribute('x1', s.left); node.setAttribute('y1', s.top);
      node.setAttribute('x2', s.left + s.width); node.setAttribute('y2', s.top + s.height);
    } else {
      node = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      node.setAttribute('x', s.left); node.setAttribute('y', s.top);
      node.setAttribute('width', s.width); node.setAttribute('height', s.height);
      node.setAttribute('rx', 1);
    }
    node.setAttribute('fill', a.fill ? hexA(a.color, 0.25) : 'none');
    node.setAttribute('stroke', a.color);
    node.setAttribute('stroke-width', String(Math.max(1, a.width * state.zoom)));
    svg.appendChild(node);
    el.style.cssText = 'left:0;top:0;width:100%;height:100%;pointer-events:none';
    el.appendChild(svg);
    return el;
  }

  if (a.type === 'text') {
    if (a.erased) {
      // 已删除的文字：只保留白底遮盖，不再生成空的文本框（否则会留下一个空框）
      if (a.cover) {
        const cs0 = userRectToScreen(n, a.cover.x, a.cover.y, a.cover.w, a.cover.h);
        const cv0 = document.createElement('div');
        cv0.className = 'anno-cover';
        cv0.style.cssText = `position:absolute;left:${cs0.left}px;top:${cs0.top}px;width:${cs0.width}px;height:${cs0.height}px;background:#fff;pointer-events:none`;
        el.appendChild(cv0);
      }
      el.style.cssText = 'left:0;top:0;width:100%;height:100%;pointer-events:none;';
      return el;
    }
    if (a.cover) {
      const cs = userRectToScreen(n, a.cover.x, a.cover.y, a.cover.w, a.cover.h);
      const cover = document.createElement('div');
      cover.className = 'anno-cover';
      cover.style.cssText = `position:absolute;left:${cs.left}px;top:${cs.top}px;width:${cs.width}px;height:${cs.height}px;background:#fff;pointer-events:none`;
      el.appendChild(cover);
    }
    const s = userPointToScreen(n, a.x, a.y);
    const box = document.createElement('div');
    box.className = 'anno-text';
    // PDF 原生文字块：光是文本光标（点一下就地编辑）；自己插入的文字：移动光标（可拖动）
    if (a.native || a.blockKey) box.classList.add('editable');
    box.dataset.type = 'text';
    box.style.position = 'absolute';
    box.style.left = s.left + 'px';
    box.style.top = s.top + 'px';
    box.style.width = Math.ceil(a.w * state.zoom) + 'px';
    box.style.fontSize = (a.fontSize * state.zoom) + 'px';
    box.style.fontFamily = fontCss(a.font);
    box.style.lineHeight = '1.25';
    box.style.color = a.color;
    // 单行文字用 pre（永不换行）：系统渲染字体常比 PDF 原字体略宽，
    // 若允许换行会把最后几个字挤到第二行，看起来像「没改却自动换行」
    box.style.whiteSpace = String(a.text || '').indexOf('\n') >= 0 ? 'pre-wrap' : 'pre';
    box.style.wordBreak = 'break-word';
    box.textContent = a.text;
    el.appendChild(box);
    // 容器铺满整页但必须「不接收事件」，否则会挡住页面上其它文本块 / 批注的点击
    el.style.cssText = 'left:0;top:0;width:100%;height:100%;pointer-events:none;';
    box.style.pointerEvents = 'auto';
    return el;
  }

  if (a.type === 'note') {
    const s = userPointToScreen(n, a.x, a.y);
    el.className = 'anno anno-note';
    el.style.left = (s.left - 11) + 'px';
    el.style.top = (s.top - 11) + 'px';
    el.dataset.type = 'note';
    return el;
  }

  if (a.type === 'link') {
    const s = userRectToScreen(n, a.x, a.y, a.w, a.h);
    el.className = 'anno anno-link';
    el.style.left = s.left + 'px'; el.style.top = s.top + 'px';
    el.style.width = s.width + 'px'; el.style.height = s.height + 'px';
    el.dataset.type = 'link';
    el.title = a.url || `跳转到第 ${a.targetPage} 页`;
    const tag = document.createElement('span');
    tag.className = 'anno-link-tag';
    tag.textContent = a.url ? '🔗' : '↗';
    el.appendChild(tag);
    return el;
  }

  if (a.type === 'stamp' || a.type === 'signature' || a.type === 'image') {
    const s = userRectToScreen(n, a.x, a.y, a.w, a.h);
    el.style.left = s.left + 'px'; el.style.top = s.top + 'px';
    el.style.width = s.width + 'px'; el.style.height = s.height + 'px';
    el.dataset.type = a.type;
    if (a.dataUrl) {
      const img = document.createElement('img');
      img.src = a.dataUrl;
      img.className = 'anno-img';
      img.style.width = '100%'; img.style.height = '100%';
      img.draggable = false;
      el.appendChild(img);
    } else if (a.type !== 'image') {
      el.style.border = `${Math.max(1, 1.5 * state.zoom)}px solid ${a.color}`;
      el.style.color = a.color;
      el.style.display = 'flex'; el.style.alignItems = 'center'; el.style.justifyContent = 'center';
      el.style.fontSize = (Math.min(a.h * state.zoom * 0.5, 15)) + 'px';
      el.style.fontWeight = '700'; el.style.letterSpacing = '1px'; el.style.borderRadius = '2px';
      el.textContent = a.text || 'Approved';
    }
    return el;
  }

  return el;
}

function hexA(hex, alpha) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * 拖动/缩放时只更新现有 DOM 的几何属性，绝不重建元素。
 * 重建会导致 <img> 每帧重新解码 base64，造成卡顿与尺寸跳变。
 */
function positionAnnoEl(n, a, el) {
  if (!el) return;

  if (a.type === 'text') {
    const box = el.querySelector('.anno-text');
    if (box) {
      const s = userPointToScreen(n, a.x, a.y);
      box.style.left = s.left + 'px';
      box.style.top = s.top + 'px';
      box.style.width = Math.ceil(a.w * state.zoom) + 'px';
    }
    const cover = el.querySelector('.anno-cover');
    if (cover && a.cover) {
      const cs = userRectToScreen(n, a.cover.x, a.cover.y, a.cover.w, a.cover.h);
      cover.style.left = cs.left + 'px';
      cover.style.top = cs.top + 'px';
      cover.style.width = cs.width + 'px';
      cover.style.height = cs.height + 'px';
    }
    return;
  }

  if (a.type === 'note') {
    const s = userPointToScreen(n, a.x, a.y);
    el.style.left = (s.left - 11) + 'px';
    el.style.top = (s.top - 11) + 'px';
    return;
  }

  if (a.rects) {
    const kids = Array.from(el.children);
    a.rects.forEach((r, i) => {
      const d = kids[i];
      if (!d) return;
      const s = userRectToScreen(n, r.x, r.y, r.w, r.h);
      d.style.left = s.left + 'px';
      d.style.width = s.width + 'px';
      if (a.type === 'highlight') {
        d.style.top = s.top + 'px';
        d.style.height = s.height + 'px';
      } else if (a.type === 'underline') {
        d.style.top = s.top + 'px';
        d.style.height = s.height + 'px';
      } else {
        d.style.top = (s.top + s.height / 2) + 'px';
        d.style.height = '0px';
      }
    });
    return;
  }

  if (a.type === 'ink') {
    const polylines = el.querySelectorAll('polyline');
    a.paths.forEach((path, i) => {
      const pl = polylines[i];
      if (!pl) return;
      pl.setAttribute('points', path.map((p) => {
        const s = userPointToScreen(n, p.x, p.y);
        return `${s.left.toFixed(1)},${s.top.toFixed(1)}`;
      }).join(' '));
    });
    return;
  }

  if (a.type === 'shape') {
    const node = el.querySelector('svg > *');
    if (!node) return;
    const s = userRectToScreen(n, a.x, a.y, a.w, a.h);
    if (a.shape === 'ellipse') {
      node.setAttribute('cx', s.left + s.width / 2);
      node.setAttribute('cy', s.top + s.height / 2);
      node.setAttribute('rx', s.width / 2);
      node.setAttribute('ry', s.height / 2);
    } else if (a.shape === 'line') {
      node.setAttribute('x1', s.left);
      node.setAttribute('y1', s.top);
      node.setAttribute('x2', s.left + s.width);
      node.setAttribute('y2', s.top + s.height);
    } else {
      node.setAttribute('x', s.left);
      node.setAttribute('y', s.top);
      node.setAttribute('width', s.width);
      node.setAttribute('height', s.height);
    }
    return;
  }

  // image / signature / stamp / link：仅改样式，不重建 <img>
  const s = userRectToScreen(n, a.x, a.y, a.w, a.h);
  el.style.left = s.left + 'px';
  el.style.top = s.top + 'px';
  el.style.width = s.width + 'px';
  el.style.height = s.height + 'px';
  // 原生图片的「原位置白底遮盖」是独立兄弟节点（画在下面），位置固定不动，
  // 拖动时不需要、也不应该跟着移动 —— 否则会遮住对象自身的边框。
}

/* ---------------- 选择 / 移动 / 缩放 ---------------- */
const RESIZABLE = {
  image: ['nw', 'ne', 'sw', 'se'], signature: ['nw', 'ne', 'sw', 'se'],
  stamp: ['nw', 'ne', 'sw', 'se'], link: ['nw', 'ne', 'sw', 'se']
};
function handlesFor(a) {
  if (a.type === 'shape' && a.shape !== 'line') return ['nw', 'ne', 'sw', 'se'];
  if (RESIZABLE[a.type]) return RESIZABLE[a.type];
  if (a.type === 'text') return ['e'];
  return [];
}

function selectAnnotation(sel, keep) {
  document.querySelectorAll('.anno-sel').forEach((e) => {
    e.classList.remove('anno-sel');
    e.querySelectorAll('.anno-del, .anno-h, .anno-done, .anno-act').forEach((h) => h.remove());
  });
  selected = sel;
  if (!sel) return;
  const wrap = pageWrap(sel.page);
  const el = wrap && wrap.querySelector(`.anno[data-id="${sel.id}"]`);
  if (!el) return;
  const a = (state.annotations[sel.page] || []).find((x) => x.id === sel.id);
  if (!a) return;
  if (a.erased) { selected = null; return; }     // 已抹除的对象不再提供选中框与按钮
  const visual = a.type === 'text' ? (el.querySelector('.anno-text') || el) : el;
  visual.classList.add('anno-sel');

  const del = document.createElement('button');
  del.className = 'anno-del';
  del.textContent = '×';
  del.title = t('删除');
  del.onpointerdown = (e) => e.stopPropagation();
  del.onclick = (e) => {
    e.stopPropagation();
    // 原生对象（PDF 里本来就有的文字/图片）删除 = 白底抹除；自己插入的对象删除 = 直接移除
    if (a.native) eraseNativeElement(sel.page, sel.id);
    else removeAnnotation(sel.page, sel.id);
  };
  /* 对象类批注把删除按钮移到对象框上方一行，避免压住右上角的缩放手柄 */
  if (OBJECT_TYPES.has(a.type)) { del.style.top = '-32px'; del.style.right = '-6px'; }
  visual.appendChild(del);

  for (const h of handlesFor(a)) {
    const hd = document.createElement('div');
    hd.className = 'anno-h ' + h;
    hd.dataset.handle = h;
    visual.appendChild(hd);
  }

  /* 对象类批注：额外提供操作按钮与「完成」按钮 */
  if (OBJECT_TYPES.has(a.type)) {
    const acts = [];
    if (a.type === 'text') {
      acts.push(actBtn('editObject', t('修改文字'), () => {
        const node = el.querySelector('.anno-text') || el;
        editTextInline(sel.page, a, node, false);
      }));
    }
    if (a.type === 'image' || a.type === 'signature') {
      acts.push(actBtn('replace', t('替换图片'), () => replaceImage(sel.page, sel.id)));
    }
    if (a.type === 'link') {
      acts.push(actBtn('editObject', t('修改链接'), () => openLinkDialog(sel.page, a)));
    }
    if (a.native && a.type === 'text') {
      acts.push(actBtn('trash', t('删除这段文字（白底抹除）'), () => eraseNativeElement(sel.page, sel.id)));
    }
    if (acts.length) {
      const row = document.createElement('div');
      row.className = 'anno-acts';
      acts.forEach((x) => row.appendChild(x));
      visual.appendChild(row);
    }
    const done = document.createElement('button');
    done.className = 'anno-done';
    done.textContent = t('完成');
    done.title = t('完成编辑（Enter / Esc）');
    done.onpointerdown = (e) => e.stopPropagation();
    done.onclick = (e) => { e.stopPropagation(); selectAnnotation(null); };
    visual.appendChild(done);
  }
  void keep;
}

function actBtn(ic, title, onClick) {
  const b = document.createElement('button');
  b.className = 'anno-act';
  b.title = title;
  b.innerHTML = typeof ic === 'string' && ic.length <= 24 && /^[a-zA-Z]+$/.test(ic)
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ACT_ICONS[ic] || ''}</svg>`
    : ic;
  b.onpointerdown = (e) => e.stopPropagation();
  b.onclick = (e) => { e.stopPropagation(); onClick(); };
  return b;
}

const ACT_ICONS = {
  replace: '<path d="M4 8.5h12l-3.2-3.2"/><path d="M20 15.5H8l3.2 3.2"/>',
  editObject: '<path d="M4 20h16"/><path d="M6.5 16.5 15 8l3 3-8.5 8.5H6.5z"/><path d="M13.5 6.5l3 3"/>',
  trash: '<path d="M5 6.5h14"/><path d="M9 6.5V4.5h6v2"/><path d="M7 6.5 8 20h8l1-13.5"/>'
};

export function removeAnnotation(page, id) {
  snapshot();
  state.annotations[page] = (state.annotations[page] || []).filter((a) => a.id !== id);
  selected = null;
  setDirty(true);
  drawOverlay(page);
}

/* ---------------- 指针交互 ---------------- */
function onPointerDown(e) {
  const wrap = e.target.closest('.page-wrap');
  if (!wrap) return;
  const n = Number(wrap.dataset.page);

  // 选区工具条上的按钮自行处理
  if (e.target.closest('.marquee-bar')) return;

  /* ---- 右键拖拽 = 框选删除（编辑模式下，左键保持正常的点选 / 拖动页面） ---- */
  if (e.button === 2) {
    if (state.mode !== 'edit') return;
    e.preventDefault();
    hideTextHover();
    clearMarquee();
    const { x: rx, y: ry } = cssPointInPage(e, wrap);
    drag = { mode: 'marquee', page: n, start: { x: rx, y: ry }, cur: { x: rx, y: ry }, wrap, moved: false };
    return;
  }

  // 选中框上的按钮自行处理（完成 / 删除 / 替换图片 / 修改链接）
  if (e.target.closest('.anno-done, .anno-del, .anno-act')) return;

  // 正在编辑的文本框：完全交给浏览器处理光标定位（不要拦截，否则点不进去）
  if (e.target.closest && e.target.closest('.anno-text.editing')) return;

  // 有选区时先清掉（点选区框/工具条的点击已在上面返回）
  if (marqueeSel && !e.target.closest('.marquee-box')) clearMarquee();

  // 缩放手柄
  const handleEl = e.target.closest('.anno-h');
  if (handleEl) {
    e.preventDefault(); e.stopPropagation();
    const annoNode = handleEl.closest('.anno');
    const id = annoNode.dataset.id;
    const a = (state.annotations[n] || []).find((x) => x.id === id);
    if (!a) return;
    selectAnnotation({ page: n, id });      // 保证编辑态（按钮 / 手柄）始终存在
    drag = {
      mode: 'resize', handle: handleEl.dataset.handle, page: n, id,
      start: cssPointInPage(e, wrap), orig: JSON.parse(JSON.stringify(a)), wrap, el: annoNode, moved: false
    };
    return;
  }

  const annoEl = e.target.closest('.anno');

  /* ---- 浏览模式：链接可直接打开；点图片可选中以便 Ctrl+C 复制；其余只读 ---- */
  if (state.mode !== 'edit') {
    if (annoEl) {
      const a = (state.annotations[n] || []).find((x) => x.id === annoEl.dataset.id);
      if (a && a.type === 'link') { e.preventDefault(); openAnnotationLink(a); }
      return;
    }
    if (e.button === 0) {
      const { x: cx, y: cy } = cssPointInPage(e, wrap);
      const im = imageAt(n, cx, cy);
      if (im) selectImageForCopy(n, im);     // 选中图片（虚线框），Ctrl+C 即可复制
      else clearImagePick();
    }
    return;
  }

  /* ---- 编辑模式 ---- */
  // 先把正在编辑的文本框提交保存（点页面任意别处 = 保存）
  const hadEditor = !!activeEditor;
  if (hadEditor) { commitActiveEditor(); selectAnnotation(null); }

  /* 命中已有对象（优先级最高，避免「插入文字」时点已存在的文本框又新建一个） */
  if (annoEl && !isDrawingTool()) {
    const id = annoEl.dataset.id;
    const a = (state.annotations[n] || []).find((x) => x.id === id);
    if (!a) return;

    if (state.tool === 'editImage' && a.type !== 'image' && a.type !== 'signature') {
      selectAnnotation(null);      // 点了非图片对象：等同于点空白，结束当前图片编辑
      return;
    }
    if (state.tool === 'link' && a.type !== 'link') return;
    // 「插入文字 / 文本框」工具下，点非文本对象不做处理（保持继续在空白处新增文字）
    if (TEXT_TOOLS.has(state.tool) && a.type !== 'text') return;

    // 「编辑文字」划出的原生文本块：点一下就地编辑，光标落在点击处
    if (a.type === 'text' && (a.native || a.blockKey || state.tool === 'editText')) {
      e.preventDefault();
      editTextInline(n, a, annoEl.querySelector('.anno-text') || annoEl, { caret: { x: e.clientX, y: e.clientY } });
      return;
    }

    // 已选中的链接再次点击 -> 打开
    if (a.type === 'link' && selected && selected.id === id && selected.page === n) {
      e.preventDefault();
      openAnnotationLink(a);
      return;
    }
    if (a.type === 'note') { e.preventDefault(); openNoteEditor(n, a); return; }

    // 其余对象（含「插入文字」生成的文本框）：选中 + 直接拖动
    e.preventDefault();
    selectAnnotation({ page: n, id });
    drag = {
      mode: 'move', page: n, id, start: cssPointInPage(e, wrap),
      orig: JSON.parse(JSON.stringify(a)), moved: false, wrap, el: annoEl
    };
    return;
  }

  /* ---- 智能编辑（默认 / 编辑文字 / 框选删除）：
   *   点文字 → 就地编辑；点图片 → 选中图片；
   *   左键拖空白 → 拖动页面；右键拖 / 「框选删除」工具左键拖 → 框选 ---- */
  if (!state.tool || state.tool === 'editText' || state.tool === 'marquee') {
    const { x: cssX0, y: cssY0 } = cssPointInPage(e, wrap);

    if (state.tool !== 'marquee') {
      // 先按下，等抬手时再决定：没拖动 = 点文字/图片；拖动了 = 框选删除
      const blk = blockAt(n, cssX0, cssY0);
      if (blk) {
        e.preventDefault();
        hideTextHover();
        drag = {
          mode: 'smart', page: n, start: { x: cssX0, y: cssY0 }, cur: { x: cssX0, y: cssY0 }, wrap, moved: false,
          target: { kind: 'text', key: blk.key, cx: e.clientX, cy: e.clientY }
        };
        return;
      }
      // 兜底：文本块缓存没命中（例如刚渲染完）时，用文字层直接找整行
      const line = findLineAt(n, e.clientX, e.clientY, wrap);
      if (line && !regionClaimed(n, line.cover)) {
        e.preventDefault();
        hideTextHover();
        drag = {
          mode: 'smart', page: n, start: { x: cssX0, y: cssY0 }, cur: { x: cssX0, y: cssY0 }, wrap, moved: false,
          target: { kind: 'text', line, cx: e.clientX, cy: e.clientY }
        };
        return;
      }
      const im = imageAt(n, cssX0, cssY0);
      if (im) {
        e.preventDefault();
        hideTextHover();
        drag = {
          mode: 'smart', page: n, start: { x: cssX0, y: cssY0 }, cur: { x: cssX0, y: cssY0 }, wrap, moved: false,
          target: { kind: 'image', im }
        };
        return;
      }
    }

    // 空白处：刚提交过文字就不重复动作
    if (hadEditor && !state.tool) return;
    e.preventDefault();
    hideTextHover();

    if (state.tool === 'marquee') {
      // 显式选了「框选删除」：左键拖也能框选
      drag = { mode: 'marquee', page: n, start: { x: cssX0, y: cssY0 }, cur: { x: cssX0, y: cssY0 }, wrap, moved: false };
      return;
    }

    // 默认：左键按住拖动 = 平移页面（和普通 PDF 阅读器一致）
    const vpEl = viewportElRef();
    drag = {
      mode: 'pan', page: n, wrap, startClient: { x: e.clientX, y: e.clientY }, moved: false,
      startScroll: vpEl ? { top: vpEl.scrollTop, left: vpEl.scrollLeft } : { top: 0, left: 0 }
    };
    document.body.classList.add('panning');
    return;
  }

  if (state.tool === 'eraser') {
    const id = annoEl && annoEl.dataset.id;
    if (id) removeAnnotation(n, id);
    return;
  }

  // 编辑图片：点未接管的原生图片 = 选中它；点空白处 = 结束本次编辑（保存）
  if (isObjectTool()) {
    if (annoEl) return;
    const cx = e.clientX;
    const cy = e.clientY;
    pickNativeImage(n, cx, cy, wrap).then((im) => {
      if (im) selectNativeImage(n, im);
      else selectAnnotation(null);
    });
    return;
  }

  e.preventDefault();
  const { x: cssX, y: cssY } = cssPointInPage(e, wrap);

  if (state.tool === 'highlight' || state.tool === 'underline' || state.tool === 'strikeout') {
    const rects = rectsFromSelection(n, wrap);
    if (rects) {
      snapshot();
      push(n, { id: NID(), type: state.tool, rects, color: state.tool === 'highlight' ? state.toolOptions.color : '#e4002b', opacity: state.toolOptions.opacity });
      return;
    }
    drag = { mode: 'rect-anno', page: n, start: { x: cssX, y: cssY }, cur: { x: cssX, y: cssY }, wrap, kind: state.tool };
    return;
  }

  if (state.tool === 'insertText' || state.tool === 'text') {
    if (hadEditor) return;      // 刚才那一下只是「保存上一段文字」，不在这里又冒出一个空文本框
    const u = toUser(n, cssX, cssY);
    const a = {
      id: NID(), type: 'text', x: u.x, y: u.y, text: '',
      fontSize: state.toolOptions.fontSize,
      color: state.toolOptions.fontColor || state.toolOptions.textColor,
      font: state.toolOptions.font || 'hei',
      w: 200
    };
    snapshot();
    push(n, a);
    const el = pageOverlay(n).querySelector(`.anno[data-id="${a.id}"] .anno-text`);
    if (el) editTextInline(n, a, el, { isNew: true, caret: { x: e.clientX, y: e.clientY } });
    return;
  }

  if (state.tool === 'note') {
    const u = toUser(n, cssX, cssY);
    const a = { id: NID(), type: 'note', x: u.x, y: u.y, text: '' };
    snapshot();
    push(n, a);
    openNoteEditor(n, a);
    return;
  }

  if (state.tool === 'ink') {
    drag = { mode: 'ink', page: n, wrap, points: [toUser(n, cssX, cssY)], width: state.toolOptions.strokeWidth };
    return;
  }

  if (state.tool === 'shape') {
    drag = { mode: 'shape', page: n, start: { x: cssX, y: cssY }, cur: { x: cssX, y: cssY }, wrap, shape: state.toolOptions.shape };
    return;
  }

  if (state.tool === 'link') {
    drag = { mode: 'link', page: n, start: { x: cssX, y: cssY }, cur: { x: cssX, y: cssY }, wrap };
    return;
  }

  if (state.tool === 'stamp') { placeStamp(n, toUser(n, cssX, cssY)); return; }
  if (state.tool === 'signature') { placeSignature(n, toUser(n, cssX, cssY)); return; }
}

function isObjectTool() { return state.mode === 'edit' && OBJECT_TOOLS.has(state.tool); }

function isDrawingTool() {
  const cur = state.tool;
  if (state.mode !== 'edit' || !cur) return false;
  return !['eraser', 'editText', 'note', 'editImage', 'link', 'insertText', 'text', 'marquee'].includes(cur);
}

function onPointerMove(e) {
  if (drag && drag.mode === 'pan') return panMove(e);
  if (!drag) { onHoverMove(e); return; }
  const wrap = drag.wrap;
  const { x: cssX, y: cssY } = cssPointInPage(e, wrap);
  const dx = (cssX - drag.start.x) / state.zoom;
  const dy = (cssY - drag.start.y) / state.zoom;
  const o = drag.orig;
  const a = (state.annotations[drag.page] || []).find((x) => x.id === drag.id);

  if (drag.mode === 'smart') {
    // 按在文字/图片上后拖动 = 转为拖动页面（左键保持“普通浏览”手感）
    if (!drag.moved && (Math.abs(cssX - drag.start.x) > 3 || Math.abs(cssY - drag.start.y) > 3)) {
      drag.moved = true;
      drag.mode = 'pan';
      hideTextHover();
      const vpEl = viewportElRef();
      drag.startClient = { x: e.clientX, y: e.clientY };
      drag.startScroll = vpEl ? { top: vpEl.scrollTop, left: vpEl.scrollLeft } : { top: 0, left: 0 };
      document.body.classList.add('panning');
      return;
    }
    return;
  }

  if (drag.mode === 'marquee') {
    drag.cur = { x: cssX, y: cssY };
    if (Math.abs(cssX - drag.start.x) > 3 || Math.abs(cssY - drag.start.y) > 3) drag.moved = true;
    previewRect({ page: drag.page, start: drag.start, cur: drag.cur, mode: 'marquee' });
    return;
  }

  if (drag.mode === 'move') {
    if (!a) return;
    if (a.type === 'text' || a.type === 'note') {
      a.x = o.x + dx; a.y = o.y - dy;
      if (o.cover) a.cover = { x: o.cover.x + dx, y: o.cover.y - dy, w: o.cover.w, h: o.cover.h };
    } else if (a.rects) { a.rects = o.rects.map((r) => ({ ...r, x: r.x + dx, y: r.y - dy })); }
    else { a.x = o.x + dx; a.y = o.y - dy; }
    drag.moved = true;
    positionAnnoEl(drag.page, a, drag.el);
    return;
  }

  if (drag.mode === 'resize') {
    if (!a) return;
    const h = drag.handle;
    const isCorner = h.length === 2;
    const lockRatio = isCorner && (a.type === 'image' || a.type === 'signature') && !e.shiftKey;

    if (lockRatio && o.w > 0 && o.h > 0) {
      // 按「对角线投影」等比缩放：沿对角线拖拽放大、垂直方向拖拽几乎不变，手感平滑
      const sx = h.includes('e') ? 1 : -1;
      const sy = h.includes('s') ? 1 : -1;
      const k = (dx * sx * o.w + dy * sy * o.h) / (o.w * o.w + o.h * o.h);
      const ratio = o.h / o.w;
      let w = Math.max(MIN_SIZE, o.w * (1 + k));
      let hh = w * ratio;
      if (hh < MIN_SIZE) { hh = MIN_SIZE; w = hh / ratio; }
      a.w = w; a.h = hh;
      a.x = h.includes('w') ? o.x + (o.w - w) : o.x;
      a.y = h.includes('s') ? o.y + (o.h - hh) : o.y;
    } else {
      let w = o.w, hh = o.h;
      if (h.includes('e')) w = o.w + dx;
      if (h.includes('w')) w = o.w - dx;
      if (h.includes('n')) hh = o.h - dy;      // 上边下移 => 高度减小
      if (h.includes('s')) hh = o.h + dy;      // 下边下移 => 高度增大
      w = Math.max(MIN_SIZE, w);
      if (a.type !== 'text') hh = Math.max(MIN_SIZE, hh);
      a.w = w;
      if (a.type !== 'text') a.h = hh;
      a.x = h.includes('w') ? o.x + (o.w - w) : o.x;
      if (a.type !== 'text') a.y = h.includes('s') ? o.y + (o.h - hh) : o.y;
      else a.y = o.y;
    }
    drag.moved = true;
    positionAnnoEl(drag.page, a, drag.el);
    return;
  }

  if (drag.mode === 'rect-anno' || drag.mode === 'shape' || drag.mode === 'link') {
    drag.cur = { x: cssX, y: cssY };
    previewRect(drag);
    return;
  }

  if (drag.mode === 'ink') {
    const prev = drag.points[drag.points.length - 1];
    const u = toUser(drag.page, cssX, cssY);
    if (Math.hypot(u.x - prev.x, u.y - prev.y) > 0.6) { drag.points.push(u); previewInk(drag); }
  }
}

function onPointerUp() {
  if (!drag) { stopPan(); return; }
  const d = drag;
  drag = null;
  removePreview();

  if (d.mode === 'pan') { stopPan(); return; }

  if (d.mode === 'smart') {
    // 没拖动 = 一次普通点击：点文字进入就地编辑，点图片选中图片
    const tg = d.target || {};
    if (tg.kind === 'text') {
      if (tg.key) openTextBlock(d.page, tg.key, { x: tg.cx, y: tg.cy });
      else if (tg.line) openInlineLine(d.page, tg.line, { x: tg.cx, y: tg.cy });
    } else if (tg.kind === 'image') selectNativeImage(d.page, tg.im);
    return;
  }

  if (d.mode === 'marquee') {
    if (!d.moved) { selectAnnotation(null); return; }   // 只是点了一下空白
    const x1 = Math.min(d.start.x, d.cur.x), x2 = Math.max(d.start.x, d.cur.x);
    const y1 = Math.min(d.start.y, d.cur.y), y2 = Math.max(d.start.y, d.cur.y);
    if (x2 - x1 < 6 || y2 - y1 < 6) return;
    setMarquee(d.page, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 });   // 只选区，不直接删
    return;
  }

  if (d.mode === 'move' || d.mode === 'resize') {
    if (d.moved) { snapshot(); setDirty(true); }
    drawOverlay(d.page);
    // 关键：移动 / 缩放结束后保持选中状态，允许继续反复调整，直到点击「完成」
    selectAnnotation({ page: d.page, id: d.id });
    return;
  }
  if (d.mode === 'link') {
    const x1 = Math.min(d.start.x, d.cur.x), x2 = Math.max(d.start.x, d.cur.x);
    const y1 = Math.min(d.start.y, d.cur.y), y2 = Math.max(d.start.y, d.cur.y);
    if (x2 - x1 < 6 || y2 - y1 < 6) return createLinkAt(d.page, d.start, d.cur);
    const tl = toUser(d.page, x1, y1), br = toUser(d.page, x2, y2);
    return createLinkAt(d.page, tl, br);
  }
  if (d.mode === 'rect-anno') {
    const x1 = Math.min(d.start.x, d.cur.x), x2 = Math.max(d.start.x, d.cur.x);
    const y1 = Math.min(d.start.y, d.cur.y), y2 = Math.max(d.start.y, d.cur.y);
    if (x2 - x1 < 4 || y2 - y1 < 4) return toast(t('请拖拽划出标注区域'));
    const tl = toUser(d.page, x1, y1), br = toUser(d.page, x2, y2);
    snapshot();
    push(d.page, {
      id: NID(), type: d.kind,
      rects: [{ x: Math.min(tl.x, br.x), y: Math.min(tl.y, br.y), w: Math.abs(br.x - tl.x), h: Math.abs(br.y - tl.y) }],
      color: d.kind === 'highlight' ? state.toolOptions.color : '#e4002b',
      opacity: state.toolOptions.opacity
    });
    return;
  }
  if (d.mode === 'shape') {
    const x1 = Math.min(d.start.x, d.cur.x), x2 = Math.max(d.start.x, d.cur.x);
    const y1 = Math.min(d.start.y, d.cur.y), y2 = Math.max(d.start.y, d.cur.y);
    if (x2 - x1 < 3 && y2 - y1 < 3) return;
    const tl = toUser(d.page, x1, y1), br = toUser(d.page, x2, y2);
    snapshot();
    push(d.page, {
      id: NID(), type: 'shape', shape: d.shape,
      x: Math.min(tl.x, br.x), y: Math.min(tl.y, br.y),
      w: Math.abs(br.x - tl.x), h: Math.abs(br.y - tl.y),
      color: state.toolOptions.textColor, width: state.toolOptions.strokeWidth / state.zoom, fill: false
    });
    return;
  }
  if (d.mode === 'ink') {
    if (d.points.length < 2) return;
    snapshot();
    push(d.page, { id: NID(), type: 'ink', paths: [d.points], color: state.toolOptions.textColor, width: state.toolOptions.strokeWidth / state.zoom });
  }
}

/* ---------------- 框选删除 ---------------- */
/** 批注在 PDF 用户空间的包围盒 */
function annoBounds(a) {
  if (a.cover) return { x: a.cover.x, y: a.cover.y, w: a.cover.w, h: a.cover.h };
  if (a.rects && a.rects.length) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of a.rects) {
      x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  if (a.type === 'text' || a.type === 'note') {
    const lines = Math.max(1, String(a.text || '').split('\n').length);
    const h = (a.fontSize || 14) * 1.35 * lines;
    return { x: a.x, y: a.y - h, w: Math.max(20, a.w || 100), h };
  }
  return { x: a.x || 0, y: a.y || 0, w: a.w || 0, h: a.h || 0 };
}

/** 矩形是否被框选“罩住”（中心落入，或重叠面积占比 ≥ 35%） */
function marqueeHits(box, r) {
  if (!r || r.w <= 0 || r.h <= 0) return false;
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  if (cx >= box.x1 && cx <= box.x2 && cy >= box.y1 && cy <= box.y2) return true;
  const ox = Math.max(0, Math.min(box.x2, r.x + r.w) - Math.max(box.x1, r.x));
  const oy = Math.max(0, Math.min(box.y2, r.y + r.h) - Math.max(box.y1, r.y));
  const ratio = (ox * oy) / Math.max(1, Math.abs(r.w * r.h));
  return ratio >= 0.35;
}

/* ---------------- 像素级擦除（保证「删干净」） ----------------
 * 文字层 / 图片算子列表都识别不到的内容（矢量图、QR 码、遮罩图、图章底纹…）会残留，
 * 因此再对「框内实际有墨迹的像素」做一次连通域分析，用白底把每一团墨迹盖住。
 */
const INK_CELL = 6;          // 墨迹网格边长（渲染像素，2× 渲染下约 3pt）
const MAX_INK_RECTS = 90;    // 墨迹团数量上限，超过则退化为「整框遮盖」

function pixToUser(vp, x, y) { const p = vp.convertToPdfPoint(x, y); return { x: p[0], y: p[1] }; }
/** {x,y,w,h} -> {x1,y1,x2,y2}（inkRects / coverResidualInk 统一用后者） */
function boxXY(r) { return { x1: r.x, y1: r.y, x2: r.x + r.w, y2: r.y + r.h }; }

/** 把 box 内的墨迹聚成若干矩形（PDF 用户空间），用于生成白底遮盖 */
async function inkRects(page, box) {
  const SCALE = 2;
  let canvas;
  try { canvas = await renderPageToCanvas(page, SCALE); } catch (e) { return []; }
  const docPage = await state.pdfDoc.getPage(page);
  const info = state.pageInfo[page] || { rotate: 0 };
  const vp = docPage.getViewport({ scale: SCALE, rotation: info.rotate || 0 });

  const a1 = vp.convertToViewportPoint(box.x1, box.y1);
  const a2 = vp.convertToViewportPoint(box.x2, box.y2);
  const x0 = Math.max(0, Math.floor(Math.min(a1[0], a2[0])) - 2);
  const y0 = Math.max(0, Math.floor(Math.min(a1[1], a2[1])) - 2);
  const x1 = Math.min(canvas.width, Math.ceil(Math.max(a1[0], a2[0])) + 2);
  const y1 = Math.min(canvas.height, Math.ceil(Math.max(a1[1], a2[1])) + 2);
  const w = x1 - x0, h = y1 - y0;
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 2 || h < 2) return [];

  let data;
  try { data = canvas.getContext('2d').getImageData(x0, y0, w, h).data; } catch (e) { return []; }

  const cols = Math.max(1, Math.ceil(w / INK_CELL));
  const rows = Math.max(1, Math.ceil(h / INK_CELL));
  const ink = new Uint8Array(cols * rows);
  for (let y = 0; y < h; y++) {
    const gy = (y / INK_CELL) | 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i] < 235 || data[i + 1] < 235 || data[i + 2] < 235) ink[gy * cols + ((x / INK_CELL) | 0)] = 1;
    }
  }

  // 膨胀一格再把相邻墨迹并成一团（一行文字的字间距会被合并为一条）
  const dil = new Uint8Array(cols * rows);
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      if (!ink[gy * cols + gx]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = gy + dy, nx = gx + dx;
          if (ny < 0 || nx < 0 || ny >= rows || nx >= cols) continue;
          dil[ny * cols + nx] = 1;
        }
      }
    }
  }

  const label = new Int32Array(cols * rows).fill(-1);
  const boxes = [];
  const stack = [];
  for (let start = 0; start < dil.length; start++) {
    if (!dil[start] || label[start] >= 0) continue;
    const id = boxes.length;
    const bb = { cx0: cols, cy0: rows, cx1: -1, cy1: -1 };
    stack.length = 0; stack.push(start);
    label[start] = id;
    while (stack.length) {
      const cur = stack.pop();
      const cy = (cur / cols) | 0, cx = cur % cols;
      // 只把「真实有墨迹」的格子计入包围盒，避免膨胀把框撑大
      if (ink[cur]) {
        if (cx < bb.cx0) bb.cx0 = cx;
        if (cy < bb.cy0) bb.cy0 = cy;
        if (cx > bb.cx1) bb.cx1 = cx;
        if (cy > bb.cy1) bb.cy1 = cy;
      }
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = cy + dy, nx = cx + dx;
          if (ny < 0 || nx < 0 || ny >= rows || nx >= cols) continue;
          const ni = ny * cols + nx;
          if (!dil[ni] || label[ni] >= 0) continue;
          label[ni] = id; stack.push(ni);
        }
      }
    }
    if (bb.cx1 < 0) continue;
    boxes.push(bb);
  }
  if (!boxes.length) return [];
  if (boxes.length > MAX_INK_RECTS) {
    // 墨迹过于零碎：直接用整框遮盖，保证一定删干净
    const t1 = pixToUser(vp, x0, y0), t2 = pixToUser(vp, x0 + w, y0 + h);
    return [{
      x: Math.min(t1.x, t2.x), y: Math.min(t1.y, t2.y),
      w: Math.abs(t2.x - t1.x), h: Math.abs(t2.y - t1.y)
    }];
  }

  return boxes.map((bb) => {
    const px = x0 + bb.cx0 * INK_CELL - 1;
    const py = y0 + bb.cy0 * INK_CELL - 1;
    const pw = (bb.cx1 - bb.cx0 + 1) * INK_CELL + 2;
    const ph = (bb.cy1 - bb.cy0 + 1) * INK_CELL + 2;
    const t1 = pixToUser(vp, px, py), t2 = pixToUser(vp, px + pw, py + ph);
    return {
      x: Math.min(t1.x, t2.x), y: Math.min(t1.y, t2.y),
      w: Math.abs(t2.x - t1.x), h: Math.abs(t2.y - t1.y)
    };
  });
}

/** 一个矩形是否已被现有白底遮盖覆盖（留 1pt 容差） */
function rectCovered(page, r) {
  const list = state.annotations[page] || [];
  return list.some((a) => {
    if (!a.cover || !(a.erased || a.native || a.type === 'text')) return false;
    const c = a.cover;
    return c.x - 1 <= r.x && c.y - 1 <= r.y
      && c.x + c.w + 1 >= r.x + r.w && c.y + c.h + 1 >= r.y + r.h;
  });
}

/** 追加一片白底遮盖（复用「已抹除的原生文字」这一数据结构，渲染/写盘都无需特殊处理） */
function addCover(page, r) {
  state.annotations[page].push({
    id: NID(), type: 'text', native: true, erased: true,
    x: r.x, y: r.y + r.h, text: '', fontSize: 10, color: '#14161a', font: 'hei',
    w: r.w, cover: { x: r.x, y: r.y, w: r.w, h: r.h }
  });
}

/** 用像素分析补齐框内残留墨迹（保证删干净）；返回新增的遮盖数 */
async function coverResidualInk(page, box) {
  const rects = await inkRects(page, box);
  let n = 0;
  for (const r of rects) {
    if (r.w < 0.5 || r.h < 0.5) continue;
    if (rectCovered(page, r)) continue;
    addCover(page, r);
    n++;
  }
  return n;
}

/* ---------------- 框选删除：选区 + 删除按钮 ---------------- */
let marqueeSel = null;        // { page, css:{x,y,w,h} }
let marqueeBoxEl = null;
let marqueeBarEl = null;

function clearMarquee() {
  if (marqueeBoxEl) { marqueeBoxEl.remove(); marqueeBoxEl = null; }
  if (marqueeBarEl) { marqueeBarEl.remove(); marqueeBarEl = null; }
  marqueeSel = null;
}

/** 记录框选区域并显示「删除 / 取消」按钮（不直接删除） */
function setMarquee(page, cssRect) {
  clearMarquee();
  const overlay = pageOverlay(page);
  if (!overlay) return;
  marqueeSel = { page, css: cssRect };
  renderMarqueeEls(page, overlay, cssRect);
}

/** 把「虚线选区框 + 删除/取消按钮」画到覆盖层上（重建覆盖层后可反复调用） */
function renderMarqueeEls(page, overlay, cssRect) {
  const box = document.createElement('div');
  box.className = 'marquee-box';
  box.style.left = cssRect.x + 'px';
  box.style.top = cssRect.y + 'px';
  box.style.width = cssRect.w + 'px';
  box.style.height = cssRect.h + 'px';
  overlay.appendChild(box);
  marqueeBoxEl = box;

  const bar = document.createElement('div');
  bar.className = 'marquee-bar';
  const tip = document.createElement('span');
  tip.className = 'mq-tip';
  tip.textContent = t('已框选');
  const del = document.createElement('button');
  del.className = 'mq-del';
  del.textContent = t('删除');
  del.onclick = (e) => { e.stopPropagation(); applyMarqueeDelete(); };
  const cancel = document.createElement('button');
  cancel.className = 'mq-cancel';
  cancel.textContent = t('取消');
  cancel.onclick = (e) => { e.stopPropagation(); clearMarquee(); };
  bar.append(tip, del, cancel);
  bar.addEventListener('pointerdown', (e) => e.stopPropagation());
  overlay.appendChild(bar);

  const wrapEl = pageWrap(page);
  const pageW = wrapEl ? wrapEl.clientWidth : 0;
  let left = Math.max(2, cssRect.x);
  if (pageW && left + bar.offsetWidth > pageW - 2) left = Math.max(2, pageW - bar.offsetWidth - 2);
  let top = cssRect.y - bar.offsetHeight - 8;
  if (top < 2) top = cssRect.y + cssRect.h + 8;
  bar.style.left = left + 'px';
  bar.style.top = Math.max(2, top) + 'px';
  marqueeBarEl = bar;
}

/** 执行框选删除（点了「删除」/ 按 Delete 才走到这里） */
async function applyMarqueeDelete() {
  if (!marqueeSel || state.mode !== 'edit') return;
  const page = marqueeSel.page;
  const cssRect = marqueeSel.css;
  const tl = toUser(page, cssRect.x, cssRect.y);
  const br = toUser(page, cssRect.x + cssRect.w, cssRect.y + cssRect.h);
  const box = {
    x1: Math.min(tl.x, br.x), x2: Math.max(tl.x, br.x),
    y1: Math.min(tl.y, br.y), y2: Math.max(tl.y, br.y)
  };

  // 1) 收集命中项
  const list = state.annotations[page] || [];
  const hitAnno = list.filter((a) => !a.erased && marqueeHits(box, annoBounds(a)));
  const hitBlocks = computeTextBlocks(page).filter((b) => !regionClaimed(page, b.cover) && marqueeHits(box, b.cover));
  const hitImages = getPageImagesSync(page).filter((im) => {
    if (!marqueeHits(box, im)) return false;
    return !list.some((x) => x.cover && isSameRect(im, x.cover));
  });

  snapshot();
  if (!state.annotations[page]) state.annotations[page] = [];
  for (const a of hitAnno) {
    if (a.native) {
      a.erased = true;
      if (a.type === 'image' || a.type === 'signature') a.dataUrl = null; else a.text = '';
    } else {
      state.annotations[page] = state.annotations[page].filter((x) => x.id !== a.id);
    }
  }
  for (const b of hitBlocks) {
    addCover(page, padCover(b.cover, b.fontSize));
  }
  for (const im of hitImages) {
    state.annotations[page].push({
      id: NID(), type: 'image', native: true, erased: true, dataUrl: null,
      x: im.x, y: im.y, w: im.w, h: im.h, cover: { x: im.x, y: im.y, w: im.w, h: im.h }
    });
  }

  // 2) 像素级兜底：把算子列表/文字层都识别不到的墨迹（矢量化 QR、遮罩图、底纹…）一并盖掉
  clearMarquee();
  drawOverlay(page);
  toast(t('正在清理框选区域…'));
  let extra = 0;
  try { extra = await coverResidualInk(page, box); } catch (e) { extra = 0; }

  selected = null;
  setDirty(true);
  drawOverlay(page);
  const removed = hitAnno.length + hitBlocks.length + hitImages.length;
  if (!removed && !extra) toast(t('框选范围内没有可删除的内容'));
  else toast(t('已删除框选区域的内容（可 Ctrl+Z 撤销）'), 'ok');
}

/** 文字遮盖框向外扩一点：文字层包围盒比实际字形墨迹略小，会留下「黑点」残留 */
function padCover(c, fontSize) {
  const fs = fontSize || 12;
  const px = Math.max(1, fs * 0.18);
  const py = Math.max(1, fs * 0.22);
  return { x: c.x - px, y: c.y - py, w: c.w + px * 2, h: c.h + py * 2 };
}

/* ---------------- 左键拖动页面 ---------------- */
function panMove(e) {
  const vpEl = viewportElRef();
  if (!vpEl || !drag.startClient) return;
  vpEl.scrollTop = drag.startScroll.top - (e.clientY - drag.startClient.y);
  vpEl.scrollLeft = drag.startScroll.left - (e.clientX - drag.startClient.x);
  drag.moved = true;
}

function stopPan() {
  document.body.classList.remove('panning');
}

/* ---------------- 预览 ---------------- */
let previewEl = null;
function previewRect(d) {
  removePreview();
  const overlay = pageOverlay(d.page);
  const x = Math.min(d.start.x, d.cur.x), y = Math.min(d.start.y, d.cur.y);
  const w = Math.abs(d.cur.x - d.start.x), h = Math.abs(d.cur.y - d.start.y);
  previewEl = document.createElement('div');
  previewEl.style.cssText = `position:absolute;pointer-events:none;left:${x}px;top:${y}px;width:${w}px;height:${h}px;`;
  previewEl.style.border = '1px dashed ' + (d.kind === 'highlight' ? '#e0a500' : (d.mode === 'link' ? '#1a73e8' : '#e4002b'));
  previewEl.style.background = d.kind === 'highlight' ? 'rgba(255,212,0,.3)'
    : (d.mode === 'link' ? 'rgba(26,115,232,.16)'
      : (d.mode === 'marquee' ? 'rgba(228,0,43,.10)' : 'transparent'));
  if (d.mode === 'marquee') previewEl.style.zIndex = '8';
  overlay.appendChild(previewEl);
}
function previewInk(d) {
  removePreview();
  const overlay = pageOverlay(d.page);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const r = d.wrap.getBoundingClientRect();
  svg.setAttribute('width', r.width); svg.setAttribute('height', r.height);
  svg.style.cssText = 'left:0;top:0;pointer-events:none';
  const pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  pl.setAttribute('points', d.points.map((p) => {
    const s = userPointToScreen(d.page, p.x, p.y);
    return `${s.left.toFixed(1)},${s.top.toFixed(1)}`;
  }).join(' '));
  pl.setAttribute('fill', 'none');
  pl.setAttribute('stroke', state.toolOptions.textColor);
  pl.setAttribute('stroke-width', String(Math.max(1, state.toolOptions.strokeWidth)));
  pl.setAttribute('stroke-linecap', 'round');
  svg.appendChild(pl);
  previewEl = svg;
  overlay.appendChild(previewEl);
}
function removePreview() { if (previewEl) { previewEl.remove(); previewEl = null; } }

/* ---------------- 选择区 / 文字命中 ---------------- */
function rectsFromSelection(n, wrap) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  if (!sel.toString().trim()) return null;
  const range = sel.getRangeAt(0);
  const wrapRect = wrap.getBoundingClientRect();
  if (!wrap.contains(range.commonAncestorContainer)) return null;
  const rects = [];
  for (const cr of Array.from(range.getClientRects())) {
    if (cr.width < 1 || cr.height < 1) continue;
    const tl = toUser(n, cr.left - wrapRect.left, cr.top - wrapRect.top);
    const br = toUser(n, cr.left - wrapRect.left + cr.width, cr.top - wrapRect.top + cr.height);
    rects.push({ x: Math.min(tl.x, br.x), y: Math.min(tl.y, br.y), w: Math.abs(br.x - tl.x), h: Math.abs(br.y - tl.y) });
    if (rects.length >= 400) break;
  }
  return rects.length ? rects : null;
}
export function hasSelection() {
  const sel = window.getSelection();
  return !!sel && !sel.isCollapsed && !!sel.toString().trim();
}
export function annotateSelection(kind) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return toast(t('请先选择文本'));
  const node = sel.getRangeAt(0).startContainer;
  const wrap = node.parentElement && node.parentElement.closest('.page-wrap');
  if (!wrap) return toast(t('请选择正文中的文本'));
  const n = Number(wrap.dataset.page);
  const rects = rectsFromSelection(n, wrap);
  if (!rects) return toast(t('未获取到选择区域'));
  snapshot();
  push(n, { id: NID(), type: kind, rects, color: kind === 'highlight' ? state.toolOptions.color : '#e4002b', opacity: state.toolOptions.opacity });
  sel.removeAllRanges();
}

/** 命中页面上的原始文字（借助 pdf.js 文本层） */
/* ---------------- 文本层：行提取 ---------------- */
/** 取文字层中与 seed 同一行（垂直中心相近）的所有 span，按 x 排序 */
function lineSpans(layer, seed) {
  const all = Array.from(layer.querySelectorAll('span')).filter((s) => (s.textContent || '').trim());
  const sb = seed.getBoundingClientRect();
  const cy = sb.top + sb.height / 2;
  const tol = Math.max(4, sb.height * 0.5);
  const band = all.filter((s) => {
    const b = s.getBoundingClientRect();
    return Math.abs((b.top + b.height / 2) - cy) <= tol;
  });
  band.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  return band;
}

/**
 * pdf.js 文字层存在大量相互重叠的 span（如 G / GE / EO / O），
 * 这里按「字符屏幕区间」去重，还原该行的真实文字。
 */
function dedupeLineText(spans) {
  let out = '';
  const covered = [];
  for (const s of spans) {
    const str = s.textContent || '';
    if (!str) continue;
    const b = s.getBoundingClientRect();
    const n = str.length;
    const cw = b.width / n;
    for (let i = 0; i < n; i++) {
      const a0 = b.left + i * cw;
      const a1 = a0 + cw;
      let cov = 0;
      for (const iv of covered) cov += Math.max(0, Math.min(a1, iv[1]) - Math.max(a0, iv[0]));
      if (cov >= (a1 - a0) * 0.6) continue;
      const ch = str[i];
      if (ch === '\n' || ch === '\r') continue;
      out += ch;
      covered.push([a0, a1]);
    }
  }
  return normalizePdfText(out);
}

/** 命中测试：返回点击位置所在的整行文字（含精确覆盖框与字号） */
function findLineAt(n, clientX, clientY, wrap) {
  const layer = wrap.querySelector('.textLayer');
  if (!layer) return null;

  let seed = null;
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    if (el.tagName === 'SPAN' && layer.contains(el) && (el.textContent || '').trim()) { seed = el; break; }
  }
  if (!seed) {
    const r = wrap.getBoundingClientRect();
    const lx = clientX - r.left;
    const ly = clientY - r.top;
    for (const s of layer.querySelectorAll('span')) {
      if (!(s.textContent || '').trim()) continue;
      const b = s.getBoundingClientRect();
      if (lx >= b.left - r.left - 3 && lx <= b.left - r.left + b.width + 3
        && ly >= b.top - r.top - 4 && ly <= b.top - r.top + b.height + 4) { seed = s; break; }
    }
  }
  if (!seed) return null;

  const band = lineSpans(layer, seed);
  const text = normalizePdfText(dedupeLineText(band)).trim();
  if (!text) return null;

  const wr = wrap.getBoundingClientRect();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of band) {
    const b = s.getBoundingClientRect();
    x0 = Math.min(x0, b.left); y0 = Math.min(y0, b.top);
    x1 = Math.max(x1, b.right); y1 = Math.max(y1, b.bottom);
  }
  const css = { x: x0 - wr.left, y: y0 - wr.top, w: x1 - x0, h: y1 - y0 };
  if (css.w < 2 || css.h < 2) return null;
  const fsPx = parseFloat(getComputedStyle(seed).fontSize) || 12;

  const tl = toUser(n, css.x, css.y);
  const br = toUser(n, css.x + css.w, css.y + css.h);
  const ux = Math.min(tl.x, br.x);
  const uy = Math.min(tl.y, br.y);
  const uw = Math.abs(br.x - tl.x);
  const uh = Math.abs(br.y - tl.y);
  return {
    text,
    x: ux,
    y: uy + uh,                    // 文本框左上角（PDF 用户空间，y 向上为负、向下为正）
    w: Math.max(uw, 40),
    fontSize: Math.round(Math.max(6, fsPx / state.zoom) * 10) / 10,
    cover: { x: ux, y: uy, w: uw, h: uh }
  };
}

/* ---------------- 全文本块（编辑文字模式） ----------------
 * 进入「编辑文字」后，把页面里所有文字按「行 + 横向间隔」切成一块块文本区域，
 * 每块都可以直接点开就地编辑；点击空白处自动提交。
 */
const blockCache = new Map();       // page -> { sig, blocks }
let activeEditor = null;            // { commit } 当前正在编辑的文本框

function commitActiveEditor() {
  if (activeEditor) {
    const c = activeEditor.commit;
    activeEditor = null;
    try { c(); } catch (e) { /* 忽略 */ }
  }
}

function blockSig(n) {
  const w = pageWrap(n);
  const layer = w && w.querySelector('.textLayer');
  if (!layer) return '';
  const spans = layer.querySelectorAll('span');
  return `${state.zoom}|${state.rotation}|${spans.length}|${spans.length ? (spans[0].textContent || '').length : 0}`;
}

function computeTextBlocks(n) {
  const wrap = pageWrap(n);
  const layer = wrap && wrap.querySelector('.textLayer');
  if (!layer || !getViewport(n)) return [];
  const sig = blockSig(n);
  const hit = blockCache.get(n);
  if (hit && hit.sig === sig) return hit.blocks;

  const items = [];
  for (const s of layer.querySelectorAll('span')) {
    if (!(s.textContent || '').trim()) continue;
    const b = s.getBoundingClientRect();
    if (b.width < 1 || b.height < 1) continue;
    items.push({ s, b, cy: b.top + b.height / 2, h: b.height });
  }
  const blocks = [];
  if (items.length) {
    items.sort((a, b) => a.cy - b.cy || a.b.left - b.b.left);

    // 1) 按垂直中心聚成「行」
    const lines = [];
    for (const it of items) {
      let target = null;
      let bestD = Infinity;
      const tol = Math.max(4, it.h * 0.5);
      for (const l of lines) {
        const d = Math.abs(l.cy - it.cy);
        if (d <= tol && d < bestD) { target = l; bestD = d; }
      }
      if (target) {
        target.cy = (target.cy * target.members.length + it.cy) / (target.members.length + 1);
        target.members.push(it);
      } else {
        lines.push({ cy: it.cy, members: [it] });
      }
    }

    // 2) 同一行里按横向间隔切成若干「块」
    const wr = wrap.getBoundingClientRect();
    for (const l of lines) {
      l.members.sort((a, b) => a.b.left - b.b.left);
      const runs = [];
      let cur = null;
      let right = -Infinity;
      for (const it of l.members) {
        const gapTol = Math.max(14, it.h * 1.8);
        if (cur && it.b.left - right > gapTol) { runs.push(cur); cur = null; }
        if (!cur) { cur = [it]; right = it.b.right; }
        else { cur.push(it); right = Math.max(right, it.b.right); }
      }
      if (cur) runs.push(cur);

      for (const run of runs) {
        const text = normalizePdfText(dedupeLineText(run.map((m) => m.s))).trim();
        if (!text) continue;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const m of run) {
          x0 = Math.min(x0, m.b.left); y0 = Math.min(y0, m.b.top);
          x1 = Math.max(x1, m.b.right); y1 = Math.max(y1, m.b.bottom);
        }
        const css = { x: x0 - wr.left, y: y0 - wr.top, w: x1 - x0, h: y1 - y0 };
        if (css.w < 3 || css.h < 3) continue;
        const tl = toUser(n, css.x, css.y);
        const br = toUser(n, css.x + css.w, css.y + css.h);
        const ux = Math.min(tl.x, br.x);
        const uy = Math.min(tl.y, br.y);
        const uw = Math.abs(br.x - tl.x);
        const uh = Math.abs(br.y - tl.y);
        if (uw < 2 || uh < 2) continue;
        const fsPx = parseFloat(getComputedStyle(run[0].s).fontSize) || 12;
        blocks.push({
          key: `b${n}_${Math.round(ux)}_${Math.round(uy)}_${Math.round(uw)}_${Math.round(uh)}`,
          text,
          x: ux, y: uy + uh,
          w: Math.max(uw, 40),
          fontSize: Math.round(Math.max(6, fsPx / state.zoom) * 10) / 10,
          cover: { x: ux, y: uy, w: uw, h: uh },
          css
        });
      }
    }
  }
  blockCache.set(n, { sig, blocks });
  return blocks;
}

/* ---------------- 悬停高亮 / 智能命中 ---------------- */
let hoverEl = null;
let hoverKey = '';
let hoverOv = null;
let hoverTimer = 0;

/** 在编辑模式、无工具时，鼠标划过文字给一层浅色提示，暗示“点一下即可编辑” */
function updateTextHover(n, cssX, cssY) {
  const overlay = pageOverlay(n);
  if (!overlay) return;
  const blk = blockAt(n, cssX, cssY);
  if (hoverOv && hoverOv !== overlay) { hoverOv.style.cursor = ''; hoverOv = null; }
  hoverOv = overlay;
  overlay.style.cursor = blk ? 'text' : 'grab';
  if (!blk) { if (hoverEl) { hoverEl.remove(); hoverEl = null; } hoverKey = ''; return; }
  if (hoverKey === blk.key && hoverEl) return;
  if (hoverEl) { hoverEl.remove(); hoverEl = null; }
  hoverEl = document.createElement('div');
  hoverEl.className = 'text-hover';
  hoverEl.style.left = blk.css.x + 'px';
  hoverEl.style.top = blk.css.y + 'px';
  hoverEl.style.width = blk.css.w + 'px';
  hoverEl.style.height = blk.css.h + 'px';
  overlay.appendChild(hoverEl);
  hoverKey = blk.key;
}
function hideTextHover() {
  if (hoverEl) { hoverEl.remove(); hoverEl = null; }
  if (hoverOv) { hoverOv.style.cursor = ''; hoverOv = null; }
  hoverKey = '';
}

/** 鼠标移动（未拖拽时）：编辑模式无工具 -> 划过文字给一层浅色提示 */
function onHoverMove(e) {
  if (state.mode !== 'edit' || state.tool) { if (hoverEl) hideTextHover(); return; }
  const tgt = e.target;
  const wrap = tgt && tgt.closest ? tgt.closest('.page-wrap') : null;
  if (!wrap) { if (hoverEl) hideTextHover(); return; }
  const now = Date.now();
  if (now - hoverTimer < 60) return;
  hoverTimer = now;
  const n = Number(wrap.dataset.page);
  const { x, y } = cssPointInPage(e, wrap);
  updateTextHover(n, x, y);
}

/** 命中测试：返回 (cssX,cssY) 处的文本块（已编辑/已抹除的块由批注本身接管，不再返回） */
function blockAt(n, cssX, cssY, tol = 3) {
  const blocks = computeTextBlocks(n);
  for (const b of blocks) {
    if (cssX < b.css.x - tol || cssX > b.css.x + b.css.w + tol) continue;
    if (cssY < b.css.y - tol || cssY > b.css.y + b.css.h + tol) continue;
    if (regionClaimed(n, b.cover)) continue;
    return b;
  }
  return null;
}

/** 命中测试：返回 (cssX,cssY) 处的原生图片矩形（同步，命中已接管的图不返回） */
function imageAt(n, cssX, cssY) {
  const images = getPageImagesSync(n);
  if (!images.length) return null;
  const u = toUser(n, cssX, cssY);
  const claimed = (state.annotations[n] || [])
    .filter((a) => a.type === 'image' && a.native && a.cover)
    .map((a) => a.cover);
  for (let i = images.length - 1; i >= 0; i--) {
    const im = images[i];
    if (!(u.x >= im.x && u.x <= im.x + im.w && u.y >= im.y && u.y <= im.y + im.h)) continue;
    if (claimed.some((c) => isSameRect(im, c))) continue;
    return im;
  }
  return null;
}

/** 用文字层整行信息就地编辑（文本块缓存未命中时的兜底路径） */
function openInlineLine(n, line, caret) {
  commitActiveEditor();
  if (regionClaimed(n, line.cover)) return;
  snapshot();
  const a = push(n, {
    id: NID(), type: 'text', native: true,
    x: line.x, y: line.y, text: line.text,
    fontSize: line.fontSize, color: '#14161a', font: 'hei',
    w: line.w, cover: { ...line.cover }
  });
  const el = pageOverlay(n).querySelector(`.anno[data-id="${a.id}"] .anno-text`);
  if (el) editTextInline(n, a, el, { caret });
}

/** 打开（或重新打开）一个文本块进行就地编辑 */
function openTextBlock(n, key, caret) {
  commitActiveEditor();
  const b = (blockCache.get(n) || { blocks: [] }).blocks.find((x) => x.key === key);
  if (!b) return;
  const overlay = pageOverlay(n);
  if (!overlay) return;

  const exist = (state.annotations[n] || []).find((a) => a.blockKey === key);
  if (exist) {
    if (exist.erased) { toast(t('这段文字已被删除')); return; }
    const el2 = overlay.querySelector(`.anno[data-id="${exist.id}"] .anno-text`);
    if (el2) editTextInline(n, exist, el2, { caret });
    return;
  }
  if (regionClaimed(n, b.cover)) return;
  snapshot();
  const a = push(n, {
    id: NID(), type: 'text', native: true, blockKey: key,
    x: b.x, y: b.y, text: b.text,
    fontSize: b.fontSize, color: '#14161a', font: 'hei',
    w: b.w, cover: { ...b.cover }
  });
  const el = pageOverlay(n).querySelector(`.anno[data-id="${a.id}"] .anno-text`);
  if (el) editTextInline(n, a, el, { caret });
}

/* ---------------- PDF 原生图片 ---------------- */
/** 命中测试：只找页面内原生图片（PDF 里原本就有的图） */
async function pickNativeImage(n, clientX, clientY, wrap) {
  let images = [];
  try { images = await getPageImages(n); } catch (e) { images = []; }
  if (!images.length) return null;
  const r = wrap.getBoundingClientRect();
  const u = toUser(n, clientX - r.left, clientY - r.top);

  // 已被「覆盖式图片对象」接管的原生图不能再被拾取，否则每点一次就会复制出一张原尺寸图
  const claimed = (state.annotations[n] || [])
    .filter((a) => a.type === 'image' && a.native && a.cover)
    .map((a) => a.cover);

  for (let i = images.length - 1; i >= 0; i--) {
    const im = images[i];
    if (!(u.x >= im.x && u.x <= im.x + im.w && u.y >= im.y && u.y <= im.y + im.h)) continue;
    // 该原生图已被「覆盖式对象」接管（cover 即原图矩形），不能再拾取，否则会复制出一张原尺寸图
    if (claimed.some((c) => isSameRect(im, c))) continue;
    return im;
  }
  return null;
}

/** 两个矩形是否为同一块（容差 1.5pt，避免浮点误差） */
function isSameRect(a, b, tol = 1.5) {
  return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol
    && Math.abs(a.w - b.w) <= tol && Math.abs(a.h - b.h) <= tol;
}

/** 选中 PDF 原生图片：转成「覆盖式图片对象」，可替换 / 移动 / 删除 */
async function selectNativeImage(n, im) {
  if (state.mode !== 'edit' || !state.pdfDoc) return;
  let dataUrl = null;
  try { dataUrl = await cropNativeImage(n, im); } catch (e) { dataUrl = null; }
  const a = push(n, {
    id: NID(), type: 'image', native: true,
    x: im.x, y: im.y, w: im.w, h: im.h,
    dataUrl, mime: 'image/png',
    cover: { x: im.x, y: im.y, w: im.w, h: im.h }
  });
  selectAnnotation({ page: n, id: a.id });
  toast(t('已选中图片：可拖动移动、替换或删除，改完点「完成」'), 'ok');
}

/** 从渲染结果中裁剪出原生图片像素（用于移动 / 替换 / 复制时重放） */
async function cropNativeImage(n, rect, scale = 2) {
  const canvas = await renderPageToCanvas(n, scale);
  const page = await state.pdfDoc.getPage(n);
  const info = state.pageInfo[n] || { rotate: 0 };
  const vp = page.getViewport({ scale, rotation: info.rotate || 0 });
  const p1 = vp.convertToViewportPoint(rect.x, rect.y);
  const p2 = vp.convertToViewportPoint(rect.x + rect.w, rect.y + rect.h);
  const x = Math.max(0, Math.min(p1[0], p2[0]));
  const y = Math.max(0, Math.min(p1[1], p2[1]));
  const w = Math.min(canvas.width - x, Math.abs(p2[0] - p1[0]));
  const h = Math.min(canvas.height - y, Math.abs(p2[1] - p1[1]));
  if (w < 2 || h < 2) return null;
  const out = document.createElement('canvas');
  out.width = Math.round(w);
  out.height = Math.round(h);
  out.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

/** 删除原生元素：保留白色遮盖（视觉上抹除），不改变其它内容 */
async function eraseNativeElement(page, id) {
  const a = (state.annotations[page] || []).find((x) => x.id === id);
  if (!a || !a.native) return;
  snapshot();
  a.erased = true;
  if (a.type === 'image' || a.type === 'signature') a.dataUrl = null;
  else a.text = '';
  if (a.cover) a.cover = padCover(a.cover, a.fontSize);
  setDirty(true);
  selected = null;
  drawOverlay(page);
  // 文字层包围盒通常比字形墨迹略小，逐一补掉残留墨迹（避免原位置留黑点）
  if (a.cover) {
    try { if (await coverResidualInk(page, boxXY(a.cover))) drawOverlay(page); } catch (e) { /* 忽略 */ }
  }
  toast(t('已删除该元素（可用 Ctrl+Z 撤销）'), 'ok');
}

/** 某个文字区域是否已经被现有批注接管（含被抹除的），避免再点一次又生成一份原文 */
function regionClaimed(n, box) {
  return (state.annotations[n] || []).some((a) => {
    if (!a.cover) return false;
    const ix = Math.max(0, Math.min(a.cover.x + a.cover.w, box.x + box.w) - Math.max(a.cover.x, box.x));
    const iy = Math.max(0, Math.min(a.cover.y + a.cover.h, box.y + box.h) - Math.max(a.cover.y, box.y));
    const inter = ix * iy;
    const area = Math.min(Math.abs(a.cover.w * a.cover.h), Math.abs(box.w * box.h));
    return area > 0 && inter / area > 0.5;
  });
}

/* ---------------- 文本 / 便签 ---------------- */
/**
 * 就地编辑文本。
 * opts: { isNew?:boolean, caret?:{x,y} }  caret 为点击位置（client 坐标），用于把光标落到点上，
 *        避免「全选」造成的整块高亮，让用户像在编辑器里一样直接增删文字。
 */
function editTextInline(n, a, el, opts = {}) {
  const o = typeof opts === 'boolean' ? { isNew: opts } : (opts || {});
  const minW = el.style.width || '';
  hideTextHover();
  el.classList.add('editing');
  el.style.whiteSpace = 'pre';       // 编辑时单行增长，不换行
  el.style.width = 'auto';
  el.style.minWidth = minW || '24px';
  el.style.fontFamily = fontCss(a.font);
  el.style.fontSize = ((a.fontSize || 14) * state.zoom) + 'px';
  el.style.color = a.color || '#14161a';
  el.contentEditable = 'true';
  el.style.pointerEvents = 'auto';
  el.focus();

  const sel = window.getSelection();
  const placeCaret = () => {
    let done2 = false;
    if (o.caret && document.caretRangeFromPoint) {
      try {
        const r = document.caretRangeFromPoint(o.caret.x, o.caret.y);
        if (r && el.contains(r.startContainer)) {
          const r2 = document.createRange();
          r2.setStart(r.startContainer, r.startOffset);
          r2.collapse(true);
          sel.removeAllRanges();
          sel.addRange(r2);
          done2 = true;
        }
      } catch (e) { /* 忽略，退回到末尾 */ }
    }
    if (!done2) {
      const r2 = document.createRange();
      r2.selectNodeContents(el);
      r2.collapse(false);          // 光标置于文字末尾
      sel.removeAllRanges();
      sel.addRange(r2);
    }
  };
  placeCaret();
  let done = false;

  const commit = () => {
    if (done) return;
    done = true;
    if (activeEditor && activeEditor.commit === commit) activeEditor = null;
    closeTextBar();
    el.contentEditable = 'false';
    el.classList.remove('editing');
    el.classList.remove('empty');
    // 量宽度必须仍在「单行 + 不限最小宽度」状态下进行。
    // 注意：全局 CSS 是 box-sizing: border-box，渲染时 `width` 指的是「含内边距的边框盒」，
    // 所以这里直接取编辑态（width:auto，绝对定位收缩到内容）的边框盒宽度，
    // 不再减去 padding —— 否则存下来的宽度会窄 8px，提交后就把最后几个字挤到第二行。
    el.style.whiteSpace = 'pre';
    el.style.width = 'auto';
    el.style.minWidth = '0';
    const grown = Math.max(24, Math.ceil(el.getBoundingClientRect().width)) / state.zoom;
    el.style.whiteSpace = 'pre-wrap';
    el.style.width = minW;
    el.style.minWidth = '';
    const txt = el.innerText.replace(/\n$/, '');
    // 宽度变化也要落盘：否则「什么都没改」的旧文本框会一直保持过窄的宽度而换行
    const changed = txt !== a.text || Math.abs(grown - (a.w || 0)) > 0.5;
    if (changed) {
      if (!txt.trim()) {
        if (o.isNew) { removeSilent(n, a.id); return; }
        // 把内容删空 = 删除这段文字：保留白底遮盖，不再留一个空文本框
        snapshot();
        a.text = '';
        a.erased = true;
        if (a.cover) a.cover = padCover(a.cover, a.fontSize);
        setDirty(true);
        selected = null;
        drawOverlay(n);
        // 字形墨迹可能超出文字层包围盒，逐一补掉残留（避免原位置留黑点）
        if (a.cover) {
          const box = a.cover;
          coverResidualInk(n, boxXY(box))
            .then((added) => { if (added) drawOverlay(n); })
            .catch(() => {});
        }
        return;
      }
      snapshot();
      a.text = txt;
      a.erased = false;
      a.w = grown;
      setDirty(true);
    }
    drawOverlay(n);
  };
  el.addEventListener('blur', commit, { once: true });
  activeEditor = { commit, page: n };

  // 空状态下给个占位提示
  if (!a.text) { el.classList.add('empty'); el.dataset.ph = t('输入文字…'); }
  el.addEventListener('input', () => {
    el.classList.toggle('empty', !el.innerText.trim());
  });

  // 浮动工具条：4 种字体 / 字号 / 颜色 / 完成
  openTextBar(n, a, el, () => el.blur());

  el.addEventListener('paste', (ev) => {
    ev.preventDefault();
    const txt = (ev.clipboardData || window.clipboardData).getData('text/plain');
    if (txt) document.execCommand('insertText', false, txt);
  });
  el.addEventListener('keydown', (ev) => {
    if (ev.isComposing || ev.keyCode === 229) return;   // 中文输入法组词中
    if (ev.key === 'Escape') { ev.preventDefault(); el.blur(); }
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); el.blur(); }
  });
}

/* ---------------- 插入文字浮动工具条 ---------------- */
let textBar = null;
function closeTextBar() { if (textBar) { textBar.remove(); textBar = null; } }

function openTextBar(n, a, el, onDone) {
  closeTextBar();
  const overlay = pageOverlay(n);
  if (!overlay) return;

  const bar = document.createElement('div');
  bar.className = 'txt-bar';
  // 不抢走正文字框的焦点，也不把点击冒泡成“页面点击”
  bar.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
  bar.addEventListener('mousedown', (e) => e.stopPropagation());

  // —— 字体 ——
  const fl = document.createElement('span'); fl.className = 'txt-lbl'; fl.textContent = t('字体');
  bar.appendChild(fl);
  const fgroup = document.createElement('span'); fgroup.className = 'txt-group';
  for (const f of TEXT_FONTS) {
    const b = document.createElement('button');
    b.className = 'txt-f' + ((a.font || 'hei') === f.id ? ' active' : '');
    b.textContent = t(f.name);
    b.style.fontFamily = f.css;
    b.title = t(f.name);
    b.onclick = () => {
      a.font = f.id;
      el.style.fontFamily = f.css;
      fgroup.querySelectorAll('.txt-f').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      setDirty(true);
    };
    fgroup.appendChild(b);
  }
  bar.appendChild(fgroup);

  // —— 字号 ——
  const sl = document.createElement('span'); sl.className = 'txt-lbl'; sl.textContent = t('字号');
  bar.appendChild(sl);
  const sgroup = document.createElement('span'); sgroup.className = 'txt-group';
  const cur = document.createElement('span'); cur.className = 'txt-size';
  const showSize = (v) => { cur.textContent = String(Math.round(v)); };
  const setSize = (v) => {
    a.fontSize = v;
    showSize(v);
    el.style.fontSize = (v * state.zoom) + 'px';
    setDirty(true);
  };
  const step = (dir) => {
    const sizes = TEXT_SIZES;
    let i = 0, best = Infinity;
    sizes.forEach((s, k) => { const d = Math.abs(s - (a.fontSize || 14)); if (d < best) { best = d; i = k; } });
    const ni = Math.max(0, Math.min(sizes.length - 1, i + dir));
    setSize(sizes[ni]);
  };
  const mkStep = (txt, dir) => {
    const b = document.createElement('button');
    b.className = 'txt-step';
    b.textContent = txt;
    b.onclick = () => step(dir);
    return b;
  };
  showSize(a.fontSize || 14);
  sgroup.appendChild(mkStep('A-', -1));
  sgroup.appendChild(cur);
  sgroup.appendChild(mkStep('A+', 1));
  bar.appendChild(sgroup);

  // —— 颜色 ——
  const cl = document.createElement('span'); cl.className = 'txt-lbl'; cl.textContent = t('颜色');
  bar.appendChild(cl);
  const cgroup = document.createElement('span'); cgroup.className = 'txt-group txt-colors';
  for (const c of TEXT_COLORS) {
    const d = document.createElement('button');
    d.className = 'txt-c' + ((a.color || '#14161a') === c ? ' active' : '');
    d.style.background = c;
    d.title = c;
    d.onclick = () => {
      a.color = c;
      el.style.color = c;
      cgroup.querySelectorAll('.txt-c').forEach((x) => x.classList.remove('active'));
      d.classList.add('active');
      setDirty(true);
    };
    cgroup.appendChild(d);
  }
  bar.appendChild(cgroup);

  // —— 完成 ——
  const done = document.createElement('button');
  done.className = 'txt-done';
  done.textContent = t('完成');
  done.onclick = () => onDone();
  bar.appendChild(done);

  overlay.appendChild(bar);
  // 定位在文本框上方；贴顶时放到下方；靠右时左移防止溢出页面
  const bx = el.offsetLeft;
  const by = el.offsetTop;
  const bh = bar.offsetHeight || 34;
  const pageW = wrapperWidth(overlay);
  let top = by - bh - 6;
  if (top < 2) top = by + el.offsetHeight + 6;
  let left = Math.max(2, bx);
  if (pageW && left + bar.offsetWidth > pageW - 2) left = Math.max(2, pageW - bar.offsetWidth - 2);
  bar.style.left = left + 'px';
  bar.style.top = Math.max(2, top) + 'px';
  textBar = bar;
}

function wrapperWidth(overlay) {
  const w = overlay.closest('.page-wrap');
  return w ? w.clientWidth : 0;
}

function removeSilent(page, id) {
  state.annotations[page] = (state.annotations[page] || []).filter((a) => a.id !== id);
  drawOverlay(page);
}

function openNoteEditor(n, a) {
  const ta = document.createElement('textarea');
  ta.value = a.text || '';
  ta.placeholder = t('输入便签内容…');
  const body = document.createElement('div');
  body.innerHTML = '<div class="field"><label>' + t('便签内容') + '</label></div>';
  body.querySelector('.field').appendChild(ta);
  openModal({
    title: t('便签'), body,
    footer: [
      { label: t('删除'), kind: 'btn-ghost', onClick: ({ close }) => { removeAnnotation(n, a.id); close(); } },
      { label: t('保存'), kind: 'btn-primary', onClick: ({ close }) => { snapshot(); a.text = ta.value; setDirty(true); drawOverlay(n); close(); } }
    ]
  });
}

/* ---------------- 图章 / 签名 / 图片 ---------------- */
let stampPreset = { text: null, color: '#12a150' };

const STAMP_PRESETS = [
  { key: '已批准', color: '#12a150' },
  { key: '已审核', color: '#e4002b' },
  { key: '草稿', color: '#e08d00' },
  { key: '机密', color: '#b70021' },
  { key: '作废', color: '#5b6472' },
  { key: '仅供内部使用', color: '#1565c0' }
];

export function openStampMenu(anchor) {
  openMenu(anchor, [
    { title: t('选择图章样式后，在页面上点击放置') },
    ...STAMP_PRESETS.map((p) => ({ label: t(p.key), icon: 'stamp', onClick: () => { stampPreset = { text: t(p.key), color: p.color }; setTool('stamp', true); } })),
    { sep: true },
    { label: t('自定义图章…'), icon: 'tools', onClick: () => openCustomStamp() }
  ], { minWidth: 240 });
}

function openCustomStamp() {
  const body = document.createElement('div');
  body.innerHTML = field(t('图章文字'), '<input type="text" id="cs-text" value="' + t('已批准') + '" />')
    + field(t('颜色'), '<input type="color" id="cs-color" value="#e4002b" style="width:60px;height:34px;padding:2px" />');
  openModal({
    title: t('自定义图章'), body,
    footer: [
      { label: t('取消'), kind: 'btn-ghost', onClick: ({ close }) => close() },
      {
        label: t('使用'), kind: 'btn-primary', onClick: ({ close, body: b }) => {
          stampPreset = { text: b.querySelector('#cs-text').value || t('已批准'), color: b.querySelector('#cs-color').value };
          setTool('stamp', true);
          close();
        }
      }
    ]
  });
}

function placeStamp(n, u) {
  const info = state.pageInfo[n] || state.defaultSize;
  const vw = info.view[2] - info.view[0];
  const w = Math.max(80, vw * 0.18);
  const h = w * 0.34;
  snapshot();
  push(n, { id: NID(), type: 'stamp', x: u.x - w / 2, y: u.y - h / 2, w, h, text: stampPreset.text || t('已批准'), color: stampPreset.color });
  setTool(null);
}

function placeSignature(n, u) {
  openModal({
    title: t('添加签名'),
    body: '<div class="hint">' + t('选择签名方式：手写签名或导入签名图片。') + '</div>',
    footer: [
      { label: t('导入图片'), kind: 'btn-ghost', onClick: ({ close }) => { close(); pickImageFor(n, u, 'signature'); } },
      { label: t('手写签名'), kind: 'btn-primary', onClick: ({ close }) => { close(); openDrawSignature(n, u); } }
    ]
  });
}

/* ---- 图片 ---- */

/** 点击页面后选择文件（签名导入用） */
export function pickImageFor(n, u, type = 'image') {
  const inp = document.getElementById('hidden-file');
  inp.value = '';
  inp.onchange = () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => insertImageAnnotation(n, u, rd.result, f.type, type);
    rd.readAsDataURL(f);
  };
  inp.click();
}

/** 【添加图片】按钮：直接打开文件夹选择，插入到当前页中央 */
export function pickAndInsertImage() {
  if (!state.pdfDoc) return toast(t('请先打开 PDF'));
  const inp = document.getElementById('hidden-file');
  inp.value = '';
  inp.onchange = async () => {
    const files = Array.from(inp.files || []).filter((f) => /^image\//.test(f.type));
    if (!files.length) return;
    if (state.mode !== 'edit') setMode('edit');
    let offset = 0;
    for (const f of files) {
      const url = await new Promise((res) => {
        const rd = new FileReader();
        rd.onload = () => res(rd.result);
        rd.readAsDataURL(f);
      });
      insertImageToCurrentPage(url, f.type, offset);
      offset += 26;
    }
    toast(t('已插入 {n} 张图片，可拖动或拉伸调整', { n: files.length }), 'ok');
  };
  inp.click();
}

export function insertImageAnnotation(n, u, dataUrl, mime, type = 'image', autoSelect = true) {
  const img = new Image();
  img.onload = () => {
    const info = state.pageInfo[n] || state.defaultSize;
    const vw = info.view[2] - info.view[0];
    const vh = info.view[3] - info.view[1];
    let w = Math.min(vw * 0.45, (img.naturalWidth / 96) * 72);
    let h = w * (img.naturalHeight / img.naturalWidth);
    if (h > vh * 0.5) { h = vh * 0.5; w = h * (img.naturalWidth / img.naturalHeight); }
    snapshot();
    const a = push(n, { id: NID(), type, x: u.x - w / 2, y: u.y - h / 2, w, h, dataUrl, mime: mime || 'image/png' });
    setTool(null);
    if (autoSelect) selectAnnotation({ page: n, id: a.id });
  };
  img.src = dataUrl;
}

/** 在当前页中央插入图片（粘贴 / 添加图片按钮） */
export function insertImageToCurrentPage(dataUrl, mime, offset = 0) {
  const n = state.currentPage;
  const info = state.pageInfo[n] || state.defaultSize;
  const cx = (info.view[0] + info.view[2]) / 2;
  const cy = (info.view[1] + info.view[3]) / 2 - offset;
  insertImageAnnotation(n, { x: cx, y: cy }, dataUrl, mime, 'image');
}

function onPaste(e) {
  if (!state.pdfDoc) return;
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const it of items) {
    if (it.type && it.type.indexOf('image') === 0) {
      const f = it.getAsFile();
      if (!f) continue;
      e.preventDefault();
      const rd = new FileReader();
      rd.onload = () => {
        if (state.mode !== 'edit') setMode('edit');
        insertImageToCurrentPage(rd.result, f.type);
      };
      rd.readAsDataURL(f);
      return;
    }
  }
}

/* ---- 替换图片内容 ---- */
export function replaceImage(page, id) {
  const inp = document.getElementById('hidden-file');
  inp.value = '';
  inp.onchange = () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      const a = (state.annotations[page] || []).find((x) => x.id === id);
      if (!a) return;
      const probe = new Image();
      probe.onload = () => {
        snapshot();
        a.dataUrl = rd.result;
        a.mime = f.type || 'image/png';
        if (probe.naturalWidth > 0) a.h = a.w * (probe.naturalHeight / probe.naturalWidth);
        setDirty(true);
        drawOverlay(page);
        selectAnnotation({ page, id });
        toast(t('图片已替换'), 'ok');
      };
      probe.src = rd.result;
    };
    rd.readAsDataURL(f);
  };
  inp.click();
}

/* ---- 链接 ---- */
export function openAnnotationLink(a) {
  if (a.url) { window.pdfmini.app.openExternal(a.url); return; }
  if (a.targetPage) goToPage(a.targetPage, { smooth: true });
}

function createLinkAt(page, a, b) {
  let x = Math.min(a.x, b.x);
  let y = Math.min(a.y, b.y);
  let w = Math.abs(b.x - a.x);
  let h = Math.abs(b.y - a.y);
  if (w < 10 || h < 10) {
    // 单击而非拖拽：在落点创建一个默认大小的链接框
    w = 190; h = 24;
    y = a.y - h / 2;
    x = a.x;
    if (x + w > (state.pageInfo[page] ? state.pageInfo[page].view[2] : 595)) x = Math.max(0, (state.pageInfo[page] ? state.pageInfo[page].view[2] : 595) - w - 8);
  }
  openLinkDialog(page, { x, y, w, h, url: '', targetPage: 0 }, true);
}

export function openLinkDialog(page, anno, isNew = false) {
  const box = document.createElement('div');
  box.innerHTML = field(t('网址（http:// 或 https://）'), '<input id="lk-url" type="text" placeholder="https://example.com" />')
    + `<div class="hint" style="margin:2px 0 10px">${t('也可以留空网址，改为「跳转到文档内某页」')}</div>`
    + field(t('跳转到第几页'), `<input id="lk-page" type="number" min="1" max="${state.numPages || 1}" />`)
    + '<div class="hint" id="lk-err" style="color:var(--red);min-height:16px;margin-top:6px"></div>';

  openModal({
    title: isNew ? t('添加链接') : t('修改链接'),
    body: box,
    footer: [
      {
        label: t('取消'), kind: 'btn-ghost',
        onClick: ({ close }) => { close(); if (isNew) setTool(null); }
      },
      {
        label: isNew ? t('创建链接') : t('保存'), kind: 'btn-primary',
        onClick: ({ close, body: b }) => {
          const url = b.querySelector('#lk-url').value.trim();
          const pg = parseInt(b.querySelector('#lk-page').value, 10) || 0;
          const err = b.querySelector('#lk-err');
          err.textContent = '';
          if (!url && !pg) { err.textContent = t('请填写网址，或填写要跳转的页码'); return; }
          if (url && !/^https?:\/\//i.test(url)) { err.textContent = t('网址需要以 http:// 或 https:// 开头'); return; }
          if (pg && (pg < 1 || pg > state.numPages)) { err.textContent = t('页码需在 1 ~ {n} 之间', { n: state.numPages }); return; }
          snapshot();
          if (isNew) {
            const made = push(page, { id: NID(), type: 'link', x: anno.x, y: anno.y, w: anno.w, h: anno.h, url, targetPage: pg });
            setTool(null);
            selectAnnotation({ page, id: made.id });
          } else {
            anno.url = url;
            anno.targetPage = pg;
            setDirty(true);
            drawOverlay(page);
            selectAnnotation({ page, id: anno.id });
          }
          toast(url ? t('链接已创建，浏览模式下点击即可打开') : t('跳转链接已创建'), 'ok');
          close();
        }
      }
    ],
    onMount: ({ body: b }) => {
      if (anno.url) b.querySelector('#lk-url').value = anno.url;
      if (anno.targetPage) b.querySelector('#lk-page').value = anno.targetPage;
      setTimeout(() => b.querySelector('#lk-url').focus(), 40);
    }
  });
}

function openDrawSignature(n, u) {
  const W = 520, H = 200;
  const body = document.createElement('div');
  body.innerHTML = `<div class="hint" style="margin-bottom:8px">${t('在下方区域手写签名（支持鼠标/触控板）')}</div>
  <canvas id="sig-pad" width="${W}" height="${H}" style="border:1px solid var(--border-2);border-radius:6px;width:100%;background:#fff;touch-action:none;cursor:crosshair"></canvas>`;
  openModal({
    title: t('手写签名'), body, width: 580,
    footer: [
      { label: t('清除'), kind: 'btn-ghost', onClick: ({ body: b }) => clearPad(b.querySelector('#sig-pad')) },
      {
        label: t('插入'), kind: 'btn-primary', onClick: ({ close, body: b }) => {
          const pad = b.querySelector('#sig-pad');
          if (!pad.dataset.drawn) return toast(t('请先书写签名'));
          insertImageAnnotation(n, u, trimCanvas(pad), 'image/png', 'signature');
          close();
        }
      }
    ],
    onMount: ({ body: b }) => setupPad(b.querySelector('#sig-pad'))
  });
}

function setupPad(pad) {
  const ctx = pad.getContext('2d');
  ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#12141a';
  let drawing = false;
  const pos = (e) => {
    const r = pad.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (pad.width / r.width), y: (e.clientY - r.top) * (pad.height / r.height) };
  };
  pad.addEventListener('pointerdown', (e) => { drawing = true; pad.dataset.drawn = '1'; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); pad.setPointerCapture(e.pointerId); });
  pad.addEventListener('pointermove', (e) => { if (!drawing) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); });
  pad.addEventListener('pointerup', () => { drawing = false; });
}
function clearPad(pad) { pad.getContext('2d').clearRect(0, 0, pad.width, pad.height); delete pad.dataset.drawn; }
function trimCanvas(pad) {
  const ctx = pad.getContext('2d');
  const { width, height } = pad;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = 0, maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX <= minX || maxY <= minY) return pad.toDataURL('image/png');
  const p2 = 12;
  minX = Math.max(0, minX - p2); minY = Math.max(0, minY - p2);
  maxX = Math.min(width - 1, maxX + p2); maxY = Math.min(height - 1, maxY + p2);
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1; out.height = maxY - minY + 1;
  out.getContext('2d').drawImage(pad, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

/* ---------------- 写入 ---------------- */
export function push(page, anno) {
  if (!state.annotations[page]) state.annotations[page] = [];
  state.annotations[page].push(anno);
  setDirty(true);
  drawOverlay(page);
  return anno;
}

export function annotationsCount() {
  let n = 0;
  for (const k in state.annotations) n += state.annotations[k].length;
  return n;
}

export function clearAllAnnotations() {
  if (!annotationsCount()) return;
  snapshot();
  state.annotations = {};
  selected = null;
  setDirty(true);
  updateOverlays();
}

export function getSelected() { return selected; }
/** 供自检调用：按 id 重新选中某个批注/对象 */
export function selectById(page, id) { selectAnnotation({ page, id }); }
export function hitLineAt(n, x, y, wrap) { return findLineAt(n, x, y, wrap); }
/** 供自检调用：页面文本块命中测试（cssX/cssY 为相对页面的坐标） */
export function hitTextBlock(n, cssX, cssY) { return blockAt(n, cssX, cssY); }
export function textBlockCount(n) { return computeTextBlocks(n).length; }
export { goToPage };
