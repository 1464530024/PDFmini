// 应用入口：模式/分组工具栏、文档标签页、对话框、快捷键
import { state, setDirty } from './state.js';
import { icon } from './icons.js';
import { t, setLocale, getLocale, onLocale } from './i18n.js';
import {
  toast, openModal, openMenu, confirmDialog, alertDialog, field, showLoading, hideLoading
} from './ui.js';
import {
  initViewer, goToPage, zoomIn, zoomOut, fitWidth, fitPage, setZoom, setRotation,
  setOverlayDrawer, updateOverlays, renderPageToCanvas, scrollRatio, displaySize, extractText,
  showViewerLoading, renderPage
} from './viewer.js';
import {
  initAnnotate, setTool, setMode, onModeChange, drawOverlay, undo, redo, annotateSelection, hasSelection,
  openStampMenu, annotationsCount, clearAllAnnotations, snapshot, push, insertImageAnnotation, pickAndInsertImage,
  openLinkDialog, selectById, hitLineAt, insertImageToCurrentPage,
  hitTextBlock, textBlockCount,
  TEXT_FONTS, TEXT_COLORS, TEXT_SIZES
} from './annotate.js';
import * as IO from './io.js';
import * as OPS from './ops.js';
import * as SB from './sidebar.js';
import * as Tabs from './tabs.js';

const $ = (s) => document.querySelector(s);

/* ================= 按钮工厂 ================= */
function tbtn({ icon: ic, label, title, tool, onClick, onContextMenu, slim, id, disabled }) {
  const b = document.createElement('button');
  b.className = 'tbtn' + (slim ? ' slim' : '');
  if (id) b.id = id;
  if (tool) b.dataset.tool = tool;
  b.title = title || label || '';
  b.innerHTML = icon(ic) + (label ? `<span class="lbl">${label}</span>` : '');
  if (onClick) b.onclick = (e) => onClick(e, b);
  if (onContextMenu) b.oncontextmenu = (e) => { e.preventDefault(); onContextMenu(e, b); };
  if (disabled) b.disabled = true;
  return b;
}

/** 插入文字：默认字体 / 字号 / 颜色 下拉菜单 */
function openTextPresetMenu(anchor) {
  if (!hasDoc()) return;
  openMenu(anchor, [
    { title: t('默认字体') },
    ...TEXT_FONTS.map((f) => ({
      label: t(f.name), checked: (state.toolOptions.font || 'hei') === f.id,
      onClick: () => { state.toolOptions.font = f.id; }
    })),
    { sep: true },
    { title: t('默认字号') },
    ...TEXT_SIZES.filter((s) => [10, 12, 14, 16, 18, 20, 24, 28, 32].includes(s)).map((s) => ({
      label: `${s} pt`, checked: state.toolOptions.fontSize === s,
      onClick: () => { state.toolOptions.fontSize = s; }
    })),
    { sep: true },
    { title: t('默认颜色') },
    {
      colors: TEXT_COLORS,
      onPick: (c) => { state.toolOptions.fontColor = c; }
    },
    { sep: true },
    { label: t('在页面上点击即可插入'), icon: 'text', onClick: () => setTool('insertText', true) }
  ], { minWidth: 210 });
}
function sep() { const s = document.createElement('span'); s.className = 'tb-sep'; return s; }

function hasDoc() {
  if (!state.pdfDoc) { toast(t('请先打开 PDF'), 'err'); return false; }
  return true;
}

/** 在当前页中央创建一个链接框并打开编辑对话框 */
function addLinkQuick(kind) {
  if (state.mode !== 'edit') { setMode('edit'); }
  const page = state.currentPage;
  const info = state.pageInfo[page] || state.defaultSize || { view: [0, 0, 595.28, 841.89] };
  const w = 200, h = 24;
  const x = (info.view[0] + info.view[2]) / 2 - w / 2;
  const y = (info.view[1] + info.view[3]) / 2 - h / 2;
  const targetPage = kind === 'page' ? Math.min(state.numPages || 1, page + 1) : 0;
  openLinkDialog(page, { x, y, w, h, url: '', targetPage }, true);
}

/* ================= 模式与分组定义 ================= */
function ctxGroups(mode) {
  return mode === 'edit'
    ? [
      { id: 'text', label: t('文字与图片') },
      { id: 'annot', label: t('批注') },
      { id: 'page', label: t('页面') },
      { id: 'tools', label: t('工具') }
    ]
    : [
      { id: 'view', label: t('视图') },
      { id: 'nav', label: t('导航') }
    ];
}
let activeCtx = { view: 'view', edit: 'text' };

function ctxBuilders() {
  return {
    /* ---- 浏览 ---- */
    view: () => [
      tbtn({ icon: 'sidebar', label: t('侧栏'), onClick: (e, b) => { const on = SB.toggleSidebar(); b.classList.toggle('active', on); } }),
      sep(),
      tbtn({ icon: 'zoomOut', label: t('缩小'), title: t('缩小 (Ctrl+-)'), onClick: () => zoomOut() }),
      tbtn({ icon: 'actualSize', label: Math.round(state.zoom * 100) + '%', title: t('点击恢复实际大小 (Ctrl+0)'), id: 'zoom-btn', onClick: () => setZoom(1) }),
      tbtn({ icon: 'zoomIn', label: t('放大'), title: t('放大 (Ctrl+=)'), onClick: () => zoomIn() }),
      sep(),
      tbtn({ icon: 'fitW', label: t('适应宽度'), onClick: () => fitWidth() }),
      tbtn({ icon: 'fitP', label: t('适应页面'), onClick: () => fitPage() }),
      tbtn({ icon: 'rotate', label: t('旋转视图'), onClick: () => { setRotation(state.rotation + 90); toast(t('视图旋转 {n}°', { n: state.rotation })); } }),
      tbtn({ icon: 'fullscreen', label: t('全屏'), title: t('全屏 (F11)'), onClick: () => document.documentElement.requestFullscreen().catch(() => {}) })
    ],
    nav: () => [
      tbtn({ icon: 'moveUp', label: t('首页'), onClick: () => goToPage(1, { smooth: true }) }),
      tbtn({ icon: 'rotateLeft', label: t('上一页'), onClick: () => goToPage(state.currentPage - 1, { smooth: true }) }),
      tbtn({ icon: 'rotate', label: t('下一页'), onClick: () => goToPage(state.currentPage + 1, { smooth: true }) }),
      tbtn({ icon: 'moveDown', label: t('末页'), onClick: () => goToPage(state.numPages, { smooth: true }) }),
      sep(),
      tbtn({ icon: 'find', label: t('查找'), title: t('查找 (Ctrl+F)'), onClick: () => { SB.toggleSidebar(true); SB.switchTab('search'); } })
    ],

    /* ---- 编辑 ---- */
    text: () => [
      tbtn({
        icon: 'text', label: t('插入文字'), tool: 'insertText',
        title: t('点击页面任意位置输入新文字；右键本按钮可切换默认字体 / 字号 / 颜色'),
        onClick: (e, b) => {
          if (!hasDoc()) return;
          if (e && e.shiftKey) { openTextPresetMenu(b); return; }
          setTool('insertText');
        },
        onContextMenu: (e, b) => openTextPresetMenu(b)
      }),
      tbtn({ icon: 'image', label: t('添加图片'), title: t('打开文件夹选择图片（也支持 Ctrl+V 粘贴或直接拖入）'), onClick: () => pickAndInsertImage() }),
      tbtn({
        icon: 'eraser', label: t('框选删除'), tool: 'marquee',
        title: t('按住左键拖出一个方框（也可在其它工具下直接右键拖），松开后点「删除」确认'),
        onClick: () => setTool('marquee')
      }),
      sep(),
      tbtn({
        icon: 'link', label: t('链接'), tool: 'link',
        title: t('在页面上拖拽划出链接区域；也可从菜单快速添加'),
        onClick: (e, b) => {
          if (!hasDoc()) return;
          openMenu(b, [
            { title: t('添加链接') },
            { label: t('网页链接…'), icon: 'link', onClick: () => addLinkQuick('url') },
            { label: t('跳转到指定页…'), icon: 'moveDown', onClick: () => addLinkQuick('page') },
            { sep: true },
            { label: t('在页面上拖拽划出区域'), icon: 'select', onClick: () => setTool('link') }
          ], { minWidth: 210 });
        }
      }),
      sep(),
      tbtn({ icon: 'stamp', label: t('图章'), tool: 'stamp', onClick: (e, b) => openStampMenu(b) }),
      tbtn({ icon: 'sign', label: t('签名'), tool: 'signature', onClick: () => setTool('signature') })
    ],
    annot: () => [
      tbtn({
        icon: 'highlight', label: t('高亮'), tool: 'highlight',
        onClick: (e, b) => {
          if (hasSelection()) { setTool('highlight', true); annotateSelection('highlight'); return; }
          openMenu(b, [
            { title: t('高亮颜色'), colors: ['#ffd400', '#ff9f1c', '#8ce99a', '#74c0fc', '#f783ac', '#e4002b'], onPick: (c) => { state.toolOptions.color = c; setTool('highlight', true); } },
            { sep: true },
            { label: t('标注所选文本'), icon: 'select', onClick: () => annotateSelection('highlight') }
          ], { minWidth: 220 });
        }
      }),
      tbtn({ icon: 'underline', label: t('下划线'), tool: 'underline', onClick: () => setTool('underline') }),
      tbtn({ icon: 'strike', label: t('删除线'), tool: 'strikeout', onClick: () => setTool('strikeout') }),
      sep(),
      tbtn({ icon: 'text', label: t('文本框'), tool: 'text', onClick: () => setTool('text') }),
      tbtn({ icon: 'note', label: t('便签'), tool: 'note', onClick: () => setTool('note') }),
      tbtn({
        icon: 'ink', label: t('墨迹'), tool: 'ink',
        onClick: (e, b) => openMenu(b, [
          { title: t('画笔颜色'), colors: ['#e4002b', '#14161a', '#1565c0', '#12a150', '#e08d00'], onPick: (c) => { state.toolOptions.textColor = c; setTool('ink', true); } },
          { sep: true },
          { title: t('粗细') },
          ...[1, 2, 3, 5].map((w) => ({ label: `${w} px`, checked: state.toolOptions.strokeWidth === w, onClick: () => { state.toolOptions.strokeWidth = w; setTool('ink', true); } }))
        ])
      }),
      tbtn({
        icon: 'shape', label: t('形状'), tool: 'shape',
        onClick: (e, b) => openMenu(b, [
          { title: t('形状类型') },
          { label: t('矩形'), icon: 'shape', checked: state.toolOptions.shape === 'rect', onClick: () => { state.toolOptions.shape = 'rect'; setTool('shape', true); } },
          { label: t('椭圆'), icon: 'shape', checked: state.toolOptions.shape === 'ellipse', onClick: () => { state.toolOptions.shape = 'ellipse'; setTool('shape', true); } },
          { label: t('直线'), icon: 'strike', checked: state.toolOptions.shape === 'line', onClick: () => { state.toolOptions.shape = 'line'; setTool('shape', true); } },
          { sep: true },
          { title: t('线条颜色'), colors: ['#e4002b', '#14161a', '#1565c0', '#12a150', '#e08d00'], onPick: (c) => { state.toolOptions.textColor = c; setTool('shape', true); } }
        ])
      }),
      tbtn({ icon: 'eraser', label: t('橡皮擦'), tool: 'eraser', title: t('点击批注直接删除'), onClick: () => setTool('eraser') })
    ],
    page: () => [
      tbtn({ icon: 'pages', label: t('页面管理'), onClick: () => openPageManager() }),
      tbtn({ icon: 'blank', label: t('插入空白页'), onClick: () => openInsertDialog() }),
      tbtn({ icon: 'insert', label: t('从文件插入'), onClick: () => openInsertFromFile() }),
      sep(),
      tbtn({ icon: 'merge', label: t('合并 PDF'), onClick: () => openMergeDialog() }),
      tbtn({ icon: 'split', label: t('拆分 PDF'), onClick: () => openSplitDialog() }),
      tbtn({ icon: 'crop', label: t('裁剪页面'), onClick: () => openCropDialog() })
    ],
    tools: () => [
      tbtn({ icon: 'watermark', label: t('水印'), onClick: () => openWatermarkDialog() }),
      tbtn({ icon: 'header', label: t('页眉页脚'), onClick: () => openHeaderFooterDialog() }),
      tbtn({ icon: 'pagenum', label: t('页码'), onClick: () => openPageNumberDialog() }),
      tbtn({ icon: 'form', label: t('填写表单'), onClick: () => openFormDialog() }),
      sep(),
      tbtn({ icon: 'textExport', label: t('导出文本'), onClick: () => IO.exportText() }),
      tbtn({ icon: 'image', label: t('导出图片'), title: t('导出当前页为图片'), onClick: () => IO.exportPageImage(state.currentPage) }),
      tbtn({ icon: 'eraser', label: t('清除批注'), onClick: async () => { if (await confirmDialog(t('清除批注'), t('确定清除当前文档的全部批注吗？'), t('清除'))) clearAllAnnotations(); } })
    ]
  };
}

function renderCtxTabs() {
  const box = $('#ctx-tabs');
  box.innerHTML = '';
  for (const g of ctxGroups(state.mode)) {
    const b = document.createElement('button');
    b.className = 'ctx-tab' + (activeCtx[state.mode] === g.id ? ' active' : '');
    b.textContent = g.label;
    b.onclick = () => { activeCtx[state.mode] = g.id; renderCtxTabs(); renderMainToolbar(); };
    box.appendChild(b);
  }
}

function renderMainToolbar() {
  const g = $('#grp-main');
  g.innerHTML = '';
  const builders = ctxBuilders();
  const id = activeCtx[state.mode];
  const fallback = ctxGroups(state.mode)[0].id;
  const items = (builders[id] || builders[fallback])();
  items.forEach((el) => g.appendChild(el));
}

function renderModeRow() {
  document.querySelectorAll('.mode-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === state.mode);
    b.textContent = t(b.dataset.mode === 'edit' ? '编辑' : '浏览');
  });
  renderCtxTabs();
}

/* ================= 模式切换 ================= */
function switchMode(mode) {
  if (state.mode === mode) return;
  setMode(mode);
}

/** setMode 的统一回调：保证界面与状态永远同步 */
function onModeChanged(mode) {
  renderModeRow();
  renderMainToolbar();
  const sm = $('#st-mode');
  if (sm) sm.textContent = t(mode === 'edit' ? '编辑模式' : '浏览模式');
  const note = $('#mode-note');
  if (note) note.textContent = mode === 'edit' ? t('编辑模式：修改内容后请记得保存') : '';
}

/* ================= 功能栏右侧常驻按钮（始终显示文字） ================= */
function buildRightBar() {
  const box = $('#grp-rightbar');
  box.innerHTML = '';
  box.append(
    tbtn({ icon: 'open', label: t('打开'), title: t('打开 (Ctrl+O)'), onClick: () => IO.pickAndOpen() }),
    tbtn({ icon: 'save', label: t('保存'), title: t('保存 (Ctrl+S)'), onClick: () => IO.saveDoc() }),
    tbtn({ icon: 'undo', label: t('撤销'), title: t('撤销 (Ctrl+Z)'), onClick: () => undo() }),
    tbtn({ icon: 'redo', label: t('重做'), title: t('重做 (Ctrl+Y)'), onClick: () => redo() }),
    tbtn({ icon: 'trash', label: t('关闭'), title: t('关闭当前文档 (Ctrl+W)'), onClick: () => IO.closeActiveDoc() }),
    tbtn({
      icon: 'more', label: t('更多'), title: t('更多'),
      onClick: (e, b) => openMenu(b, [
        { label: t('另存为…'), icon: 'saveAs', key: 'Ctrl+Shift+S', onClick: () => IO.saveDocAs() },
        { label: t('还原到打开时'), icon: 'undo', onClick: () => IO.revertDoc() },
        { sep: true },
        { label: t('导入图片 / Word…'), icon: 'image', onClick: () => IO.pickImport() },
        { label: t('页面管理'), icon: 'pages', onClick: () => openPageManager() },
        {
          label: t('文字缺失修复'), icon: 'editText', checked: state.textRepair !== false,
          onClick: () => toggleTextRepair()
        },
        { sep: true },
        { title: t('界面语言') },
        { label: t('中文'), checked: getLocale() === 'zh-CN', onClick: () => applyLocale('zh-CN') },
        { label: t('英文'), checked: getLocale() === 'en-US', onClick: () => applyLocale('en-US') },
        { sep: true },
        { label: t('使用说明'), icon: 'help', onClick: () => openHelp() },
        { label: t('关于 PDFmini'), icon: 'info', onClick: () => openAbout() }
      ], { minWidth: 230 })
    })
  );
}

