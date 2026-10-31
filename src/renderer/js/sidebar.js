// 侧栏：缩略图、书签、搜索
import { state } from './state.js';
import { pdfjsLib, goToPage, pageWrap, getViewport, displaySize, ensurePageInfo } from './viewer.js';
import { toast } from './ui.js';
import { t } from './i18n.js';
import { normalizePdfText, getFixedTextContent } from './textfix.js';

let thumbObserver = null;
let activeTab = 'thumbnails';

export function initSidebar() {
  document.querySelectorAll('.sb-tab').forEach((b) => {
    b.onclick = () => switchTab(b.dataset.tab);
  });
  const inp = document.getElementById('search-input');
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.shiftKey ? searchPrev() : searchNext();
    }
  });
  inp.addEventListener('input', debounce(() => runSearch(inp.value.trim()), 320));
  document.getElementById('search-next').onclick = () => searchNext();
  document.getElementById('search-prev').onclick = () => searchPrev();
  switchTab('thumbnails');
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

export function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.sb-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.sb-pane').forEach((p) => p.classList.toggle('hidden', p.id !== 'pane-' + tab));
  if (tab === 'thumbnails') renderThumbnails();
  if (tab === 'bookmarks') renderBookmarks();
  if (tab === 'search') setTimeout(() => document.getElementById('search-input').focus(), 20);
}

/** 文档重新加载后刷新侧栏 */
export function refreshSidebar() {
  if (activeTab === 'thumbnails') renderThumbnails();
  else if (activeTab === 'bookmarks') renderBookmarks();
  else if (activeTab === 'search') { clearSearch(); }
}

export function toggleSidebar(force) {
  const sb = document.getElementById('sidebar');
  const show = force === undefined ? sb.classList.contains('collapsed') : force;
  sb.classList.toggle('collapsed', !show);
  return show;
}
export function sidebarVisible() { return !document.getElementById('sidebar').classList.contains('collapsed'); }

/* ---------------- 缩略图 ---------------- */
function renderThumbnails() {
  const pane = document.getElementById('pane-thumbnails');
  if (!state.pdfDoc) { pane.innerHTML = '<div class="sb-empty">' + t('未打开文档') + '</div>'; return; }
  pane.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (let i = 1; i <= state.numPages; i++) {
    const item = document.createElement('div');
    item.className = 'thumb-item';
    item.dataset.page = String(i);
    item.innerHTML = `<div class="thumb-ph page-ph" style="aspect-ratio:${thumbRatio(i)}"></div><span class="thumb-no">${i}</span>`;
    item.onclick = () => { goToPage(i, { smooth: true }); markActiveThumb(i); };
    frag.appendChild(item);
  }
  pane.appendChild(frag);
  if (thumbObserver) thumbObserver.disconnect();
  thumbObserver = new IntersectionObserver((entries) => {
    entries.forEach((e) => { if (e.isIntersecting) renderThumb(Number(e.target.dataset.page), e.target); });
  }, { root: pane, rootMargin: '300px 0px' });
  pane.querySelectorAll('.thumb-item').forEach((el) => thumbObserver.observe(el));
  markActiveThumb(state.currentPage);
}

function thumbRatio(n) {
  const s = displaySize(n, 1);
  return `${s.w} / ${s.h}`;
}

async function renderThumb(n, item) {
  if (item.dataset.done) return;
  item.dataset.done = '1';
  const w = 190;
  await ensurePageInfo(n);
  const info = state.pageInfo[n] || state.defaultSize;
  const scale = w / (info.view[2] - info.view[0]);
  const page = await state.pdfDoc.getPage(n);
  const vp = page.getViewport({ scale, rotation: info.rotate });
  const canvas = document.createElement('canvas');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(vp.width * dpr);
  canvas.height = Math.floor(vp.height * dpr);
  canvas.style.width = '100%';
  canvas.style.height = 'auto';
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
  const ph = item.querySelector('.thumb-ph');
  if (ph) ph.replaceWith(canvas);
}

