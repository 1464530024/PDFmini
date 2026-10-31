'use strict';

const {
  app, BrowserWindow, ipcMain, dialog, protocol, net, shell, Menu, clipboard, nativeImage
} = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { pathToFileURL } = require('url');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const isDev = process.argv.includes('--dev');

/* ------------------------------------------------------------------ *
 * 自定义 app:// 协议：让渲染进程拥有同源环境（file:// 下 Worker 会被拦截）
 * ------------------------------------------------------------------ */
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);

/* ------------------------------------------------------------------ *
 * 简易持久化存储
 * ------------------------------------------------------------------ */
function storeFile(name) {
  return path.join(app.getPath('userData'), name);
}
function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}
function writeJSON(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
  } catch (e) { /* ignore */ }
}

const DEFAULT_SETTINGS = {
  lang: null,
  textRepair: true,
  theme: 'light',
  viewMode: 'continuous',
  zoomMode: 'fit-width',
  showSidebar: true,
  sidebarTab: 'thumbnails',
  highlightColor: '#ffd400',
  inkColor: '#e4002b'
};

/** 安装包在选择语言时会把语言写进安装目录下的 lang.txt，首次启动用它作为默认语言 */
function installerLang() {
  try {
    const file = path.join(path.dirname(app.getPath('exe')), 'lang.txt');
    const v = String(fs.readFileSync(file, 'utf8') || '').trim();
    if (/^en/i.test(v)) return 'en-US';
    if (/^zh/i.test(v)) return 'zh-CN';
  } catch (e) { /* 未安装或不存在 */ }
  return null;
}

function getSettings() {
  const s = Object.assign({}, DEFAULT_SETTINGS, readJSON(storeFile('settings.json'), {}));
  if (!s.lang) s.lang = installerLang();
  return s;
}
function getRecent() {
  return readJSON(storeFile('recent.json'), []);
}

/* ------------------------------------------------------------------ *
 * 主窗口
 * ------------------------------------------------------------------ */