/* ================= 页面管理 ================= */
async function openPageManager() {
  if (!state.pdfDoc) return t('没有打开的文档');
  const body = document.createElement('div');
  body.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
      <button class="btn-ghost" id="pm-all" style="height:30px;padding:0 12px">${t('全选')}</button>
      <button class="btn-ghost" id="pm-none" style="height:30px;padding:0 12px">${t('全不选')}</button>
      <span class="hint" id="pm-stat"></span>
      <span style="flex:1"></span>
      <span class="hint">${t('点击选择页面')}</span>
    </div>
    <div class="page-grid" id="pm-grid"></div>
    <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
      <button class="btn-ghost" id="pm-del" style="height:32px">${t('删除所选')}</button>
      <button class="btn-ghost" id="pm-rotl" style="height:32px">${t('左转 90°')}</button>
      <button class="btn-ghost" id="pm-rotr" style="height:32px">${t('右转 90°')}</button>
      <button class="btn-ghost" id="pm-extract" style="height:32px">${t('提取所选')}</button>
      <button class="btn-ghost" id="pm-extract-sep" style="height:32px">${t('逐页导出')}</button>
      <button class="btn-ghost" id="pm-moveup" style="height:32px">${t('上移')}</button>
      <button class="btn-ghost" id="pm-movedown" style="height:32px">${t('下移')}</button>
    </div>`;

  const selected = new Set();
  let order = Array.from({ length: state.numPages }, (_, i) => i + 1);

  const modal = openModal({
    title: t('页面管理'), body, width: 740,
    footer: [{ label: t('完成'), kind: 'btn-primary', onClick: ({ close }) => close() }]
  });

  const grid = body.querySelector('#pm-grid');
  const stat = body.querySelector('#pm-stat');
  const updateStat = () => { stat.textContent = t('已选 {n} / 共 {t} 页', { n: selected.size, t: state.numPages }); };

  async function drawGrid() {
    grid.innerHTML = '';
    const limit = Math.min(order.length, 300);
    for (let i = 0; i < limit; i++) {
      const p = order[i];
      const sz = displaySize(p, 1);
      const cell = document.createElement('div');
      cell.className = 'page-cell' + (selected.has(p) ? ' sel' : '');
      cell.dataset.page = String(p);
      cell.innerHTML = `<div class="page-ph" style="aspect-ratio:${sz.w}/${sz.h}"></div>`
        + (selected.has(p) ? '<span class="pc-del">✓</span>' : '')
        + `<span class="pc-no">${p}</span>`;
      cell.onclick = () => toggle(p, cell);
      grid.appendChild(cell);
    }
    if (order.length > limit) {
      const note = document.createElement('div');
      note.className = 'hint';
      note.style.gridColumn = '1 / -1';
      note.textContent = t('（仅显示前 {n} 页缩略图，操作仍对全部页面有效）', { n: limit });
      grid.appendChild(note);
    }
    updateStat();
    const io = new IntersectionObserver((entries) => {
      entries.forEach(async (en) => {
        if (!en.isIntersecting) return;
        const cell = en.target;
        if (cell.dataset.done) return;
        cell.dataset.done = '1';
        const p = Number(cell.dataset.page);
        const page = await state.pdfDoc.getPage(p);
        const vp = page.getViewport({ scale: 0.2, rotation: page.rotate });
        const cv = document.createElement('canvas');
        cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
        cv.style.width = '100%'; cv.style.height = 'auto';
        await page.render({ canvasContext: cv.getContext('2d', { alpha: false }), viewport: vp }).promise;
        const ph = cell.querySelector('.page-ph');
        if (ph) ph.replaceWith(cv);
        io.unobserve(cell);
      });
    }, { root: body.querySelector('.modal-body'), rootMargin: '200px' });
    grid.querySelectorAll('.page-cell').forEach((c) => io.observe(c));
  }

  function toggle(p, cell) {
    if (selected.has(p)) selected.delete(p); else selected.add(p);
    cell.classList.toggle('sel', selected.has(p));
    let badge = cell.querySelector('.pc-del');
    if (selected.has(p) && !badge) {
      badge = document.createElement('span');
      badge.className = 'pc-del';
      badge.textContent = '✓';
      cell.insertBefore(badge, cell.querySelector('.pc-no'));
    } else if (!selected.has(p) && badge) badge.remove();
    updateStat();
  }

  await drawGrid();

  body.querySelector('#pm-all').onclick = () => { order.forEach((p) => selected.add(p)); drawGrid(); };
  body.querySelector('#pm-none').onclick = () => { selected.clear(); drawGrid(); };
  body.querySelector('#pm-del').onclick = async () => {
    if (!selected.size) return toast(t('请先选择页面'));
    if (selected.size >= state.numPages) return toast(t('不能删除全部页面'), 'err');
    await OPS.deletePages([...selected].sort((a, b) => a - b));
    modal.close();
  };
  body.querySelector('#pm-rotl').onclick = async () => { await OPS.rotatePages(selected.size ? [...selected] : [state.currentPage], -90); modal.close(); };
  body.querySelector('#pm-rotr').onclick = async () => { await OPS.rotatePages(selected.size ? [...selected] : [state.currentPage], 90); modal.close(); };
  body.querySelector('#pm-extract').onclick = async () => {
    if (!selected.size) return toast('请先选择页面');
    await OPS.extractPages([...selected].sort((a, b) => a - b), false);
  };
  body.querySelector('#pm-extract-sep').onclick = async () => {
    if (!selected.size) return toast('请先选择页面');
    await OPS.extractPages([...selected].sort((a, b) => a - b), true);
  };
  body.querySelector('#pm-moveup').onclick = () => move(-1);
  body.querySelector('#pm-movedown').onclick = () => move(1);

  async function move(dir) {
    if (selected.size !== 1) return toast(t('请只选择一页用于移动'));
    const p = [...selected][0];
    const idx = order.indexOf(p);
    const ni = idx + dir;
    if (ni < 0 || ni >= order.length) return;
    [order[idx], order[ni]] = [order[ni], order[idx]];
    await OPS.reorderPages(order.slice());
    order = order.map((_, i) => i + 1);
    selected.clear();
    selected.add(ni + 1);
    await drawGrid();
    toast(t('页面顺序已更新'), 'ok');
  }
}

/* ================= 插入 / 合并 / 拆分 / 裁剪 ================= */
function openInsertDialog() {
  if (!state.pdfDoc) return toast('没有打开的文档');
  const body = document.createElement('div');
  body.innerHTML = `
    ${field(t('插入位置'), `<select id="ins-pos">
      <option value="curr">${t('当前页之后（第 {n} 页）', { n: state.currentPage })}</option>
      <option value="end">${t('文档末尾')}</option>
      <option value="start">${t('文档开头')}</option>
    </select>`)}
    <div class="field"><label>${t('页面尺寸')}</label>
      <select id="ins-size">
        <option value="curr">${t('与当前页一致')}</option>
        <option value="a4">A4（595 × 842 pt）</option>
        <option value="a4l">${t('A4 横向')}</option>
        <option value="letter">Letter（612 × 792 pt）</option>
      </select>
    </div>
    <div class="field"><label>${t('插入页数')}</label><input type="number" id="ins-count" value="1" min="1" max="50" /></div>`;
  openModal({
    title: t('插入空白页'), body,
    footer: [
      { label: t('取消'), kind: 'btn-ghost', onClick: ({ close }) => close() },
      {
        label: t('插入'), kind: 'btn-primary', onClick: async ({ close, body: b }) => {
          const pos = b.querySelector('#ins-pos').value;
          const sizeSel = b.querySelector('#ins-size').value;
          const count = Math.max(1, Math.min(50, Number(b.querySelector('#ins-count').value) || 1));
          close();
          let after = state.currentPage;
          if (pos === 'end') after = state.numPages;
          if (pos === 'start') after = 0;
          let w, h;
          if (sizeSel === 'a4') { w = 595.28; h = 841.89; }
          else if (sizeSel === 'a4l') { w = 841.89; h = 595.28; }
          else if (sizeSel === 'letter') { w = 612; h = 792; }
          for (let i = 0; i < count; i++) await OPS.insertBlankPage(after + i, w, h);
          toast(t('已插入 {n} 页', { n: count }), 'ok');
        }
      }
    ]
  });
}

async function openInsertFromFile() {
  if (!state.pdfDoc) return toast('没有打开的文档');
  const r = await window.pdfmini.file.pick({ title: t('选择要插入的 PDF 或图片'), filters: [{ name: t('PDF 或图片'), extensions: ['pdf', 'png', 'jpg', 'jpeg'] }] });
  if (!r.ok) return;
  const p = r.paths[0];
  if (/\.pdf$/i.test(p)) { await OPS.insertPdfPages(p, state.currentPage); toast(t('已插入 PDF 页面'), 'ok'); return; }
  const fr = await window.pdfmini.file.read(p);
  const blob = new Blob([fr.data]);
  const dataUrl = await new Promise((res) => { const f = new FileReader(); f.onload = () => res(f.result); f.readAsDataURL(blob); });
  await OPS.insertImagePage(dataUrl, state.currentPage);
  toast(t('已插入图片页'), 'ok');
}

async function openMergeDialog() {
  const r = await window.pdfmini.file.pick({ title: t('选择要合并的 PDF（可多选）'), multi: true });
  if (!r.ok) return;
  if (!Tabs.tabCount()) { for (const p of r.paths) await IO.openPath(p); return; }
  await OPS.mergeFiles(r.paths);
}

function openSplitDialog() {
  if (!state.pdfDoc) return toast('没有打开的文档');
  const body = document.createElement('div');
  body.innerHTML = `
    ${field(t('拆分方式'), `<select id="sp-mode">
      <option value="every">${t('每 N 页拆分为一个文件')}</option>
      <option value="range">${t('按页码范围（如 1-3,4,5-8）')}</option>
    </select>`)}
    <div class="field" id="sp-n-wrap"><label>${t('每份页数')}</label><input type="number" id="sp-n" value="1" min="1" /></div>
    <div class="field hidden" id="sp-range-wrap"><label>${t('页码范围')}</label><input type="text" id="sp-range" placeholder="例如：1-3,4" /></div>
    <div class="hint">${t('拆分结果将逐个提示保存位置。')}</div>`;
  openModal({
    title: t('拆分 PDF'), body,
    footer: [
      { label: t('取消'), kind: 'btn-ghost', onClick: ({ close }) => close() },
      {
        label: t('开始拆分'), kind: 'btn-primary', onClick: async ({ close, body: b }) => {
          const mode = b.querySelector('#sp-mode').value;
          const val = mode === 'every' ? Number(b.querySelector('#sp-n').value) : b.querySelector('#sp-range').value;
          close();
          await OPS.splitPdf(mode, val);
        }
      }
    ],
    onMount: ({ body: b }) => {
      b.querySelector('#sp-mode').onchange = (e) => {
        const isEvery = e.target.value === 'every';
        b.querySelector('#sp-n-wrap').classList.toggle('hidden', !isEvery);
        b.querySelector('#sp-range-wrap').classList.toggle('hidden', isEvery);
      };
    }
  });
}

function openCropDialog() {
  if (!state.pdfDoc) return toast('没有打开的文档');
  const body = document.createElement('div');
  body.innerHTML = `
    ${field(t('应用范围'), `<select id="cr-scope">
      <option value="curr">${t('当前页（第 {n} 页）', { n: state.currentPage })}</option>
      <option value="all">${t('全部页面')}</option>
      <option value="range">${t('指定页')}</option>
    </select>`)}
    <div class="field hidden" id="cr-range-wrap"><label>${t('页码范围')}</label><input type="text" id="cr-range" placeholder="1-5" /></div>
    ${field(t('单位'), `<select id="cr-unit"><option value="mm">${t('毫米 (mm)')}</option><option value="pt">${t('磅 (pt)')}</option></select>`)}
    <div class="field-row">
      <div class="field"><label>${t('上边距')}</label><input type="number" id="cr-t" value="0" min="0" /></div>
      <div class="field"><label>${t('下边距')}</label><input type="number" id="cr-b" value="0" min="0" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>${t('左边距')}</label><input type="number" id="cr-l" value="0" min="0" /></div>
      <div class="field"><label>${t('右边距')}</label><input type="number" id="cr-r" value="0" min="0" /></div>
    </div>
    <div class="hint">${t('裁剪会修改页面可见区域（CropBox），内容不会丢失。')}</div>`;
  openModal({
    title: t('裁剪页面'), body,
    footer: [
      { label: t('取消'), kind: 'btn-ghost', onClick: ({ close }) => close() },
      {
        label: t('应用裁剪'), kind: 'btn-primary', onClick: async ({ close, body: b }) => {
          const scope = b.querySelector('#cr-scope').value;
          const unit = b.querySelector('#cr-unit').value;
          const margins = {
            top: Number(b.querySelector('#cr-t').value) || 0,
            bottom: Number(b.querySelector('#cr-b').value) || 0,
            left: Number(b.querySelector('#cr-l').value) || 0,
            right: Number(b.querySelector('#cr-r').value) || 0
          };
          let list = [state.currentPage];
          if (scope === 'all') list = Array.from({ length: state.numPages }, (_, i) => i + 1);
          if (scope === 'range') list = parseRange(b.querySelector('#cr-range').value, state.numPages);
          if (!list.length) return toast(t('页码范围无效'), 'err');
          close();
          await OPS.cropPages(list, margins, unit);
          toast(t('裁剪完成'), 'ok');
        }
      }
    ],
    onMount: ({ body: b }) => {
      b.querySelector('#cr-scope').onchange = (e) => {
        b.querySelector('#cr-range-wrap').classList.toggle('hidden', e.target.value !== 'range');
      };
    }
  });
}

function parseRange(str, max) {
  const out = [];
  for (const part of String(str || '').split(',')) {
    const s = part.trim();
    if (!s) continue;
    const m = s.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) { for (let i = +m[1]; i <= +m[2]; i++) if (i >= 1 && i <= max) out.push(i); }
    else if (/^\d+$/.test(s)) { const i = +s; if (i >= 1 && i <= max) out.push(i); }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/* ================= 水印 / 页眉页脚 / 页码 / 表单 ================= */
function openWatermarkDialog() {
  if (!state.pdfDoc) return toast('没有打开的文档');
  const body = document.createElement('div');
  body.innerHTML = `
    ${field(t('水印文字'), '<input type="text" id="wm-text" value="PDFmini" />')}
    <div class="field-row">
      <div class="field"><label>${t('字号')}</label><input type="number" id="wm-size" value="60" min="8" max="300" /></div>
      <div class="field"><label>${t('透明度')}</label><input type="number" id="wm-opacity" value="0.18" min="0.02" max="1" step="0.02" /></div>
    </div>
    <div class="field"><label>${t('颜色')}</label><input type="color" id="wm-color" value="#e4002b" style="width:70px;height:34px;padding:2px" /></div>
    <label class="field-check"><input type="checkbox" id="wm-diag" checked /> ${t('对角线倾斜样式')}</label>`;
  openModal({
    title: t('添加水印'), body,
    footer: [
      { label: t('取消'), kind: 'btn-ghost', onClick: ({ close }) => close() },
      {
        label: t('添加'), kind: 'btn-primary', onClick: async ({ close, body: b }) => {
          const opts = {
            text: b.querySelector('#wm-text').value || 'PDFmini',
            size: Number(b.querySelector('#wm-size').value) || 60,
            opacity: Number(b.querySelector('#wm-opacity').value) || 0.18,
            color: b.querySelector('#wm-color').value,
            diagonal: b.querySelector('#wm-diag').checked
          };
          close();
          await OPS.addWatermark(opts);
          toast(t('水印已添加'), 'ok');
        }
      }
    ]
  });
}

function openHeaderFooterDialog() {
  if (!state.pdfDoc) return toast('没有打开的文档');
  const body = document.createElement('div');
  body.innerHTML = `
    ${field(t('页眉文字'), '<input type="text" id="hf-header" placeholder="' + t('留空则不添加') + '" />')}
    ${field(t('页脚文字'), '<input type="text" id="hf-footer" placeholder="' + t('例如：{filename}   第 {page} 页') + '" />')}
    <div class="field-row">
      <div class="field"><label>字号</label><input type="number" id="hf-size" value="10" min="6" max="24" /></div>
      <div class="field"><label>${t('颜色')}</label><input type="color" id="hf-color" value="#333333" style="width:70px;height:34px;padding:2px" /></div>
    </div>
    <div class="hint">${t('支持占位符：{page} 当前页、{total} 总页数、{date} 日期、{filename} 文件名。')}</div>`;
  openModal({
    title: t('页眉 / 页脚'), body,
    footer: [
      { label: t('取消'), kind: 'btn-ghost', onClick: ({ close }) => close() },
      {
        label: t('添加'), kind: 'btn-primary', onClick: async ({ close, body: b }) => {
          const opts = {
            header: b.querySelector('#hf-header').value,
            footer: b.querySelector('#hf-footer').value,
            size: Number(b.querySelector('#hf-size').value) || 10,
            color: b.querySelector('#hf-color').value
          };
          if (!opts.header && !opts.footer) return toast(t('请至少填写页眉或页脚'));
          close();
          await OPS.addHeaderFooter(opts);
          toast(t('已添加页眉页脚'), 'ok');
        }
      }
    ]
  });
}

function openPageNumberDialog() {
  if (!state.pdfDoc) return toast('没有打开的文档');
  const body = document.createElement('div');
  body.innerHTML = `
    ${field(t('位置'), `<select id="pn-pos">
      <option value="bottom-center">${t('底部居中')}</option>
      <option value="bottom-right">${t('底部右侧')}</option>
      <option value="bottom-left">${t('底部左侧')}</option>
      <option value="top-center">${t('顶部居中')}</option>
      <option value="top-right">${t('顶部右侧')}</option>
    </select>`)}
    <div class="field-row">
      <div class="field"><label>字号</label><input type="number" id="pn-size" value="10" min="6" max="24" /></div>
      <div class="field"><label>${t('颜色')}</label><input type="color" id="pn-color" value="#333333" style="width:70px;height:34px;padding:2px" /></div>
    </div>
    <label class="field-check"><input type="checkbox" id="pn-en" /> ${t('使用英文格式（Page 1 of N）')}</label>`;
  openModal({
    title: t('添加页码'), body,
    footer: [
      { label: t('取消'), kind: 'btn-ghost', onClick: ({ close }) => close() },
      {
        label: t('添加'), kind: 'btn-primary', onClick: async ({ close, body: b }) => {
          const opts = {
            position: b.querySelector('#pn-pos').value,
            size: Number(b.querySelector('#pn-size').value) || 10,
            color: b.querySelector('#pn-color').value,
            format: b.querySelector('#pn-en').checked ? 'en' : 'zh'
          };
          close();
          await OPS.addPageNumbers(opts);
          toast(t('页码已添加'), 'ok');
        }
      }
    ]
  });
}

async function openFormDialog() {
  if (!state.pdfDoc) return toast('没有打开的文档');
  let fields = [];
  try { fields = await OPS.listFormFields(); } catch (e) { fields = []; }
  if (!fields.length) return alertDialog(t('填写表单'), t('当前文档没有可填写的表单字段（AcroForm）。'));
  const body = document.createElement('div');
  body.innerHTML = '<div class="hint" style="margin-bottom:12px">' + t('填写后点击「写入表单」，字段将保存到文档中。') + '</div>'
    + fields.map((f) => {
      if (f.kind === 'checkbox') {
        return `<label class="field-check"><input type="checkbox" data-field="${encodeURIComponent(f.name)}" data-kind="${f.kind}" ${f.value ? 'checked' : ''} /> ${escapeHtml(f.name)}</label>`;
      }
      return `<div class="field"><label>${escapeHtml(f.name)} <span class="hint">(${f.type})</span></label>
        <input type="text" data-field="${encodeURIComponent(f.name)}" data-kind="${f.kind}" value="${escapeAttr(String(f.value || ''))}" /></div>`;
    }).join('');
  openModal({
    title: t('填写表单'), body, width: 560,
    footer: [
      { label: t('取消'), kind: 'btn-ghost', onClick: ({ close }) => close() },
      {
        label: t('写入表单'), kind: 'btn-primary', onClick: async ({ close, body: b }) => {
          const values = [...b.querySelectorAll('[data-field]')].map((el) => ({
            name: decodeURIComponent(el.dataset.field),
            kind: el.dataset.kind,
            value: el.type === 'checkbox' ? el.checked : el.value
          }));
          close();
          await OPS.fillFormValues(values);
          toast(t('表单已写入'), 'ok');
        }
      }
    ]
  });
}

/* ================= 关于 / 帮助 ================= */
function openAbout() {
  openModal({
    title: t('关于 PDFmini'),
    body: `
      <div style="text-align:center;padding:6px 0 14px">
        <div style="font-size:30px;font-weight:800;color:var(--red);letter-spacing:-1px">PDFmini</div>
        <div class="hint" style="margin-top:6px">${t('轻量 · 极速 · 极简 PDF 阅读与编辑工具')}</div>
      </div>
      <div class="hint" style="line-height:2">
        ${t('版本')}：v${(document.getElementById('st-info') || {}).dataset?.version || '1.3.1'}<br/>
        ${t('渲染内核：pdf.js　编辑内核：pdf-lib')}<br/>
        ${t('本软件为独立实现，无 OCR、格式转换、数字签名等重型模块，启动快、体积小、无后台网络请求。')}
      </div>`,
    footer: [
      { label: t('使用说明'), kind: 'btn-ghost', onClick: ({ close }) => { close(); openHelp(); } },
      { label: t('关闭'), kind: 'btn-primary', onClick: ({ close }) => close() }
    ]
  });
}

function openHelp() {
  openModal({
    title: t('使用说明（快捷键）'), width: 600,
    body: `<div class="hint" style="line-height:2.1;font-size:12.5px">
      <b>${t('文件')}</b>　Ctrl+O ${t('打开')}　Ctrl+S ${t('保存')}　Ctrl+Shift+S ${t('另存为…')}　Ctrl+W ${t('关闭当前文档')}　Ctrl+Tab ${t('切换文档')}<br/>
      <b>${t('视图')}</b>　Ctrl+= ${t('放大')}　Ctrl+- ${t('缩小')}　Ctrl+0 ${t('实际大小')}　F11 ${t('全屏')}<br/>
      <b>${t('查找')}</b>　Ctrl+F　Enter ${t('下一个')}　Shift+Enter ${t('上一个')}<br/>
      <b>${t('模式')}</b>　${t('默认「浏览模式」只读；点击顶部「编辑」进入编辑模式')}<br/>
      <b>${t('编辑文字')}</b>　${t('点页面里的文字即可就地修改；点空白处自动保存')}<br/>
      <b>${t('添加图片')}</b>　${t('按钮选择文件、Ctrl+V 粘贴、直接把图片拖到页面上')}<br/>
      <b>${t('调整')}</b>　${t('选中对象后四角可缩放、拖动可移动；改动后点右下角「完成」或点空白处结束（可反复调整）；Delete 删除；Ctrl+Z 撤销')}<br/>
      <b>${t('链接')}</b>　${t('在页面上拖拽划出区域，或在菜单里快速添加；浏览模式下点击链接即可打开')}<br/>
      <b>${t('保存')}</b>　${t('所有编辑在「保存 / 页面操作」时写入 PDF')}
    </div>`,
    footer: [{ label: t('知道了'), kind: 'btn-primary', onClick: ({ close }) => close() }]
  });
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function escapeAttr(s) { return escapeHtml(s).replace(/'/g, '&#39;'); }

/* ================= 快捷键 ================= */
function initShortcuts() {
  window.addEventListener('keydown', (e) => {
    const editing = e.target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
    const ctrl = e.ctrlKey || e.metaKey;

    if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); IO.pickAndOpen(); return; }
    if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); e.shiftKey ? IO.saveDocAs() : IO.saveDoc(); return; }
    if (ctrl && e.key.toLowerCase() === 'w') { e.preventDefault(); IO.closeActiveDoc(); return; }
    if (ctrl && e.key === 'Tab') {
      e.preventDefault();
      const list = Tabs.tabs;
      if (list.length > 1) {
        const i = list.findIndex((t) => t.id === Tabs.getActiveId());
        Tabs.activateTab(list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length].id);
      }
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'f') {
      e.preventDefault(); SB.toggleSidebar(true); SB.switchTab('search');
      setTimeout(() => document.getElementById('search-input').focus(), 30);
      return;
    }
    if (editing) return;
    if (ctrl && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomIn(); return; }
    if (ctrl && e.key === '-') { e.preventDefault(); zoomOut(); return; }
    if (ctrl && e.key === '0') { e.preventDefault(); setZoom(1); return; }
    if (ctrl && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (ctrl && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (e.key === 'Escape') { setTool(null); return; }
    if (!e.ctrlKey && (e.key === 'PageDown' || e.key === 'ArrowRight')) goToPage(state.currentPage + 1, { smooth: true });
    if (!e.ctrlKey && (e.key === 'PageUp' || e.key === 'ArrowLeft')) goToPage(state.currentPage - 1, { smooth: true });
  });

  document.getElementById('viewport').addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    if (e.deltaY < 0) zoomIn(); else zoomOut();
  }, { passive: false });
}



/** 切换「文字缺失修复」（有些 PDF 的字体有问题，pdf.js 画不出个别字，开启后会自动补画） */
async function toggleTextRepair() {
  state.textRepair = state.textRepair === false;
  try { await window.pdfmini.settings.set({ textRepair: state.textRepair }); } catch (e) { /* ignore */ }
  toast(t(state.textRepair ? '已开启文字缺失修复，重新渲染当前页…' : '已关闭文字缺失修复'), 'ok');
  // 重新渲染已渲染过的页面
  for (const n of Array.from(state.renderedPages)) {
    state.renderedPages.delete(n);
  }
  refreshVisiblePages();
}

/** 重新渲染当前可见页（用于切换修复开关后立即生效） */
function refreshVisiblePages() {
  const wraps = document.querySelectorAll('.page-wrap');
  for (const w of wraps) {
    const r = w.getBoundingClientRect();
    if (r.bottom < -200 || r.top > window.innerHeight + 200) continue;
    const n = Number(w.dataset.page);
    if (n) renderPage(n, true);
  }
}

/* ================= 窗口 ================= */
function initWindowControls() {
  document.getElementById('win-min').onclick = () => window.pdfmini.window.minimize();
  document.getElementById('win-max').onclick = () => window.pdfmini.window.toggleMaximize();
  document.getElementById('win-close').onclick = () => window.pdfmini.window.close();
  window.pdfmini.window.onState(({ maximized }) => {
    const b = document.getElementById('win-max');
    b.title = t(maximized ? '还原' : '最大化');
  });
  // 关闭窗口时若有未保存文档，先确认
  window.pdfmini.window.onCloseRequest(async () => {
    if (Tabs.hasDirty()) {
      const ok = await confirmDialog(t('退出 PDFmini'), t('有文档尚未保存，确定退出吗？'), t('仍要退出'));
      if (!ok) return;
    }
    window.pdfmini.window.forceClose();
  });
}

function initResizer() {
  const rz = document.getElementById('sb-resizer');
  const sb = document.getElementById('sidebar');
  let dragging = false;
  rz.addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); document.body.style.cursor = 'col-resize'; });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = Math.max(160, Math.min(480, e.clientX - sb.getBoundingClientRect().left));
    sb.style.width = w + 'px';
  });
  window.addEventListener('mouseup', () => { if (dragging) { dragging = false; document.body.style.cursor = ''; } });
}

/* ================= 启动 ================= */
/** 把静态文案（HTML 里写死的部分）按当前语言刷一遍 */
function applyStaticText() {
  const set = (id, txt, attr) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (attr) el.setAttribute(attr, txt); else el.textContent = txt;
  };
  set('win-min', t('最小化'), 'title');
  set('win-max', t('最大化'), 'title');
  set('win-close', t('关闭'), 'title');
  set('tb-dirty', t('未保存'), 'title');
  set('viewer-loading-text', t('正在打开文档…'));
  const sbTabs = { thumbnails: '缩略图', bookmarks: '书签', search: '搜索' };
  document.querySelectorAll('.sb-tab').forEach((b) => {
    const key = sbTabs[b.dataset.tab];
    if (key) { b.textContent = t(key); b.title = t(key); }
  });
  set('search-input', t('输入关键字后回车'), 'placeholder');
  set('search-prev', t('上一个'), 'title');
  set('search-next', t('下一个'), 'title');
  set('welcome-sub', t('轻量 · 极速 · 极简 PDF 阅读与编辑'));
  set('welcome-open', t('打开 PDF 文件'));
  set('welcome-import', t('导入图片 / Word'));
  set('welcome-tip', t('支持拖拽 PDF 文件到窗口直接打开'));
  set('welcome-about', t('关于 PDFmini'));
  set('welcome-help', t('使用说明'));
  const hint = document.getElementById('drop-hint');
  if (hint) hint.textContent = t('松开以打开 PDF');
  const dt = document.getElementById('doc-tabs');
  if (dt) dt.dataset.empty = t('没有打开的文档');
}

/** 应用语言：持久化 + 重绘所有界面文案 */
export function applyLocale(loc, persist = true) {
  setLocale(loc);
  if (persist) { try { window.pdfmini.settings.set({ lang: loc }); } catch (e) { /* ignore */ } }
  applyStaticText();
  renderModeRow();
  renderMainToolbar();
  buildRightBar();
  onModeChanged(state.mode);
  const info = document.getElementById('st-info');
  if (info && info.dataset.version) info.textContent = `PDFmini v${info.dataset.version}`;
  SB.refreshSidebar();
  Tabs.renderTabStrip();
  IO.syncEmptyState();
  IO.renderRecent();
}

async function boot() {
  // 语言：优先用户设置，其次安装时写入的语言，最后跟随系统
  let settings = {};
  try { settings = await window.pdfmini.settings.get(); } catch (e) { settings = {}; }
  if (settings.textRepair === false) state.textRepair = false;
  const initialLang = settings.lang
    || (() => { const l = String(navigator.language || '').toLowerCase(); return l.startsWith('zh') ? 'zh-CN' : 'en-US'; })();
  setLocale(initialLang);

  initWindowControls();
  applyStaticText();
  buildRightBar();
  const note = document.createElement('span');
  note.className = 'mr-note';
  note.id = 'mode-note';
  const mrow = document.getElementById('moderow-right');
  if (mrow) mrow.appendChild(note);

  document.querySelectorAll('.mode-btn').forEach((b) => {
    b.onclick = () => switchMode(b.dataset.mode);
  });
  renderModeRow();
  renderMainToolbar();
  onModeChanged(state.mode);

  initViewer({
    onPageChange: (n, total) => {
      const el = document.getElementById('st-page');
      if (el) el.textContent = n + ' / ' + total;
      SB.markActiveThumb(n);
    },
    onDocumentLoad: () => {
      SB.refreshSidebar();
      const el = document.getElementById('st-page');
      if (el) el.textContent = state.currentPage + ' / ' + state.numPages;
      IO.syncEmptyState();
      IO.syncTitle();
      Tabs.renderTabStrip();
    }
  });
  setOverlayDrawer(drawOverlay);
  initAnnotate();
  onModeChange(onModeChanged);
  SB.initSidebar();
  initResizer();
  initShortcuts();
  IO.initDropZone();
  Tabs.setEmptyHandler(async () => { await IO.onAllClosed(); switchMode('view'); });

  document.getElementById('welcome-open').onclick = () => IO.pickAndOpen();
  document.getElementById('welcome-import').onclick = () => IO.pickImport();
  document.getElementById('welcome-about').onclick = () => openAbout();
  document.getElementById('welcome-help').onclick = () => openHelp();

  IO.syncEmptyState();
  IO.renderRecent();

  window.pdfmini.onOpenPath(async (p) => {
    if (/\.docx$/i.test(p)) { await IO.importPaths([p]); return; }
    await IO.openPath(p);
  });

  // 状态栏版本号取自 package.json，避免硬编码失配
  const info = await window.pdfmini.app.info();
  const st = document.getElementById('st-info');
  st.dataset.version = info.version;
  st.textContent = `PDFmini v${info.version}`;

  // 语言切换后重绘一次（例如安装器写入的语言与系统语言不一致时）
  onLocale(() => { /* applyLocale 内部已重绘，这里只保留扩展点 */ });
}

/* ================= 自检（开发验证用） ================= */
/** 自检辅助：在页面里扫出一个“确实点在了文字上”的画面坐标 */
function scanTextPoint(wrap, opts = {}) {
  if (!wrap) return null;
  const startDy = opts.startDy == null ? 40 : opts.startDy;
  const endDy = opts.endDy == null ? 100000 : opts.endDy;
  const exclude = opts.exclude || [];
  const wr = wrap.getBoundingClientRect();
  const vpEl = document.getElementById('viewport').getBoundingClientRect();
  for (let dy = startDy; dy < Math.min(endDy, wr.height); dy += 12) {
    for (let dx = 90; dx < wr.width - 90; dx += 24) {
      const x = Math.round(wr.left + dx), y = Math.round(wr.top + dy);
      if (y < vpEl.top + 20 || y > vpEl.bottom - 20) continue;
      if (x < vpEl.left + 20 || x > vpEl.right - 20) continue;
      const hit = hitLineAt(1, x, y, wrap);
      if (hit && hit.text && !exclude.includes(hit.text)) return { x, y, hit };
    }
  }
  return null;
}

/** 自检辅助：等页面文字层与覆盖层都就绪（首次渲染完成后再操作，避免渲染重建把编辑框冲掉） */
async function waitForTextLayer(wrap, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const layer = wrap && wrap.querySelector('.textLayer');
    const ov = wrap && wrap.querySelector('.page-overlay');
    // overlay.dataset.page 由 drawOverlay 在最后设置，说明本轮渲染 + 覆盖层重建已结束
    if (layer && layer.querySelectorAll('span').length > 0 && ov && ov.dataset.page) {
      await new Promise((r) => setTimeout(r, 250));
      return true;
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  return false;
}

/** 自检辅助：在页面里扫出一个空白点（无文字、无批注） */
function scanBlankPoint(wrap) {
  if (!wrap) return null;
  const wr = wrap.getBoundingClientRect();
  const vpEl = document.getElementById('viewport').getBoundingClientRect();
  for (let dy = 16; dy < wr.height - 16; dy += 16) {
    for (let dx = 16; dx < wr.width - 16; dx += 16) {
      const x = Math.round(wr.left + dx), y = Math.round(wr.top + dy);
      if (y < vpEl.top + 30 || y > vpEl.bottom - 30) continue;
      if (x < vpEl.left + 20 || x > vpEl.right - 20) continue;
      const el = document.elementFromPoint(x, y);
      if (el && el.closest && el.closest('.anno')) continue;
      if (el && el.closest && el.closest('.txt-bar')) continue;
      if (hitLineAt(1, x, y, wrap)) continue;
      return { x, y };
    }
  }
  return null;
}

/** 仅自检使用：造一份空白 PDF 作为新标签打开（正式版本已不提供「新建空白 PDF」） */
async function devBlankDoc(pages = 1, w = 595.28, h = 841.89) {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([w, h]);
  const bytes = await doc.save();
  await Tabs.openDocument({ bytes, fileName: t('未命名.pdf'), dirty: true });
  goToPage(1);
  return bytes;
}
/* ================= 自检总入口 =================
 * 以前每个用例一个命令行开关、跑完就退出 → N 个用例要启动 N 次 Electron。
 * 这里提供「一次启动跑完所有用例」的入口，参数形如
 *   smart:fixtures/text.pdf,marquee:fixtures/image.pdf,test
 * 名称与用例的对应见 SMOKE_SUITES；返回每个用例的通过情况与失败项。
 */
const SMOKE_SUITES = {
  test: () => window.__smokeTest(),
  open: (a) => window.__smokeOpen(a),
  form: (a) => window.__smokeForm(a),
  drop: (a) => window.__smokeDrop(a),
  link: (a) => window.__smokeLink(a),
  native: (a) => window.__smokeNative(a),
  insert: (a) => window.__smokeInsert(a),
  docx: (a) => window.__smokeDocx(a),
  imgdel: (a) => window.__smokeImgDel(a),
  erase: (a) => window.__smokeErase(a),
  smart: (a) => window.__smokeSmart(a),
  marquee: (a) => window.__smokeMarquee(a),
  vector: (a) => window.__smokeVectorErase(a),
  viewcopy: (a) => window.__smokeViewCopy(a),
  nowrap: (a) => window.__smokeNoWrap(a),
  sel: (a) => window.__smokeSel(a)
};

window.__runSuites = async function (spec) {
  const out = [];
  for (const item of String(spec).split(',')) {
    const s = item.trim();
    if (!s) continue;
    const cut = s.indexOf(':');
    const name = cut < 0 ? s : s.slice(0, cut);
    const arg = cut < 0 ? '' : s.slice(cut + 1);
    const fn = SMOKE_SUITES[name];
    if (!fn) { out.push({ name, ok: false, error: 'unknown suite' }); continue; }
    // 每个用例前清空选区：用例之间共用同一个渲染进程，不能互相带状态
    try { window.getSelection().removeAllRanges(); } catch (e) { /* 忽略 */ }
    const t0 = performance.now();
    let r = null;
    try { r = await fn(arg || undefined); } catch (e) { r = { ok: false, error: String((e && e.stack) || e) }; }
    out.push({
      name: s,
      ok: !!(r && r.ok),
      ms: Math.round(performance.now() - t0),
      bad: ((r && r.steps) || []).filter((x) => !x[1]).map((x) => [x[0], x[2]]),
      error: (r && r.error) || ''
    });
  }
  return { ok: out.every((x) => x.ok), total: out.length, passed: out.filter((x) => x.ok).length, suites: out };
};

window.__smokeTest = async function () {
  const log = [];
  const t0 = performance.now();
  let tPrev = t0;
  const step = (name, ok, extra) => {
    const now = performance.now();
    log.push([name, !!ok, (extra === undefined ? '' : extra) + ` +${Math.round(now - tPrev)}ms`]);
    tPrev = now;
  };
  try {
    // 首页态：不显示模式行/功能栏，且已没有「新建空白 PDF」入口
    step('homeMode', document.body.classList.contains('home'));
    step('homeToolbarHidden', getComputedStyle(document.getElementById('toolbar')).display === 'none');
    step('homeModerowHidden', getComputedStyle(document.getElementById('moderow')).display === 'none');
    step('noBlankDocEntry', !document.getElementById('welcome-blank'));
    step('welcomeAboutHelp', !!document.getElementById('welcome-about') && !!document.getElementById('welcome-help'));

    await devBlankDoc(2);
    step('devDocOpened', state.numPages === 2, 'pages=' + state.numPages);
    step('toolbarShownWithDoc', getComputedStyle(document.getElementById('toolbar')).display !== 'none');
    step('welcomeHidden', document.getElementById('welcome').classList.contains('hidden'));
    step('sidebarVisible', !document.getElementById('sidebar').classList.contains('collapsed'));
    step('tabCount', Tabs.tabCount() === 1);

    setMode('edit');
    step('editMode', state.mode === 'edit' && document.body.classList.contains('edit-mode'));

    snapshot();
    push(1, { id: 't1', type: 'text', x: 100, y: 700, text: 'PDFmini 中文测试 ABC 123', fontSize: 14, color: '#e4002b', w: 220 });
    push(1, { id: 't2', type: 'highlight', rects: [{ x: 80, y: 600, w: 200, h: 16 }], color: '#ffd400', opacity: 0.42 });
    push(1, { id: 't3', type: 'ink', paths: [[{ x: 80, y: 500 }, { x: 180, y: 470 }, { x: 280, y: 520 }]], color: '#e4002b', width: 2 });
    push(1, { id: 't4', type: 'shape', shape: 'rect', x: 100, y: 380, w: 180, h: 80, color: '#1565c0', width: 2 });
    push(1, { id: 't5', type: 'stamp', x: 200, y: 250, w: 130, h: 42, text: '已批准', color: '#12a150' });
    push(1, { id: 't6', type: 'text', bg: true, x: 90, y: 200, w: 200, text: '覆盖原文字后的新文字', fontSize: 12, color: '#14161a', cover: { x: 88, y: 196, w: 220, h: 18 } });
    step('annotations', annotationsCount() === 6, 'count=' + annotationsCount());

    // 加载指示不重复：全局遮罩存在时不应再出现阅读区转圈
    showLoading('自检');
    showViewerLoading();
    step('singleSpinner', document.getElementById('viewer-loading').classList.contains('hidden'));
    hideLoading();

    // 覆盖式文字编辑 + 图片插入 / 选中 / 拖动 / 缩放
    snapshot();
    push(1, {
      id: 'te1', type: 'text', bg: true, x: 90, y: 200, w: 200,
      text: '覆盖原文字后的新文字', fontSize: 12, color: '#14161a',
      cover: { x: 88, y: 196, w: 220, h: 18 }
    });
    step('textEditCover', !!document.querySelector('.page-wrap[data-page="1"] .anno[data-id="te1"]'), 'cover+text');

    const cv = document.createElement('canvas');
    cv.width = 60; cv.height = 40;
    const cx = cv.getContext('2d');
    cx.fillStyle = '#e4002b'; cx.fillRect(0, 0, 60, 40);
    const pngURL = cv.toDataURL('image/png');
    insertImageAnnotation(1, { x: 300, y: 400 }, pngURL, 'image/png', 'image');
    await new Promise((r) => setTimeout(r, 150));
    const imgAnno = (state.annotations[1] || []).find((a) => a.type === 'image');
    step('insertImage', !!imgAnno, imgAnno ? `${Math.round(imgAnno.w)}x${Math.round(imgAnno.h)}` : 'none');


    // 点击选中 -> 出现 4 个缩放手柄
    const wrap1 = document.querySelector('.page-wrap[data-page="1"]');
    const q = (id) => wrap1.querySelector(`.anno[data-id="${id}"]`);
    const pd = (el, x, y) => el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y }));
    const pm = (x, y) => window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y }));
    const pu = () => window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));

    if (imgAnno) {
      const el = q(imgAnno.id);
      const r = el.getBoundingClientRect();
      pd(el, r.left + r.width / 2, r.top + r.height / 2);
      pu();
    }
    step('imageHandles', wrap1.querySelectorAll('.anno-h').length === 4, 'handles=' + wrap1.querySelectorAll('.anno-h').length);

    // 拖动移动：同时验证拖动过程中不重建 DOM（否则 <img> 每帧重新解码会卡顿）
    if (imgAnno) {
      const el = q(imgAnno.id);
      const imgNode = el.querySelector('img');
      const r = el.getBoundingClientRect();
      const before = imgAnno.x;
      pd(el, r.left + 5, r.top + 5);
      pm(r.left + 20, r.top + 15);
      const sameMidDrag = q(imgAnno.id) === el && el.querySelector('img') === imgNode;
      pm(r.left + 45, r.top + 25);
      const sameStill = q(imgAnno.id) === el && el.querySelector('img') === imgNode;
      pu();
      step('noRebuildDuringDrag', sameMidDrag && sameStill);
      step('imageMove', Math.abs(imgAnno.x - before) > 1, `x ${before}->${imgAnno.x}, zoom=${state.zoom}`);
    }

    // 四角缩放：垂直方向主导，验证方向与锚点
    if (imgAnno) {
      const handle = wrap1.querySelector(`.anno[data-id="${imgAnno.id}"] .anno-h.se`);
      if (handle) {
        const hr = handle.getBoundingClientRect();
        const b4 = { x: imgAnno.x, y: imgAnno.y, w: imgAnno.w, h: imgAnno.h };
        const topBefore = b4.y + b4.h;
        pd(handle, hr.left + 2, hr.top + 2);
        pm(hr.left + 12, hr.top + 62);
        pu();
        step('resizeGrow', imgAnno.w > b4.w + 0.5 && imgAnno.h > b4.h + 0.5,
          `w ${Math.round(b4.w)}->${Math.round(imgAnno.w)}, h ${Math.round(b4.h)}->${Math.round(imgAnno.h)}`);
        step('resizeAnchor', Math.abs(imgAnno.x - b4.x) < 0.01 && Math.abs((imgAnno.y + imgAnno.h) - topBefore) < 0.01,
          `left ${imgAnno.x.toFixed(1)}, top ${(imgAnno.y + imgAnno.h).toFixed(1)}`);
      } else step('resizeGrow', false, 'no handle');
    }

    const canvas = await renderPageToCanvas(1, 1);
    step('renderCanvas', canvas.width > 100, `${canvas.width}x${canvas.height}`);

    const baked = await OPS.bakeBytes(true);
    step('bakeAnnotations', baked && baked.length > 500, 'bytes=' + (baked ? baked.length : 0));

    await OPS.reorderPages([2, 1]);
    step('reorderPages', state.numPages === 2);
    await OPS.rotatePages([1], 90);
    step('rotatePage', state.numPages === 2);
    await OPS.deletePages([2]);
    step('deletePage', state.numPages === 1);
    await OPS.addWatermark({ text: 'PDFmini 水印', size: 40, opacity: 0.2, color: '#e4002b', diagonal: false });
    step('watermark', state.numPages === 1);
    await OPS.addPageNumbers({ position: 'bottom-center', size: 10, color: '#333333', format: 'en' });
    step('pageNumbers', true);

    const finalBytes = await OPS.bakeBytes(true);
    step('finalBake', finalBytes.length > 500, 'bytes=' + finalBytes.length);
    step('tabsAlive', Tabs.tabCount() === 1);
    return { ok: log.every((l) => l[1]), ms: Math.round(performance.now() - t0), steps: log, finalSize: finalBytes.length };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e), steps: log };
  }
};

window.__smokeOpen = async function (p) {
  const log = [];
  const t0 = performance.now();
  try {
    const t1 = performance.now();
    await IO.openPath(p);
    log.push(['open', true, `${state.numPages} pages, ${Math.round(performance.now() - t1)}ms`]);

    const t2 = performance.now();
    log.push(['firstPaint', state.renderedPages.has(state.currentPage), Math.round(performance.now() - t2) + 'ms']);
    log.push(['welcomeHidden', document.getElementById('welcome').classList.contains('hidden')]);

    const t3 = performance.now();
    const c1 = await renderPageToCanvas(1, 1);
    log.push(['render1', c1.width > 0, Math.round(performance.now() - t3) + 'ms']);

    const txt = await extractText();
    log.push(['extractText', txt.length > 0, 'len=' + txt.length]);

    const ts = performance.now();
    const q = txt.replace(/\s+/g, '').slice(20, 22) || 'a';
    await SB.runSearch(q);
    log.push(['search:' + q, state.searchHits.length > 0, `hits=${state.searchHits.length}, ${Math.round(performance.now() - ts)}ms`]);

    // 多标签切换
    const before = Tabs.tabCount();
    await devBlankDoc(1);
    await Tabs.activateTab(Tabs.tabs[0].id);
    log.push(['tabs', Tabs.tabCount() === before + 1 && state.numPages > 0, 'count=' + Tabs.tabCount()]);

    const tb = performance.now();
    const bytes = await OPS.bakeBytes(true);
    log.push(['bake', bytes.length > 500, `${bytes.length} bytes, ${Math.round(performance.now() - tb)}ms`]);

    return { ok: log.every((l) => l[1]), ms: Math.round(performance.now() - t0), pages: state.numPages, steps: log };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e), steps: log };
  }
};

window.__smokeForm = async function (p) {
  const log = [];
  const t0 = performance.now();
  try {
    await IO.openPath(p);
    log.push(['open', state.numPages > 0, state.numPages + ' pages']);
    const fields = await OPS.listFormFields();
    log.push(['listFormFields', fields.length > 0, fields.map((f) => f.name + ':' + f.kind).join(', ')]);
    const values = fields.map((f) => ({
      name: f.name, kind: f.kind,
      value: f.kind === 'checkbox' ? true : (f.kind === 'dropdown' ? 'Shanghai' : 'PDFmini-' + f.name)
    }));
    await OPS.fillFormValues(values);
    const after = await OPS.listFormFields();
    log.push(['fillFormValues', after.some((f) => f.value), JSON.stringify(after.map((f) => [f.name, f.value]))]);
    const bytes = await OPS.bakeBytes(true);
    log.push(['save', bytes.length > 500, bytes.length + ' bytes']);
    return { ok: log.every((l) => l[1]), ms: Math.round(performance.now() - t0), steps: log };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e), steps: log };
  }
};

/* 拖拽/粘贴插入图片后的可编辑性自检 */
window.__smokeDrop = async function (pdfPath) {
  const log = [];
  const step = (n, ok, extra) => log.push([n, !!ok, extra === undefined ? '' : extra]);
  try {
    await IO.openPath(pdfPath);
    step('open', state.numPages > 0, state.numPages + ' pages');

    const cv = document.createElement('canvas');
    cv.width = 120; cv.height = 80;
    const cx = cv.getContext('2d');
    cx.fillStyle = '#e4002b'; cx.fillRect(0, 0, 120, 80);
    const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
    const file = new File([blob], 'drop-test.png', { type: 'image/png' });

    const wrap = document.querySelector('.page-wrap[data-page="1"]');
    const r = wrap.getBoundingClientRect();
    const px = r.left + r.width * 0.4;
    const py = r.top + r.height * 0.12;

    const dt = new DataTransfer();
    dt.items.add(file);
    window.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: px, clientY: py }));
    await new Promise((res) => setTimeout(res, 500));

    const imgs = (state.annotations[1] || []).filter((a) => a.type === 'image');
    step('dropInserted', imgs.length === 1, 'images=' + imgs.length);
    step('modeEdit', state.mode === 'edit' && document.body.classList.contains('edit-mode'), 'mode=' + state.mode);
    step('toolCleared', state.tool === null, 'tool=' + state.tool);
    step('toolbarModeSync', document.querySelector('.mode-btn.active').dataset.mode === 'edit', 'btn=' + document.querySelector('.mode-btn.active').dataset.mode);

    if (imgs.length) {
      const id = imgs[0].id;
      const el = wrap.querySelector(`.anno[data-id="${id}"]`);
      step('annoElFound', !!el);
      if (el) {
        const er = el.getBoundingClientRect();
        step('annoRectOk', er.width > 5 && er.height > 5, `${Math.round(er.left)},${Math.round(er.top)} ${Math.round(er.width)}x${Math.round(er.height)}`);

        // 用真实命中测试（elementFromPoint）取最上层元素，模拟真实鼠标点击
        const cx = Math.round(er.left + er.width / 2);
        const cy = Math.round(er.top + er.height / 2);
        const topEl = document.elementFromPoint(cx, cy);
        step('hitTestHitsAnno', !!(topEl && topEl.closest && topEl.closest('.anno')), 'top=' + (topEl ? topEl.className || topEl.tagName : 'null'));

        topEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: cx, clientY: cy }));
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        step('handlesAfterClick', wrap.querySelectorAll('.anno-h').length === 4, 'h=' + wrap.querySelectorAll('.anno-h').length);

        // 拖动一次，检查是否跟手（同样用真实命中测试取目标元素）
        const el2 = wrap.querySelector(`.anno[data-id="${id}"]`);
        const r2 = el2.getBoundingClientRect();
        const beforeX = imgs[0].x;
        const t2 = document.elementFromPoint(Math.round(r2.left + 10), Math.round(r2.top + 10));
        t2.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r2.left + 10, clientY: r2.top + 10 }));
        for (let i = 1; i <= 5; i++) {
          window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r2.left + 10 + i * 8, clientY: r2.top + 10 + i * 4 }));
        }
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        step('dragWorks', Math.abs(imgs[0].x - beforeX) > 1, `dx=${(imgs[0].x - beforeX).toFixed(1)}`);

        // 连续多次编辑：连续做 3 次「缩放 -> 移动」，每次都不应丢失可编辑状态
        for (let round = 1; round <= 3; round++) {
          const node = wrap.querySelector(`.anno[data-id="${id}"]`);
          const handle = node && node.querySelector('.anno-h.se');
          const before = { ...imgs[0] };
          if (handle) {
            const hr = handle.getBoundingClientRect();
            handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: hr.left + 2, clientY: hr.top + 2 }));
            handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: hr.left + 2, clientY: hr.top + 2 }));
            window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: hr.left + 16, clientY: hr.top + 12 }));
            window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
            window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: hr.left + 16, clientY: hr.top + 12 }));
          }
          const h1 = wrap.querySelectorAll('.anno-h').length;
          const node2 = wrap.querySelector(`.anno[data-id="${id}"]`);
          const nr = node2.getBoundingClientRect();
          const bx = imgs[0].x;
          node2.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: nr.left + 6, clientY: nr.top + 6 }));
          window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: nr.left + 20, clientY: nr.top + 14 }));
          window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
          const h2 = wrap.querySelectorAll('.anno-h').length;
          step(`round${round}`, imgs[0].w > before.w && Math.abs(imgs[0].x - bx) > 1 && h1 === 4 && h2 === 4,
            `w ${Math.round(before.w)}->${Math.round(imgs[0].w)}, h1=${h1}, h2=${h2}`);
        }

        // 完成按钮
        const doneBtn = wrap.querySelector('.anno-done');
        step('doneButton', !!doneBtn, doneBtn ? doneBtn.textContent : 'missing');
      }
    }
    return { ok: log.every((l) => l[1]), steps: log };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e), steps: log };
  }
};

/* 链接功能自检 */
window.__smokeLink = async function (pdfPath) {
  const log = [];
  const step = (n, ok, extra) => log.push([n, !!ok, extra === undefined ? '' : extra]);
  try {
    await IO.openPath(pdfPath);
    step('open', state.numPages > 0, state.numPages + ' pages');
    if (state.mode !== 'edit') switchMode('edit');
    await new Promise((r) => setTimeout(r, 250));

    addLinkQuick('url');
    await new Promise((r) => setTimeout(r, 200));
    const urlInput = document.getElementById('lk-url');
    step('dialogOpen', !!urlInput);
    if (urlInput) {
      urlInput.value = 'https://www.example.com/pdfmini';
      const btn = Array.from(document.querySelectorAll('.modal-foot button'))
        .find((b) => b.textContent === t('创建链接'));
      step('createBtnFound', !!btn);
      if (btn) btn.click();
      await new Promise((r) => setTimeout(r, 250));
    }

    const links = (state.annotations[1] || []).filter((a) => a.type === 'link');
    step('linkCreated', links.length === 1, 'links=' + links.length);
    if (links.length) {
      step('linkUrl', links[0].url === 'https://www.example.com/pdfmini', links[0].url);
      step('linkOverlay', !!document.querySelector('.anno-link'));
      step('linkSelected', !!document.querySelector('.anno-link .anno-done') && !!document.querySelector('.anno-link .anno-act'));
    }

    // 编辑模式下（不启用任何工具）点中链接应选中并出现「完成」
    setTool(null, true);
    const linkEl = document.querySelector('.anno-link');
    if (linkEl) {
      const lr = linkEl.getBoundingClientRect();
      linkEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: lr.left + lr.width / 2, clientY: lr.top + lr.height / 2 }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    }
    step('objectSelect', !!document.querySelector('.anno-done') && !!document.querySelector('.anno-act'));
    const doneBtn = document.querySelector('.anno-done');
    if (doneBtn) doneBtn.click();
    step('doneClears', !document.querySelector('.anno-done'));
    setTool(null);

    // 页内跳转链接
    addLinkQuick('page');
    await new Promise((r) => setTimeout(r, 200));
    const pgInput = document.getElementById('lk-page');
    if (pgInput) pgInput.value = '2';
    const btn2 = Array.from(document.querySelectorAll('.modal-foot button')).find((b) => b.textContent === t('创建链接'));
    if (btn2) btn2.click();
    await new Promise((r) => setTimeout(r, 250));
    const gotoLinks = (state.annotations[1] || []).filter((a) => a.type === 'link' && a.targetPage === 2);
    step('gotoLinkCreated', gotoLinks.length === 1, 'goto=' + gotoLinks.length);

    const bytes = await OPS.bakeBytes(true);
    const { PDFDocument, PDFName } = await import('pdf-lib');
    const chk = await PDFDocument.load(bytes);
    const arr = chk.getPage(0).node.Annots();
    let subtype = '', uri = '', kinds = [];
    if (arr && arr.size()) {
      for (let i = 0; i < arr.size(); i++) {
        const dict = chk.context.lookup(arr.get(i));
        const st = dict.get(PDFName.of('Subtype'));
        if (st) subtype = st.toString();
        const act = dict.get(PDFName.of('A'));
        if (act) {
          const ad = chk.context.lookup(act);
          kinds.push(ad.get(PDFName.of('S')).toString());
          const u = ad.get(PDFName.of('URI'));
          if (u) uri = u.toString().replace(/^\(|\)$/g, '');
        }
      }
    }
    step('pdfHasLinkAnnot', subtype === '/Link' && uri.indexOf('example.com') >= 0, subtype + ' ' + uri);
    step('pdfHasGoto', kinds.indexOf('/GoTo') >= 0, kinds.join(','));
    return { ok: log.every((l) => l[1]), steps: log };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e), steps: log };
  }
};

/* 临时探针：查看文字层与原生图片结构 */
window.__probe = async function (pdfPath) {
  const out = {};
  await IO.openPath(pdfPath);
  if (state.mode !== 'edit') switchMode('edit');
  await new Promise((r) => setTimeout(r, 600));
  const wrap = document.querySelector('.page-wrap[data-page="1"]');
  const layer = wrap && wrap.querySelector('.textLayer');
  out.hasLayer = !!layer;
  if (layer) {
    const spans = Array.from(layer.querySelectorAll('span'));
    out.spanCount = spans.length;
    const wr0 = wrap.getBoundingClientRect();
    out.wrapBox = [Math.round(wr0.left), Math.round(wr0.top)];
    out.spans = spans.slice(0, 60).map((s) => {
      const b = s.getBoundingClientRect();
      const r = wrap.getBoundingClientRect();
      return {
        t: (s.textContent || '').slice(0, 22),
        x: Math.round(b.left - r.left), y: Math.round(b.top - r.top),
        w: Math.round(b.width), h: Math.round(b.height),
        fs: getComputedStyle(s).fontSize
      };
    });
  }
  // 原生图片检测 + 文本内容映射校验
  try {
    const { pdfjsLib } = await import('./viewer.js');
    const OPS = pdfjsLib.OPS;
    const Util = pdfjsLib.Util;
    const page = await state.pdfDoc.getPage(1);
    const ops = await page.getOperatorList();
    const counts = {};
    for (const fn of ops.fnArray) counts[fn] = (counts[fn] || 0) + 1;
    out.opCounts = Object.keys(counts).length;
    const paintIds = ['save', 'restore', 'transform', 'paintImageXObject', 'paintInlineImageXObject', 'paintImageMaskXObject', 'paintImageMaskXObjectGroup', 'paintJpegXObject', 'paintImageXObjectRepeat'];
    out.paintOps = paintIds.map((k) => k + '=' + (OPS[k] === undefined ? '?' : (counts[OPS[k]] || 0))).join(', ');

    const vp = page.getViewport({ scale: state.zoom });
    const tc = await page.getTextContent();

    out.items = tc.items.slice(0, 6).map((it) => {
      const tx = Util.transform(vp.transform, it.transform);
      const x1 = tx[4], y1 = tx[5];
      const x2 = tx[4] + it.width * vp.scale, y2 = tx[5] + it.height * vp.scale;
      const p1 = vp.convertToViewportPoint(x1, y1);
      const p2 = vp.convertToViewportPoint(x2, y2);
      return {
        str: it.str,
        transform: it.transform.map((v) => Math.round(v * 1000) / 1000),
        w: Math.round(it.width * 10) / 10, h: Math.round(it.height * 10) / 10,
        fs: Math.round(Math.hypot(tx[0], tx[1]) * 100) / 100,
        boxFromTx: [Math.round(Math.min(p1[0], p2[0])), Math.round(Math.min(p1[1], p2[1])), Math.round(Math.abs(p2[0] - p1[0])), Math.round(Math.abs(p2[1] - p1[1]))]
      };
    });
  } catch (e) { out.imgErr = String(e); }
  return out;
};

/* 编辑文字（全文本块）/ 编辑图片 自检 */
window.__smokeNative = async function (pdfPath) {
  const log = [];
  const step = (n, ok, extra) => log.push([n, !!ok, extra === undefined ? '' : extra]);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 2000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; await wait(60); }
    return fn();
  };
  try {
    await IO.openPath(pdfPath);
    if (state.mode !== 'edit') switchMode('edit');
    await wait(700);
    const wrap = document.querySelector('.page-wrap[data-page="1"]');
    const wr = wrap.getBoundingClientRect();
    step('open', state.numPages > 0 && !!wrap, state.numPages + ' pages');

    /* ---------- 1. 点文字即编辑（无工具，需求 3） ---------- */
    setTool(null);
    await waitForTextLayer(wrap);
    await wait(200);
    const p1 = scanTextPoint(wrap);
    step('textPoint1', !!p1, p1 ? `${p1.x},${p1.y} ${JSON.stringify(p1.hit.text.slice(0, 14))}` : 'none');
    if (p1) {
      const t1 = document.elementFromPoint(p1.x, p1.y);
      t1.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: p1.x, clientY: p1.y }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      await wait(300);
      const t1box = wrap.querySelector('.anno-text[contenteditable="true"]');
      step('block1Editing', !!t1box && t1box.isContentEditable === true, 'active=' + (document.activeElement === t1box));
      step('barShown', !!wrap.querySelector('.txt-bar'), 'fonts=' + wrap.querySelectorAll('.txt-bar .txt-f').length + ' colors=' + wrap.querySelectorAll('.txt-bar .txt-c').length);
      const a1 = (state.annotations[1] || [])[0];
      step('block1Text', !!a1 && a1.text === p1.hit.text, a1 ? JSON.stringify(a1.text.slice(0, 16)) : 'none');
      step('block1Cover', !!a1 && !!a1.cover && a1.cover.w > 4 && a1.cover.h > 4, a1 && a1.cover ? `${Math.round(a1.cover.w)}x${Math.round(a1.cover.h)}` : 'none');
      if (t1box) {
        t1box.innerText = '第一块已改';
        t1box.dispatchEvent(new Event('blur'));   // 确定性触发提交（真实用户为失焦/点空白）
      }
      await waitFor(() => (state.annotations[1] || []).some((x) => x.text === '第一块已改'), 2500);
      const a1b = (state.annotations[1] || []).find((x) => x.id === (a1 && a1.id));
      step('block1Edited', !!a1b && a1b.text === '第一块已改', a1b ? JSON.stringify(a1b.text) : 'gone');
    }

    // 再点另一段文字 → 必须仍然可以继续编辑（用户反馈的核心问题）
    await wait(200);
    const p2 = scanTextPoint(wrap, { exclude: p1 ? [p1.hit.text] : [] });
    step('textPoint2', !!p2, p2 ? `${p2.x},${p2.y}` : 'none');
    if (p2) {
      const t2 = document.elementFromPoint(p2.x, p2.y);
      t2.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: p2.x, clientY: p2.y }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      await wait(300);
      const t2box = wrap.querySelector('.anno-text[contenteditable="true"]');
      step('block2Editing', !!t2box && t2box.isContentEditable === true, 'active=' + (document.activeElement === t2box));
      const n2 = (state.annotations[1] || []).length;
      step('block2AnnoCount', n2 === 2, 'n=' + n2);
      if (t2box) {
        t2box.innerText = '第二块已改';
        // 点空白处 → 自动保存
        const empty = scanBlankPoint(wrap);
        step('blankPoint', !!empty, empty ? `${empty.x},${empty.y}` : 'none');
        if (empty) {
          const et = document.elementFromPoint(empty.x, empty.y);
          et.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: empty.x, clientY: empty.y }));
          window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        }
        await waitFor(() => !wrap.querySelector('.anno-text[contenteditable="true"]'), 2500);
        step('blankAutoCommit', !wrap.querySelector('.anno-text[contenteditable="true"]'));
        const a2 = (state.annotations[1] || []).find((x) => x.text === '第二块已改');
        step('block2Saved', !!a2, a2 ? 'saved' : 'missing');
        const a1c = (state.annotations[1] || []).find((x) => x.text === '第一块已改');
        step('block1Kept', !!a1c, a1c ? 'kept' : 'lost');
      }
    }
    step('dirtyAfterEdit', state.dirty === true, 'dirty=' + state.dirty);
    setTool(null);
    state.annotations = {}; state.undo = []; state.redo = [];
    setDirty(false);
    drawOverlay(1);
    await wait(200);
    step('blocksCleared', wrap.querySelectorAll('.anno-text').length === 0, 'n=' + wrap.querySelectorAll('.anno-text').length);

    /* ---------- 2. 编辑图片：选中 PDF 原生图片 ---------- */
    const V = await import('./viewer.js');
    const imgs = await V.getPageImages(1);
    step('nativeImagesFound', imgs.length > 0, 'n=' + imgs.length);
    if (imgs.length) {
      const vEl = document.getElementById('viewport');
      const vr = vEl.getBoundingClientRect();
      const vp = V.getViewport(1);
      const cands = imgs.slice().sort((a, b) => b.w * b.h - a.w * a.h).map((im) => {
        const c = vp.convertToViewportPoint(im.x + im.w / 2, im.y + im.h / 2);
        const w1 = V.pageWrap(1).getBoundingClientRect();
        return { im, px: w1.left + c[0], py: w1.top + c[1] };
      });
      let pick = cands.find((c) => c.py > vr.top + 60 && c.py < vr.bottom - 60 && c.px > vr.left + 60 && c.px < vr.right - 60);
      if (!pick) {
        vEl.scrollTop += Math.round(cands[0].py - (vr.top + vr.height / 2));
        await wait(600);
        const w2 = V.pageWrap(1).getBoundingClientRect();
        const c = vp.convertToViewportPoint(cands[0].im.x + cands[0].im.w / 2, cands[0].im.y + cands[0].im.h / 2);
        pick = { im: cands[0].im, px: w2.left + c[0], py: w2.top + c[1] };
      }
      step('imageClickPoint', !!pick, pick ? `${Math.round(pick.px)},${Math.round(pick.py)}` : 'none');

      setTool('editImage', true);
      await wait(200);
      let target = pick && document.elementFromPoint(pick.px, pick.py);
      step('imageHitTarget', !!target, target ? (target.className || target.tagName) : 'null');
      if (target) {
        target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: pick.px, clientY: pick.py }));
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        await wait(1200);
        const imgsAnno = (state.annotations[1] || []).filter((a) => a.type === 'image' && a.native);
        step('objImageSelected', imgsAnno.length === 1, 'n=' + imgsAnno.length);
        if (imgsAnno.length) {
          const a = imgsAnno[0];
          step('objImageCover', !!a.cover, a.cover ? `${Math.round(a.cover.w)}x${Math.round(a.cover.h)}` : 'none');
          step('objImagePixels', !!a.dataUrl && a.dataUrl.length > 100, a.dataUrl ? Math.round(a.dataUrl.length / 1024) + 'KB' : 'none');
          const actions = Array.from(wrap.querySelectorAll('.anno-acts .anno-act')).map((b) => b.title);
          step('objImageActions', actions.indexOf(t('替换图片')) >= 0, actions.join('|'));

          // 拖动移动：对象移动、原位置遮盖不动
          const cur = (state.annotations[1] || []).find((x) => x.id === a.id) || a;
          const node = wrap.querySelector(`.anno[data-id="${cur.id}"]`);
          const nr = node.getBoundingClientRect();
          const beforeX = cur.x, beforeCoverX = cur.cover.x;
          const hit = document.elementFromPoint(Math.round(nr.left + nr.width / 2), Math.round(nr.top + nr.height / 2));
          step('moveHitTarget', !!hit, hit ? (hit.className || hit.tagName) : 'null');
          if (hit) {
            hit.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: nr.left + nr.width / 2, clientY: nr.top + nr.height / 2 }));
            for (let i = 1; i <= 6; i++) {
              window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: nr.left + nr.width / 2 + i * 12, clientY: nr.top + nr.height / 2 - i * 6 }));
            }
            window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
          }
          await wait(250);
          const cur2 = (state.annotations[1] || []).find((x) => x.id === a.id) || cur;
          step('objImageMoved', Math.abs(cur2.x - beforeX) > 2, `x ${beforeX.toFixed(0)}->${cur2.x.toFixed(0)}`);
          step('objImageCoverFixed', Math.abs(cur2.cover.x - beforeCoverX) < 0.01, `coverX=${cur2.cover.x.toFixed(0)}`);

          /* ---------- 回归：缩放 + 完成 + 点空白 不应复制出原图 ---------- */
          const actions2 = Array.from(wrap.querySelectorAll('.anno-acts .anno-act')).map((b) => b.title);
          step('noEraseAction', actions2.indexOf(t('删除元素（白底抹除）')) < 0, actions2.join('|'));
          step('hasReplaceAction', actions2.indexOf(t('替换图片')) >= 0, actions2.join('|'));

          // 缩放到约 45%（拖 se 手柄到框内 45% 处，等比缩小）
          const cur3 = (state.annotations[1] || []).find((x) => x.id === a.id);
          const node3 = wrap.querySelector(`.anno[data-id="${cur3.id}"]`);
          const seH = node3.querySelector('.anno-h.se');
          const wBeforeShrink = cur3.w;
          if (seH) {
            const hr = seH.getBoundingClientRect();
            const nr3 = node3.getBoundingClientRect();
            seH.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: hr.left + 2, clientY: hr.top + 2 }));
            window.dispatchEvent(new PointerEvent('pointermove', {
              bubbles: true,
              clientX: nr3.left + nr3.width * 0.45,
              clientY: nr3.top + nr3.height * 0.45
            }));
            window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
            await waitFor(() => ((state.annotations[1] || []).find((x) => x.id === a.id) || {}).w < wBeforeShrink * 0.7, 2000);
          }
          const cur4 = (state.annotations[1] || []).find((x) => x.id === a.id);
          step('shrunk', !!cur4 && cur4.w < wBeforeShrink * 0.7, `w ${wBeforeShrink.toFixed(0)}->${cur4 ? cur4.w.toFixed(0) : '?'}`);

          const countBefore = (state.annotations[1] || []).filter((x) => x.type === 'image' && x.native).length;

          // 找一个「在原图范围内、但在缩小后的图片框外」的点 —— 修复前这里会复制出一张原尺寸图
          const G = await import('./viewer.js');
          const vpG = G.getViewport(1);
          const pTL = vpG.convertToViewportPoint(pick.im.x, pick.im.y + pick.im.h);
          const pBR = vpG.convertToViewportPoint(pick.im.x + pick.im.w, pick.im.y);
          const wrG = G.pageWrap(1).getBoundingClientRect();
          const oL = wrG.left + Math.min(pTL[0], pBR[0]);
          const oT = wrG.top + Math.min(pTL[1], pBR[1]);
          const oR = wrG.left + Math.max(pTL[0], pBR[0]);
          const oB = wrG.top + Math.max(pTL[1], pBR[1]);

          const dupTest = async (tag) => {
            // 先重新选中图片（第一轮完成后会处于未选中态）
            const curX = (state.annotations[1] || []).find((x) => x.id === cur4.id);
            const nd0 = wrap.querySelector(`.anno[data-id="${cur4.id}"]`);
            if (nd0 && !wrap.querySelector('.anno-done')) {
              const r0 = nd0.getBoundingClientRect();
              const t0 = document.elementFromPoint(Math.round(r0.left + r0.width / 2), Math.round(r0.top + r0.height / 2));
              if (t0) {
                t0.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r0.left + r0.width / 2, clientY: r0.top + r0.height / 2 }));
                window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
                await wait(250);
              }
            }
            void curX;
            step(`${tag}Reselected`, !!wrap.querySelector('.anno-done'));

            // 点「完成」结束编辑
            const doneBtn = wrap.querySelector('.anno-done');
            if (doneBtn) doneBtn.click();
            await waitFor(() => !wrap.querySelector('.anno-done'), 1500);
            step(`${tag}Finished`, !wrap.querySelector('.anno-done'));

            // 在「原图内、注释框外」点一下
            const nd = wrap.querySelector(`.anno[data-id="${cur4.id}"]`);
            const ar = nd ? nd.getBoundingClientRect() : null;
            const cands2 = ar ? [
              { x: Math.round(ar.right + 12), y: Math.round(ar.bottom - 12) },
              { x: Math.round(ar.right + 12), y: Math.round((ar.top + ar.bottom) / 2) },
              { x: Math.round((ar.left + ar.right) / 2), y: Math.round(ar.bottom + 12) }
            ] : [];
            const pt = cands2.find((c) => c.x > oL + 4 && c.x < oR - 4 && c.y > oT + 4 && c.y < oB - 4
              && c.x > 4 && c.y > 4 && c.x < window.innerWidth - 4 && c.y < window.innerHeight - 4);
            step(`${tag}BlankPoint`, !!pt, pt ? `${pt.x},${pt.y}` : 'none');
            if (pt) {
              const tEl = document.elementFromPoint(pt.x, pt.y);
              step(`${tag}BlankTarget`, !!tEl, tEl ? (tEl.className || tEl.tagName) : 'null');
              if (tEl) {
                tEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: pt.x, clientY: pt.y }));
                window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
              }
              await wait(500);
            }
            const nowCount = (state.annotations[1] || []).filter((x) => x.type === 'image' && x.native).length;
            step(`${tag}NoDuplicate`, nowCount === countBefore, `n ${countBefore}->${nowCount}`);
            step(`${tag}StillDeselected`, !wrap.querySelector('.anno-done'));
          };
          await dupTest('dup1');
          await dupTest('dup2');
        }
        const bytes = await OPS.bakeBytes(true);
        const { PDFDocument } = await import('pdf-lib');
        const chk = await PDFDocument.load(bytes);
        step('bakeOk', chk.getPageCount() > 0, 'bytes=' + bytes.length);
      }
    }
    return { ok: log.every((l) => l[1]), steps: log };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e), steps: log };
  }
};

/** 截图用：进入「编辑文字」并停在编辑态 */
window.__shotTextEdit = async function (pdfPath, commit) {
  await IO.openPath(pdfPath);
  if (state.mode !== 'edit') switchMode('edit');
  await new Promise((r) => setTimeout(r, 800));
  const wrap = document.querySelector('.page-wrap[data-page="1"]');
  const wr = wrap.getBoundingClientRect();
  setTool(null);                      // 无工具：点击文字即进入文字编辑（需求 3）
  await waitForTextLayer(wrap);
  const p = scanTextPoint(wrap);
  if (p) {
    const node0 = document.elementFromPoint(p.x, p.y);
    node0.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: p.x, clientY: p.y }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    if (commit) {
      const tb0 = wrap.querySelector('.anno-text');
      if (tb0) { tb0.innerText = 'PDFmini 就地编辑测试'; tb0.blur(); }
      await new Promise((r) => setTimeout(r, 300));
      const id0 = (state.annotations[1] || [])[0] && (state.annotations[1] || [])[0].id;
      if (id0) selectById(1, id0);
      await new Promise((r) => setTimeout(r, 200));
    }
    const node = wrap.querySelector('.anno');
    const tb = node && node.querySelector('.anno-text');
    const cv = node && node.querySelector('.anno-cover');
    const R = (e2) => { if (!e2) return null; const b = e2.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
    const cs = tb ? getComputedStyle(tb) : null;
    return {
      ok: true, text: p.hit.text, fontSize: p.hit.fontSize, cover: p.hit.cover,
      wrapOrigin: [Math.round(wr.left), Math.round(wr.top)],
      annoRect: R(node), textRect: R(tb), coverRect: R(cv),
      textBg: cs ? cs.backgroundColor : '', textColor: cs ? cs.color : '',
      textContent: tb ? JSON.stringify(tb.innerText) : '', editing: tb ? tb.classList.contains('editing') : false
    };
  }
  return { ok: false };
};

/** 截图用：无工具状态下点击一段原生文字，展示“点文字即编辑”的就地编辑框与浮动工具条 */
window.__shotBlocks = async function (pdfPath) {
  await IO.openPath(pdfPath);
  if (state.mode !== 'edit') switchMode('edit');
  await new Promise((r) => setTimeout(r, 900));
  setTool(null);
  await new Promise((r) => setTimeout(r, 200));
  const wrap = document.querySelector('.page-wrap[data-page="1"]');
  await waitForTextLayer(wrap);
  const p = scanTextPoint(wrap);
  if (!p) return { ok: false, reason: 'no text point' };
  const node0 = document.elementFromPoint(p.x, p.y);
  node0.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: p.x, clientY: p.y }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  return {
    ok: true,
    editing: !!wrap.querySelector('.anno-text.editing'),
    hasBar: !!wrap.querySelector('.txt-bar'),
    fonts: wrap.querySelectorAll('.txt-bar .txt-f').length,
    colors: wrap.querySelectorAll('.txt-bar .txt-c').length
  };
};

/* 「插入文字」自检：文本框可直接拖动；点击已有文本框不会又弹出新文本框 */
window.__smokeInsert = async function (pdfPath) {
  const log = [];
  const step = (n, ok, extra) => log.push([n, !!ok, extra === undefined ? '' : extra]);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await IO.openPath(pdfPath);
    if (state.mode !== 'edit') switchMode('edit');
    const wrap = document.querySelector('.page-wrap[data-page="1"]');
    await waitForTextLayer(wrap);
    const wr = wrap.getBoundingClientRect();
    step('open', state.numPages > 0 && !!wrap, state.numPages + ' pages');

    setTool('insertText', true);
    await wait(150);
    const vp2 = document.getElementById('viewport').getBoundingClientRect();
    const pt = {
      x: Math.round(Math.min(Math.max(wr.left + 90, vp2.left + 40), vp2.right - 40)),
      y: Math.round(Math.min(wr.bottom, vp2.bottom) - 120)
    };
    if (pt.y < vp2.top + 30) pt.y = Math.round(vp2.top + 30);
    const t1 = document.elementFromPoint(pt.x, pt.y);
    t1.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: pt.x, clientY: pt.y }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await wait(300);
    const box = wrap.querySelector('.anno-text[contenteditable="true"]');
    step('newTextBox', !!box);
    if (box) {
      box.innerText = 'PDFmini 插入文字';
      box.dispatchEvent(new Event('blur'));
    }
    await wait(300);
    const annos = (state.annotations[1] || []).filter((a) => a.type === 'text');
    step('textCommitted', annos.length === 1 && annos[0].text === 'PDFmini 插入文字', JSON.stringify(annos.map((a) => a.text)));
    if (!annos.length) return { ok: false, steps: log };

    // 点击已存在的文本框：不能再新建
    const node = wrap.querySelector(`.anno[data-id="${annos[0].id}"] .anno-text`);
    const nr = node.getBoundingClientRect();
    const before = (state.annotations[1] || []).filter((a) => a.type === 'text').length;
    const target = document.elementFromPoint(Math.round(nr.left + 6), Math.round(nr.top + nr.height / 2));
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: nr.left + 6, clientY: nr.top + nr.height / 2 }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await wait(250);
    const after = (state.annotations[1] || []).filter((a) => a.type === 'text').length;
    step('noNewTextBoxOnClick', after === before, `n ${before}->${after}`);
    step('editingNotStarted', !wrap.querySelector('.anno-text[contenteditable="true"]'));

    // 直接拖动该文本框
    const x0 = annos[0].x;
    const node2 = wrap.querySelector(`.anno[data-id="${annos[0].id}"] .anno-text`);
    const r2 = node2.getBoundingClientRect();
    const t2 = document.elementFromPoint(Math.round(r2.left + 6), Math.round(r2.top + 6));
    t2.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r2.left + 6, clientY: r2.top + 6 }));
    for (let i = 1; i <= 5; i++) {
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r2.left + 6 + i * 10, clientY: r2.top + 6 + i * 5 }));
    }
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await wait(200);
    step('dragInsertedText', Math.abs(annos[0].x - x0) > 1, `x ${x0.toFixed(0)}->${annos[0].x.toFixed(0)}`);
    return { ok: log.every((l) => l[1]), steps: log };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e), steps: log };
  }
};

/* Word → PDF 自检 */
window.__smokeDocx = async function (docxPath) {
  const log = [];
  const step = (n, ok, extra) => log.push([n, !!ok, extra === undefined ? '' : extra]);
  try {
    const rd = await window.pdfmini.file.read(docxPath);
    step('read', rd.ok, rd.ok ? ('bytes=' + rd.data.byteLength) : rd.error);
    if (rd.ok) {
      try {
        const { docxToPdf } = await import('./docx.js');
        const out = await docxToPdf(new Uint8Array(rd.data));
        step('convert', !!out && out.length > 500, 'bytes=' + (out ? out.length : 0));
      } catch (e) {
        step('convert', false, String(e && e.message || e));
      }
    }
    await IO.importPaths([docxPath]);
    await new Promise((r) => setTimeout(r, 900));
    step('opened', state.numPages > 0, 'pages=' + state.numPages);
    step('nameIsPdf', /\.pdf$/i.test(state.fileName || ''), state.fileName);
    const txt = await extractText();
    step('hasTitle', txt.indexOf('Word 转 PDF 测试文档') >= 0, 'len=' + txt.length);
    step('hasHeading', txt.indexOf('总体说明') >= 0);
    step('hasTable', txt.indexOf('中文渲染') >= 0 && txt.indexOf('通过') >= 0);
    const cv = await renderPageToCanvas(1, 1);
    step('rendered', cv.width > 100, `${cv.width}x${cv.height}`);
    const bytes = await OPS.bakeBytes(true);
    step('saveable', bytes.length > 500, 'bytes=' + bytes.length);
    return { ok: log.every((l) => l[1]), steps: log };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e), steps: log };
  }
};

/** 截图用：选中 PDF 原生图片并停在该状态（用于核对遮盖层与选中边框） */
window.__shotImageEdit = async function (pdfPath) {
  await IO.openPath(pdfPath);
  if (state.mode !== 'edit') switchMode('edit');
  await new Promise((r) => setTimeout(r, 800));
  const V = await import('./viewer.js');
  const imgs = await V.getPageImages(1);
  if (!imgs.length) return { ok: false };
  const big = imgs.slice().sort((a, b) => b.w * b.h - a.w * a.h)[0];
  const vp = V.getViewport(1);
  const c = vp.convertToViewportPoint(big.x + big.w / 2, big.y + big.h / 2);
  const vpEl = document.getElementById('viewport');
  let wr = V.pageWrap(1).getBoundingClientRect();
  let px = wr.left + c[0], py = wr.top + c[1];
  const vr = vpEl.getBoundingClientRect();
  if (py < vr.top + 60 || py > vr.bottom - 60) {
    vpEl.scrollTop += Math.round(py - (vr.top + vr.height / 2));
    await new Promise((r) => setTimeout(r, 700));
    wr = V.pageWrap(1).getBoundingClientRect();
    px = wr.left + c[0];
    py = wr.top + c[1];
  }
  setTool('editImage', true);
  await new Promise((r) => setTimeout(r, 200));
  const el = document.elementFromPoint(px, py);
  if (!el) return { ok: false, reason: 'no hit', px, py };
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: px, clientY: py }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 1200));
  // 拖动一段距离，复现「移动后原位遮盖」的场景
  const anno = (state.annotations[1] || []).find((a) => a.type === 'image' && a.native);
  if (anno) {
    const node = document.querySelector(`.anno[data-id="${anno.id}"]`);
    const nr = node.getBoundingClientRect();
    node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: nr.left + nr.width / 2, clientY: nr.top + nr.height / 2 }));
    for (let i = 1; i <= 8; i++) {
      window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: nr.left + nr.width / 2 + i * 10, clientY: nr.top + nr.height / 2 + i * 6 }));
    }
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
  }
  return { ok: true, selected: !!anno, cover: !!document.querySelector('.anno-cover-el') };
};

/** 截图用：打开文档并跳到指定页（--shot-page=页码:文件） */
window.__shotPage = async function (arg) {
  const idx = String(arg).indexOf(':');
  const n = parseInt(idx > 0 ? String(arg).slice(0, idx) : arg, 10) || 1;
  const file = idx > 0 ? String(arg).slice(idx + 1) : '';
  if (file) await IO.openPath(file);
  if (state.mode !== 'edit') switchMode('view');
  goToPage(n, { smooth: false });
  await new Promise((r) => setTimeout(r, 1200));
  return { ok: true, page: state.currentPage, pages: state.numPages };
};

/** 诊断用：把第 1 页按 scale 渲染到 canvas，并裁剪指定文字所在的区域返回 dataURL */
/** 自检：编辑图片的删除按钮（原生图片=抹除，自己插入的=移除） */
window.__smokeImgDel = async function (pdfPath) {
  const log = [];
  const step = (n, ok, extra) => log.push([n, !!ok, extra === undefined ? '' : extra]);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await IO.openPath(pdfPath);
    if (state.mode !== 'edit') switchMode('edit');
    await wait(700);
    const V = await import('./viewer.js');
    const wrap = document.querySelector('.page-wrap[data-page="1"]');
    const imgs = await V.getPageImages(1);
    step('nativeImages', imgs.length > 0, 'n=' + imgs.length);
    if (!imgs.length) return { ok: false, steps: log };
    const big = imgs.slice().sort((a, b) => b.w * b.h - a.w * a.h)[0];
    const vp = V.getViewport(1);
    const c = vp.convertToViewportPoint(big.x + big.w / 2, big.y + big.h / 2);
    const vpEl = document.getElementById('viewport');
    let wr = wrap.getBoundingClientRect();
    let px = wr.left + c[0], py = wr.top + c[1];
    const vr = vpEl.getBoundingClientRect();
    if (py < vr.top + 60 || py > vr.bottom - 60) {
      vpEl.scrollTop += Math.round(py - (vr.top + vr.height / 2));
      await wait(700);
      wr = wrap.getBoundingClientRect();
      px = wr.left + c[0]; py = wr.top + c[1];
    }
    setTool('editImage', true);
    await wait(200);
    const t0 = document.elementFromPoint(px, py);
    t0.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: px, clientY: py }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await wait(1100);
    const anno = (state.annotations[1] || []).find((a) => a.type === 'image' && a.native);
    step('selected', !!anno);
    const del = wrap.querySelector('.anno-del');
    step('delBtnExists', !!del);
    if (del) {
      const dr = del.getBoundingClientRect();
      const hitEl = document.elementFromPoint(Math.round(dr.left + dr.width / 2), Math.round(dr.top + dr.height / 2));
      step('delBtnClickable', !!(hitEl && hitEl.closest && hitEl.closest('.anno-del')), hitEl ? (hitEl.className || hitEl.tagName) : 'null');
      if (hitEl) hitEl.click();
      await wait(400);
    }
    const after = (state.annotations[1] || []).find((a) => a.id === (anno && anno.id));
    step('nativeImageErased', !!after && after.erased === true && !after.dataUrl, after ? ('erased=' + after.erased + ' dataUrl=' + !!after.dataUrl) : 'gone');
    step('noSelectionAfter', !wrap.querySelector('.anno-sel'));

    // 自己插入的图片：删除应当整条移除
    const cv = document.createElement('canvas');
    cv.width = 60; cv.height = 40;
    cv.getContext('2d').fillStyle = '#e4002b';
    cv.getContext('2d').fillRect(0, 0, 60, 40);
    const url = cv.toDataURL('image/png');
    insertImageToCurrentPage(url, 'image/png');
    await wait(600);
    const mine = (state.annotations[1] || []).find((a) => a.type === 'image' && !a.native);
    step('insertedImage', !!mine);
    const del2 = wrap.querySelector('.anno-del');
    if (del2) {
      const dr2 = del2.getBoundingClientRect();
      const hit2 = document.elementFromPoint(Math.round(dr2.left + dr2.width / 2), Math.round(dr2.top + dr2.height / 2));
      if (hit2) hit2.click();
      await wait(400);
    }
    const stillMine = (state.annotations[1] || []).some((a) => a.type === 'image' && !a.native);
    step('insertedImageRemoved', !stillMine);
    return { ok: log.every((l) => l[1]), steps: log };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e), steps: log };
  }
};

window.__canvasCrop = async function (arg) {
  const parts = String(arg).split('|');
  const label = parts[0] || '';
  const scale = Number(parts[1]) || 3;
  const file = parts.slice(2).join('|');
  if (file) await IO.openPath(file);
  if (state.mode !== 'edit') switchMode('view');
  await new Promise((r) => setTimeout(r, 900));
  const wrap = document.querySelector('.page-wrap[data-page="1"]');
  const layer = wrap && wrap.querySelector('.textLayer');
  if (!layer) return { ok: false, reason: 'no layer' };
  const spans = Array.from(layer.querySelectorAll('span'));
  // 用页面上「已经渲染并做过缺字修复」的画布，而不是重新渲染一遍
  let cv = wrap.querySelector('canvas:not(.th)');
  let liveDpr = 1;
  if (cv && cv.width > 0) {
    liveDpr = cv.width / (parseFloat(cv.style.width) || cv.width);
  } else {
    cv = await renderPageToCanvas(1, scale);
  }
  if (!label) {
    const out0 = document.createElement('canvas');
    const k0 = Math.min(1, 1000 / cv.width);
    out0.width = Math.round(cv.width * k0);
    out0.height = Math.round(cv.height * k0);
    out0.getContext('2d').drawImage(cv, 0, 0, out0.width, out0.height);
    return { ok: true, full: true, dataUrl: out0.toDataURL('image/png') };
  }
  const target = spans.find((s) => (s.textContent || '').indexOf(label) >= 0);
  if (!target) return { ok: false, reason: 'no span', sample: spans.slice(0, 5).map((s) => s.textContent) };
  const wr = wrap.getBoundingClientRect();
  const tb = target.getBoundingClientRect();
  const k = (cv.width / wr.width) || liveDpr;
  const x = Math.max(0, Math.round((tb.left - wr.left) * k) - 6);
  const y = Math.max(0, Math.round((tb.top - wr.top) * k) - 6);
  const w = Math.min(cv.width - x, Math.round(tb.width * k) + 12);
  const h = Math.min(cv.height - y, Math.round(tb.height * k) + 12);
  const out = document.createElement('canvas');
  out.width = w * 3; out.height = h * 3;
  out.getContext('2d').drawImage(cv, x, y, w, h, 0, 0, out.width, out.height);
  return { ok: true, text: target.textContent, x, y, w, h, dataUrl: out.toDataURL('image/png') };
};

/** 自检：编辑文字里把内容清空（等同于删除文字）后的残留与复现情况 */
window.__smokeErase = async function (pdfPath) {
  const log = [];
  const step = (n, ok, extra) => log.push([n, !!ok, extra === undefined ? '' : extra]);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await IO.openPath(pdfPath);
    if (state.mode !== 'edit') switchMode('edit');
    await wait(700);
    const wrap = document.querySelector('.page-wrap[data-page="1"]');
    setTool(null);
    await waitForTextLayer(wrap);
    await wait(200);
    const p = scanTextPoint(wrap);
    step('textPoint', !!p, p ? `${p.x},${p.y}` : 'none');
    if (!p) return { ok: false, steps: log };
    const px = p.x, py = p.y;
    const t0 = document.elementFromPoint(px, py);
    t0.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: px, clientY: py }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await wait(350);
    const box = wrap.querySelector('.anno-text[contenteditable="true"]');
    step('editing', !!box, box ? JSON.stringify(box.innerText.slice(0, 12)) : 'none');
    const key0 = (state.annotations[1] || [])[0] && (state.annotations[1] || [])[0].blockKey;
    step('blockKey', !!key0, String(key0));
    if (box) { box.innerText = ''; box.dispatchEvent(new Event('blur')); }
    await wait(400);
    const annos = state.annotations[1] || [];
    step('annoKept', annos.length === 1, 'n=' + annos.length + ' text=' + JSON.stringify((annos[0] || {}).text));
    step('coverKept', !!(annos[0] && annos[0].cover));
    // 删除文字后原位置不应残留黑点（字形墨迹可能超出文字层包围盒）
    await wait(600);
    const c0 = (state.annotations[1] || [])[0];
    const dark = c0 && c0.cover
      ? await residualDarkPixels(1, { x1: c0.cover.x, x2: c0.cover.x + c0.cover.w, y1: c0.cover.y, y2: c0.cover.y + c0.cover.h })
      : -1;
    step('noDarkSpeck', dark === 0, 'darkPixels=' + dark);
    const emptyBox = wrap.querySelector('.anno-text');
    step('noEmptyTextBox', !emptyBox, emptyBox ? 'len=' + emptyBox.textContent.length : 'none');
    step('noResidualSel', !wrap.querySelector('.anno-sel'), 'sel=' + wrap.querySelectorAll('.anno-sel').length);
    // 点空白
    const blank = scanBlankPoint(wrap);
    if (blank) {
      const et = document.elementFromPoint(blank.x, blank.y);
      et.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: blank.x, clientY: blank.y }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    }
    await wait(400);
    step('afterBlankSel', !wrap.querySelector('.anno-sel'));
    step('afterBlankNoNewAnno', (state.annotations[1] || []).length === 1, 'n=' + (state.annotations[1] || []).length);
    // 再点原位置（此时文字已被抹除，不应“复活”）
    const t2 = document.elementFromPoint(px, py);
    step('hitAtOrigin', !!t2, t2 ? (t2.className || t2.tagName) : 'null');
    if (t2) { t2.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: px, clientY: py })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); }
    await wait(400);
    const after = state.annotations[1] || [];
    step('noRevive', after.length === 1 && !!(after[0] && after[0].erased === true), 'n=' + after.length + ' texts=' + JSON.stringify(after.map((a) => (a.text || '').slice(0, 8))));
    return { ok: log.every((l) => l[1]), steps: log };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e), steps: log };
  }
};

/* ================= 需求 3：点文字/图片即编辑 ================= */
window.__smokeSmart = async function (pdfPath) {
  const log = [];
  const step = (n, ok, extra) => log.push([n, !!ok, extra === undefined ? '' : extra]);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = (x, y) => {
    const el = document.elementFromPoint(x, y);
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y }));
  };
  try {
    await IO.openPath(pdfPath);
    if (state.mode !== 'edit') switchMode('edit');
    await wait(800);
    const wrap = document.querySelector('.page-wrap[data-page="1"]');
    setTool(null);
    await wait(200);
    step('noEditTextButton', !document.querySelector('.tbtn[data-tool="editText"]'));
    step('noEditImageButton', !document.querySelector('.tbtn[data-tool="editImage"]'));
    step('hasMarqueeButton', !!document.querySelector('.tbtn[data-tool="marquee"]'));

    // 1) 点文字 → 就地编辑 + 浮动工具条
    await waitForTextLayer(wrap);
    const p = scanTextPoint(wrap);
    step('textPoint', !!p, p ? `${p.x},${p.y}` : 'none');
    if (!p) return { ok: false, steps: log };
    const wr0 = wrap.getBoundingClientRect();
    step('blocksTotal', textBlockCount(1) > 1, 'n=' + textBlockCount(1));
    step('blockAtHit', !!hitTextBlock(1, p.x - wr0.left, p.y - wr0.top), `local=${Math.round(p.x - wr0.left)},${Math.round(p.y - wr0.top)}`);
    // 悬停提示（hover 有 60ms 节流，这里多打两次确保生效）
    let hovered = false;
    for (let k = 0; k < 4 && !hovered; k++) {
      const hEl = document.elementFromPoint(p.x, p.y);
      hEl.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: p.x, clientY: p.y }));
      await wait(120);
      hovered = !!wrap.querySelector('.text-hover');
    }
    step('hoverHighlight', hovered);
    const hEl2 = document.elementFromPoint(p.x, p.y);
    if (hEl2) hEl2.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: p.x, clientY: 4 }));
    click(p.x, p.y);
    await wait(350);
    let box = wrap.querySelector('.anno-text[contenteditable="true"]');
    step('textEditing', !!box);
    const bar = wrap.querySelector('.txt-bar');
    step('textBar', !!bar);
    step('fontBtnCount', wrap.querySelectorAll('.txt-bar .txt-f').length === 4, 'n=' + wrap.querySelectorAll('.txt-bar .txt-f').length);
    step('colorBtnCount', wrap.querySelectorAll('.txt-bar .txt-c').length >= 4, 'n=' + wrap.querySelectorAll('.txt-bar .txt-c').length);
    const a0 = (state.annotations[1] || [])[0];
    step('nativeTextKept', !!a0 && a0.text === p.hit.text, a0 ? JSON.stringify(a0.text.slice(0, 14)) : 'none');
    step('hasCover', !!(a0 && a0.cover));

    // 切换字体与颜色
    const fBtns = Array.from(wrap.querySelectorAll('.txt-bar .txt-f'));
    const kai = fBtns[1];
    if (kai) kai.click();
    const cBtns = Array.from(wrap.querySelectorAll('.txt-bar .txt-c'));
    const blue = cBtns[4];
    if (blue) blue.click();
    const sizePlus = wrap.querySelectorAll('.txt-bar .txt-step')[1];
    const sizeBefore = (state.annotations[1] || [])[0].fontSize;
    if (sizePlus) sizePlus.click();
    step('fontApplied', (state.annotations[1] || [])[0].font === 'kai', String((state.annotations[1] || [])[0].font));
    step('colorApplied', (state.annotations[1] || [])[0].color === '#1565c0', String((state.annotations[1] || [])[0].color));
    step('sizeApplied', (state.annotations[1] || [])[0].fontSize > sizeBefore, `${sizeBefore}->${(state.annotations[1] || [])[0].fontSize}`);

    // 直接点另一个位置结束编辑（不新建）
    const blank = scanBlankPoint(wrap);
    if (blank) click(blank.x, blank.y);
    await wait(400);
    step('committed', !wrap.querySelector('.anno-text[contenteditable="true"]'));
    step('annoCountAfterClickBlank', (state.annotations[1] || []).length === 1, 'n=' + (state.annotations[1] || []).length);

    // 写入 PDF：应用了自定义字体/颜色后仍可正常烘出
    try {
      const bytes = await OPS.bakeBytes(true);
      step('bakeLatin', bytes.length > 500, 'bytes=' + bytes.length);
    } catch (e) { step('bakeLatin', false, String(e && e.message || e)); }

    // 写入 PDF：中文 + 楷体（走系统字体子集内嵌）
    try {
      snapshot();
      push(1, { id: 'cjk1', type: 'text', x: 90, y: 320, text: '中文楷体测试 ABC', fontSize: 16, color: '#e4002b', font: 'kai', w: 200 });
      const b2 = await OPS.bakeBytes(true);
      step('bakeCJK', b2.length > 500, 'bytes=' + b2.length);
      state.annotations[1] = (state.annotations[1] || []).filter((x) => x.id !== 'cjk1');
      drawOverlay(1);
    } catch (e) { step('bakeCJK', false, String(e && e.message || e)); }

    // 2) 点原生图片 → 选中（若该文档有图片）
    state.annotations = {}; state.undo = []; state.redo = []; setDirty(false); drawOverlay(1);
    await wait(200);
    const V = await import('./viewer.js');
    const imgs = await V.getPageImages(1);
    if (imgs.length) {
      const vp = V.getViewport(1);
      const big = imgs.slice().sort((a, b) => b.w * b.h - a.w * a.h)[0];
      const c = vp.convertToViewportPoint(big.x + big.w / 2, big.y + big.h / 2);
      const vpEl = document.getElementById('viewport');
      let wr2 = wrap.getBoundingClientRect();
      let px = wr2.left + c[0], py = wr2.top + c[1];
      const vr = vpEl.getBoundingClientRect();
      if (py < vr.top + 60 || py > vr.bottom - 60) {
        vpEl.scrollTop += Math.round(py - (vr.top + vr.height / 2));
        await wait(700);
        wr2 = wrap.getBoundingClientRect();
        px = wr2.left + c[0]; py = wr2.top + c[1];
      }
      click(px, py);
      await wait(1200);
      const ia = (state.annotations[1] || []).filter((x) => x.type === 'image' && x.native);
      step('imageSelectedNoTool', ia.length === 1, 'n=' + ia.length);
      step('imageHandles', wrap.querySelectorAll('.anno-h').length >= 4, 'n=' + wrap.querySelectorAll('.anno-h').length);
    }
    return { ok: log.every((l) => l[1]), steps: log };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e), steps: log };
  }
};

/* ================= 需求 2：框选删除（右键框选 → 点删除确认） ================= */
/** 自检辅助：把页面按 scale 渲染，涂上所有白底遮盖后统计框内残余的暗像素 */
async function residualDarkPixels(page, box) {
  const canvas = await renderPageToCanvas(page, 2);
  const ctx = canvas.getContext('2d');
  const docPage = await state.pdfDoc.getPage(page);
  const info = state.pageInfo[page] || { rotate: 0 };
  const vp = docPage.getViewport({ scale: 2, rotation: info.rotate || 0 });
  ctx.fillStyle = '#fff';
  for (const a of (state.annotations[page] || [])) {
    const c = a.cover;
    if (!c || !a.erased) continue;
    const p1 = vp.convertToViewportPoint(c.x, c.y);
    const p2 = vp.convertToViewportPoint(c.x + c.w, c.y + c.h);
    ctx.fillRect(Math.min(p1[0], p2[0]), Math.min(p1[1], p2[1]), Math.abs(p2[0] - p1[0]), Math.abs(p2[1] - p1[1]));
  }
  const a1 = vp.convertToViewportPoint(box.x1, box.y1);
  const a2 = vp.convertToViewportPoint(box.x2, box.y2);
  const x0 = Math.max(0, Math.floor(Math.min(a1[0], a2[0])));
  const y0 = Math.max(0, Math.floor(Math.min(a1[1], a2[1])));
  const w = Math.min(canvas.width - x0, Math.ceil(Math.abs(a2[0] - a1[0])));
  const h = Math.min(canvas.height - y0, Math.ceil(Math.abs(a2[1] - a1[1])));
  if (w < 2 || h < 2) return 0;
  const data = ctx.getImageData(x0, y0, w, h).data;
  let dark = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] < 230 || data[i + 1] < 230 || data[i + 2] < 230) dark++;
  }
  return dark;
}

window.__smokeMarquee = async function (pdfPath) {
  const log = [];
  const step = (n, ok, extra) => log.push([n, !!ok, extra === undefined ? '' : extra]);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const vpEl = document.getElementById('viewport');
  const dragRight = async (sx, sy, ex, ey) => {
    const el = document.elementFromPoint(sx, sy);
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2, buttons: 2, clientX: sx, clientY: sy }));
    for (let i = 1; i <= 6; i++) {
      window.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, button: 2, buttons: 2,
        clientX: Math.round(sx + (ex - sx) * i / 6), clientY: Math.round(sy + (ey - sy) * i / 6)
      }));
      await wait(20);
    }
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 2, clientX: ex, clientY: ey }));
    await wait(300);
  };
  const clickAt = async (x, y) => {
    const el = document.elementFromPoint(x, y) || document.body;
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
    await wait(200);
  };
  try {
    await IO.openPath(pdfPath);
    if (state.mode !== 'edit') switchMode('edit');
    const wrap = document.querySelector('.page-wrap[data-page="1"]');
    setTool(null);
    await waitForTextLayer(wrap);
    await wait(250);

    const V = await import('./viewer.js');
    const vpBox = vpEl.getBoundingClientRect();
    const before = (state.annotations[1] || []).length;

    /* ---------- 1) 右键拖框：只出选区与按钮，不直接删 ---------- */
    const p = scanTextPoint(wrap);
    step('textPoint', !!p, p ? `${p.x},${p.y}` : 'none');
    if (!p) return { ok: false, steps: log };
    const vp = V.getViewport(1);
    const wr = wrap.getBoundingClientRect();
    const tl = vp.convertToViewportPoint(p.hit.cover.x, p.hit.cover.y + p.hit.cover.h);
    const br = vp.convertToViewportPoint(p.hit.cover.x + p.hit.cover.w, p.hit.cover.y);
    const bx1 = Math.round(wr.left + Math.min(tl[0], br[0]));
    const by1 = Math.round(wr.top + Math.min(tl[1], br[1]));
    const bx2 = Math.round(wr.left + Math.max(tl[0], br[0]));
    const by2 = Math.round(wr.top + Math.max(tl[1], br[1]));
    const sx = Math.max(vpBox.left + 30, bx1 - 10);
    const ex = Math.min(vpBox.right - 30, bx2 + 12);
    const sy = by1 - 6;
    const ey = by2 + 6;

    await dragRight(sx, sy, ex, ey);
    step('rightDragSelects', !!wrap.querySelector('.marquee-box') && !!wrap.querySelector('.marquee-bar'),
      'box=' + !!wrap.querySelector('.marquee-box') + ' bar=' + !!wrap.querySelector('.marquee-bar'));
    step('notDeletedYet', (state.annotations[1] || []).length === before, 'n=' + (state.annotations[1] || []).length);

    /* ---------- 2) 点「取消」：选区消失且内容不变 ---------- */
    const cancelBtn = wrap.querySelector('.marquee-bar .mq-cancel');
    step('cancelBtnShown', !!cancelBtn);
    if (cancelBtn) {
      const r = cancelBtn.getBoundingClientRect();
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + r.height / 2);
      const hitEl = document.elementFromPoint(cx, cy);
      const okHit = !!(hitEl && hitEl.closest && hitEl.closest('.mq-cancel'));
      step('cancelBtnHittable', okHit,
        'rect=' + JSON.stringify([Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)])
        + ' hit=' + (hitEl ? (hitEl.className || hitEl.tagName) : 'null'));
      if (okHit) await clickAt(cx, cy);
      else cancelBtn.click();       // 命不中也要把后续路径跑完，好定位问题
      await wait(150);
    }
    step('cancelClears', !wrap.querySelector('.marquee-box') && (state.annotations[1] || []).length === before);

    /* ---------- 3) 再框选 + 点「删除」 ---------- */
    await dragRight(sx, sy, ex, ey);
    const delBtn = wrap.querySelector('.marquee-bar .mq-del');
    step('delBtnShown', !!delBtn);
    if (delBtn) {
      const r = delBtn.getBoundingClientRect();
      const hitEl = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      step('delBtnHittable', !!(hitEl && hitEl.classList && hitEl.classList.contains('mq-del')),
        'rect=' + JSON.stringify([Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]) + ' hit=' + (hitEl ? (hitEl.className || hitEl.tagName) : 'null'));
      await clickAt(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    }
    await wait(1500);
    const after = state.annotations[1] || [];
    step('deletedAfterConfirm', after.length > before, `n ${before}->${after.length}`);
    step('erasedCreated', after.some((a) => a.erased), JSON.stringify(after.map((a) => a.erased ? 'E' : 'K')));
    step('selectionCleared', !wrap.querySelector('.marquee-box'));
    step('dirty', state.dirty === true);

    const t1u = V.getViewport(1).convertToPdfPoint(bx1 - wr.left, by1 - wr.top);
    const t2u = V.getViewport(1).convertToPdfPoint(bx2 - wr.left, by2 - wr.top);
    const uBox = {
      x1: Math.min(t1u[0], t2u[0]), x2: Math.max(t1u[0], t2u[0]),
      y1: Math.min(t1u[1], t2u[1]), y2: Math.max(t1u[1], t2u[1])
    };
    const dark = await residualDarkPixels(1, uBox);
    step('cleanedNoResidue', dark === 0, 'darkPixels=' + dark);

    // 再点原位置：不应复活原文
    const el2 = document.elementFromPoint(p.x, p.y);
    el2.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: p.x, clientY: p.y }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: p.x, clientY: p.y }));
    await wait(350);
    step('noReviveAfterMarquee', (state.annotations[1] || []).length === after.length && !wrap.querySelector('.anno-text[contenteditable="true"]'));

    // 撤销可恢复
    undo();
    await wait(300);
    step('undoRestores', (state.annotations[1] || []).length === before, 'n=' + (state.annotations[1] || []).length);

    /* ---------- 4) 左键拖动 = 平移页面（不再框选） ---------- */
    state.annotations = {}; state.undo = []; state.redo = []; setDirty(false); drawOverlay(1);
    await wait(250);
    const blank = scanBlankPoint(wrap);
    step('blankPoint', !!blank, blank ? `${blank.x},${blank.y}` : 'none');
    if (blank) {
      const st0 = vpEl.scrollTop;
      const el = document.elementFromPoint(blank.x, blank.y);
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1, clientX: blank.x, clientY: blank.y }));
      for (let i = 1; i <= 5; i++) {
        window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, buttons: 1, clientX: blank.x, clientY: blank.y - i * 12 }));
      }
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: blank.x, clientY: blank.y - 60 }));
      await wait(200);
      step('leftDragPans', Math.abs(vpEl.scrollTop - st0) > 10, `scrollTop ${Math.round(st0)}->${Math.round(vpEl.scrollTop)}`);
      step('noMarqueeOnLeftDrag', !wrap.querySelector('.marquee-box'));
      step('panningClassCleared', !document.body.classList.contains('panning'));
    }
    return { ok: log.every((l) => l[1]), steps: log };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e), steps: log };
  }
};

/* 自检：矢量点阵（图片算子/文字层都识别不到）框选后必须删干净 */
window.__smokeVectorErase = async function (pdfPath) {
  const log = [];
  const step = (n, ok, extra) => log.push([n, !!ok, extra === undefined ? '' : extra]);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const vpEl = document.getElementById('viewport');
  try {
    await IO.openPath(pdfPath);
    if (state.mode !== 'edit') switchMode('edit');
    const wrap = document.querySelector('.page-wrap[data-page="1"]');
    setTool(null);
    await waitForTextLayer(wrap);
    await wait(250);
    const V = await import('./viewer.js');
    const vpBox = vpEl.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    // 框住整块点阵（PDF 用户空间 100..410 / 100..430）
    const c1 = V.getViewport(1).convertToViewportPoint(100, 100);
    const c2 = V.getViewport(1).convertToViewportPoint(410, 430);
    let sx = Math.round(wr.left + Math.min(c1[0], c2[0])) - 8;
    let sy = Math.round(wr.top + Math.min(c1[1], c2[1])) - 8;
    let ex = Math.round(wr.left + Math.max(c1[0], c2[0])) + 8;
    let ey = Math.round(wr.top + Math.max(c1[1], c2[1])) + 8;
    // 需要可见才能模拟鼠标：先滚到中间
    const cyNow = (sy + ey) / 2;
    const need = cyNow - (vpBox.top + vpBox.height / 2);
    if (Math.abs(need) > 30) { vpEl.scrollTop += Math.round(need); await wait(700); }
    const wr2 = wrap.getBoundingClientRect();
    const vpBox2 = vpEl.getBoundingClientRect();
    const dx = wr2.left - wr.left, dy = wr2.top - wr.top;
    sx += dx; sy += dy; ex += dx; ey += dy;
    sx = Math.max(vpBox2.left + 8, sx); sy = Math.max(vpBox2.top + 8, sy);
    ex = Math.min(vpBox2.right - 8, ex); ey = Math.min(vpBox2.bottom - 8, ey);
    step('boxVisible', ex - sx > 60 && ey - sy > 60, `${sx},${sy} -> ${ex},${ey}`);

    const el = document.elementFromPoint(sx, sy);
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2, buttons: 2, clientX: sx, clientY: sy }));
    for (let i = 1; i <= 6; i++) {
      window.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, button: 2, buttons: 2,
        clientX: Math.round(sx + (ex - sx) * i / 6), clientY: Math.round(sy + (ey - sy) * i / 6)
      }));
      await wait(20);
    }
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 2, clientX: ex, clientY: ey }));
    await wait(300);
    step('selected', !!wrap.querySelector('.marquee-box'));

    const delBtn = wrap.querySelector('.marquee-bar .mq-del');
    if (delBtn) {
      delBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      delBtn.click();
    }
    await wait(1800);
    step('coversAdded', (state.annotations[1] || []).length > 0, 'n=' + (state.annotations[1] || []).length);

    const u1 = V.getViewport(1).convertToPdfPoint(sx - wr2.left, sy - wr2.top);
    const u2 = V.getViewport(1).convertToPdfPoint(ex - wr2.left, ey - wr2.top);
    const dark = await residualDarkPixels(1, {
      x1: Math.min(u1[0], u2[0]), x2: Math.max(u1[0], u2[0]),
      y1: Math.min(u1[1], u2[1]), y2: Math.max(u1[1], u2[1])
    });
    step('cleanedNoResidue', dark === 0, 'darkPixels=' + dark);
    return { ok: log.every((l) => l[1]), steps: log };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e), steps: log };
  }
};

/* 截图用：右键拖出选区后停在「选区 + 删除按钮」状态（用于核对新交互） */
window.__shotMarquee = async function (pdfPath) {
  await IO.openPath(pdfPath);
  if (state.mode !== 'edit') switchMode('edit');
  const wrap = document.querySelector('.page-wrap[data-page="1"]');
  setTool(null);
  await waitForTextLayer(wrap);
  await new Promise((r) => setTimeout(r, 250));
  const p = scanTextPoint(wrap);
  if (!p) return { ok: false, reason: 'no text point' };
  const V = await import('./viewer.js');
  const vp = V.getViewport(1);
  const wr = wrap.getBoundingClientRect();
  const tl = vp.convertToViewportPoint(p.hit.cover.x, p.hit.cover.y + p.hit.cover.h);
  const br = vp.convertToViewportPoint(p.hit.cover.x + p.hit.cover.w, p.hit.cover.y);
  const x1 = Math.round(wr.left + Math.min(tl[0], br[0]));
  const y1 = Math.round(wr.top + Math.min(tl[1], br[1]));
  const x2 = Math.round(wr.left + Math.max(tl[0], br[0]));
  const y2 = Math.round(wr.top + Math.max(tl[1], br[1]));
  const vpEl = document.getElementById('viewport').getBoundingClientRect();
  const sx = Math.max(vpEl.left + 30, x1 - 10);
  const sy = y1 - 6;
  const ex = Math.min(vpEl.right - 30, x2 + 12);
  const ey = y2 + 6;
  const el = document.elementFromPoint(sx, sy);
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 2, buttons: 2, clientX: sx, clientY: sy }));
  for (let i = 1; i <= 6; i++) {
    window.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, button: 2, buttons: 2,
      clientX: Math.round(sx + (ex - sx) * i / 6), clientY: Math.round(sy + (ey - sy) * i / 6)
    }));
    await new Promise((r) => setTimeout(r, 25));
  }
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 2, clientX: ex, clientY: ey }));
  await new Promise((r) => setTimeout(r, 400));
  return { ok: true, bar: !!wrap.querySelector('.marquee-bar'), box: !!wrap.querySelector('.marquee-box') };
};

/* ================= 需求：浏览模式选中文字/图片复制 ================= */
window.__smokeViewCopy = async function (pdfPath) {
  const log = [];
  const step = (n, ok, extra) => log.push([n, !!ok, extra === undefined ? '' : extra]);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await IO.openPath(pdfPath);
    if (state.mode !== 'view') switchMode('view');
    const wrap = document.querySelector('.page-wrap[data-page="1"]');
    await waitForTextLayer(wrap);
    await wait(250);
    step('isViewMode', state.mode === 'view');

    /* ---- 1) 文字可以被鼠标选中（CSS 放行 user-select） ---- */
    const span = wrap.querySelector('.textLayer span');
    step('spanFound', !!span);
    if (span) {
      const us = getComputedStyle(span).userSelect || getComputedStyle(span).webkitUserSelect;
      step('userSelectText', us === 'text', 'user-select=' + us);
    }

    /* ---- 2) 选中一段文字 → 复制 → 剪贴板里应是这段文字 ---- */
    const layer = wrap.querySelector('.textLayer');
    const picks = Array.from(layer.querySelectorAll('span')).filter((s) => (s.textContent || '').trim());
    if (picks.length) {
      await window.pdfmini.clipboard.writeText('__cleared__');
      const r = document.createRange();
      r.setStartBefore(picks[0]);
      r.setEndAfter(picks[Math.min(2, picks.length - 1)]);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      const selText = String(sel).trim();
      step('selectionMade', selText.length > 0, JSON.stringify(selText.slice(0, 24)));
      document.execCommand('copy');
      await wait(300);
      const clip = await window.pdfmini.clipboard.read();
      step('textCopied', !!clip.text && clip.text.trim().length > 0, JSON.stringify((clip.text || '').slice(0, 24)));
      sel.removeAllRanges();
    }

    /* ---- 3) 点图片 → 出现选中框 → Ctrl+C 复制图片 ---- */
    const V = await import('./viewer.js');
    const imgs = await V.getPageImages(1);
    if (imgs.length) {
      const big = imgs.slice().sort((a, b) => b.w * b.h - a.w * a.h)[0];
      const c = V.getViewport(1).convertToViewportPoint(big.x + big.w / 2, big.y + big.h / 2);
      const vpEl = document.getElementById('viewport');
      let wr = wrap.getBoundingClientRect();
      let px = wr.left + c[0], py = wr.top + c[1];
      const vr = vpEl.getBoundingClientRect();
      if (py < vr.top + 60 || py > vr.bottom - 60) {
        vpEl.scrollTop += Math.round(py - (vr.top + vr.height / 2));
        await wait(700);
        wr = wrap.getBoundingClientRect();
        px = wr.left + c[0]; py = wr.top + c[1];
      }
      const el = document.elementFromPoint(px, py);
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1, clientX: px, clientY: py }));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: px, clientY: py }));
      await wait(300);
      step('imagePicked', !!wrap.querySelector('.img-pick'), 'pick=' + !!wrap.querySelector('.img-pick'));
      await window.pdfmini.clipboard.writeText('__cleared__');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }));
      await wait(1200);
      const clip2 = await window.pdfmini.clipboard.read();
      step('imageCopied', !!clip2.hasImage && clip2.width > 10, 'img=' + clip2.width + 'x' + clip2.height);
    }

    /* ---- 4) 右键菜单：复制本页为图片 / 复制本页文字 ---- */
    const blank = scanBlankPoint(wrap) || { x: Math.round(vr.left + 40), y: Math.round(vr.top + 40) };
    const tEl = document.elementFromPoint(blank.x, blank.y) || document.body;
    tEl.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: blank.x, clientY: blank.y }));
    await wait(300);
    const menu = document.querySelector('#menu-root .menu');
    const labels = menu ? Array.from(menu.querySelectorAll('.menu-item span:nth-child(2)')).map((x) => x.textContent) : [];
    step('contextMenuShown', !!menu, JSON.stringify(labels));
    step('menuHasPageImage', labels.some((l) => l.indexOf('本页为图片') >= 0), JSON.stringify(labels));
    step('menuHasPageText', labels.some((l) => l.indexOf('本页文字') >= 0), JSON.stringify(labels));

    // 点「复制本页为图片」验证可用
    if (menu) {
      const target = Array.from(menu.querySelectorAll('.menu-item')).find((it) => it.textContent.indexOf('本页为图片') >= 0);
      if (target) target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await wait(1500);
      const clip3 = await window.pdfmini.clipboard.read();
      step('pageImageCopied', !!clip3.hasImage && clip3.width > 100, 'img=' + clip3.width + 'x' + clip3.height);
    }
    return { ok: log.every((l) => l[1]), steps: log };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e), steps: log };
  }
};

/* ================= 需求：编辑文字后不应自动换行 ================= */
window.__smokeNoWrap = async function (pdfPath) {
  const log = [];
  const step = (n, ok, extra) => log.push([n, !!ok, extra === undefined ? '' : extra]);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await IO.openPath(pdfPath);
    if (state.mode !== 'edit') switchMode('edit');
    const wrap = document.querySelector('.page-wrap[data-page="1"]');
    setTool(null);
    await waitForTextLayer(wrap);
    await wait(250);

    const p = scanTextPoint(wrap);
    step('textPoint', !!p, p ? `${p.x},${p.y}` : 'none');
    if (!p) return { ok: false, steps: log };

    // 点开文字 → 什么都不改 → 直接提交（模拟「点保存」）
    const el = document.elementFromPoint(p.x, p.y);
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: p.x, clientY: p.y }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: p.x, clientY: p.y }));
    await wait(400);
    const editing = wrap.querySelector('.anno-text[contenteditable="true"]');
    step('openedEditor', !!editing);
    if (editing) editing.dispatchEvent(new Event('blur'));     // 未做任何修改就提交
    await wait(600);

    const a = (state.annotations[1] || [])[0];
    step('annotationKept', !!a && a.text === p.hit.text, a ? JSON.stringify(a.text.slice(0, 20)) : 'none');
    const box = wrap.querySelector('.anno-text');
    step('boxRendered', !!box);
    if (box) {
      const cs = getComputedStyle(box);
      const lh = parseFloat(cs.lineHeight) || 0;
      const h = box.getBoundingClientRect().height;
      const lines = lh > 0 ? Math.round(h / lh) : 0;
      step('singleLine', lines === 1, `h=${Math.round(h)} lh=${Math.round(lh)} lines=${lines}`);

      // 与「用同一字体渲染这段文字所需的自然宽度」比较
      const probe = document.createElement('span');
      probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${cs.font};letter-spacing:${cs.letterSpacing}`;
      probe.textContent = box.textContent;
      document.body.appendChild(probe);
      const natural = probe.getBoundingClientRect().width;
      probe.remove();
      const boxCs = getComputedStyle(box);
      const boxPad = (parseFloat(boxCs.paddingLeft) || 0) + (parseFloat(boxCs.paddingRight) || 0)
        + (parseFloat(boxCs.borderLeftWidth) || 0) + (parseFloat(boxCs.borderRightWidth) || 0);
      const boxContent = box.getBoundingClientRect().width - boxPad;
      step('boxWideEnough', boxContent + 0.5 >= natural,
        `content=${boxContent.toFixed(1)} natural=${natural.toFixed(1)}`);
      step('storedWidthEnough', !!a && Math.ceil(a.w * state.zoom) + 1 >= natural,
        a ? `a.w*zoom=${Math.round(a.w * state.zoom)} natural=${Math.round(natural)}` : 'none');
    }
    return { ok: log.every((l) => l[1]), steps: log };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e), steps: log };
  }
};

