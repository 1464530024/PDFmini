// PDF 渲染核心：惰性解析、虚拟化渲染、缩放、文本层
// 说明：pdfjs-dist 的 legacy 构建经 esbuild 打包后反而比 build/ 更小（已实测 1.98MB vs 2.29MB），
// 故仍使用 legacy/build。
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js';
import { state } from './state.js';
import { t } from './i18n.js';
import { normalizePdfText, repairMissingGlyphs, getFixedTextContent } from './textfix.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'app://local/dist/pdf.worker.js';

const CMAP_URL = 'app://local/dist/cmaps/';
const FONT_URL = 'app://local/dist/standard_fonts/';

let pagesEl = null;
let viewportEl = null;
const renderTasks = {};     // page -> RenderTask
const textTasks = {};       // page -> TextLayerRenderTask
const pendingRenders = new Map();
let renderWaiters = [];
let scrollRaf = null;
let firstRenderDone = false;
let handlers = {};

export function initViewer(h) {
  handlers = h || {};
  pagesEl = document.getElementById('pages');
  viewportEl = document.getElementById('viewport');
  viewportEl.addEventListener('scroll', onScroll, { passive: true });
  // 选中高亮：选区一变就重绘（合帧）；拖拽结束再补一次，保证落点准确
  document.addEventListener('selectionchange', scheduleSelHighlight);
  window.addEventListener('mouseup', scheduleSelHighlight, true);
  window.addEventListener('touchend', scheduleSelHighlight, true);
  window.addEventListener('resize', debounce(() => {
    if (!state.pdfDoc) return;
    if (state.zoomMode !== 'custom') applyFit(false);
    else layoutPages();
  }, 160));
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ---------------- 解析：只取第 1 页尺寸，其余惰性 ---------------- */
async function parseInto(bytes) {
  const doc = await pdfjsLib.getDocument({
    data: bytes.slice(0),
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: FONT_URL,
    disableFontFace: true,
    useSystemFonts: false
  }).promise;

  state.pdfDoc = doc;
  state.numPages = doc.numPages;
  state.pageInfo = [];
  state.defaultSize = null;

  try {
    const p1 = await doc.getPage(1);
    const vp = p1.getViewport({ scale: 1 });
    state.defaultSize = { view: p1.view.slice(0), rotate: p1.rotate || 0, size: { w: vp.width, h: vp.height } };
    state.pageInfo[1] = { view: p1.view.slice(0), rotate: p1.rotate || 0, size: { w: vp.width, h: vp.height }, ref: p1 };
  } catch (e) { /* 忽略 */ }
  return doc;
}

/** 打开文档（重新解析） */
/** 挂载已缓存 pdf.js 文档的标签页（秒切） */
export async function mountDocument(tab) {
  destroyPages();
  if (tab.pdfDoc) {
    state.pdfDoc = tab.pdfDoc;
    state.numPages = tab.numPages;
    state.pageInfo = tab.pageInfo;
    state.defaultSize = tab.defaultSize;
  } else {
    showViewerLoading();
    await parseInto(tab.workBytes);
    tab.pdfDoc = state.pdfDoc;
    tab.numPages = state.numPages;
    tab.pageInfo = state.pageInfo;
    tab.defaultSize = state.defaultSize;
  }
  buildPages();
  if (state.zoomMode !== 'custom') applyFit(false);
  else layoutPages();
  const n = clamp(tab.currentPage || 1, 1, state.numPages);
  state.currentPage = n;
  renderPage(n);
  await waitPageRendered(n);
  hideViewerLoading();
  restoreScrollTo(n, tab.scrollRatio);
  onDocumentLoad();
}

/** 页面操作 / 保存后重新解析当前字节 */
export async function reparse(bytes) {
  const old = state.pdfDoc;
  destroyPages();
  showViewerLoading();
  try {
    state.pageInfo = [];
    state.defaultSize = null;
    await parseInto(bytes);
    buildPages();
    if (state.zoomMode !== 'custom') applyFit(false);
    else layoutPages();
    const n = clamp(state.currentPage || 1, 1, state.numPages);
    state.currentPage = n;
    renderPage(n);
    await waitPageRendered(n);
  } finally {
    hideViewerLoading();
    onDocumentLoad();
  }
  if (old && old !== state.pdfDoc) { try { old.destroy(); } catch (e) { /* 忽略 */ } }
}

function onDocumentLoad() { try { handlers.onDocumentLoad && handlers.onDocumentLoad(); } catch (e) { /* 忽略 */ } }
function onPageChange(n, total) { try { handlers.onPageChange && handlers.onPageChange(n, total); } catch (e) { /* 忽略 */ } }

/* ---------------- 加载指示 ---------------- */
// 全局遮罩（loading-mask）已显示时不再重复显示阅读区转圈，避免出现两个加载指示
export function showViewerLoading() {
  if (document.getElementById('loading-mask')) return;
  const el = document.getElementById('viewer-loading');
  if (el) el.classList.remove('hidden');
}
export function hideViewerLoading() {
  const el = document.getElementById('viewer-loading');
  if (el) el.classList.add('hidden');
}

/* ---------------- 页面尺寸 ---------------- */
function sizeOf(n) {
  return state.pageInfo[n] || state.defaultSize || { view: [0, 0, 595.28, 841.89], rotate: 0, size: { w: 595.28, h: 841.89 } };
}

/** 显示尺寸（仅依赖缓存的页面尺寸，无需页面对象 —— 保证大文件秒开） */
export function displaySize(n, zoom = state.zoom) {
  const info = sizeOf(n);
  const s = info.size || { w: 595.28, h: 841.89 };
  const swap = state.rotation % 180 !== 0;
  return { w: (swap ? s.h : s.w) * zoom, h: (swap ? s.w : s.h) * zoom };
}

export async function ensurePageInfo(n) {
  if (state.pageInfo[n] && state.pageInfo[n].ref) return state.pageInfo[n];
  if (!state.pdfDoc) return null;
  const page = await state.pdfDoc.getPage(n);
  const vp = page.getViewport({ scale: 1 });
  state.pageInfo[n] = {
    view: page.view.slice(0), rotate: page.rotate || 0,
    size: { w: vp.width, h: vp.height }, ref: page
  };
  const wrap = pageWrap(n);
  if (wrap) {
    const { w, h } = displaySize(n);
    wrap.style.width = Math.round(w) + 'px';
    wrap.style.height = Math.round(h) + 'px';
    const ph = wrap.querySelector('.page-ph');
    if (ph) { ph.style.width = '100%'; ph.style.height = '100%'; }
  }
  return state.pageInfo[n];
}

/* ---------------- 页面构建 ---------------- */
export function destroyPages() {
  for (const k in renderTasks) { try { renderTasks[k].cancel(); } catch (e) {} delete renderTasks[k]; }
  for (const k in textTasks) { try { textTasks[k].cancel(); } catch (e) {} delete textTasks[k]; }
  if (state.observer) { state.observer.disconnect(); state.observer = null; }
  state.renderedPages.clear();
  pendingRenders.clear();
  renderWaiters = [];
  firstRenderDone = false;
  if (pagesEl) pagesEl.innerHTML = '';
}

function buildPages() {
  pagesEl.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (let i = 1; i <= state.numPages; i++) {
    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    wrap.dataset.page = String(i);
    wrap.innerHTML = `<div class="page-ph">${t('第 {n} 页', { n: i })}</div><div class="page-overlay"></div>`;
    frag.appendChild(wrap);
  }
  pagesEl.appendChild(frag);
  layoutPages();
  setupObserver();
}

export function layoutPages() {
  if (!state.numPages) return;
  for (let i = 1; i <= state.numPages; i++) {
    const wrap = pageWrap(i);
    if (!wrap) continue;
    const { w, h } = displaySize(i);
    wrap.style.width = Math.round(w) + 'px';
    wrap.style.height = Math.round(h) + 'px';
    const ph = wrap.querySelector('.page-ph');
    if (ph) { ph.style.width = '100%'; ph.style.height = '100%'; }
  }
  for (const p of Array.from(state.renderedPages)) renderPage(p, true);
  updateOverlays();
  suspendSelHighlight();       // 页面尺寸变了：旧坐标的高亮立刻作废，等重渲染完再画
}

function contentSize() {
  const r = viewportEl.getBoundingClientRect();
  return { w: r.width - 24, h: r.height - 24 };
}

export function applyFit(resetScroll = false) {
  if (!state.numPages) return;
  const { w, h } = contentSize();
  const sz = displaySize(state.currentPage, 1);
  let zoom;
  if (state.zoomMode === 'fit-page') zoom = Math.min(w / sz.w, h / sz.h);
  else {
    state.zoomMode = state.zoomMode === 'custom' ? 'fit-width' : state.zoomMode;
    zoom = w / sz.w;
  }
  state.zoom = clamp(zoom, 0.1, 8);
  layoutPages();
  updateZoomLabel();
  if (resetScroll) viewportEl.scrollTop = 0;
}

/* ---------------- 缩放 ---------------- */
export function setZoom(z, mode = 'custom') {
  const before = state.zoom;
  state.zoom = clamp(z, 0.1, 8);
  state.zoomMode = mode;
  const wrap = pageWrap(state.currentPage);
  const rel = wrap && wrap.offsetHeight ? (viewportEl.scrollTop - (wrap.offsetTop - 18)) / wrap.offsetHeight : 0;
  layoutPages();
  updateZoomLabel();
  if (wrap && before !== state.zoom) restoreScrollTo(state.currentPage, clamp(rel, 0, 1));
}
export function zoomIn() { setZoom(state.zoom * 1.2); }
export function zoomOut() { setZoom(state.zoom / 1.2); }
export function fitWidth() { state.zoomMode = 'fit-width'; applyFit(true); }
export function fitPage() { state.zoomMode = 'fit-page'; applyFit(true); }

function updateZoomLabel() {
  const txt = Math.round(state.zoom * 100) + '%';
  const lb = document.getElementById('st-zoom');
  if (lb) lb.textContent = txt;
  const zl = document.getElementById('zoom-label');
  if (zl) zl.textContent = txt;
  const zb = document.querySelector('#zoom-btn .lbl');
  if (zb) zb.textContent = txt;
}

export function setRotation(deg) {
  state.rotation = ((deg % 360) + 360) % 360;
  if (state.zoomMode !== 'custom') applyFit(false);
  else layoutPages();
}

/* ---------------- 渲染 ---------------- */
function setupObserver() {
  if (state.observer) state.observer.disconnect();
  state.observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const n = Number(e.target.dataset.page);
      if (e.isIntersecting) renderPage(n);
      else if (state.renderedPages.has(n) && !isNear(e.target)) unrenderPage(n);
    }
  }, { root: viewportEl, rootMargin: '700px 0px', threshold: 0 });
  document.querySelectorAll('.page-wrap').forEach((el) => state.observer.observe(el));
}

