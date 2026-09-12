/* --- Crosswalk -------------------------------------------------------------- */

function refreshCrosswalkStatus() {
  const has = state.prov.all.length > 0;
  if (!has) {
    setStatus('status-crosswalk', 'idle',
      ['Load a provincial voting-area layer on the Data tab first.']);
    $('corr-controls').hidden = true;
    return;
  }
  if (!state.crosswalk) {
    setStatus('status-crosswalk', 'idle',
      ['Ready. Building the crosswalk takes a second or two.']);
  }
}

function buildCrosswalk() {
  const spacingM = parseInt($('lattice').value, 10);
  const fedFeatures = state.fed.active, provFeatures = state.prov.active;
  if (!fedFeatures.length || !provFeatures.length) {
    setStatus('status-crosswalk', 'error', ['Nothing to cross: one of the two layers is empty here.']);
    return;
  }
  const bar = $('crosswalk-bar');
  $('crosswalk-progress').hidden = false;
  bar.style.width = '0%';
  $('build-crosswalk').disabled = true;
  setStatus('status-crosswalk', 'busy', ['Sampling the overlap…']);

  const fedIndex = Geo.buildIndex(fedFeatures);
  const provIndex = Geo.buildIndex(provFeatures);
  const runner = Analysis.crosswalkRunner(fedFeatures, provFeatures,
    { spacingM, fedIndex, provIndex });
  const started = Date.now();

  /* Stepped through a timer so the progress bar actually paints. */
  const step = () => {
    let result;
    const until = Date.now() + 40;
    do { result = runner.next(); } while (!result.done && Date.now() < until);
    if (!result.done) {
      bar.style.width = Math.round(result.value * 100) + '%';
      setTimeout(step, 0);
      return;
    }
    const cw = result.value;
    const repaired = Analysis.repairSmallFeatures(cw, fedFeatures, provFeatures,
      { fed: fedIndex, prov: provIndex });
    state.crosswalk = cw;
    state.crosswalkFed = fedFeatures;
    state.crosswalkProv = provFeatures;
    state.coverage = Analysis.coverage(cw);
    applyMinOverlap();
    bar.style.width = '100%';
    $('crosswalk-progress').hidden = true;
    $('build-crosswalk').disabled = false;

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const fullyInside = state.coverage.fed.filter((c) => c > 0.999).length;
    const partial = state.coverage.fed.filter((c) => c > 0.001 && c <= 0.999).length;
    const uncovered = state.coverage.fed.filter((c) => c <= 0.001).length;
    const lines = [
      `Sampled ${fmtInt(cw.points)} lattice points at ${cw.spacingM} m in ${seconds}s, `
        + `giving ${fmtInt(state.pairs.length)} federal–provincial overlaps.`,
      `${fmtInt(fullyInside)} polling divisions sit wholly inside the provincial layer, `
        + `${fmtInt(partial)} straddle its edge, ${fmtInt(uncovered)} fall outside it entirely.`,
    ];
    if (repaired.fed.length || repaired.prov.length) {
      lines.push(el('p', 'text-small text-muted',
        `${fmtInt(repaired.fed.length)} federal and ${fmtInt(repaired.prov.length)} provincial `
        + 'polygons were too small for the lattice and were assigned whole to the unit '
        + 'containing an interior point.'));
    }
    if (uncovered > 0) {
      lines.push(el('p', 'text-warning',
        `${fmtInt(uncovered)} polling divisions have no provincial coverage; their votes are `
        + 'left out of the comparison. Check that the provincial file covers the whole area.'));
    }
    setStatus('status-crosswalk', 'ok', lines);
    recomputeProvincialOnFederal();
    $('corr-controls').hidden = false;
    refreshCorrelation();
    refreshTurnout();
    draw();
  };
  setTimeout(step, 0);
}

function applyMinOverlap() {
  if (!state.crosswalk) return;
  const minShare = parseFloat($('min-overlap').value);
  state.pairs = Analysis.crosswalkPairs(state.crosswalk, { minShare });
}

$('build-crosswalk').addEventListener('click', buildCrosswalk);
$('min-overlap').addEventListener('change', () => {
  if (!state.crosswalk) return;
  applyMinOverlap();
  recomputeProvincialOnFederal();
  refreshCorrelation();
  refreshTurnout();
  draw();
});