export function markActiveThumb(n) {
  const pane = document.getElementById('pane-thumbnails');
  if (!pane) return;
  pane.querySelectorAll('.thumb-item').forEach((el) => el.classList.toggle('active', Number(el.dataset.page) === n));
  const cur = pane.querySelector(`.thumb-item[data-page="${n}"]`);
  if (cur && activeTab === 'thumbnails') {
    const pr = pane.getBoundingClientRect(), cr = cur.getBoundingClientRect();
    if (cr.top < pr.top || cr.bottom > pr.bottom) cur.scrollIntoView({ block: 'nearest' });
  }
}

/* ---------------- 书签 ---------------- */
export async function renderBookmarks() {
  const pane = document.getElementById('pane-bookmarks');
  if (!state.pdfDoc) { pane.innerHTML = '<div class="sb-empty">' + t('未打开文档') + '</div>'; return; }
  let outline = [];
  try { outline = await state.pdfDoc.getOutline() || []; } catch (e) { outline = []; }
  if (!outline.length) {
    pane.innerHTML = '<div class="sb-empty">' + t('该文档没有书签目录') + '</div>';
    return;
  }
  pane.innerHTML = '';
  const build = (items, depth) => {
    const box = document.createElement('div');
    box.style.paddingLeft = (depth * 10) + 'px';
    for (const it of items) {
      const el = document.createElement('div');
      el.className = 'bm-item';
      el.innerHTML = `<span class="bm-dot"></span><span>${escapeHtml(it.title || t('(无标题)'))}</span>`;
      el.onclick = async () => {
        const p = await resolveDest(it.dest);
        if (p) goToPage(p, { smooth: true });
      };
      box.appendChild(el);
      if (it.items && it.items.length) box.appendChild(build(it.items, depth + 1));
    }
    return box;
  };
  pane.appendChild(build(outline, 0));
}

