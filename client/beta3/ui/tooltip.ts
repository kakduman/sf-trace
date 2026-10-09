/**
 * One shared tooltip for the map and the charts. Chart marks carry `data-tip` (HTML they built
 * from escaped text); the map calls showTip directly.
 */
let el: HTMLElement | null = null;

function tip(): HTMLElement {
  if (!el) {
    el = document.createElement('div');
    el.className = 'tip';
    el.setAttribute('role', 'tooltip');
    el.hidden = true;
    document.body.append(el);
  }
  return el;
}

export function showTip(html: string, x: number, y: number): void {
  const t = tip();
  if (!html) return hideTip();
  if (t.innerHTML !== html) t.innerHTML = html;
  t.hidden = false;
  const r = t.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = x + 14, top = y + 14;
  if (left + r.width > vw - 8) left = Math.max(8, x - r.width - 14);
  if (top + r.height > vh - 8) top = Math.max(8, y - r.height - 14);
  t.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

export function hideTip(): void {
  if (el) el.hidden = true;
}

/** hover/focus tooltips for every [data-tip] inside `root` */
export function bindTips(root: HTMLElement): void {
  let current: Element | null = null;
  root.addEventListener('pointermove', (e) => {
    const t = (e.target as Element).closest?.('[data-tip]');
    if (!t) {
      if (current) hideTip(), (current = null);
      return;
    }
    current = t;
    showTip(t.getAttribute('data-tip')!, e.clientX, e.clientY);
  });
  root.addEventListener('pointerleave', () => {
    hideTip();
    current = null;
  });
  root.addEventListener('focusin', (e) => {
    const t = (e.target as Element).closest?.('[data-tip]');
    if (!t) return;
    const r = t.getBoundingClientRect();
    showTip(t.getAttribute('data-tip')!, r.right, r.top);
  });
  root.addEventListener('focusout', () => hideTip());
  root.addEventListener('scroll', () => hideTip(), true);
}
