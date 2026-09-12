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
  return ap ? ap.values : store.values;
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
      inVancouver: VANCOUVER_FEDS.has(p.fed) && !p.jurisdiction,
      label: `${FED_NAMES[p.fed] || p.fed} · poll ${p.poll.replace(/-0$/, '')}`,
    };
  });
}

const isPointLike = (f) => f.pollType === 'M' || f.pollType === 'S';

function activeFederal() {
  const area = $('area-filter').value;
  const showMobile = $('show-mobile').checked;
  return state.fed.all.filter((f) => {
    if (area === 'van' && !f.inVancouver) return false;
    if (area === 'van-ubc' && !VANCOUVER_FEDS.has(f.fedNum)) return false;
    if (!showMobile && isPointLike(f)) return false;
    return true;
  });
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
const gFed = d3.select(map.getPane('fed'));
const gProv = d3.select(map.getPane('prov'));

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
    const u = provValues()?.get(f.__idx);
    if (!u) return null;
    if (mode === 'prov-party') return provParty ? Analysis.shareOf(u, provParty) : null;
    if (mode === 'turnout-prov') return Turnout.rate(u);
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
  if (TURNOUT_MODES.has(mode) && domain) {
    return Math.max(0, Math.min(1, (v - domain.lo) / (domain.hi - domain.lo)));
  }
  return Math.min(1, v / 0.6);
}

function fillColour(mode, v, fedParty, provParty) {
  if (mode === 'gap') return v >= 0 ? partyColour(fedParty) : partyColour(provParty);
  if (mode === 'turnout-delta') return v >= 0 ? 'var(--viz-series-1)' : 'var(--viz-series-2)';
  if (TURNOUT_MODES.has(mode)) return 'var(--viz-series-1)';
  if (mode === 'fed-party') return partyColour(fedParty);
  if (mode === 'prov-party') return partyColour(provParty);
  return 'var(--muted)';
}

/* Inline style, not a presentation attribute: the .poll / .va stylesheet rules
   set default fills, and a stylesheet rule always beats an attribute in SVG.
   A null value removes the inline style so the stylesheet applies again. */
function styleLayer(layerKey, sel) {
  const fedParty = $('shade-party-fed').value;
  const provParty = $('shade-party-prov').value;
  const mode = layerKey === 'fed' ? $('shade-by').value : $('shade-prov-by').value;
  const domain = TURNOUT_MODES.has(mode) ? shadeDomain(layerKey, sel, mode, fedParty, provParty) : null;
  state.shadeDomain[layerKey] = domain;
  const base = layerKey === 'prov' ? parseFloat($('prov-opacity').value) : 1;
  const isProv = layerKey === 'prov';
  sel.style('fill', (f) => {
    if (isProv && mode === 'none') return null;
    if (isProv && mode === 'flat') return 'var(--viz-series-2)';
    if (mode === 'type') return TYPE_FILL[f.pollType] || 'var(--muted)';
    const v = shadeValue(layerKey, f, mode, fedParty, provParty);
    if (v == null) return isProv ? 'var(--viz-series-2)' : 'var(--muted)';
    return fillColour(mode, v, fedParty, provParty);
  }).style('fill-opacity', (f) => {
    if (isProv && mode === 'none') return null;
    if (isProv && mode === 'flat') return base * 0.35;
    if (mode === 'none') return 0.28;
    if (mode === 'type') return f.pollType === 'N' ? 0.28 : 0.75;
    const v = shadeValue(layerKey, f, mode, fedParty, provParty);
    if (v == null) return isProv ? 0.04 : 0.06;
    /* Capped below full opacity so the outlines stay readable underneath. */
    return base * (0.10 + 0.68 * rampT(mode, v, domain));
  });
}
const applyFederalStyle = (sel) => styleLayer('fed', sel);
const applyProvincialStyle = (sel) => styleLayer('prov', sel);

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
function draw() {
  state.fed.active = activeFederal();
  const fedExtent = extentOf(state.fed.active);
  state.prov.active = activeProvincial(fedExtent);
  state.fed.index = Geo.buildIndex(state.fed.active);
  state.prov.index = state.prov.active.length ? Geo.buildIndex(state.prov.active) : null;

  const signature = [state.fed.active.length, state.prov.active.length, state.prov.all.length,
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
  }
  applyFederalStyle(gFed.selectAll('path'));
  applyProvincialStyle(gProv.selectAll('path'));

  updateLayerVisibility();
  renderLegend();
  redrawSelection();

  const extent = fedExtent || extentOf(state.prov.active);
  const key = extent ? extent.map((v) => v.toFixed(4)).join(',') : '';
  if (key !== extentSignature) { extentSignature = key; fitAll(); }
}

