/* --- Socioeconomic tab ------------------------------------------------------
   Election results moved onto Statistics Canada's dissemination areas through
   the sample-table crosswalk, correlated with census variables. The maths is
   in f2-turnout.js (rows on a target geography), e-analysis.js (correlateXY)
   and f3-census.js (variables); this file wires the controls, the variable
   picker, the table, the scatter and the export, and keeps the map's
   dissemination-area shading in step. */

function daLabel(f) {
  if (!f) return 'Dissemination area';
  const k = state.da.keyProp;
  const v = k ? f.properties[k] : null;
  return v != null && String(v).trim() !== '' ? `DA ${String(v).trim()}` : `DA #${f.__idx}`;
}

/* The geographies a correlation can run on. Dissemination areas are where the
   census lives; voting areas are where the provincial results live. Running on
   the voting areas drops a whole modelling step from the provincial side --
   place to area, and then no further -- at the cost of moving the census the
   other way instead. */
const SOCIO_UNITS = {
  da: { name: 'dissemination areas', one: 'dissemination area', label: (f) => daLabel(f),
        idColumn: 'da_id', file: 'vancouver-da-joined.csv', keyProp: () => state.da.keyProp },
  prov: { name: 'provincial voting areas', one: 'voting area', label: (f) => provLabel(f),
          idColumn: 'va_id', file: 'vancouver-voting-area-joined.csv',
          keyProp: () => state.prov.keyDef?.poll },
};

/* A unit is on offer only when its layer is in the sample alongside the
   census, since the variables have to be carried across. */
function socioUnitsAvailable() {
  const s = state.sample;
  const out = ['da'];
  if (s && s.ids.includes('da') && s.ids.includes('prov') && state.prov.all.length) out.push('prov');
  return out;
}

/* Offer only the units that can actually be computed, and keep whatever the
   user picked if it is still among them. */
function renderSocioUnits() {
  const sel = $('socio-unit');
  if (!sel) return;
  const available = socioUnitsAvailable();
  const previous = sel.value;
  fillSelect(sel, available.map((k) => ({ value: k, label: SOCIO_UNITS[k].name })),
    available.includes(previous) ? previous : 'da');
  sel.disabled = available.length < 2;
  const note = $('socio-unit-note');
  if (note) {
    note.textContent = available.length < 2
      ? 'Load the provincial voting areas and build the crosswalk to correlate on them as well.'
      : (sel.value === 'da'
        ? 'Census variables sit here natively; provincial results are carried in through the crosswalk.'
        : 'Provincial results sit here natively; census variables are carried in, counts shared out and rates averaged by population.');
  }
}

function socioUnit() {
  const wanted = $('socio-unit') ? $('socio-unit').value : 'da';
  const available = socioUnitsAvailable();
  return available.includes(wanted) ? wanted : 'da';
}

/* Sources in the crosswalk's index space (active-layer indices). A source
   native to the chosen unit is used as it stands; the others are moved through
   their own pair with it. */
function socioSources(unit) {
  const s = state.sample;
  if (!s || !s.ids.includes(unit)) return [];
  const sources = [];
  const add = (id, values, key) => {
    const native = id === unit;
    const c = native ? null : crossPair(id, unit);
    if (!native && !c) return;
    const m = new Map();
    state[id].active.forEach((f, i) => { const u = values.get(f[key]); if (u) m.set(i, u); });
    sources.push({ id, values: m, pairs: c ? c.pairs : null, side: 'a' });
  };
  const fv = fedValues(); if (fv) add('fed', fv, 'idx');
  const pv = provValues(); if (pv) add('prov', pv, '__idx');
  return sources;
}

/* Census residents aged 15 and over per row on this tab. Rows here carry their
   feature directly, so the lookup is by the feature's own index. */
function socioAdultsOf(unit) {
  const by = residentAdultsOn(unit);
  if (!by) return null;
  const id = unit === 'fed' ? (f) => f.idx : (f) => f.__idx;
  return (row) => (row.feature ? (by.get(id(row.feature)) ?? null) : null);
}

