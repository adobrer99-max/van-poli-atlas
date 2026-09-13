/* --- Turnout tab -------------------------------------------------------------
   Rows are rebuilt from the loaded results on every change. The maths lives in
   f2-turnout.js; this file only wires controls, the table, the curve and the
   basket, and keeps the map's turnout shading in step. */

const UNIT_NAMES = { fed: 'federal (2025) polling divisions', prov: 'provincial (2024) voting areas',
                     atom: 'overlap pieces' };

/* Feature behind a row index, in whichever index space the sources used:
   crosswalk-local once a crosswalk exists, otherwise the layer's own. */
function turnoutFeature(side, i) {
  if (state.pairs && state.crosswalkFed && state.crosswalkProv) {
    return side === 'fed' ? state.crosswalkFed[i] : state.crosswalkProv[i];
  }
  return side === 'fed' ? state.fed.all[i] : state.prov.all[i];
}

/* Census residents aged 15 and over for each row, on whichever geography the
   tab is ranking. Null on the overlap pieces: a piece of a federal poll inside
   a voting area has no dissemination-area pair of its own, so the census
   denominator simply is not available there and the column says so by being
   absent. The federal one still is, since it travels on the row itself. */
function adultsForRows(unit) {
  if (unit === 'atom') return null;
  const by = residentAdultsOn(unit);
  if (!by) return null;
  const id = unit === 'fed' ? (f) => f.idx : (f) => f.__idx;
  return (row) => {
    const f = turnoutFeature(unit, +row.key);
    return f ? (by.get(id(f)) ?? null) : null;
  };
}

function turnoutSources() {
  const usePairs = Boolean(state.pairs && state.crosswalkFed && state.crosswalkProv);
  const sources = [];
  const fv = fedValues();
  if (fv) {
    const values = new Map();
    if (usePairs) state.crosswalkFed.forEach((f, i) => { const u = fv.get(f.idx); if (u) values.set(i, u); });
    else activeFederal().forEach((f) => { const u = fv.get(f.idx); if (u) values.set(f.idx, u); });
    sources.push({ id: 'fed', values, pairs: usePairs ? state.pairs : null });
  }
  const pv = provValues();
  if (pv) {
    const values = new Map();
    if (usePairs) state.crosswalkProv.forEach((f, i) => { const u = pv.get(f.__idx); if (u) values.set(i, u); });
    else state.prov.active.forEach((f) => { const u = pv.get(f.__idx); if (u) values.set(f.__idx, u); });
    sources.push({ id: 'prov', values, pairs: usePairs ? state.pairs : null });
  }
  return sources;
}

/* Basket membership is keyed by stable feature keys, not row indices, so it
   survives a rebuild of the crosswalk. */
function basketKeyFor(unit, row) {
  if (unit === 'fed') return turnoutFeature('fed', +row.key)?.key ?? null;
  if (unit === 'prov') return turnoutFeature('prov', +row.key)?.__key ?? null;
  const [fi, pi] = row.key.split('|').map(Number);
  const f = turnoutFeature('fed', fi), p = turnoutFeature('prov', pi);
  return f && p ? `${f.key}|${p.__key}` : null;
}
function basketKeyForSelection() {
  const unit = state.turnout.unit, { fed, prov } = state.selection;
  if (unit === 'fed') return fed ? fed.key : null;
  if (unit === 'prov') return prov ? prov.__key : null;
  return fed && prov ? `${fed.key}|${prov.__key}` : null;
}

