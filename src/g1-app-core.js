/* ---------------------------------------------------------------------------
   The atlas application: map overlay, data loading, and the correlation view.
--------------------------------------------------------------------------- */
(() => {
const root = document.getElementById('atlas');
const $ = (id) => root.querySelector('#' + id);
const el = (tag, className, text) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
};
const fmtInt = (n) => Math.round(n).toLocaleString();
const fmtPct = (n, dp = 1) => (n == null || !isFinite(n)) ? '--' : (n * 100).toFixed(dp) + '%';
const fmtNum = (n, dp = 3) => (n == null || !isFinite(n)) ? '--' : n.toFixed(dp);

/* The six ridings that make up the City of Vancouver in the 2023
   representation order; UBC and UEL sit in Quadra but outside the city. */
const VANCOUVER_FEDS = new Set(['59035', '59036', '59037', '59038', '59039', '59040']);
const FED_NAMES = {
  '59035': 'Vancouver Centre', '59036': 'Vancouver East',
  '59037': 'Vancouver Fraserview—South Burnaby', '59038': 'Vancouver Granville',
  '59039': 'Vancouver Kingsway', '59040': 'Vancouver Quadra',
};
const POLL_TYPE = { N: 'ordinary', M: 'mobile', S: 'single building' };

const state = {
  fed: { all: [], active: [], index: null },
  prov: { all: [], active: [], index: null, keyDef: null, meta: null },
  fedResults: null,
  provResults: null,
  crosswalk: null,
  pairs: null,
  coverage: null,
  selection: { fed: null, prov: null },
  lastCorrelation: null,
  turnout: { unit: 'fed', weight: 0.5, apportion: { fed: 'none', prov: 'none' },
             minElectors: 50, rows: null, basket: new Set(), sortKey: 'agg', sortDir: 'desc' },
  shadeDomain: {},
  /* Census geography: dissemination areas are drawn and analysed; dissemination
     blocks only weight the crosswalk. Both trim to the federal extent like the
     provincial layer. */
  da: { all: [], active: [], index: null, keyProp: null, meta: null, census: null, variables: [],
        pop: null, shadeVar: null },
  db: { all: [], active: [], index: null, keyProp: null, meta: null, pop: null },
  geoAttr: null,
  /* One lattice sample over every loaded layer, and the crosswalks derived
     from it, cached by layer pair. */
  sample: null,
  cross: new Map(),
  weightingInEffect: null,
  results: { sortKey: 'ballots', sortDir: 'desc' },
  provElectors: null,
  /* Ballots per federal elector and per resident aged 15 and over, by voting
     area. Neither is turnout; see recomputeProvincialParticipation. */
  provPart: null,
  socio: { outcome: 'turnout-agg', minElectors: 50, selected: new Set(), extra: new Map(),
           rows: null, byDa: null, table: null, sortKey: 'absR', sortDir: 'desc', picked: null },
};

/* Results for one side, apportioned if the Turnout tab asked for it. Every
   reader of results goes through these so the map, the readout and the tab
   agree on which ballots are being counted. */
function resultsFor(side) {
  const store = side === 'fed' ? state.fedResults : state.provResults;
  if (!store || !store.values) return null;
  const mode = state.turnout.apportion[side];
  if (mode === 'none') return store.values;
  const ap = store.apportioned && store.apportioned[mode];
  /* An empty apportionment is not an apportionment. Results reported by
     voting place have nothing left over to apportion -- every ballot was
     already spread -- and an empty Map here would blank the whole side. */
  return ap && ap.values.size ? ap.values : store.values;
}
const fedValues = () => resultsFor('fed');
const provValues = () => resultsFor('prov');

/* --- Party colours ---------------------------------------------------------
   Conventional Canadian party colours where the party is recognisable, and a
   stable fallback palette otherwise so a party never changes colour mid-session. */
const PARTY_COLOURS = [
  [/\b(liberal|lib)\b/i, '#d71920'],
  [/\bconservative|\bcpc\b|tory/i, '#1a4782'],
  [/\bndp\b|new democratic/i, '#f37021'],
  [/\bgreen\b/i, '#3d9b35'],
  [/bloc|quebecois/i, '#33b2cc'],
  [/people'?s party|\bppc\b/i, '#4b306a'],
  [/\bbc united\b|\bsocial credit\b/i, '#c8102e'],
  [/independent|no affiliation/i, '#8a8a8a'],
];
const FALLBACK_COLOURS = ['#7b5ea7', '#0f8b8d', '#c06c84', '#b08968', '#4a6fa5', '#9a6324'];
const colourCache = new Map();
function partyColour(name) {
  if (colourCache.has(name)) return colourCache.get(name);
  let c = null;
  for (const [re, hex] of PARTY_COLOURS) if (re.test(name)) { c = hex; break; }
  if (!c) c = FALLBACK_COLOURS[colourCache.size % FALLBACK_COLOURS.length];
  colourCache.set(name, c);
  return c;
}

/* --- Feature preparation --------------------------------------------------- */

function prepareFederal(features) {
  return features.map((f, i) => {
    Geo.normalizeWinding(f.geometry);
    const p = f.properties;
    const num = parseInt(p.poll, 10);
    return {
      ...f,
      idx: i,
      key: `${p.fed}/${p.poll}`,
      fedNum: p.fed,
      fedName: FED_NAMES[p.fed] || `Riding ${p.fed}`,
      poll: p.poll,
      pollNum: isFinite(num) ? num : null,
      pollType: p.type,
      outsideCity: Boolean(p.jurisdiction),
      jurisdiction: p.jurisdiction || null,
      locality: p.locality || null,
      inVancouver: VANCOUVER_FEDS.has(p.fed) && !p.jurisdiction,
      label: `${FED_NAMES[p.fed] || p.fed} · poll ${p.poll.replace(/-0$/, '')}`,
    };
  });
}

const isPointLike = (f) => f.pollType === 'M' || f.pollType === 'S';

/* Two ridings reach past the city line, and only one of them is UBC. Quadra
   covers the University Endowment Lands; Fraserview--South Burnaby is a third
   Burnaby by electors. The locality on the poll says which, so the option
   named "+ UBC / UEL" adds UBC and nothing else -- Burnaby appears only under
   "everything in the file", like the other Metro ridings in the payload. */
const UBC_LOCALITY = 'Metro Vancouver A';

/* The study area: what the Area control admits, mobile polls included. This is
   a statement about geography, so nothing that only changes the drawing is
   allowed to narrow it. */
function federalStudyArea() {
  const area = $('area-filter').value;
  return state.fed.all.filter((f) => {
    if (area !== 'all' && !VANCOUVER_FEDS.has(f.fedNum)) return false;
    if (area === 'van' && f.outsideCity) return false;
    if (area === 'van-ubc' && f.outsideCity && f.locality !== UBC_LOCALITY) return false;
    return true;
  });
}

/* What is drawn and ranked: the study area, less anything the reader has
   switched off. */
function activeFederal() {
  const showMobile = $('show-mobile').checked;
  return federalStudyArea().filter((f) => showMobile || !isPointLike(f));
}

/* Provincial features are trimmed to those touching the federal extent so a
   province-wide download does not drag the whole of BC into every redraw. */
function activeProvincial(fedExtent) {
  if (!state.prov.all.length || !fedExtent) return [];
  const [x0, y0, x1, y1] = fedExtent;
  return state.prov.all.filter((f) => {
    const b = Geo.bboxOf(f.geometry);
    return b[0] <= x1 && b[2] >= x0 && b[1] <= y1 && b[3] >= y0;
  });
}

/* Any other layer trims the same way. */
function activeWithin(layer, fedExtent) {
  if (!layer.all.length || !fedExtent) return [];
  const [x0, y0, x1, y1] = fedExtent;
  return layer.all.filter((f) => {
    const b = Geo.bboxOf(f.geometry);
    return b[0] <= x1 && b[2] >= x0 && b[1] <= y1 && b[3] >= y0;
  });
}

function extentOf(features) {
  let e = [Infinity, Infinity, -Infinity, -Infinity];
  for (const f of features) {
    const b = Geo.bboxOf(f.geometry);
    if (!isFinite(b[0])) continue;
    e = [Math.min(e[0], b[0]), Math.min(e[1], b[1]), Math.max(e[2], b[2]), Math.max(e[3], b[3])];
  }
  return isFinite(e[0]) ? e : null;
}

/* Label a provincial feature from whichever fields were chosen as its key. */
function provLabel(f) {
  const k = state.prov.keyDef;
  if (!k) return 'Voting area';
  const d = k.district ? String(f.properties[k.district] ?? '').trim() : '';
  const v = k.poll ? String(f.properties[k.poll] ?? '').trim() : '';
  return d && v ? `${d} · VA ${v}` : (v || d || 'Voting area');
}

/* --- Map ------------------------------------------------------------------- */

/* --- Map (Leaflet) ----------------------------------------------------------
   One pane and one SVG renderer per layer, so `.layer-fed path` and
   `.layer-prov path` stay countable and stylable exactly as before. Every
   path gets its feature bound as d3's __data__, which lets the d3-style
   callbacks below (fill, classes, basket marks) keep working untouched on
   selections of the panes. Clicks are handled once at map level with a
   latlng; hit-testing stays in Geo, so the readout is always point-based.
   Shift-click is the basket gesture, so Leaflet's shift-drag box zoom is off. */
/* A centre and zoom at construction matter: Leaflet defers adding layers
   until the map has a view, and draw() binds each path's feature the moment
   the layer is added. Without a view the paths would not exist yet. */
const map = L.map($('atlas-map'), {
  center: [49.25, -123.12], zoom: 12,
  zoomSnap: 0.25, zoomControl: true, attributionControl: true, boxZoom: false,
  worldCopyJump: false, maxZoom: 20, minZoom: 9,
});
map.createPane('fed').classList.add('layer-fed');
map.getPane('fed').style.zIndex = 410;
map.createPane('prov').classList.add('layer-prov');
map.getPane('prov').style.zIndex = 420;
const fedLayer = L.geoJSON(null, {
  pane: 'fed', renderer: L.svg({ pane: 'fed' }), className: 'poll', weight: 0.6, fill: true,
}).addTo(map);
const provLayer = L.geoJSON(null, {
  pane: 'prov', renderer: L.svg({ pane: 'prov' }), className: 'va', fill: false,
}).addTo(map);
/* Voting places sit above every polygon: they are the thing the provincial
   results were actually reported at, and the catchments below them are only a
   model of who went where. */
map.createPane('places').classList.add('layer-places');
map.getPane('places').style.zIndex = 430;
const placesLayer = L.layerGroup([], { pane: 'places' }).addTo(map);

map.createPane('da').classList.add('layer-da');
map.getPane('da').style.zIndex = 405;
const daLayer = L.geoJSON(null, {
  pane: 'da', renderer: L.svg({ pane: 'da' }), className: 'da', fill: false,
}).addTo(map);
const gFed = d3.select(map.getPane('fed'));
const gProv = d3.select(map.getPane('prov'));
const gDa = d3.select(map.getPane('da'));

/* Free basemaps. Tiles are the only thing in the file that ever touches the
   network; without them the boundaries and every analysis still work. */
const BASEMAPS = {
  positron: {
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', subdomains: 'abcd', maxZoom: 20,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  },
  dark: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', subdomains: 'abcd', maxZoom: 20,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  },
  osm: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', subdomains: 'abc', maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
};
let tileLayer = null, tileErrors = 0, tileLoaded = false;
const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');
function resolveBasemap(mode) {
  if (mode === 'auto') return darkScheme.matches ? 'dark' : 'positron';
  return mode;
}
function setBasemap(mode) {
  if (tileLayer) { map.removeLayer(tileLayer); tileLayer = null; }
  tileErrors = 0; tileLoaded = false;
  $('basemap-note').hidden = true;
  const key = resolveBasemap(mode);
  const def = BASEMAPS[key];
  root.classList.toggle('basemap-none', !def);
  if (!def) return;
  tileLayer = L.tileLayer(def.url, {
    subdomains: def.subdomains, maxZoom: def.maxZoom, attribution: def.attribution, detectRetina: false,
  });
  /* Eight failures with nothing loaded is offline, not a slow tile. */
  tileLayer.on('tileerror', () => { tileErrors++; if (tileErrors >= 8 && !tileLoaded) $('basemap-note').hidden = false; });
  tileLayer.on('tileload', () => { tileLoaded = true; $('basemap-note').hidden = true; });
  tileLayer.addTo(map);
}
darkScheme.addEventListener('change', () => { if ($('basemap').value === 'auto') setBasemap('auto'); });

function fitAll() {
  const extent = extentOf(state.fed.active) || extentOf(state.prov.active);
  if (extent) map.fitBounds([[extent[1], extent[0]], [extent[3], extent[2]]], { padding: [12, 12], animate: false });
  else map.setView([49.25, -123.12], 12);
}

/* The value a feature is shaded by, for one layer and one mode. Federal modes
   read the 2025 results by feature index; the provincial-on-federal modes need
   the crosswalk (state.provOnFed); the provincial layer's own modes read the
   2024 results by f.__idx and need no crosswalk at all. */
function shadeValue(layerKey, f, mode, fedParty, provParty) {
  if (mode === 'none' || mode === 'type' || mode === 'flat') return null;
  if (layerKey === 'prov') {
    if (PART_MODES.has(mode)) {
      const p = state.provPart && state.provPart.get(f.__idx);
      if (!p) return null;
      return mode === 'prov-per-elector' ? p.perFedElector : p.perAdult;
    }
    const u = provValues()?.get(f.__idx);
    if (!u) return null;
    if (mode === 'prov-party') return provParty ? Analysis.shareOf(u, provParty) : null;
    if (mode === 'turnout-prov') return Turnout.rate(u);
    return null;
  }
  if (layerKey === 'da') {
    if (mode === 'variable') return state.da.shadeVar ? (state.da.shadeVar.get(f.__idx) ?? null) : null;
    const row = state.socio.byDa && state.socio.byDa.get(f.__idx);
    if (!row) return null;
    if (mode === 'turnout-agg') return row.agg;
    if (mode === 'turnout-fed') return row.t.fed;
    if (mode === 'turnout-prov') return row.t.prov;
    return null;
  }
  const fedUnit = fedValues()?.get(f.idx);
  const provOnFed = state.provOnFed && state.provOnFed.get(f.idx);
  const fedShare = fedUnit && fedParty ? Analysis.shareOf(fedUnit, fedParty) : null;
  const provShare = provOnFed && provParty ? Analysis.shareOf(provOnFed, provParty) : null;
  const tf = Turnout.rate(fedUnit), tp = Turnout.rate(provOnFed);
  switch (mode) {
    case 'fed-party': return fedShare;
    case 'prov-party': return provShare;
    case 'gap': return fedShare == null || provShare == null ? null : fedShare - provShare;
    case 'turnout-fed': return tf;
    case 'turnout-prov': return tp;
    case 'turnout-agg': {
      /* Same rule as Turnout.score: a weighted mean over the sides present. */
      const w = state.turnout.weight;
      let num = 0, den = 0;
      if (tf != null) { num += w * tf; den += w; }
      if (tp != null) { num += (1 - w) * tp; den += 1 - w; }
      return den > 0 ? num / den : null;
    }
    case 'turnout-delta': return tf == null || tp == null ? null : tf - tp;
    default: return null;
  }
}

const TYPE_FILL = { N: 'var(--muted)', M: 'var(--viz-series-5)', S: 'var(--viz-series-6)' };
const TURNOUT_MODES = new Set(['turnout-fed', 'turnout-prov', 'turnout-agg']);
/* Provincial ballots over a denominator that is not a provincial electorate.
   They ramp like a turnout because they are the same shape of number, and they
   are kept out of TURNOUT_MODES because they are not one. */
const PART_MODES = new Set(['prov-per-elector', 'prov-per-resident']);
/* Modes whose ramp follows the data on the map rather than a fixed scale. */
const DATA_MODES = new Set([...TURNOUT_MODES, ...PART_MODES, 'variable']);

/* Turnout ramps are data-driven -- 5th to 95th percentile of what is on the
   map -- because a fixed scale would either wash out or saturate depending on
   the election. Party shares keep a fixed 60% saturation so a 40% share looks
   the same in every riding. */
function shadeDomain(layerKey, sel, mode, fedParty, provParty) {
  const vals = [];
  sel.each((f) => {
    const v = shadeValue(layerKey, f, mode, fedParty, provParty);
    if (v != null && isFinite(v)) vals.push(v);
  });
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * (vals.length - 1)))];
  const lo = q(0.05), hi = q(0.95);
  return { lo, hi: hi > lo ? hi : lo + 1e-9, n: vals.length };
}

