/* --- Loading data ---------------------------------------------------------- */

const readFile = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(new Uint8Array(reader.result));
  reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
  reader.readAsArrayBuffer(file);
});

function setStatus(id, kind, lines) {
  const box = $(id);
  box.textContent = '';
  box.className = 'status status-' + kind;
  for (const line of [].concat(lines)) {
    if (line == null) continue;
    box.append(typeof line === 'string' ? el('p', null, line) : line);
  }
}

function fillSelect(select, options, selected) {
  select.textContent = '';
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = typeof opt === 'string' ? opt : opt.value;
    o.textContent = typeof opt === 'string' ? opt : opt.label;
    select.append(o);
  }
  if (selected != null) select.value = selected;
}

/* --- Provincial boundaries -------------------------------------------------- */

$('file-prov-geo').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  setStatus('status-prov-geo', 'busy', `Reading ${file.name}…`);
  try {
    const bytes = await readFile(file);
    const loaded = await Ingest.loadBoundaries(file.name, bytes);
    loaded.features.forEach((f, i) => { f.__idx = i; f.__key = 'p' + i; });
    state.prov.all = loaded.features;
    state.prov.meta = loaded;

    const suggestion = Results.suggestKeyProperties(loaded.features);
    const props = suggestion.properties;
    $('prov-key-row').hidden = props.length === 0;
    fillSelect($('prov-key-district'),
      [{ value: '', label: '(none — voting area codes are unique on their own)' }, ...props],
      suggestion.district || '');
    fillSelect($('prov-key-va'), props, suggestion.poll || props[0]);
    state.prov.keyDef = { district: suggestion.district || null, poll: suggestion.poll || props[0] };

    const lines = [
      `Loaded ${fmtInt(loaded.features.length)} voting areas from ${loaded.label}.`,
      `Coordinate system: ${loaded.crsLabel}.`,
    ];
    for (const w of loaded.warnings) lines.push(el('p', 'text-warning', w));
    setStatus('status-prov-geo', 'ok', lines);
    $('clear-prov-geo').hidden = false;
    $('prov-missing').hidden = true;
    onProvincialLayerChanged();
  } catch (err) {
    setStatus('status-prov-geo', 'error', [`Could not read ${file.name}.`, err.message]);
  }
});

$('clear-prov-geo').addEventListener('click', () => {
  state.prov.all = []; state.prov.meta = null; state.prov.keyDef = null;
  state.provResults = null; state.crosswalk = null; state.pairs = null; state.provOnFed = null;
  $('file-prov-geo').value = '';
  $('clear-prov-geo').hidden = true;
  $('prov-key-row').hidden = true;
  $('prov-missing').hidden = false;
  setStatus('status-prov-geo', 'idle', []);
  setStatus('status-prov-results', 'idle', []);
  $('map-prov-results').hidden = true;
  onProvincialLayerChanged();
});

function onProvincialLayerChanged() {
  state.selection.prov = null;
  const has = state.prov.all.length > 0;
  $('find-va').disabled = !has;
  $('build-crosswalk').disabled = !has;
  refreshCrosswalkStatus();
  draw();
  populateFinders();
  renderReadout();
}

for (const id of ['prov-key-district', 'prov-key-va']) {
  $(id).addEventListener('change', () => {
    state.prov.keyDef = {
      district: $('prov-key-district').value || null,
      poll: $('prov-key-va').value || null,
    };
    if (state.provResults) rejoinProvincialResults();
    populateFinders();
    renderReadout();
  });
}

/* --- Results tables --------------------------------------------------------- */

/* Results files arrive one riding at a time, so tables are concatenated on a
   shared header before the join runs. */
function mergeTables(existing, incoming) {
  if (!existing) return incoming;
  const sameHeader = existing.header.length === incoming.header.length
    && existing.header.every((h, i) => h === incoming.header[i]);
  if (!sameHeader) {
    throw new Error('This file has different columns from the ones already loaded. '
      + 'Clear the loaded results first, or load files that share a layout.');
  }
  return { header: existing.header, rows: existing.rows.concat(incoming.rows),
           names: (existing.names || []).concat(incoming.names || []) };
}