function refreshTurnout() {
  const statsHost = $('turnout-stats');
  if (!statsHost) return;
  const t = state.turnout;
  t.unit = $('turnout-unit').value;
  t.weight = parseFloat($('turnout-weight').value);
  t.apportion.fed = $('apportion-fed').value;
  t.apportion.prov = $('apportion-prov').value;
  t.minElectors = parseFloat($('turnout-min-electors').value);
  $('turnout-weight-label').textContent =
    `${Math.round(t.weight * 100)}% federal · ${Math.round((1 - t.weight) * 100)}% provincial`;

  /* Apportionment changes which values every reader sees, so the provincial
     votes pushed onto federal polls must follow. */
  recomputeProvincialOnFederal();
  recomputeProvincialParticipation();

  const sources = turnoutSources();
  statsHost.textContent = '';
  const results = $('turnout-results'), basketCard = $('turnout-basket-card');
  if (!sources.length) {
    setStatus('turnout-status', 'idle',
      ['Load federal or provincial results on the Data tab. Turnout needs an electors count in the file.']);
    t.rows = null; results.hidden = true; basketCard.hidden = true;
    restyleMapForTurnout();
    return;
  }
  const labels = {
    fed: (i) => turnoutFeature('fed', i)?.label ?? `poll ${i}`,
    prov: (i) => provLabel(turnoutFeature('prov', i)),
  };
  let rows = Turnout.rowsOnUnit(t.unit, sources, labels, { minElectors: t.minElectors });
  rows = Turnout.score(rows, { weights: { fed: t.weight, prov: 1 - t.weight } });
  /* Provincial ballots over the two denominators that can be had for an area.
     Computed always, reported only where a denominator resolved, and kept out
     of the aggregate: score() above is the only thing that writes a turnout. */
  Turnout.participation(rows, { side: 'prov', adultsOf: adultsForRows(t.unit) });
  rows.forEach((r) => { r.basketKey = basketKeyFor(t.unit, r); });
  const ranked = sortTurnoutRows(rows);
  t.rows = ranked;

  const withAgg = ranked.filter((r) => r.agg != null);
  const both = ranked.filter((r) => !r.partial);
  const electors = withAgg.reduce((a, r) => a + r.electors, 0);
  const expected = withAgg.reduce((a, r) => a + (r.expected || 0), 0);
  const curve = Turnout.cumulative(withAgg);
  const at = (share) => curve.find((p) => p.shareOfAreas >= share) || curve[curve.length - 1];
  const top20 = curve.length ? at(0.2) : null;

  const stat = (label, value, note) => {
    const box = el('div', 'viz-stat');
    box.append(el('div', 'viz-stat-value', value), el('div', 'text-small text-muted', label));
    if (note) box.append(el('div', 'text-small text-muted', note));
    return box;
  };
  statsHost.append(
    stat('areas ranked', fmtInt(withAgg.length), `${fmtInt(both.length)} with both elections`),
    stat('electors in ranked areas', fmtInt(electors)),
    stat('pooled aggregate turnout', fmtPct(electors > 0 ? expected / electors : null)),
    stat('top 20% of areas hold', top20 ? fmtPct(top20.shareOfElectors) : '--', 'of electors'),
  );

  const lines = [];
  lines.push(`${fmtInt(withAgg.length)} ${UNIT_NAMES[t.unit]} ranked`
    + (state.pairs ? '.' : ' — without a crosswalk only the election native to this geography is included; build it on the Correlation tab to combine both.'));
  const ap = [];
  for (const side of ['fed', 'prov']) {
    const mode = t.apportion[side];
    const store = side === 'fed' ? state.fedResults : state.provResults;
    if (mode === 'none' || !store?.apportioned) continue;
    const a = store.apportioned[mode];
    const who = side === 'fed' ? 'federal' : 'provincial';
    /* An advance poll spread over the ten divisions that fed it is a far
       smaller claim than one spread over a whole riding, so the two are
       counted separately rather than reported as one number. */
    if (a.advancePools) {
      ap.push(`${fmtInt(a.advanceApportioned)} ${who} advance ballots went to the divisions that fed `
        + `each of ${fmtInt(a.advancePools)} advance polls (${a.advanceUnitsMean.toFixed(1)} divisions `
        + `each on average), apportioned by ${mode}`);
    }
    const wide = a.apportioned - (a.advanceApportioned || 0);
    if (wide > 0.5) {
      ap.push(`${fmtInt(wide)} ${who} ballots with no narrower geography — special ballots, mail — `
        + `spread across ${fmtInt(a.districts)} whole districts by ${mode}`);
    }
    if (a.withheld > 0.5) {
      ap.push(`${fmtInt(a.withheld)} were cast outside the study area and are not spread onto it`);
    }
  }
  if (ap.length) {
    lines.push(el('p', 'text-warning', ap.join('; ')
      + '. A ballot spread over the divisions that fed its advance poll is on far firmer ground '
      + 'than one spread across a district, but neither is a measurement — see Method.'));
  }
  for (const line of participationLines(ranked)) lines.push(line);
  setStatus('turnout-status', 'ok', lines);

  results.hidden = withAgg.length === 0;
  basketCard.hidden = withAgg.length === 0;
  renderTurnoutTable(ranked);
  drawTurnoutCurve(curve, top20);
  renderBasket();
  restyleMapForTurnout();
}

/* What the two denominator columns are, said in the tab rather than only in
   the Method — including how many areas came out over 100%, which is the
   honest way to show that a borrowed denominator does not fit everywhere. */
