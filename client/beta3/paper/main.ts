/**
 * The methodology and validation article at /beta3/method. The text is rendered once from the
 * section modules (so citation numbers follow the order of first use); the figures are SVG drawn
 * at the width they are shown at, and redrawn when that width changes.
 */
import 'katex/dist/katex.min.css';
import './paper.css';
import { CHARTS } from './charts';
import { article as renderArticle } from './article';

const article = document.getElementById('article')!;
article.innerHTML = renderArticle();

// ---------- contents ----------
function buildToc() {
  const items = [...article.querySelectorAll<HTMLElement>('section > h2, section > h3')].filter((h) => h.id && h.closest('section')?.id !== 'abstract');
  const li = items
    .map((h) => {
      const sec = h.closest('section')!;
      const num = h.querySelector('.sec-num')?.textContent ?? '';
      const title = (h.textContent ?? '').replace(num, '').trim();
      return `<li class="${h.tagName === 'H3' ? 'sub' : ''}"><a href="#${sec.id}" data-sec="${sec.id}"><span class="toc-num">${num}</span>${title}</a></li>`;
    })
    .join('');
  const list = `<ol class="toc-list">${li}</ol>`;
  document.getElementById('toc')!.innerHTML = list;
  const mobile = document.getElementById('toc-mobile');
  if (mobile) mobile.innerHTML = `<details><summary>Contents</summary>${list}</details>`;
  // mark the section being read
  const links = new Map([...document.querySelectorAll<HTMLAnchorElement>('#toc a')].map((a) => [a.dataset.sec!, a]));
  const seen = new Map<string, boolean>();
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) seen.set((e.target as HTMLElement).id, e.isIntersecting);
      const current = [...links.keys()].filter((id) => seen.get(id)).pop();
      if (!current) return;
      for (const [id, a] of links) a.toggleAttribute('aria-current', id === current);
    },
    { rootMargin: '-15% 0px -70% 0px' },
  );
  for (const id of links.keys()) {
    const el = document.getElementById(id);
    if (el) io.observe(el);
  }
}
buildToc();

// ---------- figures ----------
const slots = [...document.querySelectorAll<HTMLElement>('.chart-slot[data-chart]')];
const drawn = new WeakMap<HTMLElement, number>();
function draw(slot: HTMLElement) {
  const w = Math.floor(slot.clientWidth);
  if (!w || drawn.get(slot) === w) return;
  const render = CHARTS[slot.dataset.chart!];
  if (!render) throw new Error(`no chart ${slot.dataset.chart}`);
  slot.innerHTML = render(w);
  drawn.set(slot, w);
}
let pending = 0;
const ro = new ResizeObserver((entries) => {
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(() => entries.forEach((e) => draw(e.target as HTMLElement)));
});
for (const s of slots) {
  draw(s);
  ro.observe(s);
}

// ---------- theme ----------
const THEMES = ['auto', 'light', 'dark'] as const;
type Theme = (typeof THEMES)[number];
const btn = document.getElementById('theme') as HTMLButtonElement;
const read = (): Theme => {
  try {
    const t = localStorage.getItem('b3-theme') as Theme | null;
    return t && THEMES.includes(t) ? t : 'auto';
  } catch {
    return 'auto';
  }
};
function apply(t: Theme) {
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  btn.textContent = t === 'auto' ? 'Theme: system' : t === 'light' ? 'Theme: light' : 'Theme: dark';
  btn.setAttribute('aria-label', `Color theme: ${t === 'auto' ? 'follow the system' : t}. Change`);
}
let current = read();
apply(current);
btn.addEventListener('click', () => {
  const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
  current = next;
  try {
    localStorage.setItem('b3-theme', next);
  } catch {
    /* private mode: the choice lasts for this page only */
  }
  apply(next);
});

// a hash link loaded before the article existed
if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
