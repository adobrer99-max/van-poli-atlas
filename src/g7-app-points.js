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
    /* The shape of the misses, which says what KIND of failure this is and so
       which fix would be wasted effort.

       A roll has one row per elector, so a tower is hundreds of rows at a
       single address. Tens of thousands of rows collapsing to a couple of
       thousand addresses means big buildings whose registered parcel address is
       not the one their residents write -- a reference problem, and no amount
       of work on the normaliser touches it. Misses spread across nearly as many
       addresses as rows means the keying itself is wrong. The row count cannot
       tell those apart, and they call for opposite work. */
    if (r.missKeys) {
      const per = r.missRows / r.missKeys;
      /* Read against the rows that DID match, not against an absolute number.

         The first version compared this to 1 and called 3.75 "close to one row
         per address", which is both wrong and the wrong question. What matters
         is whether the addresses that missed look like the addresses that hit:
         3.75 beside a located 4.8 says the same mix of towers and houses, so
         the reference is simply missing addresses across the board rather than
         failing on a particular kind of place. Only a figure far below the
         located one would point at the keying, and far above it at whole
         buildings. The baseline was always sitting in the next sentence. */
      const locatedPer = r.placeKeys ? r.matched / r.placeKeys : null;
      const ratio = locatedPer ? per / locatedPer : null;
      lines.push(el('p', 'text-small text-muted',
        `Those ${fmtInt(r.missRows)} rows sit at ${fmtInt(r.missKeys)} distinct addresses, `
        + `${fmtNum(per, 2)} rows each on average`
        + (locatedPer ? `, against ${fmtNum(locatedPer, 2)} at the addresses that did match. ` : '. ')
        + (ratio == null ? ''
          : ratio > 1.75
            ? 'Far more to an address than the ones that matched, so whole buildings are missing '
              + 'from the reference rather than scattered doors — a newer extract would recover '
              + 'them in blocks.'
          : ratio < 0.45
            ? 'Far fewer to an address than the ones that matched, which points at the keying '
              + 'rather than at missing places.'
            : 'About the same, so the addresses that missed are the same mix of buildings and '
              + 'houses as the ones that hit — the reference is missing addresses across the '
              + 'board, not failing on one kind of place.')));
      if (r.topMisses && r.topMisses.length) {
        lines.push(el('p', 'text-small text-muted',
          'Most electors at one unmatched address: '
          + r.topMisses.slice(0, 5).map((m) => `${m.key} (${fmtInt(m.rows)})`).join('; ') + '.'));
      }
    }
  }
  /* The buildings, which is the useful side of the same count.

     Several electors at one address is not something to explain away: a tower
     is one door for a canvass and hundreds of electors behind it. So the
     addresses carrying the most rows are named, largest first, and the count of
     distinct addresses says how many separate places the list really is. */
  if (r.placeKeys) {
    lines.push(el('p', 'text-small text-muted',
      `${fmtInt(r.matched)} located rows sit at ${fmtInt(r.placeKeys)} distinct addresses — `
      + `${fmtNum(r.matched / r.placeKeys, 1)} each on average.`));
    if (r.topPlaces && r.topPlaces.length > 1 && r.topPlaces[0].rows > 1) {
      lines.push(el('p', 'text-small text-muted',
        'Largest: '
        + r.topPlaces.slice(0, 6).map((m) => `${m.key} (${fmtInt(m.rows)})`).join('; ')
        + '. One address, one visit.'));
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
      /* "addresses" minus a trailing s is "addresse". English plurals in -ses,
         -shes and -ies need more than one character taken off, and the noun is
         whatever the reader typed, so a rule that covers the common shapes and
         leaves anything else alone beats a rule that is confidently wrong. */
      + `${Points.singular(noun)}, ${fmtInt(cov.empty)} carry none`
      + (out ? `, and ${fmtInt(out)} rows fell outside every one of them` : '') + '.'));
    if (cov.sparse) {
      lines.push(el('p', 'text-small text-muted',
        `${fmtInt(cov.sparse)} of those areas hold fewer than ${cov.disclosureBelow}. A count that small `
        + 'describes the people in it, so treat the export as disclosive and aggregate further before sharing.'));
    }
  }
  setStatus('status-points', 'ok', lines);
}