function isNear(el) {
  const r = el.getBoundingClientRect();
  const vr = viewportEl.getBoundingClientRect();
  return r.bottom > vr.top - 1400 && r.top < vr.bottom + 1400;
}

export async function renderPage(n, force = false) {
  if (!state.pdfDoc) return;
  const wrap = pageWrap(n);
  if (!wrap) return;
  if (state.renderedPages.has(n) && !force) { markRendered(n); return; }
  if (pendingRenders.has(n)) return pendingRenders.get(n);

  const task = (async () => {
    if (renderTasks[n]) { try { renderTasks[n].cancel(); } catch (e) {} renderTasks[n] = null; }
    if (textTasks[n]) { try { textTasks[n].cancel(); } catch (e) {} textTasks[n] = null; }

    await ensurePageInfo(n);
    const page = await state.pdfDoc.getPage(n);
    const info = state.pageInfo[n];
    const viewport = page.getViewport({ scale: state.zoom, rotation: (info.rotate || 0) + state.rotation });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const oldCanvas = wrap.querySelector('canvas');
    if (oldCanvas) oldCanvas.remove();
    const oldText = wrap.querySelector('.textLayer');
    if (oldText) oldText.remove();

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = Math.round(viewport.width) + 'px';
    canvas.style.height = Math.round(viewport.height) + 'px';
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const ph = wrap.querySelector('.page-ph');
    wrap.insertBefore(canvas, wrap.firstChild);
    if (ph) ph.style.display = 'none';

    const rt = page.render({
      canvasContext: ctx,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null
    });
    renderTasks[n] = rt;
    try { await rt.promise; } catch (e) { if (e && e.name === 'RenderingCancelledException') return; }
    renderTasks[n] = null;

    // 部分 PDF（每个字形一个 Type3 字体）会让 pdf.js 画不出个别字甚至整行文字，
    // 成图后逐字检测「该位置没有墨迹」并用系统字体补画，避免“文字缺失”
    if (state.textRepair !== false) {
      try { await repairMissingGlyphs(canvas, ctx, page, viewport, dpr); } catch (e) { /* 修复失败不影响原显示 */ }
    }

    state.renderedPages.add(n);
    markRendered(n);

    try {
      const textContent = await getFixedTextContent(page);
      const textLayerDiv = document.createElement('div');
      textLayerDiv.className = 'textLayer';
      textLayerDiv.style.width = Math.round(viewport.width) + 'px';
      textLayerDiv.style.height = Math.round(viewport.height) + 'px';
      textLayerDiv.style.setProperty('--scale-factor', String(viewport.scale));
      wrap.insertBefore(textLayerDiv, wrap.querySelector('.page-overlay'));
      const tlTask = pdfjsLib.renderTextLayer({
        textContentSource: textContent,
        textContent,
        container: textLayerDiv,
        viewport,
        textDivs: []
      });
      textTasks[n] = tlTask;
      if (tlTask && tlTask.promise) await tlTask.promise;
      textTasks[n] = null;
      sortTextSpansByVisualOrder(textLayerDiv);
      invalidateSelModel(n);        // 文本层重建 → 行模型作废
      scheduleSelHighlight();
    } catch (e) { /* 文本层失败不影响阅读 */ }

    updateOverlay(n);
    // 页面重建后把选中高亮挂回去（选区通常已被清掉，这里只是兜底）
    scheduleSelHighlight();
    // 预热原生图片矩形缓存：让「点击图片即编辑 / 框选删除」可以同步命中
    getPageImages(n).catch(() => {});
  })();

  pendingRenders.set(n, task);
  try { await task; } finally { pendingRenders.delete(n); }
}

