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

/* Sources in the crosswalk's index space (active-layer indices), each on
   side 'a' of its own pair with the dissemination areas. */
function socioSources() {
  const s = state.sample;
  if (!s || !s.ids.includes('da')) return [];
  const sources = [];
  const add = (id, values, key) => {
    const c = crossPair(id, 'da');
    if (!c) return;
    const m = new Map();
    state[id].active.forEach((f, i) => { const u = values.get(f[key]); if (u) m.set(i, u); });
    sources.push({ id, values: m, pairs: c.pairs, side: 'a' });
  };
  const fv = fedValues(); if (fv) add('fed', fv, 'idx');
  const pv = provValues(); if (pv) add('prov', pv, '__idx');
  return sources;
}

/* The chosen outcome as a function of a scored row; null when unavailable. */
function socioOutcome(mode) {
  if (mode === 'turnout-fed') return { label: 'Federal (2025) turnout', of: (r) => r.t.fed, format: fmtPct };
  if (mode === 'turnout-prov') return { label: 'Provincial (2024) turnout', of: (r) => r.t.prov, format: fmtPct };
  const m = /^(fed|prov):(.*)$/.exec(mode);
  if (m) {
    const side = m[1], party = m[2];
    return { label: `${party} share, ${side === 'fed' ? 'federal 2025' : 'provincial 2024'}`,
             of: (r) => Analysis.shareOf(r.by[side], party), format: fmtPct };
  }
  return { label: 'Aggregate turnout, both elections', of: (r) => r.agg, format: fmtPct };
}

/* Every variable currently available on the dissemination areas: the
   starter set (or the wide file's columns) plus any characteristic added
   from the search box. Each has byFeature: Map<feature index, value>. */
function socioVariables() {
  return state.da.variables;
}

