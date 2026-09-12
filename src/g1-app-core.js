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

const svg = d3.select(root.querySelector('.atlas-map'));
const gRoot = svg.append('g');
const gFed = gRoot.append('g').attr('class', 'layer-fed');
const gProv = gRoot.append('g').attr('class', 'layer-prov');
const gPick = gRoot.append('g').attr('class', 'layer-pick');
let width = 900, height = 620, projection = null, path = null;
const zoom = d3.zoom().scaleExtent([1, 60]).on('zoom', (event) => {
  gRoot.attr('transform', event.transform);
});
svg.call(zoom).on('dblclick.zoom', null);

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

function draw() {
  const box = root.querySelector('.map-wrap').getBoundingClientRect();
  width = Math.max(320, Math.floor(box.width) || 900);
  height = Math.max(380, Math.min(700, Math.round(width * 0.72)));
  svg.attr('viewBox', `0 0 ${width} ${height}`).attr('height', height);

  state.fed.active = activeFederal();
  const fedExtent = extentOf(state.fed.active);
  state.prov.active = activeProvincial(fedExtent);

  const fitTarget = { type: 'FeatureCollection', features: state.fed.active.length
    ? state.fed.active : state.prov.active };
  projection = d3.geoMercator();
  if (fitTarget.features.length) {
    projection.fitExtent([[12, 12], [width - 12, height - 12]], fitTarget);
  } else {
    projection.center([-123.12, 49.25]).scale(90000).translate([width / 2, height / 2]);
  }
  path = d3.geoPath(projection);

  state.fed.index = Geo.buildIndex(state.fed.active);
  state.prov.index = state.prov.active.length ? Geo.buildIndex(state.prov.active) : null;

  const fedSel = gFed.selectAll('path').data(state.fed.active, (f) => f.key);
  fedSel.exit().remove();
  const fedAll = fedSel.enter().append('path')
    .attr('class', 'poll')
    .on('click', (event, f) => { selectAt(null, f, null); })
    .merge(fedSel)
    .attr('d', path)
    .classed('outside-cov', (f) => f.outsideCity)
    .classed('point-like', (f) => isPointLike(f));
  applyFederalStyle(fedAll);

  const provSel = gProv.selectAll('path').data(state.prov.active, (f, i) => f.__key || i);
  provSel.exit().remove();
  const provAll = provSel.enter().append('path')
    .attr('class', 'va')
    .on('click', (event, f) => { selectAt(null, null, f); })
    .merge(provSel)
    .attr('d', path);
  applyProvincialStyle(provAll);

  updateLayerVisibility();
  renderLegend();
  redrawSelection();
}

function updateLayerVisibility() {
  gFed.attr('display', $('show-fed').checked ? null : 'none');
  gProv.attr('display', $('show-prov').checked ? null : 'none');
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

svg.on('click', (event) => {
  if (event.defaultPrevented) return;
  if (!projection) return;
  const [mx, my] = d3.pointer(event, svg.node());
  const t = d3.zoomTransform(svg.node());
  const [px, py] = t.invert([mx, my]);
  const lonlat = projection.invert([px, py]);
  if (lonlat) selectAt(lonlat);
  /* Shift-click adds the unit under the cursor to the turnout basket. */
  if (event.shiftKey) {
    const key = basketKeyForSelection();
    if (key) toggleBasket(key);
  }
});

function zoomToFeature(feature) {
  if (!feature || !path) return;
  const b = path.bounds(feature);
  const dx = b[1][0] - b[0][0], dy = b[1][1] - b[0][1];
  const k = Math.max(1, Math.min(40, 0.55 / Math.max(dx / width, dy / height)));
  const cx = (b[0][0] + b[1][0]) / 2, cy = (b[0][1] + b[1][1]) / 2;
  svg.transition().duration(400).call(zoom.transform,
    d3.zoomIdentity.translate(width / 2 - k * cx, height / 2 - k * cy).scale(k));
}
