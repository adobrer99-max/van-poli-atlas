/* --- A file of places, on the Data tab ---------------------------------------
   Loads a point file, joins it to a reference when its rows carry addresses
   rather than coordinates, counts it onto every layer that is loaded, and says
   what it did. The maths is in f6-points.js; this file is wiring and words.

   Written knowing it will be run on a machine this code was never tested on,
   against a file its author will never see -- an electors list stays on the
   campaign's own device. So the report says what was detected rather than
   assuming it was right: which columns, which coordinate order, what fraction
   of rows joined, and which keys missed. A silent 30% miss rate is
   indistinguishable from 30% of an electorate not voting. */

/* The reference table, when one has been loaded: address or postal key to a
   coordinate. Kept apart from state.points so that reloading the roll does not
   mean reloading the 99,744-row address file behind it. */
let pointReference = null;

function pointsExtent() {
  const e = extentOf(activeFederal());
  return e && isFinite(e[0]) ? e : null;
}

/* Every loaded polygon layer, so one pass over the points serves all of them. */
function pointTargets() {
  const out = [];
  if (state.fed.active.length) out.push({ key: 'fed', features: state.fed.active, idOf: (f) => f.idx });
  if (state.prov.active.length) out.push({ key: 'prov', features: state.prov.active, idOf: (f) => f.__idx });
  if (state.da.active.length) out.push({ key: 'da', features: state.da.active, idOf: (f) => f.__idx });
  return out;
}

function assignPoints(points) {
  const per = {}, coverage = {}, outside = {};
  for (const t of pointTargets()) {
    const index = Geo.buildIndex(t.features);
    const a = Points.assignToLayer(points, index, (i) => t.idOf(t.features[i]));
    per[t.key] = a.per;
    outside[t.key] = a.outside;
    coverage[t.key] = Points.coverage(a.per, t.features.map(t.idOf), { disclosureBelow: 5 });
  }
  return { per, coverage, outside };
}

const LAYER_NAME = { fed: 'federal polling divisions', prov: 'provincial voting areas',
                     da: 'dissemination areas' };

