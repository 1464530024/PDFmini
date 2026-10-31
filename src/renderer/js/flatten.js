// 将批注扁平化写入 PDF（pdf-lib）
import { PDFDocument, rgb, degrees, StandardFonts, BlendMode, PDFName, PDFString } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { normalizePdfText } from './textfix.js';

/* ---------------- 字体（4 种简单字体） ----------------
 * hei 黑体 / kai 楷体 / fang 仿宋 / mono 等宽
 * 中文用系统字体（按需读取、子集内嵌，零体积成本）；拉丁字母用 pdf-lib 内置标准字体。
 */
const CJK_FONT_IDS = { hei: 'hei', kai: 'kai', fang: 'fang', mono: 'hei' };
const STD_FONT_IDS = {
  hei: StandardFonts.Helvetica,
  kai: StandardFonts.TimesRoman,
  fang: StandardFonts.TimesRoman,
  mono: StandardFonts.Courier
};
const cjkCache = new Map();     // id -> Uint8Array | false
const cjkDocCache = new Map();  // id -> embedded font | null

function hex2rgb(hex, opacity = 1) {
  const h = String(hex || '#000000').replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return rgb(isNaN(r) ? 0 : r, isNaN(g) ? 0 : g, isNaN(b) ? 0 : b);
}

function hasNonLatin(str) {
  return /[^\u0000-\u00ff]/.test(str || '');
}

function sanitizeLatin(str) {
  return (str || '').replace(/[^\u0000-\u00ff]/g, '?');
}

async function loadSystemCjk(id = 'hei') {
  const key = CJK_FONT_IDS[id] || 'hei';
  if (cjkCache.has(key)) return cjkCache.get(key);
  let bytes = false;
  try {
    const r = await window.pdfmini.font.systemCJK({ id: key });
    bytes = r && r.ok ? new Uint8Array(r.data) : false;
  } catch (e) {
    bytes = false;
  }
  cjkCache.set(key, bytes);
  return bytes;
}