/* Provincial votes pushed onto federal divisions, for map shading. */
function recomputeProvincialOnFederal() {
  state.provOnFed = null;
  const pv = provValues();
  if (!state.pairs || !pv) return;
  const byIndex = new Map();
  state.crosswalkProv.forEach((f, i) => {
    const unit = pv.get(f.__idx);
    if (unit) byIndex.set(i, unit);
  });
  const onFed = Analysis.redistribute(state.pairs, byIndex, { from: 'prov' });
  const out = new Map();
  for (const [i, unit] of onFed) {
    const feature = state.crosswalkFed[i];
    if (feature) out.set(feature.idx, unit);
  }
  state.provOnFed = out;
}

/* --- Correlation view -------------------------------------------------------- */

function correlationInputs() {
  if (!state.pairs || !state.fedResults?.values || !state.provResults?.values) return null;
  const fedValues = new Map();
  state.crosswalkFed.forEach((f, i) => {
    const unit = state.fedResults.values.get(f.idx);
    if (unit) fedValues.set(i, unit);
  });
  const provValues = new Map();
  state.crosswalkProv.forEach((f, i) => {
    const unit = state.provResults.values.get(f.__idx);
    if (unit) provValues.set(i, unit);
  });
  return { fedValues, provValues };
}

function refreshCorrelation() {
  const host = $('corr-stats');
  const caption = $('scatter-caption');
  if (!state.pairs) { $('corr-controls').hidden = true; return; }
  $('corr-controls').hidden = false;
  const inputs = correlationInputs();
  host.textContent = '';
  if (!inputs) {
    caption.textContent = '';
    d3.select($('scatter')).selectAll('*').remove();
    host.append(el('p', 'text-muted',
      'Load both federal and provincial results on the Data tab to see the correlation.'));
    return;
  }
  const unit = $('corr-unit').value;
  const minVotes = parseFloat($('corr-min-votes').value);
  const labels = {
    fed: (i) => state.crosswalkFed[i]?.label || `poll ${i}`,
    prov: (i) => provLabel(state.crosswalkProv[i]) || `area ${i}`,
  };
  const rows = Analysis.comparisonRows(state.crosswalk, state.pairs,
    inputs.fedValues, inputs.provValues, unit, labels, minVotes);
  const fedParty = $('corr-fed-party').value, provParty = $('corr-prov-party').value;
  const result = Analysis.correlate(rows, fedParty, provParty);
  state.lastCorrelation = { result, rows, unit, fedParty, provParty };

  const stat = (label, value, note) => {
    const t = el('div', 'viz-stat');
    t.append(el('div', 'viz-stat-value', value), el('div', 'text-small text-muted', label));
    if (note) t.append(el('div', 'text-small text-muted', note));
    return t;
  };
  host.append(
    stat('units compared', fmtInt(result.n)),
    stat('Pearson r', fmtNum(result.r),
      result.ci ? `95% CI ${fmtNum(result.ci[0], 2)} to ${fmtNum(result.ci[1], 2)}` : null),
    stat('vote-weighted r', fmtNum(result.rWeighted)),
    stat("Spearman's rho", fmtNum(result.rho)),
    stat('slope', result.fit ? fmtNum(result.fit.slope, 2) : '--',
      result.fit ? `intercept ${fmtNum(result.fit.intercept, 2)}` : null),
  );
  drawScatter(result, fedParty, provParty);

  const unitName = { prov: 'provincial voting areas', fed: 'federal polling divisions',
                     atom: 'overlap pieces' }[unit];
  const parts = [
    `${fmtInt(result.n)} ${unitName}, carrying ${fmtInt(result.totalWeight)} votes on the lighter side of each pair.`,
  ];
  const fedRep = state.fedResults.report, provRep = state.provResults.report;
  if (fedRep && provRep) {
    parts.push(`Federal results cover ${fmtPct(fedRep.matchedVotes / fedRep.tableVotes)} of the votes in the loaded federal file, `
      + `provincial ${fmtPct(provRep.matchedVotes / provRep.tableVotes)} — the rest are advance polls and special ballots with no boundary.`);
  }
  caption.textContent = parts.join(' ');
}