/* The chosen outcome as a function of a scored row; null when unavailable. */
/* usesProvincial marks an outcome that reads the provincial numbers, which
   matters when those were modelled from voting places: the areas of one
   catchment then carry a single measurement between them. */
function socioOutcome(mode) {
  if (mode === 'turnout-fed') return { label: 'Federal (2025) turnout', of: (r) => r.t.fed, format: fmtPct, usesProvincial: false };
  if (mode === 'turnout-prov') return { label: 'Provincial (2024) turnout', of: (r) => r.t.prov, format: fmtPct, usesProvincial: true };
  /* Not turnout: a voting area has no electorate of its own, so these divide
     the ballots by the two counts that can be carried onto it. `circular` marks
     the second, whose denominator comes out of the same census as the
     variables it would be correlated against. */
  if (mode === 'part-fed') {
    return { label: 'Provincial ballots per federal elector', of: (r) => r.p?.perFedElector ?? null,
             format: fmtPct, usesProvincial: true };
  }
  if (mode === 'part-adult') {
    return { label: 'Provincial ballots per resident 15+', of: (r) => r.p?.perAdult ?? null,
             format: fmtPct, usesProvincial: true, circular: true };
  }
  const m = /^(fed|prov):(.*)$/.exec(mode);
  if (m) {
    const side = m[1], party = m[2];
    return { label: `${party} share, ${side === 'fed' ? 'federal 2025' : 'provincial 2024'}`,
             of: (r) => Analysis.shareOf(r.by[side], party), format: fmtPct,
             usesProvincial: side === 'prov' };
  }
  return { label: 'Aggregate turnout, both elections', of: (r) => r.agg, format: fmtPct,
           usesProvincial: true };
}

/* How a variable survives being carried to another geography. A count is
   shared out; anything else is averaged, because rates and medians do not add.
   A long profile says which it is; a wide file does not, so the tool's own
   C<id> / R<id> spelling and a few obvious names stand in, and the picker
   shows the treatment so the guess is never silent. */
function variableKind(v) {
  if (v.use === 'count' || v.use === 'complement') return 'count';
  if (v.use) return 'mean';
  if (/^C\d+$/i.test(v.key)) return 'count';
  if (/^R\d+$/i.test(v.key)) return 'mean';
  if (/(^|_)(pop|population|count|total|dwellings?|households?)(_|$)/i.test(v.key)) return 'count';
  return 'mean';
}

/* Every variable currently available on the chosen unit: on the dissemination
   areas they are as loaded; anywhere else they are carried across the
   crosswalk. Each has byFeature: Map<feature __idx, value>. */
let movedVariables = null;
function socioVariables(unit = 'da') {
  if (unit === 'da') return state.da.variables;
  const source = state.da.variables;
  const signature = [unit, state.weightingInEffect, $('min-overlap').value,
                     source.map((v) => v.key).join(',')].join('|');
  if (movedVariables && movedVariables.signature === signature) return movedVariables.variables;
  const c = crossPair('da', unit);
  if (!c) return [];
  const target = state[unit].active;
  const variables = source.map((v) => {
    const kind = variableKind(v);
    const onActive = new Map();
    state.da.active.forEach((f, i) => {
      const x = v.byFeature.get(f.__idx);
      if (x != null && isFinite(x)) onActive.set(i, x);
    });
    const moved = Analysis.moveVariable(c.pairs, onActive, { from: 'a', kind });
    const byFeature = new Map();
    for (const [i, value] of moved) {
      const f = target[i];
      if (f) byFeature.set(f.__idx, value);
    }
    return { ...v, byFeature, kind,
             movedAs: kind === 'count' ? 'shared out' : 'population-weighted mean' };
  });
  movedVariables = { signature, variables };
  return variables;
}
function clearMovedVariables() { movedVariables = null; }

