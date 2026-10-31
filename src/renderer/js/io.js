// 文件输入输出
import { state, resetDocumentState, setDirty, cloneBytes } from './state.js';
import { goToPage, extractText, renderPageToCanvas, getViewport, showViewerLoading, hideViewerLoading } from './viewer.js';
import { bakeBytes, createFromImages } from './ops.js';
import { docxToPdf } from './docx.js';
import { t } from './i18n.js';
import * as Tabs from './tabs.js';
import { insertImageAnnotation, insertImageToCurrentPage, setMode } from './annotate.js';
import { toast, withLoading, confirmDialog } from './ui.js';

const IMG_RE = /\.(png|jpe?g|gif|bmp|webp)$/i;

/* ---------------- 打开 ---------------- */
export async function pickAndOpen() {
  const r = await window.pdfmini.file.pick({ title: t('打开 PDF') });
  if (!r.ok) return;
  for (const p of r.paths) await openPath(p);
}

export async function openPath(filePath) {
  // 只使用阅读区内的加载指示，避免与全局遮罩同时出现
  hideWelcome();
  showViewerLoading();
  const r = await window.pdfmini.file.read(filePath);
  if (!r.ok) {
    hideViewerLoading();
    syncEmptyState();
    return toast(t('打开失败：') + (r.error || ''), 'err');
  }
  try {
    const bytes = new Uint8Array(r.data);
    await Tabs.openDocument({ bytes, filePath: r.path, fileName: r.name });
    syncEmptyState();
    syncTitle();
    state.undo = [];
    state.redo = [];
    await window.pdfmini.recent.add({ path: r.path, name: r.name });
  } catch (e) {
    hideViewerLoading();
    syncEmptyState();
    toast(t('打开失败：') + (e && e.message || e), 'err');
  }
}

/** 用内存字节新建一个标签页 */
/* ---------------- 导入（图片 / Word / PDF） ---------------- */
/** 统一的导入入口：图片→图片转 PDF，Word(.docx)→Word 转 PDF，PDF→直接打开 */
export async function pickImport() {
  const r = await window.pdfmini.file.pick({
    title: t('选择图片或 Word 文档'),
    filters: [{ name: t('图片或 Word'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'docx'] }],
    multi: true
  });
  if (!r.ok) return;
  await importPaths(r.paths);
}

export async function importPaths(paths) {
  const list = Array.from(paths || []);
  if (!list.length) return;
  const pdfs = list.filter((p) => /\.pdf$/i.test(p));
  const docxs = list.filter((p) => /\.docx$/i.test(p));
  const imgs = list.filter((p) => IMG_RE.test(p));
  if (!pdfs.length && !docxs.length && !imgs.length) {
    return toast(t('仅支持 PDF、图片或 Word（.docx）文件'), 'err');
  }
  for (const p of pdfs) await openPath(p);
  for (const p of docxs) await docxPathToPdf(p);
  if (imgs.length) await imagesToPdfFromPaths(imgs);
}

/** 拖入的 File 对象（Electron 下带 path） */
export async function importFiles(files) {
  const list = Array.from(files || []);
  const paths = list.map((f) => f.path).filter(Boolean);
  if (paths.length === list.length && list.length) return importPaths(paths);
  // 无路径（例如粘贴的 File）：按名称分类
  const docxs = list.filter((f) => /\.docx$/i.test(f.name));
  const imgs = list.filter((f) => IMG_RE.test(f.name));
  const pdfs = list.filter((f) => /\.pdf$/i.test(f.name));
  for (const f of pdfs) if (f.path) await openPath(f.path);
  for (const f of docxs) await docxFileToPdf(f);
  if (imgs.length) await imagesToPdfFromFiles(imgs);
}

async function docxPathToPdf(p) {
  const r = await window.pdfmini.file.read(p);
  if (!r.ok) return toast(t('打开失败：') + (r.error || ''), 'err');
  const name = (r.name || 'document.docx').replace(/\.docx$/i, '') + '.pdf';
  await docxBytesToPdf(new Uint8Array(r.data), name);
}

async function docxFileToPdf(file) {
  const buf = await file.arrayBuffer();
  const name = (file.name || 'document.docx').replace(/\.docx$/i, '') + '.pdf';
  await docxBytesToPdf(new Uint8Array(buf), name);
}

async function docxBytesToPdf(bytes, name) {
  await withLoading(t('正在转换 Word 文档…'), async () => {
    try {
      const pdfBytes = await docxToPdf(bytes);
      await Tabs.openDocument({ bytes: pdfBytes, fileName: name, dirty: true });
      syncEmptyState();
      syncTitle();
      toast(t('Word 文档已转换为 PDF'), 'ok');
    } catch (e) {
      const msg = String(e && e.message || e);
      toast(t('Word 转换失败：') + (msg === 'empty document' ? t('此 .docx 文件为空或无法解析') : msg), 'err');
    }
  });
}