/* 截图用：浏览模式下选中文字 + 选中图片（展示复制能力） */
window.__shotViewPick = async function (pdfPath) {
  await IO.openPath(pdfPath);
  if (state.mode !== 'view') switchMode('view');
  const wrap = document.querySelector('.page-wrap[data-page="1"]');
  await waitForTextLayer(wrap);
  await new Promise((r) => setTimeout(r, 300));
  const V = await import('./viewer.js');
  const imgs = await V.getPageImages(1);
  if (!imgs.length) return { ok: false, reason: 'no image' };
  const big = imgs.slice().sort((a, b) => b.w * b.h - a.w * a.h)[0];
  // 把图片滚到视口中间，让它下面的说明文字也一并可见
  const vpEl = document.getElementById('viewport');
  const c = V.getViewport(1).convertToViewportPoint(big.x + big.w / 2, big.y + big.h / 2);
  let wr = wrap.getBoundingClientRect();
  const vr = vpEl.getBoundingClientRect();
  vpEl.scrollTop += Math.round((wr.top + c[1]) - (vr.top + vr.height / 2));
  await new Promise((r) => setTimeout(r, 700));
  wr = wrap.getBoundingClientRect();

  // 选中图片下方最近的一行文字
  const spans = Array.from(wrap.querySelectorAll('.textLayer span')).filter((x) => (x.textContent || '').trim());
  const ib = V.getViewport(1).convertToViewportPoint(big.x, big.y);
  const imgBottom = wr.top + ib[1];
  let best = null, bestD = Infinity;
  for (const sp of spans) {
    const b = sp.getBoundingClientRect();
    if (b.top < imgBottom) continue;
    const d = b.top - imgBottom;
    if (d < bestD) { bestD = d; best = sp; }
  }
  if (best) {
    const r = document.createRange();
    r.setStartBefore(best);
    r.setEndAfter(best);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(r);
  }

  // 选中图片
  const pc = V.getViewport(1).convertToViewportPoint(big.x + big.w / 2, big.y + big.h / 2);
  const px = wr.left + pc[0], py = wr.top + pc[1];
  const el = document.elementFromPoint(px, py);
  if (el) {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, buttons: 1, clientX: px, clientY: py }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: px, clientY: py }));
  }
  await new Promise((r) => setTimeout(r, 500));
  const pk = wrap.querySelector('.img-pick');
  const pr = pk ? pk.getBoundingClientRect() : null;
  return {
    ok: true, picked: !!pk, sel: String(window.getSelection()).slice(0, 24),
    pickRect: pr ? [Math.round(pr.left), Math.round(pr.top), Math.round(pr.width), Math.round(pr.height)] : null
  };
};