function rampT(mode, v, domain) {
  if (mode === 'gap') return Math.min(1, Math.abs(v) / 0.3);
  if (mode === 'turnout-delta') return Math.min(1, Math.abs(v) / 0.15);
  if (DATA_MODES.has(mode) && domain) {
    return Math.max(0, Math.min(1, (v - domain.lo) / (domain.hi - domain.lo)));
  }
  return Math.min(1, v / 0.6);
}

function fillColour(mode, v, fedParty, provParty) {
  if (mode === 'gap') return v >= 0 ? partyColour(fedParty) : partyColour(provParty);
  if (mode === 'turnout-delta') return v >= 0 ? 'var(--viz-series-1)' : 'var(--viz-series-2)';
  if (mode === 'variable') return 'var(--viz-series-3)';
  if (TURNOUT_MODES.has(mode)) return 'var(--viz-series-1)';
  if (mode === 'prov-per-elector') return 'var(--viz-series-4)';
  if (mode === 'prov-per-resident') return 'var(--viz-series-5)';
  if (mode === 'fed-party') return partyColour(fedParty);
  if (mode === 'prov-party') return partyColour(provParty);
  return 'var(--muted)';
}

/* Inline style, not a presentation attribute: the .poll / .va stylesheet rules
   set default fills, and a stylesheet rule always beats an attribute in SVG.
   A null value removes the inline style so the stylesheet applies again. */