function participationLines(rows) {
  const out = [];
  const withFed = rows.filter((r) => r.p?.perFedElector != null).length;
  const withAdult = rows.filter((r) => r.p?.perAdult != null).length;
  if (!withFed && !withAdult) return out;
  const both = [];
  if (withFed) both.push('the 2025 federal roll carried onto these areas by the crosswalk');
  if (withAdult) both.push('census residents aged 15 and over');
  const pair = withFed && withAdult;
  out.push(el('p', 'text-small text-muted',
    `The last ${pair ? 'three columns are' : 'column is'} not turnout: Elections BC publishes `
    + 'registered voters per electoral district and never per voting area, so provincial ballots '
    + `are divided by ${both.join(' and by ')} instead. `
    + (pair
      ? 'Neither is a provincial electorate, and the spread between them is the size of that choice. '
      : 'That is not a provincial electorate; load the other layer to see a second denominator beside it. ')
    + 'See the Method tab.'));
  const over = (key) => Turnout.overOne(rows, key);
  const bits = [];
  if (withFed && over('perFedElector')) bits.push(`${fmtInt(over('perFedElector'))} over 100% of federal electors`);
  if (withAdult && over('perAdult')) bits.push(`${fmtInt(over('perAdult'))} over 100% of residents 15+`);
  if (bits.length) {
    out.push(el('p', 'text-small text-warning',
      `${bits.join('; ')} — in those areas the denominator does not describe the people who voted there, `
      + 'which is a fact about the denominator rather than about the ballots.'));
  }
  return out;
}

function sortTurnoutRows(rows) {
  const t = state.turnout;
  /* A column can be withdrawn between refreshes -- unloading the census takes
     the resident denominator with it -- and sorting on one that is no longer
     there would silently order the table by nothing. */
  if (!turnoutColumns(rows).some((c) => c.key === t.sortKey)) { t.sortKey = 'agg'; t.sortDir = 'desc'; }
  const { sortKey, sortDir } = t;
  if (sortKey === 'label') {
    const sorted = rows.slice().sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    if (sortDir === 'desc') sorted.reverse();
    Turnout.rank(rows, 'agg');           // ranks always follow the aggregate
    return sorted;
  }
  const byAgg = Turnout.rank(rows, 'agg');
  if (sortKey === 'agg' && sortDir === 'desc') return byAgg;
  return Turnout.rank(rows, sortKey, sortDir).map((r) => r); // rank numbers were set by agg above
}

const TURNOUT_COLUMNS = [
  { key: 'rank', label: '#', get: (r) => r.rank, fmt: (v) => String(v) },
  { key: 'label', label: 'Area', get: (r) => r.label, fmt: (v) => v, left: true },
  { key: 't.fed', label: 'Federal 2025', get: (r) => r.t.fed, fmt: fmtPct },
  { key: 't.prov', label: 'Provincial 2024', get: (r) => r.t.prov, fmt: fmtPct },
  { key: 'agg', label: 'Aggregate', get: (r) => r.agg, fmt: fmtPct },
  { key: 'min', label: 'Minimum', get: (r) => r.min, fmt: fmtPct },
  { key: 'delta', label: 'Fed − prov', get: (r) => r.delta,
    fmt: (v) => (v == null ? '--' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)} pt`) },
  { key: 'electors', label: 'Electors', get: (r) => r.electors, fmt: fmtInt },
  { key: 'expected', label: 'Expected ballots', get: (r) => r.expected, fmt: (v) => (v == null ? '--' : fmtInt(v)) },
  /* Not turnout, and never headed as one. The provincial side has ballots on
     every area and registered voters on none, so these divide by the two
     counts that can be carried onto an area instead -- shown together, because
     the distance between them is the size of the choice. */
  { key: 'p.perFedElector', label: 'Per fed elector', get: (r) => r.p?.perFedElector ?? null, fmt: fmtPct },
  { key: 'p.perAdult', label: 'Per resident 15+', get: (r) => r.p?.perAdult ?? null, fmt: fmtPct },
  { key: 'p.spread', label: 'Spread', get: (r) => r.p?.spread ?? null,
    fmt: (v) => (v == null ? '--' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)} pt`) },
];

/* A column of dashes says nothing. Each denominator appears only where it
   resolved for at least one area, exactly as the Results tab drops its turnout
   column for a file that carries no electors. */
