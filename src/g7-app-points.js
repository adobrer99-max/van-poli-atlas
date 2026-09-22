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
    /* Placed by estimate, said plainly and kept apart from the lookups.

       This is the difference between "the file says this door is here" and
       "the nearest door the file knows is sixty numbers away", and a reader
       deciding whether to trust a per-area count needs to see which they have.
       The median gap is the useful figure: sixty numbers is most of a block and
       almost never crosses a division; six hundred would. */
    if (r.snapped) {
      lines.push(el('p', 'text-small text-muted',
        `A further ${fmtInt(r.snapped)} were placed beside the nearest number on the same street, `
        + `at ${fmtInt(r.snapKeys)} addresses the lookup table does not carry. `
        + `Typically ${fmtInt(r.snapGapMedian)} numbers away, at most ${fmtInt(r.snapGapMax)} — `
        + 'an estimate of where the door is, not a lookup, and never counted as one.'
        + (r.snapCrossedStreet
          ? ` ${fmtInt(r.snapCrossedStreet)} had nothing close on their own side of the street `
            + 'and took the other side, which is the case most likely to cross an area boundary.'
          : ' All kept to their own side of the street.')));
    }
    /* What the civic-number suffix is doing to this join, which was the one
       part of the key nothing reported on.

       A roll that splits 1234A into "1234" and "A" gets them welded back
       together before the lookup. Where the property file carries 1234A that is
       exactly right. Where it carries only the parcel, the row misses the
       lookup and snaps back to 1234 at a gap of zero -- the right building,
       counted as an estimate -- and the direct-lookup rate a reader is told to
       check drops by however many rows that is, with nothing on the map having
       moved. Saying so beats letting somebody conclude the join got worse. */
    if (r.numberSuffix) {
      const ns = r.numberSuffix;
      if (!ns.rows) {
        lines.push(el('p', 'text-small text-muted',
          'The file has a civic-number suffix column and no row fills it, so nothing here '
          + 'depends on it.'));
      } else {
        const same = ns.snappedSameNumber;
        lines.push(el('p', 'text-small text-muted',
          `${fmtInt(ns.rows)} rows carry a civic-number suffix (1234A rather `
          + `than 1234). ${fmtInt(ns.matched)} of them matched the reference exactly`
          + (ns.snapped
            ? `, and ${fmtInt(ns.snapped)} did not`
              + (same
                ? ` — of which ${fmtInt(same)} landed back on their own civic number, meaning the `
                  + 'reference carries the building but not the suffix. Those are at the right '
                  + 'address and counted as estimates, so they lower the matched percentage above '
                  + 'without being misplaced.'
                : '.')
            : '.')));
      }
    }
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
/* --- Canvass results ------------------------------------------------------

   Read by the same machinery that places a roll: addresses joined against the
   same lookup table, pooled to one entry per door. What differs is the column
   it carries -- a support answer rather than a quantity -- and that the answer
   is priced by the reader instead of parsed, because campaign databases agree
   on nothing and this code has never seen the file it will be given.

   What survives the read is a score and a contact count per address. Names,
   notes and numbers are read and dropped in the same pass, and there is no
   flag in make-payload.js that would let any of it into a shared build -- a
   test asserts that by every name such a flag might take. */
let canvassTable = null;

async function loadCanvassFile(file) {
  setStatus('status-canvass', 'busy', `Reading ${file.name}…`);
  try {
    const table = await Ingest.loadTable(file.name, await readFile(file));
    const layout = Points.detectPointLayout(table.header, table.rows, { extent: pointsExtent() });
    if (!layout) {
      throw new Error('No way to locate these rows. Wanted a civic number and a street, one '
        + 'column holding a whole address, or coordinates. '
        + `This file has: ${table.header.slice(0, 10).join(', ')}.`);
    }
    if (Points.NEEDS_REFERENCE.has(layout.kind) && !pointReference) {
      canvassTable = table;
      setStatus('status-canvass', 'error', ['These rows carry addresses rather than '
        + 'coordinates, so they need the same lookup table the roll does. Load the City of '
        + 'Vancouver property addresses above and this file will join against it.']);
      return;
    }
    canvassTable = table;
    applyCanvassFile(table);
  } catch (err) {
    setStatus('status-canvass', 'error', [String(err.message || err)]);
  }
}

/* Which column to read the answer from. Guessed by name where the name gives
   it away, and always overridable, since "the column called Support" is a
   convention rather than a rule. */
const CANVASS_COLUMN_HINTS = [/support/i, /canvass/i, /disposition/i, /response/i,
                              /result/i, /^level$/i, /^score$/i];