async function resolveDest(dest) {
  try {
    let d = dest;
    if (typeof d === 'string') d = await state.pdfDoc.getDestination(d);
    if (!Array.isArray(d) || !d.length) return null;
    const idx = await state.pdfDoc.getPageIndex(d[0]);
    return idx + 1;
  } catch (e) { return null; }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ---------------- 搜索 ---------------- */
export async function runSearch(query) {
  state.searchQuery = query;
  state.searchHits = [];
  state.searchIndex = -1;
  clearSearchLayer();
  const list = document.getElementById('search-results');
  const count = document.getElementById('search-count');
  if (!query || !state.pdfDoc) { list.innerHTML = ''; count.textContent = ''; return; }
  count.textContent = t('搜索中…');
  const q = query.toLowerCase();
  const itemsByPage = {};
  for (let n = 1; n <= state.numPages; n++) {
    const page = await state.pdfDoc.getPage(n);
    const tc = await getFixedTextContent(page);
    let full = '';
    const map = [];
    tc.items.forEach((it, i) => {
      const s = normalizePdfText(it.str || '');
      if (!s) return;
      map.push({ start: full.length, end: full.length + s.length, i });
      full += s;
    });
    itemsByPage[n] = { full, map, items: tc.items };
    const lower = full.toLowerCase();
    let idx = 0;
    while ((idx = lower.indexOf(q, idx)) !== -1) {
      state.searchHits.push({ page: n, start: idx, end: idx + q.length });
      idx += q.length;
      if (state.searchHits.length > 2000) break;
    }
  }
  count.textContent = state.searchHits.length ? t('共 {n} 处匹配', { n: state.searchHits.length }) : t('未找到匹配项');
  list.innerHTML = '';
  const frag = document.createDocumentFragment();
  state.searchHits.slice(0, 500).forEach((h, i) => {
    const ctx = snippet(itemsByPage[h.page].full, h.start, h.end);
    const el = document.createElement('div');
    el.className = 'search-result';
    el.dataset.i = String(i);
    el.innerHTML = `<div class="sr-page">${t('第 {n} 页', { n: h.page })}</div><div>${ctx}</div>`;
    el.onclick = () => gotoHit(i);
    frag.appendChild(el);
  });
  list.appendChild(frag);
  if (state.searchHits.length) gotoHit(0);
  cachePageText(itemsByPage);
}

let pageTextCache = {};
function cachePageText(m) { pageTextCache = m; }

function snippet(text, start, end) {
  const a = Math.max(0, start - 40);
  const b = Math.min(text.length, end + 40);
  const before = escapeHtml(text.slice(a, start));
  const hit = escapeHtml(text.slice(start, end));
  const after = escapeHtml(text.slice(end, b));
  return `${a > 0 ? '…' : ''}${before}<mark>${hit}</mark>${after}${b < text.length ? '…' : ''}`;
}

export function searchNext() {
  if (!state.searchHits.length) return;
  state.searchIndex = (state.searchIndex + 1) % state.searchHits.length;
  gotoHit(state.searchIndex);
}
export function searchPrev() {
  if (!state.searchHits.length) return;
  state.searchIndex = (state.searchIndex - 1 + state.searchHits.length) % state.searchHits.length;
  gotoHit(state.searchIndex);
}

async function gotoHit(i) {
  const h = state.searchHits[i];
  if (!h) return;
  state.searchIndex = i;
  document.querySelectorAll('.search-result').forEach((el) => el.classList.toggle('active', Number(el.dataset.i) === i));
  const cur = document.querySelector(`.search-result[data-i="${i}"]`);
  if (cur) cur.scrollIntoView({ block: 'nearest' });
  goToPage(h.page, { smooth: true });
  setTimeout(() => markHits(state.searchQuery, i), 120);
}

/* 页面级高亮：在 .search-layer 上绘制 */
function clearSearchLayer() {
  document.querySelectorAll('.search-layer').forEach((e) => e.remove());
}

export async function markHits(query, currentIndex) {
  clearSearchLayer();
  if (!query || !state.searchHits.length) return;
  const byPage = {};
  state.searchHits.forEach((h, i) => {
    (byPage[h.page] = byPage[h.page] || []).push({ ...h, i });
  });
  for (const pg of Object.keys(byPage)) {
    const n = Number(pg);
    const wrap = pageWrap(n);
    if (!wrap) continue;
    const data = pageTextCache[n];
    if (!data) continue;
    const vp = getViewport(n);
    const layer = document.createElement('div');
    layer.className = 'search-layer';
    layer.style.cssText = 'position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;z-index:2';
    for (const h of byPage[pg]) {
      const rects = hitRects(data, vp, h.start, h.end);
      for (const r of rects) {
        const d = document.createElement('div');
        d.style.cssText = `position:absolute;border-radius:2px;background:${h.i === currentIndex ? 'rgba(228,0,43,.5)' : 'rgba(228,0,43,.24)'};`;
        d.style.left = r.left + 'px';
        d.style.top = r.top + 'px';
        d.style.width = r.width + 'px';
        d.style.height = r.height + 'px';
        layer.appendChild(d);
      }
    }
    wrap.appendChild(layer);
  }
}

function hitRects(data, vp, start, end) {
  const rects = [];
  for (const seg of data.map) {
    if (seg.end <= start || seg.start >= end) continue;
    const item = data.items[seg.i];
    const localA = Math.max(0, start - seg.start);
    const localB = Math.min(item.str.length, end - seg.start);
    const total = item.str.length || 1;
    const tx = pdfjsLib.Util.transform(vp.transform, item.transform);
    const fh = Math.hypot(tx[2], tx[3]) || 10;
    const itemW = (item.width || 0) * vp.scale;
    const left = tx[4] + (localA / total) * itemW;
    const width = Math.max(2, ((localB - localA) / total) * itemW);
    const top = tx[5] - fh;
    rects.push({ left, top, width, height: fh * 1.05 });
  }
  return rects;
}

export function clearSearch() {
  state.searchHits = [];
  state.searchIndex = -1;
  state.searchQuery = '';
  pageTextCache = {};
  clearSearchLayer();
  const list = document.getElementById('search-results');
  if (list) list.innerHTML = '';
  const c = document.getElementById('search-count');
  if (c) c.textContent = '';
  const i = document.getElementById('search-input');
  if (i) i.value = '';
}

export { toast };