function dataUrlToBytes(dataUrl) {
  const base64 = String(dataUrl).split(',')[1] || '';
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 把批注写入 pdf-lib 文档
 * @param {PDFDocument} pdfDoc
 * @param {Object} annotations  { [page]: [anno] }
 */
export async function applyAnnotations(pdfDoc, annotations) {
  const pages = pdfDoc.getPages();
  const fonts = { cjk: new Map(), std: new Map() };

  // 统计用到的字体 id（带文字的批注）
  const usedIds = new Set();
  for (const k in annotations) {
    for (const a of annotations[k]) {
      if ((a.type === 'text' || a.type === 'note' || a.type === 'stamp') && a.text) {
        usedIds.add(CJK_FONT_IDS[a.font] ? a.font : 'hei');
      }
    }
  }
  usedIds.add('hei');   // 兜底字体总是准备着

  // 标准字体（拉丁）按需内嵌
  for (const id of usedIds) {
    const stdName = STD_FONT_IDS[id] || StandardFonts.Helvetica;
    if (fonts.std.has(stdName)) continue;
    try { fonts.std.set(stdName, await pdfDoc.embedFont(stdName)); }
    catch (e) { /* 忽略 */ }
  }

  // 中文字体：只有真正出现非拉丁字符时才读取（避免无谓的 10MB 字体读取）
  let needCjk = false;
  for (const k in annotations) {
    for (const a of annotations[k]) {
      if ((a.type === 'text' || a.type === 'note' || a.type === 'stamp') && hasNonLatin(a.text || '')) needCjk = true;
    }
  }
  if (needCjk) {
    pdfDoc.registerFontkit(fontkit);
    for (const id of usedIds) {
      const key = CJK_FONT_IDS[id] || 'hei';
      if (cjkDocCache.has(key)) continue;
      let embedded = null;
      const bytes = await loadSystemCjk(key);
      if (bytes) {
        try { embedded = await pdfDoc.embedFont(bytes, { subset: true }); } catch (e) { embedded = null; }
      }
      cjkDocCache.set(key, embedded);
    }
  }
  fonts.cjk = cjkDocCache;

  const helv = fonts.std.get(StandardFonts.Helvetica) || null;

  for (const key in annotations) {
    const idx = Number(key) - 1;
    if (idx < 0 || idx >= pages.length) continue;
    const page = pages[idx];
    const rot = page.getRotation().angle || 0;

    for (const a of annotations[key]) {
      if (a.type === 'link') continue;      // 链接单独处理（写入真正的 Link 注解）
      try {
        await drawOne(page, a, rot, fonts, helv, pdfDoc);
      } catch (e) {
        console.warn('批注写入失败', a.type, e);
      }
    }
  }

  writeLinks(pdfDoc, pages, annotations);
  return pdfDoc;
}

/**
 * 把「链接」写入为真正的 PDF /Link 注解（URI 或 页内跳转）。
 * 这类注解不绘制内容，因此不能走 drawOne 的扁平化路径。
 */
function writeLinks(pdfDoc, pages, annotations) {
  const ctx = pdfDoc.context;
  for (const key in annotations) {
    const idx = Number(key) - 1;
    if (idx < 0 || idx >= pages.length) continue;
    const page = pages[idx];
    for (const a of annotations[key]) {
      if (a.type !== 'link') continue;
      try {
        const rect = ctx.obj([a.x, a.y, a.x + a.w, a.y + a.h]);
        let action;
        if (a.url) {
          action = ctx.obj({ Type: PDFName.of('Action'), S: PDFName.of('URI'), URI: PDFString.of(String(a.url)) });
        } else if (a.targetPage) {
          const tIdx = Math.max(0, Math.min(pages.length - 1, a.targetPage - 1));
          const dest = ctx.obj([pages[tIdx].ref, PDFName.of('XYZ'), 0, pages[tIdx].getHeight(), 0]);
          action = ctx.obj({ Type: PDFName.of('Action'), S: PDFName.of('GoTo'), D: dest });
        } else {
          continue;
        }
        const annot = ctx.obj({
          Type: PDFName.of('Annot'),
          Subtype: PDFName.of('Link'),
          Rect: rect,
          Border: ctx.obj([0, 0, 0]),
          F: 4,
          A: action
        });
        const ref = ctx.register(annot);
        const existing = page.node.Annots();
        if (existing) existing.push(ref);
        else page.node.set(PDFName.of('Annots'), ctx.obj([ref]));
      } catch (e) {
        console.warn('链接写入失败', e);
      }
    }
  }
}

async function drawOne(page, a, rot, fonts, helv, pdfDoc) {
  const col = hex2rgb(a.color || '#e4002b');
  const op = a.opacity == null ? 1 : a.opacity;

  if (a.type === 'highlight') {
    for (const r of a.rects) {
      page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: r.h, color: col, opacity: op || 0.42, blendMode: BlendMode.Multiply });
    }
    return;
  }
  if (a.type === 'underline') {
    for (const r of a.rects) {
      page.drawRectangle({ x: r.x, y: r.y, width: r.w, height: Math.max(1, r.h * 0.08), color: col, opacity: 0.95 });
    }
    return;
  }
  if (a.type === 'strikeout') {
    for (const r of a.rects) {
      page.drawRectangle({ x: r.x, y: r.y + r.h / 2 - Math.max(0.5, r.h * 0.05), width: r.w, height: Math.max(1, r.h * 0.08), color: col, opacity: 0.95 });
    }
    return;
  }
  if (a.type === 'ink') {
    for (const path of a.paths) {
      for (let i = 1; i < path.length; i++) {
        page.drawLine({
          start: { x: path[i - 1].x, y: path[i - 1].y },
          end: { x: path[i].x, y: path[i].y },
          thickness: Math.max(0.5, a.width || 1.5),
          color: col,
          opacity: 0.95,
          lineCap: 1
        });
      }
    }
    return;
  }
  if (a.type === 'shape') {
    const rotateOpt = rot ? { rotate: degrees(rot) } : {};
    if (a.shape === 'line') {
      page.drawLine({
        start: { x: a.x, y: a.y + a.h },
        end: { x: a.x + a.w, y: a.y },
        thickness: Math.max(0.5, a.width || 1.5),
        color: col,
        opacity: 0.95
      });
      return;
    }
    if (a.shape === 'ellipse') {
      page.drawEllipse({
        x: a.x + a.w / 2, y: a.y + a.h / 2,
        xScale: a.w / 2, yScale: a.h / 2,
        borderColor: col, borderWidth: Math.max(0.5, a.width || 1.5), borderOpacity: 0.95,
        color: a.fill ? col : undefined, opacity: a.fill ? 0.2 : undefined,
        ...rotateOpt
      });
      return;
    }
    page.drawRectangle({
      x: a.x, y: a.y, width: a.w, height: a.h,
      borderColor: col, borderWidth: Math.max(0.5, a.width || 1.5), borderOpacity: 0.95,
      color: a.fill ? col : undefined, opacity: a.fill ? 0.2 : undefined,
      ...rotateOpt
    });
    return;
  }
  if (a.type === 'text') {
    const font = pickFont(a, fonts, helv);
    if (!font) return;
    const size = a.fontSize || 14;
    const rotateOpt = rot ? { rotate: degrees(rot) } : {};
    // 覆盖原文字（编辑文字功能）
    if (a.cover) {
      page.drawRectangle({
        x: a.cover.x, y: a.cover.y, width: a.cover.w, height: a.cover.h,
        color: rgb(1, 1, 1), opacity: 1, ...rotateOpt
      });
    }
    const lines = String(a.text || '').split('\n');
    let y = a.y - size * 0.86;
    for (const line of lines) {
      page.drawText(safeStr(line, font, a.text), {
        x: a.x, y, size, font, color: col, opacity: 0.98,
        maxWidth: a.w ? a.w : undefined,
        ...rotateOpt
      });
      y -= size * 1.28;
    }
    return;
  }
  if (a.type === 'note') {
    const size = 11;
    const font = pickFont(a, fonts, helv);
    page.drawRectangle({ x: a.x - 9, y: a.y - 9, width: 18, height: 18, color: rgb(1, 0.83, 0), opacity: 0.95, borderColor: rgb(0.72, 0.55, 0), borderWidth: 0.5 });
    if (a.text && font) {
      const lines = wrapText(String(a.text), font, size, 150);
      let y = a.y - 22;
      for (const ln of lines.slice(0, 40)) {
        page.drawText(safeStr(ln, font, a.text), { x: a.x + 12, y, size, font, color: rgb(0.15, 0.15, 0.15) });
        y -= size * 1.3;
      }
    }
    return;
  }
  if (a.type === 'stamp') {
    const font = pickFont(a, fonts, helv);
    const rotateOpt = rot ? { rotate: degrees(rot) } : {};
    if (a.cover) {
      page.drawRectangle({ x: a.cover.x, y: a.cover.y, width: a.cover.w, height: a.cover.h, color: rgb(1, 1, 1), opacity: 1, ...rotateOpt });
    }
    page.drawRectangle({
      x: a.x, y: a.y, width: a.w, height: a.h,
      borderColor: col, borderWidth: Math.max(1, a.h * 0.045), borderOpacity: 0.95,
      color: col, opacity: 0.06,
      ...rotateOpt
    });
    if (font) {
      const size = Math.min(a.h * 0.44, a.w / Math.max(2, (a.text || '').length) * 1.5);
      const txt = safeStr(a.text || '', font, a.text);
      const tw = font.widthOfTextAtSize(txt, size);
      page.drawText(txt, {
        x: a.x + Math.max(3, (a.w - tw) / 2),
        y: a.y + a.h / 2 - size * 0.36,
        size, font, color: col, opacity: 0.95,
        ...rotateOpt
      });
    }
    return;
  }
  if (a.type === 'signature' || a.type === 'image') {
    const rotateOpt = rot ? { rotate: degrees(rot) } : {};
    // 覆盖式对象（PDF 原生元素）：先铺白底，用于「移动后遮盖原位」
    if (a.cover) {
      page.drawRectangle({
        x: a.cover.x, y: a.cover.y, width: a.cover.w, height: a.cover.h,
        color: rgb(1, 1, 1), opacity: 1, ...rotateOpt
      });
    }
    if (!a.dataUrl) return;      // 已删除（仅保留白底抹除）
    const bytes = dataUrlToBytes(a.dataUrl);
    let img;
    try { img = await pdfDoc.embedPng(bytes); }
    catch (e) { img = await pdfDoc.embedJpg(bytes); }
    page.drawImage(img, { x: a.x, y: a.y, width: a.w, height: a.h, opacity: 1, ...rotateOpt });
    return;
  }
}