function applyCanvassFile(table) {
  const wanted = $('canvass-column') ? $('canvass-column').value : '';
  const header = table.header || [];
  const column = header.includes(wanted) ? wanted
    : (CANVASS_COLUMN_HINTS.map((re) => header.find((h) => re.test(h))).find(Boolean) || header[0]);
  const layout = Points.detectPointLayout(header, table.rows,
    { extent: pointsExtent(), weightColumn: '' });
  if (!layout) return;
  const read = Points.readPoints(table, { ...layout, label: header.indexOf(column) }, {
    reference: pointReference && pointReference.map,
    referenceStreets: pointReference && pointReference.streets,
    snapToStreet: $('points-snap') ? $('points-snap').checked : false,
    byStreet: pointReference && pointReference.byStreet,
  });
  const values = Canvass.values(read.points);
  /* The reader's own prices survive a column change or a reload; only values
     they have never seen get a fresh guess. */
  const previous = (state.canvass && state.canvass.scale) || new Map();
  const scale = Canvass.guess(values);
  for (const { value } of values) if (previous.has(value)) scale.set(value, previous.get(value));
  state.canvass = { column, values, scale, points: read.points, report: read.report,
                    pooled: Canvass.pool(read.points, scale) };
  fillSelect($('canvass-column'), header.map((h) => ({ value: h, label: h })), column);
  $('canvass-controls').hidden = false;
  $('clear-canvass').hidden = false;
  renderCanvassScale();
  renderCanvassReport();
  refreshTargetPicker();
  renderExportBasis();
}

/* Re-price without re-reading: the points are already in hand. */
function rescoreCanvass() {
  if (!state.canvass) return;
  state.canvass.pooled = Canvass.pool(state.canvass.points, state.canvass.scale);
  renderCanvassReport();
  refreshTargetPicker();
  renderExportBasis();
}

function renderCanvassScale() {
  const wrap = $('canvass-scale');
  const list = $('canvass-values');
  if (!wrap || !list || !state.canvass) return;
  wrap.hidden = false;
  list.innerHTML = '';
  for (const { value, rows } of state.canvass.values) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'target-name';
    name.textContent = `${value === '' ? '(blank)' : value} — ${fmtInt(rows)} row${rows === 1 ? '' : 's'}`;
    li.appendChild(name);
    const box = document.createElement('input');
    box.type = 'number';
    box.className = 'form-control target-direction';
    box.min = '0'; box.max = '1'; box.step = '0.05';
    box.style.width = '6rem';
    const at = state.canvass.scale.get(value);
    box.value = at == null ? '' : String(at);
    box.addEventListener('change', () => {
      const n = box.value.trim() === '' ? null : Number(box.value);
      state.canvass.scale.set(value, n != null && isFinite(n) ? Math.max(0, Math.min(1, n)) : null);
      box.value = state.canvass.scale.get(value) == null ? '' : String(state.canvass.scale.get(value));
      rescoreCanvass();
    });
    li.appendChild(box);
    list.appendChild(li);
  }
}