function renderPointsReport() {
  const p = state.points;
  if (!p) { setStatus('status-points', 'idle', []); return; }
  const r = p.report;
  const lines = [];
  const noun = p.noun || 'rows';

  /* What was detected, first and plainly: everything downstream depends on it
     and nobody else can check it. */
  const how = { lonlat: 'longitude and latitude columns', geometry: 'a GeoJSON geometry column',
                pair: 'one column holding both numbers', address: 'a civic number and a street',
                address1: 'one column holding the whole address', postal: 'a postal code' }[r.kind];
  lines.push(`${fmtInt(r.read)} of ${fmtInt(r.rows)} rows located, from ${how}.`);
  if (r.order && r.kind === 'pair') {
    lines.push(el('p', 'text-small' + (r.order.by === 'assumed' ? ' text-warning' : ' text-muted'),
      `Read as ${r.order.order} — decided by ${r.order.by}. `
      + (r.order.by === 'assumed'
        ? 'Nothing in the file settled it, so check a point on the map before trusting any of this.'
        : 'Reversing these would put every address in the Indian Ocean without erroring, so it is stated rather than assumed.')));
  }
  if (r.joined) {
    const rate = 1 - (r.missRate || 0);
    lines.push(el('p', 'text-small' + (rate < 0.9 ? ' text-warning' : ' text-muted'),
      `${fmtPct(rate)} of rows matched the reference file`
      + (r.misses.length ? `. Unmatched keys include: ${r.misses.slice(0, 6).join('; ')}` : '.')));
    /* Two kinds of miss, and they call for opposite things. A number missing
       from a street the reference knows is a building that went up after the
       extract was taken -- expected in a city that keeps building, and fixed
       by a newer extract if it matters. A street the reference has never heard
       of is usually a column picked wrong or a spelling the normaliser does
       not cover, and one number covering both hides whichever is smaller. */
    if (r.classified && (r.newOnKnownStreet.count || r.unknownStreet.count)) {
      if (r.newOnKnownStreet.count) {
        lines.push(el('p', 'text-small text-muted',
          `${fmtInt(r.newOnKnownStreet.count)} are numbers the reference does not have on streets `
          + 'it does know — almost always built since the property extract was taken. '
          + `For example: ${r.newOnKnownStreet.sample.slice(0, 4).join('; ')}.`));
      }
      if (r.unknownStreet.count) {
        lines.push(el('p', 'text-small text-warning',
          `${fmtInt(r.unknownStreet.count)} are on streets the reference has never heard of, which `
          + 'usually means a column was picked wrong or the street is spelled a way the normaliser '
          + `does not cover. For example: ${r.unknownStreet.sample.slice(0, 4).join('; ')}.`));
      }
    }
  }
  if (r.unreadable) {
    lines.push(el('p', 'text-small text-muted',
      `${fmtInt(r.unreadable)} rows could not be located and are left out of every count below.`));
  }

  for (const t of pointTargets()) {
    const cov = p.coverage[t.key], out = p.outside[t.key];
    lines.push(el('p', 'text-small text-muted',
      `${LAYER_NAME[t.key]}: ${fmtInt(cov.areas - cov.empty)} of ${fmtInt(cov.areas)} carry at least one `
      + `${noun.replace(/s$/, '')}, ${fmtInt(cov.empty)} carry none`
      + (out ? `, and ${fmtInt(out)} rows fell outside every one of them` : '') + '.'));
    if (cov.sparse) {
      lines.push(el('p', 'text-small text-muted',
        `${fmtInt(cov.sparse)} of those areas hold fewer than ${cov.disclosureBelow}. A count that small `
        + 'describes the people in it, so treat the export as disclosive and aggregate further before sharing.'));
    }
  }
  setStatus('status-points', 'ok', lines);
}

/* rethrow is for the payload adopt step. This function handles its own errors
   so that a person who picks the wrong file sees why beside the input -- which
   is right for a file input and wrong for a baked dataset, because adoptPayloads
   can only record what it is told. A build whose reference failed to load
   reported "built into this file, with nothing to load" while the reason sat in
   a drawer no reader has cause to open. */
async function loadPointFile(file, { asReference, rethrow } = {}) {
  const id = asReference ? 'status-points-ref' : 'status-points';
  setStatus(id, 'busy', `Reading ${file.name}…`);
  try {
    const table = await Ingest.loadTable(file.name, await readFile(file));
    const weightColumn = $('points-weight-col') ? $('points-weight-col').value : '';
    const layout = Points.detectPointLayout(table.header, table.rows,
      { extent: pointsExtent(), weightColumn: asReference ? '' : weightColumn });
    if (!layout) {
      throw new Error('No way to locate these rows. Wanted longitude and latitude, a geometry '
        + 'column, one column holding both numbers, or a civic number and a street. '
        + `This file has: ${table.header.slice(0, 10).join(', ')}.`);
    }
    if (asReference) {
      if (Points.NEEDS_REFERENCE.has(layout.kind)) {
        throw new Error('A reference file needs coordinates of its own — this one would itself '
          + 'need looking up. Load the City of Vancouver property addresses, which carry both.');
      }
      const ref = Points.buildReference(table, layout);
      pointReference = ref;
      setStatus('status-points-ref', 'ok', [
        `${fmtInt(ref.keys)} keys from ${fmtInt(table.rows.length)} rows.`,
        el('p', 'text-small text-muted',
          `${fmtInt(ref.duplicates)} rows share a key with an earlier one and keep the first `
          + 'coordinate; two properties at one address sit beside each other, so the area is the '
          + 'same either way, but the point is one of the two.'),
      ]);
      $('clear-points-ref').hidden = false;
      /* A roll already loaded can be joined now that the reference exists. */
      if (state.pointsTable) applyPointFile(state.pointsTable);
      return;
    }
    state.pointsTable = table;
    applyPointFile(table);
  } catch (err) {
    setStatus(id, 'error', [String(err.message || err)]);
    clearInput(asReference ? 'file-points-ref' : 'file-points');
    if (rethrow) throw err;
  }
}

