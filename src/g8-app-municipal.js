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
/* The year of the municipal results that are loaded: read from the race sheet
   titles or the archive's name, never assumed, so a 2022 archive still says
   2022 and a 2026 one says 2026. Empty until something is loaded. */
function muniYear() {
  return (state.muni && state.muni.year)
    || (state.muniFiles && state.muniFiles.year) || '';
}

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

/* One race from one election's two files, joined and spread onto every
   loaded layer. Both the election being mapped and the one it is compared
   with go through here, so the two sides of a swing are made the same way. */
function spreadRace(files, race) {
  const built = Municipal.toPlacesTable(race.table, files.places, { district: 'CoV' });
  const layout = Places.detectPlaceLayout(built.table.header);
  if (!layout) throw new Error('The joined table carried no party columns to read.');
  const read = Places.readPlaces(built.table, layout);
  /* UBC and the UEL are a different jurisdiction whose electors vote for
     School Trustee and nothing else. Their places are held out of the city
     spread rather than quietly folded into a City of Vancouver map. */
  const inCity = { ...read, places: read.places.filter((p) => p.ed === 'COV'),
                   unlocated: read.unlocated.filter((p) => p.ed === 'COV') };
  const spread = spreadMunicipal(inCity);
  return {
    ...spread,
    race: race.name,
    year: files.year || Municipal.yearOf(built.report.title) || '',
    built,
    read: inCity,
    parties: read.parties,
    overview: files.overview,
    ballots: inCity.places.reduce((a, p) =>
      a + (p.declaredTotal == null ? p.total + p.rejected : p.declaredTotal), 0),
  };
}

function applyMunicipal() {
  const files = state.muniFiles;
  if (!files.places || !files.races || !files.races.length) return;
  const raceName = $('muni-race') && $('muni-race').value;
  const race = files.races.find((r) => r.name === raceName) || files.races[0];
  try {
    state.muni = spreadRace(files, race);
    const read = state.muni.read;
    fillSelect($('muni-party'), read.parties.map(([name]) => ({ value: name, label: name })),
      $('muni-party').value);
    fillSelect($('muni-race'), files.races.map((r) => ({ value: r.name, label: r.name })), race.name);
    $('muni-party-label').hidden = false;
    $('muni-controls').hidden = false;
    $('clear-muni').hidden = false;
    applyMuniBase(false);
    updateMuniControls();
    renderMuniReport();
    draw(); renderReadout(); refreshResults(true);
  } catch (err) {
    setStatus('status-muni', 'error', [String(err.message || err)]);
  }
}

/* --- The earlier election, for a swing -------------------------------------

   Loaded the same way as the main one and spread onto the same layers with the
   same bandwidths, then held beside it. Nothing else in the atlas reads it: it
   exists to be subtracted. The race always follows the one being mapped, so
   the two sides of a swing are never different contests. */
function applyMuniBase(redraw = true) {
  const files = state.muniBaseFiles;
  state.muniBase = null;
  const finish = () => {
    updateMuniControls();
    renderMuniBaseReport();
    if (redraw) { draw(); renderReadout(); }
  };
  if (!files.places || !files.races || !files.races.length) { finish(); return; }
  if (!state.muni) {
    setStatus('status-muni-base', 'busy', [
      `${files.year || 'Earlier'} results and voting places read. Load the election above `
      + 'to compare them with.']);
    if (redraw) updateMuniControls();
    return;
  }
  const race = Municipal.matchRace(state.muni.race, files.races);
  if (!race) { finish(); return; }
  try {
    const base = spreadRace(files, race);
    const parties = Municipal.swingParties(state.muni.parties, base.parties);
    base.swingParties = parties;
    base.city = new Map(parties.map((p) => [p, {
      now: Municipal.cityShare(state.muni.read, p),
      then: Municipal.cityShare(base.read, p),
    }]));
    state.muniBase = base;
    fillSelect($('muni-swing-party'), parties.map((p) => ({ value: p, label: p })),
      $('muni-swing-party').value);
    $('muni-swing-party-label').hidden = !parties.length;
  } catch (err) {
    setStatus('status-muni-base', 'error', [String(err.message || err)]);
    return;
  }
  finish();
}