function renderCanvassReport() {
  if (!state.canvass) { setStatus('status-canvass', 'idle', []); return; }
  const s = Canvass.summary(state.canvass.values, state.canvass.scale, state.canvass.pooled);
  const r = state.canvass.report;
  const lines = [`${fmtInt(r.read)} of ${fmtInt(r.rows)} rows located, over `
    + `${fmtInt(s.doors)} addresses. ${fmtInt(s.scoredDoors)} of those carry a support score.`];
  if (r.joined && r.missRate) {
    lines.push(el('p', 'text-small' + (r.missRate > 0.1 ? ' text-warning' : ' text-muted'),
      `${fmtPct(1 - r.missRate)} of rows matched the lookup table.`));
  }
  /* The three ways a row can fail to reach a score, kept apart because they
     call for different things: a blank means nobody answered, an unmapped
     value means the scale below is incomplete, and neither is a zero. */
  if (s.unmapped) {
    lines.push(el('p', 'text-small text-warning',
      `${fmtInt(s.unmapped)} rows carry a value with no score set — they are out of the `
      + 'ranking until one is given below. Numbers are always left for you, since no scale '
      + 'can be read off them safely.'));
  }
  if (s.blank) {
    lines.push(el('p', 'text-small text-muted',
      `${fmtInt(s.blank)} rows have nothing in that column at all — knocked and unanswered, `
      + 'usually, and counted as a contact without a score.'));
  }
  setStatus('status-canvass', s.scoredDoors ? 'ok' : 'idle', lines);
}

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
      /* And a canvass held back for want of it, which is the likelier order:
         both files carry addresses, and whichever was dropped first waited. */
      if (canvassTable) applyCanvassFile(canvassTable);
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
  const read = Points.readPoints(table, layout, {
    reference: pointReference && pointReference.map,
    referenceStreets: pointReference && pointReference.streets,
    snapToStreet: $('points-snap') ? $('points-snap').checked : false,
    byStreet: pointReference && pointReference.byStreet,
  });
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
    refreshTargetPicker();
    renderExportBasis();
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
  const bases = exportBases();
  const basis = bases.length > 0;
  const head = [];
  if (basis) head.push('rank');
  head.push('address', noun);
  if (p.report && p.report.weighted) head.push('weight');
  /* Whether this door was looked up or estimated. A fixed column name, so a
     script can filter on it, and never folded into the coordinate: a reader
     who wants only the addresses the city actually lists can have them. */
  head.push('located_by');
  head.push('longitude', 'latitude');
  /* Whether this door has already been knocked, and what it said.

     The campaign's own throughput is "export the list, check it against the
     canvassing database, drop the ones already identified, target the rest" --
     three steps of which two are a join this already has. Carrying the answer
     out means the filtering happens on one file rather than across two, and
     `canvass_contacts` is there because a door knocked twice and still
     unscored is a different problem from one never visited. */
  const canvassed = (state.canvass && state.canvass.pooled) || null;
  if (canvassed) head.push('canvass_contacts', 'canvass_support');
  for (const t of indexes) head.push(LAYER_COLUMN[t.key] || t.key);
  if (basis) {
    /* One triple per measure, numbered in the order they were chosen.

       They were named for their layer while only one measure per layer was
       possible. Three census indicators at once is the case the target list
       exists for, and three columns called census_value is not a spreadsheet.
       The number is only an index; measure_N_name carries the full label --
       measure, party, and the areas it was ranked against -- so a heading still
       says what it is to somebody who was not in the room when it was chosen. */
    bases.forEach((b, i) => {
      head.push(`measure_${i + 1}_name`, `measure_${i + 1}_value`, `measure_${i + 1}_percentile`);
    });
    /* The composite the rank is taken on, whenever there is more than one
       measure to compose. With a single measure the rank runs down that
       measure's own percentile and a second column saying the same thing
       twice would only invite the question of how they differ. */
    if (bases.length > 1) head.push('target_score');
    /* The running total down the ranked list, which is the column a print run
       is actually planned against. "Mail the top 20,000" is a budget, not a
       row count, and without this somebody works it out in a spreadsheet and
       gets it wrong on the buildings -- one address can be three hundred
       pieces. Read it as: order this row and you have committed this many. */
    head.push(`cumulative_${noun}`);
  }

  /* Build every row first, then decide the order.

     byAddress hands these over biggest building first, which is the right
     default for a file with nothing to rank on and the wrong one for a target
     list: it puts a tower in a safe area above a street in the best one. When
     the map is colouring by something, that something is the priority, and
     building size drops to being the tie-break it should have been -- among
     doors of equal quality, take the ones that come in a single stop.

     Addresses the measures cannot value -- outside a layer, or in an area with
     no result -- are not ranked at all. They go last with an empty rank rather
     than an invented one, because a rank of 41,000 reads as "we looked and it
     was poor" and the truth is that we did not look. */
  const built = places.map((a) => {
    const cells = [a.key, a.rows];
    if (p.report && p.report.weighted) cells.push(round5(a.weight));
    cells.push(a.route === 'interpolated' ? 'nearest on street' : 'address lookup');
    cells.push(round5(a.lon), round5(a.lat));
    if (canvassed) {
      const at = canvassed.get(a.key);
      cells.push(at ? at.contacts : 0,
                 at && at.support != null ? Math.round(at.support * 1000) / 1000 : '');
    }
    const onLayer = {};
    for (const t of indexes) {
      const i = t.index.hit(a.lon, a.lat);
      cells.push(i < 0 ? '' : t.idOf(t.features[i]));
      if (i >= 0) onLayer[t.key] = t.features[i];
    }
    /* Every selected measure has to land, or the address is not ranked.

       Averaging over whichever measures happened to resolve silently compares
       different things, and the address with less behind it can win: one
       measure at the 90th percentile outscores 90th-and-50th, so a door can
       reach the top of a target list for the reason that it is missing data.
       Score on all of them or on none, and let the columns show which. */
    const parts = [];
    let whole = bases.length > 0;
    for (const b of bases) {
      /* An address-scoped measure reads the door itself; every other kind
         reads the area the door falls in. That distinction is the whole reason
         the scope exists: an area measure gives the same number to every door
         in the division, and a door-level one is the only thing that can order
         them against each other. */
      const subject = b.scope === 'address' ? a : (onLayer[b.layer] || null);
      let v = subject ? b.valueOf(subject) : null;
      if (v != null && !isFinite(v)) v = null;
      if (v == null) whole = false;
      parts.push(v);
      cells.push(b.label, b.format(v), b.percentile(v));
    }
    /* The mean of the percentiles, which is what "rank on X and Y together"
       means once somebody has to write it down. Percentiles rather than the
       values themselves because a vote share and a median income do not add:
       one runs 0 to 1 and the other to six figures, and summing them ranks
       every address by income alone. */
    let score = null;
    if (whole) {
      let sum = 0;
      bases.forEach((b, i) => { sum += b.fraction(parts[i]); });
      score = (sum / bases.length) * 100;
    }
    if (bases.length > 1) cells.push(whole ? Math.round(score * 10) / 10 : '');
    /* Two different quantities, kept apart because they answer different
       questions and one of them used to answer both.

       `count` is what the noun column holds and what the running total adds up,
       so the two agree by construction. `size` is how big a drop this door is,
       which is what "largest building first" is an argument about -- and where
       a reader has named a weight column, the weight IS that quantity and the
       row count is not. A roll with one row per elector makes them equal and
       hides the difference; a file with one row per address and a count in a
       column makes the row count 1 everywhere, which left the tie-break sorting
       on a constant and doing nothing at all. */
    return { cells, value: whole ? score : null,
             count: a.rows,
             size: (p.report && p.report.weighted) ? a.weight : a.rows,
             key: a.key };
  });

  if (basis) {
    /* How doors that scored identically are ordered against each other.

       This matters far more than it looks. Every measure above is reported for
       an AREA, so every door in a polling division scores the same and the
       tie-break decides the order of hundreds of addresses at a time -- in a
       real export, 237 doors share the median score and the largest block is
       2,666. Whatever this comparator does is most of the within-area ordering
       in the file.

       It used to be building size, descending, always and invisibly: one stop
       for many pieces, which is a real argument about delivery cost. But it is
       also a directional bet about who lives in large buildings, and in a city
       where those skew renter it can put the least promising doors at the top
       of every area. So it is a visible choice now, defaulting to what it
       always did, and "address" is there for readers who would rather the file
       admit it has no information to order these doors by. */
    const order = $('target-tiebreak') ? $('target-tiebreak').value : 'largest';
    const tie = (x, y) => (order === 'largest' ? y.size - x.size
      : order === 'smallest' ? x.size - y.size : 0) || x.key.localeCompare(y.key);
    built.sort((x, y) => {
      if (x.value == null && y.value == null) return tie(x, y);
      if (x.value == null) return 1;
      if (y.value == null) return -1;
      return y.value - x.value || tie(x, y);
    });
    let reached = 0, rank = 0;
    for (const b of built) {
      if (b.value == null) { b.cells.unshift(''); b.cells.push(''); continue; }
      reached += b.count;
      b.cells.unshift(++rank);
      b.cells.push(reached);
    }
    /* Measures were chosen and not one door could be ranked on them.

       The file would be a hundred thousand rows in address order with an empty
       rank column, under a name like true-blue-conservatives.csv -- which looks
       exactly like a target list and is not one. That happened: a turnout
       measure with no elector denominator behind it valued nothing, and the
       export was written, downloaded and passed on before anybody read a cell.

       Refusing is the honest answer. The measure that came up empty is named,
       because "nothing ranked" is a symptom and the reader needs the cause. */
    if (!rank) {
      const empty = bases.filter((b) => !b.resolves).map((b) => b.label);
      setStatus('status-points', 'error', [
        'Nothing could be ranked, so no file was written — a list where every rank is blank '
        + 'is not a target list, whatever it is named.',
        el('p', 'text-small', empty.length
          ? `${empty.join('; ')} has no value for anything, and a door is ranked only where `
            + 'every chosen measure has one. Remove it, or load the data behind it — a turnout '
            + 'rate needs an elector count, which arrives in its own file.'
          : 'Every address is missing a value on at least one chosen measure. Remove a measure, '
            + 'or check the coverage of the ones on the list.'),
      ]);
      return;
    }
  }

  /* A campaign produces several of these in a sitting -- one list of existing
     supporters, one of crossover voters, one on demographics -- and three files
     called mailer-targets.csv in a downloads folder is how the wrong one gets
     sent to the printer. The reader names the list; the name becomes the file.

     Slugged rather than trusted: this string reaches a filesystem, and a
     download named with a slash or a leading dot is somebody else's bug
     report. */
  const given = $('points-export-name') ? $('points-export-name').value.trim() : '';
  const slug = given.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  downloadCsv(`${slug || (basis ? 'mailer-targets' : 'addresses')}.csv`,
    [head].concat(built.map((b) => b.cells)));
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

   One entry per layer that is currently colouring something, because a target
   list is rarely one measure.

   The lists a campaign actually asks for are conjunctions: provincial
   Conservative share AND turnout, to find the supporters it already has;
   provincial Conservative AND federal Liberal, to find the crossover it can
   persuade; a demographic indicator on top of either. Ranking on one measure
   and eyeballing the rest is how a door ends up on a list for a reason nobody
   can reconstruct afterwards.

   So each of the three map layers contributes whatever it is currently
   colouring by, every contribution keeps its own value and percentile column,
   and the rank runs down the mean of the percentiles. The reader composes the
   list by setting the map; the file records what they set.

   Returns an empty array when no layer is showing anything, in which case the
   columns are simply absent rather than empty. */
