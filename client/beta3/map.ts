/**
 * The map: MapLibre with the Positron basemap and our sources. Geometry is built once; on a period,
 * view, color or result change only the feature properties are recomputed and the source's data
 * replaced (MapLibre re-tiles in its worker). Selection and hover use filters and paint
 * properties, which are cheap. Nothing redraws per frame.
 */
import { AttributionControl, GeoJSONSource, Map as MLMap, NavigationControl, setWorkerCount, setWorkerUrl, type MapMouseEvent, type MapGeoJSONFeature } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre 6 finds its worker next to its own module, which Vite's dependency bundling moves: point it at a bundled copy
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { RunResult, Scenario } from '../../shared/beta3/types';
import type { Engine } from './engine';
import {
  LINE_GROUP_COLOR,
  LINE_GROUP_LABEL,
  LINE_GROUPS,
  OPERATOR_LABEL,
  PERIOD_SHORT,
  hoursOf,
  lineGroup,
  lineIndex,
  newLines,
  pathSlice,
  periodsOf,
  routeStats,
  routeTitle,
  segLoad,
  segService,
  scenTrips,
  extendStopIndices,
  stopInfo,
  type Model,
  type NewLineEdit,
} from './derive';
import { compact, dec1, esc, int, pct, signedInt, signedPp } from './format';
import { DAY_LABEL, DAY_NOUN } from './derive';
import { PROFILES, draftAddStop, draftMoveStop, draftRemoveStop, nearestStop, profileOf, streetGraph, relegAll } from './scenario';
import { set, shownResult, state, subscribe, touch, type AppState, type MapView, type ZoneLayer } from './state';
import { hideTip, showTip } from './ui/tooltip';
import { CHANGE_COLORS, CHANGE_LABELS, CHANGE_WIDTH, CONGESTION_COLORS, CONGESTION_LABELS, LOCAL_GROUP, changeClass, congestionClass, congestionShare, freeFlowSpeed, linkSpeed, linkVolume, roadGroup, streetWidthExpr, todayTraffic } from './roadsView';
import { shapeCoords } from '../../shared/beta3/roadShapes';

type Key = keyof AppState;
/** minimal GeoJSON types (the project doesn't include @types/geojson) */
interface Feature {
  type: 'Feature';
  id?: number;
  properties: Record<string, unknown>;
  geometry: { type: 'LineString'; coordinates: [number, number][] } | { type: 'Point'; coordinates: [number, number] } | { type: 'Polygon'; coordinates: [number, number][][] };
}
interface FC {
  type: 'FeatureCollection';
  features: Feature[];
}

const SF_BOUNDS: [[number, number], [number, number]] = [
  [-122.515, 37.705],
  [-122.355, 37.835],
];

/** width at zoom 12 (px) for riders per hour: a power of 0.75 keeps a quiet bus visible without letting BART swamp the city */
const flowWidth = (perHour: number) => (perHour > 0.5 ? Math.min(30, 0.6 + 0.045 * perHour ** 0.75) : 0);
const changeWidth = (perHour: number) => Math.min(26, 0.6 + 0.09 * Math.abs(perHour) ** 0.75);
/** line width by zoom from the feature's `w` (px at zoom 12); zoom must stay the top-level input */
const W_STATE = ['coalesce', ['feature-state', 'w'], 0];
const ON_STATE = ['==', ['coalesce', ['feature-state', 'on'], 0], 1];
const WIDTH_EXPR = (scale = 1, add = 0, min = 0, w: unknown = W_STATE) => {
  const at = (k: number) => ['max', min, ['+', ['*', w, k * scale], add]];
  return ['interpolate', ['exponential', 1.5], ['zoom'], 10, at(0.35), 12, at(1), 14, at(1.9), 17, at(4)] as unknown as number;
};

export const CROWD_BREAKS = [0.5, 0.85, 1.0];
export const CROWD_COLORS = ['#86b6ef', '#2a78d6', '#eda100', '#d03b3b'];
export const CROWD_LABELS = ['under 50% full', '50–85%', '85–100% (crowded)', 'over capacity'];

// ---------- theme: the basemap and our casings follow the page's light or dark scheme ----------