async function loadResultFiles(files, side) {
  const statusId = side === 'fed' ? 'status-fed-results' : 'status-prov-results';
  setStatus(statusId, 'busy', `Reading ${files.length} file${files.length > 1 ? 's' : ''}…`);
  try {
    let table = side === 'fed'
      ? (state.fedResults && state.fedResults.table)
      : (state.provResults && state.provResults.table);
    for (const file of files) {
      const bytes = await readFile(file);
      const loaded = await Ingest.loadTable(file.name, bytes);
      table = mergeTables(table, { header: loaded.header, rows: loaded.rows, names: [loaded.name] });
    }
    const mapping = (side === 'fed' ? state.fedResults?.mapping : state.provResults?.mapping)
      || Results.detectLayout(table.header, table.rows);
    if (side === 'fed') state.fedResults = { table, mapping };
    else state.provResults = { table, mapping };
    renderMappingUi(side);
    rejoin(side);
  } catch (err) {
    setStatus(statusId, 'error', ['Could not load these results.', err.message]);
  }
}

$('file-fed-results').addEventListener('change', (e) => {
  if (e.target.files.length) loadResultFiles([...e.target.files], 'fed');
  e.target.value = '';
});
$('file-prov-results').addEventListener('change', (e) => {
  if (e.target.files.length) loadResultFiles([...e.target.files], 'prov');
  e.target.value = '';
});
$('clear-fed-results').addEventListener('click', () => {
  state.fedResults = null;
  $('clear-fed-results').hidden = true;
  $('map-fed-results').hidden = true;
  setStatus('status-fed-results', 'idle', []);
  refreshPartySelectors();
  draw(); renderReadout(); refreshCorrelation(); refreshTurnout();
});
$('clear-prov-results').addEventListener('click', () => {
  state.provResults = null; state.provOnFed = null;
  $('clear-prov-results').hidden = true;
  $('map-prov-results').hidden = true;
  setStatus('status-prov-results', 'idle', []);
  refreshPartySelectors();
  draw(); renderReadout(); refreshCorrelation(); refreshTurnout();
});

/* Column pickers, pre-set to whatever detection guessed, so a file with
   unexpected headers can still be joined without editing anything. */
function renderMappingUi(side) {
  const store = side === 'fed' ? state.fedResults : state.provResults;
  const host = $(side === 'fed' ? 'map-fed-results' : 'map-prov-results');
  host.hidden = false;
  host.textContent = '';
  const { header, rows } = store.table;
  const m = store.mapping;

  const head = el('div', 'viz-controls');
  const colOptions = (allowNone) => [
    ...(allowNone ? [{ value: '-1', label: '(none)' }] : []),
    ...header.map((h, i) => ({ value: String(i), label: h || `Column ${i + 1}` })),
  ];
  const picker = (label, key, allowNone) => {
    const wrap = el('label', 'form-label grow', label);
    const sel = el('select', 'form-select');
    fillSelect(sel, colOptions(allowNone), String(m[key]));
    sel.addEventListener('change', () => { m[key] = parseInt(sel.value, 10); rejoin(side); });
    wrap.append(sel);
    return wrap;
  };
  head.append(picker('Electoral district column', 'district', true));
  head.append(picker('Poll / voting area column', 'poll', false));
  if (m.layout === 'long') {
    head.append(picker('Party column', 'party', false));
    head.append(picker('Votes column', 'votes', false));
  }
  host.append(head);
  /* Turnout needs the denominator; merges and voids need recognising. */
  const more = el('div', 'viz-controls');
  more.append(picker('Electors / registered voters column', 'electors', true));
  more.append(picker('Rejected ballots column', 'rejected', true));
  more.append(picker('Merged-with column', 'mergeWith', true));
  host.append(more);

  if (m.layout === 'wide') {
    const note = el('div', 'wide-parties');
    note.append(el('p', 'text-small text-muted', 'Party columns (one column per party):'));
    const boxes = el('div', 'viz-controls');
    header.forEach((h, i) => {
      if (!h) return;
      const lab = el('label', 'form-check');
      const cb = el('input', 'form-check-input');
      cb.type = 'checkbox';
      cb.checked = m.partyColumns.includes(i);
      cb.addEventListener('change', () => {
        m.partyColumns = cb.checked
          ? [...m.partyColumns, i].sort((a, b) => a - b)
          : m.partyColumns.filter((x) => x !== i);
        rejoin(side);
      });
      lab.append(cb, el('span', 'form-check-label', h));
      boxes.append(lab);
    });
    note.append(boxes);
    host.append(note);
  }

  const preview = el('details', 'preview');
  preview.append(el('summary', null, `Preview ${store.table.rows.length.toLocaleString()} rows`));
  const wrap = el('div', 'table-responsive');
  const tbl = el('table', 'table table-sm');
  const thead = el('thead'); const hr = el('tr');
  for (const h of header) hr.append(el('th', null, h));
  thead.append(hr); tbl.append(thead);
  const tbody = el('tbody');
  for (const row of rows.slice(0, 5)) {
    const tr = el('tr');
    for (let i = 0; i < header.length; i++) tr.append(el('td', null, row[i] ?? ''));
    tbody.append(tr);
  }
  tbl.append(tbody); wrap.append(tbl); preview.append(wrap);
  host.append(preview);
}