/* Every colouring that puts a NUMBER on an area. Deliberately not DATA_MODES,
   which exists for a different question -- whether the ramp is scaled to the
   data -- and therefore leaves out the party shares, which use a fixed scale.
   Gating on it silently dropped the justification columns for exactly the
   measure a campaign is most likely to target on. The test is the one
   shadeValue itself applies. */
const UNSHADED = new Set(['none', 'type', 'flat', 'catchment']);

/* The three map layers, their selectors, and the areas each is drawing. */
const BASIS_LAYERS = [
  { key: 'fed', select: 'shade-by', on: 'federal polls', features: () => activeFederal() },
  { key: 'prov', select: 'shade-prov-by', on: 'provincial areas',
    features: () => (state.prov && state.prov.active) || [] },
  { key: 'da', select: 'shade-da-by', on: 'census areas',
    features: () => (state.da && state.da.active) || [] },
];
const BASIS_LAYER = Object.fromEntries(BASIS_LAYERS.map((l) => [l.key, l]));

/* Which shade modes name a party rather than being a measure on their own, and
   which side's party list fills them in. */
const PARTY_MODES = { 'fed-party': 'fed', 'prov-party': 'prov', 'muni-party': 'muni' };

/* Left out of the target list on purpose. `gap` is a federal party share minus
   a provincial one: it needs TWO parties, and offering every pairing would be
   thirty-six entries of which one is wanted. Nothing is lost for targeting --
   "high provincially and high federally" is two measures, which the list holds
   natively and reports separately, and separately is how a campaign reads it. */
const NOT_A_TARGET = new Set(['gap']);

function partiesFor(side) {
  if (side === 'muni') {
    const node = $('muni-party');
    return node ? [...node.options].filter((o) => o.value).map((o) => [o.value]) : [];
  }
  const store = side === 'fed' ? state.fedResults : state.provResults;
  return (store && store.parties) || [];
}

