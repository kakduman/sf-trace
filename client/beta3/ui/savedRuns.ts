/** Saved runs (savedRuns.ts): the list in the Scenario panel, and opening a run saved to a file. */
import { bundleId } from '../../../shared/beta3/bundle';
import { DAY_LABEL } from '../derive';
import { esc, signedInt } from '../format';
import { RETENTION, RUN_FILE_EXT, type SavedRunMeta } from '../savedRuns';
import { state } from '../state';
import { onActs, section, type Ctx } from './common';
import { RUN_MODE_TEXT } from './scenarioPanel';

const when = (t: number) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const size = (n: number) => (n < 1e6 ? `${Math.max(1, Math.round(n / 1e3))} KB` : `${(n / 1e6).toFixed(1)} MB`);

function item(r: SavedRunMeta, current: string): string {
  const stale = r.bundleId !== current;
  const shown = !!state.result && state.resultKey === r.key && state.result.bundleId === r.bundleId;
  const bits = [DAY_LABEL[r.day], RUN_MODE_TEXT[r.runMode]?.label ?? r.runMode, when(r.savedAt), r.dTrips !== undefined && !stale ? `${signedInt(r.dTrips)} transit trips` : '', size(r.size)].filter(Boolean);
  return `<li><div><div class="ed-t">${esc(r.name)}${shown ? ' <span class="muted">· shown</span>' : ''}</div><div class="ed-d">${esc(bits.join(' · '))}${stale ? ' · <span class="warn">earlier model: open to run again</span>' : ''}</div></div>
    <div class="ed-acts"><button class="btn sm" data-act="run-open" data-id="${esc(r.id)}">Open</button><button class="icon-btn" data-act="run-keep" data-id="${esc(r.id)}" aria-pressed="${r.kept}" aria-label="${r.kept ? 'Kept: click to let it go' : 'Keep this run'}" title="${r.kept ? 'Kept until you remove it' : 'Keep (recent runs are removed after a while)'}">${r.kept ? '★' : '☆'}</button><button class="icon-btn" data-act="run-dl" data-id="${esc(r.id)}" aria-label="Download ${esc(r.name)}" title="Download to a file">⤓</button><button class="icon-btn" data-act="run-del" data-id="${esc(r.id)}" aria-label="Remove ${esc(r.name)}" title="Remove">✕</button></div></li>`;
}

export function renderSavedRuns(ctx: Ctx, el: HTMLElement): void {
  const { runs, error } = state.saved;
  const current = bundleId(ctx.engine.bundle.header);
  const kept = runs.filter((r) => r.kept), recent = runs.filter((r) => !r.kept);
  const list = (rs: SavedRunMeta[]) => `<ul class="saved-list">${rs.map((r) => item(r, current)).join('')}</ul>`;
  let body = error
    ? `<p class="note">This browser isn’t keeping runs (${esc(error)}). You can still download results from Results and open them here.</p>`
    : !runs.length
      ? `<p class="note">Runs you finish are saved here, in this browser, with their scenarios.</p>`
      : `${kept.length ? `<h4>Kept</h4>${list(kept)}` : ''}${recent.length ? `<h4>Recent</h4>${list(recent)}` : ''}`;
  body += `<div class="row-actions"><label class="btn sm ghost">Open a file…<input type="file" id="run-file" accept="${RUN_FILE_EXT},application/gzip,application/octet-stream" hidden></label></div>`;
  el.innerHTML = section(`Saved runs${runs.length ? ` (${runs.length})` : ''}`, body, {
    note: `The last ${RETENTION.recent} runs stay for ${RETENTION.days} days; ★ keeps one until you remove it. The browser can still clear its storage, so download a run to keep it for good.`,
  });
  onActs(el, {
    'run-open': (b) => ctx.openRun(b.dataset.id!),
    'run-keep': (b) => ctx.keepRun(b.dataset.id!, b.getAttribute('aria-pressed') !== 'true'),
    'run-dl': (b) => ctx.downloadRun(b.dataset.id!),
    'run-del': (b) => ctx.removeRun(b.dataset.id!),
  });
  const input = el.querySelector<HTMLInputElement>('#run-file')!;
  input.onchange = () => {
    const f = input.files?.[0];
    input.value = '';
    if (f) ctx.importRun(f);
  };
}
