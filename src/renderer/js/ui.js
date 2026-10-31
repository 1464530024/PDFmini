// 通用 UI：提示、弹窗、下拉菜单、加载遮罩
import { icon } from './icons.js';

/* ---------------- Toast ---------------- */
export function toast(msg, kind = '') {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 260);
  }, kind === 'err' ? 4200 : 2400);
}

/* ---------------- Loading ---------------- */
export function showLoading(text = '处理中…') {
  let el = document.getElementById('loading-mask');
  if (el) { el.querySelector('.loading-text').textContent = text; return; }
  el = document.createElement('div');
  el.id = 'loading-mask';
  el.className = 'loading-mask';
  el.innerHTML = `<div class="spinner"></div><div class="loading-text"></div>`;
  el.querySelector('.loading-text').textContent = text;
  document.body.appendChild(el);
}
export function hideLoading() {
  const el = document.getElementById('loading-mask');
  if (el) el.remove();
}
export async function withLoading(text, fn) {
  showLoading(text);
  try {
    return await fn();
  } finally {
    hideLoading();
  }
}

/* ---------------- Modal ---------------- */
/**
 * openModal({ title, body(HTMLElement|string), footer:[{label,kind,onClick}], width, onMount })
 * 返回 { close }
 */
export function openModal(opts) {
  const root = document.getElementById('modal-root');
  const mask = document.createElement('div');
  mask.className = 'modal-mask';

  const modal = document.createElement('div');
  modal.className = 'modal';
  if (opts.width) modal.style.width = opts.width + 'px';

  const head = document.createElement('div');
  head.className = 'modal-head';
  head.textContent = opts.title || '';

  const body = document.createElement('div');
  body.className = 'modal-body';
  if (typeof opts.body === 'string') body.innerHTML = opts.body;
  else if (opts.body instanceof HTMLElement) body.appendChild(opts.body);

  modal.appendChild(head);
  modal.appendChild(body);

  const close = () => mask.remove();

  if (opts.footer !== false) {
    const foot = document.createElement('div');
    foot.className = 'modal-foot';
    const items = opts.footer || [
      { label: '取消', kind: 'btn-ghost', onClick: close },
      { label: '确定', kind: 'btn-primary', onClick: close }
    ];
    for (const it of items) {
      const b = document.createElement('button');
      b.className = it.kind || 'btn-ghost';
      b.textContent = it.label;
      b.onclick = () => it.onClick ? it.onClick({ close, body, modal }) : close();
      foot.appendChild(b);
    }
    modal.appendChild(foot);
  }

  mask.appendChild(modal);
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });
  root.appendChild(mask);
  if (opts.onMount) opts.onMount({ body, modal, close });
  const firstInput = body.querySelector('input,textarea,select');
  if (firstInput) setTimeout(() => firstInput.focus(), 30);
  return { close, body, modal };
}

export function confirmDialog(title, message, okLabel = '确定') {
  return new Promise((resolve) => {
    openModal({
      title,
      body: `<div class="hint" style="font-size:13px;color:var(--text)">${message}</div>`,
      footer: [
        { label: '取消', kind: 'btn-ghost', onClick: ({ close }) => { close(); resolve(false); } },
        { label: okLabel, kind: 'btn-primary', onClick: ({ close }) => { close(); resolve(true); } }
      ]
    });
  });
}

export function alertDialog(title, message) {
  return new Promise((resolve) => {
    openModal({
      title,
      body: `<div class="hint" style="font-size:13px;color:var(--text)">${message}</div>`,
      footer: [{ label: '知道了', kind: 'btn-primary', onClick: ({ close }) => { close(); resolve(true); } }]
    });
  });
}

/* ---------------- 下拉菜单 ---------------- */
let activeMenu = null;
export function closeMenu() {
  if (activeMenu) { activeMenu.remove(); activeMenu = null; }
  document.querySelectorAll('.tbtn.menu-open').forEach((b) => b.classList.remove('menu-open'));
}
document.addEventListener('mousedown', (e) => {
  if (activeMenu && !activeMenu.contains(e.target)) closeMenu();
}, true);
window.addEventListener('blur', closeMenu);

/**
 * openMenu(anchorEl, items)
 * item: {label, icon, key, onClick, checked, sep:true, title:'分组名'} 或 {colors:[...], onPick}
 */
export function openMenu(anchorEl, items, opts = {}) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.style.minWidth = (opts.minWidth || 190) + 'px';

  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'menu-sep'; menu.appendChild(s); continue; }
    if (it.title) { const tt = document.createElement('div'); tt.className = 'menu-title'; tt.textContent = it.title; menu.appendChild(tt); continue; }
    if (it.colors) {
      const grid = document.createElement('div');
      grid.className = 'menu-colors';
      for (const c of it.colors) {
        const d = document.createElement('button');
        d.className = 'color-dot';
        d.style.background = c;
        d.title = c;
        d.onclick = () => { it.onPick(c); closeMenu(); };
        grid.appendChild(d);
      }
      menu.appendChild(grid);
      continue;
    }
    const el = document.createElement('div');
    el.className = 'menu-item';
    el.innerHTML = `<span class="mi-icon">${it.icon ? icon(it.icon) : ''}</span><span>${it.label}</span>`
      + (it.key ? `<span class="mi-key">${it.key}</span>` : '')
      + (it.checked ? `<span class="menu-check">✓</span>` : '');
    el.onclick = () => { closeMenu(); if (it.onClick) it.onClick(); };
    menu.appendChild(el);
  }

  document.getElementById('menu-root').appendChild(menu);
  const r = anchorEl.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = r.left;
  let top = r.bottom + 5;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 5);
  menu.style.left = Math.max(8, left) + 'px';
  menu.style.top = top + 'px';
  anchorEl.classList.add('menu-open');
  activeMenu = menu;
  return menu;
}

/* ---------------- 通用控件构造 ---------------- */
export function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

export function field(label, inputHTML) {
  return `<div class="field"><label>${label}</label>${inputHTML}</div>`;
}