for (const id of ['corr-unit', 'corr-fed-party', 'corr-prov-party', 'corr-min-votes']) {
  $(id).addEventListener('change', refreshCorrelation);
}

function drawScatter(result, fedParty, provParty) {
  const node = $('scatter');
  const sel = d3.select(node);
  sel.selectAll('*').remove();
  const w = Math.max(320, node.getBoundingClientRect().width || 640);
  const h = Math.max(280, Math.min(460, w * 0.62));
  sel.attr('viewBox', `0 0 ${w} ${h}`).attr('height', h);
  if (!result.points.length) return;
  const m = { top: 14, right: 16, bottom: 44, left: 54 };
  const pad = 0.02;
  const xd = d3.extent(result.points, (p) => p.x), yd = d3.extent(result.points, (p) => p.y);
  const x = d3.scaleLinear().domain([Math.max(0, xd[0] - pad), Math.min(1, xd[1] + pad)])
    .range([m.left, w - m.right]).nice();
  const y = d3.scaleLinear().domain([Math.max(0, yd[0] - pad), Math.min(1, yd[1] + pad)])
    .range([h - m.bottom, m.top]).nice();

  const g = sel.append('g');
  g.append('g').attr('class', 'axis').attr('transform', `translate(0,${h - m.bottom})`)
    .call(d3.axisBottom(x).ticks(6).tickFormat(d3.format('.0%')));
  g.append('g').attr('class', 'axis').attr('transform', `translate(${m.left},0)`)
    .call(d3.axisLeft(y).ticks(6).tickFormat(d3.format('.0%')));
  sel.append('text').attr('class', 'axis-label').attr('x', (m.left + w - m.right) / 2)
    .attr('y', h - 8).attr('text-anchor', 'middle').text(`${fedParty} — federal share`);
  sel.append('text').attr('class', 'axis-label')
    .attr('transform', `rotate(-90)`).attr('x', -(m.top + h - m.bottom) / 2).attr('y', 14)
    .attr('text-anchor', 'middle').text(`${provParty} — provincial share`);

  const maxWeight = Math.max(...result.points.map((p) => p.weight)) || 1;
  const r = (p) => 2 + 5 * Math.sqrt(Math.min(1, p.weight / maxWeight));
  sel.append('g').selectAll('circle').data(result.points).join('circle')
    .attr('class', 'dot')
    .attr('cx', (p) => x(p.x)).attr('cy', (p) => y(p.y)).attr('r', r)
    .attr('fill', partyColour(fedParty))
    .append('title')
    .text((p) => `${p.label}\n${fedParty} federal ${fmtPct(p.x)}\n${provParty} provincial ${fmtPct(p.y)}`
      + `\n${fmtInt(p.weight)} votes`);

  if (result.fit) {
    const xs = x.domain();
    const line = d3.line().x((d) => x(d[0])).y((d) => y(d[1]));
    const pts = xs.map((v) => [v, result.fit.intercept + result.fit.slope * v]);
    sel.append('path').attr('class', 'fit-line').attr('d', line(pts));
  }
}

/* --- Exports ----------------------------------------------------------------- */

