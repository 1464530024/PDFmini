// 文档标签页会话管理
import { state, cloneBytes, onDirtyChange, setDirty } from './state.js';
import * as viewer from './viewer.js';
import { confirmDialog, toast } from './ui.js';
import { t } from './i18n.js';

let seq = 1;
export const tabs = [];
let activeId = null;

onDirtyChange((v) => {
  const t = getActive();
  if (t) { t.dirty = v; renderTabStrip(); }
});

export function getActive() { return tabs.find((t) => t.id === activeId) || null; }
export function getActiveId() { return activeId; }
export function tabCount() { return tabs.length; }
export function hasDirty() { return tabs.some((t) => t.dirty); }

/* 把当前 state 写回活动标签页 */
export function captureActive() {
  const t = getActive();
  if (!t) return;
  t.filePath = state.filePath;
  t.fileName = state.fileName;
  t.originalBytes = state.originalBytes;
  t.workBytes = state.workBytes;
  t.annotations = state.annotations;
  t.undo = state.undo;
  t.redo = state.redo;
  t.zoom = state.zoom;
  t.zoomMode = state.zoomMode;
  t.rotation = state.rotation;
  t.currentPage = state.currentPage;
  t.scrollRatio = viewer.scrollRatio();
  t.dirty = state.dirty;
  t.pdfDoc = state.pdfDoc;
  t.pageInfo = state.pageInfo;
  t.defaultSize = state.defaultSize;
  t.numPages = state.numPages;
}

/* state <- 标签页 */
function applyTab(t) {
  state.filePath = t.filePath;
  state.fileName = t.fileName;
  state.originalBytes = t.originalBytes;
  state.workBytes = t.workBytes;
  state.annotations = t.annotations;
  state.undo = t.undo;
  state.redo = t.redo;
  state.zoom = t.zoom;
  state.zoomMode = t.zoomMode;
  state.rotation = t.rotation;
  state.currentPage = t.currentPage;
  state.pdfDoc = t.pdfDoc;
  state.pageInfo = t.pageInfo;
  state.defaultSize = t.defaultSize;
  state.numPages = t.numPages;
  state.renderedPages = new Set();
  setDirty(t.dirty);
}

export function createTab({ bytes, filePath, fileName, dirty = false }) {
  const t = {
    id: 't' + (seq++),
    filePath: filePath || null,
    fileName: fileName || '未命名.pdf',
    originalBytes: cloneBytes(bytes),
    workBytes: cloneBytes(bytes),
    annotations: {},
    undo: [], redo: [],
    zoom: 1, zoomMode: 'fit-width', rotation: 0, currentPage: 1, scrollRatio: 0,
    dirty,
    pdfDoc: null, pageInfo: [], defaultSize: null, numPages: 0
  };
  tabs.push(t);
  return t;
}

/** 新建标签页并切换过去 */
export async function openDocument({ bytes, filePath, fileName, dirty = false }) {
  if (getActive()) captureActive();
  const t = createTab({ bytes, filePath, fileName, dirty });
  activeId = t.id;
  applyTab(t);
  state.zoomMode = 'fit-width';
  state.currentPage = 1;
  await viewer.mountDocument(t);
  renderTabStrip();
  return t;
}

/** 切换标签页 */
export async function activateTab(id) {
  if (id === activeId) return;
  const t = tabs.find((x) => x.id === id);
  if (!t) return;
  captureActive();
  activeId = id;
  applyTab(t);
  await viewer.mountDocument(t);
  renderTabStrip();
}

/** 关闭标签页 */
export async function closeTab(id) {
  const t = tabs.find((x) => x.id === id);
  if (!t) return false;
  if (t.id === activeId) captureActive();
  if (t.dirty) {
    const ok = await confirmDialog('关闭文档', `「${t.fileName}」有未保存的修改，确定关闭吗？`, '仍要关闭');
    if (!ok) return false;
  }
  const idx = tabs.indexOf(t);
  const wasActive = t.id === activeId;
  tabs.splice(idx, 1);
  if (t.pdfDoc) { try { t.pdfDoc.destroy(); } catch (e) { /* 忽略 */ } }
  if (tabs.length === 0) {
    activeId = null;
    return { empty: true };
  }
  if (wasActive) {
    const next = tabs[Math.min(idx, tabs.length - 1)];
    activeId = next.id;
    applyTab(next);
    await viewer.mountDocument(next);
  }
  renderTabStrip();
  return true;
}

/** 页面操作 / 保存后刷新当前标签页字节 */
export async function replaceActiveBytes(bytes, { dirty = true, keepZoom = true } = {}) {
  const t = getActive();
  state.workBytes = cloneBytes(bytes);
  state.annotations = {};
  state.undo = []; state.redo = [];
  await viewer.reparse(state.workBytes);
  if (t) {
    t.workBytes = state.workBytes;
    t.annotations = state.annotations;
    t.undo = state.undo; t.redo = state.redo;
    t.pdfDoc = state.pdfDoc;
    t.pageInfo = state.pageInfo;
    t.defaultSize = state.defaultSize;
    t.numPages = state.numPages;
    t.zoom = state.zoom;
    t.zoomMode = state.zoomMode;
    t.currentPage = state.currentPage;
    t.dirty = dirty;
  }
  setDirty(dirty);
  void keepZoom;
  renderTabStrip();
}

/** 建立新标签页后同步元数据（保存/另存为后） */
export function syncActiveMeta(patch) {
  const t = getActive();
  if (!t) return;
  Object.assign(t, patch);
  if (patch.fileName) state.fileName = patch.fileName;
  if (patch.filePath !== undefined) state.filePath = patch.filePath;
  renderTabStrip();
}

/* ---------------- 标签条渲染 ---------------- */
export function renderTabStrip() {
  const strip = document.getElementById('doc-tabs');
  if (!strip) return;
  strip.innerHTML = '';
  if (!tabs.length) {
    strip.classList.add('empty');
    strip.dataset.empty = t('没有打开的文档');
    return;
  }
  strip.classList.remove('empty');
  for (const tab of tabs) {
    const el = document.createElement('div');
    el.className = 'doc-tab' + (tab.id === activeId ? ' active' : '');
    el.title = tab.filePath || tab.fileName;
    el.innerHTML = `<span class="dt-icon">${icon()}</span>`
      + `<span class="dt-name">${escapeHtml(tab.fileName)}</span>`
      + (tab.dirty ? '<span class="dt-dot" title="' + t('未保存') + '"></span>' : '')
      + `<button class="dt-close" title="${t('关闭（Ctrl+W）')}">✕</button>`;
    el.onclick = (e) => {
      if (e.target.closest('.dt-close')) return;
      activateTab(tab.id);
    };
    el.querySelector('.dt-close').onclick = async (e) => {
      e.stopPropagation();
      const r = await closeTab(tab.id);
      if (r && r.empty) onEmpty();
    };
    strip.appendChild(el);
  }
}

let onEmpty = () => {};
export function setEmptyHandler(fn) { onEmpty = fn; }

function icon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>';
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

void toast;