const LAYER_SERIES = { prov: 'var(--viz-series-2)', da: 'var(--viz-series-3)' };
/* Catchment colours mean only "served by the same voting place". They cycle,
   they carry no order, and no catchment owns one -- which is why the legend
   says so rather than listing them. */
const CATCHMENT_FILL = ['var(--viz-series-1)', 'var(--viz-series-2)', 'var(--viz-series-3)',
  'var(--viz-series-4)', 'var(--viz-series-5)', 'var(--viz-series-6)'];

/* The catchment a voting area belongs to, or -1 when it only ever took a
   district-wide spread and so belongs to none. */
function catchmentOf(f) {
  const store = state.provResults;
  if (store?.kind !== 'places' || !store.assigned || f.__idx == null) return -1;
  return store.assigned.assignment[f.__idx] ?? -1;
}

function styleLayer(layerKey, sel) {
  const fedParty = $('shade-party-fed').value;
  const provParty = $('shade-party-prov').value;
  const mode = layerKey === 'fed' ? $('shade-by').value
    : layerKey === 'prov' ? $('shade-prov-by').value : $('shade-da-by').value;
  const domain = DATA_MODES.has(mode) ? shadeDomain(layerKey, sel, mode, fedParty, provParty) : null;
  state.shadeDomain[layerKey] = domain;
  /* The provincial and census layers are overlays: outline-only unless shaded,
     and their fill strength follows the one slider. */
  const isOverlay = layerKey !== 'fed';
  const base = isOverlay ? parseFloat($('prov-opacity').value) : 1;
  const series = LAYER_SERIES[layerKey] || 'var(--muted)';
  sel.style('fill', (f) => {
    if (isOverlay && mode === 'none') return null;
    if (isOverlay && mode === 'flat') return series;
    if (mode === 'type') return TYPE_FILL[f.pollType] || 'var(--muted)';
    if (mode === 'catchment') {
      const c = catchmentOf(f);
      return c < 0 ? null : CATCHMENT_FILL[c % CATCHMENT_FILL.length];
    }
    const v = shadeValue(layerKey, f, mode, fedParty, provParty);
    if (v == null) return series;
    return fillColour(mode, v, fedParty, provParty);
  }).style('fill-opacity', (f) => {
    if (isOverlay && mode === 'none') return null;
    if (isOverlay && mode === 'flat') return base * 0.35;
    if (mode === 'none') return 0.28;
    if (mode === 'type') return f.pollType === 'N' ? 0.28 : 0.75;
    /* An area with no catchment stays unfilled, so the two routes a ballot can
       take onto the map are told apart at a glance. */
    /* Stronger than the data ramps: this mode exists to make the partition
       legible, and a pale wash of six cycling colours is not. */
    if (mode === 'catchment') return catchmentOf(f) < 0 ? 0 : base * 0.8;
    const v = shadeValue(layerKey, f, mode, fedParty, provParty);
    if (v == null) return isOverlay ? 0.04 : 0.06;
    /* Capped below full opacity so the outlines stay readable underneath. */
    return base * (0.10 + 0.68 * rampT(mode, v, domain));
  });
}
const applyFederalStyle = (sel) => styleLayer('fed', sel);
const applyProvincialStyle = (sel) => styleLayer('prov', sel);
const applyDaStyle = (sel) => styleLayer('da', sel);