const darkMQ = matchMedia('(prefers-color-scheme: dark)');
const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t === 'dark' || (t !== 'light' && darkMQ.matches);
};
interface Theme {
  land: string;
  park: string;
  water: string;
  residential: string;
  building: string;
  minor: string;
  path: string;
  casing: string;
  major: string;
  motorway: string;
  rail: string;
  railDash: string;
  boundary: string;
  label: string;
  labelStrong: string;
  waterLabel: string;
  /** halo behind our selected lines and new lines */
  lineCasing: string;
  hover: string;
  idle: string;
  stopStroke: string;
  up: string;
  down: string;
  /** sequential ramp for area layers: neutral slate, so colored lines stay readable on top */
  seq: string[];
  /** diverging ramp for scenario changes: fewer (red) to more (blue), as everywhere */
  div: string[];
}
const THEMES: Record<'light' | 'dark', Theme> = {
  light: { land: '#eef1f1', park: '#e1e9e2', water: '#c5d3da', residential: '#eaeeee', building: '#e2e7e8', minor: '#dce2e4', path: '#e5e9ea', casing: '#cfd6d9', major: '#ffffff', motorway: '#ffffff', rail: '#d3d9dc', railDash: '#f4f6f6', boundary: '#a9b3b9', label: '#55626b', labelStrong: '#1f2c35', waterLabel: '#5b7890', lineCasing: '#ffffff', hover: '#132029', idle: '#97a2a8', stopStroke: '#26333c', up: '#2a78d6', down: '#d03b3b', seq: ['#eef1f2', '#d6dde0', '#b6c1c7', '#909da5', '#6a7882', '#45535d'], div: ['#8f2424', '#d03b3b', '#f0a3a0', '#e6eaec', '#9ec5f4', '#3987e5', '#184f95'] },
  dark: { land: '#141c21', park: '#15211c', water: '#0b141b', residential: '#151e23', building: '#1b252a', minor: '#232e34', path: '#1d272c', casing: '#1b252a', major: '#2d3a41', motorway: '#36444c', rail: '#28333a', railDash: '#141c21', boundary: '#3e4b53', label: '#8a979f', labelStrong: '#c5ced3', waterLabel: '#6c8aa2', lineCasing: '#0c1215', hover: '#ffffff', idle: '#56646c', stopStroke: '#0c1215', up: '#3987e5', down: '#e66767', seq: ['#1a2328', '#26333a', '#36464f', '#4c5f69', '#6a7f8a', '#8fa4ae'], div: ['#f2958c', '#c94a44', '#6b302e', '#222c32', '#25466c', '#3f7fd0', '#8cb9f4'] },
};
let T: Theme = THEMES[isDark() ? 'dark' : 'light'];
/** basemap layer → the paint it gets from the theme */
const BASE_PAINT: Record<string, [string, keyof Theme][]> = {
  background: [['background-color', 'land']],
  park: [['fill-color', 'park']],
  landcover_wood: [['fill-color', 'park']],
  water: [['fill-color', 'water']],
  waterway: [['line-color', 'water']],
  landuse_residential: [['fill-color', 'residential']],
  building: [['fill-color', 'building'], ['fill-outline-color', 'minor']],
  road_area_pier: [['fill-color', 'land']],
  road_pier: [['line-color', 'land']],
  highway_path: [['line-color', 'path']],
  highway_minor: [['line-color', 'minor']],
  highway_major_casing: [['line-color', 'casing']],
  highway_major_inner: [['line-color', 'major']],
  highway_major_subtle: [['line-color', 'minor']],
  highway_motorway_casing: [['line-color', 'casing']],
  highway_motorway_inner: [['line-color', 'motorway']],
  highway_motorway_subtle: [['line-color', 'minor']],
  highway_motorway_bridge_casing: [['line-color', 'casing']],
  highway_motorway_bridge_inner: [['line-color', 'motorway']],
  tunnel_motorway_casing: [['line-color', 'casing']],
  tunnel_motorway_inner: [['line-color', 'minor']],
  railway_transit: [['line-color', 'rail']],
  railway_transit_dashline: [['line-color', 'railDash']],
  railway_service: [['line-color', 'rail']],
  railway_service_dashline: [['line-color', 'railDash']],
  railway: [['line-color', 'rail']],
  railway_dashline: [['line-color', 'railDash']],
  'aeroway-area': [['fill-color', 'residential']],
  'aeroway-runway': [['line-color', 'major']],
  'aeroway-runway-casing': [['line-color', 'casing']],
  'aeroway-taxiway': [['line-color', 'minor']],
  boundary_2: [['line-color', 'boundary']],
  boundary_3: [['line-color', 'boundary']],
  boundary_disputed: [['line-color', 'boundary']],
  water_name_point_label: [['text-color', 'waterLabel']],
  water_name_line_label: [['text-color', 'waterLabel']],
  waterway_line_label: [['text-color', 'waterLabel']],
};
/** basemap layers we never show (US highway shields, whose filters warn on every tile) */
const DROP = /shield/;
/** the theme's paint for one basemap layer */
function basePaint(l: { id: string; type: string }): [string, string][] {
  const out = (BASE_PAINT[l.id] ?? []).map(([k, v]) => [k, T[v]] as [string, string]);
  if (l.type === 'symbol') {
    if (!BASE_PAINT[l.id]) out.push(['text-color', /^label_(city|town|state|country)/.test(l.id) ? T.labelStrong : T.label]);
    out.push(['text-halo-color', T.land]);
  }
  return out;
}
/** route colors are darkened for a light map (derive.ts mapColor); on a dark map lift the darkest */
function themed(hex: string): string {
  if (T === THEMES.light) return hex;
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  let [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  const lum = () => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  for (let i = 0; i < 12 && lum() < 0.3; i++) (r += (255 - r) * 0.1), (g += (255 - g) * 0.1), (b += (255 - b) * 0.1);
  const h = (c: number) => Math.round(c).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

// ---------- zone layers ----------


interface ZoneMetric {
  label: string;
  unit: string;
  scenario?: boolean;
  diverging?: boolean;
  breaks?: number[];
  fmt: (v: number) => string;
  /** compact form for legend ticks */
  tick?: (v: number) => string;
}
export const ZONE_METRICS: Record<Exclude<ZoneLayer, 'none'>, ZoneMetric> = {
  share: { label: 'Transit share of residents’ trips', unit: 'of trips', breaks: [0.05, 0.1, 0.15, 0.2, 0.3], fmt: (v) => pct(v, 0) },
  jobs45: { label: 'Jobs within 45 min by transit (AM)', unit: 'jobs', breaks: [50e3, 150e3, 300e3, 450e3, 600e3], fmt: compact },
  density: { label: 'Population density', unit: 'people / sq mi', breaks: [10e3, 20e3, 30e3, 45e3, 70e3], fmt: compact },
  zerocar: { label: 'Households without a car', unit: 'of households', breaks: [0.1, 0.2, 0.3, 0.45, 0.6], fmt: (v) => pct(v, 0) },
  dshare: { label: 'Change in transit share', unit: 'percentage points of residents’ trips', scenario: true, diverging: true, fmt: (v) => signedPp(v, 2), tick: (v) => sgn(v) + trimNum(Math.abs(v) * 100) },
  daccess: { label: 'Change in accessibility', unit: 'minutes per trip', scenario: true, diverging: true, fmt: (v) => sgn(v) + Math.abs(v).toFixed(2) + ' min', tick: (v) => sgn(v) + trimNum(Math.abs(v)) },
  djobs: { label: 'Change in jobs within 45 min', unit: 'jobs reachable by transit, AM', scenario: true, diverging: true, fmt: (v) => signedInt(v), tick: (v) => sgn(v) + compact(Math.abs(v)) },
};

export class TransitMap {
  map: MLMap;
  private m: Model;
  private engine: Engine;
  private loaded = false;
  private flowFC: FC = { type: 'FeatureCollection', features: [] };
  private zoneFC: FC = { type: 'FeatureCollection', features: [] };
  private zoneBreaks: number[] = [];
  /** new-line segments currently drawn (index = feature id − segs.length) */
  private newSegs: { edit: NewLineEdit; k: number; rev: boolean; hop: number; lineHop: number }[] = [];
  /** hops of existing routes extended beyond a terminus (ids after the new lines') */
  private extSegs: { route: number; a: number; b: number; load: number; cap: number }[] = [];
  private hoverRoute = -2;
  /** feature state last sent per segment, to send only changes */
  private fsW = new Float32Array(0);
  private fsC: string[] = [];
  private dragging: { i: number; moved: boolean } | null = null;
  private raf = 0;
  private lastMove: MapMouseEvent | null = null;
  legendEl: HTMLElement;
  controlsEl: HTMLElement;
  viewEl: HTMLElement;
  hintEl: HTMLElement;

  constructor(
    el: HTMLElement,
    m: Model,
    engine: Engine,
    private hooks: { selectRoute: (key: string | null) => void; setDay: (d: AppState['day']) => void; addStopAt: (lat: number, lon: number) => void },
  ) {
    this.m = m;
    this.engine = engine;
    setWorkerUrl(maplibreWorkerUrl);
    setWorkerCount(2);
    // a container with no size yet (a hidden pane or tab) cannot fit bounds: start from the city's
    // center and zoom instead
    const sized = el.clientWidth > 64 && el.clientHeight > 64;
    this.map = new MLMap({
      container: el,
      ...(sized
        ? {
            bounds: SF_BOUNDS,
            // on phones the bottom sheet covers the lower half of the map
            fitBoundsOptions: { padding: matchMedia('(max-width: 720px)').matches ? { top: 56, bottom: el.clientHeight * 0.5 + 8, left: 8, right: 8 } : 24 },
          }
        : { center: [(SF_BOUNDS[0][0] + SF_BOUNDS[1][0]) / 2, (SF_BOUNDS[0][1] + SF_BOUNDS[1][1]) / 2] as [number, number], zoom: 11 }),
      maxBounds: [
        [-123.3, 37.1],
        [-121.6, 38.4],
      ],
      minZoom: 8.5,
      maxZoom: 18,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      attributionControl: false,
      fadeDuration: 0,
    });
    // Positron, recolored to the page's palette, without the highway shields
    this.map.setStyle('https://tiles.openfreemap.org/styles/positron', {
      transformStyle: (_prev, next) => ({
        ...next,
        // keep the camera on San Francisco (the style's own center is elsewhere)
        center: undefined,
        zoom: undefined,
        layers: next.layers
          .filter((l) => !DROP.test(l.id))
          .map((l) => {
            const paint = { ...((l as { paint?: Record<string, unknown> }).paint ?? {}) };
            for (const [k, v] of basePaint(l)) paint[k] = v;
            return { ...l, paint } as typeof l;
          }),
      }),
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.keyboard.disableRotation();
    this.map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');
    this.map.addControl(new AttributionControl({ compact: true, customAttribution: 'Model data: Census, LODES, GTFS, SFMTA, BART, Caltrain (<a href="method/">methodology</a>)' }), 'bottom-right');

    const wrap = el.parentElement!;
    this.legendEl = div('map-legend card');
    this.controlsEl = div('map-controls card');
    this.viewEl = div('map-view');
    this.hintEl = div('map-hint');
    this.hintEl.hidden = true;
    this.legendEl.hidden = true;
    this.viewEl.hidden = true;
    wrap.append(this.legendEl, this.controlsEl, this.viewEl, this.hintEl);
    this.buildControls();

    this.map.on('load', () => this.onLoad());
    // keep the attribution folded into its (i) button so it doesn't cover the legend (it opens on click)
    const fold = () => setTimeout(() => el.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'), 0);
    this.map.on('load', fold);
    this.map.on('resize', fold);
    subscribe((ch) => this.update(ch));
  }

  // ---------- setup ----------

  private onLoad() {
    const map = this.map;
    const layers = map.getStyle().layers;
    const below = layers.find((l) => l.id === 'label_other')?.id ?? layers.find((l) => l.type === 'symbol')?.id;
    const belowRoads = layers.find((l) => l.id === 'waterway')?.id ?? below;

    // zones
    const H = this.m.bundle.header;
    this.zoneFC.features = H.zones.map((z, i) => ({ type: 'Feature', id: i, properties: { v: 0, nd: 1 }, geometry: { type: 'Polygon', coordinates: z.shape } }));
    map.addSource('zones', { type: 'geojson', data: this.zoneFC });
    map.addLayer({ id: 'zones-fill', type: 'fill', source: 'zones', layout: { visibility: 'none' }, paint: { 'fill-color': '#ccc', 'fill-opacity': 0.68 } }, belowRoads);
    map.addLayer({ id: 'zones-line', type: 'line', source: 'zones', layout: { visibility: 'none' }, paint: { 'line-color': T.lineCasing, 'line-width': 0.4, 'line-opacity': 0.6 } }, belowRoads);
    map.addLayer({ id: 'zones-hover', type: 'line', source: 'zones', filter: ['==', ['id'], -1], paint: { 'line-color': T.hover, 'line-width': 1.5 } }, below);

    // flows: geometry and route are fixed; width, color and on/off live in feature state so a
    // period or view switch never re-tiles the source
    const segs = this.m.segs;
    const base = this.engine.base;
    this.flowFC.features = segs.map((sg) => {
      // draw order: busiest (today, AM) first, so thinner lines stay visible on top
      const sk = -flowWidth(segLoad(this.m, base, sg, 'AM') / 4);
      return { type: 'Feature', id: sg.id, properties: { id: sg.id, rk: sg.route, sk }, geometry: { type: 'LineString', coordinates: sg.coords } };
    });
    // street speeds (cars), under the transit lines: freeways, arterials, and collectors at any zoom,
    // local streets from about zoom 14; width by zoom and road class (and by the size of a change)
    map.addSource('speeds', { type: 'geojson', data: emptyFC(), tolerance: 0.3 });
    const speedLayout = { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'o'] } as const;
    const speedPaint = { 'line-color': ['get', 'c'], 'line-width': streetWidthExpr(), 'line-offset': streetWidthExpr(true), 'line-opacity': 0.92 } as never;
    map.addLayer({ id: 'speeds-local', type: 'line', source: 'speeds', minzoom: 13.5, filter: ['==', ['get', 'g'], LOCAL_GROUP], layout: speedLayout as never, paint: speedPaint }, below);
    map.addLayer({ id: 'speeds', type: 'line', source: 'speeds', filter: ['!=', ['get', 'g'], LOCAL_GROUP], layout: speedLayout as never, paint: speedPaint }, below);
    map.addSource('flows', { type: 'geojson', data: this.flowFC, tolerance: 0.2 });
    const FS_COLOR = ['coalesce', ['feature-state', 'c'], '#888888'];
    map.addLayer({ id: 'flows-idle', type: 'line', source: 'flows', layout: { 'line-cap': 'round' }, paint: { 'line-color': T.idle, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.4, 14, 1], 'line-opacity': ['case', ON_STATE, 0, 0.45] as never, 'line-dasharray': [2, 2] } }, below);
    map.addLayer(
      {
        id: 'flows',
        type: 'line',
        source: 'flows',
        layout: { 'line-cap': 'butt', 'line-join': 'round', 'line-sort-key': ['get', 'sk'] },
        paint: { 'line-color': FS_COLOR as never, 'line-width': WIDTH_EXPR(), 'line-offset': WIDTH_EXPR(0.5), 'line-opacity': ['case', ON_STATE, 0.88, 0] as never },
      },
      below,
    );
    map.addLayer({ id: 'flows-hover', type: 'line', source: 'flows', filter: ['==', ['get', 'rk'], -99], layout: { 'line-join': 'round' }, paint: { 'line-color': T.hover, 'line-width': WIDTH_EXPR(1, 2.5), 'line-offset': WIDTH_EXPR(0.5), 'line-opacity': ['case', ON_STATE, 0.5, 0] as never } }, 'flows');
    map.addLayer({ id: 'flows-sel-casing', type: 'line', source: 'flows', filter: ['==', ['get', 'rk'], -99], layout: { 'line-join': 'round' }, paint: { 'line-color': T.lineCasing, 'line-width': WIDTH_EXPR(1, 3), 'line-offset': WIDTH_EXPR(0.5), 'line-opacity': ['case', ON_STATE, 1, 0] as never } }, below);
    map.addLayer({ id: 'flows-sel', type: 'line', source: 'flows', filter: ['==', ['get', 'rk'], -99], layout: { 'line-join': 'round', 'line-sort-key': ['get', 'sk'] }, paint: { 'line-color': FS_COLOR as never, 'line-width': WIDTH_EXPR(1, 0, 1.5), 'line-offset': WIDTH_EXPR(0.5), 'line-opacity': ['case', ON_STATE, 1, 0] as never } }, below);
    // the scenario's new lines (few features: properties, replaced on change)
    map.addSource('newflows', { type: 'geojson', data: emptyFC() });
    map.addLayer({ id: 'newflows-casing', type: 'line', source: 'newflows', filter: ['==', ['get', 'on'], 1], layout: { 'line-join': 'round' }, paint: { 'line-color': T.lineCasing, 'line-width': WIDTH_EXPR(1, 2, 0, ['get', 'w']), 'line-offset': WIDTH_EXPR(0.5, 0, 0, ['get', 'w']) } }, below);
    map.addLayer({ id: 'newflows', type: 'line', source: 'newflows', filter: ['==', ['get', 'on'], 1], layout: { 'line-join': 'round' }, paint: { 'line-color': ['get', 'c'], 'line-width': WIDTH_EXPR(1, 0, 1.5, ['get', 'w']), 'line-offset': WIDTH_EXPR(0.5, 0, 0, ['get', 'w']) } }, below);

    // pending new lines (edited but not yet run): dashed
    map.addSource('pending', { type: 'geojson', data: emptyFC() });
    map.addLayer({ id: 'pending', type: 'line', source: 'pending', layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'c'], 'line-width': 3, 'line-dasharray': [1.5, 1.2], 'line-opacity': 0.9 } }, below);

    // stops
    map.addSource('stops', { type: 'geojson', data: emptyFC() });
    const stopPaint = {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, ['*', ['get', 'r'], 0.45], 14, ['get', 'r'], 17, ['*', ['get', 'r'], 1.8]],
      'circle-color': ['get', 'c'],
      'circle-stroke-color': T.stopStroke,
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 0.6, 15, 1.2],
      'circle-opacity': 0.92,
    } as const;
    map.addLayer({ id: 'stops-bus', type: 'circle', source: 'stops', minzoom: 13.5, filter: ['==', ['get', 'st'], 0], paint: stopPaint as never }, below);
    map.addLayer({ id: 'stops-rail', type: 'circle', source: 'stops', filter: ['==', ['get', 'st'], 1], paint: stopPaint as never }, below);
    map.addSource('selstops', { type: 'geojson', data: emptyFC() });
    map.addLayer({ id: 'selstops', type: 'circle', source: 'selstops', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2, 15, 4.5], 'circle-color': '#ffffff', 'circle-stroke-color': '#0b0b0b', 'circle-stroke-width': 1.5 } });

    // stops the scenario adds (filled ring) or removes (hollow, red)
    map.addSource('stopedits', { type: 'geojson', data: emptyFC() });
    map.addLayer({
      id: 'stopedits',
      type: 'circle',
      source: 'stopedits',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 3, 15, 6.5],
        'circle-color': ['case', ['==', ['get', 'add'], 1], '#ffffff', 'rgba(0,0,0,0)'],
        'circle-stroke-color': ['case', ['==', ['get', 'add'], 1], T.hover, T.down],
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 1.5, 15, 2.5],
      },
    });

    // the line being drawn
    map.addSource('draft', { type: 'geojson', data: emptyFC() });
    map.addLayer({ id: 'draft-casing', type: 'line', source: 'draft', filter: ['==', ['get', 'k'], 'leg'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': T.lineCasing, 'line-width': 8 } });
    map.addLayer({ id: 'draft-line', type: 'line', source: 'draft', filter: ['==', ['get', 'k'], 'leg'], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': ['get', 'c'], 'line-width': 4.5 } });
    map.addLayer({ id: 'draft-ghost', type: 'line', source: 'draft', filter: ['==', ['get', 'k'], 'ghost'], paint: { 'line-color': ['get', 'c'], 'line-width': 2, 'line-dasharray': [2, 2], 'line-opacity': 0.8 } });
    map.addLayer({
      id: 'draft-stops',
      type: 'circle',
      source: 'draft',
      filter: ['==', ['get', 'k'], 'stop'],
      paint: { 'circle-radius': ['case', ['==', ['get', 'end'], 1], 7.5, 6], 'circle-color': ['case', ['==', ['get', 'snap'], 1], '#ffffff', ['get', 'c']], 'circle-stroke-color': ['case', ['==', ['get', 'snap'], 1], ['get', 'c'], '#ffffff'], 'circle-stroke-width': 2.5 },
    });
    map.addLayer({
      id: 'draft-labels',
      type: 'symbol',
      source: 'draft',
      filter: ['==', ['get', 'k'], 'stop'],
      layout: { 'text-field': ['get', 'n'], 'text-font': ['Noto Sans Bold'], 'text-size': 9, 'text-allow-overlap': true },
      paint: { 'text-color': ['case', ['==', ['get', 'snap'], 1], '#0b0b0b', '#ffffff'] },
    });

    this.bindEvents();
    darkMQ.addEventListener('change', () => this.applyTheme());
    this.loaded = true;
    this.fsW = new Float32Array(segs.length).fill(-1);
    this.fsC = new Array(segs.length).fill('');
    this.update(new Set<Key>(['period', 'view', 'result', 'colorBy', 'zoneLayer', 'showStops', 'route', 'draft', 'scenario', 'addStop']));
  }

  /** the page switched between light and dark: repaint the basemap and our own colors */
  applyTheme() {
    const next = THEMES[isDark() ? 'dark' : 'light'];
    if (next === T || !this.loaded) return;
    T = next;
    const map = this.map;
    for (const l of map.getStyle().layers) for (const [k, v] of basePaint(l)) if (map.getLayer(l.id)) map.setPaintProperty(l.id, k as never, v as never);
    for (const id of ['zones-line', 'flows-sel-casing', 'newflows-casing', 'draft-casing']) map.setPaintProperty(id, 'line-color', T.lineCasing);
    for (const id of ['zones-hover', 'flows-hover']) map.setPaintProperty(id, 'line-color', T.hover);
    map.setPaintProperty('flows-idle', 'line-color', T.idle);
    for (const id of ['stops-bus', 'stops-rail']) map.setPaintProperty(id, 'circle-stroke-color', T.stopStroke);
    map.setPaintProperty('stopedits', 'circle-stroke-color', ['case', ['==', ['get', 'add'], 1], T.hover, T.down]);
    this.refreshSpeeds();
    // every segment's color is sent again
    this.fsC.fill('');
    this.update(new Set<Key>(['period', 'showStops', 'zoneLayer']));
  }

  private buildControls() {
    // layers card
    const c = this.controlsEl;
    c.innerHTML = `
      <button class="mc-toggle" aria-expanded="true" aria-controls="mc-body"><span>Map layers</span><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.6"/></svg></button>
      <div class="mc-body" id="mc-body">
        <label class="field"><span>Line color</span>
          <select id="mc-color"><option value="route">Route color</option><option value="mode">Mode</option><option value="crowding">Crowding</option><option value="none">None</option></select></label>
        <label class="field"><span>Areas</span>
          <select id="mc-zone">
            <option value="none">None</option>
            <optgroup label="Today">
              <option value="share">Transit share of residents’ trips</option>
              <option value="jobs45">Jobs within 45 min by transit</option>
              <option value="density">Population density</option>
              <option value="zerocar">Households without a car</option>
            </optgroup>
            <optgroup label="Scenario vs today" id="mc-zone-scen">
              <option value="dshare">Change in transit share</option>
              <option value="daccess">Change in accessibility</option>
              <option value="djobs">Change in jobs within 45 min</option>
            </optgroup>
          </select></label>
        <label class="check"><input type="checkbox" id="mc-stops" checked> Stops sized by boardings</label>
        <label class="check"><input type="checkbox" id="mc-speeds"> Street speeds (cars, weekdays)</label>
        <div class="mc-key" id="mc-key" hidden></div>
      </div>`;
    const tog = c.querySelector<HTMLButtonElement>('.mc-toggle')!;
    tog.onclick = () => {
      const open = tog.getAttribute('aria-expanded') !== 'true';
      tog.setAttribute('aria-expanded', String(open));
      c.classList.toggle('collapsed', !open);
    };
    if (window.matchMedia('(max-width: 900px)').matches) tog.click();
    c.querySelector<HTMLSelectElement>('#mc-color')!.onchange = (e) => set({ colorBy: (e.target as HTMLSelectElement).value as AppState['colorBy'] });
    c.querySelector<HTMLSelectElement>('#mc-zone')!.onchange = (e) => set({ zoneLayer: (e.target as HTMLSelectElement).value as ZoneLayer });
    c.querySelector<HTMLInputElement>('#mc-stops')!.onchange = (e) => set({ showStops: (e.target as HTMLInputElement).checked });
    c.querySelector<HTMLInputElement>('#mc-speeds')!.onchange = (e) => set({ showSpeeds: (e.target as HTMLInputElement).checked });
  }

  // ---------- state → map ----------

  update(ch: Set<Key>) {
    this.syncControls(ch);
    if (!this.loaded) return;
    // the scheme's change event only fires on a rendered frame; catch up on any state change too
    if (THEMES[isDark() ? 'dark' : 'light'] !== T) this.applyTheme();
    const any = (...k: Key[]) => k.some((x) => ch.has(x));
    if (any('period', 'view', 'result', 'colorBy', 'scenario', 'base')) this.refreshFlows();
    if (any('route', 'view', 'result', 'base', 'draft', 'addStop')) this.refreshSelection();
    if (any('zoneLayer', 'view', 'result', 'base')) this.refreshZones();
    if (any('showStops', 'view', 'result', 'base')) this.refreshStops();
    if (any('scenario', 'result', 'view', 'base')) this.refreshPending();
    if (any('draft')) this.refreshDraft();
    if (any('view', 'result', 'base', 'showSpeeds', 'roads', 'period', 'day')) this.refreshSpeeds();
    if (any('scenario')) this.refreshStopEdits();
    if (any('period', 'view', 'result', 'colorBy', 'zoneLayer', 'scenario', 'base', 'showSpeeds', 'roads', 'day')) this.renderLegend();
  }

  private syncControls(ch: Set<Key>) {
    const c = this.controlsEl;
    // the Change view colors lines by the change in riders: its choices are that or None
    const sel = c.querySelector('#mc-color') as HTMLSelectElement;
    const chg = view() === 'change';
    sel.querySelectorAll('option').forEach((o) => {
      if (o.value === 'mode' || o.value === 'crowding') o.hidden = o.disabled = chg;
      if (o.value === 'route') o.textContent = chg ? 'Change in riders' : 'Route color';
    });
    sel.value = chg && state.colorBy !== 'none' ? 'route' : state.colorBy;
    (c.querySelector('#mc-zone') as HTMLSelectElement).value = state.zoneLayer;
    (c.querySelector('#mc-stops') as HTMLInputElement).checked = state.showStops;
    (c.querySelector('#mc-speeds') as HTMLInputElement).checked = state.showSpeeds;
    const scenOk = !!shownResult();
    c.querySelectorAll<HTMLOptionElement>('#mc-zone-scen option').forEach((o) => (o.disabled = !scenOk));
    if (ch.has('result') || ch.has('view') || ch.has('scenario') || ch.has('day')) this.renderViewSwitch();
    if (ch.has('draft') || ch.has('addStop')) this.renderHint();
  }

  /**
   * Street speeds: each street colored by congestion, its speed as a share of its free-flow speed in
   * the selected period (today, or the scenario), or in the Change view by the change in speed,
   * drawn along its true course (road-shapes.bin.gz, fetched with the layer). Weekdays only (the
   * road speeds are weekday speeds).
   */
  private refreshSpeeds() {
    const src = this.map.getSource('speeds') as GeoJSONSource | undefined;
    if (!src) return;
    this.applyTransitOpacity();
    const net = this.engine.roads;
    if (!state.showSpeeds || state.day !== 'wkd') return src.setData(emptyFC());
    if (!net || !this.shapesTried) {
      // the network and the shapes come together; a failed or stale shapes file leaves the bundle's own
      void Promise.all([this.engine.loadRoads(), this.engine.loadRoadShapes()])
        .then(() => {
          this.shapesTried = true;
          set({ roads: state.roads + 1 });
        })
        .catch((e: Error) => console.error(`street speeds: ${e.message}`));
      return src.setData(emptyFC());
    }
    const shapes = this.engine.roadShapes;
    const today = todayTraffic(net);
    const r = shownResult()?.traffic;
    const v = view();
    const p = state.period;
    const dark = T === THEMES.dark;
    const feats: Feature[] = [];
    // two-way streets: each direction is drawn beside the other
    const ends = new Set<number>();
    for (let k = 0; k < net.h.nLinks; k++) if (net.cls[k] > 0) ends.add(net.a[k] * net.h.nNodes + net.b[k]);
    for (let k = 0; k < net.h.nLinks; k++) {
      let g = roadGroup(net.cls[k]);
      if (g < 0) continue;
      let coords = shapes ? shapeCoords(shapes, k) : null;
      if (!coords) {
        coords = [];
        for (let i = net.shapeStart[k]; i < net.shapeStart[k + 1]; i += 2) coords.push([net.shape[i + 1], net.shape[i]]);
      }
      if (coords.length < 2) continue;
      let c: string, o: number, m: number;
      if (v === 'change' && r) {
        const d = linkSpeed(net, r.flow, r.time, p, k) - linkSpeed(net, today.flow, today.time, p, k);
        const j = changeClass(d);
        c = (dark ? CHANGE_COLORS.dark : CHANGE_COLORS.light)[j];
        m = CHANGE_WIDTH[j];
        // bigger changes on top; a local street that changes by 1.5 mph or more shows at city zoom
        o = Math.abs(d) + 10 * (4 - g);
        if (g === LOCAL_GROUP && Math.abs(d) >= 1.5) g = 3;
      } else {
        const fl = v === 'scenario' && r ? r : today;
        const j = congestionClass(congestionShare(net, fl.flow, fl.time, p, k));
        c = (dark ? CONGESTION_COLORS.dark : CONGESTION_COLORS.light)[j];
        m = 1;
        // bigger roads on top, and on each the slower streets
        o = 10 * (4 - g) + j;
      }
      // side by side only for congestion; a change is drawn on the centerline, the bigger one on top
      const tw = v !== 'change' && ends.has(net.b[k] * net.h.nNodes + net.a[k]) ? 1 : 0;
      feats.push({ type: 'Feature', id: k, properties: { k, c, g, m, o, tw }, geometry: { type: 'LineString', coordinates: coords } });
    }
    src.setData({ type: 'FeatureCollection', features: feats });
  }
  private shapesTried = false;

  /**
   * Transit lines and stops: hidden when the line color is None, faded while the street speeds are
   * shown so the streets show through, and dimmed behind a selected route or a line being drawn.
   */
  private applyTransitOpacity() {
    const map = this.map;
    if (!map.getLayer('flows')) return;
    const none = state.colorBy === 'none';
    const fade = state.showSpeeds && state.day === 'wkd' ? 0.25 : 1;
    const r = state.route ? this.m.routeByKey.get(state.route) : null;
    for (const id of ['flows', 'flows-idle', 'flows-hover', 'newflows', 'newflows-casing']) map.setLayoutProperty(id, 'visibility', none || (id === 'flows-idle' && view() === 'change') ? 'none' : 'visible');
    const dim = r ? 0.16 : state.draft ? 0.3 : 0.88 * fade;
    map.setPaintProperty('flows', 'line-opacity', ['case', ON_STATE, dim, 0] as never);
    map.setPaintProperty('flows-idle', 'line-opacity', ['case', ON_STATE, 0, (r ? 0.15 : 0.45) * fade] as never);
    map.setPaintProperty('newflows', 'line-opacity', r ? 0.25 : fade);
    map.setPaintProperty('newflows-casing', 'line-opacity', r ? 0.25 : fade);
    for (const id of ['stops-bus', 'stops-rail']) {
      map.setPaintProperty(id, 'circle-opacity', 0.92 * (fade < 1 ? 0.5 : 1));
      map.setPaintProperty(id, 'circle-stroke-opacity', fade < 1 ? 0.5 : 1);
    }
  }

  /** a street's speed, free-flow speed, and traffic, today and in the scenario, for the tooltip */
  private speedTip(k: number): string {
    const net = this.engine.roads!;
    const today = todayTraffic(net);
    const r = shownResult()?.traffic;
    const p = state.period;
    const name = net.name[k] >= 0 ? net.h.names[net.name[k]] : net.cls[k] === 2 ? 'Freeway ramp' : net.cls[k] === 1 ? 'Freeway' : 'Unnamed street';
    const s0 = linkSpeed(net, today.flow, today.time, p, k);
    const ff = freeFlowSpeed(net, today.flow, p, k);
    const v0 = linkVolume(today.flow, p, k);
    const unit = p === 'day' ? 'cars a day' : 'cars an hour';
    const pc = (x: number) => `${Math.round(100 * Math.min(1, x))}%`;
    let h = `<div class="tip-h">${esc(name)}</div><div class="tip-sub">${PERIOD_SHORT[p]}${p === 'day' ? ', weighted by traffic' : ''} · one direction</div>`;
    h += `<div class="tip-row"><span>Speed today</span><b>${s0.toFixed(1)} mph (${pc(s0 / ff)} of free flow)</b></div>`;
    if (r) {
      const s1 = linkSpeed(net, r.flow, r.time, p, k);
      const ff1 = freeFlowSpeed(net, r.flow, p, k);
      h += `<div class="tip-row"><span>Scenario</span><b>${s1.toFixed(1)} mph (${pc(s1 / ff1)})</b></div><div class="tip-row"><span>Change</span><b>${s1 - s0 >= 0 ? '+' : '−'}${Math.abs(s1 - s0).toFixed(1)} mph</b></div>`;
    }
    h += `<div class="tip-row"><span>Free-flow speed</span><b>${ff.toFixed(1)} mph</b></div>`;
    if (r) h += `<div class="tip-row"><span>Traffic today → scenario</span><b>${compact(v0)} → ${compact(linkVolume(r.flow, p, k))} ${unit}</b></div>`;
    else h += `<div class="tip-row"><span>Traffic</span><b>${compact(v0)} ${unit}</b></div>`;
    return h;
  }

  private renderViewSwitch() {
    const el = this.viewEl;
    if (!shownResult()) {
      // a result for another day: offer to go back to it rather than hide it silently
      const rd = state.resultScenario?.day ?? 'wkd';
      el.hidden = !state.result;
      el.innerHTML = state.result ? `<button class="map-chip" type="button">Scenario results are for ${DAY_LABEL[rd] === 'Weekday' ? 'a weekday' : DAY_LABEL[rd]}: show them</button>` : '';
      const b = el.querySelector('button');
      if (b) b.onclick = () => this.hooks.setDay(rd);
      return;
    }
    el.hidden = false;
    const opts: [AppState['view'], string][] = [
      ['base', 'Today'],
      ['scenario', 'Scenario'],
      ['change', 'Change'],
    ];
    el.innerHTML = `<div class="seg" role="radiogroup" aria-label="Network shown on the map">${opts.map(([v, l]) => `<button role="radio" aria-checked="${state.view === v}" data-v="${v}">${l}</button>`).join('')}</div>`;
    el.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = () => set({ view: b.dataset.v as AppState['view'] })));
  }

  private renderHint() {
    const d = state.draft;
    const add = !d && state.addStop ? this.m.routeByKey.get(state.addStop) : undefined;
    this.hintEl.hidden = !d && !add;
    this.map.getCanvas().style.cursor = d || add ? 'crosshair' : '';
    if (add) {
      this.hintEl.innerHTML = `<b>Adding stops to the ${esc(add.label)}</b>. Click its line to place a stop. Press Esc when done.`;
      return;
    }
    if (!d) return;
    const P = PROFILES[d.profile];
    this.hintEl.innerHTML = `<b>Drawing a ${esc(P.label.toLowerCase())} line.</b> Click the map to add stops. ${matchMedia('(pointer:fine)').matches ? 'Drag a stop to move it, click it to remove it, or click the line to insert one.' : 'Tap a stop to remove it.'}`;
  }

  /** the result shown on the map, and the scenario it belongs to */
  private shown(): { r: RunResult; s: Scenario | null; base: RunResult } {
    const base = state.base;
    const r = shownResult();
    if (view() !== 'base' && r) return { r, s: state.resultScenario, base };
    return { r: base, s: null, base };
  }

  private refreshFlows() {
    const { r, s, base } = this.shown();
    const p = state.period;
    const hours = hoursOf(p);
    const change = view() === 'change';
    const day = state.day;
    const m = this.m;
    const map = this.map;
    // in the change view, an unchanged segment is not "no service" (flows-idle is hidden there)
    this.applyTransitOpacity();
    for (const seg of m.segs) {
      const route = m.routes[seg.route];
      const load = segLoad(m, r, seg, p);
      let w: number, c: string;
      if (change) {
        const d = (load - segLoad(m, base, seg, p)) / hours;
        w = Math.abs(d) >= 3 ? changeWidth(d) : 0;
        c = d > 0 ? T.up : T.down;
      } else {
        const svc = segService(m, seg, p, s, day);
        w = svc.trips > 0 && load > 0.5 ? flowWidth(load / hours) : 0;
        c = state.colorBy === 'mode' ? LINE_GROUP_COLOR[route.group] : state.colorBy === 'crowding' ? crowdColor(maxLf(m, r, seg, p, s, day)) : themed(route.color);
      }
      const i = seg.id;
      if (Math.abs(this.fsW[i] - w) > 0.02 || this.fsC[i] !== c) {
        this.fsW[i] = w;
        this.fsC[i] = c;
        map.setFeatureState({ source: 'flows', id: i }, { w, c, on: w > 0 ? 1 : 0 });
      }
    }
    // scenario lines
    this.newSegs = [];
    const feats: Feature[] = [];
    const shownRes = shownResult();
    if (view() !== 'base' && shownRes && state.resultScenario) {
      const { added } = lineIndex(shownRes);
      newLines(state.resultScenario).forEach((e, k) => {
        const lrs = added.get(k) ?? [];
        const n = e.stops.length - 1;
        const dirs = e.bothDirections ? [false, true] : [false];
        dirs.forEach((rev, di) => {
          const lr = lrs[di];
          for (let h = 0; h < n; h++) {
            const fh = rev ? n - 1 - h : h; // the forward hop this one runs over
            let coords = pathSlice(e.path, e.stopAt[fh], e.stopAt[fh + 1]);
            if (rev) coords = [...coords].reverse();
            let load = 0, cap = 0;
            for (const q of periodsOf(p)) {
              load += lr?.loads[q]?.[h] ?? 0;
              const hw = e.headway[q];
              if (hw > 0) cap += ((hoursOf(q) * 60) / hw) * (NEW_CAP[e.mode] ?? 94);
            }
            const id = m.segs.length + this.newSegs.length;
            this.newSegs.push({ edit: e, k, rev, hop: h, lineHop: fh });
            const w = change ? changeWidth(load / hours) : flowWidth(load / hours);
            const c = change ? T.up : state.colorBy === 'mode' ? LINE_GROUP_COLOR[lineGroup(e.mode)] : state.colorBy === 'crowding' ? crowdColor(cap > 0 ? load / cap : 0) : themed(e.color);
            feats.push({ type: 'Feature', id, properties: { id, rk: 10000 + k, w, c, on: load > 0.5 ? 1 : 0 }, geometry: { type: 'LineString', coordinates: coords } });
          }
        });
      });
    }
    // existing routes extended beyond a terminus: the hops that reach the extension's stops
    this.extSegs = [];
    const sc = state.resultScenario;
    if (view() !== 'base' && shownRes && sc && sc.edits.some((e) => e.kind === 'extend')) {
      const H = m.bundle.header;
      const ext = new Set<number>();
      for (const e of sc.edits) if (e.kind === 'extend') for (const i of extendStopIndices(m, sc, e)) ext.add(i);
      const agg = new Map<string, { route: number; a: number; b: number; load: number; cap: number }>();
      for (const lr of shownRes.lines) {
        if (lr.line < 0 || !lr.stops) continue;
        const line = H.lines[lr.line];
        for (let h = 0; h + 1 < lr.stops.length; h++) {
          const a = lr.stops[h], b = lr.stops[h + 1];
          if (!ext.has(a) && !ext.has(b)) continue;
          const key = `${m.lineRoute[lr.line]}|${a}|${b}`;
          let g = agg.get(key);
          if (!g) agg.set(key, (g = { route: m.lineRoute[lr.line], a, b, load: 0, cap: 0 }));
          for (const q of periodsOf(p)) {
            g.load += lr.loads[q]?.[h] ?? 0;
            g.cap += scenTrips(line, q, sc, day) * line.cap;
          }
        }
      }
      for (const g of agg.values()) {
        const A = stopInfo(m, sc, g.a), B = stopInfo(m, sc, g.b);
        if (!A || !B) continue;
        const route = m.routes[g.route];
        const id = m.segs.length + this.newSegs.length + this.extSegs.length;
        this.extSegs.push(g);
        const w = change ? changeWidth(g.load / hours) : flowWidth(g.load / hours);
        const c = change ? T.up : state.colorBy === 'mode' ? LINE_GROUP_COLOR[route.group] : state.colorBy === 'crowding' ? crowdColor(g.cap > 0 ? g.load / g.cap : 0) : themed(route.color);
        feats.push({ type: 'Feature', id, properties: { id, rk: g.route, w, c, on: g.load > 0.5 ? 1 : 0 }, geometry: { type: 'LineString', coordinates: [[A.lon, A.lat], [B.lon, B.lat]] } });
      }
    }
    (map.getSource('newflows') as GeoJSONSource).setData({ type: 'FeatureCollection', features: feats });
  }

  private refreshSelection() {
    const map = this.map;
    const r = state.route ? this.m.routeByKey.get(state.route) : null;
    const rk = r ? r.index : -99;
    map.setFilter('flows-sel', ['==', ['get', 'rk'], rk]);
    map.setFilter('flows-sel-casing', ['==', ['get', 'rk'], rk]);
    // a selected route, or a line being drawn, stands out against the rest of the network
    this.applyTransitOpacity();
    const H = this.m.bundle.header;
    const feats: Feature[] = [];
    if (r) {
      const seen = new Set<number>();
      for (const li of r.patterns) for (const s of H.lines[li].stops) if (!seen.has(s)) seen.add(s), feats.push(point(H.stops[s].lon, H.stops[s].lat, { i: s }));
    }
    (map.getSource('selstops') as GeoJSONSource).setData({ type: 'FeatureCollection', features: feats });
  }

  private refreshStops() {
    const map = this.map;
    const vis = state.showStops ? 'visible' : 'none';
    map.setLayoutProperty('stops-bus', 'visibility', vis);
    map.setLayoutProperty('stops-rail', 'visibility', vis);
    if (!state.showStops) return;
    const { r, s, base } = this.shown();
    const change = view() === 'change';
    const H = this.m.bundle.header;
    const feats: Feature[] = [];
    const n = r.stopOn.length;
    for (let i = 0; i < n; i++) {
      const v = r.stopOn[i] + r.stopOff[i];
      const info = stopInfo(this.m, s, i);
      if (!info) continue;
      const station = i < H.stops.length ? H.stops[i].station : true;
      if (change) {
        const b = i < base.stopOn.length ? base.stopOn[i] + base.stopOff[i] : 0;
        const d = v - b;
        if (Math.abs(d) < 20) continue;
        feats.push(point(info.lon, info.lat, { i, st: station ? 1 : 0, r: 1.5 + 0.09 * Math.sqrt(Math.abs(d)), c: d > 0 ? T.up : T.down }));
      } else {
        if (v < 1 && !station) continue;
        feats.push(point(info.lon, info.lat, { i, st: station ? 1 : 0, r: 1.6 + 0.075 * Math.sqrt(v), c: '#ffffff' }));
      }
    }
    // biggest first so small stops draw on top
    feats.sort((a, b) => (b.properties!.r as number) - (a.properties!.r as number));
    (map.getSource('stops') as GeoJSONSource).setData({ type: 'FeatureCollection', features: feats });
  }

  private refreshZones() {
    const map = this.map;
    let layer = state.zoneLayer;
    if (layer !== 'none' && ZONE_METRICS[layer].scenario && !shownResult()) layer = 'none';
    const vis = layer === 'none' ? 'none' : 'visible';
    map.setLayoutProperty('zones-fill', 'visibility', vis);
    map.setLayoutProperty('zones-line', 'visibility', vis);
    // buildings draw above the zone colors and, being the page's own gray, would hide them where they
    // are dense: fade them while a zone layer is on
    for (const l of map.getStyle().layers ?? []) {
      if (l.type === 'fill' && (l as { 'source-layer'?: string })['source-layer'] === 'building') map.setPaintProperty(l.id, 'fill-opacity', layer === 'none' ? 1 : 0.18);
    }
    if (layer === 'none') return;
    const metric = ZONE_METRICS[layer];
    const vals = this.zoneValues(layer);
    this.zoneFC.features.forEach((f: Feature, i: number) => {
      const v = vals[i];
      f.properties = { v: v ?? 0, nd: v === null ? 1 : 0 };
    });
    let breaks: number[], colors: string[];
    if (metric.diverging) {
      const abs = vals.filter((v): v is number => v !== null).map(Math.abs).sort((a, b) => a - b);
      const top = abs[Math.floor(abs.length * 0.97)] || 1e-6;
      const nice = niceUp(top);
      breaks = [-nice, -nice / 3, -nice / 12, nice / 12, nice / 3, nice];
      colors = T.div;
    } else {
      breaks = metric.breaks!;
      colors = T.seq;
    }
    this.zoneBreaks = breaks;
    const step: unknown[] = ['step', ['get', 'v'], colors[0]];
    breaks.forEach((b, j) => step.push(b, colors[j + 1]));
    map.setPaintProperty('zones-fill', 'fill-color', ['case', ['==', ['get', 'nd'], 1], 'rgba(0,0,0,0)', step] as never);
    (map.getSource('zones') as GeoJSONSource).setData(this.zoneFC);
  }

  zoneValues(layer: Exclude<ZoneLayer, 'none'>): (number | null)[] {
    const H = this.m.bundle.header;
    const base = state.base;
    const r = shownResult();
    return H.zones.map((z, i) => {
      switch (layer) {
        case 'share':
          return z.pop > 50 ? (view() !== 'base' && r ? r : base).zoneTransitShare[i] : null;
        case 'jobs45':
          return z.pop > 50 ? (view() !== 'base' && r ? r : base).zoneJobs45[i] : null;
        case 'density':
          return z.land > 0 ? z.pop / (z.land / 2_589_988) : null;
        case 'zerocar':
          return z.hh > 20 ? z.hhVeh[0] / z.hh : null;
        case 'dshare':
          return r && z.pop > 50 ? r.zoneTransitShare[i] - base.zoneTransitShare[i] : null;
        case 'daccess':
          return r && z.pop > 50 ? r.zoneLogsum[i] - base.zoneLogsum[i] : null;
        case 'djobs':
          return r && z.pop > 50 ? r.zoneJobs45[i] - base.zoneJobs45[i] : null;
      }
    });
  }

  private refreshPending() {
    // new lines in the scenario that the shown result doesn't include yet: dashed preview
    const shownIds = new Set(view() !== 'base' && state.resultScenario ? newLines(state.resultScenario).map((e) => e.id) : []);
    const feats: Feature[] = [];
    // route extensions not in the shown result: dashed in the route's color
    const shownExt = new Set(view() !== 'base' && state.resultScenario ? state.resultScenario.edits.filter((e) => e.kind === 'extend').map((e) => JSON.stringify(e)) : []);
    for (const e of state.scenario.edits) {
      if (e.kind !== 'extend' || shownExt.has(JSON.stringify(e))) continue;
      const r = this.m.routes.find((x) => x.feed === e.feed && x.members.includes(e.route));
      const H = this.m.bundle.header;
      const coords: [number, number][] = [[H.stops[e.from].lon, H.stops[e.from].lat], ...e.stops.map((st): [number, number] => ('stop' in st ? [H.stops[st.stop].lon, H.stops[st.stop].lat] : [st.lon, st.lat]))];
      feats.push({ type: 'Feature', properties: { c: themed(r?.color ?? '#666666') }, geometry: { type: 'LineString', coordinates: coords } });
    }
    for (const e of newLines(state.scenario)) {
      if (shownIds.has(e.id) || (state.draft && state.draft.id === e.id)) continue;
      const coords: [number, number][] = [];
      for (let i = 0; i < e.path.length; i += 2) coords.push([e.path[i + 1], e.path[i]]);
      feats.push({ type: 'Feature', properties: { c: e.color }, geometry: { type: 'LineString', coordinates: coords } });
    }
    (this.map.getSource('pending') as GeoJSONSource).setData({ type: 'FeatureCollection', features: feats });
  }

  private refreshStopEdits() {
    const H = this.m.bundle.header;
    const feats: Feature[] = [];
    const seen = new Set<number>();
    for (const e of state.scenario.edits) {
      if (e.kind === 'addStop') feats.push(point(e.lon, e.lat, { add: 1 }));
      if (e.kind === 'extend') for (const st of e.stops) if (!('stop' in st)) feats.push(point(st.lon, st.lat, { add: 1 }));
      if (e.kind === 'removeStop' && !seen.has(e.stop) && H.stops[e.stop]) seen.add(e.stop), feats.push(point(H.stops[e.stop].lon, H.stops[e.stop].lat, { add: 0 }));
    }
    (this.map.getSource('stopedits') as GeoJSONSource).setData({ type: 'FeatureCollection', features: feats });
  }

  refreshDraft(ghost?: [number, number]) {
    const d = state.draft;
    const feats: Feature[] = [];
    if (d) {
      d.legs.forEach((leg, k) => {
        const coords: [number, number][] = [];
        for (let i = 0; i < leg.path.length; i += 2) coords.push([leg.path[i + 1], leg.path[i]]);
        feats.push({ type: 'Feature', properties: { k: 'leg', c: d.color, leg: k }, geometry: { type: 'LineString', coordinates: coords } });
      });
      if (ghost && d.stops.length) {
        const last = d.stops[d.stops.length - 1];
        feats.push({ type: 'Feature', properties: { k: 'ghost', c: d.color }, geometry: { type: 'LineString', coordinates: [[last.lon, last.lat], ghost] } });
      }
      d.stops.forEach((s, i) => feats.push(point(s.lon, s.lat, { k: 'stop', i, c: d.color, snap: s.stop !== undefined ? 1 : 0, n: String(i + 1), end: i === 0 || i === d.stops.length - 1 ? 1 : 0 })));
    }
    (this.map.getSource('draft') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: feats });
    if (!ghost) this.refreshPending();
  }

  // ---------- legend ----------

  private renderLegend() {
    const p = state.period;
    const change = view() === 'change';
    const day = p === 'day';
    const unit = day ? 'riders per day' : 'riders per hour';
    const samples = change ? [50, 250, 1000] : [100, 1000, 5000];
    const widthOf = (v: number) => (change ? changeWidth(v) : flowWidth(v));
    const z = this.map.getZoom();
    const zf = z <= 12 ? 0.35 + ((1 - 0.35) * (z - 10)) / 2 : 1 + (0.9 * (z - 12)) / 2;
    const scale = Math.max(0.35, Math.min(2.5, zf));
    let h = `<div class="lg-title">${change ? 'Change in riders on each segment' : 'Riders on each segment'}</div><div class="lg-sub">${DAY_LABEL[state.day]} · ${PERIOD_SHORT[p]}${day ? '' : ', average hour'}</div><div class="lg-widths">`;
    const transit = state.colorBy !== 'none';
    for (const v of transit ? samples : []) {
      const shownV = day ? v * 24 : v;
      h += `<span class="lw"><svg width="34" height="${Math.max(4, widthOf(v) * scale + 4)}"><line x1="2" x2="32" y1="50%" y2="50%" style="stroke:${change ? T.up : 'var(--ink-2)'}" stroke-width="${Math.max(1, widthOf(v) * scale)}"/></svg>${compact(shownV)}</span>`;
    }
    h += `</div><div class="lg-sub">${unit}</div>`;
    if (change) h += `<div class="lg-keys"><span class="li"><span class="sw" style="background:${T.up}"></span>More riders</span><span class="li"><span class="sw" style="background:${T.down}"></span>Fewer riders</span></div>`;
    else if (state.colorBy === 'mode') h += `<div class="lg-keys">${LINE_GROUPS.map((g) => `<span class="li"><span class="sw" style="background:${LINE_GROUP_COLOR[g]}"></span>${LINE_GROUP_LABEL[g]}</span>`).join('')}</div>`;
    else if (state.colorBy === 'crowding') h += `<div class="lg-keys">${CROWD_COLORS.map((c, i) => `<span class="li"><span class="sw" style="background:${c}"></span>${CROWD_LABELS[i]}</span>`).join('')}</div>${day ? '<div class="lg-sub">All day: each segment’s most crowded period</div>' : ''}`;
    else h += `<div class="lg-sub">Colored by each operator’s route color. Dashed gray: no service in this period.</div>`;
    // Line color None: no transit lines, so no key for them
    if (!transit) h = '';
    let layer = state.zoneLayer;
    if (layer !== 'none' && ZONE_METRICS[layer].scenario && !shownResult()) layer = 'none';
    if (layer !== 'none') {
      const metric = ZONE_METRICS[layer];
      const b = this.zoneBreaks;
      const cols = metric.diverging ? T.div : T.seq;
      h += `<div class="lg-title lg-gap">${esc(metric.label)}</div><div class="lg-ramp">${cols.map((c) => `<span style="background:${c}"></span>`).join('')}</div><div class="lg-ramp-l">${b.map((x, j) => `<span style="left:${(((j + 1) / cols.length) * 100).toFixed(2)}%">${(metric.tick ?? metric.fmt)(x)}</span>`).join('')}</div><div class="lg-sub">${esc(metric.unit)}${metric.scenario ? ' · scenario minus today' : view() !== 'base' && (layer === 'share' || layer === 'jobs45') ? ' · scenario' : ''}</div>`;
    }
    this.controlsEl.querySelector<HTMLElement>('#mc-key')!.hidden = true;
    if (state.showSpeeds && state.day === 'wkd') {
      const dark = T === THEMES.dark;
      const ch = change && !!shownResult()?.traffic;
      const cols = ch ? (dark ? CHANGE_COLORS.dark : CHANGE_COLORS.light) : dark ? CONGESTION_COLORS.dark : CONGESTION_COLORS.light;
      const keys = ch
        ? cols.map((c, i) => `<span class="li"><span class="sw sw-line" style="background:${c};height:${Math.max(2, Math.round(2.4 * CHANGE_WIDTH[i]))}px"></span>${CHANGE_LABELS[i]}</span>`)
        : cols.map((c, i) => `<span class="li"><span class="sw" style="background:${c}"></span>${CONGESTION_LABELS[i]}</span>`);
      const title = ch ? 'Change in street speed, mph' : 'Street speed, share of free flow';
      const sub = ch ? 'Cars · scenario minus today' : `Cars · 100% is the speed on an empty street${view() === 'scenario' && shownResult() ? ' · scenario' : ' · today'}`;
      const key = this.controlsEl.querySelector<HTMLElement>('#mc-key')!;
      key.hidden = false;
      key.innerHTML = `<div class="mc-ramp">${cols.map((c) => `<span style="background:${c}"></span>`).join('')}</div><div class="mc-ends">${ch ? '<span>Faster</span><span>Slower</span>' : '<span>Free flow</span><span>Slowest</span>'}</div>`;
      h += `<div class="lg-title lg-gap">${title}</div><div class="lg-keys">${keys.join('')}</div><div class="lg-sub">${sub} · ${PERIOD_SHORT[p]}${p === 'day' ? ', weighted by traffic' : ''}${this.engine.roads ? '' : ' · loading the streets…'}</div>`;
    }
    this.legendEl.innerHTML = h.replace(/^<div class="lg-title lg-gap">/, '<div class="lg-title">');
    this.legendEl.hidden = !h;
  }

  // ---------- interaction ----------

  private bindEvents() {
    const map = this.map;
    map.on('zoomend', () => this.renderLegend());
    map.on('mousemove', (e) => {
      this.lastMove = e;
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        if (this.lastMove) this.onHover(this.lastMove);
      });
    });
    map.getCanvas().addEventListener('mouseleave', () => {
      hideTip();
      this.setHoverRoute(-2);
      if (state.draft) this.refreshDraft();
    });
    map.on('click', (e) => this.onClick(e));
    map.on('mousedown', 'draft-stops', (e) => {
      if (!state.draft || e.originalEvent.button !== 0) return;
      const f = e.features?.[0];
      if (!f) return;
      e.preventDefault();
      this.dragging = { i: f.properties!.i as number, moved: false };
      map.dragPan.disable();
    });
    map.on('mouseup', (e) => {
      const d = this.dragging;
      if (!d) return;
      this.dragging = null;
      map.dragPan.enable();
      const dr = state.draft;
      if (!dr) return;
      if (d.moved) draftMoveStop(this.m, dr, d.i, e.lngLat.lat, e.lngLat.lng);
      else draftRemoveStop(dr, d.i);
      this.suppressClick = true;
      this.draftChanged();
    });
  }
  private suppressClick = false;

  private draftChanged() {
    touch('draft');
    this.refreshDraft();
  }

  private query(e: MapMouseEvent, layers: string[], pad = 4): MapGeoJSONFeature[] {
    const live = layers.filter((l) => this.map.getLayer(l) && this.map.getLayoutProperty(l, 'visibility') !== 'none');
    if (!live.length) return [];
    return this.map
      .queryRenderedFeatures(
        [
          [e.point.x - pad, e.point.y - pad],
          [e.point.x + pad, e.point.y + pad],
        ],
        { layers: live },
      )
      .filter((f) => f.source !== 'flows' || f.state?.on === 1);
  }

  private onHover(e: MapMouseEvent) {
    const d = state.draft;
    const { clientX: x, clientY: y } = e.originalEvent;
    if (d) {
      if (this.dragging) {
        const dr = this.dragging;
        dr.moved = true;
        const s = d.stops[dr.i];
        s.lat = e.lngLat.lat;
        s.lon = e.lngLat.lng;
        s.stop = undefined;
        // straight preview while dragging; the legs are re-routed on release
        for (const k of [dr.i - 1, dr.i]) if (k >= 0 && k + 1 < d.stops.length) d.legs[k] = { path: [d.stops[k].lat, d.stops[k].lon, d.stops[k + 1].lat, d.stops[k + 1].lon], meters: 0, streets: false };
        this.refreshDraft();
        hideTip();
        return;
      }
      const onStop = this.query(e, ['draft-stops'], 3)[0];
      const snap = nearestStop(this.m, e.lngLat.lat, e.lngLat.lng, 60);
      if (onStop) showTip(`Stop ${(onStop.properties!.i as number) + 1}: ${esc(d.stops[onStop.properties!.i as number].name)}<div class="tip-sub">${matchMedia('(pointer:fine)').matches ? 'Drag to move · click to remove' : 'Tap to remove'}</div>`, x, y);
      else if (snap) showTip(`Snap to <b>${esc(this.m.bundle.header.stops[snap.i].name)}</b><div class="tip-sub">${OPERATOR_LABEL[this.m.bundle.header.stops[snap.i].feed] ?? ''} stop, ${Math.round(snap.d)} m away</div>`, x, y);
      else hideTip();
      this.refreshDraft(d.stops.length ? [e.lngLat.lng, e.lngLat.lat] : undefined);
      return;
    }
    const f = this.query(e, ['selstops', 'stops-rail', 'stops-bus'], 2)[0] ?? null;
    if (f) {
      this.map.getCanvas().style.cursor = '';
      this.setHoverRoute(-2);
      showTip(this.stopTip(f.properties!.i as number), x, y);
      return;
    }
    // while the streets are shown (and the transit lines faded), a street under the pointer comes
    // before a transit line, except the selected route
    const speedsOn = state.showSpeeds && state.day === 'wkd' && !!this.engine.roads;
    const sf = speedsOn && !(state.route && this.query(e, ['flows-sel'], 3).length) ? this.query(e, ['speeds', 'speeds-local'], 3)[0] : undefined;
    if (sf) {
      this.map.getCanvas().style.cursor = '';
      this.setHoverRoute(-2);
      this.map.setFilter('zones-hover', ['==', ['id'], -1]);
      showTip(this.speedTip(sf.properties!.k as number), x, y);
      return;
    }
    const fl = this.query(e, state.route ? ['flows-sel', 'newflows', 'flows'] : ['newflows', 'flows'], 3);
    if (fl.length) {
      // prefer the selected route, then the thinnest line on top
      const sel = state.route ? this.m.routeByKey.get(state.route)?.index : undefined;
      const pick = fl.find((x) => x.properties!.rk === sel) ?? fl[0];
      this.map.getCanvas().style.cursor = 'pointer';
      this.setHoverRoute(pick.properties!.rk as number);
      const others = new Set(fl.map((x) => x.properties!.rk as number));
      showTip(this.segTip(pick.properties!.id as number, others.size - 1), x, y);
      return;
    }
    this.map.getCanvas().style.cursor = '';
    this.setHoverRoute(-2);
    const z = this.query(e, ['zones-fill'], 0)[0];
    if (z) {
      this.map.setFilter('zones-hover', ['==', ['id'], z.id as number]);
      showTip(this.zoneTip(z.id as number), x, y);
    } else {
      this.map.setFilter('zones-hover', ['==', ['id'], -1]);
      hideTip();
    }
  }

  private setHoverRoute(rk: number) {
    if (rk === this.hoverRoute) return;
    this.hoverRoute = rk;
    this.map.setFilter('flows-hover', ['==', ['get', 'rk'], rk]);
  }

  private onClick(e: MapMouseEvent) {
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    if (state.addStop && !state.draft) {
      this.hooks.addStopAt(e.lngLat.lat, e.lngLat.lng);
      return;
    }
    const d = state.draft;
    if (d) {
      const onStop = this.query(e, ['draft-stops'], 4)[0];
      if (onStop) {
        // touch devices: tap a stop to remove it (mouse users get this on mouseup)
        if (!matchMedia('(pointer:fine)').matches) {
          draftRemoveStop(d, onStop.properties!.i as number);
          this.draftChanged();
        }
        return;
      }
      const onLeg = this.query(e, ['draft-line'], 4)[0];
      const at = onLeg ? (onLeg.properties!.leg as number) + 1 : d.stops.length;
      draftAddStop(this.m, d, at, e.lngLat.lat, e.lngLat.lng);
      this.draftChanged();
      if (PROFILES[d.profile].streets && !d.legs.every((l) => l.streets) && d.stops.length > 1)
        void streetGraph().then((g) => {
          if (g && state.draft === d) {
            relegAll(d);
            this.draftChanged();
          }
        });
      return;
    }
    const fl = this.query(e, state.route ? ['flows-sel', 'newflows', 'flows'] : ['newflows', 'flows'], 3);
    if (fl.length) {
      const sel = state.route ? this.m.routeByKey.get(state.route)?.index : undefined;
      const pick = fl.find((x) => x.properties!.rk === sel) ?? fl[0];
      const rk = pick.properties!.rk as number;
      if (rk >= 10000) set({ tab: 'results' });
      else this.hooks.selectRoute(this.m.routes[rk].key);
      return;
    }
    if (state.route && !this.query(e, ['stops-rail', 'stops-bus', 'selstops'], 2).length) this.hooks.selectRoute(null);
  }

  // ---------- tooltips ----------

  private segTip(id: number, others: number): string {
    const m = this.m;
    const p = state.period;
    const hours = hoursOf(p);
    const { r, s, base } = this.shown();
    const change = view() === 'change';
    const per = p === 'day' ? `per ${DAY_NOUN[state.day]}` : 'per hour';
    const div = p === 'day' ? 1 : hours;
    const more = others > 0 ? `<div class="tip-sub">+${others} more route${others > 1 ? 's' : ''} here</div>` : '';
    if (id >= m.segs.length + this.newSegs.length) {
      const g = this.extSegs[id - m.segs.length - this.newSegs.length];
      const sc = state.resultScenario;
      if (!g || !sc) return '';
      const route = m.routes[g.route];
      const A = stopInfo(m, sc, g.a), B = stopInfo(m, sc, g.b);
      return `<div class="tip-h"><span class="sw" style="background:${route.color}"></span>${esc(routeTitle(route))} <span class="tip-tag">extension</span></div><div class="tip-sub">${esc(A?.name ?? '')} → ${esc(B?.name ?? '')}</div><div class="tip-row"><span>${change ? 'Riders (all new)' : 'Riders on board'}</span><b>${int(g.load / div)} ${per}</b></div>${more}<div class="tip-sub">Click to open the route</div>`;
    }
    if (id >= m.segs.length) {
      const ns = this.newSegs[id - m.segs.length];
      if (!ns) return '';
      const e = ns.edit;
      const stops = e.stops.map((st) => ('stop' in st ? m.bundle.header.stops[st.stop].name : (st.name ?? 'New stop')));
      const a = ns.rev ? stops[ns.lineHop + 1] : stops[ns.lineHop], b = ns.rev ? stops[ns.lineHop] : stops[ns.lineHop + 1];
      const lrs = lineIndex(shownResult()!).added.get(ns.k) ?? [];
      const lr = lrs[ns.rev ? 1 : 0];
      let load = 0;
      for (const q of periodsOf(p)) load += lr?.loads[q]?.[ns.hop] ?? 0;
      return `<div class="tip-h"><span class="sw" style="background:${e.color}"></span>${esc(e.name)} <span class="tip-tag">new</span></div><div class="tip-sub">${esc(a)} → ${esc(b)}</div><div class="tip-row"><span>${change ? 'Riders (all new)' : 'Riders on board'}</span><b>${int(load / div)} ${per}</b></div><div class="tip-row"><span>Service</span><b>${e.headway[p === 'day' ? 'AM' : p] ? `every ${e.headway[p === 'day' ? 'AM' : p]} min` : 'none'}</b></div>${more}`;
    }
    const seg = m.segs[id];
    const route = m.routes[seg.route];
    const H = m.bundle.header;
    const line = H.lines[seg.parts[0].line];
    const load = segLoad(m, r, seg, p);
    const svc = segService(m, seg, p, s, state.day);
    let h = `<div class="tip-h"><span class="sw" style="background:${route.color}"></span>${esc(routeTitle(route))}</div><div class="tip-sub">toward ${esc(line.headsign)} · ${esc(H.stops[seg.a].name)} → ${esc(H.stops[seg.b].name)}</div>`;
    if (change) {
      // the segment under the cursor (one direction), then the whole route, as the route panel counts it
      const b = segLoad(m, base, seg, p);
      const rb = routeStats(m, base).get(route.index)?.day ?? 0, rs = routeStats(m, r).get(route.index)?.day ?? 0;
      h += `<div class="tip-sec">On board between these stops, this direction</div><div class="tip-row"><span>Today</span><b>${int(b / div)} ${per}</b></div><div class="tip-row"><span>Scenario</span><b>${int(load / div)} ${per}</b></div><div class="tip-row"><span>Change</span><b>${signedInt((load - b) / div)}${b > 0 ? ` (${pct((load - b) / b)})` : ''}</b></div>`;
      h += `<div class="tip-sec">Riders on the whole route (boardings, both directions)</div><div class="tip-row"><span>Today → scenario</span><b>${int(rb)} → ${int(rs)} per ${DAY_NOUN[state.day]}</b></div><div class="tip-row"><span>Change</span><b>${signedInt(rs - rb)}${rb > 0 ? ` (${pct((rs - rb) / rb)})` : ''}</b></div>`;
    } else {
      h += `<div class="tip-row"><span>On board here, this direction</span><b>${int(load / div)} ${per}</b></div>`;
      if (p !== 'day') h += `<div class="tip-row"><span>Over the period</span><b>${int(load)}</b></div>`;
      h += `<div class="tip-row"><span>Buses or trains (scheduled)</span><b>${svc.trips > 0 ? `${dec1(svc.trips / hours)} per hour` : 'none'}</b></div>`;
      if (svc.cap > 0) h += `<div class="tip-row"><span>Load ÷ capacity</span><b>${pct(maxLf(m, r, seg, p, s, state.day), 0)}${p === 'day' ? ' (busiest period)' : ''}</b></div>`;
      h += `<div class="tip-row"><span>Riders on the whole route (boardings)</span><b>${int(routeStats(m, r).get(route.index)?.day ?? 0)} per ${DAY_NOUN[state.day]}</b></div>`;
    }
    return h + more + `<div class="tip-sub">${state.addStop ? 'Click to add a stop here' : 'Click to open the route'}</div>`;
  }

  private stopTip(i: number): string {
    const { r, s, base } = this.shown();
    const info = stopInfo(this.m, s, i);
    if (!info) return '';
    const on = r.stopOn[i] ?? 0, off = r.stopOff[i] ?? 0;
    let h = `<div class="tip-h">${esc(info.name)}</div><div class="tip-sub">${OPERATOR_LABEL[info.feed] ?? info.feed} · whole ${DAY_NOUN[state.day]}, modeled</div><div class="tip-row"><span>Boardings</span><b>${int(on)}</b></div><div class="tip-row"><span>Alightings</span><b>${int(off)}</b></div>`;
    if (view() === 'change') {
      const b = i < base.stopOn.length ? base.stopOn[i] + base.stopOff[i] : 0;
      h += `<div class="tip-row"><span>Change (on + off)</span><b>${signedInt(on + off - b)}</b></div>`;
    }
    return h;
  }

  private zoneTip(i: number): string {
    const z = this.m.bundle.header.zones[i];
    let layer = state.zoneLayer;
    if (layer === 'none') return '';
    const metric = ZONE_METRICS[layer as Exclude<ZoneLayer, 'none'>];
    const v = this.zoneValues(layer as Exclude<ZoneLayer, 'none'>)[i];
    return `<div class="tip-h">${esc(z.nhood)}</div><div class="tip-sub">Block group ${esc(z.id.slice(5))} · ${int(z.pop)} residents · ${int(z.jobs)} jobs</div><div class="tip-row"><span>${esc(metric.label)}</span><b>${v === null ? 'n/a' : metric.fmt(v)}</b></div>`;
  }

  // ---------- camera ----------

  fitRoute(key: string) {
    const r = this.m.routeByKey.get(key);
    if (!r) return;
    const H = this.m.bundle.header;
    let w = 180, e = -180, s = 90, n = -90;
    for (const li of r.patterns)
      for (const st of H.lines[li].stops) {
        const o = H.stops[st];
        w = Math.min(w, o.lon);
        e = Math.max(e, o.lon);
        s = Math.min(s, o.lat);
        n = Math.max(n, o.lat);
      }
    this.fit(w, s, e, n);
  }

  fitPoints(pts: { lat: number; lon: number }[]) {
    if (!pts.length) return;
    this.fit(Math.min(...pts.map((p) => p.lon)), Math.min(...pts.map((p) => p.lat)), Math.max(...pts.map((p) => p.lon)), Math.max(...pts.map((p) => p.lat)));
  }

  private fit(w: number, s: number, e: number, n: number) {
    const phone = matchMedia('(max-width: 720px)').matches;
    const sheet = phone ? (document.querySelector('.sidebar') as HTMLElement | null)?.getBoundingClientRect().height ?? 0 : 0;
    this.map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      { padding: { top: 70, bottom: 40 + sheet, left: 40, right: phone ? 40 : 240 }, maxZoom: 14.5, duration: 600 },
    );
  }

  resize() {
    this.map.resize();
  }
}