/* Every concrete measure the export could rank on as things stand.

   Concrete is the point. A shade mode is not a measure until its party is
   filled in -- "Federal party share" ranks nothing, "Federal party share,
   Liberal" ranks something -- so the party-bearing modes are expanded against
   the parties actually present in the loaded results, and a census variable
   becomes one entry per variable. What comes back can be put in a select and
   chosen from without consulting anything else on screen, which is the whole
   reason the list exists. */
/* Measures that are facts about the door rather than about the area it sits in.

   There is exactly one of these today, and it is worth saying why. Every party
   share, every turnout figure and every census indicator is reported for an
   area, so two doors in the same polling division carry identical values on all
   of them -- 237 addresses share the median score in a real export. Nothing
   computed from area measures can separate two doors, because the sources hold
   no fact that distinguishes them.

   What the roll does hold, per address, is how many electors are there. That is
   genuinely door-level, and until now it was spent as an invisible tie-break:
   biggest building first, within every area, in a direction nobody chose. In a
   city where large buildings skew renter that may be ordering the best doors
   last. As a measure it is visible, it carries a percentile, it can be weighed
   against the rest, and its direction is the reader's to decide rather than
   the sort comparator's.

   Canvass support, when there is a file to read it from, is the same shape:
   address-scoped, joined by the same machinery, ranked the same way. */
function addressMeasures() {
  const p = state.points;
  if (!p || !(p.places || []).length) return [];
  const noun = p.noun || 'rows';
  const out = [{ id: 'address|count|', scope: 'address', kind: 'count',
                 label: `How many ${noun} are at the address`, on: 'each address' }];
  if (p.weighted) {
    out.push({ id: 'address|weight|', scope: 'address', kind: 'weight',
               label: `${p.weightNoun || 'Weighted'} total at the address`, on: 'each address' });
  }
  /* The only measure here that is about the people rather than the building.
     Offered once a canvass has been priced -- before that every score is null
     and it would rank nothing, which is a worse answer than not appearing. */
  const c = state.canvass;
  if (c && [...c.pooled.values()].some((a) => a.support != null)) {
    out.push({ id: 'address|canvass|', scope: 'address', kind: 'canvass',
               label: 'Canvass support at the address', on: 'each address' });
  }
  return out;
}

function measureCatalogue() {
  const out = addressMeasures();
  for (const layer of BASIS_LAYERS) {
    const node = $(layer.select);
    if (!node || !layer.features().length) continue;
    for (const opt of node.options) {
      const mode = opt.value;
      if (UNSHADED.has(mode) || NOT_A_TARGET.has(mode) || opt.hidden) continue;
      const text = opt.textContent.trim();
      if (mode === 'variable') {
        for (const v of socioVariables()) {
          out.push({ id: `${layer.key}|${mode}|${v.key}`, layer: layer.key, mode,
                     censusVar: v.key, label: v.label, on: layer.on });
        }
        continue;
      }
      const side = PARTY_MODES[mode];
      if (side) {
        for (const [name] of partiesFor(side)) {
          out.push({ id: `${layer.key}|${mode}|${name}`, layer: layer.key, mode, party: name,
                     label: `${text} — ${name}`, on: layer.on });
        }
        continue;
      }
      out.push({ id: `${layer.key}|${mode}|`, layer: layer.key, mode, label: text, on: layer.on });
    }
  }
  /* A measure that can value nothing is not a measure a reader can choose.
     Offering it is how a list came out with every row unranked. */
  return out.filter(resolvesAny);
}

/* Where a measure's value sits among its peers, in the direction the reader
   asked for.

   The composite has always assumed more is better, which is wrong for half the
   measures somebody would reasonably target on. A campaign whose support runs
   against renters wants FEWER electors at the door, not more; a list built on
   renter share wants a low one. Ranking those the only way the code could
   express put the worst doors first, and nothing on screen said so.

   So direction belongs to the measure rather than to the code. Inverting the
   standing rather than negating the value keeps the arithmetic in the same
   0..1 space the mean is taken over, and leaves the value and percentile
   columns reading as themselves. */
function directed(m, all) {
  const raw = (v) => {
    if (v == null || !isFinite(v) || !all.length) return 0;
    let below = 0;
    while (below < all.length && all[below] < v) below++;
    return below / all.length;
  };
  if (!m.invert) return raw;
  return (v) => (v == null || !isFinite(v) || !all.length ? 0 : 1 - raw(v));
}

/* Does this measure have a value for anything at all?

   Offered-but-empty is the failure this exists to stop. Provincial turnout sat
   in the picker looking exactly like the measures that work, and it could not
   value a single area: a results file carries votes, and a rate needs an
   elector denominator Elections BC publishes per district and never per voting
   area. Every address came out unranked -- correctly, since a door is ranked
   only where every chosen measure has a value -- and a hundred thousand rows of
   blank ranks were exported and handed on before anybody saw it.

   That particular measure is now withdrawn upstream, in updatePlaceControls,
   which is the better place for a mode nothing can ever fill. This stays as the
   general case, because the catalogue is assembled from live data and any
   measure can empty out: a cleared layer, a census variable absent from the
   loaded profile, a canvass whose every contact refused. The rule was right.
   Letting somebody reach the file was not.

   Short-circuits on the first value it finds, so the usual case costs one
   lookup. */