/* Bind the feature to its Leaflet-drawn path so d3 selections of the pane
   see it as the datum. */
function bindPaths(layerGroup, decorate) {
  layerGroup.eachLayer((l) => {
    const el = l.getElement();
    if (!el) return;
    el.__data__ = l.feature;
    if (decorate) decorate(el, l.feature);
  });
}

let layersSignature = null, extentSignature = null;

/* Recomputes the active sets and indexes; rebuilds the Leaflet layers only
   when the active sets actually changed (results loading merely restyles). */
/* What the readout says under a voting area whose numbers were modelled from a
   voting place rather than reported for the area itself. */
function provPlaceLine(feature, unit) {
  const store = state.provResults;
  if (store?.kind !== 'places' || !unit) return null;
  const bits = [];
  if (unit.place) {
    const metres = unit.placeDistanceM;
    bits.push(`Assigned to ${unit.place.name || 'a voting place'}`
      + (isFinite(metres) ? `, ${fmtInt(Math.round(metres))} m away` : ''));
  }
  const fromPlaces = unit.fromPlaces || 0, fromDistrict = unit.fromDistrict || 0;
  const all = fromPlaces + fromDistrict;
  if (all > 0) {
    bits.push(`${fmtPct(fromPlaces / all)} of its ballots came from that place, `
      + `the rest spread across the district`);
  }
  if (!bits.length) return null;
  const p = el('p', 'text-small text-muted', bits.join('. ') + '.');
  return p;
}

/* The two denominators for one voting area, side by side, because a reader
   checking a single area is exactly who needs to see how far apart they are.
   Written as a share of something named, never as a turnout. */
function provPartLine(feature) {
  const p = state.provPart && state.provPart.get(feature.__idx);
  if (!p || (p.perFedElector == null && p.perAdult == null)) return null;
  const bits = [`${fmtInt(p.ballots)} ballots`];
  if (p.perFedElector != null) bits.push(`${fmtPct(p.perFedElector)} of ${fmtInt(p.fedElectors)} federal electors`);
  if (p.perAdult != null) bits.push(`${fmtPct(p.perAdult)} of ${fmtInt(p.adults)} residents 15+`);
  const line = el('p', 'text-small text-muted', bits.join(' · '));
  if (p.spread != null && Math.abs(p.spread) >= 0.1) line.classList.add('text-warning');
  return line;
}

/* --- Voting places ---------------------------------------------------------- */

/* The located places behind the provincial results, or an empty list when the
   results were reported by voting area in the usual way. */
function votingPlaces() {
  return state.provResults?.kind === 'places' ? (state.provResults.read?.places || []) : [];
}

function drawPlaces() {
  const places = votingPlaces();
  const wrap = $('show-places-wrap');
  if (wrap) wrap.hidden = places.length === 0;
  placesLayer.clearLayers();
  if (!places.length) return;
  if (!$('show-places') || !$('show-places').checked) return;
  const ballots = places.map((p) => p.total + p.rejected);
  const biggest = Math.max(1, ...ballots);
  places.forEach((p, i) => {
    /* Area, not radius, follows the ballot count, so a hall with four times
       the ballots looks twice as wide rather than four times. */
    const r = 4 + 9 * Math.sqrt(ballots[i] / biggest);
    const marker = L.circleMarker([p.lat, p.lon], {
      pane: 'places', renderer: L.svg({ pane: 'places' }),
      className: 'place' + (p.final ? ' place-final' : ' place-other'),
      radius: r, weight: 1.5, fill: true, fillOpacity: 0.55,
    });
    marker.bindTooltip(`${p.name || 'Voting place'} — ${p.opportunity}, `
      + `${fmtInt(ballots[i])} ballots`, { direction: 'top' });
    marker.addTo(placesLayer);
  });
}

