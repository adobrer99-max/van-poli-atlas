/* --- Crosswalk -------------------------------------------------------------- */

function refreshCrosswalkStatus() {
  const loaded = state.prov.all.length > 0 || state.da.all.length > 0;
  /* Taken from the layers' own extents rather than their active sets: this
     runs from invalidateSample, which fires before the next draw() re-trims
     them, so the active sets can still be the previous layer's. */
  const fedExtent = extentOf(state.fed.active);
  const touches = (layer) => {
    if (!layer.all.length || !fedExtent) return false;
    const e = extentOf(layer.all);
    return Boolean(e) && e[0] <= fedExtent[2] && e[2] >= fedExtent[0]
      && e[1] <= fedExtent[3] && e[3] >= fedExtent[1];
  };
  const here = touches(state.prov) || touches(state.da);
  if (!loaded) {
    setStatus('status-crosswalk', 'idle',
      ['Load a provincial voting-area layer or a census layer on the Data tab first.']);
    $('corr-controls').hidden = true;
    return;
  }
  if (!here) {
    /* Loaded, but nowhere near the federal layer: saying "Ready" and then
       refusing to build would be the worst of both. */
    setStatus('status-crosswalk', 'error', [
      'The loaded layers do not overlap the study area, so there is nothing to cross. '
      + 'Check the Area filter above the map, or reload the file with clipping switched off.']);
    $('build-crosswalk').disabled = true;
    $('corr-controls').hidden = true;
    return;
  }
  $('build-crosswalk').disabled = false;
  if (!state.sample) {
    setStatus('status-crosswalk', 'idle',
      ['Ready. Sampling the layers takes a few seconds; every crosswalk is derived from that one sample.']);
  }
}

/* Samples every loaded layer once into state.sample, then derives the
   federal-provincial crosswalk (and any other on demand, see crossPair). */
function buildCrosswalk() {
  const spacingM = parseInt($('lattice').value, 10);
  const fedFeatures = state.fed.active;
  if (!fedFeatures.length || (!state.prov.active.length && !state.da.active.length)) {
    setStatus('status-crosswalk', 'error', ['Nothing to cross: the federal layer is empty here, or no other layer is loaded.']);
    return;
  }
  const bar = $('crosswalk-bar');
  $('crosswalk-progress').hidden = false;
  bar.style.width = '0%';
  $('build-crosswalk').disabled = true;
  setStatus('status-crosswalk', 'busy', ['Sampling the layers…']);

  const layers = [{ id: 'fed', features: fedFeatures, index: Geo.buildIndex(fedFeatures) }];
  for (const id of ['prov', 'da', 'db']) {
    if (state[id].active.length) layers.push({ id, features: state[id].active, index: Geo.buildIndex(state[id].active) });
  }
  const runner = Analysis.sampleLattice(layers, { spacingM });
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
    const sample = result.value;
    sample.ids = layers.map((l) => l.id);
    state.sample = sample;
    state.cross.clear();
    const fp = crossPair('fed', 'prov');
    bar.style.width = '100%';
    $('crosswalk-progress').hidden = true;
    $('build-crosswalk').disabled = false;

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    state.sampleSeconds = seconds;
    renderCrosswalkStatus();
    recomputeProvincialOnFederal();
    /* Results reported by voting place are split by population once the
       lattice exists, so they have to be rebuilt against it -- otherwise the
       numbers on screen stay the area-weighted ones from before the build. */
    if (state.provResults?.kind === 'places') rejoinProvincialPlaces();
    $('corr-controls').hidden = !crossPair('fed', 'prov');
    refreshCorrelation();
    refreshTurnout();
    refreshSocio();
    refreshReadiness();
    refreshOverview();
    draw();
  };
  setTimeout(step, 0);
}

/* Rebuilt whenever the crosswalk is, including after a weighting or sliver
   change: every figure in it moves with those controls, and a status line
   describing the previous crosswalk is worse than none. */