/* 诊断：文本层 span 几何 / 重叠 / 选中矩形（用于排查选中高亮的错位与闪烁） */
window.__diagTextLayer = async function (pdfPath) {
  await IO.openPath(pdfPath);
  if (state.mode !== 'view') switchMode('view');
  const wrap = document.querySelector('.page-wrap[data-page="1"]');
  await waitForTextLayer(wrap);
  await new Promise((r) => setTimeout(r, 400));
  const wr = wrap.getBoundingClientRect();
  const spans = Array.from(wrap.querySelectorAll('.textLayer span')).filter((x) => (x.textContent || '').trim());
  const info = spans.map((sp, i) => {
    const b = sp.getBoundingClientRect();
    const cs = getComputedStyle(sp);
    return {
      i, t: (sp.textContent || '').slice(0, 14),
      x: +(b.left - wr.left).toFixed(1), y: +(b.top - wr.top).toFixed(1),
      w: +b.width.toFixed(1), h: +b.height.toFixed(1),
      fs: cs.fontSize, tf: cs.transform === 'none' ? '' : cs.transform,
      lh: cs.lineHeight, ov: cs.overflow, disp: cs.display
    };
  });
  // 重叠检测（面积交集）
  const overlaps = [];
  for (let a = 0; a < info.length; a++) {
    for (let b = a + 1; b < info.length; b++) {
      const A = info[a], B = info[b];
      const ix = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
      const iy = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y);
      if (ix > 1 && iy > 1) overlaps.push([A.i, B.i, +ix.toFixed(1), +iy.toFixed(1), A.t.slice(0, 6), B.t.slice(0, 6)]);
    }
  }
  // 同一行（y 中心相近）的高度差异
  const heightGroups = {};
  for (const s of info) {
    const key = Math.round((s.y + s.h / 2) / 4) * 4;
    (heightGroups[key] = heightGroups[key] || []).push(s);
  }
  const uneven = Object.entries(heightGroups)
    .map(([k, arr]) => [k, arr.length, Math.min(...arr.map((s) => s.h)), Math.max(...arr.map((s) => s.h))])
    .filter((g) => g[1] > 1 && g[3] - g[2] > 1.5);

  // 命中测试：在每个 span 自己的中心点取 caret，看命中的是不是它自己
  const hits = [];
  for (const sp of spans.slice(0, 60)) {
    const b = sp.getBoundingClientRect();
    const cx = Math.round(b.left + Math.min(b.width / 2, 6));
    const cy = Math.round(b.top + b.height / 2);
    const rg = document.caretRangeFromPoint ? document.caretRangeFromPoint(cx, cy) : null;
    const node = rg && rg.startContainer;
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    const same = !!(el && el.closest && el.closest('.textLayer span') === sp);
    if (!same) {
      const got = el && el.closest ? el.closest('.textLayer span') : null;
      const gb = got ? got.getBoundingClientRect() : null;
      hits.push({
        want: (sp.textContent || '').slice(0, 6), wantY: +b.top.toFixed(1),
        got: got ? (got.textContent || '').slice(0, 6) : String(node && node.nodeType),
        gotY: gb ? +gb.top.toFixed(1) : null
      });
    }
  }

  // 模拟一次跨行拖选，dump 选区矩形
  let rects = [];
  if (spans.length > 4) {
    const r = document.createRange();
    r.setStartBefore(spans[1]);
    r.setEndAfter(spans[Math.min(7, spans.length - 1)]);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(r);
    await new Promise((x) => setTimeout(x, 120));
    rects = Array.from(r.getClientRects()).map((b) => [
      Math.round(b.left - wr.left), Math.round(b.top - wr.top), Math.round(b.width), Math.round(b.height)
    ]);
  }
  return { ok: true, total: spans.length, info: info.slice(0, 24), overlaps: overlaps.slice(0, 20), uneven: uneven.slice(0, 10), rects, hitSamples: Math.min(60, spans.length), hitMismatch: hits.slice(0, 12) };
};