/* --- Effective n -------------------------------------------------------------

   A provincial number on a voting area is a share of what one voting place
   reported, so the areas of a catchment are one observation between them.
   These helpers name that observation, so a correlation can count distinct
   sources instead of polygons. */
function provPlaceGroup(provIdx) {
  const store = state.provResults;
  if (store?.kind !== 'places' || !store.assigned) return null;
  const pi = store.assigned.assignment[provIdx];
  return pi >= 0 ? 'place:' + pi : 'district:' + (store.assigned.featureDistrict[provIdx] || '');
}

/* For a dissemination area, whichever voting area covers most of it, and that
   area's group. Cached against the crosswalk, and cleared whenever it is.
   The dominant area is kept as well as the group: an export needs the feature
   itself to say how much of it came through a catchment. */
let daGroupCache = null;
function daDominant(daIdx) {
  const store = state.provResults;
  if (store?.kind !== 'places' || !store.assigned) return null;
  if (!daGroupCache) {
    daGroupCache = new Map();
    const cp = state.prov.all.length && state.da.all.length ? crossPair('prov', 'da') : null;
    if (cp) {
      const best = new Map();
      for (const p of cp.pairs) {
        const da = Analysis.pairIndex(p, 'b'), share = Analysis.pairShare(p, 'b');
        const prev = best.get(da);
        if (!prev || share > prev.share) best.set(da, { share, prov: Analysis.pairIndex(p, 'a') });
      }
      /* `best` is keyed by crosswalk-local index into state.da.active, but
         every caller has a feature's __idx, its position in state.da.all.
         Those differ whenever the active set is a subset -- which it always
         is, since the layer is clipped with a buffer ring and then trimmed to
         the federal extent -- so the cache is keyed by __idx here, once. */
      for (const [da, b] of best) {
        const target = state.da.active[da];
        const feature = state.prov.active[b.prov];
        if (target && feature) {
          daGroupCache.set(target.__idx, { feature, group: provPlaceGroup(feature.__idx) });
        }
      }
    }
  }
  return daGroupCache.get(daIdx) || null;
}
const daPlaceGroup = (daIdx) => daDominant(daIdx)?.group ?? null;
function clearPlaceGroups() { daGroupCache = null; }

/* What fraction of a voting area's ballots came from its own voting place
   rather than a district-wide spread; null when the results did not come by
   place at all. */
function catchmentShare(provFeature) {
  const store = state.provResults;
  if (store?.kind !== 'places' || !provFeature) return null;
  const u = store.values?.get(provFeature.__idx);
  if (!u) return null;
  const all = (u.fromPlaces || 0) + (u.fromDistrict || 0);
  return all > 0 ? u.fromPlaces / all : null;
}

function draw() {
  state.fed.active = activeFederal();
  const fedExtent = extentOf(state.fed.active);
  state.prov.active = activeProvincial(fedExtent);
  state.da.active = activeWithin(state.da, fedExtent);
  state.db.active = activeWithin(state.db, fedExtent);
  state.fed.index = Geo.buildIndex(state.fed.active);
  state.prov.index = state.prov.active.length ? Geo.buildIndex(state.prov.active) : null;
  state.da.index = state.da.active.length ? Geo.buildIndex(state.da.active) : null;

  const signature = [state.fed.active.length, state.prov.active.length, state.prov.all.length,
    state.da.active.length, state.da.all.length, votingPlaces().length,
    $('area-filter').value, $('show-mobile').checked,
    state.fed.active[0]?.key, state.fed.active[state.fed.active.length - 1]?.key].join('|');
  if (signature !== layersSignature) {
    layersSignature = signature;
    fedLayer.clearLayers();
    fedLayer.addData({ type: 'FeatureCollection', features: state.fed.active });
    bindPaths(fedLayer, (el, f) => {
      el.classList.toggle('outside-cov', Boolean(f.outsideCity));
      el.classList.toggle('point-like', isPointLike(f));
    });
    provLayer.clearLayers();
    if (state.prov.active.length) {
      provLayer.addData({ type: 'FeatureCollection', features: state.prov.active });
    }
    bindPaths(provLayer);
    daLayer.clearLayers();
    if (state.da.active.length) {
      daLayer.addData({ type: 'FeatureCollection', features: state.da.active });
    }
    bindPaths(daLayer);
  }
  drawPlaces();
  applyFederalStyle(gFed.selectAll('path'));
  applyProvincialStyle(gProv.selectAll('path'));
  applyDaStyle(gDa.selectAll('path'));

  updateLayerVisibility();
  renderLegend();
  redrawSelection();

  const extent = fedExtent || extentOf(state.prov.active);
  const key = extent ? extent.map((v) => v.toFixed(4)).join(',') : '';
  if (key !== extentSignature) { extentSignature = key; fitAll(); }
}

/* Controls that only mean something for results reported by voting place. */
function updatePlaceControls() {
  const sel = $('shade-prov-by');
  const part = state.provPart;
  const has = (key) => {
    if (!part) return false;
    for (const p of part.values()) if (p[key] != null) return true;
    return false;
  };
  /* Each of these shades something the loaded data may not support: a
     catchment needs results by voting place, and a denominator needs the layer
     it is carried from. An option that would shade nothing is withdrawn rather
     than left to paint an empty map. */
  const available = {
    catchment: state.provResults?.kind === 'places',
    'prov-per-elector': has('perFedElector'),
    'prov-per-resident': has('perAdult'),
  };
  for (const [value, ok] of Object.entries(available)) {
    const option = sel.querySelector(`option[value="${value}"]`);
    if (option) option.hidden = !ok;
    if (!ok && sel.value === value) sel.value = 'none';
  }
}

function updateLayerVisibility() {
  updatePlaceControls();
  map.getPane('fed').style.display = $('show-fed').checked ? '' : 'none';
  map.getPane('prov').style.display = $('show-prov').checked ? '' : 'none';
  map.getPane('da').style.display = $('show-da').checked ? '' : 'none';
  map.getPane('places').style.display = $('show-places').checked ? '' : 'none';
  gProv.classed('filled', $('shade-prov-by').value !== 'none');
  gDa.classed('filled', $('shade-da-by').value !== 'none');
  const hasDa = state.da.all.length > 0;
  $('da-controls').hidden = !hasDa;
  $('show-da-wrap').hidden = !hasDa;
  root.style.setProperty('--va-weight', $('prov-weight').value);
}