function renderCrosswalkStatus() {
  const sample = state.sample;
  if (!sample) { setStatus('status-crosswalk', 'idle', []); return; }
  const fp = crossPair('fed', 'prov');
  const seconds = state.sampleSeconds || '0.0';
  {
    /* The names come from the sample itself, not from the build that made it,
       so this reads the same whether it runs after a build or after a
       weighting change. */
    const LAYER_NAMES = { fed: 'federal polls', prov: 'voting areas',
                          da: 'dissemination areas', db: 'dissemination blocks' };
    const lines = [
      `Sampled ${fmtInt(sample.points)} lattice points at ${sample.spacingM} m over `
        + `${(sample.ids || []).map((id) => LAYER_NAMES[id] || id).join(', ')} in ${seconds}s.`,
    ];
    if (fp) {
      const cov = fp.coverage.fed;
      const fullyInside = cov.filter((c) => c > 0.999).length;
      const partial = cov.filter((c) => c > 0.001 && c <= 0.999).length;
      const uncovered = cov.filter((c) => c <= 0.001).length;
      lines.push(`${fmtInt(fp.pairs.length)} federal–provincial overlaps: ${fmtInt(fullyInside)} polling divisions sit wholly inside `
        + `the provincial layer, ${fmtInt(partial)} straddle its edge, ${fmtInt(uncovered)} fall outside it entirely.`);
      if (fp.repaired.a.length || fp.repaired.b.length) {
        lines.push(el('p', 'text-small text-muted',
          `${fmtInt(fp.repaired.a.length)} federal and ${fmtInt(fp.repaired.b.length)} provincial `
          + 'polygons were too small for the lattice and were assigned whole to the unit '
          + 'containing an interior point.'));
      }
      if (uncovered > 0) {
        lines.push(el('p', 'text-warning',
          `${fmtInt(uncovered)} polling divisions have no provincial coverage; their votes are `
          + 'left out of the comparison. Check that the provincial file covers the whole area.'));
      }
    }
    const fd = crossPair('fed', 'da');
    if (fd) {
      const uncoveredDa = fd.coverage.fed.filter((c) => c <= 0.001).length;
      lines.push(`${fmtInt(fd.pairs.length)} federal–census overlaps across ${fmtInt(state.da.active.length)} dissemination areas`
        + (uncoveredDa ? `; ${fmtInt(uncoveredDa)} polling divisions lie outside the census layer.` : '.'));
    }
    lines.push(el('p', 'text-small text-muted', `Overlaps weighted by ${state.weightingInEffect || 'area'}`
      + (fp && fp.cw.weighted && (fp.cw.areaFallback.a.length || fp.cw.areaFallback.b.length)
        ? `; ${fmtInt(fp.cw.areaFallback.a.length + fp.cw.areaFallback.b.length)} polygons with no population fell back to area.` : '.')));
    setStatus('status-crosswalk', 'ok', lines);
  }
}

$('build-crosswalk').addEventListener('click', buildCrosswalk);
for (const id of ['min-overlap', 'sample-weighting']) {
  $(id).addEventListener('change', () => {
    if (!state.sample) return;
    invalidateCross();
    recomputeProvincialOnFederal();
    if (state.provResults?.kind === 'places') rejoinProvincialPlaces();
    renderCrosswalkStatus();
    refreshCorrelation();
    refreshTurnout();
    refreshSocio();
    draw();
  });
}
/* Resolution only takes effect on the next sample, so say so rather than
   letting the control look as though it did something. */
