/* --- Loading data ---------------------------------------------------------- */

const readFile = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(new Uint8Array(reader.result));
  reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
  reader.readAsArrayBuffer(file);
});

/* A failed load leaves the file input holding the file it could not read, and
   choosing the same file again fires no change event -- so the retry an error
   message asks for (untick the clipping switch, load it again) would do
   nothing at all. Clearing the input after a failure makes the retry work. */
const clearInput = (id) => { const input = $(id); if (input) input.value = ''; };

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
    /* The File goes in as is: a province-wide download is clipped to the
       study area as it is read instead of being held whole. */
    const loaded = await Ingest.loadBoundaries(file.name, file, { bbox: clipBox('clip-prov') });
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

    const keyDef = state.prov.keyDef;
    const lines = [
      `Loaded ${fmtInt(loaded.kept)} voting areas`
        + (loaded.filtered && loaded.records !== loaded.kept
          ? ` of ${fmtInt(loaded.records)} in ${loaded.label}, clipped to the study area.` : ` from ${loaded.label}.`),
      `Coordinate system: ${loaded.crsLabel}. Keyed by ${keyDef.district ? `${keyDef.district} + ${keyDef.poll}` : keyDef.poll}`
        + ' (change the fields below if that is wrong).',
    ];
    for (const w of loaded.warnings) lines.push(el('p', 'text-warning', w));
    setStatus('status-prov-geo', 'ok', lines);
    $('clear-prov-geo').hidden = false;
    $('prov-missing').hidden = true;
    onProvincialLayerChanged();
  } catch (err) {
    setStatus('status-prov-geo', 'error', [`Could not read ${file.name}.`, err.message]);
    clearInput('file-prov-geo');
  }
});

$('clear-prov-geo').addEventListener('click', () => {
  state.prov.all = []; state.prov.meta = null; state.prov.keyDef = null;
  state.provResults = null;
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
  $('build-crosswalk').disabled = !has && !state.da.all.length;
  invalidateSample();
  draw();
  populateFinders();
  renderReadout();
  refreshTurnout();
  refreshSocio();
}

/* --- Census layers (Statistics Canada, 2021) --------------------------------- */

/* The study area plus 2 km, in lon/lat, for clipping boundary files on load;
   each Data section has its own switch. */
function clipBox(switchId = 'clip-census') {
  if (!$(switchId).checked) return null;
  const e = extentOf(state.fed.active);
  if (!e) return null;
  const dLat = 2000 / 110574;
  const dLon = 2000 / (111320 * Math.cos(((e[1] + e[3]) / 2) * Math.PI / 180));
  return [e[0] - dLon, e[1] - dLat, e[2] + dLon, e[3] + dLat];
}

const CENSUS_NAMES = { da: 'dissemination areas', db: 'dissemination blocks' };

async function loadCensusLayer(kind, file) {
  const statusId = `status-${kind}-geo`;
  setStatus(statusId, 'busy', `Reading ${file.name}…`);
  try {
    /* The File itself goes in, so a national archive is read lazily and
       clipped before its geometry is parsed. */
    const loaded = await Ingest.loadBoundaries(file.name, file, { bbox: clipBox() });
    loaded.features.forEach((f, i) => { f.__idx = i; f.__key = kind + i; });
    const layer = state[kind];
    layer.all = loaded.features;
    layer.meta = loaded;
    layer.keyProp = Census.suggestGeoKey(loaded.features);
    if (kind === 'da') {
      const props = [...new Set(loaded.features.slice(0, 200).flatMap((f) => Object.keys(f.properties || {})))];
      fillSelect($('da-key'), props, layer.keyProp || props[0]);
      $('da-key-row').hidden = props.length === 0;
    }
    const lines = [
      `Loaded ${fmtInt(loaded.kept)} ${CENSUS_NAMES[kind]}`
        + (loaded.filtered && loaded.records !== loaded.kept
          ? ` of ${fmtInt(loaded.records)} in ${loaded.label}, clipped to the study area.` : ` from ${loaded.label}.`),
      `Coordinate system: ${loaded.crsLabel}. Id field: ${layer.keyProp || '(none found)'}.`,
    ];
    for (const w of loaded.warnings) lines.push(el('p', 'text-warning', w));
    setStatus(statusId, 'ok', lines);
    $(`clear-${kind}-geo`).hidden = false;
    onCensusChanged();
  } catch (err) {
    setStatus(statusId, 'error', [`Could not read ${file.name}.`, err.message]);
    clearInput(`file-${kind}-geo`);
  }
}

for (const kind of ['da', 'db']) {
  $(`file-${kind}-geo`).addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) loadCensusLayer(kind, file);
  });
  $(`clear-${kind}-geo`).addEventListener('click', () => {
    const layer = state[kind];
    layer.all = []; layer.active = []; layer.index = null; layer.meta = null; layer.keyProp = null;
    if (kind === 'da') { layer.variables = []; layer.pop = null; layer.shadeVar = null; state.selection.da = null; $('da-key-row').hidden = true; }
    else layer.pop = null;
    $(`file-${kind}-geo`).value = '';
    $(`clear-${kind}-geo`).hidden = true;
    setStatus(`status-${kind}-geo`, 'idle', []);
    onCensusChanged();
  });
}
$('da-key').addEventListener('change', () => {
  state.da.keyProp = $('da-key').value || null;
  onCensusChanged();
});

