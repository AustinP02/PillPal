// PillPal design-system primitives as HTML-string helpers (vanilla port of the React components in the design handoff).
// Every helper returns markup built from the .pp-* classes in /ds/components.css. Dynamic text always goes through esc().
import { ICONS } from './icons.js';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const attrs = o => Object.entries(o || {}).filter(([, v]) => v != null && v !== false)
  .map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${esc(v)}"`)).join('');

// Lucide line icon (2px stroke, round caps). Unknown names render an empty box rather than crashing.
export function icon(name, { size = 20, stroke = 2, color = 'currentColor', title, cls = '', style = '' } = {}) {
  const body = (ICONS[name] || []).map(([tag, a]) => `<${tag}${attrs(a)}/>`).join('');
  return `<svg class="pp-icon ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" ${title ? `role="img" aria-label="${esc(title)}"` : 'aria-hidden="true"'} style="flex:none;display:block;${style}">${title ? `<title>${esc(title)}</title>` : ''}${body}</svg>`;
}

// <button> or <a> with .pp-btn. `a` = extra attributes (data-action, aria-label, href…).
export function btn(label, { variant = 'primary', size = 'md', left, right, block, a = {}, cls = '' } = {}) {
  const c = ['pp-btn', 'pp-btn--' + variant, size !== 'md' && 'pp-btn--' + size, block && 'pp-btn--block', cls].filter(Boolean).join(' ');
  const isz = size === 'lg' ? 20 : size === 'sm' ? 16 : 18;
  const inner = `${left ? icon(left, { size: isz }) : ''}${label}${right ? icon(right, { size: isz }) : ''}`;
  return a.href ? `<a class="${c}"${attrs(a)}>${inner}</a>` : `<button type="${a.type || 'button'}" class="${c}"${attrs({ ...a, type: null })}>${inner}</button>`;
}
export function iconBtn(name, label, { variant = 'ghost', size = 'md', a = {}, cls = '' } = {}) {
  const c = ['pp-iconbtn', 'pp-iconbtn--' + variant, size !== 'md' && 'pp-iconbtn--' + size, cls].filter(Boolean).join(' ');
  return `<button type="${a.type || 'button'}" class="${c}" aria-label="${esc(label)}" title="${esc(label)}"${attrs({ ...a, type: null })}>${icon(name, { size: size === 'lg' ? 22 : size === 'sm' ? 16 : 20 })}</button>`;
}
export function badge(text, { tone, size, dot, ic, a = {} } = {}) {
  const c = ['pp-badge', tone && 'pp-badge--' + tone, size === 'sm' && 'pp-badge--sm'].filter(Boolean).join(' ');
  return `<span class="${c}"${attrs(a)}>${dot ? '<span class="pp-badge__dot"></span>' : ''}${ic ? icon(ic, { size: size === 'sm' ? 12 : 14, stroke: 2.4 }) : ''}${text}</span>`;
}
// Tag: static <span>, or a toggle <button> when `a` carries a data-action.
export function tag(text, { selected, ic, a } = {}) {
  const live = !!a;
  const c = ['pp-tag', live && 'pp-tag--interactive', selected && 'pp-tag--selected'].filter(Boolean).join(' ');
  const inner = `${selected && live && !ic ? icon('check', { size: 14, stroke: 2.6 }) : ''}${ic ? icon(ic, { size: 15 }) : ''}${text}`;
  return live ? `<button type="button" class="${c}" aria-pressed="${!!selected}"${attrs(a)}>${inner}</button>` : `<span class="${c}">${inner}</span>`;
}