/** 按批注的 font id 选择字体：含非拉丁字符走中文字体，否则走标准字体 */
function pickFont(a, fonts, helv) {
  const id = CJK_FONT_IDS[a.font] ? a.font : 'hei';
  const text = a.text || '';
  if (hasNonLatin(text)) {
    const cjk = fonts.cjk.get(CJK_FONT_IDS[id]);
    return cjk || fonts.cjk.get('hei') || helv || null;
  }
  const stdName = STD_FONT_IDS[id] || StandardFonts.Helvetica;
  const std = fonts.std.get(stdName);
  return std || helv || fonts.cjk.get('hei') || null;
}
function safeStr(str) {
  // 文本层里可能带康熙部首（如「⼤」），写进 PDF 会缺字，这里统一还原成规范汉字
  str = normalizePdfText(str);
  return str == null ? '' : String(str);
}
function wrapText(text, font, size, maxWidth) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const ch of para) {
      const test = line + ch;
      let w = 0;
      try { w = font.widthOfTextAtSize(test, size); } catch (e) { w = test.length * size * 0.6; }
      if (w > maxWidth && line) { out.push(line); line = ch; }
      else line = test;
    }
    out.push(line);
  }
  return out;
}

export { hasNonLatin, hex2rgb, loadSystemCjk, dataUrlToBytes, wrapText };