/* A lookup table that is already loaded should not look like a question.

   In a build with the property addresses baked in, this slot arrives satisfied:
   leaving an empty file input sitting under a heading that asks for one is an
   invitation to fill it, and the file nearest to hand on the day is the roll --
   which is exactly what must not go there. So once a reference exists the input
   is put away behind "Replace", and the status line below it says what is
   loaded. */
function showReferenceLoaded(loaded) {
  const slot = $('points-ref-slot');
  const hint = $('points-ref-hint');
  if (slot) slot.hidden = Boolean(loaded);
  if (hint) hint.hidden = Boolean(loaded);
  const swap = $('replace-points-ref');
  if (swap) swap.hidden = !loaded;
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
        /* Almost always the roll, in the wrong box. A lookup table needs
           coordinates; a roll has addresses and needs looking up -- so a file
           that lands here without coordinates is, nine times in ten, the very
           file the input above wants. Saying where it belongs beats restating
           what this input requires, and doubly so when a lookup table is
           already loaded and nothing was needed here at all. */
        throw new Error(pointReference
          ? 'This file has addresses rather than coordinates, so it is something to be '
            + 'looked up, not something to look up against — and the lookup table is '
            + 'already loaded. Load this file under “Places to count” above instead.'
          : 'A lookup table needs coordinates of its own — this one would itself need '
            + 'looking up, so it belongs under “Places to count” above. What goes here is '
            + 'the City of Vancouver property addresses, which carry both.');
      }
      const ref = Points.buildReference(table, layout);
      pointReference = ref;
      /* Names itself, because once the input above it collapses this line is
         all there is: under a heading that reads "Places to count", an
         unlabelled "2 keys from 2 rows" reads as a report on the roll. */
      setStatus('status-points-ref', 'ok', [
        `Address lookup table: ${fmtInt(ref.keys)} keys from `
        + `${fmtInt(table.rows.length)} rows.`,
        el('p', 'text-small text-muted',
          `${fmtInt(ref.duplicates)} rows share a key with an earlier one and keep the first `
          + 'coordinate; two properties at one address sit beside each other, so the area is the '
          + 'same either way, but the point is one of the two.'),
      ]);
      $('clear-points-ref').hidden = false;
      showReferenceLoaded(true);
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
    /* Pooled to one entry per address at load, not at export.

       A roll is hundreds of thousands of rows and the aggregate is a few tens
       of thousands, so keeping the pooled form costs a fraction of keeping the
       rows -- and the rows themselves stay out of state entirely, which is the
       point: what is held after the file has been read is a count per building,
       never a record per person. */
    places: read.report.joined ? Points.byAddress(read.points) : [],
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
  /* Only when the rows were placed by address: a file that carried its own
     coordinates has no addresses to pool by, so there is no list to offer. */
  if ($('points-export-row')) {
    $('points-export-row').hidden = !(state.points && state.points.report
      && state.points.report.joined && state.points.report.matched > 0);
  }
  $('clear-points').hidden = false;
  renderPointsReport();
  updatePointControls();
  draw(); renderReadout(); refreshTurnout();
}

/* The shade options appear only once a file is loaded, and the weighted one
   only once a weight column is chosen. */
/* The mailer list: one row per address, with how many to drop there.

   This is the artefact the roll exists to produce, and it is deliberately not
   the roll. It carries the address, the count, the coordinate and the areas the
   address falls in -- no names, no elector identifiers, nothing about any
   individual. A mail house needs the door and the quantity; it has no use for
   who is behind it, and neither does a canvass plan.

   Sorted largest first, because a building with three hundred electors is one
   visit and forty houses are forty. */