function updateLayerVisibility() {
  map.getPane('fed').style.display = $('show-fed').checked ? '' : 'none';
  map.getPane('prov').style.display = $('show-prov').checked ? '' : 'none';
  gProv.classed('filled', $('shade-prov-by').value !== 'none');
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
  if (mode === 'type') {
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
    items.push(['var(--viz-series-1)', `Aggregate turnout${range(state.shadeDomain.fed)}`]);
  } else if (mode === 'turnout-delta') {
    items.push(['var(--viz-series-1)', 'Federal turnout higher'], ['var(--viz-series-2)', 'Provincial turnout higher']);
  }
  if (state.prov.active.length) {
    if (provMode === 'prov-party' && provParty) {
      items.push([partyColour(provParty), `${provParty} share, 2024, on voting areas`]);
    } else if (provMode === 'turnout-prov') {
      items.push(['var(--viz-series-1)', `2024 provincial turnout on voting areas${range(state.shadeDomain.prov)}`]);
    }
    items.push(['outline', 'Provincial (2024) voting area']);
  }
  legend.hidden = items.length === 0;
  for (const [colour, text] of items) {
    const row = el('div', 'legend-item');
    const sw = el('span', colour === 'outline' ? 'swatch swatch-outline' : 'swatch');
    if (colour !== 'outline') sw.style.background = colour;
    row.append(sw, el('span', null, text));
    legend.append(row);
  }
}

/* --- Selection and readout ------------------------------------------------- */

function selectAt(lonlat, fedFeature, provFeature) {
  if (lonlat) {
    const fi = state.fed.index ? state.fed.index.hit(lonlat[0], lonlat[1]) : -1;
    const pi = state.prov.index ? state.prov.index.hit(lonlat[0], lonlat[1]) : -1;
    state.selection.fed = fi >= 0 ? state.fed.active[fi] : null;
    state.selection.prov = pi >= 0 ? state.prov.active[pi] : null;
  } else {
    if (fedFeature) {
      state.selection.fed = fedFeature;
      const pt = Geo.representativePoint(fedFeature.geometry);
      const pi = pt && state.prov.index ? state.prov.index.hit(pt[0], pt[1]) : -1;
      state.selection.prov = pi >= 0 ? state.prov.active[pi] : null;
    }
    if (provFeature) {
      state.selection.prov = provFeature;
      const pt = Geo.representativePoint(provFeature.geometry);
      const fi = pt && state.fed.index ? state.fed.index.hit(pt[0], pt[1]) : -1;
      if (fi >= 0) state.selection.fed = state.fed.active[fi];
    }
  }
  redrawSelection();
  renderReadout();
}

function redrawSelection() {
  gFed.selectAll('path').classed('selected', (f) => f === state.selection.fed);
  gProv.selectAll('path').classed('selected', (f) => f === state.selection.prov);
  /* Re-appending brings the selected outline above its neighbours. */
  gFed.selectAll('path.selected').raise();
  gProv.selectAll('path.selected').raise();
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
  const { fed, prov } = state.selection;
  if (!fed && !prov) {
    box.append(el('p', 'text-muted',
      'Click anywhere on the map to read the federal polling division and the provincial voting area covering that point.'));
    return;
  }
  const grid = el('div', 'readout-grid');

  const fedCard = el('div', 'readout-card');
  fedCard.append(el('h3', null, 'Federal (2025)'));
  if (fed) {
    fedCard.append(el('p', 'readout-name', fed.label));
    const bits = [`Riding ${fed.fedNum}`, `poll ${fed.poll}`,
      POLL_TYPE[fed.pollType] ? `${POLL_TYPE[fed.pollType]} poll` : null,
      fed.outsideCity ? 'UBC / UEL — outside the City of Vancouver' : null];
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
      provCard.append(el('p', 'text-small text-warning', 'No results row matched this voting area.'));
    }
  } else if (state.prov.all.length) {
    provCard.append(el('p', 'text-muted', 'No provincial voting area at this point.'));
  } else {
    provCard.append(el('p', 'text-muted', 'No provincial layer loaded yet — see the Data tab.'));
  }

  grid.append(fedCard, provCard);
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