$('file-geo-attr').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  setStatus('status-geo-attr', 'busy', `Reading ${file.name}…`);
  try {
    const table = await Ingest.loadTable(file.name, await readFile(file));
    const geo = Census.readGeoAttributes(table);
    state.geoAttr = geo;
    let people = 0; for (const v of geo.dbPop.values()) people += v;
    setStatus('status-geo-attr', 'ok', [
      `${fmtInt(geo.dbPop.size)} blocks with a population (${fmtInt(people)} people), summed into `
        + `${fmtInt(geo.daPop.size)} dissemination areas, from ${table.name}.`,
      `Columns: ${geo.columns.db}, ${geo.columns.pop}${geo.columns.da ? ', ' + geo.columns.da : ' (no DAUID column, so no area totals)'}.`,
    ]);
    $('clear-geo-attr').hidden = false;
    onCensusChanged();
  } catch (err) {
    setStatus('status-geo-attr', 'error', [`Could not read ${file.name}.`, err.message]);
    clearInput('file-geo-attr');
  }
});
$('clear-geo-attr').addEventListener('click', () => {
  state.geoAttr = null;
  $('file-geo-attr').value = '';
  $('clear-geo-attr').hidden = true;
  setStatus('status-geo-attr', 'idle', []);
  onCensusChanged();
});

$('file-census').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  setStatus('status-census', 'busy', `Reading ${file.name}…`);
  try {
    const table = await Ingest.loadTable(file.name, await readFile(file));
    const layout = Census.detectProfileLayout(table.header);
    let source;
    if (layout) {
      /* Only the study area's rows are kept when the boundaries are already
         loaded; a provincial profile has millions of others. */
      const wanted = state.da.all.length && state.da.keyProp
        ? new Set(state.da.all.map((f) => Census.geoKey(f.properties[state.da.keyProp]))) : null;
      const profile = Census.parseLongProfile(table, layout, { keep: wanted ? (geo) => wanted.has(geo) : null });
      const derived = Census.deriveVariables(profile);
      source = { kind: 'long', profile, variables: derived.variables, matched: derived.matched,
                 unmatched: derived.unmatched, geographies: profile.geographies, name: table.name };
    } else {
      const wide = Census.readWide(table);
      const starterKeys = new Set(Census.STARTER.map((s) => s.key));
      const starters = wide.variables.filter((v) => starterKeys.has(v.key));
      source = { kind: 'wide', all: wide.variables,
                 variables: starters.length ? starters : wide.variables.slice(0, 40),
                 matched: starters.map((v) => ({ key: v.key, id: null, name: v.key })),
                 unmatched: Census.STARTER.map((s) => s.key).filter((k) => !starters.some((v) => v.key === k)),
                 geographies: wide.geographies, name: table.name, geoColumn: wide.geoColumn };
    }
    state.da.census = source;
    const lines = [source.kind === 'long'
      ? `Census Profile, long layout: ${fmtInt(source.geographies)} geographies${state.da.all.length ? ' in the study area' : ''}, `
        + `${fmtInt(source.profile.characteristics.length)} characteristics, from ${table.name}.`
      : `Wide table: ${fmtInt(source.geographies)} geographies keyed by ${source.geoColumn}, `
        + `${fmtInt(source.all.length)} numeric columns, from ${table.name}.`];
    if (source.matched.length) {
      const d = el('details');
      d.append(el('summary', null, `${fmtInt(source.matched.length)} starter variables matched`));
      const ul = el('ul', 'text-small');
      for (const m of source.matched) ul.append(el('li', null, `${m.key} ← ${m.id != null ? m.id + ': ' : ''}${m.name}${m.over ? ` (of ${m.over})` : ''}`));
      d.append(ul);
      lines.push(d);
    }
    if (source.unmatched.length) {
      lines.push(el('p', 'text-warning', `Not found by name: ${source.unmatched.join(', ')}. `
        + 'Any characteristic can still be added on the Socioeconomic tab.'));
    }
    if (!state.da.all.length) lines.push(el('p', 'text-muted', 'Load the dissemination-area boundaries above to join these variables to the map.'));
    setStatus('status-census', 'ok', lines);
    $('clear-census').hidden = false;
    onCensusChanged();
  } catch (err) {
    setStatus('status-census', 'error', [`Could not read ${file.name}.`, err.message]);
    clearInput('file-census');
  }
});
$('clear-census').addEventListener('click', () => {
  state.da.census = null;
  state.socio.extra.clear();
  $('file-census').value = '';
  $('clear-census').hidden = true;
  setStatus('status-census', 'idle', []);
  onCensusChanged();
});