function resolvesAny(m) {
  if (m.scope === 'address') {
    const places = (state.points && state.points.places) || [];
    if (!places.length) return false;
    if (m.kind === 'canvass') {
      const pooled = (state.canvass && state.canvass.pooled) || new Map();
      return places.some((a) => {
        const at = pooled.get(a.key);
        return Boolean(at) && at.support != null;
      });
    }
    return places.some((a) => {
      const v = m.kind === 'weight' ? a.weight : a.rows;
      return v != null && isFinite(v);
    });
  }
  const layer = BASIS_LAYER[m.layer];
  const features = layer ? layer.features() : [];
  if (!features.length) return false;
  if (m.censusVar) {
    const table = (socioVariables().find((v) => v.key === m.censusVar) || {}).byFeature;
    if (!table) return false;
    return features.some((f) => {
      const v = table.get(f.__idx);
      return v != null && isFinite(v);
    });
  }
  const side = PARTY_MODES[m.mode];
  return features.some((f) => {
    const v = shadeValue(m.layer, f, m.mode,
      side === 'fed' ? m.party : '', side === 'prov' ? m.party : '',
      side === 'muni' ? m.party : undefined);
    return v != null && isFinite(v);
  });
}

/* One chosen measure, turned into the thing the export ranks with. */
function basisFor(m) {
  /* Address-scoped measures rank against the other doors rather than against
     the other areas, so the percentile answers "how big is this building among
     the buildings" instead of borrowing an area's standing. */
  if (m.scope === 'address') {
    const places = (state.points && state.points.places) || [];
    if (!places.length) return null;
    /* A canvassed door that was never scored has no value here, not a zero:
       "nobody answered" and "they said no" are opposite facts and only one of
       them belongs at the bottom of a target list. An address with no value is
       left out of the ranking entirely, which is what the composite already
       does with any measure it cannot fill. */
    const canvassed = (state.canvass && state.canvass.pooled) || new Map();
    const valueOf = m.kind === 'canvass'
      ? (a) => { const at = canvassed.get(a.key); return at ? at.support : null; }
      : m.kind === 'weight' ? (a) => a.weight : (a) => a.rows;
    const all = places.map(valueOf)
      .filter((v) => v != null && isFinite(v)).sort((a, b) => a - b);
    const fraction = directed(m, all);
    return {
      id: m.id, scope: 'address', layer: null, resolves: all.length,
      label: `${m.label} · ${m.on}${m.invert ? ' · fewer first' : ''}`,
      valueOf, fraction,
      format: (v) => (v == null || !isFinite(v) ? '' : String(Math.round(v * 1000) / 1000)),
      percentile: (v) => (v == null || !isFinite(v) || !all.length
        ? '' : Math.round(fraction(v) * 100)),
    };
  }
  const layer = BASIS_LAYER[m.layer];
  const features = layer ? layer.features() : [];
  if (!features.length) return null;
  const side = PARTY_MODES[m.mode];
  /* A census variable is selected by a second control rather than by the mode,
     so the value lookup needs that variable's own table rather than whatever
     the map happens to be showing. */
  const censusTable = m.censusVar
    ? (socioVariables().find((v) => v.key === m.censusVar) || {}).byFeature : null;
  if (m.censusVar && !censusTable) return null;
  /* Each side's party is passed on its own line rather than by sharing one
     value across all three. A measure names the party it means, and a lookup
     that falls through to a selector would rank a file by a party nobody chose
     for it -- the exact disagreement between file and intent this list exists
     to remove. */
  const fedParty = side === 'fed' ? m.party : '';
  const provParty = side === 'prov' ? m.party : '';
  const muniParty = side === 'muni' ? m.party : undefined;
  const valueOf = censusTable
    ? (f) => (censusTable.get(f.__idx) ?? null)
    : (f) => shadeValue(m.layer, f, m.mode, fedParty, provParty, muniParty);
  /* What the option name leaves out. A non-voter figure means nothing without
     both halves of its subtraction, and this column is the one that leaves the
     tab, so it is the last place it may go unsaid. */
  const qualifier = NONVOTER_MODES.has(m.mode) && state.nonvoters.pairing
    ? ` — ${state.nonvoters.pairing.label}, ${state.nonvoters.pairing.route}` : '';
  const label = `${m.label}${qualifier} · ${m.on}`;
  /* Ranked against every area this layer is drawing, which is the same
     population its colour ramp is scaled to. */
  const all = features.map(valueOf)
    .filter((v) => v != null && isFinite(v)).sort((a, b) => a - b);
  const isRate = m.censusVar
    ? false : /turnout|party|share|part-|gap|delta/.test(m.mode);
  /* The unrounded standing, which is what the composite is built from. The
     displayed percentile is a whole number and three hundred addresses can
     share one; averaging the rounded figure throws away the ordering inside
     every tie before the mean is even taken. */
  const fraction = directed(m, all);
  return {
    id: m.id,
    layer: m.layer,
    resolves: all.length,
    label,
    valueOf,
    fraction,
    format: (v) => (v == null || !isFinite(v) ? ''
      : isRate ? `${(v * 100).toFixed(1)}%` : String(Math.round(v * 1000) / 1000)),
    percentile: (v) => (v == null || !isFinite(v) || !all.length
      ? '' : Math.round(fraction(v) * 100)),
  };
}