function rejoin(side) {
  if (side === 'fed') rejoinFederalResults();
  else rejoinProvincialResults();
}

function joinReportNode(report, subject) {
  const frag = document.createDocumentFragment();
  const pctFeatures = report.features ? report.matchedFeatures / report.features : 0;
  const pctVotes = report.tableVotes ? report.matchedVotes / report.tableVotes : 0;
  const grid = el('div', 'viz-grid');
  const stat = (label, value, tone) => {
    const t = el('div', 'viz-stat' + (tone ? ' ' + tone : ''));
    t.append(el('div', 'viz-stat-value', value), el('div', 'text-small text-muted', label));
    return t;
  };
  grid.append(
    stat(`${subject} matched`, `${fmtInt(report.matchedFeatures)} / ${fmtInt(report.features)}`,
         pctFeatures > 0.95 ? 'good' : pctFeatures > 0.6 ? 'warn' : 'bad'),
    stat('votes located on the map', fmtPct(pctVotes),
         pctVotes > 0.9 ? 'good' : pctVotes > 0.5 ? 'warn' : 'bad'),
    stat('electors located', report.electorsColumn ? fmtInt(report.electorsMatched) : '—',
         report.electorsColumn && report.electorsMatched > 0 ? 'good' : 'warn'),
    stat('rows in file', fmtInt(report.tableUnits)),
  );
  frag.append(grid);
  if (!report.electorsColumn) {
    frag.append(el('p', 'text-warning',
      'No electors column was found, so turnout cannot be computed from this file. '
      + 'If it has one under another name, pick it below.'));
  }
  const notes = [];
  if (report.mergedGroups) notes.push(`${fmtInt(report.mergedGroups)} merged poll group${report.mergedGroups > 1 ? 's' : ''} pooled and spread pro rata to electors`);
  if (report.voidPolls) notes.push(`${fmtInt(report.voidPolls)} void poll${report.voidPolls > 1 ? 's' : ''}`);
  if (report.noPollUnits) notes.push(`${fmtInt(report.noPollUnits)} with no poll held`);
  if (notes.length) frag.append(el('p', 'text-small text-muted', notes.join(' · ') + '.'));
  if (report.mergeUnresolved && report.mergeUnresolved.length) {
    frag.append(el('p', 'text-warning',
      `${fmtInt(report.mergeUnresolved.length)} rows name a merge target that is not in the file `
      + `(e.g. poll ${report.mergeUnresolved[0].mergeWith}); they were left as reported.`));
  }

  if (report.matchedOutsideFocus) {
    frag.append(el('p', 'text-small text-muted',
      `A further ${fmtInt(report.matchedOutsideFocus)} ${subject.toLowerCase()} outside the `
      + 'current area also matched, and are available if you widen the area filter.'));
  }
  if (report.matchedFeatures === 0) {
    frag.append(el('p', 'text-destructive',
      'Nothing matched. Check that the district and poll columns above point at the '
      + 'identifiers used in the boundary file.'));
  } else if (pctFeatures < 0.95) {
    frag.append(el('p', 'text-warning',
      `${fmtInt(report.features - report.matchedFeatures)} ${subject.toLowerCase()} had no results row.`));
  }
  if (report.unmatchedRowCount) {
    const d = el('details');
    d.append(el('summary', null,
      `${fmtInt(report.unmatchedRowCount)} rows in the file matched no boundary `
      + `(${fmtInt(report.unmatchedVotes)} votes) — usually advance polls and special ballots`));
    const ul = el('ul', 'text-small');
    for (const r of report.unmatchedRows) {
      ul.append(el('li', null, `${r.unit.district ? r.unit.district + ' · ' : ''}`
        + `poll ${r.unit.poll} — ${fmtInt(r.unit.total)} votes`));
    }
    d.append(ul);
    frag.append(d);
  }
  if (report.ignoredLeadingZeros) {
    frag.append(el('p', 'text-small text-muted',
      'Leading zeros were ignored when matching identifiers.'));
  }
  return frag;
}