function refreshSocio() {
  const statsHost = $('socio-stats');
  if (!statsHost) return;
  const st = state.socio;
  renderSocioUnits();
  const unit = socioUnit();
  st.unit = unit;
  const U = SOCIO_UNITS[unit];
  st.outcome = $('socio-outcome').value;
  st.minElectors = parseFloat($('socio-min-electors').value);
  statsHost.textContent = '';
  const results = $('socio-results');

  const missing = [];
  if (!state.da.all.length) missing.push('the dissemination-area boundaries (Data tab, section 4)');
  if (state.da.all.length && !state.da.variables.length) missing.push('a census profile joined to them');
  if (!state.fedResults?.values && !state.provResults?.values) missing.push('federal or provincial results');
  if (state.da.all.length && (!state.sample || !state.sample.ids.includes('da'))) {
    missing.push('the crosswalk (build it on the Correlation tab after loading the census layer)');
  }
  if (missing.length) {
    setStatus('socio-status', 'idle', [`Needed first: ${missing.join('; ')}.`]);
    st.rows = null; st.byDa = null; st.byUnit = null; st.table = null;
    results.hidden = true;
    restyleDa();
    return;
  }

  const sources = socioSources(unit);
  const labels = {
    fed: (i) => state.fed.active[i]?.label ?? `poll ${i}`,
    prov: (i) => provLabel(state.prov.active[i]),
    da: (i) => daLabel(state.da.active[i]),
  };
  const scoredOn = (target, srcs) => {
    const out = Turnout.score(
      Turnout.rowsOnUnit(target, srcs, labels, { minElectors: st.minElectors }),
      { weights: { fed: state.turnout.weight, prov: 1 - state.turnout.weight } });
    for (const r of out) r.feature = state[target].active[+r.key];
    return out;
  };
  let rows = scoredOn(unit, sources);
  /* The same two denominators the Turnout tab reports, on whichever geography
     this tab is using, so an outcome can be one of them. */
  Turnout.participation(rows, { side: 'prov', adultsOf: socioAdultsOf(unit) });
  /* The map's dissemination-area shading and the readout's census card read
     their own rows, so they are kept whichever unit the table is using. */
  st.byDa = unit === 'da' ? null
    : new Map(scoredOn('da', socioSources('da')).map((r) => [r.feature.__idx, r]));
  const outcome = socioOutcome(st.outcome);
  /* An area covered by only one election carries that election alone as its
     "aggregate"; by default those stay out of a correlation.

     What "covered" means depends on the outcome, and getting that wrong empties
     the tab. row.partial asks whether both sides produced a turnout RATE, and a
     rate needs electors. Results reported by voting place carry none -- which is
     the entire reason the two participation outcomes exist. Filtering by
     row.partial therefore removed every area for exactly the outcomes built to
     survive a missing denominator, and the tab read "0 areas" with no hint why.

     So an outcome that needs rates keeps the rate test, and everything else
     asks the weaker, correct question: did both elections put ballots here. */
  const sideKeys = sources.map((s) => s.key);
  const needsRates = ['turnout-fed', 'turnout-prov', 'agg'].includes(st.outcome)
    || !/^(part-fed|part-adult|fed:|prov:)/.test(st.outcome);
  const incomplete = needsRates
    ? (r) => r.partial
    : (r) => !sideKeys.every((k) => (r.ballots && r.ballots[k] > 0));
  const partialCount = rows.filter(incomplete).length;
  const bothOnly = $('socio-both-only').checked && sources.length > 1;
  if (bothOnly) rows = rows.filter((r) => !incomplete(r));
  st.rows = rows;
  st.byUnit = new Map(rows.map((r) => [r.feature.__idx, r]));
  if (unit === 'da') st.byDa = st.byUnit;
  const groupOf = unit === 'prov' ? provPlaceGroup : daPlaceGroup;
  const table = [];
  for (const v of socioVariables(unit)) {
    if (!st.selected.has(v.key)) continue;
    const pts = [];
    for (const r of rows) {
      const y = outcome.of(r);
      const x = v.byFeature.get(r.feature.__idx);
      if (y == null || !isFinite(y) || x == null || !isFinite(x)) continue;
      pts.push({ x, y, weight: r.electors, label: U.label(r.feature), key: r.key,
                 group: outcome.usesProvincial ? groupOf(r.feature.__idx) : null });
    }
    const c = Analysis.correlateXY(pts);
    table.push({ key: v.key, label: v.label, movedAs: v.movedAs || null,
                 n: pts.length, nEffective: c.nEffective,
                 grouped: c.grouped, r: c.r, rWeighted: c.rWeighted, rho: c.rho,
                 ci: c.ci, absR: c.r == null ? null : Math.abs(c.r), points: pts, fit: c.fit });
  }
  st.table = table;

  const withOutcome = rows.filter((r) => outcome.of(r) != null);
  const electors = withOutcome.reduce((a, r) => a + r.electors, 0);
  const stat = (label, value, note) => {
    const box = el('div', 'viz-stat');
    box.append(el('div', 'viz-stat-value', value), el('div', 'text-small text-muted', label));
    if (note) box.append(el('div', 'text-small text-muted', note));
    return box;
  };
  statsHost.append(
    stat(U.name, fmtInt(withOutcome.length), `of ${fmtInt(state[unit].active.length)} in the study area`),
    stat('electors located', fmtInt(electors)),
    stat('overlaps weighted by', state.weightingShort || 'area', state.weightingDetail || null),
    stat('variables compared', fmtInt(table.length),
      `${fmtInt(socioVariables(unit).length)} available`
      + (unit === 'da' ? '' : ', carried from the dissemination areas')),
  );
  const lines = [`${fmtInt(withOutcome.length)} ${U.name} carry ${outcome.label.toLowerCase()}; `
    + `${sources.map((s) => (s.id === 'fed' ? 'federal (2025)' : 'provincial (2024)')).join(' and ')} results moved through the crosswalk`
    + (partialCount
      ? ` (${fmtInt(partialCount)} areas ${needsRates ? 'lack a turnout rate on one side' : 'carry ballots from only one election'}`
        + `${bothOnly ? ' and are left out' : ' and are included with what they have'}).`
      : '.')];
  if (bothOnly && !withOutcome.length && partialCount) {
    lines.push(el('p', 'text-warning',
      needsRates
        ? 'Every area is missing a turnout rate on one side, so this outcome has nothing to show. '
          + 'Results reported by voting place carry no electors, and a turnout rate needs them — '
          + 'pick one of the two "ballots per…" outcomes instead, which exist for this case, '
          + 'or untick "Only areas with both elections".'
        : 'No area carries ballots from both elections. Untick "Only areas with both elections" '
          + 'to see the areas that carry one.'));
  }
  if (state.da.census?.unmatched?.length) {
    lines.push(el('p', 'text-small text-muted',
      `Starter variables not found in this profile: ${state.da.census.unmatched.join(', ')}. Add them by name below if the file spells them differently.`));
  }
  setStatus('socio-status', 'ok', lines);
  results.hidden = false;
  renderSocioPicker();
  renderSocioTable();
  if (st.picked && !table.some((t) => t.key === st.picked)) st.picked = table.length ? table[0].key : null;
  if (!st.picked && table.length) st.picked = sortedSocio(table)[0].key;
  drawSocioScatter();
  restyleDa();
}