/* What the download will be ranked on: the target list where the reader has
   built one, and otherwise whatever the map is showing.

   The fallback is not a convenience. Before the list existed the export took
   its measures from the map's three shade selectors, which made the file
   impossible to disagree with what the reader was looking at -- a real property
   and worth keeping for the one-measure case, where setting the map and hitting
   download is still the shortest honest path. The list wins when it has
   anything in it, because an explicit choice beats an inferred one. */
function exportBases() {
  const chosen = (state.targets || []).map(basisFor).filter(Boolean);
  if (chosen.length) return chosen;
  const out = [];
  const fedParty = $('shade-party-fed') ? $('shade-party-fed').value : '';
  const provParty = $('shade-party-prov') ? $('shade-party-prov').value : '';
  for (const layer of BASIS_LAYERS) {
    const node = $(layer.select);
    if (!node) continue;
    const mode = node.value;
    if (UNSHADED.has(mode) || !layer.features().length) continue;
    const sel = node.selectedOptions[0];
    const text = sel ? sel.textContent.trim() : mode;
    const side = PARTY_MODES[mode];
    const party = side === 'fed' ? fedParty : side === 'prov' ? provParty
      : side === 'muni' && $('muni-party') ? $('muni-party').value : '';
    const censusVar = mode === 'variable' && $('shade-da-var') ? $('shade-da-var').value : null;
    const basis = basisFor({
      id: `${layer.key}|${mode}|${censusVar || party}`,
      layer: layer.key, mode, party: party || undefined,
      censusVar: censusVar || undefined,
      label: censusVar
        ? ((socioVariables().find((v) => v.key === censusVar) || {}).label || text)
        : party ? `${text} — ${party}` : text,
      on: layer.on,
    });
    if (basis) out.push(basis);
  }
  return out;
}

const LAYER_COLUMN = { fed: 'federal_poll', prov: 'provincial_area', da: 'dissemination_area' };
const round5 = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 1e5) / 1e5 : '');

/* Say, beside the button, what the download is about to be ranked on.

   The measures live on the Map tab and the button lives here, which is one tab
   too far for anybody to hold in their head across three exports in a sitting.
   Naming them at the point of download is the cheapest possible guard against
   the error that matters -- shipping a list built on last export's settings. */
function renderExportBasis() {
  const node = $('points-export-basis');
  if (!node) return;
  const bases = exportBases();
  const explicit = (state.targets || []).length > 0;
  if (!bases.length) {
    node.className = 'text-small text-warning';
    node.textContent = 'Nothing is selected to rank on, so this downloads in address order rather '
      + 'than priority order. Add a measure above, or colour the map by one.';
    return;
  }
  /* Which of the two paths is in force, said in as many words. They produce
     different files from the same button, and a reader who thinks the map is
     driving it when the list is has no way to tell from the rows. */
  const source = explicit ? '' : ' Taken from what the map is showing, since no measure is chosen.';
  /* The same quantity chosen twice, on two geographies.

     "Provincial party share — Conservative Party" is offered under both "On
     provincial areas", where the agency reported it, and "On federal polls",
     where it has been crosswalked. The labels differ by four words in the
     middle and the two sit in different groups, so adding both is an easy slip
     -- and it is not a harmless one. The mean weights every entry equally, so
     the doubled measure takes two shares of the composite while everything else
     takes one, and the extra share is carried by the crosswalked estimate
     rather than the reported figure. A list meant to balance share against
     turnout quietly becomes two thirds share. */
  const seen = new Map();
  const doubled = [];
  for (const m of state.targets || []) {
    const quantity = `${m.mode}|${m.party || m.censusVar || ''}`;
    if (m.scope === 'address') continue;
    if (seen.has(quantity)) doubled.push(m.label);
    else seen.set(quantity, m.label);
  }
  /* A chosen measure that has stopped resolving -- data cleared, a layer
     unloaded, a results file replaced by one without the denominator its rate
     needs. The catalogue will not offer such a measure, but a list built when
     it did resolve keeps it, and every door then comes out unranked. */
  const empty = bases.filter((b) => !b.resolves).map((b) => b.label);
  const dead = empty.length
    ? ` ${empty.length === 1 ? 'One measure has' : `${empty.length} measures have`} no value for `
      + `anything on the list (${empty.join('; ')}), so nothing can be ranked: a door is ranked `
      + 'only where every chosen measure has a value. Remove it, or load the data it needs.'
    : '';
  node.className = (doubled.length || empty.length)
    ? 'text-small text-warning' : 'text-small text-muted';
  node.textContent = (bases.length === 1
    ? `Ranked on ${bases[0].label}.`
    : `Ranked on the average standing across ${bases.length} measures: `
      + `${bases.map((b) => b.label).join('; ')}. An address is ranked only where all `
      + `${bases.length} have a value for it.`) + source
    + (doubled.length
      ? ` ${doubled.length === 1 ? 'One measure is' : `${doubled.length} measures are`} on the `
        + `list twice on different geographies (${doubled.join('; ')}), so ${doubled.length === 1
          ? 'it counts' : 'they count'} double against everything else. Remove the crosswalked `
        + 'copy unless you meant to weight it that way.'
      : '') + dead;
}

/* The measures on offer, minus the ones already chosen. Re-read every time it
   is shown: parties arrive with the results file and census variables with the
   profile, so a list built at load would be empty and stay empty. */