let mainWindow = null;
let allowClose = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 620,
    show: false,
    frame: false,
    backgroundColor: '#ffffff',
    title: 'PDFmini',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('maximize', () => mainWindow.webContents.send('window:state', { maximized: true }));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:state', { maximized: false }));
  mainWindow.on('closed', () => { mainWindow = null; });

  // 关闭窗口前先询问渲染进程（有未保存文档时确认）
  mainWindow.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    mainWindow.webContents.send('window:close-request');
  });

  mainWindow.loadURL('app://local/index.html');
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // 开发/自检模式下把渲染进程日志转发到 stdout
  if (isDev || process.argv.includes('--smoke')) {
    mainWindow.webContents.on('console-message', (e, level, message, line, source) => {
      console.log(`[renderer] ${message}` + (source ? ` (${source}:${line})` : ''));
    });
  }

  if (process.argv.includes('--smoke')) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        await new Promise((r) => setTimeout(r, 1200));
        // 截图/自检前先按需切换语言（保证界面文案与后续操作的语言一致）
        if (process.argv.includes('--shot-en')) {
          await mainWindow.webContents.executeJavaScript("window.__setLocale && window.__setLocale('en-US')");
          await new Promise((r) => setTimeout(r, 400));
        }
        const shotOnly = process.argv.includes('--shot-only');
        if (!shotOnly) {
        const fileArg = (process.argv.find((a) => a.startsWith('--smoke-file=')) || '').slice('--smoke-file='.length);
        const formArg = (process.argv.find((a) => a.startsWith('--smoke-form=')) || '').slice('--smoke-form='.length);
        const dropArg = (process.argv.find((a) => a.startsWith('--smoke-drop=')) || '').slice('--smoke-drop='.length);
        const linkArg = (process.argv.find((a) => a.startsWith('--smoke-link=')) || '').slice('--smoke-link='.length);
        const nativeArg = (process.argv.find((a) => a.startsWith('--smoke-native=')) || '').slice('--smoke-native='.length);
        const probeArg = (process.argv.find((a) => a.startsWith('--probe=')) || '').slice('--probe='.length);
        const shotTextArg = (process.argv.find((a) => a.startsWith('--shot-textedit=')) || '').slice('--shot-textedit='.length);
        const shotTextDoneArg = (process.argv.find((a) => a.startsWith('--shot-textdone=')) || '').slice('--shot-textdone='.length);
        const shotBlocksArg = (process.argv.find((a) => a.startsWith('--shot-blocks=')) || '').slice('--shot-blocks='.length);
        const insertArg = (process.argv.find((a) => a.startsWith('--smoke-insert=')) || '').slice('--smoke-insert='.length);
        const docxArg = (process.argv.find((a) => a.startsWith('--smoke-docx=')) || '').slice('--smoke-docx='.length);
        const shotImgArg = (process.argv.find((a) => a.startsWith('--shot-image=')) || '').slice('--shot-image='.length);
        const shotPageArg = (process.argv.find((a) => a.startsWith('--shot-page=')) || '').slice('--shot-page='.length);
        const cropArg = (process.argv.find((a) => a.startsWith('--crop=')) || '').slice('--crop='.length);
        const eraseArg = (process.argv.find((a) => a.startsWith('--smoke-erase=')) || '').slice('--smoke-erase='.length);
        const diagArg = (process.argv.find((a) => a.startsWith('--diag=')) || '').slice('--diag='.length);
        const imgDelArg = (process.argv.find((a) => a.startsWith('--smoke-imgdel=')) || '').slice('--smoke-imgdel='.length);
        const smartArg = (process.argv.find((a) => a.startsWith('--smoke-smart=')) || '').slice('--smoke-smart='.length);
        const marqueeArg = (process.argv.find((a) => a.startsWith('--smoke-marquee=')) || '').slice('--smoke-marquee='.length);
        const vectorArg = (process.argv.find((a) => a.startsWith('--smoke-vector=')) || '').slice('--smoke-vector='.length);
        const viewCopyArg = (process.argv.find((a) => a.startsWith('--smoke-viewcopy=')) || '').slice('--smoke-viewcopy='.length);
        const noWrapArg = (process.argv.find((a) => a.startsWith('--smoke-nowrap=')) || '').slice('--smoke-nowrap='.length);
        const viewPickShotArg = (process.argv.find((a) => a.startsWith('--shot-viewpick=')) || '').slice('--shot-viewpick='.length);
        const diagTLArg = (process.argv.find((a) => a.startsWith('--diag-textlayer=')) || '').slice('--diag-textlayer='.length);
        const shotSelArg = (process.argv.find((a) => a.startsWith('--shot-sel=')) || '').slice('--shot-sel='.length);
        const smokeSelArg = (process.argv.find((a) => a.startsWith('--smoke-sel=')) || '').slice('--smoke-sel='.length);
        const runSuitesArg = (process.argv.find((a) => a.startsWith('--smoke-run=')) || '').slice('--smoke-run='.length);
        const insBarArg = (process.argv.find((a) => a.startsWith('--shot-insertbar=')) || '').slice('--shot-insertbar='.length);
        const marqueeShotArg = (process.argv.find((a) => a.startsWith('--shot-marquee=')) || '').slice('--shot-marquee='.length);
        const script = runSuitesArg
          ? `window.__runSuites(${JSON.stringify(runSuitesArg)})`
          : smokeSelArg
          ? `window.__smokeSel(${JSON.stringify(smokeSelArg)})`
          : shotSelArg
          ? `window.__shotSel(${JSON.stringify(shotSelArg)})`
          : diagTLArg
          ? `window.__diagTextLayer(${JSON.stringify(diagTLArg)})`
          : viewPickShotArg
          ? `window.__shotViewPick(${JSON.stringify(viewPickShotArg)})`
          : noWrapArg
          ? `window.__smokeNoWrap(${JSON.stringify(noWrapArg)})`
          : viewCopyArg
          ? `window.__smokeViewCopy(${JSON.stringify(viewCopyArg)})`
          : vectorArg
          ? `window.__smokeVectorErase(${JSON.stringify(vectorArg)})`
          : marqueeShotArg
          ? `window.__shotMarquee(${JSON.stringify(marqueeShotArg)})`
          : insBarArg
          ? `window.__shotInsertBar(${JSON.stringify(insBarArg)})`
          : marqueeArg
          ? `window.__smokeMarquee(${JSON.stringify(marqueeArg)})`
          : smartArg
          ? `window.__smokeSmart(${JSON.stringify(smartArg)})`
          : imgDelArg
          ? `window.__smokeImgDel(${JSON.stringify(imgDelArg)})`
          : diagArg
          ? `window.__diagOps(${JSON.stringify(diagArg)})`
          : eraseArg
          ? `window.__smokeErase(${JSON.stringify(eraseArg)})`
          : cropArg
          ? `window.__canvasCrop(${JSON.stringify(cropArg)})`
          : shotPageArg
          ? `window.__shotPage(${JSON.stringify(shotPageArg)})`
          : shotImgArg
          ? `window.__shotImageEdit(${JSON.stringify(shotImgArg)})`
          : docxArg
          ? `window.__smokeDocx(${JSON.stringify(docxArg)})`
          : insertArg
          ? `window.__smokeInsert(${JSON.stringify(insertArg)})`
          : shotBlocksArg
          ? `window.__shotBlocks(${JSON.stringify(shotBlocksArg)})`
          : shotTextDoneArg
          ? `window.__shotTextEdit(${JSON.stringify(shotTextDoneArg)}, true)`
          : shotTextArg
          ? `window.__shotTextEdit(${JSON.stringify(shotTextArg)})`
          : nativeArg
          ? `window.__smokeNative(${JSON.stringify(nativeArg)})`
          : probeArg
          ? `window.__probe(${JSON.stringify(probeArg)})`
          : (linkArg
            ? `window.__smokeLink(${JSON.stringify(linkArg)})`
            : (dropArg
              ? `window.__smokeDrop(${JSON.stringify(dropArg)})`
              : (formArg
                ? `window.__smokeForm(${JSON.stringify(formArg)})`
                : (fileArg ? `window.__smokeOpen(${JSON.stringify(fileArg)})` : 'window.__smokeTest && window.__smokeTest()'))));
          const result = await mainWindow.webContents.executeJavaScript(script);
          console.log('SMOKE_RESULT ' + JSON.stringify(result));
        }
        const shotArg = (process.argv.find((a) => a.startsWith('--shot=')) || '').slice('--shot='.length);
        if (shotArg) {
          if (process.argv.includes('--shot-edit')) {
            await mainWindow.webContents.executeJavaScript("window.__setMode && window.__setMode('edit')");
          }
          if (process.argv.includes('--shot-en')) {
            await mainWindow.webContents.executeJavaScript("window.__setLocale && window.__setLocale('en-US')");
          }
          await new Promise((r) => setTimeout(r, 900));
          const img = await mainWindow.webContents.capturePage();
          await fsp.writeFile(shotArg, img.toPNG());
          console.log('SHOT_SAVED ' + shotArg);
        }
      } catch (err) {
        console.log('SMOKE_ERROR ' + (err && err.message || err));
      } finally {
        // 自检模式下强制退出，避免被「未保存确认」拦截导致进程挂住
        allowClose = true;
        setTimeout(() => {
          try { if (mainWindow) mainWindow.destroy(); } catch (e) { /* ignore */ }
          app.exit(0);
        }, 400);
      }
    });
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* ------------------------------------------------------------------ *
 * 命令行传入的 PDF（双击关联文件）
 * ------------------------------------------------------------------ */
