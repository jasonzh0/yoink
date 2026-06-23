/**
 * The on-page element picker: a crosshair-style overlay that highlights whatever
 * the pointer is over and resolves the chosen element on click. Injected into
 * arbitrary host pages, so it leans on inline styles + one injected keyframes
 * block and never touches the host's own stylesheets.
 */
const STYLE_ID = 'yoink-style';
const OVERLAY_ID = 'yoink-overlay';
const ACCENT = '#7b5cff';
const ACCENT_SOFT = 'rgba(123,92,255,0.18)';
const FONT =
  "'Inter', 'Segoe UI', system-ui, -apple-system, BlinkMacSystemFont, sans-serif";

const prefersReducedMotion = (): boolean =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function ensureKeyframes(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes yk-fade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes yk-rise { from { opacity: 0; transform: translate(-50%, 14px); } to { opacity: 1; transform: translate(-50%, 0); } }
  `;
  document.head.appendChild(style);
}

const div = (cssText: string): HTMLDivElement => {
  const el = document.createElement('div');
  el.style.cssText = cssText;
  el.dataset.yoink = 'true';
  return el;
};

const isOurNode = (node: EventTarget | null): boolean =>
  node instanceof HTMLElement && node.dataset.yoink === 'true';

const describe = (el: Element): string => {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  const cls =
    el instanceof HTMLElement && el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';
  const rect = el.getBoundingClientRect();
  const size = `${Math.round(rect.width)}×${Math.round(rect.height)}`;
  return `${tag}${id}${cls}  ·  ${size}`;
};

let activePick: (() => void) | null = null;

/** Begin element-picking. Resolves the chosen element to `onPick`, or cleans up
 * silently on cancel (Esc). Calling again cancels any prior session. */
export function startPicker(onPick: (el: Element) => void): void {
  if (activePick) activePick();
  ensureKeyframes();
  const reduced = prefersReducedMotion();

  const highlight = div(`
    position: fixed; z-index: 2147483640; pointer-events: none;
    border: 2px solid ${ACCENT}; background: ${ACCENT_SOFT};
    border-radius: 3px; box-shadow: 0 0 0 9999px rgba(10,8,20,0.32);
    transition: ${reduced ? 'none' : 'all 0.06s linear'};
    top: 0; left: 0; width: 0; height: 0; opacity: 0;
  `);
  highlight.id = OVERLAY_ID;

  const label = div(`
    position: fixed; z-index: 2147483641; pointer-events: none;
    padding: 5px 9px; border-radius: 5px; max-width: 80vw;
    background: ${ACCENT}; color: #fff; font: 600 12px/1.2 ${FONT};
    letter-spacing: 0.01em; white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis; box-shadow: 0 4px 14px rgba(0,0,0,0.4);
    opacity: 0;
  `);

  const hint = div(`
    position: fixed; left: 50%; bottom: 22px; z-index: 2147483641;
    pointer-events: none; transform: translateX(-50%);
    padding: 9px 16px; border-radius: 999px;
    background: rgba(20,16,32,0.92); color: #efeaff;
    font: 600 12.5px/1 ${FONT}; letter-spacing: 0.02em;
    box-shadow: 0 8px 28px rgba(0,0,0,0.5);
    border: 1px solid rgba(123,92,255,0.5);
  `);
  hint.textContent = 'Click an element to yoink it  ·  Esc to cancel';
  if (!reduced) hint.style.animation = 'yk-rise 0.25s ease-out both';

  document.body.append(highlight, label, hint);

  let current: Element | null = null;

  const place = (el: Element): void => {
    const r = el.getBoundingClientRect();
    highlight.style.opacity = '1';
    highlight.style.top = `${r.top}px`;
    highlight.style.left = `${r.left}px`;
    highlight.style.width = `${r.width}px`;
    highlight.style.height = `${r.height}px`;

    label.style.opacity = '1';
    label.textContent = describe(el);
    const labelTop = r.top > 26 ? r.top - 24 : r.top + 4;
    label.style.top = `${Math.max(2, labelTop)}px`;
    label.style.left = `${Math.max(2, r.left)}px`;
  };

  const onMove = (event: MouseEvent): void => {
    if (isOurNode(event.target)) return;
    const el = document.elementFromPoint(event.clientX, event.clientY);
    if (!el || isOurNode(el) || el === current) return;
    current = el;
    place(el);
  };

  const swallow = (event: Event): void => {
    if (isOurNode(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const onClick = (event: MouseEvent): void => {
    if (isOurNode(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const el =
      document.elementFromPoint(event.clientX, event.clientY) || current;
    teardown();
    if (el) onPick(el);
  };

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      teardown();
    }
  };

  function teardown(): void {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('mousedown', swallow, true);
    window.removeEventListener('pointerdown', swallow, true);
    window.removeEventListener('contextmenu', swallow, true);
    window.removeEventListener('keydown', onKey, true);
    highlight.remove();
    label.remove();
    hint.remove();
    activePick = null;
  }

  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('mousedown', swallow, true);
  window.addEventListener('pointerdown', swallow, true);
  window.addEventListener('contextmenu', swallow, true);
  window.addEventListener('keydown', onKey, true);
  activePick = teardown;
}

let toastTimer = 0;

/** Show a transient pill at the bottom of the page. */
export function showToast(message: string, kind: 'success' | 'error'): void {
  ensureKeyframes();
  const existing = document.getElementById('yoink-toast');
  if (existing) existing.remove();

  const color = kind === 'success' ? ACCENT : '#ff5d6c';
  const toast = div(`
    position: fixed; left: 50%; bottom: 24px; z-index: 2147483646;
    transform: translateX(-50%); pointer-events: none; max-width: 86vw;
    padding: 11px 18px; border-radius: 999px;
    background: rgba(18,14,28,0.96); color: #f4f1ff;
    font: 600 13px/1.3 ${FONT}; letter-spacing: 0.01em; text-align: center;
    border: 1px solid ${color};
    box-shadow: 0 10px 34px rgba(0,0,0,0.55), 0 0 18px -6px ${color};
  `);
  toast.id = 'yoink-toast';
  toast.textContent = message;
  if (!prefersReducedMotion()) toast.style.animation = 'yk-rise 0.3s ease-out both';
  document.body.appendChild(toast);

  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.remove(), 2600);
}