/**
 * 把文本层的 span 重排成「视觉顺序」（按行、再按横坐标）。
 * 绝对定位元素的 DOM 顺序不影响显示，但决定鼠标拖选的先后：
 * 有些 PDF（每个字形一个 Type3 字体、或内容流顺序与视觉顺序不一致）会让 pdf.js
 * 生成的 span 顺序与肉眼所见不同 —— 表现就是「鼠标在第 3 行，高亮却跳到第 5 行」。
 */
function sortTextSpansByVisualOrder(container) {
  const spans = Array.from(container.querySelectorAll('span'));
  if (spans.length < 2) return;
  const box = container.getBoundingClientRect();
  const keyed = spans.map((sp, i) => {
    const b = sp.getBoundingClientRect();
    return { sp, i, row: Math.round((b.top - box.top) / 2), x: b.left - box.left };
  });
  let ordered = true;
  for (let k = 1; k < keyed.length; k++) {
    const a = keyed[k - 1];
    const b = keyed[k];
    if (b.row < a.row || (b.row === a.row && b.x < a.x - 0.5)) { ordered = false; break; }
  }
  if (ordered) return;
  keyed.sort((a, b) => a.row - b.row || a.x - b.x || a.i - b.i);
  for (const k of keyed) container.appendChild(k.sp);
}