function turnoutColumns(rows) {
  const has = (key) => rows.some((r) => r.p && r.p[key] != null);
  const drop = new Set();
  if (!has('perFedElector')) drop.add('p.perFedElector');
  if (!has('perAdult')) drop.add('p.perAdult');
  if (drop.size) drop.add('p.spread');
  return TURNOUT_COLUMNS.filter((c) => !drop.has(c.key));
}

function renderTurnoutTable(rows) {
  const table = $('turnout-table');
  table.textContent = '';
  const columns = turnoutColumns(rows);
  const thead = el('thead'), hr = el('tr');
  hr.append(el('th', 'text-start', ''));
  for (const c of columns) {
    const th = el('th', c.left ? 'text-start' : null, c.label);
    if (c.key === state.turnout.sortKey) th.classList.add('sorted', state.turnout.sortDir);
    th.dataset.key = c.key;
    th.addEventListener('click', () => {
      const t = state.turnout;
      if (t.sortKey === c.key) t.sortDir = t.sortDir === 'desc' ? 'asc' : 'desc';
      else { t.sortKey = c.key; t.sortDir = c.key === 'label' ? 'asc' : 'desc'; }
      refreshTurnout();
    });
    hr.append(th);
  }
  thead.append(hr);
  const tbody = el('tbody');
  const frag = document.createDocumentFragment();
  for (const r of rows) {
    if (r.agg == null) continue;
    const tr = el('tr');
    tr.dataset.key = r.basketKey || '';
    if (r.partial) tr.classList.add('partial');
    if (r.basketKey && state.turnout.basket.has(r.basketKey)) tr.classList.add('in-basket');
    const td0 = el('td', 'text-start');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = tr.classList.contains('in-basket');
    cb.disabled = !r.basketKey;
    cb.setAttribute('aria-label', `Add ${r.label} to basket`);
    cb.addEventListener('change', () => toggleBasket(r.basketKey));
    td0.append(cb); tr.append(td0);
    for (const c of columns) {
      const v = c.get(r);
      tr.append(el('td', c.left ? 'text-start' : null, v == null ? '--' : c.fmt(v)));
    }
    frag.append(tr);
  }
  tbody.append(frag);
  table.append(thead, tbody);
  $('turnout-note').textContent = rows.some((r) => r.partial)
    ? 'Italic rows have only one election; their aggregate is that election alone.' : '';
}

function drawTurnoutCurve(curve, top20) {
  const node = $('turnout-curve');
  const sel = d3.select(node);
  sel.selectAll('*').remove();
  const caption = $('turnout-curve-caption');
  if (!curve.length) { caption.textContent = ''; return; }
  const w = Math.max(320, node.getBoundingClientRect().width || 640);
  const h = Math.max(200, Math.min(300, w * 0.42));
  sel.attr('viewBox', `0 0 ${w} ${h}`).attr('height', h);
  const m = { top: 12, right: 16, bottom: 40, left: 52 };
  const x = d3.scaleLinear().domain([0, 1]).range([m.left, w - m.right]);
  const y = d3.scaleLinear().domain([0, 1]).range([h - m.bottom, m.top]);
  const pct = d3.format('.0%');
  sel.append('g').attr('class', 'axis').attr('transform', `translate(0,${h - m.bottom})`)
    .call(d3.axisBottom(x).ticks(5).tickFormat(pct));
  sel.append('g').attr('class', 'axis').attr('transform', `translate(${m.left},0)`)
    .call(d3.axisLeft(y).ticks(5).tickFormat(pct));
  sel.append('text').attr('class', 'axis-label').attr('x', (m.left + w - m.right) / 2).attr('y', h - 6)
    .attr('text-anchor', 'middle').text('share of areas, best turnout first');
  sel.append('text').attr('class', 'axis-label').attr('transform', 'rotate(-90)')
    .attr('x', -(m.top + h - m.bottom) / 2).attr('y', 14).attr('text-anchor', 'middle').text('share held');
  sel.append('path').attr('class', 'diag').attr('d', `M${x(0)},${y(0)}L${x(1)},${y(1)}`);
  const line = (k) => d3.line().x((p) => x(p.shareOfAreas)).y((p) => y(p[k]));
  const pts = [{ shareOfAreas: 0, shareOfElectors: 0, shareOfExpected: 0 }, ...curve];
  sel.append('path').attr('class', 'line-expected').attr('d', line('shareOfExpected')(pts));
  sel.append('path').attr('class', 'line').attr('d', line('shareOfElectors')(pts));
  caption.textContent = top20
    ? `Solid: electors. Dashed: expected ballots. The top 20% of areas by aggregate turnout hold `
      + `${fmtPct(top20.shareOfElectors)} of electors and ${fmtPct(top20.shareOfExpected)} of expected ballots.`
    : '';
}

