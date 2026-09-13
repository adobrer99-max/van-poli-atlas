/* --- Vancouver's municipal election, on the Data tab -------------------------
   Two files from the city's open data portal, joined on an integer, smoothed
   onto whichever polygon layers are loaded. The maths is in f7-municipal.js
   and f4-places.js; this file is wiring and words.

   The one thing worth knowing before reading it: this election is measured
   differently from the other two, and the difference is not cosmetic. You may
   vote at any voting place in Vancouver, so a ballot's location says much less
   about its voter than it does federally or provincially. Everything below
   follows from that -- the distance smoothing instead of catchments, the two
   bandwidths instead of one, and the absence of any per-area turnout. */

/* Every polygon layer that is loaded, so one spread serves all of them. The
   weight is the layer's own electorate where the atlas has one and ground area
   where it does not: an area with no electors would otherwise take no ballots
   at all, which is wrong for a park with a tower on its edge and very wrong
   for a layer with no results loaded yet. */
function muniTargets() {
  const out = [];
  const areaOf = (f) => (f.__area || (f.__area = Geo.areaM2(f.geometry))) || 1;
  if (state.fed.active.length) {
    const v = fedValues();
    out.push({ key: 'fed', features: federalStudyArea(), idOf: (f) => f.idx,
               weightOf: (f) => (v && v.get(f.idx)?.electors) || areaOf(f) / 1e4,
               capOf: (f) => (v && v.get(f.idx)?.electors) || 0 });
  }
  if (state.prov.active.length) {
    const v = provValues();
    out.push({ key: 'prov', features: state.prov.active, idOf: (f) => f.__idx,
               weightOf: (f) => (v && v.get(f.__idx)?.electors) || areaOf(f) / 1e4,
               capOf: (f) => (v && v.get(f.__idx)?.electors) || 0 });
  }
  if (state.da.active.length) {
    out.push({ key: 'da', features: state.da.active, idOf: (f) => f.__idx,
               weightOf: (f) => (state.da.pop && state.da.pop[f.__idx]) || areaOf(f) / 1e4,
               capOf: () => 0 });
  }
  return out;
}

function muniBandwidth() {
  const n = (id, fallback) => {
    const v = $(id) ? parseFloat($(id).value) : NaN;
    return isFinite(v) && v > 0 ? v : fallback;
  };
  return { finalM: n('muni-band-final', Places.BANDWIDTH.finalM),
           advanceM: n('muni-band-advance', Places.BANDWIDTH.advanceM) };
}

/* One race, spread onto every loaded layer. The cap is the area's own
   electorate where there is one: a ceiling that stops a model claiming more
   ballots than an area has voters, never a target. Constraining to a target
   returns that target everywhere, which is an answer rather than a
   measurement. */
function spreadMunicipal(read) {
  const on = {}, reports = {};
  const bandwidth = muniBandwidth();
  for (const t of muniTargets()) {
    const idx = new Map(t.features.map((f, i) => [i, f]));
    const spread = Places.smoothToAreas(t.features, read, {
      bandwidth,
      pointOf: (f) => (f.__pt || (f.__pt = Geo.representativePoint(f.geometry))),
      weightOf: (i) => t.weightOf(idx.get(i)),
      capOf: (i) => t.capOf(idx.get(i)),
      pollOf: (f) => String(t.idOf(f)),
      districtOf: () => 'CoV',
    });
    const byId = new Map();
    for (const [i, u] of spread.values) byId.set(t.idOf(t.features[i]), u);
    on[t.key] = byId;
    reports[t.key] = spread.report;
  }
  return { on, reports, bandwidth };
}