function sortedSocio(table) {
  const { sortKey, sortDir } = state.socio;
  const val = (t) => (sortKey === 'label' ? t.label : t[sortKey]);
  return table.slice().sort((a, b) => {
    const x = val(a), y = val(b);
    if (sortKey === 'label') return sortDir === 'desc' ? String(y).localeCompare(String(x)) : String(x).localeCompare(String(y));
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return sortDir === 'desc' ? y - x : x - y;
  });
}

const SOCIO_COLUMNS = [
  { key: 'label', label: 'Census variable', get: (t) => t.label, fmt: (v) => v, left: true },
  { key: 'n', label: 'n', get: (t) => t.n, fmt: fmtInt },
  { key: 'r', label: 'Pearson r', get: (t) => t.r, fmt: (v) => fmtNum(v, 3) },
  { key: 'rWeighted', label: 'Electors-weighted r', get: (t) => t.rWeighted, fmt: (v) => fmtNum(v, 3) },
  { key: 'rho', label: "Spearman's rho", get: (t) => t.rho, fmt: (v) => fmtNum(v, 3) },
  { key: 'absR', label: '|r|', get: (t) => t.absR, fmt: (v) => fmtNum(v, 3) },
  { key: 'nEffective', label: 'sources', get: (t) => (t.grouped ? t.nEffective : null),
    fmt: (v) => fmtInt(v) },
  { key: 'ci', label: '95% CI of r', get: (t) => t.ci, fmt: (v) => `${fmtNum(v[0], 2)} to ${fmtNum(v[1], 2)}` },
];

