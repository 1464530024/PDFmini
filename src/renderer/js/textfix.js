// 文本修复：
// 1) normalizePdfText —— 把 pdf.js 从「损坏 ToUnicode」里读出的康熙部首 / 兼容汉字还原成规范汉字。
//    这类 PDF（每个字形一个 Type3 字体）会把「大」写成 U+2F24（KANGXI RADICAL BIG）、
//    「工」写成 U+2F2F。系统字体没有这些码位，界面上显示成豆腐块，写回 PDF 也会丢字。
// 2) repairMissingGlyphs —— pdf.js 画不出来的字形（这类 PDF 常见），
//    在渲染完成后逐字检测「该位置压根没有墨迹」，用系统字体补画上去，避免整行/整字缺失。
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js';

const CJK_FONT = '"Microsoft YaHei", "PingFang SC", "SimHei", "SimSun", system-ui, sans-serif';

const KANGXI_START = 0x2f00;
const KANGXI_END = 0x2fd5;
const COMPAT_START = 0xf900;
const COMPAT_END = 0xfaff;

/** 康熙部首 / CJK 兼容汉字 → 规范汉字；顺带丢掉 NUL 与替换符 */
export function normalizePdfText(str) {
  if (!str) return str;
  let out = '';
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp === 0 || cp === 0xfffd) continue;
    if ((cp >= KANGXI_START && cp <= KANGXI_END) || (cp >= COMPAT_START && cp <= COMPAT_END)) {
      let n = ch;
      try { n = ch.normalize('NFKC') || ch; } catch (e) { n = ch; }
      out += n;
    } else {
      out += ch;
    }
  }
  return out;
}

/** 单个字符版（保留空白字符） */
export function normalizePdfChar(ch) {
  if (!ch) return ch;
  if (/\s/.test(ch)) return ch;
  return normalizePdfText(ch);
}

/* ------------------------------------------------------------------ *
 * ActualText 还原
 * 这类 PDF 会把「读不出编码的字」包在 /Span<</ActualText <FEFF5927>>> 里，
 * 但 pdf.js 3.x 既不给 marked content、也不使用 ActualText，
 * 于是这些字在文本层里成了 NUL（或康熙部首）。这里自己从操作符列表里把
 * ActualText 按顺序取出来，逐字替换回去。
 * ------------------------------------------------------------------ */
const actualTextCache = new WeakMap();   // page -> string[]

async function collectActualTexts(page) {
  const hit = actualTextCache.get(page);
  if (hit) return hit;
  let list = [];
  try {
    const ops = await page.getOperatorList();
    const OPS = pdfjsLib.OPS;
    const fnArr = ops.fnArray;
    const argArr = ops.argsArray;
    const stack = [null];
    for (let i = 0; i < fnArr.length; i++) {
      const fn = fnArr[i];
      const args = argArr[i];
      if (fn === OPS.beginMarkedContentProps || fn === OPS.beginMarkedContent) {
        let at = null;
        if (args && args.length > 1 && args[1] && typeof args[1].get === 'function') {
          try {
            const v = args[1].get('ActualText');
            if (v) at = typeof v === 'string' ? v : (v.str != null ? String(v.str) : null);
          } catch (e) { at = null; }
        }
        stack.push(at);
      } else if (fn === OPS.endMarkedContent) {
        if (stack.length > 1) stack.pop();
      } else if (fn === OPS.showText || fn === OPS.showSpacedText) {
        list.push(stack[stack.length - 1]);
      }
    }
  } catch (e) { list = []; }
  actualTextCache.set(page, list);
  return list;
}

function isCjkLike(ch) {
  const cp = ch.codePointAt(0);
  return (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) || cp > 0xffff;
}

