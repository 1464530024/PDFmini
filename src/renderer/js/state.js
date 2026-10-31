// 全局状态（当前活动文档的实时视图）
export const state = {
  filePath: null,
  fileName: '未命名.pdf',
  originalBytes: null,     // 打开时的原始字节（用于还原）
  workBytes: null,         // 当前工作字节（页面操作后）
  pdfDoc: null,            // pdf.js 文档对象
  numPages: 0,
  pageInfo: [],            // { [page]: { view, rotate, ref } }
  defaultSize: null,       // { view, rotate } 占位尺寸
  zoom: 1,
  zoomMode: 'fit-width',   // fit-width | fit-page | custom
  viewMode: 'continuous',
  rotation: 0,             // 视图旋转 0/90/180/270（仅查看）
  currentPage: 1,
  annotations: {},         // { [page]: [anno] }
  dirty: false,
  mode: 'view',            // view | edit
  tool: null,              // 当前编辑工具
  toolOptions: {
    color: '#ffd400',
    textColor: '#e4002b',
    strokeWidth: 2,
    fontSize: 14,
    opacity: 0.42,
    shape: 'rect',
    font: 'hei',            // 插入文字默认字体：hei 黑体 / kai 楷体 / fang 仿宋 / mono 等宽
    fontColor: '#14161a'    // 插入文字默认颜色
  },
  undo: [],
  redo: [],
  renderedPages: new Set(),
  observer: null,
  searchQuery: '',
  searchHits: [],
  searchIndex: -1,
  busy: false,
  textRepair: true      // 是否对画不出来的字形做补画
};

/* 脏标记变化钩子（由 tabs.js 注册，用于同步到标签页） */
let dirtyHook = null;
export function onDirtyChange(fn) { dirtyHook = fn; }

export function setDirty(v) {
  state.dirty = !!v;
  const dot = document.getElementById('tb-dirty');
  if (dot) dot.classList.toggle('on', state.dirty);
  if (dirtyHook) dirtyHook(state.dirty);
}

export function cloneBytes(u8) {
  return u8.slice(0);
}

/** 关闭全部文档后重置运行时状态 */
export function resetDocumentState() {
  state.pdfDoc = null;
  state.numPages = 0;
  state.pageInfo = [];
  state.defaultSize = null;
  state.annotations = {};
  state.undo = [];
  state.redo = [];
  state.renderedPages = new Set();
  state.currentPage = 1;
  state.rotation = 0;
  state.searchQuery = '';
  state.searchHits = [];
  state.searchIndex = -1;
  state.tool = null;
}