function renderSocioTable() {
  const table = $('socio-table');
  table.textContent = '';
  const st = state.socio;
  const thead = el('thead'), hr = el('tr');
  for (const c of SOCIO_COLUMNS) {
    const th = el('th', c.left ? 'text-start' : null, c.label);
    if (c.key === st.sortKey) th.classList.add('sorted', st.sortDir);
    th.addEventListener('click', () => {
      if (st.sortKey === c.key) st.sortDir = st.sortDir === 'desc' ? 'asc' : 'desc';
      else { st.sortKey = c.key; st.sortDir = c.key === 'label' ? 'asc' : 'desc'; }
      renderSocioTable();
    });
    hr.append(th);
  }
  thead.append(hr);
  const tbody = el('tbody');
  for (const t of sortedSocio(st.table || [])) {
    const tr = el('tr');
    tr.dataset.key = t.key;
    if (t.key === st.picked) tr.classList.add('picked');
    for (const c of SOCIO_COLUMNS) {
      const v = c.get(t);
      tr.append(el('td', c.left ? 'text-start' : null, v == null ? '--' : c.fmt(v)));
    }
    tr.addEventListener('click', () => { st.picked = t.key; renderSocioTable(); drawSocioScatter(); });
    tbody.append(tr);
  }
  table.append(thead, tbody);
}

function drawSocioScatter() {
  const st = state.socio;
  const node = $('socio-scatter');
  const caption = $('socio-scatter-caption');
  const t = (st.table || []).find((x) => x.key === st.picked);
  if (!t) { d3.select(node).selectAll('*').remove(); caption.textContent = ''; return; }
  const outcome = socioOutcome(st.outcome);
  const xFormat = d3.format(Math.max(...t.points.map((p) => Math.abs(p.x))) >= 1000 ? ',.3~s' : ',.3~r');
  drawScatterXY(node, t.points, {
    xLabel: t.label, yLabel: outcome.label, xFormat, yFormat: d3.format('.0%'),
    colour: 'var(--viz-series-3)', fit: t.fit,
    title: (p) => `${p.label}\n${t.label}: ${xFormat(p.x)}\n${outcome.label}: ${fmtPct(p.y)}\n${fmtInt(p.weight)} electors`,
  });
  const dropped = (st.rows || []).length - t.n;
  /* The unit is whatever the tab is running on; saying "dissemination areas"
     under a voting-area correlation names the wrong geography. */
  const unitName = SOCIO_UNITS[st.unit || 'da'].name;
  caption.textContent = `${t.label} against ${outcome.label.toLowerCase()} across ${fmtInt(t.n)} ${unitName}`
    + (dropped > 0 ? ` (${fmtInt(dropped)} left out for missing values)` : '')
    + `; r = ${fmtNum(t.r, 3)}, electors-weighted r = ${fmtNum(t.rWeighted, 3)}. Dot size follows electors.`
    /* The resident denominator is a census count, so correlating it against
       another census count shares a source with its own outcome. Worth saying
       under the chart rather than only in the Method. */
    + (outcome.circular
      ? ' This outcome divides by a census count, so a correlation against another '
        + 'census variable shares a source with its own denominator — read it beside the '
        + 'per-federal-elector version, which does not.'
      : '');
}