/* Joins the loaded census variables and populations to the loaded
   boundaries, keyed by each layer's id field. */
function rejoinCensus() {
  const da = state.da;
  da.variables = [];
  if (da.all.length && da.census) {
    const defs = da.census.variables.slice();
    for (const [key, c] of state.socio.extra) {
      if (da.census.kind === 'long') {
        const v = Census.characteristicVariable(da.census.profile, c.id, c.use);
        if (v) defs.push({ ...v, key, extra: true });
      } else {
        const v = da.census.all.find((x) => x.key === key);
        if (v) defs.push({ ...v, extra: true });
      }
    }
    for (const v of defs) da.variables.push({ ...v, byFeature: Census.joinToFeatures(da.all, da.keyProp, v.values) });
    if (!state.socio.selected.size) for (const v of da.census.variables) state.socio.selected.add(v.key);
  }
  da.pop = null;
  if (da.all.length) {
    if (state.geoAttr && state.geoAttr.daPop.size) da.pop = Census.joinToFeatures(da.all, da.keyProp, state.geoAttr.daPop);
    if (!da.pop || !da.pop.size) { const p = da.variables.find((v) => v.key === 'pop_2021'); if (p) da.pop = p.byFeature; }
  }
  const db = state.db;
  db.pop = null;
  if (db.all.length && state.geoAttr) db.pop = Census.joinToFeatures(db.all, db.keyProp, state.geoAttr.dbPop);
}

function onCensusChanged() {
  rejoinCensus();
  $('build-crosswalk').disabled = !state.prov.all.length && !state.da.all.length;
  invalidateSample();
  draw();
  populateFinders();
  refreshDaShadeVars();
  renderReadout();
  refreshTurnout();
  refreshSocio();
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
    clearInput(side === 'fed' ? 'file-fed-results' : 'file-prov-results');
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
  /* The Socioeconomic outcome can be any loaded party's share as well as turnout. */
  const outcome = $('socio-outcome');
  if (outcome) {
    const previous = outcome.value;
    fillSelect(outcome, [
      { value: 'turnout-agg', label: 'Aggregate turnout, both elections' },
      { value: 'turnout-fed', label: 'Federal (2025) turnout' },
      { value: 'turnout-prov', label: 'Provincial (2024) turnout' },
      ...fedParties.map(([name]) => ({ value: `fed:${name}`, label: `${name} share, federal 2025` })),
      ...provParties.map(([name]) => ({ value: `prov:${name}`, label: `${name} share, provincial 2024` })),
    ]);
    outcome.value = [...outcome.options].some((o) => o.value === previous) ? previous : 'turnout-agg';
  }
}
