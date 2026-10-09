/** About: what the model is and isn't, the words the app uses, its key assumptions, and its sources. The methodology page has the depth. */
import { COST_PER_HOUR, PATH, IVT_FACTOR, MODEL_AUTHOR, MODEL_AUTHOR_NOTE, MODEL_AUTHOR_URL, MODEL_CITATION, MODEL_LONG_NAME, MODEL_NAME, MODEL_VERSION, PURPOSE_HELP, PURPOSE_LABEL, transferPenalty } from '../../../shared/beta3/params';
import { esc } from '../format';
import { state } from '../state';
import { bindWeekendSwitch, RUNS_HELP, SERVICE_HOURS_HELP, section, weekendSwitch, type Ctx } from './common';

export function renderMethod(ctx: Ctx, el: HTMLElement): void {
  const H = ctx.m.bundle.header;
  const cal = H.calibration;
  let h = `<div class="panel-head"><h2>About ${MODEL_NAME}</h2>
    <a class="method-callout" href="method/"><span>For how the model works, its data, and how it compares with ridership counts, read the full methodology.</span><b>Read the methodology →</b></a></div>`;
  h += section(
    'What it is',
    `<p>${MODEL_NAME}, the ${MODEL_LONG_NAME}, is an open travel model of San Francisco on an average weekday, built from public data and checked against ridership counts. It works like the models regional agencies use, simplified so a scenario runs in your browser.</p>`,
  );
  h += section(
    'What it can’t tell you',
    `<ul class="plain">
      <li>Results are averages for a typical day, not a forecast for a particular date.</li>
      <li>Homes and jobs stay where they are. Car ownership changes only in a long-run scenario.</li>
      <li>Trips with neither end in the city change only with the number of trains.</li>
      <li>Travel outside the city is modeled coarsely.</li>
      <li>People don’t change what time of day they travel.</li>
      <li>Some inputs predate the pandemic, adjusted for working from home.</li>
    </ul>`,
  );
  h += section(
    'Words used in this app',
    `<dl class="glossary">
      <dt>Trip</dt><dd>One person going from one place to another by any mode. A trip with a transfer is still one trip.</dd>
      <dt>Transit trip</dt><dd>A trip by transit, counted once however many vehicles it uses.</dd>
      <dt>Riders, boardings</dt><dd>Each time someone gets on a bus, train, or boat. A trip with one transfer is two boardings.</dd>
      <dt>${esc(PURPOSE_LABEL.nhb)}</dt><dd>${esc(PURPOSE_HELP.nhb)}</dd>
      <dt>Scheduled runs</dt><dd>${esc(RUNS_HELP)}</dd>
      <dt>Service hours</dt><dd>${esc(SERVICE_HOURS_HELP)}</dd>
      <dt>Peak load</dt><dd>Riders on board ÷ capacity on a route’s busiest stretch in its busiest period.</dd>
      <dt>Headway</dt><dd>Minutes between buses or trains in one direction.</dd>
      <dt>Day types</dt><dd>An average weekday. Saturday and Sunday models can be switched on below.</dd>
    </dl>`,
  );
  h += section(
    'Key assumptions',
    `<table class="tbl kv"><tbody>
      <tr><td>A minute waiting / walking, vs riding</td><td class="num">×${PATH.waitWeight} / ×${PATH.walkWeight}</td></tr>
      <tr><td>Each transfer feels like</td><td class="num">${transferPenalty(cal).toFixed(1)} min</td></tr>
      <tr><td>A minute on board, vs a bus</td><td class="num">${Object.entries(IVT_FACTOR)
        .filter(([, v]) => v !== 1)
        .map(([k, v]) => `${esc(k)} ${v}`)
        .join(', ')}</td></tr>
      <tr><td>Operating cost per service hour</td><td class="num">bus $${Math.round(COST_PER_HOUR.bus)}, light rail $${Math.round(COST_PER_HOUR.lightrail)}, BART train $${Math.round(COST_PER_HOUR.bart).toLocaleString('en-US')}, Caltrain train $${Math.round(COST_PER_HOUR.caltrain).toLocaleString('en-US')}</td></tr>
      <tr><td>Value of time</td><td class="num">$20 per hour</td></tr>
      <tr><td>CO₂ per vehicle-km</td><td class="num">0.25 kg</td></tr>
      <tr><td>Days per year</td><td class="num">255 weekdays, 52 Saturdays, 58 Sundays & holidays</td></tr>
      <tr><td>New line speeds, with stops</td><td class="num">bus 12, rapid 16, light rail 20, subway 32, metro 45, ferry 30 km/h</td></tr>
    </tbody></table>`,
  );
  h += section('Weekends', weekendSwitch(state.weekends));
  h += section('Sources', `<details class="sources"><summary>Data sources (${H.sources.length + 1})</summary><ul class="plain">${H.sources.map((s) => `<li>${esc(s)}</li>`).join('')}<li>Basemap: OpenFreeMap, © OpenMapTiles, © OpenStreetMap contributors</li></ul></details>`);
  h += section('Credits', `<p>Created by <a href="${MODEL_AUTHOR_URL}" target="_blank" rel="noopener">${esc(MODEL_AUTHOR)}</a><sup>*</sup>.</p><p class="note"><sup>*</sup> ${esc(MODEL_AUTHOR_NOTE)}</p>`);
  h += section('How to cite', `<p class="cite-line">${esc(MODEL_CITATION)}</p>`);
  h += `<p class="note">Model data built ${esc(new Date(H.built).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }))} · ${H.zones.length} block groups, ${H.ext.length} outside zones, ${H.stops.length.toLocaleString()} stops, ${H.lines.length} route patterns.</p>`;
  el.innerHTML = h;
  bindWeekendSwitch(ctx, el);
}