/* --- Variable picker and search ------------------------------------------ */

function renderSocioPicker() {
  const host = $('socio-picker');
  host.textContent = '';
  const st = state.socio;
  for (const v of socioVariables(st.unit || 'da')) {
    const lab = el('label');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = st.selected.has(v.key);
    cb.addEventListener('change', () => { if (cb.checked) st.selected.add(v.key); else st.selected.delete(v.key); refreshSocio(); });
    lab.append(cb, el('span', null, v.label));
    /* Carried variables say how they were carried: a count shared out and a
       rate averaged are different numbers, and the difference is not
       recoverable from the value alone. */
    if (v.movedAs) lab.append(el('span', 'text-small text-muted', ` (${v.movedAs})`));
    if (v.extra) {
      const rm = el('button', 'btn btn-small', '×'); rm.type = 'button'; rm.title = 'Remove this characteristic';
      rm.style.marginTop = '0';
      rm.addEventListener('click', () => { st.extra.delete(v.key); st.selected.delete(v.key); rejoinCensus(); refreshSocio(); });
      lab.append(rm);
    }
    host.append(lab);
  }
}

/* Characteristics the user can add by name: the long profile's full list, or
   the wide file's columns that are not already shown. */
function socioCandidates(query) {
  const q = query.trim().toLowerCase();
  if (!q || !state.da.census) return [];
  const shown = new Set(socioVariables(state.socio.unit || 'da').map((v) => v.key));
  const out = [];
  if (state.da.census.kind === 'long') {
    for (const c of state.da.census.profile.characteristics) {
      if (!c.name.toLowerCase().includes(q)) continue;
      if (!shown.has('c' + c.id)) out.push({ key: 'c' + c.id, id: c.id, use: 'count', label: c.name + (c.depth ? ` (level ${c.depth})` : '') });
      if (out.length >= 40) break;
    }
  } else {
    for (const v of state.da.census.all) {
      if (shown.has(v.key) || !v.key.toLowerCase().includes(q)) continue;
      out.push({ key: v.key, wide: true, label: v.key });
      if (out.length >= 40) break;
    }
  }
  return out;
}

function renderSocioSearch() {
  const host = $('socio-search-results');
  host.textContent = '';
  const query = $('socio-search').value;
  const found = socioCandidates(query);
  if (query.trim() && !found.length) { host.append(el('span', 'text-small text-muted', 'No characteristic matches.')); return; }
  for (const c of found) {
    const b = el('button', 'btn', `+ ${c.label}`); b.type = 'button';
    b.addEventListener('click', () => {
      state.socio.extra.set(c.key, c);
      state.socio.selected.add(c.key);
      rejoinCensus();
      $('socio-search').value = '';
      host.textContent = '';
      refreshSocio();
      refreshDaShadeVars();
    });
    host.append(b);
  }
}

/* --- Map shading of the dissemination areas ------------------------------ */

function refreshDaShadeVars() {
  const sel = $('shade-da-var');
  const vars = socioVariables();
  const previous = sel.value;
  if (!vars.length) { fillSelect(sel, [{ value: '', label: 'Load a census profile' }]); sel.disabled = true; state.da.shadeVar = null; return; }
  sel.disabled = false;
  fillSelect(sel, vars.map((v) => ({ value: v.key, label: v.label })));
  sel.value = vars.some((v) => v.key === previous) ? previous : vars[0].key;
  state.da.shadeVar = vars.find((v) => v.key === sel.value)?.byFeature || null;
}

function restyleDa() {
  applyDaStyle(gDa.selectAll('path'));
  updateLayerVisibility();
  renderLegend();
}