function downloadCsv(name, rows) {
  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const text = rows.map((r) => r.map(esc).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  $('export-note').textContent = `Saved ${name} (${fmtInt(rows.length - 1)} rows).`;
}

$('export-joined').addEventListener('click', () => {
  const c = state.lastCorrelation;
  if (!c || !c.result.points.length) { $('export-note').textContent = 'Nothing to export yet.'; return; }
  const fedParties = (state.fedResults?.parties || []).map(([p]) => p);
  const provParties = (state.provResults?.parties || []).map(([p]) => p);
  const header = ['unit_key', 'unit_label', 'federal_votes', 'provincial_votes',
    'federal_electors', 'federal_rejected', 'turnout_fed',
    'provincial_electors', 'provincial_rejected', 'turnout_prov',
    ...fedParties.map((p) => `fed_${p}`), ...fedParties.map((p) => `fed_share_${p}`),
    ...provParties.map((p) => `prov_${p}`), ...provParties.map((p) => `prov_share_${p}`)];
  const rows = [header];
  const t6 = (v) => (v == null ? '' : v.toFixed(6));
  for (const row of c.rows) {
    rows.push([row.key, row.label, row.fed.total.toFixed(2), row.prov.total.toFixed(2),
      (row.fed.electors || 0).toFixed(2), (row.fed.rejected || 0).toFixed(2), t6(Turnout.rate(row.fed)),
      (row.prov.electors || 0).toFixed(2), (row.prov.rejected || 0).toFixed(2), t6(Turnout.rate(row.prov)),
      ...fedParties.map((p) => (row.fed.parties.get(p) || 0).toFixed(2)),
      ...fedParties.map((p) => { const s = Analysis.shareOf(row.fed, p); return s == null ? '' : s.toFixed(6); }),
      ...provParties.map((p) => (row.prov.parties.get(p) || 0).toFixed(2)),
      ...provParties.map((p) => { const s = Analysis.shareOf(row.prov, p); return s == null ? '' : s.toFixed(6); })]);
  }
  downloadCsv(`vancouver-${c.unit}-joined.csv`, rows);
});

$('export-crosswalk').addEventListener('click', () => {
  if (!state.pairs) { $('export-note').textContent = 'Build the crosswalk first.'; return; }
  const rows = [['federal_riding', 'federal_poll', 'provincial_area',
    'share_of_federal_poll', 'share_of_voting_area', 'sample_points']];
  for (const p of state.pairs) {
    const f = state.crosswalkFed[p.fi], v = state.crosswalkProv[p.pi];
    rows.push([f?.fedNum ?? '', f?.poll ?? '', provLabel(v),
      p.shareOfFed.toFixed(6), p.shareOfProv.toFixed(6), Math.round(p.count)]);
  }
  downloadCsv('vancouver-federal-provincial-crosswalk.csv', rows);
});

/* --- Finder menus and wiring -------------------------------------------------- */

function populateFinders() {
  const fedSel = $('find-poll');
  fillSelect(fedSel, [{ value: '', label: 'Select a division…' },
    ...state.fed.active
      .slice()
      .sort((a, b) => a.fedNum.localeCompare(b.fedNum) || (a.pollNum ?? 0) - (b.pollNum ?? 0))
      .map((f) => ({ value: f.key, label: f.label }))]);
  const provSel = $('find-va');
  if (!state.prov.active.length) {
    fillSelect(provSel, [{ value: '', label: 'No provincial layer loaded' }]);
    provSel.disabled = true;
  } else {
    provSel.disabled = false;
    fillSelect(provSel, [{ value: '', label: 'Select a voting area…' },
      ...state.prov.active
        .map((f) => ({ value: f.__key, label: provLabel(f) }))
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))]);
  }
}

$('find-poll').addEventListener('change', (e) => {
  const f = state.fed.active.find((x) => x.key === e.target.value);
  if (f) { selectAt(null, f, null); zoomToFeature(f); }
});
$('find-va').addEventListener('change', (e) => {
  const f = state.prov.active.find((x) => x.__key === e.target.value);
  if (f) { selectAt(null, null, f); zoomToFeature(f); }
});

$('zoom-reset').addEventListener('click', () => { fitAll(); });
$('basemap').addEventListener('change', () => setBasemap($('basemap').value));

for (const id of ['show-fed', 'show-prov', 'prov-weight']) {
  $(id).addEventListener('input', updateLayerVisibility);
}
for (const id of ['area-filter', 'show-mobile']) {
  $(id).addEventListener('change', () => {
    state.crosswalk = null; state.pairs = null; state.provOnFed = null;
    state.turnout.rows = null; state.turnout.basket.clear();
    $('corr-controls').hidden = true;
    refreshCrosswalkStatus();
    draw(); populateFinders(); renderReadout(); refreshTurnout();
  });
}
for (const id of ['shade-by', 'shade-party-fed']) {
  $(id).addEventListener('change', () => {
    applyFederalStyle(gFed.selectAll('path'));
    renderLegend();
  });
}
/* The provincial party feeds both the cross-level modes on the federal layer
   and the provincial layer's own shading. */
for (const id of ['shade-prov-by', 'shade-party-prov']) {
  $(id).addEventListener('change', () => {
    applyFederalStyle(gFed.selectAll('path'));
    applyProvincialStyle(gProv.selectAll('path'));
    updateLayerVisibility();
    renderLegend();
  });
}
$('prov-opacity').addEventListener('input', () => applyProvincialStyle(gProv.selectAll('path')));
