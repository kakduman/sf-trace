import { describe, expect, it } from 'vitest';

describe('beta3 article: the whole methodology article', () => {
  it('renders every section with its numbers filled in and every cross-reference resolved', async () => {
    const { article } = await import('../client/beta3/paper/article');
    const { OUTLINE } = await import('../client/beta3/paper/outline');
    const html = article();
    // KaTeX's MathML carries no model numbers; check the text a reader sees
    const text = html.replace(/<annotation[\s\S]*?<\/annotation>/g, '').replace(/<[^>]+>/g, ' ');
    expect(text).not.toMatch(/\bundefined\b|\bNaN\b|\bInfinity\b/);
    expect(text).not.toMatch(/Section(&nbsp;|\s)\?/);
    expect(text).toContain('SF-TRACE, the San Francisco Transit Ridership And Choice Estimator');
    // every outline section is rendered once, with a heading and some text
    for (const { id } of OUTLINE) {
      const m = html.match(new RegExp(`<section id="${id}"[^>]*>([\\s\\S]*?)(?=<section id=|$)`));
      expect(m, `section ${id}`).not.toBeNull();
      expect(m![1].replace(/<h[23][\s\S]*?<\/h[23]>/, '').replace(/<[^>]+>/g, '').trim().length, `section ${id} is empty`).toBeGreaterThan(40);
    }
    // every link inside the article points at something in it
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const missing = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]).filter((h) => !ids.has(h));
    expect([...new Set(missing)]).toEqual([]);
  });
});