/* --- Export ---------------------------------------------------------------- */

$('export-socio').addEventListener('click', () => {
  const st = state.socio;
  if (!st.rows || !st.rows.length) { $('socio-note').textContent = 'Nothing to export yet.'; return; }
  const fedParties = (state.fedResults?.parties || []).map(([p]) => p);
  const provParties = (state.provResults?.parties || []).map(([p]) => p);
  const unit = st.unit || 'da';
  const U = SOCIO_UNITS[unit];
  const vars = socioVariables(unit).filter((v) => st.selected.has(v.key));
  const cFed = crossPair('fed', unit), cProv = crossPair('prov', unit);
  const covOf = (c, i) => (c ? c.coverage.b[i] : null);
  const k = U.keyProp();
  /* source_unit names the voting place a row's provincial numbers came from,
     and catchment_share how much of them came from that place rather than a
     district-wide spread. Together they let an analyst cluster on the real
     source instead of treating every polygon as an observation. */
  const header = [U.idColumn, 'dguid', 'population_2021', 'electors_fed', 'ballots_fed', 'turnout_fed',
    'electors_prov', 'ballots_prov', 'turnout_prov', 'turnout_agg', 'coverage_fed', 'coverage_prov',
    'source_unit', 'catchment_share',
    ...fedParties.map((p) => `fed_share_${p}`), ...provParties.map((p) => `prov_share_${p}`),
    ...vars.map((v) => v.key)];
  const f6 = (v) => (v == null || !isFinite(v) ? '' : Number(v).toFixed(6));
  const f2 = (v) => (v == null || !isFinite(v) ? '' : Number(v).toFixed(2));
  const rows = [header];
  for (const r of st.rows) {
    const f = r.feature, i = +r.key;
    const source = unit === 'prov' ? provPlaceGroup(f.__idx) : daPlaceGroup(f.__idx);
    const share = unit === 'prov' ? catchmentShare(f) : catchmentShare(daDominant(f.__idx)?.feature);
    rows.push([k ? f.properties[k] ?? '' : f.__idx, f.properties.DGUID ?? f.properties.dguid ?? '',
      f2(unit === 'da' ? state.da.pop?.get(f.__idx) : null),
      f2(r.by.fed?.electors), f2(Turnout.ballots(r.by.fed)), f6(r.t.fed),
      f2(r.by.prov?.electors), f2(Turnout.ballots(r.by.prov)), f6(r.t.prov), f6(r.agg),
      f6(covOf(cFed, i)), f6(covOf(cProv, i)),
      source || '', f6(share),
      ...fedParties.map((p) => f6(Analysis.shareOf(r.by.fed, p))),
      ...provParties.map((p) => f6(Analysis.shareOf(r.by.prov, p))),
      ...vars.map((v) => { const x = v.byFeature.get(f.__idx); return x == null ? '' : String(x); })]);
  }
  downloadCsv(U.file, rows);
  $('socio-note').textContent = `Saved ${U.file} (${fmtInt(rows.length - 1)} rows).`;
});

/* --- Wiring ---------------------------------------------------------------- */

for (const id of ['socio-unit', 'socio-outcome', 'socio-min-electors', 'socio-both-only']) {
  $(id).addEventListener('change', () => { clearMovedVariables(); refreshSocio(); });
}
$('socio-search').addEventListener('input', renderSocioSearch);
$('shade-da-by').addEventListener('change', restyleDa);
$('shade-da-var').addEventListener('change', () => {
  state.da.shadeVar = socioVariables().find((v) => v.key === $('shade-da-var').value)?.byFeature || null;
  restyleDa();
});
$('show-da').addEventListener('input', updateLayerVisibility);
$('show-places').addEventListener('input', updateLayerVisibility);
$('find-da').addEventListener('change', (e) => {
  const f = state.da.active.find((x) => x.__key === e.target.value);
  if (f) { selectAt(null, null, null, f); zoomToFeature(f); }
});