$('lattice').addEventListener('change', () => {
  if (!state.sample) return;
  if (String(state.sample.spacingM) === $('lattice').value) { renderCrosswalkStatus(); return; }
  setStatus('status-crosswalk', 'busy', [
    `The crosswalk on screen was sampled at ${state.sample.spacingM} m. `
    + 'Press Build crosswalk again to resample at the new resolution.']);
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

/* --- Two denominators for a provincial voting area ---------------------------

   The 2024 provincial results arrive per voting place with no elector column,
   and Elections BC publishes registered voters per electoral district only, so
   a voting area has ballots and no electorate. Two counts can be carried onto
   it instead -- the 2025 federal roll, and census residents aged 15 and over --
   and neither of them is a provincial electorate. Both are computed here, side
   by side, so the gap between them is on the page rather than in an argument.

   Prepared once per refresh and read per feature by the map, exactly as
   state.provOnFed is, because shading cannot afford a crosswalk pass per
   polygon. */

const ID_OF = { fed: (f) => f.idx, prov: (f) => f.__idx, da: (f) => f.__idx, db: (f) => f.__idx };

/* One count moved from one loaded layer onto another, keyed by the target
   feature's own index. Counts share out by overlap; this is the same call the
   Neighbourhood profile tab makes to carry census variables the other way. */
function carriedCount(from, to, valueOf) {
  if (!state[from]?.all.length || !state[to]?.all.length) return null;
  const c = crossPair(from, to);
  if (!c) return null;
  const src = new Map();
  state[from].active.forEach((f, i) => {
    const v = valueOf(f);
    if (v != null && isFinite(v)) src.set(i, v);
  });
  if (!src.size) return null;
  const moved = Analysis.moveVariable(c.pairs, src, { from: 'a', kind: 'count' });
  const id = ID_OF[to];
  const out = new Map();
  for (const [i, value] of moved) {
    const f = state[to].active[i];
    if (f) out.set(id(f), value);
  }
  return out;
}

/* Census residents aged 15 and over, on whichever geography is asked for.
   Native on the dissemination areas; carried across for anything else. The
   variable is absent when the loaded profile has no age table, and then so is
   the denominator -- it is never stood in for. */
function residentAdultsOn(unit) {
  const v = state.da.variables.find((x) => x.key === 'pop_15_plus');
  if (!v) return null;
  if (unit === 'da') return v.byFeature;
  return carriedCount('da', unit, (f) => v.byFeature.get(f.__idx));
}

function recomputeProvincialParticipation() {
  state.provPart = null;
  const pv = provValues();
  if (!pv || !state.prov.active.length) return;
  const fv = fedValues();
  /* The ranked table takes its federal electors from the unit already carried
     onto each row; the map has no rows, so it carries the count itself. */
  const electors = fv ? carriedCount('fed', 'prov', (f) => fv.get(f.idx)?.electors) : null;
  const adults = residentAdultsOn('prov');
  if (!electors && !adults) return;
  const rows = [];
  for (const f of state.prov.active) {
    const u = pv.get(f.__idx);
    if (!u) continue;
    rows.push({ f, by: { prov: u, fed: { electors: electors?.get(f.__idx) || 0 } } });
  }
  /* The arithmetic lives in f2-turnout.js and is used from here unchanged, so
     the map and the ranked table can never disagree about a ratio. */
  Turnout.participation(rows, { side: 'prov', adultsOf: (r) => adults?.get(r.f.__idx) ?? null });
  state.provPart = new Map(rows.map((r) => [r.f.__idx, r.p]));
}

/* --- Correlation view -------------------------------------------------------- */

function correlationInputs() {
  if (!state.pairs || !state.fedResults?.values || !state.provResults?.values) return null;
  /* Through resultsFor, not the raw store: the Turnout tab's apportionment
     setting changes the map, the readout and the turnout table, and a
     correlation computed on different ballots from all three would be a trap. */
  const fedSource = fedValues(), provSource = provValues();
  if (!fedSource || !provSource) return null;
  const fedOnCross = new Map();
  state.crosswalkFed.forEach((f, i) => {
    const unit = fedSource.get(f.idx);
    if (unit) fedOnCross.set(i, unit);
  });
  const provOnCross = new Map();
  state.crosswalkProv.forEach((f, i) => {
    const unit = provSource.get(f.__idx);
    if (unit) provOnCross.set(i, unit);
  });
  return { fedValues: fedOnCross, provValues: provOnCross };
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
  /* When the provincial numbers were modelled from voting places, the areas of
     one catchment are a single measurement between them; the interval has to
     be computed on the number of places, not the number of polygons. */
  /* On the federal geography a poll's provincial numbers are a blend, so the
     source is taken to be whichever voting area contributed most of it. */
  let dominant = null;
  const groupOf = (row) => {
    if (state.provResults?.kind !== 'places') return null;
    let pi = row.provIndex;
    if (pi == null && row.fedIndex != null) {
      if (!dominant) {
        dominant = new Map();
        for (const p of state.pairs) {
          const fi = Analysis.pairIndex(p, 'a'), share = Analysis.pairShare(p, 'a');
          const prev = dominant.get(fi);
          if (!prev || share > prev.share) dominant.set(fi, { share, pi: Analysis.pairIndex(p, 'b') });
        }
      }
      pi = dominant.get(row.fedIndex)?.pi ?? null;
    }
    const feature = pi == null ? null : state.crosswalkProv[pi];
    return feature ? provPlaceGroup(feature.__idx) : null;
  };
  const result = Analysis.correlate(rows, fedParty, provParty, { groupOf });
  state.lastCorrelation = { result, rows, unit, fedParty, provParty };

  const stat = (label, value, note) => {
    const t = el('div', 'viz-stat');
    t.append(el('div', 'viz-stat-value', value), el('div', 'text-small text-muted', label));
    if (note) t.append(el('div', 'text-small text-muted', note));
    return t;
  };
  host.append(
    stat('units compared', fmtInt(result.n),
      result.grouped ? `${fmtInt(result.nEffective)} independent sources` : null),
    stat('Pearson r', fmtNum(result.r),
      result.ci ? `95% CI ${fmtNum(result.ci[0], 2)} to ${fmtNum(result.ci[1], 2)}`
        + (result.grouped ? ', on the sources' : '') : null),
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
  if (fedRep && fedRep.tableVotes) {
    parts.push(`Federal results cover ${fmtPct(fedRep.matchedVotes / fedRep.tableVotes)} of the votes in the `
      + 'loaded federal file; the rest are advance polls and special ballots with no boundary.');
  }
  /* Results reported by voting place leave nothing out -- every ballot was
     spread onto an area -- so the figure worth quoting is how much of that was
     modelled rather than measured. */
  if (state.provResults.kind === 'places' && provRep && provRep.ballotsTotal) {
    parts.push(`Every provincial ballot is on the map, but ${fmtPct(provRep.ballotsSpread / provRep.ballotsTotal)} `
      + 'of them had no voting place and were spread across a whole district.');
  } else if (provRep && provRep.tableVotes) {
    parts.push(`Provincial results cover ${fmtPct(provRep.matchedVotes / provRep.tableVotes)} of the votes in the `
      + 'loaded provincial file.');
  }
  if (minVotes > 0) {
    parts.push(`Units under ${fmtInt(minVotes)} votes on either side are left out.`);
  }
  /* This r moves with apportionment -- apportionUnmatched redistributes
     per-party votes, so the shares it correlates are not the same shares -- and
     the control that decides it is on another tab. */
  if (turnoutBasis().short) {
    parts.push(`Computed on ${turnoutBasis().short}; apportion the advance and special ballots `
      + 'on the Turnout tab to include them.');
  }
  caption.textContent = parts.join(' ');
}

for (const id of ['corr-unit', 'corr-fed-party', 'corr-prov-party', 'corr-min-votes']) {
  $(id).addEventListener('change', refreshCorrelation);
}

/* One scatter routine for every tab: points {x, y, weight, label}, axis
   labels and formats, a colour, an optional fit line, a title per dot. */
function drawScatterXY(node, points, opts) {
  const sel = d3.select(node);
  sel.selectAll('*').remove();
  const w = Math.max(320, node.getBoundingClientRect().width || 640);
  const h = Math.max(280, Math.min(460, w * 0.62));
  sel.attr('viewBox', `0 0 ${w} ${h}`).attr('height', h);
  if (!points.length) return;
  const m = { top: 14, right: 16, bottom: 44, left: 54 };
  const xd = d3.extent(points, (p) => p.x), yd = d3.extent(points, (p) => p.y);
  const padX = ((xd[1] - xd[0]) || Math.abs(xd[0]) || 1) * 0.04;
  const padY = ((yd[1] - yd[0]) || Math.abs(yd[0]) || 1) * 0.04;
  const x = d3.scaleLinear().domain(opts.xDomain || [xd[0] - padX, xd[1] + padX]).range([m.left, w - m.right]).nice();
  const y = d3.scaleLinear().domain(opts.yDomain || [yd[0] - padY, yd[1] + padY]).range([h - m.bottom, m.top]).nice();
  const xFormat = opts.xFormat || d3.format('.0%'), yFormat = opts.yFormat || d3.format('.0%');

  const g = sel.append('g');
  g.append('g').attr('class', 'axis').attr('transform', `translate(0,${h - m.bottom})`)
    .call(d3.axisBottom(x).ticks(6).tickFormat(xFormat));
  g.append('g').attr('class', 'axis').attr('transform', `translate(${m.left},0)`)
    .call(d3.axisLeft(y).ticks(6).tickFormat(yFormat));
  sel.append('text').attr('class', 'axis-label').attr('x', (m.left + w - m.right) / 2)
    .attr('y', h - 8).attr('text-anchor', 'middle').text(opts.xLabel || '');
  sel.append('text').attr('class', 'axis-label')
    .attr('transform', 'rotate(-90)').attr('x', -(m.top + h - m.bottom) / 2).attr('y', 14)
    .attr('text-anchor', 'middle').text(opts.yLabel || '');

  const maxWeight = Math.max(...points.map((p) => p.weight)) || 1;
  const r = (p) => 2 + 5 * Math.sqrt(Math.min(1, p.weight / maxWeight));
  sel.append('g').selectAll('circle').data(points).join('circle')
    .attr('class', 'dot')
    .attr('cx', (p) => x(p.x)).attr('cy', (p) => y(p.y)).attr('r', r)
    .attr('fill', opts.colour || 'var(--viz-series-1)')
    .append('title')
    .text((p) => (opts.title ? opts.title(p) : `${p.label}\n${xFormat(p.x)}, ${yFormat(p.y)}`));

  if (opts.fit) {
    const xs = x.domain();
    const line = d3.line().x((d) => x(d[0])).y((d) => y(d[1]));
    const pts = xs.map((v) => [v, opts.fit.intercept + opts.fit.slope * v]);
    sel.append('path').attr('class', 'fit-line').attr('d', line(pts));
  }
}

function drawScatter(result, fedParty, provParty) {
  const pad = 0.02;
  const xd = d3.extent(result.points, (p) => p.x), yd = d3.extent(result.points, (p) => p.y);
  drawScatterXY($('scatter'), result.points, {
    xLabel: `${fedParty} — federal share`, yLabel: `${provParty} — provincial share`,
    xDomain: result.points.length ? [Math.max(0, xd[0] - pad), Math.min(1, xd[1] + pad)] : null,
    yDomain: result.points.length ? [Math.max(0, yd[0] - pad), Math.min(1, yd[1] + pad)] : null,
    colour: partyColour(fedParty), fit: result.fit,
    title: (p) => `${p.label}\n${fedParty} federal ${fmtPct(p.x)}\n${provParty} provincial ${fmtPct(p.y)}\n${fmtInt(p.weight)} votes`,
  });
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
  const daSel = $('find-da');
  fillSelect(daSel, [{ value: '', label: state.da.active.length ? 'Select an area…' : 'No census layer loaded' },
    ...state.da.active
      .map((f) => ({ value: f.__key, label: daLabel(f) }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))]);
  daSel.disabled = !state.da.active.length;
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
    invalidateSample();
    draw(); populateFinders(); renderReadout(); refreshTurnout(); refreshSocio();
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
/* The slider is read by styleLayer for every overlay, which is the provincial
   layer AND the census one. Restyling only the provincial paths left a shaded
   census layer at its old opacity until something else forced a redraw. */
$('prov-opacity').addEventListener('input', () => {
  applyProvincialStyle(gProv.selectAll('path'));
  if (state.da.active.length) applyDaStyle(gDa.selectAll('path'));
});