// Pill: CSS capsule / round / oval in the medication's real colours.
export function pill({ shape = 'capsule', colors = ['#1B8E93', '#FFE6D5'] } = {}, size = 32) {
  const a = esc(colors[0]), b = esc(colors[1] || colors[0]);
  const inner = shape === 'capsule'
    ? `<span class="pp-pill pp-pill--capsule" style="width:${size * 0.42}px;height:${size * 0.92}px;background:linear-gradient(to bottom,${a} 50%,${b} 50%);box-shadow:inset 0 0 0 1px rgba(0,0,0,.06)"></span>`
    : shape === 'oval'
      ? `<span class="pp-pill pp-pill--oval" style="width:${size * 0.86}px;height:${size * 0.52}px;background:${a};transform:rotate(-20deg)"></span>`
      : `<span class="pp-pill pp-pill--round" style="width:${size * 0.72}px;height:${size * 0.72}px;background:${a}"></span>`;
  return `<span class="pp-pill-wrap" style="width:${size}px;height:${size}px" aria-hidden="true">${inner}</span>`;
}
export const pillBox = (p, box, size) => `<span class="pp-pill-icon" style="width:${box}px;height:${box}px">${pill(p, size)}</span>`;
export const medPill = m => ({ shape: m.shape || 'round', colors: (m.shape === 'capsule') ? [m.color || '#127479', '#F7F9F8'] : [m.color || '#F1F4F4'] });

// Pip, the capsule mascot. Moods: happy, wink, sleepy, celebrate, alert.
let pipN = 0;
export function mascot(mood = 'happy', size = 96, { animate = true, title = '' } = {}) {
  const id = 'pip' + (++pipN);
  const s = 'stroke="var(--pip-face)" stroke-width="3.2" stroke-linecap="round" fill="none"';
  const eyes = {
    wink: `<ellipse cx="40" cy="74" rx="3.6" ry="4.6" fill="var(--pip-face)"/><path d="M56 75 Q60 71 64 75" ${s}/>`,
    sleepy: `<path d="M36 74 Q40 77 44 74" ${s}/><path d="M56 74 Q60 77 64 74" ${s}/>`,
    celebrate: `<path d="M36 76 Q40 70 44 76" ${s}/><path d="M56 76 Q60 70 64 76" ${s}/>`,
    alert: '<circle cx="40" cy="73" r="5" fill="var(--pip-face)"/><circle cx="60" cy="73" r="5" fill="var(--pip-face)"/><circle cx="41.6" cy="71.4" r="1.6" fill="#fff"/><circle cx="61.6" cy="71.4" r="1.6" fill="#fff"/>',
  }[mood] || '<ellipse cx="40" cy="74" rx="3.6" ry="4.6" fill="var(--pip-face)"/><ellipse cx="60" cy="74" rx="3.6" ry="4.6" fill="var(--pip-face)"/><circle cx="41.2" cy="72.4" r="1.2" fill="#fff"/><circle cx="61.2" cy="72.4" r="1.2" fill="#fff"/>';
  const mouth = {
    alert: '<ellipse cx="50" cy="86" rx="3.4" ry="3.8" fill="var(--pip-face)"/>',
    sleepy: `<path d="M46 86 Q50 88 54 86" ${s}/>`,
    celebrate: '<path d="M42 83 Q50 94 58 83 Z" fill="var(--pip-face)" stroke="var(--pip-face)" stroke-width="2" stroke-linejoin="round"/>',
  }[mood] || `<path d="M43 84 Q50 91 57 84" ${s}/>`;
  return `<svg class="pip${animate ? ' pip--bob' : ''}" width="${Math.round(size * 100 / 120)}" height="${size}" viewBox="0 0 100 120" ${title ? `role="img" aria-label="${esc(title)}"` : 'aria-hidden="true"'}>
    <g transform="rotate(-14 50 60)"><clipPath id="${id}"><rect x="22" y="6" width="56" height="108" rx="28"/></clipPath>
    <g clip-path="url(#${id})"><rect x="22" y="6" width="56" height="54" fill="var(--pip-top)"/><rect x="22" y="60" width="56" height="54" fill="var(--pip-bottom)"/>
      <rect x="22" y="58.5" width="56" height="3" fill="rgba(0,0,0,.10)"/><rect x="32" y="16" width="8" height="28" rx="4" fill="#fff" opacity=".32"/><rect x="32" y="48" width="8" height="5" rx="2.5" fill="#fff" opacity=".32"/></g>
    <ellipse cx="32" cy="84" rx="4.6" ry="2.8" fill="var(--pip-cheek)" opacity=".55"/><ellipse cx="68" cy="84" rx="4.6" ry="2.8" fill="var(--pip-cheek)" opacity=".55"/>${eyes}${mouth}</g></svg>`;
}
export const logo = (size = 24) => `<span class="pp-logo" style="gap:${Math.round(size * 0.22)}px">${mascot('happy', Math.round(size * 1.15), { animate: false })}<span style="font-size:${Math.round(size * 0.82)}px">Pill<span class="pp-logo__pal">Pal</span></span><span class="sr-only">PillPal</span></span>`;