const NEW_CAP: Record<string, number> = { bus: 63, rapid: 94, lightrail: 238, bart: 1110, ferry: 350 };

/** the network the map shows: a scenario view only when there is a result for the day on show */
const view = (): MapView => (shownResult() ? state.view : 'base');

function maxLf(m: Model, r: RunResult, seg: Model['segs'][number], p: AppState['period'], s: Scenario | null, day: AppState['day']): number {
  let best = 0;
  for (const q of periodsOf(p)) {
    const svc = segService(m, seg, q, s, day);
    if (svc.cap > 0) best = Math.max(best, segLoad(m, r, seg, q) / svc.cap);
  }
  return best;
}
function crowdColor(lf: number): string {
  let i = 0;
  while (i < CROWD_BREAKS.length && lf >= CROWD_BREAKS[i]) i++;
  return CROWD_COLORS[i];
}
function niceUp(x: number): number {
  const mag = 10 ** Math.floor(Math.log10(x));
  return ([1, 1.5, 2, 3, 5, 7.5, 10].map((k) => k * mag).find((v) => v >= x) ?? 10 * mag) as number;
}
const sgn = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '');
/** 0.3333 → 0.33, 12.5 → 13, 0.083 → 0.08 */
const trimNum = (a: number) => (a >= 10 ? a.toFixed(0) : a >= 1 ? a.toFixed(1).replace(/\.0$/, '') : a.toPrecision(1));
const emptyFC = (): FC => ({ type: 'FeatureCollection', features: [] });
const point = (lon: number, lat: number, properties: Record<string, unknown>): Feature => ({ type: 'Feature', properties, geometry: { type: 'Point', coordinates: [lon, lat] } });
function div(cls: string) {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}
export { profileOf };