function applyMunicipal() {
  const files = state.muniFiles;
  if (!files.places || !files.races || !files.races.length) return;
  const raceName = $('muni-race') && $('muni-race').value;
  const race = files.races.find((r) => r.name === raceName) || files.races[0];
  try {
    const built = Municipal.toPlacesTable(race.table, files.places, { district: 'CoV' });
    const layout = Places.detectPlaceLayout(built.table.header);
    if (!layout) throw new Error('The joined table carried no party columns to read.');
    const read = Places.readPlaces(built.table, layout);
    /* UBC and the UEL are a different jurisdiction whose electors vote for
       School Trustee and nothing else. Their two places are held out of the
       city spread rather than quietly folded into a City of Vancouver map. */
    const inCity = { ...read, places: read.places.filter((p) => p.ed === 'COV'),
                     unlocated: read.unlocated.filter((p) => p.ed === 'COV') };
    const spread = spreadMunicipal(inCity);
    state.muni = {
      ...spread,
      race: race.name,
      built,
      read: inCity,
      parties: read.parties,
      overview: files.overview,
      ballots: inCity.places.reduce((a, p) =>
        a + (p.declaredTotal == null ? p.total + p.rejected : p.declaredTotal), 0),
    };
    fillSelect($('muni-party'), read.parties.map(([name]) => ({ value: name, label: name })),
      $('muni-party').value);
    fillSelect($('muni-race'), files.races.map((r) => ({ value: r.name, label: r.name })), race.name);
    $('muni-party-label').hidden = false;
    $('muni-controls').hidden = false;
    $('clear-muni').hidden = false;
    updateMuniControls();
    renderMuniReport();
    draw(); renderReadout(); refreshResults(true);
  } catch (err) {
    setStatus('status-muni', 'error', [String(err.message || err)]);
  }
}

function renderMuniReport() {
  const m = state.muni;
  if (!m) { setStatus('status-muni', 'idle', []); return; }
  const r = m.built.report;
  const lines = [];
  lines.push(`${r.title || m.race}: ${fmtInt(m.ballots)} ballots on ${fmtInt(r.matched)} voting places.`);
  if (r.seats > 1) {
    lines.push(el('p', 'text-small text-muted',
      `Every ballot in this race carries up to ${fmtInt(r.seats)} votes, so the party columns are `
      + 'votes and the ballots column is ballots. The share is a share of votes; the surface is ballots.'));
  }
  if (r.summaries.length) {
    lines.push(el('p', 'text-small text-muted',
      `${r.summaries.map((s) => `${s.label} (${fmtInt(s.ballots)})`).join(', ')} `
      + `${r.summaries.length === 1 ? 'is a summary row and is' : 'are summary rows and are'} `
      + 'held out rather than added as places, which would count the election twice.'));
  }
  if (r.unplaced.length) {
    lines.push(el('p', 'text-small text-muted',
      `${r.unplaced.map((u) => `${u.name} (${fmtInt(u.ballots)})`).join(', ')}: reported without a `
      + 'voting place, so they are left off the map rather than put somewhere plausible.'));
  }
  if (r.outsideCity) {
    lines.push(el('p', 'text-small text-muted',
      `${fmtInt(r.outsideCity)} ballots were cast on the UBC Lands and the UEL, which are outside the `
      + 'city. They are excluded from everything below.'));
  }
  const ov = m.overview;
  if (ov && ov.turnout) {
    lines.push(el('p', 'text-small text-muted',
      `City-wide turnout was ${fmtPct(ov.turnout)} — ${fmtInt(ov.ballots)} ballots on `
      + `${fmtInt(ov.electors)} registered voters, as the city publishes it. That is the only `
      + 'turnout figure this election contributes: there is no municipal turnout by area, because '
      + 'a map of where ballots were cast in a vote-anywhere election is largely a map of the '
      + 'voting places.'));
  }
  for (const [key, rep] of Object.entries(m.reports)) {
    const name = { fed: 'federal polling divisions', prov: 'provincial voting areas',
                   da: 'dissemination areas' }[key];
    lines.push(el('p', 'text-small text-muted',
      `${name}: spread over ${fmtInt(rep.areasAssigned)} of ${fmtInt(rep.areasTotal)}, `
      + `each resting on about ${rep.placesPerArea.median.toFixed(1)} voting places `
      + `(${rep.placesPerArea.min.toFixed(1)} to ${rep.placesPerArea.max.toFixed(1)})`
      + (rep.capsBinding
        ? `, and ${fmtInt(rep.capsBinding)} were pulled back to their own electorate`
        : '') + '.'));
  }
  lines.push(el('p', 'text-small text-muted',
    `Spread at ${fmtInt(m.bandwidth.finalM)} m for final-day places and `
    + `${fmtInt(m.bandwidth.advanceM)} m for advance ones. Widening these flattens the map and `
    + 'narrowing them concentrates it; neither makes it agree better with a real turnout surface, '
    + 'which is why the party share is what this election is here for.'));
  setStatus('status-muni', 'ok', lines);
}

/* The two municipal shade options appear once the results are loaded, on every
   layer they were spread onto. */