/* 截图用：浏览模式下选中若干行文字（展示选中高亮效果） */
window.__shotSel = async function (arg) {
  const [pdfPath, cntStr, zoomStr] = String(arg).split('|');
  const cnt = Number(cntStr) || 12;
  await IO.openPath(pdfPath);
  if (state.mode !== 'view') switchMode('view');
  const wrap = document.querySelector('.page-wrap[data-page="1"]');
  await waitForTextLayer(wrap);
  await new Promise((r) => setTimeout(r, 400));
  let spans = Array.from(wrap.querySelectorAll('.textLayer span')).filter((x) => (x.textContent || '').trim());
  if (spans.length > 2) {
    // 按视觉行（top 分组）取前 cnt 行，再从第一行首个字选到最后一行末个字
    const rows = [];
    for (const sp of spans) {
      const b = sp.getBoundingClientRect();
      const cy = Math.round((b.top + b.height / 2) / 6) * 6;
      let row = rows.find((r) => Math.abs(r.cy - cy) <= 6);
      if (!row) { row = { cy, items: [] }; rows.push(row); }
      row.items.push({ sp, x: b.left });
    }
    rows.sort((a, b) => a.cy - b.cy);
    for (const r of rows) r.items.sort((a, b) => a.x - b.x);
    const n = Math.max(1, Math.min(cnt, rows.length));
    const first = rows[0].items[0].sp;
    const lastRow = rows[n - 1].items;
    const last = lastRow[lastRow.length - 1].sp;
    const r = document.createRange();
    r.setStartBefore(first);
    r.setEndAfter(last);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(r);
  }
  // 可选：缩放后再截图 —— 验证缩放后高亮不残留、不错位
  const zoom = Number(zoomStr);
  if (zoom > 0) {
    const V = await import('./viewer.js');
    V.setZoom(zoom);
    await new Promise((r) => setTimeout(r, 1500));
    spans = Array.from(wrap.querySelectorAll('.textLayer span')).filter((x) => (x.textContent || '').trim());
  }
  await new Promise((r) => setTimeout(r, 500));
  const bars = Array.from(wrap.querySelectorAll('.sel-layer .sel-bar'))
    .filter((el) => el.style.display !== 'none')
    .map((el) => [Number(el.style.left.replace('px', '')), Number(el.style.top.replace('px', '')), Number(el.style.width.replace('px', '')), Number(el.style.height.replace('px', ''))]);
  const rng = window.getSelection().rangeCount ? window.getSelection().getRangeAt(0) : null;
  const rects = rng ? Array.from(rng.getClientRects()).filter((r) => r.width > 1 && r.height > 1).length : 0;
  return { ok: true, spans: spans.length, selLen: String(window.getSelection()).length, bars, rects, zoom: state.zoom };
};