function fileFromArgv(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  const hit = args.find((a) => /\.pdf$/i.test(a) && fs.existsSync(a));
  return hit ? path.resolve(hit) : null;
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */
function registerIPC() {
  // 窗口控制
  ipcMain.handle('window:minimize', () => mainWindow && mainWindow.minimize());
  ipcMain.handle('window:toggleMaximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('window:close', () => mainWindow && mainWindow.close());
  ipcMain.handle('window:forceClose', () => { allowClose = true; if (mainWindow) mainWindow.close(); });
  ipcMain.handle('window:isMaximized', () => (mainWindow ? mainWindow.isMaximized() : false));

  // 设置
  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:set', (e, patch) => {
    const next = Object.assign(getSettings(), patch || {});
    writeJSON(storeFile('settings.json'), next);
    return next;
  });

  // 最近文件
  ipcMain.handle('recent:list', () => getRecent().filter((f) => fs.existsSync(f.path)).slice(0, 20));
  ipcMain.handle('recent:add', (e, info) => {
    const list = getRecent().filter((f) => f.path !== info.path);
    list.unshift({ path: info.path, name: info.name, time: Date.now() });
    writeJSON(storeFile('recent.json'), list.slice(0, 20));
    return true;
  });
  ipcMain.handle('recent:clear', () => { writeJSON(storeFile('recent.json'), []); return true; });

  // 打开文件
  ipcMain.handle('file:pick', async (e, opts = {}) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: opts.title || '打开 PDF',
      filters: opts.filters || [{ name: 'PDF 文档', extensions: ['pdf'] }],
      properties: opts.multi ? ['openFile', 'multiSelections'] : ['openFile']
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    return { ok: true, paths: res.filePaths };
  });

  ipcMain.handle('file:read', async (e, filePath) => {
    try {
      const buf = await fsp.readFile(filePath);
      const st = await fsp.stat(filePath);
      return { ok: true, path: filePath, name: path.basename(filePath), data: buf, size: st.size, mtime: st.mtimeMs };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('file:exists', (e, filePath) => fs.existsSync(filePath));

  ipcMain.handle('file:save', async (e, { data, defaultPath, filters }) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '保存 PDF',
      defaultPath: defaultPath || '未命名.pdf',
      filters: filters || [{ name: 'PDF 文档', extensions: ['pdf'] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    try {
      await fsp.writeFile(res.filePath, Buffer.from(data));
      return { ok: true, path: res.filePath, name: path.basename(res.filePath) };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  // 覆盖写回原文件
  ipcMain.handle('file:writeInPlace', async (e, { path: filePath, data }) => {
    try {
      await fsp.writeFile(filePath, Buffer.from(data));
      return { ok: true, path: filePath, name: path.basename(filePath) };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  // 读取系统字体（用于在 PDF 中写入中文文本，避免打包体积膨胀）
  // 支持按「字体 id」取指定中文字体：hei 黑体 / kai 楷体 / fang 仿宋 / song 宋体 / yahei 雅黑
  const FONT_FILES = {
    hei: ['simhei.ttf'],
    kai: ['simkai.ttf'],
    fang: ['simfang.ttf'],
    song: ['simsun.ttf', 'simsunb.ttf'],
    yahei: ['msyh.ttf', 'msyh.ttc'],
    deng: ['Deng.ttf']
  };
  const DEFAULT_FONTS = ['simhei.ttf', 'msyh.ttc', 'simkai.ttf', 'simfang.ttf', 'simsun.ttc', 'Deng.ttf'];
  ipcMain.handle('font:systemCJK', async (e, opt) => {
    const winDir = process.env.WINDIR || 'C:\\Windows';
    const wantId = opt && opt.id;
    let candidates = DEFAULT_FONTS;
    if (wantId) {
      const exact = FONT_FILES[wantId] || [];
      // 精确命中优先，其次退回到内置默认字体表，保证任何 id 都能拿到可用的中文字体
      candidates = exact.concat(DEFAULT_FONTS);
    }
    for (const name of candidates) {
      const p = path.join(winDir, 'Fonts', name);
      try {
        const buf = await fsp.readFile(p);
        if (buf.length > 1000) {
          // 只支持单一 TTF/OTF（.ttc 字体集合 pdf-lib 无法直接嵌入）
          if (/\.ttc$/i.test(name)) continue;
          return { ok: true, id: wantId || null, name, data: buf };
        }
      } catch (err) { /* next */ }
    }
    return { ok: false };
  });

  // 复制图片到系统剪贴板（用 Electron 原生 clipboard，避免浏览器 clipboard 的权限/激活限制）
  ipcMain.handle('clipboard:writeImage', async (e, { dataUrl }) => {
    try {
      const img = nativeImage.createFromDataURL(String(dataUrl || ''));
      if (img.isEmpty()) return { ok: false, error: 'empty image' };
      clipboard.writeImage(img);
      const size = img.getSize();
      return { ok: true, width: size.width, height: size.height };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  // 读取剪贴板（自检 / 诊断用）
  ipcMain.handle('clipboard:read', async () => {
    try {
      const img = clipboard.readImage();
      const size = img.isEmpty() ? { width: 0, height: 0 } : img.getSize();
      return { text: clipboard.readText() || '', hasImage: !img.isEmpty(), width: size.width, height: size.height };
    } catch (err) {
      return { text: '', hasImage: false, width: 0, height: 0 };
    }
  });

  // 复制文本到系统剪贴板
  ipcMain.handle('clipboard:writeText', async (e, text) => {
    try { clipboard.writeText(String(text == null ? '' : text)); return { ok: true }; }
    catch (err) { return { ok: false, error: String(err && err.message || err) }; }
  });

  // 导出图片：把临时 PNG 存到用户选择的位置
  ipcMain.handle('file:saveImage', async (e, { dataUrl, defaultName }) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '导出图片',
      defaultPath: defaultName || 'export.png',
      filters: [{ name: 'PNG 图片', extensions: ['png'] }, { name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    try {
      const base64 = String(dataUrl).replace(/^data:image\/\w+;base64,/, '');
      await fsp.writeFile(res.filePath, Buffer.from(base64, 'base64'));
      return { ok: true, path: res.filePath };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  // 导出纯文本
  ipcMain.handle('file:saveText', async (e, { text, defaultName }) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '导出文本',
      defaultPath: defaultName || 'export.txt',
      filters: [{ name: '文本文件', extensions: ['txt'] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    try {
      await fsp.writeFile(res.filePath, text, 'utf8');
      return { ok: true, path: res.filePath };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('shell:reveal', (e, filePath) => { shell.showItemInFolder(filePath); });
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    name: app.getName(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    arch: process.arch
  }));
  ipcMain.handle('app:openExternal', (e, url) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
  });
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (ev, argv) => {
    const f = fileFromArgv(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (f) mainWindow.webContents.send('file:openPath', f);
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    protocol.handle('app', async (request) => {
      const url = new URL(request.url);
      let rel = decodeURIComponent(url.pathname);
      if (!rel || rel === '/') rel = '/index.html';
      const filePath = path.normalize(path.join(RENDERER_DIR, rel));
      if (!filePath.startsWith(RENDERER_DIR)) {
        return new Response('Forbidden', { status: 403 });
      }
      const res = await net.fetch(pathToFileURL(filePath).toString());
      // 文本类资源显式声明 UTF-8：打包后的 bundle.js 内含中文字面量（不再转 \uXXXX 以减小体积），
      // 必须保证按 UTF-8 解码，否则中文会乱码
      if (/\.(?:js|mjs|css|html|json|txt|svg)$/i.test(filePath)) {
        const headers = new Headers(res.headers);
        const ct = headers.get('content-type');
        if (ct && !/charset/i.test(ct)) headers.set('content-type', ct + '; charset=utf-8');
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
      }
      return res;
    });
    registerIPC();
    createWindow();
    const f = fileFromArgv(process.argv);
    if (f) {
      mainWindow.webContents.once('did-finish-load', () => {
        mainWindow.webContents.send('file:openPath', f);
      });
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