/** 用 ActualText 修好这一页的文本项（就地修改 item.str） */
async function applyActualText(page, items) {
  if (!items || !items.length) return;
  const texts = await collectActualTexts(page);
  if (!texts.length) return;
  let k = 0;
  for (const it of items) {
    const str = it && it.str;
    if (!str) continue;
    const chars = Array.from(str);
    let out = null;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const cp = ch.codePointAt(0);
      const broken = cp === 0 || cp === 0xfffd
        || (cp >= KANGXI_START && cp <= KANGXI_END)
        || (cp >= COMPAT_START && cp <= COMPAT_END);
      if (!broken) continue;
      const at = texts[k++];
      if (!at) continue;
      const clean = String(at).replace(/^\ufeff/, '').split('\ufeff').join('');
      // 只接受看起来像汉字的实际文本，避免错位时写出乱码
      if (!clean || !isCjkLike(clean[0])) continue;
      if (!out) out = chars.slice();
      out[i] = clean;
    }
    if (out) it.str = out.join('');
  }
}

/** 取这一页的文本内容，并把 ActualText 还原回去（带缓存） */
export async function getFixedTextContent(page) {
  const tc = await page.getTextContent();
  const items = (tc && tc.items) || [];
  if (!items.length) return tc;
  if (!tc.__fixed) {
    await applyActualText(page, items);
    try { Object.defineProperty(tc, '__fixed', { value: true, enumerable: false }); } catch (e) { /* ignore */ }
  }
  return tc;
}

/**
 * 渲染后逐字检测「没画出来的字」并补画。
 * @returns {number} 补画的字符数
 */
export async function repairMissingGlyphs(canvas, ctx, page, viewport, dpr = 1) {
  const W = canvas.width;
  const H = canvas.height;
  if (!W || !H || W * H > 3.2e7) return 0;      // 超大画布不处理，避免一次性吃掉几十 MB

  let items = [];
  try {
    const tc = await getFixedTextContent(page);
    items = tc.items || [];
  } catch (e) { return 0; }
  if (!items.length) return 0;

  let img;
  try { img = ctx.getImageData(0, 0, W, H); } catch (e) { return 0; }
  const data = img.data;

  const inkRatio = (x, y, w, h) => {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(W, Math.ceil(x + w));
    const y1 = Math.min(H, Math.ceil(y + h));
    if (x1 - x0 < 1 || y1 - y0 < 1) return -1;
    let ink = 0;
    let total = 0;
    for (let yy = y0; yy < y1; yy++) {
      let i = (yy * W + x0) * 4;
      for (let xx = x0; xx < x1; xx++, i += 4) {
        total++;
        // 任何通道明显不为白 → 认为该像素有内容
        if (data[i] < 235 || data[i + 1] < 235 || data[i + 2] < 235) ink++;
      }
    }
    return total ? ink / total : -1;
  };

  let drawn = 0;
  let font = '';
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#101114';
  for (const item of items) {
    const str = item.str || '';
    if (!str.trim() || !item.width) continue;
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fs = Math.hypot(tx[2], tx[3]) || Math.hypot(tx[0], tx[1]) || 10;
    if (fs < 3) continue;
    const w = item.width * viewport.scale;
    if (w < 1) continue;
    // 按「码点」切分（emoji 是代理对，按 UTF-16 切会画成两个豆腐块）
    const chars = Array.from(str);
    const cw = w / chars.length;
    for (let k = 0; k < chars.length; k++) {
      const ch = chars[k];
      if (!/\S/.test(ch)) continue;
      const px = (tx[4] + k * cw) * dpr;
      const py = (tx[5] - fs) * dpr;
      const pw = cw * dpr;
      const ph = fs * 1.15 * dpr;
      if (inkRatio(px, py, pw, ph) > 0.02) continue;   // 已经有墨迹 → 说明画出来了
      const out = normalizePdfChar(ch);
      if (!out || !/\S/.test(out)) continue;
      const f = `${(fs * dpr).toFixed(1)}px ${CJK_FONT}`;
      if (f !== font) { ctx.font = f; font = f; }
      ctx.fillText(out, px, tx[5] * dpr);
      drawn++;
    }
  }
  ctx.restore();
  return drawn;
}