/* 自检：浏览模式选中高亮（统一浅蓝、每行一条、不串行、可复制） */
window.__smokeSel = async function (pdfPath) {
  const log = [];
  const step = (n, ok, extra) => log.push([n, !!ok, extra === undefined ? '' : extra]);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const visDOM = () => Array.from(wrap.querySelectorAll('.sel-bar')).filter((el) => el.style.display !== 'none');
  const visBars = () => Array.from(wrap.querySelectorAll('.sel-bar'))
    .filter((el) => el.style.display !== 'none')
    .map((el) => ({
      x: parseFloat(el.style.left), y: parseFloat(el.style.top),
      w: parseFloat(el.style.width), h: parseFloat(el.style.height)
    }));
  let wrap = null;
  try {
    await IO.openPath(pdfPath);
    if (state.mode !== 'view') switchMode('view');
    wrap = document.querySelector('.page-wrap[data-page="1"]');
    await waitForTextLayer(wrap);
    await wait(400);
    const spans = Array.from(wrap.querySelectorAll('.textLayer span')).filter((x) => (x.textContent || '').trim());
    step('hasSpans', spans.length > 6, 'n=' + spans.length);
    if (spans.length < 7) return { ok: false, steps: log };

    // 文本层必须已按视觉顺序排列（否则拖选会跳行）
    {
      const wb = wrap.getBoundingClientRect();
      const keyed = spans.map((sp) => { const b = sp.getBoundingClientRect(); return { r: Math.round((b.top - wb.top) / 2), x: b.left }; });
      let inversions = 0;
      for (let k = 1; k < keyed.length; k++) {
        if (keyed[k].r < keyed[k - 1].r || (keyed[k].r === keyed[k - 1].r && keyed[k].x < keyed[k - 1].x - 0.5)) inversions++;
      }
      step('textLayerVisualOrder', inversions === 0, 'inversions=' + inversions);
    }

    // 按视觉行分组（自检自己的参照系）。缩放会重建文本层，故封装成函数可重复读取
    const readRows = () => {
      const ss = Array.from(wrap.querySelectorAll('.textLayer span')).filter((x) => (x.textContent || '').trim());
      const rws = [];
      for (const sp of ss) {
        const b = sp.getBoundingClientRect();
        const cy = Math.round((b.top + b.height / 2) / 6) * 6;
        let row = rws.find((r) => Math.abs(r.cy - cy) <= 6);
        if (!row) { row = { cy, items: [] }; rws.push(row); }
        row.items.push({ sp, x: b.left, right: b.right, h: b.height });
      }
      rws.sort((a, b) => a.cy - b.cy);
      for (const r of rws) r.items.sort((a, b) => a.x - b.x);
      return rws;
    };
    let rows = readRows();
    const want = Math.min(3, rows.length);
    step('rowsFound', rows.length >= want, 'rows=' + rows.length);

    const sel = window.getSelection();
    const selectFromTo = (fromSp, fromOff, toSp, toOff) => {
      const r = document.createRange();
      if (fromOff == null) r.setStartBefore(fromSp); else r.setStart(fromSp.firstChild || fromSp, fromOff);
      if (toOff == null) r.setEndAfter(toSp); else r.setEnd(toSp.firstChild || toSp, toOff);
      sel.removeAllRanges(); sel.addRange(r);
    };

    /* ---------- 整行选择（前 want 行） ---------- */
    selectFromTo(rows[0].items[0].sp, null, rows[want - 1].items[rows[want - 1].items.length - 1].sp, null);
    await wait(400);
    const wr = wrap.getBoundingClientRect();
    const bars = visBars();
    step('barsRendered', bars.length === want, `bars=${bars.length} want=${want}`);
    if (!bars.length) return { ok: false, steps: log };

    // ① 每行的条高与该行字高必须同一比例（原问题：中西文行盒不同 → 高低不齐）
    const ratios = bars.map((b, i) => {
      const src = (rows[i] ? rows[i].items : []).map((it) => it.h).sort((a, c) => a - c);
      const base = src[Math.floor(src.length / 2)] || b.h;
      return +(b.h / base).toFixed(3);
    });
    step('uniformInsetRatio', Math.max.apply(null, ratios) - Math.min.apply(null, ratios) < 0.03, JSON.stringify(ratios));
    // ② 左边界必须对齐
    const xs = bars.map((b) => b.x);
    step('alignedLeft', Math.max.apply(null, xs) - Math.min.apply(null, xs) < 1.5, JSON.stringify(xs));
    // ③ 一条视觉行只能有一条高亮（原问题：一行被切成多段 → 选中不全）
    const ys = bars.map((b) => Math.round(b.y));
    step('oneBarPerLine', new Set(ys).size === bars.length, JSON.stringify(ys));
    // ④ 条与条之间不能纵向重叠（原问题：色块串到上下行）
    let overlapped = 0;
    for (let i = 0; i < bars.length; i++) {
      for (let j = i + 1; j < bars.length; j++) {
        if (Math.min(bars[i].y + bars[i].h, bars[j].y + bars[j].h) - Math.max(bars[i].y, bars[j].y) > 0) overlapped++;
      }
    }
    step('noVerticalOverlap', overlapped === 0, 'pairs=' + overlapped);
    // ⑤ 条高必须小于行距（否则会盖到邻行）
    const pitches = [];
    for (let i = 1; i < rows.length; i++) pitches.push(rows[i].cy - rows[i - 1].cy);
    const minPitch = pitches.length ? Math.min.apply(null, pitches) : 0;
    const barHMax = Math.max.apply(null, bars.map((b) => b.h));
    step('thinnerThanLinePitch', minPitch > barHMax, `h=${barHMax} pitch=${minPitch}`);
    // ⑥ 左右必须覆盖整行
    const row0 = rows[0].items;
    const wantL = Math.min.apply(null, row0.map((it) => it.x)) - wr.left;
    const wantR = Math.max.apply(null, row0.map((it) => it.right)) - wr.left;
    step('coversWholeLine', bars[0].x <= wantL + 1.5 && bars[0].x + bars[0].w >= wantR - 3,
      `bar=${bars[0].x.toFixed(1)}..${(bars[0].x + bars[0].w).toFixed(1)} text=${wantL.toFixed(1)}..${wantR.toFixed(1)}`);

    /* ---------- 行内部分选择：只覆盖选中部分，不多不少 ---------- */
    {
      const it = rows[0].items[0];
      const node = it.sp.firstChild;
      const len = (it.sp.textContent || '').length;
      if (node && len > 4) {
        const i0 = Math.floor(len * 0.3);
        const i1 = Math.max(i0 + 1, Math.floor(len * 0.7));
        const r = document.createRange();
        r.setStart(node, i0);
        r.setEnd(node, i1);
        sel.removeAllRanges(); sel.addRange(r);
        await wait(400);
        const pb = visBars();
        const spanW = it.right - it.x;
        const expX = it.x - wr.left + (i0 / len) * spanW;
        const expW = ((i1 - i0) / len) * spanW;
        step('partialOneBar', pb.length === 1, 'n=' + pb.length);
        step('partialStartsAtChar', pb.length === 1 && Math.abs(pb[0].x - expX) < 8,
          `bar=${pb[0] && pb[0].x} exp=${expX.toFixed(1)}`);
        step('partialWidthMatches', pb.length === 1 && Math.abs(pb[0].w - expW) < 8,
          `w=${pb[0] && pb[0].w} exp=${expW.toFixed(1)}`);
      }
    }

    /* ---------- 一行多个 span（中文前缀 + 网址）：必须合成一条，不能断成几截 ---------- */
    {
      const rw = rows[1];
      if (rw && rw.items.length > 1) {
        selectFromTo(rw.items[0].sp, null, rw.items[rw.items.length - 1].sp, null);
        await wait(400);
        const pb2 = visBars();
        const spanCount = rw.items.length;
        step('multiSpanOneBar', pb2.length === 1, `spans=${spanCount} bars=${pb2.length}`);
      }
    }

    /* ---------- 缩放：不能留下错位高亮，且选区要按新尺寸正确还原 ---------- */
    {
      const V = await import('./viewer.js');
      const zBefore = visBars();
      const z0 = state.zoom;
      V.setZoom(z0 * 1.3);
      await wait(120);
      const during = visBars();
      const tl0 = wrap.querySelector('.textLayer');
      const tb0 = tl0 ? tl0.getBoundingClientRect() : null;
      const outDuring = tb0 ? during.filter((el) => {
        const x = el.x + wrap.getBoundingClientRect().left, y = el.y + wrap.getBoundingClientRect().top;
        return x + el.w > tb0.right + 4 || x < tb0.left - 4 || y < tb0.top - 4 || y + el.h > tb0.bottom + 4;
      }).length : 0;
      step('zoomNoStaleBars', during.length === 0 || outDuring === 0, `n=${during.length} outside=${outDuring}`);

      await wait(1800);
      const after = visBars();
      const wrz = wrap.getBoundingClientRect();
      const tl1 = wrap.querySelector('.textLayer');
      const tb1 = tl1 ? tl1.getBoundingClientRect() : null;
      const outAfter = tb1 ? after.filter((el) => {
        const x = el.x + wrz.left, y = el.y + wrz.top;
        return x + el.w > tb1.right + 4 || x < tb1.left - 4 || y < tb1.top - 4 || y + el.h > tb1.bottom + 4;
      }).length : 0;
      step('zoomKeepsSelection', after.length === zBefore.length && after.length > 0,
        `before=${zBefore.length}${JSON.stringify(zBefore.map((b) => [b.x, b.y, b.w, b.h]))} after=${after.length}${JSON.stringify(after.map((b) => [b.x, b.y, b.w, b.h]))}`);
      step('zoomBarsRepositioned', outAfter === 0, `n=${after.length} outside=${outAfter}`);
      const scale = state.zoom / z0;
      step('zoomBarsScaled', !!after.length && !!zBefore.length && Math.abs(after[0].h / zBefore[0].h - scale) < 0.12,
        `h=${after[0] && after[0].h}/${zBefore[0] && zBefore[0].h} scale=${scale.toFixed(3)}`);

      V.setZoom(z0);
      await wait(1800);
      rows = readRows();          // 缩放会重建文本层，参照系必须重新读取
    }

    /* ---------- 复制仍可用（回读系统剪贴板） ---------- */
    selectFromTo(rows[0].items[0].sp, null, rows[0].items[rows[0].items.length - 1].sp, null);
    await wait(300);
    document.execCommand('copy');
    await wait(300);
    const cb = await window.pdfmini.clipboard.read();
    const txt = (cb && cb.text) || '';
    step('copyStillWorks', txt.length > 5, JSON.stringify(txt.slice(0, 20)));

    // ⑦ 原生 ::selection 必须是透明的（否则和自绘高亮叠加变深）
    let selBg = '';
    for (const ss of Array.from(document.styleSheets)) {
      let rules = [];
      try { rules = Array.from(ss.cssRules || []); } catch (e) { continue; }
      for (const r of rules) {
        if (r.selectorText && r.selectorText.indexOf('::selection') >= 0 && r.style && r.style.backgroundColor) selBg = r.style.backgroundColor;
      }
    }
    step('nativeSelectionTransparent', /transparent|rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(selBg), 'ruleBG=' + selBg);

    // ⑧ 切到编辑模式后高亮必须消失
    switchMode('edit');
    await wait(300);
    step('hiddenInEditMode', visBars().length === 0,
      'vis=' + visBars().length + ' detail=' + JSON.stringify(visDOM().map((el) => [el.style.left, el.style.top, el.parentElement && el.parentElement.className])));

    return { ok: log.every((l) => l[1]), steps: log };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e), steps: log };
  }
};

document.addEventListener('DOMContentLoaded', boot);
window.__setMode = (m) => switchMode(m);
window.__setLocale = (l) => applyLocale(l, false);
void scrollRatio;

void field;