/* --- Basket ----------------------------------------------------------------- */

function toggleBasket(key) {
  if (!key) return;
  const b = state.turnout.basket;
  if (b.has(key)) b.delete(key); else b.add(key);
  const row = $('turnout-table').querySelector(`tr[data-key="${CSS.escape(key)}"]`);
  if (row) {
    row.classList.toggle('in-basket', b.has(key));
    const cb = row.querySelector('input[type=checkbox]');
    if (cb) cb.checked = b.has(key);
  }
  renderBasket();
  markBasketOnMap();
  renderReadout();
}

function renderBasket() {
  const host = $('turnout-basket');
  if (!host) return;
  host.textContent = '';
  const rows = state.turnout.rows || [];
  const keys = state.turnout.basket;
  const summary = Turnout.basketSummary(rows.map((r) => ({ ...r, key: r.basketKey })), keys,
    { weights: { fed: state.turnout.weight, prov: 1 - state.turnout.weight } });
  const stat = (label, value) => {
    const box = el('div', 'viz-stat');
    box.append(el('div', 'viz-stat-value', value), el('div', 'text-small text-muted', label));
    return box;
  };
  host.append(
    stat('areas in basket', fmtInt(summary.count)),
    stat('electors', fmtInt(summary.electors)),
    stat('expected ballots', fmtInt(summary.expected)),
    stat('federal 2025 turnout', fmtPct(summary.per.fed?.rate)),
    stat('provincial 2024 turnout', fmtPct(summary.per.prov?.rate)),
    stat('aggregate turnout', fmtPct(summary.agg)),
  );
}

function markBasketOnMap() {
  const b = state.turnout.basket, unit = state.turnout.unit;
  const fedKeys = new Set(), provKeys = new Set();
  for (const k of b) {
    if (unit === 'fed') fedKeys.add(k);
    else if (unit === 'prov') provKeys.add(k);
    else { const [f, p] = k.split('|'); fedKeys.add(f); provKeys.add(p); }
  }
  gFed.selectAll('path').classed('basket', (f) => fedKeys.has(f.key));
  gProv.selectAll('path').classed('basket', (f) => provKeys.has(f.__key));
}

function restyleMapForTurnout() {
  /* The two denominator shadings become available only once they are computed,
     so the options are re-checked here rather than only on the next redraw. */
  updatePlaceControls();
  applyFederalStyle(gFed.selectAll('path'));
  applyProvincialStyle(gProv.selectAll('path'));
  renderLegend();
  markBasketOnMap();
}

for (const id of ['turnout-unit', 'turnout-weight', 'turnout-min-electors', 'apportion-fed', 'apportion-prov']) {
  $(id).addEventListener('change', refreshTurnout);
}
$('turnout-weight').addEventListener('input', () => {
  const w = parseFloat($('turnout-weight').value);
  $('turnout-weight-label').textContent = `${Math.round(w * 100)}% federal · ${Math.round((1 - w) * 100)}% provincial`;
});
$('export-turnout').addEventListener('click', () => {
  const rows = (state.turnout.rows || []).filter((r) => r.agg != null);
  if (!rows.length) { $('turnout-note').textContent = 'Nothing to export yet.'; return; }
  downloadCsv(`vancouver-turnout-${state.turnout.unit}.csv`, Turnout.toCsv(rows));
  $('turnout-note').textContent = `Saved vancouver-turnout-${state.turnout.unit}.csv (${fmtInt(rows.length)} rows).`;
});
$('basket-add-top').addEventListener('click', () => {
  const n = Math.max(1, parseInt($('basket-top-n').value, 10) || 50);
  const rows = Turnout.rank((state.turnout.rows || []).filter((r) => r.agg != null), 'agg');
  for (const r of rows.slice(0, n)) if (r.basketKey) state.turnout.basket.add(r.basketKey);
  renderTurnoutTable(state.turnout.rows || []);
  renderBasket(); markBasketOnMap(); renderReadout();
});
$('basket-clear').addEventListener('click', () => {
  state.turnout.basket.clear();
  renderTurnoutTable(state.turnout.rows || []);
  renderBasket(); markBasketOnMap(); renderReadout();
});