function markRendered(n) {
  if (firstRenderDone) return;
  if (n !== state.currentPage) return;
  firstRenderDone = true;
  hideViewerLoading();
  renderWaiters.forEach((w) => w());
  renderWaiters = [];
}

function waitPageRendered(n) {
  if (state.renderedPages.has(n)) { hideViewerLoading(); return Promise.resolve(); }
  return new Promise((resolve) => {
    const timer = setTimeout(() => { hideViewerLoading(); resolve(); }, 6000);
    renderWaiters.push(() => { clearTimeout(timer); resolve(); });
  });
}

function unrenderPage(n) {
  const wrap = pageWrap(n);
  if (!wrap) return;
  if (renderTasks[n]) { try { renderTasks[n].cancel(); } catch (e) {} renderTasks[n] = null; }
  const c = wrap.querySelector('canvas'); if (c) c.remove();
  const tl = wrap.querySelector('.textLayer'); if (tl) tl.remove();
  const ph = wrap.querySelector('.page-ph'); if (ph) ph.style.display = '';
  state.renderedPages.delete(n);
  invalidateSelModel(n);
  scheduleSelHighlight();
}

export function getViewport(n) {
  const info = state.pageInfo[n];
  if (!info || !info.ref) return null;
  return info.ref.getViewport({ scale: state.zoom, rotation: (info.rotate || 0) + state.rotation });
}

export function pageWrap(n) { return pagesEl && pagesEl.querySelector(`.page-wrap[data-page="${n}"]`); }
export function pageOverlay(n) { const w = pageWrap(n); return w && w.querySelector('.page-overlay'); }
export function textLayer(n) { const w = pageWrap(n); return w && w.querySelector('.textLayer'); }

/* ---------------- 滚动 ---------------- */
function onScroll() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => { scrollRaf = null; updateCurrentPageFromScroll(); });
}