function renderLegend() {
  const legend = $('map-legend');
  const mode = $('shade-by').value;
  const provMode = $('shade-prov-by').value;
  const fedParty = $('shade-party-fed').value, provParty = $('shade-party-prov').value;
  legend.textContent = '';
  const items = [];
  const range = (d) => (d ? ` — ${fmtPct(d.lo, 0)} to ${fmtPct(d.hi, 0)}` : '');
  /* Everything the federal layer can show about the provincial election is
     carried there by the crosswalk. Without one those modes shade nothing, and
     a legend describing them would be describing an empty map. */
  const CROSS_LEVEL = new Set(['prov-party', 'turnout-prov', 'turnout-agg', 'turnout-delta', 'gap']);
  const crossReady = Boolean(state.provOnFed && state.provOnFed.size);
  if (CROSS_LEVEL.has(mode) && !crossReady) {
    items.push(['note', 'This shading needs the crosswalk — build it on the Correlation tab.']);
  } else if (mode === 'type') {
    items.push(['var(--muted)', 'Ordinary poll'], ['var(--viz-series-5)', 'Mobile poll'],
               ['var(--viz-series-6)', 'Single building']);
  } else if (mode === 'fed-party' && fedParty) {
    items.push([partyColour(fedParty), `${fedParty} share, 2025 — darker is higher`]);
  } else if (mode === 'prov-party' && provParty) {
    items.push([partyColour(provParty), `${provParty} share, 2024, on federal polls — darker is higher`]);
  } else if (mode === 'gap') {
    items.push([partyColour(fedParty), `${fedParty} runs ahead federally`],
               [partyColour(provParty), `${provParty} runs ahead provincially`]);
  } else if (mode === 'turnout-fed') {
    items.push(['var(--viz-series-1)', `2025 federal turnout${range(state.shadeDomain.fed)}`]);
  } else if (mode === 'turnout-prov') {
    items.push(['var(--viz-series-1)', `2024 provincial turnout on federal polls${range(state.shadeDomain.fed)}`]);
  } else if (mode === 'turnout-agg') {
    const w = Math.round(state.turnout.weight * 100);
    items.push(['var(--viz-series-1)',
      `Aggregate turnout, ${w}% federal / ${100 - w}% provincial${range(state.shadeDomain.fed)}`]);
    items.push(['note', 'A poll reached by only one election shows that election alone.']);
  } else if (mode === 'turnout-delta') {
    items.push(['var(--viz-series-1)', 'Federal turnout higher'], ['var(--viz-series-2)', 'Provincial turnout higher']);
  }
  if (state.prov.active.length) {
    if (provMode === 'prov-party' && provParty) {
      items.push([partyColour(provParty), `${provParty} share, 2024, on voting areas`]);
    } else if (provMode === 'turnout-prov') {
      items.push(['var(--viz-series-1)', `2024 provincial turnout on voting areas${range(state.shadeDomain.prov)}`]);
    } else if (PART_MODES.has(provMode)) {
      /* Named by its denominator every time it is drawn. The whole reason
         these exist is that neither denominator is a provincial electorate,
         and a legend reading "turnout" would undo that in one word. */
      const perElector = provMode === 'prov-per-elector';
      const dom = state.shadeDomain.prov;
      items.push([perElector ? 'var(--viz-series-4)' : 'var(--viz-series-5)',
        `2024 provincial ballots per ${perElector ? '2025 federal elector' : 'resident aged 15+'}`
        + (dom ? ` — ${fmtPct(dom.lo, 0)} to ${fmtPct(dom.hi, 0)}` : '')]);
      items.push(['note', perElector
        ? 'Not turnout: the denominator is the 2025 federal roll, not the 2024 provincial one.'
        : 'Not turnout: the denominator counts 2021 residents, not registered voters.']);
    } else if (provMode === 'catchment') {
      const n = state.provResults?.report?.catchments || 0;
      /* The colours cycle and carry no order, so the legend says what they
         mean rather than pretending to be a scale. */
      items.push([CATCHMENT_FILL[0], `${fmtInt(n)} catchments — one colour per voting place, repeating`]);
      items.push(['outline', 'No catchment: ballots spread across the district']);
    }
    items.push(['outline', 'Provincial (2024) voting area']);
  }
  if (state.da.active.length) {
    const daMode = $('shade-da-by').value;
    if (DATA_MODES.has(daMode)) {
      const name = daMode === 'variable'
        ? ($('shade-da-var').selectedOptions[0]?.textContent || 'census variable')
        : { 'turnout-agg': 'Aggregate turnout', 'turnout-fed': '2025 federal turnout', 'turnout-prov': '2024 provincial turnout' }[daMode];
      const dom = state.shadeDomain.da;
      const rangeText = dom ? (daMode === 'variable'
        ? ` — ${fmtNum(dom.lo, 1)} to ${fmtNum(dom.hi, 1)}` : range(dom)) : '';
      items.push([daMode === 'variable' ? 'var(--viz-series-3)' : 'var(--viz-series-1)', `${name} on dissemination areas${rangeText}`]);
    }
    items.push(['outline-da', 'Census (2021) dissemination area']);
  }
  legend.hidden = items.length === 0;
  for (const [colour, text] of items) {
    const row = el('div', 'legend-item');
    if (colour === 'note') { row.append(el('span', 'text-small text-muted', text)); legend.append(row); continue; }
    const outline = colour === 'outline' || colour === 'outline-da';
    const sw = el('span', colour === 'outline' ? 'swatch swatch-outline' : colour === 'outline-da' ? 'swatch swatch-da' : 'swatch');
    if (!outline) sw.style.background = colour;
    row.append(sw, el('span', null, text));
    legend.append(row);
  }
}

/* --- Selection and readout ------------------------------------------------- */

/* Hit-test one point against every layer; a feature given directly stands in
   for its own layer and the others are found at its interior point. */
function selectAt(lonlat, fedFeature, provFeature, daFeature) {
  const hitAll = (pt) => ({
    fed: pt && state.fed.index ? state.fed.index.hit(pt[0], pt[1]) : -1,
    prov: pt && state.prov.index ? state.prov.index.hit(pt[0], pt[1]) : -1,
    da: pt && state.da.index ? state.da.index.hit(pt[0], pt[1]) : -1,
  });
  const given = fedFeature || provFeature || daFeature;
  const pt = lonlat || (given ? Geo.representativePoint(given.geometry) : null);
  const h = hitAll(pt);
  state.selection.fed = fedFeature || (h.fed >= 0 ? state.fed.active[h.fed] : null);
  state.selection.prov = provFeature || (h.prov >= 0 ? state.prov.active[h.prov] : null);
  state.selection.da = daFeature || (h.da >= 0 ? state.da.active[h.da] : null);
  redrawSelection();
  renderReadout();
}