function renderMuniBaseReport() {
  const files = state.muniBaseFiles;
  const b = state.muniBase, m = state.muni;
  $('clear-muni-base').hidden = !(files.places || files.races);
  if (!files.places && !files.races) { setStatus('status-muni-base', 'idle', []); return; }
  if (!b) {
    if (m && files.races && files.places) {
      setStatus('status-muni-base', 'busy', [
        `${m.race} has no counterpart in the ${files.year || 'earlier'} results to compare with. `
        + 'Mayor, Councillor, Park Board and School Trustee are compared; the questions change '
        + 'from one election to the next, so they never are.']);
    }
    return;
  }
  const lines = [];
  lines.push(`${b.year} ${b.race}: ${fmtInt(b.ballots)} ballots on `
    + `${fmtInt(b.built.report.matched)} voting places, compared with ${m.year} ${m.race}.`);
  if (b.year && m.year && +b.year >= +m.year) {
    lines.push(el('p', 'text-small text-muted',
      `The comparison election (${b.year}) is not earlier than the one mapped (${m.year}). `
      + 'The swing is still the mapped year minus the comparison year, so read its sign accordingly.'));
  }
  if (b.swingParties.length) {
    const city = b.swingParties.map((p) => {
      const c = b.city.get(p);
      return c.now == null || c.then == null ? null
        : `${p} ${fmtSwing(c.now - c.then)}`;
    }).filter(Boolean);
    lines.push(el('p', 'text-small text-muted',
      `On the ballot both times, under the same name: ${b.swingParties.join(', ')}. `
      + `City-wide swing: ${city.join(' · ')}.`));
  } else {
    lines.push(el('p', 'text-small text-muted',
      'No party ran in this race under the same name both times, so there is no swing to draw.'));
  }
  lines.push(el('p', 'text-small text-muted',
    'Each year is smoothed from its own voting places with the bandwidths above, then the shares '
    + 'are subtracted. The voting places moved between the two elections, so a swing in one area '
    + 'is partly a change in where people could vote; the city-wide swing has no such problem, and '
    + 'the map offers the swing against it for that reason.'));
  setStatus('status-muni-base', 'ok', lines);
}

function renderMuniReport() {
  const m = state.muni;
  if (!m) { setStatus('status-muni', 'idle', []); return; }
  const r = m.built.report;
  const lines = [];
  lines.push(`${r.title || m.race}: ${fmtInt(m.ballots)} ballots on ${fmtInt(r.matched)} voting places.`);
  const vp = state.muniFiles.places;
  if (vp && vp.inferredAdvance) {
    lines.push(el('p', 'text-small text-muted',
      `${fmtInt(vp.inferredAdvance)} voting places share a building with a lower-numbered one `
      + 'and are not marked Advance Only; each is read as that building\u2019s advance place. The '
      + '2026 file uses Advance Only for buildings that held nothing else.'));
  }
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
  /* Every layer the spread reached, not only the two election ones: the
     municipal model produces a value per dissemination area as well, and
     leaving that off the census dropdown hid a working path. */
  for (const [sel, key] of [['shade-by', 'fed'], ['shade-prov-by', 'prov'], ['shade-da-by', 'da']]) {
    const node = $(sel);
    if (!node) continue;
    const b = state.muniBase;
    for (const value of ['muni-party', 'muni-ballots', 'muni-swing', 'muni-swing-rel']) {
      const option = node.querySelector(`option[value="${value}"]`);
      if (!option) continue;
      const swing = value.startsWith('muni-swing');
      const ok = Boolean(m && m.on[key])
        && (!swing || Boolean(b && b.on[key] && b.swingParties.length));
      option.hidden = !ok;
      /* The markup names no year, so the option says which election it is
         showing once one is loaded. */
      if (!option.dataset.base) option.dataset.base = option.textContent.trim();
      const years = swing ? (b && b.year && m.year ? `${b.year}\u2192${m.year}` : '') : (m && m.year) || '';
      option.textContent = years ? `${option.dataset.base} (${years})` : option.dataset.base;
      if (!ok && node.value === value) node.value = 'none';
    }
  }
}

/* --- Reading the two files ------------------------------------------------- */

/* The results arrive as an archive of one sheet per race plus an Overview and
   a Totals sheet. Every race is kept so the selector can switch between them
   without re-reading the file. */
/* One archive, or the sheets from inside one already unpacked -- a payload
   baked into the build carries them separately, because an archive would have
   to be base64 to survive being inlined. */
/* The main election and the comparison one load through the same code into
   their own slot, and report on their own status line. */
const MUNI_SLOT = {
  main: { files: () => state.muniFiles, status: 'status-muni',
          inputs: ['file-muni-results', 'file-muni-places'] },
  base: { files: () => state.muniBaseFiles, status: 'status-muni-base',
          inputs: ['file-muni-base-results', 'file-muni-base-places'] },
};