export function updateCurrentPageFromScroll() {
  const vr = viewportEl.getBoundingClientRect();
  const mid = vr.top + vr.height * 0.35;
  let best = 1, bestDist = Infinity;
  for (let i = 1; i <= state.numPages; i++) {
    const wrap = pageWrap(i);
    if (!wrap) continue;
    const r = wrap.getBoundingClientRect();
    const d = Math.abs(r.top + r.height / 2 - mid);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  if (best !== state.currentPage) {
    state.currentPage = best;
    onPageChange(best, state.numPages);
  }
}

export function goToPage(n, opts = {}) {
  n = clamp(Math.round(n), 1, state.numPages || 1);
  const wrap = pageWrap(n);
  if (!wrap) return;
  viewportEl.scrollTo({ top: wrap.offsetTop - 18, behavior: opts.smooth ? 'smooth' : 'auto' });
  state.currentPage = n;
  onPageChange(n, state.numPages);
}

export function restoreScrollTo(n, ratio) {
  const wrap = pageWrap(n);
  if (!wrap) return;
  let top = wrap.offsetTop - 18;
  if (ratio != null && ratio > 0) top += wrap.offsetHeight * ratio;
  viewportEl.scrollTop = Math.max(0, top);
}

export function scrollRatio() {
  const wrap = pageWrap(state.currentPage);
  if (!wrap || !wrap.offsetHeight) return 0;
  return clamp((viewportEl.scrollTop - (wrap.offsetTop - 18)) / wrap.offsetHeight, 0, 1);
}

/** 滚动容器（供编辑层做「左键拖动页面」的平移） */
export function viewportElRef() { return viewportEl; }

/* ---------------- 覆盖层 ---------------- */
let overlayDrawer = null;
export function setOverlayDrawer(fn) { overlayDrawer = fn; }
export function updateOverlay(n) { if (overlayDrawer) overlayDrawer(n); }
export function updateOverlays() { for (let i = 1; i <= state.numPages; i++) updateOverlay(i); }

/* ---------------- 选中高亮（自绘） ----------------
 * 原生 ::selection 是按「字形盒」逐块绘制的：同一视觉行里中文 span 与西文 span 字号不同，
 * 盒高差几像素、相邻块半透明叠加还会变深，逐字形成块的 PDF 更会变成阶梯碎块。
 * 因此原生高亮置为透明（style.css），改为自绘。
 *
 * 自绘的关键是「几何必须稳定」：不能拿当前选区的矩形反推行/段 —— 那样每一帧的
 * 行基准都在变，拖选时就会上下跳动、缩放后比例也对不上。这里改成两步：
 *   ① 行模型（每页一份，随 zoom / 旋转 / 文本层重建而失效并缓存）
 *      —— 把文本层所有 span 归成「视觉行」，每行一个固定的行带（中心 + 高度中位数），
 *         与当前选区无关，所以高亮条永远落在同一位置，不会抖。
 *   ② 选区映射（每帧只做纯计算，不读布局）
 *      —— 由 DOM Range 求出每个 span 被选中的「字符区间」，按字符比例换算横坐标，
 *         覆盖范围精确到字，不会多也不会少（原「选中不全」）。
 * 复制仍走 DOM 选区，不受绘制方式影响。
 */
const SEL_INSET = 0.85;        // 高亮条高 = 行字高中位数 × 系数（贴合字形又不盖到邻行）
const SEL_MERGE_GAP = 1.25;    // 同一行内相邻片段间隔 ≤ 该系数 × 行字高时连成一条（字距/词距远小于此值，故一定合并）
let selRaf = 0;
let selSuspended = false;          // 缩放/换页重排期间挂起：此时文本层是旧尺寸，画出来必然是错的
let selTornDown = false;           // 已做过一次彻底清理，避免每帧重复拆 DOM
let selResumeToken = 0;
const selModelCache = new Map();   // page -> { sig, lines, wrap }
const selBarPool = new Map();      // page -> { layer, map: Map<key, el> }

function selLayerFor(wrap) {
  let layer = wrap.querySelector('.sel-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'sel-layer';
    wrap.insertBefore(layer, wrap.querySelector('.page-overlay') || null);
  }
  return layer;
}

/** 行模型的失效签名：缩放 / 旋转 / 文本层重建 / 页面宽度变化都必须重建 */
function selSig(wrap, layer) {
  return `${state.zoom}|${state.rotation}|${layer.childElementCount}|${Math.round(wrap.getBoundingClientRect().width)}`;
}

/**
 * 建立（或取缓存）该页的行模型。
 * 行带 = 该行所有 span 盒高的中位数；行心 = 行内 span 垂直中心的均值。
 */
function buildSelLineModel(n) {
  const wrap = pageWrap(n);
  const layer = wrap && wrap.querySelector('.textLayer');
  if (!wrap || !layer) return null;
  const sig = selSig(wrap, layer);
  const hit = selModelCache.get(n);
  if (hit && hit.sig === sig) return hit;

  const wr = wrap.getBoundingClientRect();
  const spans = [];
  for (const el of layer.querySelectorAll('span')) {
    const txt = el.textContent || '';
    if (!txt.trim()) continue;
    const b = el.getBoundingClientRect();
    if (b.width < 0.5 || b.height < 0.5) continue;
    spans.push({
      el, len: txt.length,
      l: b.left - wr.left, w: b.width,
      cy: b.top - wr.top + b.height / 2, h: b.height
    });
  }
  spans.sort((a, b) => a.cy - b.cy || a.l - b.l);

  const lines = [];
  for (const s of spans) {
    const tol = Math.max(3, s.h * 0.55);
    let target = null;
    let bestD = Infinity;
    for (const ln of lines) {
      const d = Math.abs(ln.refCy - s.cy);   // 用固定参考行心判定，避免均值漂移把相邻行并成一行
      if (d <= tol && d < bestD) { target = ln; bestD = d; }
    }
    if (target) {
      const k = target.spans.length;
      target.cy = (target.cy * k + s.cy) / (k + 1);
      target.spans.push(s);
    } else {
      lines.push({ refCy: s.cy, cy: s.cy, spans: [s] });
    }
  }
  for (const ln of lines) {
    ln.spans.sort((a, b) => a.l - b.l);
    const hs = ln.spans.map((s) => s.h).sort((a, b) => a - b);
    ln.bandH = Math.max(6, hs[Math.floor(hs.length / 2)] || 12);
    ln.bandCy = ln.cy;
  }
  lines.sort((a, b) => a.bandCy - b.bandCy);

  const model = { sig, lines, wrap };
  selModelCache.set(n, model);
  return model;
}

/** 页面重渲染 / 缩放 / 旋转后必须让行模型失效 */
export function invalidateSelModel(n) {
  if (n == null) selModelCache.clear();
  else selModelCache.delete(n);
}

/** 选区边界若正落在该 span 内，返回字符偏移；返回 null 表示该 span 被整段包含 */
function selOffsetIn(range, spanEl, isStart) {
  const node = isStart ? range.startContainer : range.endContainer;
  const off = isStart ? range.startOffset : range.endOffset;
  if (node === spanEl) return off;
  if (node && node.nodeType === 3 && node.parentNode === spanEl) return off;
  return null;
}

/** 由 DOM 选区 + 行模型算出高亮条（纯计算，不读布局） */
function collectSelBars(model, range, clip) {
  const bars = [];
  for (let li = 0; li < model.lines.length; li++) {
    const ln = model.lines[li];
    if (clip && (ln.bandCy < clip.top || ln.bandCy > clip.bottom)) continue;
    const segs = [];
    for (const s of ln.spans) {
      if (!range.intersectsNode(s.el)) continue;
      const a = selOffsetIn(range, s.el, true);
      const b = selOffsetIn(range, s.el, false);
      const i0 = a == null ? 0 : Math.max(0, Math.min(s.len, a));
      const i1 = b == null ? s.len : Math.max(0, Math.min(s.len, b));
      if (i1 <= i0) continue;
      segs.push({ x0: s.l + (i0 / s.len) * s.w, x1: s.l + (i1 / s.len) * s.w });
    }
    if (!segs.length) continue;
    segs.sort((p, q) => p.x0 - q.x0);
    const h = Math.max(6, Math.round(ln.bandH * SEL_INSET * 2) / 2);
    const y = Math.round((ln.bandCy - h / 2) * 2) / 2;
    const gapMax = Math.max(14, ln.bandH * SEL_MERGE_GAP);
    let cur = { x0: segs[0].x0, x1: segs[0].x1 };
    const parts = [];
    for (let i = 1; i < segs.length; i++) {
      if (segs[i].x0 - cur.x1 <= gapMax) cur.x1 = Math.max(cur.x1, segs[i].x1);
      else { parts.push(cur); cur = { x0: segs[i].x0, x1: segs[i].x1 }; }
    }
    parts.push(cur);
    for (let p = 0; p < parts.length; p++) {
      const wid = parts[p].x1 - parts[p].x0;
      if (wid < 1) continue;
      bars.push({
        key: li + '#' + p, line: li,
        x: Math.round(parts[p].x0 * 2) / 2, y,
        w: Math.round(wid * 2) / 2, h: h
      });
    }
  }
  return bars;
}

/** 按 (行, 片段) 复用高亮条元素：同一行的条永远落在同一位置，拖选时不会重建、不会闪 */
function applySelBars(n, wrap, bars) {
  let item = selBarPool.get(n);
  if (!item) { item = { layer: null, map: new Map() }; selBarPool.set(n, item); }
  if (item.layer && !item.layer.isConnected) { item.layer = null; item.map.clear(); }
  const list = bars || [];
  if (list.length && !item.layer) item.layer = selLayerFor(wrap);
  if (list.length) selTornDown = false;
  const keep = new Set();
  for (const b of list) {
    keep.add(b.key);
    let el = item.map.get(b.key);
    if (!el) {
      el = document.createElement('div');
      el.className = 'sel-bar';
      item.layer.appendChild(el);
      item.map.set(b.key, el);
    }
    el.style.display = '';
    el.style.left = b.x + 'px';
    el.style.top = b.y + 'px';
    el.style.width = b.w + 'px';
    el.style.height = b.h + 'px';
  }
  for (const [key, el] of item.map) {
    if (!keep.has(key)) el.style.display = 'none';
  }
}

function hideAllSelBars() {
  // 直接摘掉元素（而不只是 display:none）：任何路径下都不该留下残留高亮条
  if (selTornDown) return;
  for (const [, item] of selBarPool) {
    for (const el of item.map.values()) el.remove();
    item.map.clear();
  }
  selTornDown = true;
}

function selInEditable(node) {
  const el = node && (node.nodeType === 1 ? node : node.parentElement);
  return !!(el && el.closest && el.closest('input, textarea, [contenteditable="true"]'));
}

function paintSelHighlight() {
  const sel = window.getSelection();
  const range = sel && sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0) : null;
  if (selSuspended || !range || state.mode === 'edit' || selInEditable(range.startContainer)) { hideAllSelBars(); return; }
  const selRect = range.getBoundingClientRect();
  const wraps = document.querySelectorAll('.page-wrap');
  for (const wrap of wraps) {
    const n = Number(wrap.dataset.page);
    const wr = wrap.getBoundingClientRect();
    let bars = null;
    if (wr.bottom >= selRect.top - 4 && wr.top <= selRect.bottom + 4) {
      const model = buildSelLineModel(n);
      if (model) {
        bars = collectSelBars(model, range, {
          top: selRect.top - wr.top - 8,
          bottom: selRect.bottom - wr.top + 8
        });
      }
    }
    applySelBars(n, wrap, bars);
  }
  // 已经不在 DOM 里的页面：连池一起清掉，避免越攒越多、也避免旧尺寸的残留条
  for (const [k, item] of selBarPool) {
    let alive = false;
    for (const wrap of wraps) if (Number(wrap.dataset.page) === k) { alive = true; break; }
    if (alive) continue;
    for (const el of item.map.values()) el.remove();
    selBarPool.delete(k);
    selModelCache.delete(k);
  }
}

