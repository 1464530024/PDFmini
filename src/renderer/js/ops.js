// 页面操作与高级编辑（基于 pdf-lib）
import {
  PDFDocument, rgb, degrees, StandardFonts,
  PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFOptionList
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { state, setDirty } from './state.js';
import { applyAnnotations, loadSystemCjk, dataUrlToBytes, hasNonLatin } from './flatten.js';
import * as viewer from './viewer.js';
import * as Tabs from './tabs.js';
import { toast, withLoading } from './ui.js';
import { t } from './i18n.js';

/* ---------------- 基础工具 ---------------- */
export async function loadWorking() {
  return PDFDocument.load(state.workBytes, { ignoreEncryption: true });
}

/** 把当前批注烘焙进工作字节，返回新字节 */
export async function bakeBytes(withAnnotations = true) {
  const doc = await loadWorking();
  if (withAnnotations) await applyAnnotations(doc, state.annotations);
  return doc.save();
}

/** 应用一个变更函数，然后重新加载文档 */
export async function applyChange(mutator, message) {
  return withLoading(message || t('处理中…'), async () => {
    const doc = await loadWorking();
    await applyAnnotations(doc, state.annotations);
    const result = await mutator(doc);
    const bytes = await doc.save();
    await Tabs.replaceActiveBytes(bytes, { dirty: true });
    return result;
  });
}

async function embedTextFont(pdfDoc, needCjk) {
  if (needCjk) {
    const bytes = await loadSystemCjk();
    if (bytes) {
      try {
        pdfDoc.registerFontkit(fontkit);
        return await pdfDoc.embedFont(bytes, { subset: true });
      } catch (e) { /* fallback */ }
    }
  }
  return pdfDoc.embedFont(StandardFonts.Helvetica);
}

function toRgb(hex) {
  const h = String(hex || '#000000').replace('#', '');
  return rgb(
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255
  );
}

/* ---------------- 页面操作 ---------------- */
export async function deletePages(list) {
  if (!list.length) return;
  if (list.length >= state.numPages) return toast(t('不能删除全部页面'), 'err');
  await applyChange((doc) => {
    const sorted = [...list].sort((a, b) => b - a);
    for (const p of sorted) doc.removePage(p - 1);
  }, t('正在删除页面…'));
  toast(t('已删除 {n} 页', { n: list.length }), 'ok');
}

export async function rotatePages(list, delta) {
  if (!list.length) return;
  await applyChange((doc) => {
    const pages = doc.getPages();
    for (const p of list) {
      const page = pages[p - 1];
      if (!page) continue;
      const cur = page.getRotation().angle || 0;
      page.setRotation(degrees(((cur + delta) % 360 + 360) % 360));
    }
  }, t('正在旋转页面…'));
}

export async function reorderPages(order) {
  await applyChange(async (doc) => {
    const copy = await doc.copyPages(doc, order.map((i) => i - 1));
    for (let i = doc.getPageCount() - 1; i >= 0; i--) doc.removePage(i);
    copy.forEach((p) => doc.addPage(p));
  }, t('正在重排页面…'));
}

export async function insertBlankPage(afterIndex, width, height) {
  await applyChange((doc) => {
    const pages = doc.getPages();
    const base = pages[Math.min(afterIndex - 1, pages.length - 1)];
    const size = base ? base.getSize() : { width: 595.28, height: 841.89 };
    doc.insertPage(afterIndex, [width || size.width, height || size.height]);
  }, t('正在插入页面…'));
}

export async function insertImagePage(dataUrl, afterIndex) {
  await applyChange(async (doc) => {
    const bytes = dataUrlToBytes(dataUrl);
    let img;
    try { img = await doc.embedPng(bytes); } catch (e) { img = await doc.embedJpg(bytes); }
    const page = doc.insertPage(afterIndex, [img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }, t('正在插入图片页…'));
}

export async function insertPdfPages(filePath, afterIndex) {
  const r = await window.pdfmini.file.read(filePath);
  if (!r.ok) return toast(t('读取失败：') + r.error, 'err');
  await applyChange(async (doc) => {
    const src = await PDFDocument.load(r.data, { ignoreEncryption: true });
    const copied = await doc.copyPages(src, src.getPageIndices());
    let at = afterIndex;
    for (const p of copied) { doc.insertPage(at, p); at++; }
  }, t('正在插入 PDF…'));
}

export async function mergeFiles(paths) {
  return withLoading(t('正在合并…'), async () => {
    const baseDoc = await loadWorking();
    await applyAnnotations(baseDoc, state.annotations);
    for (const p of paths) {
      const r = await window.pdfmini.file.read(p);
      if (!r.ok) { toast(t('读取失败：') + r.error, 'err'); continue; }
      const src = await PDFDocument.load(r.data, { ignoreEncryption: true });
      const copied = await baseDoc.copyPages(src, src.getPageIndices());
      copied.forEach((pg) => baseDoc.addPage(pg));
    }
    const bytes = await baseDoc.save();
    await Tabs.replaceActiveBytes(bytes, { dirty: true });
    toast(t('合并完成'), 'ok');
  });
}

export async function extractPages(list, asSeparate = false) {
  if (!list.length) return;
  return withLoading(t('正在提取…'), async () => {
    const src = await loadWorking();
    await applyAnnotations(src, state.annotations);
    const baseName = (state.fileName || 'document.pdf').replace(/\.pdf$/i, '');
    if (asSeparate) {
      for (const p of list) {
        const one = await PDFDocument.create();
        const [cp] = await one.copyPages(src, [p - 1]);
        one.addPage(cp);
        const bytes = await one.save();
        const r = await window.pdfmini.file.save({
          data: bytes,
          defaultPath: `${baseName}-第${p}页.pdf`,
          filters: [{ name: 'PDF 文档', extensions: ['pdf'] }]
        });
        if (r.canceled) break;
      }
    } else {
      const out = await PDFDocument.create();
      const copied = await out.copyPages(src, list.map((p) => p - 1));
      copied.forEach((pg) => out.addPage(pg));
      const bytes = await out.save();
      const r = await window.pdfmini.file.save({
        data: bytes,
        defaultPath: `${baseName}-提取.pdf`,
        filters: [{ name: 'PDF 文档', extensions: ['pdf'] }]
      });
      if (!r.ok) return;
    }
    toast(t('提取完成'), 'ok');
  });
}

export async function splitPdf(mode, value) {
  return withLoading(t('正在拆分…'), async () => {
    const src = await loadWorking();
    await applyAnnotations(src, state.annotations);
    const total = src.getPageCount();
    const baseName = (state.fileName || 'document.pdf').replace(/\.pdf$/i, '');
    const ranges = [];
    if (mode === 'every') {
      const n = Math.max(1, value | 0);
      for (let s = 1; s <= total; s += n) ranges.push([s, Math.min(total, s + n - 1)]);
    } else {
      const parts = String(value).split(',').map((s) => s.trim()).filter(Boolean);
      for (const part of parts) {
        const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
        if (m) ranges.push([+m[1], +m[2]]);
        else if (/^\d+$/.test(part)) ranges.push([+part, +part]);
      }
    }
    if (!ranges.length) { toast(t('拆分范围无效'), 'err'); return; }
    for (let i = 0; i < ranges.length; i++) {
      const [a, b] = ranges[i];
      const idx = [];
      for (let p = a; p <= b; p++) if (p >= 1 && p <= total) idx.push(p - 1);
      if (!idx.length) continue;
      const out = await PDFDocument.create();
      const copied = await out.copyPages(src, idx);
      copied.forEach((pg) => out.addPage(pg));
      const bytes = await out.save();
      const r = await window.pdfmini.file.save({
        data: bytes,
        defaultPath: `${baseName}-${a}-${b}.pdf`,
        filters: [{ name: 'PDF 文档', extensions: ['pdf'] }]
      });
      if (r.canceled) break;
    }
    toast(t('拆分完成'), 'ok');
  });
}

export async function cropPages(list, margins, unit) {
  // margins: {top,bottom,left,right} 单位由 unit 决定（mm/pt）
  const k = unit === 'mm' ? 2.834645669 : 1;
  await applyChange((doc) => {
    const pages = doc.getPages();
    for (const p of list) {
      const page = pages[p - 1];
      if (!page) continue;
      const box = page.getCropBox();
      const x = box.x + (margins.left || 0) * k;
      const y = box.y + (margins.bottom || 0) * k;
      const w = Math.max(10, box.width - ((margins.left || 0) + (margins.right || 0)) * k);
      const h = Math.max(10, box.height - ((margins.top || 0) + (margins.bottom || 0)) * k);
      page.setCropBox(x, y, w, h);
      page.setMediaBox(box.x, box.y, box.width, box.height);
    }
  }, t('正在裁剪…'));
}

/* ---------------- 水印 ---------------- */
export async function addWatermark(opts) {
  await applyChange(async (doc) => {
    const pages = doc.getPages();
    const needCjk = hasNonLatin(opts.text);
    const font = await embedTextFont(doc, needCjk);
    for (const page of pages) {
      const { width, height } = page.getSize();
      const size = opts.size || Math.min(width, height) / 8;
      const text = opts.text || 'PDFmini';
      const tw = safeWidth(font, text, size);
      const x = (width - tw) / 2;
      const y = height / 2 - size * 0.35;
      if (opts.diagonal) {
        page.drawText(text, {
          x: width * 0.08, y: height * 0.12, size, font,
          color: toRgb(opts.color), opacity: opts.opacity,
          rotate: degrees(30)
        });
      } else {
        page.drawText(text, { x, y, size, font, color: toRgb(opts.color), opacity: opts.opacity });
      }
    }
  }, t('正在添加水印…'));
}

/* ---------------- 页眉页脚 / 页码 ---------------- */
export async function addHeaderFooter(opts) {
  await applyChange(async (doc) => {
    const pages = doc.getPages();
    const needCjk = hasNonLatin((opts.header || '') + (opts.footer || ''));
    const font = await embedTextFont(doc, needCjk);
    const size = opts.size || 10;
    pages.forEach((page, i) => {
      const { width, height } = page.getSize();
      const idx = i + 1;
      if (opts.header) {
        const t = applyTokens(opts.header, idx, pages.length);
        page.drawText(t, { x: 40, y: height - 28, size, font, color: toRgb(opts.color), opacity: 0.9 });
      }
      if (opts.footer) {
        const t = applyTokens(opts.footer, idx, pages.length);
        page.drawText(t, { x: 40, y: 24, size, font, color: toRgb(opts.color), opacity: 0.9 });
      }
    });
  }, t('正在添加页眉页脚…'));
}

export async function addPageNumbers(opts) {
  await applyChange(async (doc) => {
    const pages = doc.getPages();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const size = opts.size || 10;
    const total = pages.length;
    pages.forEach((page, i) => {
      const { width, height } = page.getSize();
      const label = opts.format === 'en'
        ? `Page ${i + 1} of ${total}`
        : `第 ${i + 1} 页 / 共 ${total} 页`;
      let text = label;
      if (hasNonLatin(text)) {
        // 中文页码需要 CJK 字体，改用数字形式
        text = `${i + 1} / ${total}`;
      }
      const tw = safeWidth(font, text, size);
      const pos = opts.position || 'bottom-center';
      let x = (width - tw) / 2, y = 24;
      if (pos === 'bottom-right') { x = width - tw - 40; y = 24; }
      else if (pos === 'bottom-left') { x = 40; y = 24; }
      else if (pos === 'top-center') { y = height - 28; }
      else if (pos === 'top-right') { x = width - tw - 40; y = height - 28; }
      page.drawText(text, { x, y, size, font, color: toRgb(opts.color || '#333333'), opacity: 0.95 });
    });
  }, t('正在添加页码…'));
}

function applyTokens(tpl, idx, total) {
  return String(tpl)
    .replace(/\{page\}/gi, String(idx))
    .replace(/\{total\}/gi, String(total))
    .replace(/\{n\}/gi, String(idx))
    .replace(/\{date\}/gi, new Date().toLocaleDateString('zh-CN'))
    .replace(/\{filename\}/gi, state.fileName || '')
    .replace(/[\u4e00-\u9fff]/g, '');   // 页眉页脚默认用英文数字，避免缺字体
}

function safeWidth(font, text, size) {
  try { return font.widthOfTextAtSize(text, size); } catch (e) { return text.length * size * 0.5; }
}

/* ---------------- 表单填写 ---------------- */
// 注意：不能依赖 constructor.name —— 生产构建压缩后类名会被混淆
function fieldKind(f) {
  if (f instanceof PDFTextField) return 'text';
  if (f instanceof PDFCheckBox) return 'checkbox';
  if (f instanceof PDFDropdown) return 'dropdown';
  if (f instanceof PDFRadioGroup) return 'radio';
  if (f instanceof PDFOptionList) return 'optionlist';
  return 'other';
}
const KIND_LABEL = {
  text: '文本字段', checkbox: '复选框', dropdown: '下拉框',
  radio: '单选组', optionlist: '列表', other: '其它'
};
const kindLabel = (k) => t(KIND_LABEL[k] || '其它');

export async function listFormFields() {
  const doc = await loadWorking();
  const form = doc.getForm();
  return form.getFields().map((f) => {
    const kind = fieldKind(f);
    let value = '';
    try {
      if (kind === 'checkbox') value = f.isChecked();
      else if (kind === 'dropdown' || kind === 'optionlist') value = (typeof f.getSelected === 'function' ? (f.getSelected() || [])[0] || '' : '');
      else if (kind === 'radio') value = (typeof f.getSelected === 'function' ? f.getSelected() || '' : '');
      else if (typeof f.getText === 'function') value = f.getText() || '';
    } catch (e) { value = ''; }
    return { name: f.getName(), kind, type: kindLabel(kind), value };
  });
}

export async function fillFormValues(values) {
  await applyChange(async (doc) => {
    const form = doc.getForm();
    const needCjk = values.some((v) => typeof v.value === 'string' && hasNonLatin(v.value));
    let font = null;
    try { font = await embedTextFont(doc, needCjk); } catch (e) { font = null; }
    for (const v of values) {
      const kind = v.kind || (v.type && v.type.includes('CheckBox') ? 'checkbox' : 'text');
      try {
        if (kind === 'text') {
          form.getTextField(v.name).setText(String(v.value == null ? '' : v.value));
        } else if (kind === 'checkbox') {
          const cb = form.getCheckBox(v.name);
          if (v.value) cb.check(); else cb.uncheck();
        } else if (kind === 'dropdown') {
          if (v.value) form.getDropdown(v.name).select(String(v.value));
        } else if (kind === 'radio') {
          if (v.value) form.getRadioGroup(v.name).select(String(v.value));
        } else if (kind === 'optionlist') {
          if (v.value) form.getOptionList(v.name).select(String(v.value));
        }
      } catch (e) { /* 忽略单个字段错误 */ }
    }
    // 优先重绘字段外观（保留可编辑性）；失败时回退到扁平化
    let updated = false;
    if (font) {
      try { form.updateFieldAppearances(font); updated = true; } catch (e) { updated = false; }
    }
    if (!updated) {
      try { form.flatten(); } catch (e) { /* 部分字段可能不支持扁平化 */ }
    }
  }, t('正在写入表单…'));
}

/* ---------------- 由图片生成 PDF ---------------- */
export async function createFromImages(dataUrls) {
  const doc = await PDFDocument.create();
  for (const d of dataUrls) {
    const bytes = dataUrlToBytes(d);
    let img;
    try { img = await doc.embedPng(bytes); } catch (e) { img = await doc.embedJpg(bytes); }
    const page = doc.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  }
  const bytes = await doc.save();
  await Tabs.openDocument({ bytes, fileName: '由图片创建.pdf', dirty: true });
  viewer.goToPage(1);
}