async function loadMuniResults(input, slot = 'main') {
  const S = MUNI_SLOT[slot];
  const files = Array.isArray(input) ? input : [input];
  setStatus(S.status, 'busy', `Reading ${files.map((f) => f.name).join(', ')}…`);
  const races = [], seen = new Set();
  let overview = null, catalogue = null, year = null;
  const add = (name, bytesIn) => {
    const table = TextFormats.parseDelimited(TextFormats.decodeBytes(bytesIn));
    if (!table.header.length) return;
    catalogue = catalogue || Municipal.catalogueLink(table);
    if (Municipal.isOverviewSheet(name)) { overview = Municipal.readOverview(table) || overview; return; }
    if (!Municipal.isRaceSheet(name) || seen.has(name)) return;
    const label = Municipal.raceLabel(name);
    const race = Municipal.detectRace(table);
    year = year || Municipal.yearOf(race && race.title, name);
    seen.add(name);
    races.push({ name: label, table });
  };
  for (const file of files) {
    const bytes = await readFile(file);
    if (/\.zip$/i.test(file.name)) {
      year = year || Municipal.yearOf(file.name);
      const zip = BinaryFormats.readZip(bytes);
      for (const [name, open] of zip) {
        /* The archive carries the resource forks a Mac adds when it is
           rezipped; they parse as empty tables and would appear as races. */
        if (name.includes('__MACOSX') || /(^|\/)\./.test(name)) continue;
        if (!/\.(csv|tsv|txt)$/i.test(name)) continue;
        add(name, await open());
      }
    } else {
      add(file.name, bytes);
    }
  }
  if (!races.length) {
    if (catalogue) {
      throw new Error(catalogue.url
        ? `That is the open-data portal's list of elections, not the results — it has one row per `
          + `election with a link to each. The one you want is ${catalogue.name}: ${catalogue.url}`
        : `That is the open-data portal's list of elections, not the results. It offers `
          + `${catalogue.elections.join(', ')}; download the archive for the one you want and load that.`);
    }
    throw new Error('No race sheet was found. The archive holds Mayor, Councillor, '
      + 'Park Board, School Trustee and three questions; load that archive, or one of its sheets.');
  }
  races.sort((a, b) => Municipal.raceRank(a.name) - Municipal.raceRank(b.name)
    || a.name.localeCompare(b.name));
  const into = S.files();
  into.races = races;
  into.overview = overview;
  into.year = year;
}

async function loadMuniPlaces(file, slot = 'main') {
  const S = MUNI_SLOT[slot];
  setStatus(S.status, 'busy', `Reading ${file.name}…`);
  const table = await Ingest.loadTable(file.name, await readFile(file));
  S.files().places = Municipal.readVotingPlaces(table);
}

async function loadMuniFile(file, which, slot = 'main') {
  const S = MUNI_SLOT[slot];
  try {
    if (which === 'results') await loadMuniResults(file, slot);
    else await loadMuniPlaces(Array.isArray(file) ? file[0] : file, slot);
    const files = S.files();
    if (!files.places) {
      setStatus(S.status, 'busy', [
        `${fmtInt(files.races.length)} races read. Now load the voting places file, which carries the `
        + 'coordinates these results have to be joined to.']);
      return;
    }
    if (!files.races) {
      setStatus(S.status, 'busy', [
        `${fmtInt(files.places.count)} voting places read. Now load the results archive.`]);
      return;
    }
    if (slot === 'base') applyMuniBase();
    else applyMunicipal();
  } catch (err) {
    setStatus(S.status, 'error', [String(err.message || err)]);
    clearInput(which === 'results' ? S.inputs[0] : S.inputs[1]);
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
  $('muni-swing-party').addEventListener('change', () => { draw(); renderReadout(); });
  $('file-muni-base-results').addEventListener('change', (e) => {
    if (e.target.files.length) loadMuniFile(e.target.files[0], 'results', 'base');
    e.target.value = '';
  });
  $('file-muni-base-places').addEventListener('change', (e) => {
    if (e.target.files.length) loadMuniFile(e.target.files[0], 'places', 'base');
    e.target.value = '';
  });
  $('clear-muni-base').addEventListener('click', () => {
    state.muniBase = null;
    state.muniBaseFiles = { places: null, races: null, overview: null, year: null };
    $('muni-swing-party-label').hidden = true;
    applyMuniBase();
  });
  $('clear-muni').addEventListener('click', () => {
    state.muni = null;
    state.muniBase = null;
    state.muniFiles = { places: null, races: null, overview: null, year: null };
    $('muni-swing-party-label').hidden = true;
    applyMuniBase(false);
    $('clear-muni').hidden = true;
    $('muni-controls').hidden = true;
    $('muni-party-label').hidden = true;
    setStatus('status-muni', 'idle', []);
    updateMuniControls();
    draw(); renderReadout(); refreshResults(true);
  });
}