/** 合并到下一帧统一重绘（拖选时 selectionchange 触发非常频繁） */
export function scheduleSelHighlight() {
  if (selRaf) return;
  selRaf = requestAnimationFrame(() => { selRaf = 0; paintSelHighlight(); });
}

/**
 * 页面尺寸/缩放变化时调用：立刻清掉旧高亮并挂起绘制，
 * 等本次重渲染全部结束再恢复 —— 否则会拿旧尺寸的文本层画出一堆错位的高亮条。
 */
/**
 * 把选区的一端描述成「第几个 span + 第几个字符」。
 * 重渲染会把整个文本层换掉（元素全变、几何全变），只有这个下标在两个尺寸下是一致的，
 * 因此缩放/旋转后可以据此把选区原样接回来。
 */
function describeSelPoint(node, offset) {
  const el = node && (node.nodeType === 3 ? node.parentElement : node);
  const layer = el && el.closest ? el.closest('.textLayer') : null;
  const wrap = layer && layer.parentElement;
  if (!layer || !wrap || !wrap.dataset || !wrap.dataset.page) return null;
  const spans = Array.from(layer.querySelectorAll('span'));
  if (node === layer) {
    // 边界落在容器上时，offset 是「子节点」序号（可能夹着 <br>），必须换算成 span 序号
    const kids = Array.from(layer.childNodes);
    let at = Math.max(0, Math.min(kids.length, offset));
    let sib = kids[at] || null;
    while (sib && !(sib.nodeType === 1 && sib.tagName === 'SPAN')) sib = sib.nextSibling;
    const idx = sib ? spans.indexOf(sib) : spans.length;
    return { n: Number(wrap.dataset.page), spanIdx: idx < 0 ? spans.length : idx, off: 0 };
  }
  const span = el.closest ? el.closest('span') : null;
  if (!span) return null;
  const idx = spans.indexOf(span);
  if (idx < 0) return null;
  return { n: Number(wrap.dataset.page), spanIdx: idx, off: node && node.nodeType === 3 ? offset : 0 };
}