function redrawSelection() {
  gFed.selectAll('path').classed('selected', (f) => f === state.selection.fed);
  gProv.selectAll('path').classed('selected', (f) => f === state.selection.prov);
  gDa.selectAll('path').classed('selected', (f) => f === state.selection.da);
  /* Re-appending brings the selected outline above its neighbours. */
  gFed.selectAll('path.selected').raise();
  gProv.selectAll('path.selected').raise();
  gDa.selectAll('path.selected').raise();
}

function resultsList(unit, limit = 6) {
  if (!unit || !unit.parties.size) return null;
  const rows = [...unit.parties.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  const list = el('ul', 'result-list');
  for (const [party, votes] of rows) {
    const li = el('li');
    const dot = el('span', 'dot');
    dot.style.background = partyColour(party);
    li.append(dot, el('span', 'party', party),
      el('span', 'votes tabular-nums', `${fmtInt(votes)} (${fmtPct(unit.total ? votes / unit.total : null)})`));
    list.append(li);
  }
  return list;
}

function renderReadout() {
  const box = $('readout');
  box.textContent = '';
  const { fed, prov, da } = state.selection;
  if (!fed && !prov && !da) {
    box.append(el('p', 'text-muted',
      'Click anywhere on the map to read the federal polling division, the provincial voting area and the dissemination area covering that point.'));
    return;
  }
  const grid = el('div', 'readout-grid');

  const fedCard = el('div', 'readout-card');
  fedCard.append(el('h3', null, 'Federal (2025)'));
  if (fed) {
    fedCard.append(el('p', 'readout-name', fed.label));
    const bits = [`Riding ${fed.fedNum}`, `poll ${fed.poll}`,
      POLL_TYPE[fed.pollType] ? `${POLL_TYPE[fed.pollType]} poll` : null,
      fed.jurisdiction];
    fedCard.append(el('p', 'text-small text-muted', bits.filter(Boolean).join(' · ')));
    const unit = fedValues()?.get(fed.idx);
    if (unit) {
      fedCard.append(el('p', 'text-small', `${fmtInt(unit.total)} valid votes`));
      const tl = turnoutLine(unit);
      if (tl) fedCard.append(el('p', 'text-small' + (Turnout.rate(unit) > 1 ? ' text-warning' : ''), tl));
      const list = resultsList(unit);
      if (list) fedCard.append(list);
    } else if (state.fedResults) {
      fedCard.append(el('p', 'text-small text-warning', 'No results row matched this polling division.'));
    }
  } else {
    fedCard.append(el('p', 'text-muted', 'No federal polling division at this point.'));
  }

  const provCard = el('div', 'readout-card');
  provCard.append(el('h3', null, 'Provincial (2024)'));
  if (prov) {
    provCard.append(el('p', 'readout-name', provLabel(prov)));
    const k = state.prov.keyDef || {};
    const extras = Object.entries(prov.properties)
      .filter(([key, v]) => key !== k.district && key !== k.poll && String(v ?? '').trim() !== '')
      .slice(0, 4)
      .map(([key, v]) => `${key}: ${v}`);
    if (extras.length) provCard.append(el('p', 'text-small text-muted', extras.join(' · ')));
    const unit = provValues()?.get(prov.__idx);
    if (unit) {
      provCard.append(el('p', 'text-small', `${fmtInt(unit.total)} valid votes`));
      const tl = turnoutLine(unit);
      if (tl) provCard.append(el('p', 'text-small' + (Turnout.rate(unit) > 1 ? ' text-warning' : ''), tl));
      const list = resultsList(unit);
      if (list) provCard.append(list);
    } else if (state.provResults) {
      provCard.append(el('p', 'text-small text-warning',
        state.provResults.kind === 'places'
          ? 'No voting place served this area — its district reported no results.'
          : 'No results row matched this voting area.'));
    }
    const placeLine = provPlaceLine(prov, unit);
    if (placeLine) provCard.append(placeLine);
    const partLine = provPartLine(prov);
    if (partLine) provCard.append(partLine);
  } else if (state.prov.all.length) {
    provCard.append(el('p', 'text-muted', 'No provincial voting area at this point.'));
  } else {
    provCard.append(el('p', 'text-muted', 'No provincial layer loaded yet — see the Data tab.'));
  }

  grid.append(fedCard, provCard);
  if (state.da.all.length) {
    const daCard = el('div', 'readout-card');
    daCard.append(el('h3', null, 'Census (2021)'));
    if (da) {
      daCard.append(el('p', 'readout-name', daLabel(da)));
      const bits = [];
      const pop = state.da.pop?.get(da.__idx);
      if (pop != null) bits.push(`${fmtInt(pop)} people`);
      const row = state.socio.byDa && state.socio.byDa.get(da.__idx);
      if (row) {
        if (row.t.fed != null) bits.push(`federal turnout ${fmtPct(row.t.fed)}`);
        if (row.t.prov != null) bits.push(`provincial turnout ${fmtPct(row.t.prov)}`);
        if (row.agg != null) bits.push(`aggregate ${fmtPct(row.agg)}`);
      }
      if (bits.length) daCard.append(el('p', 'text-small', bits.join(' · ')));
      const shown = state.da.variables.filter((v) => v.byFeature.has(da.__idx)).slice(0, 8);
      if (shown.length) {
        const list = el('ul', 'result-list');
        for (const v of shown) {
          const li = el('li');
          li.append(el('span', 'party', v.label), el('span', 'votes tabular-nums', fmtNum(v.byFeature.get(da.__idx), 1)));
          list.append(li);
        }
        daCard.append(list);
      } else if (state.da.census) {
        daCard.append(el('p', 'text-small text-warning', 'No census row matched this area.'));
      }
    } else {
      daCard.append(el('p', 'text-muted', 'No dissemination area at this point.'));
    }
    grid.append(daCard);
  }
  box.append(grid);

  const bkey = basketKeyForSelection();
  if (bkey && state.turnout.rows) {
    const inBasket = state.turnout.basket.has(bkey);
    const bk = el('button', 'btn btn-small', inBasket ? 'Remove from turnout basket' : 'Add to turnout basket');
    bk.type = 'button';
    bk.addEventListener('click', () => toggleBasket(bkey));
    box.append(bk);
  }

  if (fed && prov && state.pairs) {
    const fi = state.fed.all.indexOf(fed);
    const overlaps = state.pairs.filter((p) => state.crosswalkFed[p.fi] === fed);
    if (overlaps.length) {
      const note = el('p', 'text-small text-muted');
      const here = overlaps.find((p) => state.crosswalkProv[p.pi] === prov);
      note.textContent = here
        ? `This polling division is split across ${overlaps.length} voting area${overlaps.length > 1 ? 's' : ''}; `
          + `${fmtPct(here.shareOfFed)} of its area lies in ${provLabel(prov)}.`
        : `This polling division is split across ${overlaps.length} voting area${overlaps.length > 1 ? 's' : ''}.`;
      box.append(note);
    }
  }
}

/* One line of ballots / electors / turnout for a readout card. */
function turnoutLine(unit) {
  const t = Turnout.rate(unit);
  if (t == null) return unit.electors ? null : 'No elector count in this file — turnout unavailable.';
  const bits = [`${fmtInt(Turnout.ballots(unit))} ballots`, `${fmtInt(unit.electors)} electors`,
    `turnout ${fmtPct(t)}`];
  if (unit.apportioned) bits.push(`incl. ${fmtInt(unit.apportioned)} apportioned`);
  if (t > 1) bits.push('over 100% — merged or mis-keyed poll');
  return bits.join(' · ');
}

map.on('click', (event) => {
  selectAt([event.latlng.lng, event.latlng.lat]);
  /* Shift-click adds the unit under the cursor to the turnout basket. */
  if (event.originalEvent && event.originalEvent.shiftKey) {
    const key = basketKeyForSelection();
    if (key) toggleBasket(key);
  }
});

function zoomToFeature(feature) {
  if (!feature) return;
  const b = Geo.bboxOf(feature.geometry);
  if (!isFinite(b[0])) return;
  map.fitBounds([[b[1], b[0]], [b[3], b[2]]], { padding: [24, 24], maxZoom: 17 });
}

/* --- The sample table and its crosswalks ------------------------------------
   buildCrosswalk (g3) samples every loaded layer once into state.sample.
   crossPair(a, b) then derives the crosswalk for any two layers on demand,
   weighted as the Correlation tab asks, and caches it; the federal-provincial
   pair also fills the older state.crosswalk / state.pairs fields the rest of
   the app reads. */

/* Per-point weights from the best population layer available:
   dissemination blocks, else dissemination areas, else none (area). */
function sampleWeights() {
  const s = state.sample;
  const none = { weights: null, label: 'area', short: 'area', detail: '' };
  if (!s) return none;
  const mode = $('sample-weighting').value;
  if (mode === 'area') return none;
  const popOf = (id) => {
    const k = s.ids.indexOf(id);
    if (k < 0 || !state[id].pop) return null;
    const m = new Map();
    state[id].active.forEach((f, i) => { const v = state[id].pop.get(f.__idx); if (v != null) m.set(i, v); });
    return m.size ? { k, m } : null;
  };
  const da = (mode === 'auto' || mode === 'da') ? popOf('da') : null;
  const db = (mode === 'auto' || mode === 'db') ? popOf('db') : null;
  let weights = null, label = 'area', short = 'area', detail = '';
  if (da) { weights = Analysis.pointWeights(s, da.k, da.m, null); label = 'dissemination-area population'; short = 'area population'; }
  if (db) {
    weights = Analysis.pointWeights(s, db.k, db.m, weights);
    short = 'block population';
    detail = da ? 'area population where a block has none' : '';
    label = 'dissemination-block population' + (detail ? ` (${detail})` : '');
  }
  if (!weights && mode !== 'auto') { label = 'area (no population loaded for that layer)'; detail = 'no population loaded for that layer'; }
  return { weights, label, short, detail };
}

function crossPair(a, b) {
  const s = state.sample;
  if (!s) return null;
  const ka = s.ids.indexOf(a), kb = s.ids.indexOf(b);
  if (ka < 0 || kb < 0) return null;
  const key = a + '|' + b;
  let c = state.cross.get(key);
  if (c) return c;
  const { weights, label, short, detail } = sampleWeights();
  const cw = Analysis.crosswalkBetween(s, ka, kb, { weights });
  const repaired = Analysis.repairSmallFeatures(cw, state[a].active, state[b].active,
    { a: s.indexes[ka], b: s.indexes[kb] });
  const minShare = parseFloat($('min-overlap').value);
  c = { cw, pairs: Analysis.crosswalkPairs(cw, { minShare }), coverage: Analysis.coverage(cw), repaired, weighting: label };
  state.cross.set(key, c);
  state.weightingInEffect = label;
  state.weightingShort = short;
  state.weightingDetail = detail;
  if (a === 'fed' && b === 'prov') {
    state.crosswalk = cw; state.pairs = c.pairs; state.coverage = c.coverage;
    state.crosswalkFed = state.fed.active; state.crosswalkProv = state.prov.active;
  }
  return c;
}

/* Weighting or the sliver threshold changed: the sample stands, the
   crosswalks are rebuilt from it. */
function invalidateCross() {
  state.cross.clear();
  /* The place groups are derived from the pairs, so they die with them:
     without this, changing the weighting or the sliver threshold would leave
     the effective-n figure counting sources from the previous crosswalk. */
  clearPlaceGroups();
  state.crosswalk = null; state.pairs = null; state.coverage = null; state.provOnFed = null;
  /* Both denominators are carried across the crosswalk, so they die with it
     rather than shading the map from the previous weighting. */
  state.provPart = null;
  state.crosswalkFed = null; state.crosswalkProv = null;
  if (state.sample) crossPair('fed', 'prov');
}

/* The active sets changed: nothing derived from the sample survives. */
function invalidateSample() {
  state.sample = null;
  invalidateCross();
  state.turnout.rows = null; state.turnout.basket.clear();
  state.socio.rows = null; state.socio.byDa = null; state.socio.table = null;
  $('corr-controls').hidden = true;
  refreshCrosswalkStatus();
}