export function ring(value, { size = 96, stroke = 10, color = 'var(--brand)', label, sub, aria } = {}) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, value));
  return `<span class="pp-ring" style="width:${size}px;height:${size}px" role="img" aria-label="${esc(aria || label)}"><svg width="${size}" height="${size}" aria-hidden="true">
    <circle class="pp-ring__track" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}"/>
    <circle class="pp-ring__bar" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - v / 100)}"/></svg>
    <span class="pp-ring__label" aria-hidden="true"><span><span style="font-size:${Math.round(size * 0.24)}px;display:block">${esc(label ?? Math.round(v) + '%')}</span>
    ${sub ? `<span class="pp-ring__sub" style="font-size:${Math.max(11, Math.round(size * 0.11))}px">${esc(sub)}</span>` : ''}</span></span></span>`;
}

// Form fields. `a` goes on the <input>/<select>/<textarea>.
export function input({ label, hint, error, ic, a = {}, trailing = '', cls = '' }) {
  const id = a.id || 'f' + Math.random().toString(36).slice(2, 8);
  return `<label class="pp-field ${cls}" for="${id}">${label ? `<span class="pp-field__label">${label}</span>` : ''}
    <span class="pp-input${error ? ' pp-input--error' : ''}">${ic ? icon(ic, { size: 18 }) : ''}<input${attrs({ type: 'text', ...a, id, 'aria-invalid': error ? 'true' : null })}>${trailing}</span>
    ${error ? `<span class="pp-field__hint pp-field__hint--error">${esc(error)}</span>` : hint ? `<span class="pp-field__hint">${hint}</span>` : ''}</label>`;
}
export function select({ label, ic, options, value, a = {} }) {
  const id = a.id || 'f' + Math.random().toString(36).slice(2, 8);
  return `<label class="pp-field" for="${id}">${label ? `<span class="pp-field__label">${label}</span>` : ''}<span class="pp-input">${ic ? icon(ic, { size: 18 }) : ''}
    <select${attrs({ ...a, id })}>${options.map(o => `<option value="${esc(o.value)}"${o.value === value ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>${icon('chevron-down', { size: 18, style: 'pointer-events:none' })}</span></label>`;
}
export function textarea({ label, hint, a = {}, value = '' }) {
  const id = a.id || 'f' + Math.random().toString(36).slice(2, 8);
  return `<label class="pp-field" for="${id}"><span class="pp-field__label">${label}${hint ? ` <span class="pp-caption" style="font-weight:500">${hint}</span>` : ''}</span>
    <textarea class="pp-textarea"${attrs({ ...a, id })}>${esc(value)}</textarea></label>`;
}
export const toggle = ({ label = '', checked, a = {} }) =>
  `<label class="pp-switch"><input type="checkbox" role="switch"${attrs({ ...a, checked: !!checked })}><span class="pp-switch__track"><span class="pp-switch__thumb"></span></span>${label ? `<span>${label}</span>` : ''}</label>`;
export const checkbox = ({ label, checked, a = {} }) =>
  `<label class="pp-check"><input type="checkbox"${attrs({ ...a, checked: !!checked })}><span class="pp-check__box">${icon('check', { size: 14, stroke: 3 })}</span><span>${label}</span></label>`;
// Segmented tabs. Each button gets data-action + data-value so the page's click handler can react.
export const tabs = (items, value, { action, block, label } = {}) =>
  `<div class="pp-tabs${block ? ' pp-tabs--block' : ''}" role="tablist"${label ? ` aria-label="${esc(label)}"` : ''}>${items.map(it =>
    `<button type="button" role="tab" class="pp-tabs__tab" aria-selected="${it.value === value}" data-action="${action}" data-value="${esc(it.value)}">${esc(it.label)}</button>`).join('')}</div>`;