function captureSelAnchor() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  const a = describeSelPoint(r.startContainer, r.startOffset);
  const b = describeSelPoint(r.endContainer, r.endOffset);
  if (!a || !b) return null;
  return { a, b };
}

function restoreSelAnchor(anchor) {
  if (!anchor) return;
  const wrap = pageWrap(anchor.a.n);
  const layer = wrap && wrap.querySelector('.textLayer');
  if (!layer) return;
  const spans = Array.from(layer.querySelectorAll('span'));
  const s1 = spans[anchor.a.spanIdx];
  const s2 = spans[anchor.b.spanIdx];
  if (!s1 || !s2) return;
  const nodeOf = (sp) => sp.firstChild || sp;
  const offOf = (sp, o) => (sp.firstChild ? Math.max(0, Math.min((sp.textContent || '').length, o)) : 0);
  try {
    const r = document.createRange();
    r.setStart(nodeOf(s1), offOf(s1, anchor.a.off));
    r.setEnd(nodeOf(s2), offOf(s2, anchor.b.off));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  } catch (e) { /* 接不回来就不接，最多是没有高亮 */ }
}

/**
 * 页面尺寸/缩放变化时调用：记住当前选区 → 立刻清掉旧高亮并挂起绘制 →
 * 等本次重渲染全部结束，按新尺寸把选区接回来再画。
 * 这样缩放时既不会留下按旧尺寸画出的错位高亮，选区本身也不会莫名消失。
 */