/* Separated from the reading so that loading a reference, or choosing a weight
   column, re-runs the join without re-reading the file. */
function applyPointFile(table) {
  const weightColumn = $('points-weight-col') ? $('points-weight-col').value : '';
  const layout = Points.detectPointLayout(table.header, table.rows,
    { extent: pointsExtent(), weightColumn });
  if (!layout) return;
  if (Points.NEEDS_REFERENCE.has(layout.kind) && !pointReference) {
    setStatus('status-points', 'error', [
      'These rows carry addresses rather than coordinates, so they need a reference file to be '
      + 'placed. Load the City of Vancouver property addresses below and this file will join '
      + 'against it.']);
    return;
  }
  const read = Points.readPoints(table, layout, { reference: pointReference && pointReference.map,
     referenceStreets: pointReference && pointReference.streets });
  const assigned = assignPoints(read.points);
  state.points = {
    ...assigned,
    report: read.report,
    weighted: layout.weight >= 0,
    joined: read.report.joined,
    missRate: read.report.missRate,
    noun: $('points-noun') ? ($('points-noun').value.trim() || 'rows') : 'rows',
    weightNoun: weightColumn || 'weighted',
  };
  fillSelect($('points-weight-col'),
    [{ value: '', label: 'Count the rows' }].concat(
      table.header.map((h) => ({ value: h, label: `Sum ${h}` }))), weightColumn);
  $('points-controls').hidden = false;
  $('clear-points').hidden = false;
  renderPointsReport();
  updatePointControls();
  draw(); renderReadout(); refreshTurnout();
}

/* The shade options appear only once a file is loaded, and the weighted one
   only once a weight column is chosen. */
function updatePointControls() {
  const p = state.points;
  for (const sel of ['shade-by', 'shade-prov-by', 'shade-da-by']) {
    const node = $(sel);
    if (!node) continue;
    for (const value of ['points-count', 'points-weight']) {
      const option = node.querySelector(`option[value="${value}"]`);
      if (!option) continue;
      const ok = Boolean(p) && (value === 'points-count' || p.weighted);
      option.hidden = !ok;
      if (!ok && node.value === value) node.value = 'none';
    }
  }
}

/* --- Wiring ---------------------------------------------------------------- */

if ($('file-points')) {
  $('file-points').addEventListener('change', (e) => {
    if (e.target.files.length) loadPointFile(e.target.files[0], {});
    e.target.value = '';
  });
  $('file-points-ref').addEventListener('change', (e) => {
    if (e.target.files.length) loadPointFile(e.target.files[0], { asReference: true });
    e.target.value = '';
  });
  $('points-weight-col').addEventListener('change', () => {
    if (state.pointsTable) applyPointFile(state.pointsTable);
  });
  $('points-noun').addEventListener('change', () => {
    if (state.points) {
      state.points.noun = $('points-noun').value.trim() || 'rows';
      renderPointsReport(); renderLegend(); renderReadout();
    }
  });
  $('clear-points').addEventListener('click', () => {
    state.points = null; state.pointsTable = null;
    $('clear-points').hidden = true;
    $('points-controls').hidden = true;
    setStatus('status-points', 'idle', []);
    updatePointControls();
    draw(); renderReadout(); refreshTurnout();
  });
  $('clear-points-ref').addEventListener('click', () => {
    pointReference = null;
    $('clear-points-ref').hidden = true;
    setStatus('status-points-ref', 'idle', []);
    if (state.pointsTable) applyPointFile(state.pointsTable);
  });
}