function refreshSocio() {
  const statsHost = $('socio-stats');
  if (!statsHost) return;
  const st = state.socio;
  st.outcome = $('socio-outcome').value;
  st.minElectors = parseFloat($('socio-min-electors').value);
  statsHost.textContent = '';
  const results = $('socio-results');

  const missing = [];
  if (!state.da.all.length) missing.push('the dissemination-area boundaries (Data tab, section 4)');
  if (state.da.all.length && !socioVariables().length) missing.push('a census profile joined to them');
  if (!state.fedResults?.values && !state.provResults?.values) missing.push('federal or provincial results');
  if (state.da.all.length && (!state.sample || !state.sample.ids.includes('da'))) {
    missing.push('the crosswalk (build it on the Correlation tab after loading the census layer)');
  }
  if (missing.length) {
    setStatus('socio-status', 'idle', [`Needed first: ${missing.join('; ')}.`]);
    st.rows = null; st.byDa = null; st.table = null;
    results.hidden = true;
    restyleDa();
    return;
  }

  const sources = socioSources();
  const labels = {
    fed: (i) => state.fed.active[i]?.label ?? `poll ${i}`,
    prov: (i) => provLabel(state.prov.active[i]),
    da: (i) => daLabel(state.da.active[i]),
  };
  let rows = Turnout.rowsOnUnit('da', sources, labels, { minElectors: st.minElectors });
  rows = Turnout.score(rows, { weights: { fed: state.turnout.weight, prov: 1 - state.turnout.weight } });
  for (const r of rows) r.feature = state.da.active[+r.key];
  /* An area covered by only one election carries that election alone as its
     "aggregate"; by default those stay out of a correlation. */
  const partialCount = rows.filter((r) => r.partial).length;
  const bothOnly = $('socio-both-only').checked && sources.length > 1;
  if (bothOnly) rows = rows.filter((r) => !r.partial);
  st.rows = rows;
  st.byDa = new Map(rows.map((r) => [r.feature.__idx, r]));

  const outcome = socioOutcome(st.outcome);
  const table = [];
  for (const v of socioVariables()) {
    if (!st.selected.has(v.key)) continue;
    const pts = [];
    for (const r of rows) {
      const y = outcome.of(r);
      const x = v.byFeature.get(r.feature.__idx);
      if (y == null || !isFinite(y) || x == null || !isFinite(x)) continue;
      pts.push({ x, y, weight: r.electors, label: daLabel(r.feature), key: r.key });
    }
    const c = Analysis.correlateXY(pts);
    table.push({ key: v.key, label: v.label, n: pts.length, r: c.r, rWeighted: c.rWeighted, rho: c.rho,
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
    stat('dissemination areas', fmtInt(withOutcome.length), `of ${fmtInt(state.da.active.length)} in the study area`),
    stat('electors located', fmtInt(electors)),
    stat('overlaps weighted by', state.weightingShort || 'area', state.weightingDetail || null),
    stat('variables compared', fmtInt(table.length), `${fmtInt(socioVariables().length)} available`),
  );
  const lines = [`${fmtInt(withOutcome.length)} dissemination areas carry ${outcome.label.toLowerCase()}; `
    + `${sources.map((s) => (s.id === 'fed' ? 'federal (2025)' : 'provincial (2024)')).join(' and ')} results moved through the crosswalk`
    + (partialCount ? ` (${fmtInt(partialCount)} areas touch only one election${bothOnly ? ' and are left out' : ' and are included with that election alone'}).` : '.')];
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
  caption.textContent = `${t.label} against ${outcome.label.toLowerCase()} across ${fmtInt(t.n)} dissemination areas`
    + (dropped > 0 ? ` (${fmtInt(dropped)} left out for missing values)` : '')
    + `; r = ${fmtNum(t.r, 3)}, electors-weighted r = ${fmtNum(t.rWeighted, 3)}. Dot size follows electors.`;
}

/* --- Variable picker and search ------------------------------------------ */

function renderSocioPicker() {
  const host = $('socio-picker');
  host.textContent = '';
  const st = state.socio;
  for (const v of socioVariables()) {
    const lab = el('label');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = st.selected.has(v.key);
    cb.addEventListener('change', () => { if (cb.checked) st.selected.add(v.key); else st.selected.delete(v.key); refreshSocio(); });
    lab.append(cb, el('span', null, v.label));
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
  const shown = new Set(socioVariables().map((v) => v.key));
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
  const vars = socioVariables().filter((v) => st.selected.has(v.key));
  const cFed = crossPair('fed', 'da'), cProv = crossPair('prov', 'da');
  const covOf = (c, i) => (c ? c.coverage.b[i] : null);
  const k = state.da.keyProp;
  const header = ['da_id', 'dguid', 'population_2021', 'electors_fed', 'ballots_fed', 'turnout_fed',
    'electors_prov', 'ballots_prov', 'turnout_prov', 'turnout_agg', 'coverage_fed', 'coverage_prov',
    ...fedParties.map((p) => `fed_share_${p}`), ...provParties.map((p) => `prov_share_${p}`),
    ...vars.map((v) => v.key)];
  const f6 = (v) => (v == null || !isFinite(v) ? '' : Number(v).toFixed(6));
  const f2 = (v) => (v == null || !isFinite(v) ? '' : Number(v).toFixed(2));
  const rows = [header];
  for (const r of st.rows) {
    const f = r.feature, i = +r.key;
    rows.push([k ? f.properties[k] ?? '' : f.__idx, f.properties.DGUID ?? f.properties.dguid ?? '',
      f2(state.da.pop?.get(f.__idx)),
      f2(r.by.fed?.electors), f2(Turnout.ballots(r.by.fed)), f6(r.t.fed),
      f2(r.by.prov?.electors), f2(Turnout.ballots(r.by.prov)), f6(r.t.prov), f6(r.agg),
      f6(covOf(cFed, i)), f6(covOf(cProv, i)),
      ...fedParties.map((p) => f6(Analysis.shareOf(r.by.fed, p))),
      ...provParties.map((p) => f6(Analysis.shareOf(r.by.prov, p))),
      ...vars.map((v) => { const x = v.byFeature.get(f.__idx); return x == null ? '' : String(x); })]);
  }
  downloadCsv('vancouver-da-joined.csv', rows);
  $('socio-note').textContent = `Saved vancouver-da-joined.csv (${fmtInt(rows.length - 1)} rows).`;
});

/* --- Wiring ---------------------------------------------------------------- */

for (const id of ['socio-outcome', 'socio-min-electors', 'socio-both-only']) $(id).addEventListener('change', refreshSocio);
$('socio-search').addEventListener('input', renderSocioSearch);
$('shade-da-by').addEventListener('change', restyleDa);
$('shade-da-var').addEventListener('change', () => {
  state.da.shadeVar = socioVariables().find((v) => v.key === $('shade-da-var').value)?.byFeature || null;
  restyleDa();
});
$('show-da').addEventListener('input', updateLayerVisibility);
$('find-da').addEventListener('change', (e) => {
  const f = state.da.active.find((x) => x.__key === e.target.value);
  if (f) { selectAt(null, null, null, f); zoomToFeature(f); }
});