function updateMuniControls() {
  const m = state.muni;
  for (const [sel, key] of [['shade-by', 'fed'], ['shade-prov-by', 'prov']]) {
    const node = $(sel);
    if (!node) continue;
    for (const value of ['muni-party', 'muni-ballots']) {
      const option = node.querySelector(`option[value="${value}"]`);
      if (!option) continue;
      const ok = Boolean(m && m.on[key]);
      option.hidden = !ok;
      if (!ok && node.value === value) node.value = 'none';
    }
  }
}

/* --- Reading the two files ------------------------------------------------- */

/* The results arrive as an archive of one sheet per race plus an Overview and
   a Totals sheet. Every race is kept so the selector can switch between them
   without re-reading the file. */
async function loadMuniResults(file) {
  setStatus('status-muni', 'busy', `Reading ${file.name}…`);
  const bytes = await readFile(file);
  const races = [], seen = new Set();
  let overview = null;
  const add = (name, bytesIn) => {
    const table = TextFormats.parseDelimited(TextFormats.decodeBytes(bytesIn));
    if (!table.header.length) return;
    if (Municipal.isOverviewSheet(name)) { overview = Municipal.readOverview(table) || overview; return; }
    if (!Municipal.isRaceSheet(name) || seen.has(name)) return;
    const label = name.replace(/^.*[-\/]/, '').replace(/\.[a-z]+$/i, '').trim() || name;
    seen.add(name);
    races.push({ name: label, table });
  };
  if (/\.zip$/i.test(file.name)) {
    const zip = BinaryFormats.readZip(bytes);
    for (const [name, open] of zip) {
      /* The archive carries the resource forks a Mac adds when it is rezipped;
         they parse as empty tables and would appear as races. */
      if (name.includes('__MACOSX') || /(^|\/)\./.test(name)) continue;
      if (!/\.(csv|tsv|txt)$/i.test(name)) continue;
      add(name, await open());
    }
  } else {
    add(file.name, bytes);
  }
  if (!races.length) {
    throw new Error('No race sheet was found. The 2022 archive holds Mayor, Councillor, '
      + 'ParkBoard, SchoolTrustee and three questions; load that archive, or one of its sheets.');
  }
  state.muniFiles.races = races;
  state.muniFiles.overview = overview;
}

async function loadMuniPlaces(file) {
  setStatus('status-muni', 'busy', `Reading ${file.name}…`);
  const table = await Ingest.loadTable(file.name, await readFile(file));
  state.muniFiles.places = Municipal.readVotingPlaces(table);
}

async function loadMuniFile(file, which) {
  try {
    if (which === 'results') await loadMuniResults(file); else await loadMuniPlaces(file);
    const files = state.muniFiles;
    if (!files.places) {
      setStatus('status-muni', 'busy', [
        `${fmtInt(files.races.length)} races read. Now load the voting places file, which carries the `
        + 'coordinates these results have to be joined to.']);
      return;
    }
    if (!files.races) {
      setStatus('status-muni', 'busy', [
        `${fmtInt(files.places.count)} voting places read. Now load the results archive.`]);
      return;
    }
    applyMunicipal();
  } catch (err) {
    setStatus('status-muni', 'error', [String(err.message || err)]);
    clearInput(which === 'results' ? 'file-muni-results' : 'file-muni-places');
  }
}

/* --- Wiring ---------------------------------------------------------------- */

if ($('file-muni-results')) {
  $('file-muni-results').addEventListener('change', (e) => {
    if (e.target.files.length) loadMuniFile(e.target.files[0], 'results');
    e.target.value = '';
  });
  $('file-muni-places').addEventListener('change', (e) => {
    if (e.target.files.length) loadMuniFile(e.target.files[0], 'places');
    e.target.value = '';
  });
  $('muni-race').addEventListener('change', () => applyMunicipal());
  for (const id of ['muni-band-final', 'muni-band-advance']) {
    $(id).addEventListener('change', () => { if (state.muni) applyMunicipal(); });
  }
  $('muni-party').addEventListener('change', () => { draw(); renderReadout(); });
  $('clear-muni').addEventListener('click', () => {
    state.muni = null;
    state.muniFiles = { places: null, races: null, overview: null };
    $('clear-muni').hidden = true;
    $('muni-controls').hidden = true;
    $('muni-party-label').hidden = true;
    setStatus('status-muni', 'idle', []);
    updateMuniControls();
    draw(); renderReadout(); refreshResults(true);
  });
}