function refreshTargetPicker() {
  const sel = $('target-measure');
  if (!sel) return;
  const taken = new Set((state.targets || []).map((m) => m.id));
  const all = measureCatalogue().filter((m) => !taken.has(m.id));
  const previous = sel.value;
  sel.innerHTML = '';
  if (!all.length) {
    sel.appendChild(new Option(taken.size ? 'Every available measure is on the list'
      : 'Load results or a census profile first', ''));
    sel.disabled = true;
  } else {
    sel.disabled = false;
    /* Grouped by the areas each is measured on, because the same measure on two
       geographies is two different numbers and the group heading is the only
       place that distinction fits without doubling every option's length. */
    for (const on of [...new Set(all.map((m) => m.on))]) {
      const group = document.createElement('optgroup');
      group.label = `On ${on}`;
      for (const m of all.filter((x) => x.on === on)) group.appendChild(new Option(m.label, m.id));
      sel.appendChild(group);
    }
    if (all.some((m) => m.id === previous)) sel.value = previous;
  }
  const list = $('target-list');
  if (list) {
    list.innerHTML = '';
    (state.targets || []).forEach((m, i) => {
      const li = document.createElement('li');
      /* In its own element rather than as a bare text node on the li: a text
         node in a flex or grid row is an anonymous item with no class to size,
         and whatever the row's first track happens to be is where it lands. */
      const name = document.createElement('span');
      name.className = 'target-name';
      name.textContent = `${i + 1}. ${m.label} · ${m.on}`;
      li.appendChild(name);
      /* Which end of the measure is the good end. More is better for a party
         share and worse for anything a campaign runs against -- renter share,
         or the size of a building when its support skews to owners.

         A select rather than a toggle button, because the button was read as an
         action and not as a state. "More is better" on a clickable control says
         both "this is how it is ranking" and "click to make it so", and the two
         readings prescribe opposite clicks. It was got wrong on a real list the
         first time it was used -- the door measure left ranking big buildings up
         by a campaign whose support runs the other way -- while the tie-break
         select directly above it, which can only be read one way, was set
         correctly. A control whose two readings disagree is a control that will
         be set wrong, and the evidence arrived within an hour. */
      const dir = document.createElement('select');
      dir.className = 'form-select target-direction';
      for (const [value, label] of [['high', 'More is better'], ['low', 'Fewer is better']]) {
        const opt = new Option(label, value);
        if ((value === 'low') === Boolean(m.invert)) opt.selected = true;
        dir.appendChild(opt);
      }
      dir.addEventListener('change', () => {
        const low = dir.value === 'low';
        state.targets = state.targets.map(
          (x) => (x.id === m.id ? { ...x, invert: low } : x));
        refreshTargetPicker();
        renderExportBasis();
      });
      li.appendChild(dir);
      const drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'btn btn-small';
      drop.textContent = 'Remove';
      drop.addEventListener('click', () => {
        state.targets = state.targets.filter((x) => x.id !== m.id);
        refreshTargetPicker();
        renderExportBasis();
      });
      li.appendChild(drop);
      list.appendChild(li);
    });
  }
  if ($('target-clear')) $('target-clear').hidden = !(state.targets || []).length;
}

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
    /* Every control that can change what the file would be ranked on, including
       the two party pickers: "Conservative share" and "Liberal share" are the
       same shade mode with a different party behind it, and a line that did not
       follow the party would name the wrong list while looking right. */
    for (const id of ['shade-by', 'shade-prov-by', 'shade-da-by',
                      'shade-party-fed', 'shade-party-prov']) {
      const node = $(id);
      if (node) node.addEventListener('change', renderExportBasis);
    }
    /* And again whenever the tab is opened. A census variable can change the
       measure behind shade-da-by without anybody firing a change event on the
       select itself, and a line that is right at load and wrong by the time it
       is read is worse than no line: it would be believed. The picker is
       refreshed on the same beat, since parties and census variables arrive
       with their files rather than at load. */
    if ($('tab-data')) {
      $('tab-data').addEventListener('click', () => { refreshTargetPicker(); renderExportBasis(); });
    }
    if ($('target-add')) {
      $('target-add').addEventListener('click', () => {
        const id = $('target-measure').value;
        const found = measureCatalogue().find((m) => m.id === id);
        if (!found || (state.targets || []).some((m) => m.id === id)) return;
        state.targets = (state.targets || []).concat([found]);
        refreshTargetPicker();
        renderExportBasis();
      });
    }
    if ($('target-clear')) {
      $('target-clear').addEventListener('click', () => {
        state.targets = [];
        refreshTargetPicker();
        renderExportBasis();
      });
    }
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
  if ($('file-canvass')) {
    $('file-canvass').addEventListener('change', (e) => {
      if (e.target.files.length) loadCanvassFile(e.target.files[0]);
      e.target.value = '';
    });
    $('canvass-column').addEventListener('change', () => {
      if (canvassTable) applyCanvassFile(canvassTable);
    });
    $('clear-canvass').addEventListener('click', () => {
      canvassTable = null;
      state.canvass = null;
      /* Any target list ranking on it goes with it, rather than being left
         pointing at a measure that no longer has values. */
      state.targets = (state.targets || []).filter((m) => m.kind !== 'canvass');
      $('canvass-controls').hidden = true;
      $('canvass-scale').hidden = true;
      $('clear-canvass').hidden = true;
      setStatus('status-canvass', 'idle', []);
      refreshTargetPicker();
      renderExportBasis();
    });
  }
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