export function suspendSelHighlight() {
  const anchor = captureSelAnchor();
  selSuspended = true;
  invalidateSelModel();
  selTornDown = false;
  hideAllSelBars();
  const token = ++selResumeToken;
  Promise.all(Array.from(pendingRenders.values())).catch(() => {}).then(() => {
    if (token !== selResumeToken) return;   // 期间又发生了一次缩放，交给最新那次收尾
    if (anchor) restoreSelAnchor(anchor);
    selSuspended = false;
    scheduleSelHighlight();
  });
}

/* ---------------- 导出 ---------------- */
export async function renderPageToCanvas(n, scale = 2) {
  await ensurePageInfo(n);
  const page = await state.pdfDoc.getPage(n);
  const info = state.pageInfo[n];
  const vp = page.getViewport({ scale, rotation: info.rotate || 0 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width);
  canvas.height = Math.floor(vp.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return canvas;
}

export async function extractText() {
  const parts = [];
  for (let i = 1; i <= state.numPages; i++) {
    const page = await state.pdfDoc.getPage(i);
    const tc = await getFixedTextContent(page);
    // 文本层里的康熙部首要还原成规范汉字，否则导出的 txt 是错字
    parts.push(`\n===== ${t('第 {n} 页', { n: i })} =====\n` + normalizePdfText(tc.items.map((it) => it.str).join('')));
  }
  return parts.join('\n');
}

/* ---------------- 页面内原生图片矩形 ---------------- */
const imageRectCache = new Map();   // page -> { doc, rects }
/**
 * 通过 pdf.js 操作符列表 + 变换矩阵栈，计算页面内每张原生图片的矩形（PDF 用户空间）。
 * PDF 图像语义：图像占据「单位正方形」，由当前 CTM 映射。
 */
/** 同步读取已缓存的原生图片矩形（未预热时返回空数组），用于指针命中测试 */
export function getPageImagesSync(n) {
  const hit = imageRectCache.get(n);
  return (hit && hit.doc === state.pdfDoc) ? hit.rects : [];
}

export async function getPageImages(n) {
  if (!state.pdfDoc) return [];
  const hit = imageRectCache.get(n);
  if (hit && hit.doc === state.pdfDoc) return hit.rects;

  const page = await state.pdfDoc.getPage(n);
  const opList = await page.getOperatorList();
  const OPS = pdfjsLib.OPS;
  const Util = pdfjsLib.Util;
  const fn = opList.fnArray;
  const args = opList.argsArray;

  const rects = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const PAINT = new Set([
    OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject,
    OPS.paintJpegXObject, OPS.paintImageXObjectRepeat
  ].filter((v) => v !== undefined));

  for (let i = 0; i < fn.length; i++) {
    const op = fn[i];
    const a = args[i];
    if (op === OPS.save) {
      stack.push(ctm.slice());
    } else if (op === OPS.restore) {
      ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    } else if (op === OPS.transform) {
      ctm = Util.transform(ctm, a);
    } else if (PAINT.has(op)) {
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map((p) => Util.applyTransform(p, ctm));
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs);
      const y0 = Math.min(...ys), y1 = Math.max(...ys);
      if (x1 - x0 < 2 || y1 - y0 < 2) continue;
      rects.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
  }
  imageRectCache.set(n, { doc: state.pdfDoc, rects });
  return rects;
}

export function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
export { pdfjsLib };