function bytesToDataUrl(bytes, mime) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:${mime || 'image/png'};base64,${btoa(bin)}`;
}

async function imagesToPdfFromPaths(paths) {
  const urls = [];
  for (const p of paths) {
    const r = await window.pdfmini.file.read(p);
    if (!r.ok) continue;
    const ext = (p.split('.').pop() || 'png').toLowerCase();
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
      : ext === 'gif' ? 'image/gif' : ext === 'bmp' ? 'image/bmp' : ext === 'webp' ? 'image/webp' : 'image/png';
    urls.push(bytesToDataUrl(new Uint8Array(r.data), mime));
  }
  if (!urls.length) return toast(t('打开失败：') + '', 'err');
  await imagesToPdfFromUrls(urls);
}

async function imagesToPdfFromUrls(urls) {
  await withLoading(t('正在生成 PDF…'), async () => {
    await createFromImages(urls);
    syncEmptyState();
    syncTitle();
  });
  toast(t('已由图片生成 PDF'), 'ok');
}

/* ---------------- 保存 ---------------- */
export async function saveDoc() {
  if (!state.pdfDoc) return toast(t('没有打开的文档'));
  if (!state.filePath) return saveDocAs();
  await withLoading(t('正在保存…'), async () => {
    const bytes = await bakeBytes(true);
    const r = await window.pdfmini.file.writeInPlace({ path: state.filePath, data: bytes });
    if (!r.ok) return toast(t('保存失败：') + (r.error || ''), 'err');
    await afterSave(bytes, r.path, r.name);
    toast(t('已保存'), 'ok');
  });
}

export async function saveDocAs() {
  if (!state.pdfDoc) return toast(t('没有打开的文档'));
  await withLoading(t('正在保存…'), async () => {
    const bytes = await bakeBytes(true);
    const def = state.filePath || state.fileName || t('未命名.pdf');
    const r = await window.pdfmini.file.save({
      data: bytes, defaultPath: def,
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (!r.ok) return;
    await afterSave(bytes, r.path, r.name);
    await window.pdfmini.recent.add({ path: r.path, name: r.name });
    toast(t('已另存为 ') + r.name, 'ok');
  });
}

async function afterSave(bytes, path, name) {
  await Tabs.replaceActiveBytes(bytes, { dirty: false });
  Tabs.syncActiveMeta({ filePath: path, fileName: name, dirty: false });
  setDirty(false);
  syncTitle();
}

/* ---------------- 导出 ---------------- */
export async function exportText() {
  if (!state.pdfDoc) return;
  await withLoading(t('正在提取文本…'), async () => {
    const text = await extractText();
    const name = (state.fileName || 'document.pdf').replace(/\.pdf$/i, '') + '.txt';
    const r = await window.pdfmini.file.saveText({ text, defaultName: name });
    if (r.ok) toast(t('文本已导出'), 'ok');
  });
}

export async function exportPageImage(pageNo) {
  if (!state.pdfDoc) return;
  await withLoading(t('正在生成图片…'), async () => {
    const canvas = await renderPageToCanvas(pageNo, 2);
    const dataUrl = canvas.toDataURL('image/png');
    const name = (state.fileName || 'page').replace(/\.pdf$/i, '') + `-p${pageNo}.png`;
    const r = await window.pdfmini.file.saveImage({ dataUrl, defaultName: name });
    if (r.ok) toast(t('图片已导出'), 'ok');
  });
}

/* ---------------- 关闭 / 还原 ---------------- */
export async function closeActiveDoc() {
  const tab = Tabs.getActive();
  if (!tab) return toast(t('没有打开的文档'));
  const r = await Tabs.closeTab(tab.id);
  if (r && r.empty) { await onAllClosed(); return; }
  syncEmptyState();
  syncTitle();
}

export async function onAllClosed() {
  resetDocumentState();
  setDirty(false);
  state.filePath = null;
  state.fileName = t('未命名.pdf');
  state.originalBytes = null;
  state.workBytes = null;
  const pages = document.getElementById('pages');
  if (pages) pages.innerHTML = '';
  showWelcome();
  syncEmptyState();
  syncTitle();
}

export async function revertDoc() {
  if (!state.originalBytes) return;
  const ok = await confirmDialog(t('放弃修改'), t('将放弃所有未保存的修改，恢复到打开时的状态，确定吗？'), t('放弃修改'));
  if (!ok) return;
  await Tabs.replaceActiveBytes(cloneBytes(state.originalBytes), { dirty: false });
  toast(t('已还原到打开时的状态'));
}

/* ---------------- 界面 ---------------- */
export function syncTitle() {
  const el = document.getElementById('tb-file');
  if (el) el.textContent = state.pdfDoc ? state.fileName : '';
  document.title = (state.pdfDoc ? state.fileName + ' — ' : '') + 'PDFmini';
}

export function showWelcome() {
  const w = document.getElementById('welcome');
  if (w) w.classList.remove('hidden');
  renderRecent();
}
export function hideWelcome() {
  const w = document.getElementById('welcome');
  if (w) w.classList.add('hidden');
}

/** 无文档时隐藏侧栏/标签条与顶部工具栏，避免残留 */
export function syncEmptyState() {
  const has = Tabs.tabCount() > 0;
  const sb = document.getElementById('sidebar');
  const rz = document.getElementById('sb-resizer');
  const tb = document.getElementById('tabbar');
  document.body.classList.toggle('home', !has);
  if (has) {
    hideWelcome();
    if (sb) sb.classList.remove('collapsed');
    if (rz) rz.style.display = '';
    if (tb) tb.style.display = '';
  } else {
    showWelcome();
    if (sb) sb.classList.add('collapsed');
    if (rz) rz.style.display = 'none';
    if (tb) tb.style.display = 'none';
    // 仅清理生成内容，保留搜索面板的输入框等结构
    for (const id of ['pane-thumbnails', 'pane-bookmarks', 'search-results']) {
      const p = document.getElementById(id);
      if (p) p.innerHTML = '';
    }
    const c = document.getElementById('search-count');
    if (c) c.textContent = '';
    const si = document.getElementById('search-input');
    if (si) si.value = '';
  }
}

export async function renderRecent() {
  const box = document.getElementById('welcome-recent');
  if (!box) return;
  const list = await window.pdfmini.recent.list();
  if (!list.length) { box.innerHTML = ''; return; }
  box.innerHTML = '<h4>' + t('最近打开') + '</h4>' + list.slice(0, 6).map((f) => `
    <div class="recent-item" data-path="${escapeAttr(f.path)}">
      <span class="ri-name">${escapeHtml(f.name || f.path)}</span>
      <span class="ri-path">${escapeHtml(f.path)}</span>
    </div>`).join('');
  box.querySelectorAll('.recent-item').forEach((el) => {
    el.onclick = () => openPath(el.dataset.path);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/'/g, '&#39;'); }

/* ---------------- 拖拽 ---------------- */
export function initDropZone() {
  const hint = document.getElementById('drop-hint');
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    depth++;
    if (hint) {
      hint.textContent = t(state.pdfDoc ? '松开以插入图片 / 打开 PDF' : '松开以打开 PDF');
      hint.classList.add('on');
    }
  });
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth && hint) hint.classList.remove('on');
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    if (hint) hint.classList.remove('on');
    const files = Array.from(e.dataTransfer.files || []);
    if (!files.length) return;

    const pdfs = files.filter((f) => /\.pdf$/i.test(f.name) && f.path);
    if (pdfs.length) { for (const f of pdfs) await openPath(f.path); return; }

    // Word / 其它 → 走统一导入（图片→转 PDF、Word→转 PDF）
    const docxs = files.filter((f) => /\.docx$/i.test(f.name));
    if (docxs.length) { await importFiles(files); return; }

    const imgs = files.filter((f) => IMG_RE.test(f.name));
    if (!imgs.length) return toast(t('仅支持 PDF、图片或 Word（.docx）文件'), 'err');

    const wrap = document.elementFromPoint(e.clientX, e.clientY);
    const pageEl = wrap && wrap.closest ? wrap.closest('.page-wrap') : null;
    if (state.pdfDoc && pageEl) {
      // 插入到落点所在页（保留原有行为）
      const n = Number(pageEl.dataset.page);
      const r = pageEl.getBoundingClientRect();
      const vp = getViewport(n);
      const p = vp.convertToPdfPoint(e.clientX - r.left, e.clientY - r.top);
      const url = await readFileAsDataURL(imgs[0]);
      if (state.mode !== 'edit') setMode('edit');
      insertImageAnnotation(n, { x: p[0], y: p[1] }, url, imgs[0].type, 'image');
      return;
    }
    if (state.pdfDoc) {
      const url = await readFileAsDataURL(imgs[0]);
      if (state.mode !== 'edit') setMode('edit');
      insertImageToCurrentPage(url, imgs[0].type);
      return;
    }
    await imagesToPdfFromFiles(imgs);
  });
}

export async function imagesToPdfFromFiles(files) {
  const dataUrls = await Promise.all(files.map(readFileAsDataURL));
  await imagesToPdfFromUrls(dataUrls);
}

export function readFileAsDataURL(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
}
