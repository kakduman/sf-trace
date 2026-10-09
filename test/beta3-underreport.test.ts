import { describe, expect, it } from 'vitest';
import { readC16002 } from '../server/beta3/pipeline/language';
import { INCOME_CLASSES, SEGMENTS, UNDERREPORT } from '../shared/beta3/params';

const header = ['GEO_ID', 'C16002_E001', 'C16002_M001', 'C16002_E004', 'C16002_M004', 'C16002_E007', 'C16002_M007', 'C16002_E010', 'C16002_M010', 'C16002_E013', 'C16002_M013'].join('|');

describe('beta3 survey underreporting (sensitivity only)', () => {
  it('is off in the model: every factor is 1', () => {
    expect(UNDERREPORT.tours.length).toBe(SEGMENTS.length);
    for (const row of UNDERREPORT.tours) {
      expect(row.length).toBe(INCOME_CLASSES.length);
      for (const f of row) expect(f).toBe(1);
    }
    expect(UNDERREPORT.lep).toBe(1);
    expect(UNDERREPORT.lepShare).toBeNull();
  });
  it("reads limited-English households from C16002's four language groups, block groups only", () => {
    const text = [header, '1500000US060750101011|200|9|10|1|5|1|30|2|0|1', '1400000US06075010101|900|9|50|1|5|1|30|2|0|1'].join('\n');
    const m = readC16002(text);
    expect(m.size).toBe(1);
    expect(m.get('060750101011')).toEqual([45, 200]);
  });
});

describe('beta3 article: survey underreporting', () => {
  it('renders from underreport-results.json without missing numbers', async () => {
    const { underreportWork } = await import('../client/beta3/paper/sections/muniarea');
    const h = underreportWork();
    expect(h).toContain('Limited-English ×2');
    expect(h).not.toMatch(/NaN|undefined|Infinity/);
    if (process.env.SHOW_SECTION) console.log(h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
  });
});