function rejoinFederalResults() {
  const store = state.fedResults;
  if (!store) return;
  const keyDef = { district: 'fed', poll: 'poll', federalSuffixes: true };
  const focus = new Set(activeFederal().map((f) => f.idx));
  const joined = Results.join(state.fed.all, keyDef, store.table, store.mapping, focus);
  store.values = joined.values;
  store.parties = joined.parties;
  store.report = joined.report;
  store.keyOpts = joined.keyOpts;
  store.apportioned = buildApportioned(store);
  $('clear-fed-results').hidden = false;
  setStatus('status-fed-results', joined.report.matchedFeatures ? 'ok' : 'error',
    [joinReportNode(joined.report, 'Polling divisions')]);
  refreshPartySelectors();
  draw(); renderReadout(); refreshCorrelation(); refreshTurnout();
}

/* Both apportionment bases are computed once per join; the Turnout tab picks. */
function buildApportioned(store) {
  const out = {};
  for (const basis of ['votes', 'electors']) {
    out[basis] = Turnout.apportionUnmatched(store.values, store.report.unmatchedByDistrict,
      { basis, keyOpts: store.keyOpts });
  }
  return out;
}

function rejoinProvincialResults() {
  const store = state.provResults;
  if (!store || !state.prov.all.length) return;
  const keyDef = { district: state.prov.keyDef?.district, poll: state.prov.keyDef?.poll };
  const focus = state.prov.active.length
    ? new Set(state.prov.active.map((f) => f.__idx)) : null;
  const joined = Results.join(state.prov.all, keyDef, store.table, store.mapping, focus);
  store.values = joined.values;
  store.parties = joined.parties;
  store.report = joined.report;
  store.keyOpts = joined.keyOpts;
  store.apportioned = buildApportioned(store);
  $('clear-prov-results').hidden = false;
  setStatus('status-prov-results', joined.report.matchedFeatures ? 'ok' : 'error',
    [joinReportNode(joined.report, 'Voting areas')]);
  refreshPartySelectors();
  recomputeProvincialOnFederal();
  draw(); renderReadout(); refreshCorrelation(); refreshTurnout();
}

/* Party menus follow whatever parties actually appear in the loaded results. */
function refreshPartySelectors() {
  const fedParties = state.fedResults?.parties || [];
  const provParties = state.provResults?.parties || [];
  const apply = (id, parties, placeholder) => {
    const sel = $(id);
    const previous = sel.value;
    if (!parties.length) {
      fillSelect(sel, [{ value: '', label: placeholder }]);
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    fillSelect(sel, parties.map(([name, votes]) =>
      ({ value: name, label: `${name} (${fmtInt(votes)})` })));
    sel.value = parties.some(([n]) => n === previous) ? previous : parties[0][0];
  };
  apply('shade-party-fed', fedParties, 'Load 2025 federal results');
  apply('shade-party-prov', provParties, 'Load 2024 provincial results');
  if ($('corr-fed-party')) {
    apply('corr-fed-party', fedParties, 'Load federal results');
    apply('corr-prov-party', provParties, 'Load provincial results');
  }
}