function exportAddresses() {
  const p = state.points;
  if (!p) return;
  const places = p.places || [];
  if (!places.length) {
    setStatus('status-points', 'error',
      ['These rows carried their own coordinates, so there are no addresses to pool them by.']);
    return;
  }
  const targets = pointTargets();
  const indexes = targets.map((t) => ({ ...t, index: Geo.buildIndex(t.features) }));
  const noun = (state.points.noun || 'rows').replace(/\s+/g, '_').toLowerCase();
  const basis = exportBasis();
  const head = ['address', noun];
  if (p.report && p.report.weighted) head.push('weight');
  head.push('longitude', 'latitude');
  for (const t of indexes) head.push(LAYER_COLUMN[t.key] || t.key);
  if (basis) head.push('selected_on', 'selected_value', 'selected_percentile');
  const rows = [head];
  for (const a of places) {
    const row = [a.key, a.rows];
    if (p.report && p.report.weighted) row.push(round5(a.weight));
    row.push(round5(a.lon), round5(a.lat));
    let onFeature = null;
    for (const t of indexes) {
      const i = t.index.hit(a.lon, a.lat);
      row.push(i < 0 ? '' : t.idOf(t.features[i]));
      if (basis && t.key === basis.layer && i >= 0) onFeature = t.features[i];
    }
    if (basis) {
      const v = onFeature ? basis.valueOf(onFeature) : null;
      row.push(basis.label, basis.format(v), basis.percentile(v));
    }
    rows.push(row);
  }
  downloadCsv('addresses.csv', rows);
}

/* Why an address is on the list, taken from what the map is currently
   coloured by.

   A campaign needs to be able to say why a door was chosen, and the honest
   answer names the measure, the election and the year rather than an adjective.
   So the column carries the measure's own label -- "Conservative share, federal
   2025" -- the value for the area that address sits in, and its percentile
   among the areas being charted.

   The percentile is what makes "high" defensible. A share of 41% means nothing
   on its own; 41% at the 94th percentile is a sentence somebody can stand
   behind. And taking all of it from the map's own setting means the export can
   never disagree with what the reader was looking at when they chose it: change
   the colouring, change the justification.

   Returns null when the map is showing nothing, in which case the columns are
   simply absent rather than empty. */
/* Every colouring that puts a NUMBER on an area. Deliberately not DATA_MODES,
   which exists for a different question -- whether the ramp is scaled to the
   data -- and therefore leaves out the party shares, which use a fixed scale.
   Gating on it silently dropped the justification columns for exactly the
   measure a campaign is most likely to target on. The test is the one
   shadeValue itself applies. */
const UNSHADED = new Set(['none', 'type', 'flat', 'catchment']);

function exportBasis() {
  const mode = $('shade-by').value;
  if (UNSHADED.has(mode)) return null;
  const sel = $('shade-by').selectedOptions[0];
  const fedParty = $('shade-party-fed').value;
  const provParty = $('shade-party-prov').value;
  const label = (sel ? sel.textContent.trim() : mode)
    + (mode.includes('fed-party') && fedParty ? ` — ${fedParty}`
      : mode.includes('prov-party') && provParty ? ` — ${provParty}` : '');
  const valueOf = (f) => shadeValue('fed', f, mode, fedParty, provParty);
  /* Ranked against every area the map is drawing, which is the same population
     the colour ramp is scaled to. */
  const all = activeFederal().map(valueOf).filter((v) => v != null && isFinite(v)).sort((a, b) => a - b);
  const isRate = /turnout|party|share|part-|gap|delta/.test(mode);
  return {
    layer: 'fed',
    label,
    valueOf,
    format: (v) => (v == null || !isFinite(v) ? ''
      : isRate ? `${(v * 100).toFixed(1)}%` : String(Math.round(v * 1000) / 1000)),
    percentile: (v) => {
      if (v == null || !isFinite(v) || !all.length) return '';
      let below = 0;
      while (below < all.length && all[below] < v) below++;
      return Math.round((below / all.length) * 100);
    },
  };
}

const LAYER_COLUMN = { fed: 'federal_poll', prov: 'provincial_area', da: 'dissemination_area' };
const round5 = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 1e5) / 1e5 : '');

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
  if ($('export-addresses')) {
    $('export-addresses').addEventListener('click', exportAddresses);
  }
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
    if ($('points-export-row')) $('points-export-row').hidden = true;
    setStatus('status-points', 'idle', []);
    updatePointControls();
    draw(); renderReadout(); refreshTurnout();
  });
  if ($('replace-points-ref')) {
    $('replace-points-ref').addEventListener('click', () => {
      showReferenceLoaded(false);
      $('file-points-ref').click();
    });
  }
  $('clear-points-ref').addEventListener('click', () => {
    pointReference = null;
    $('clear-points-ref').hidden = true;
    showReferenceLoaded(false);
    setStatus('status-points-ref', 'idle', []);
    if (state.pointsTable) applyPointFile(state.pointsTable);
  });
}
