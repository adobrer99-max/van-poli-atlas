/* --- What is loaded, and what it is safe to say about it --------------------

   Two audiences read this file and they are not the same person. Whoever
   prepared the build ran downloads from four agencies and a command line;
   whoever opens it wants to know what is in front of them and whether they can
   quote it. So the inventory is computed once, here, and rendered in two
   places: as a readiness checklist on the Data tab, and as the briefing the
   atlas opens on.

   Nothing in here measures anything. It reports what the other tabs have
   already computed, and where a figure is modelled rather than counted it says
   so beside the figure rather than three tabs away. */

/* One row per dataset the atlas can carry. `ready` is the checklist's state;
   `detail` is what it amounts to, in the units a reader thinks in. */
function datasetInventory() {
  const n = (v) => (v == null ? 0 : v);
  const rows = [];
  const add = (name, ready, detail, source) => rows.push({ name, ready, detail, source });

  add('Federal polling divisions (2025)', state.fed.all.length > 0,
    `${fmtInt(state.fed.active.length)} in the study area, ${fmtInt(state.fed.all.length)} in the file`,
    'Elections Canada');
  add('Federal results (2025)', Boolean(state.fedResults?.values?.size),
    state.fedResults?.values?.size
      ? `${fmtInt(state.fedResults.values.size)} divisions with votes`
      : 'not loaded',
    'Elections Canada');
  add('Provincial voting areas (2024)', state.prov.all.length > 0,
    state.prov.all.length
      ? `${fmtInt(state.prov.active.length)} in the study area`
      : 'not loaded',
    'Elections BC');
  add('Provincial results (2024)', Boolean(state.provResults?.values?.size),
    state.provResults?.values?.size
      ? `${fmtInt(state.provResults.values.size)} areas with votes`
        + (state.provResults.kind === 'places' ? ', reported by voting place' : '')
      : 'not loaded',
    'Elections BC');
  add('Municipal results (2022)', Boolean(state.muni),
    state.muni ? `${state.muni.race}, ${fmtInt(n(state.muni.ballots))} ballots` : 'not loaded',
    'City of Vancouver');
  add('Census geography (2021)', state.da.all.length > 0,
    state.da.all.length
      ? `${fmtInt(state.da.active.length)} dissemination areas`
        + (state.db.all.length ? `, ${fmtInt(state.db.active.length)} blocks` : '')
      : 'not loaded',
    'Statistics Canada');
  add('Census profile (2021)', state.da.variables.length > 0,
    state.da.variables.length
      ? `${fmtInt(state.da.variables.length)} characteristics joined`
      : 'not loaded',
    'Statistics Canada');
  /* Derived rather than loaded, and the one row a reader can act on: without
     it Compare, Turnout and Neighbourhood profile have nothing to say, and
     nothing on those tabs explains that it is one button away. */
  add('Crosswalk between the geographies', Boolean(state.sample),
    state.sample
      ? `built over ${fmtInt(state.sample.ids.length)} layers`
        + (state.weightingShort ? `, weighted by ${state.weightingShort}` : '')
      : 'not built yet',
    'computed here');
  if (state.points) {
    add('A file of places', true,
      `${fmtInt(n(state.points.report?.read))} of ${fmtInt(n(state.points.report?.rows))} `
      + `${state.points.noun || 'rows'} placed`,
      'loaded in this tab, never saved');
  }
  return rows;
}

/* The crosswalk is the only checklist row a reader can do something about, so
   the checklist offers the button rather than sending them to another tab to
   look for it. */
function canBuildCrosswalk() {
  return !state.sample && state.fed.active.length > 0
    && ['prov', 'da', 'db'].some((id) => state[id].active.length > 0);
}

function renderReadiness(host) {
  if (!host) return;
  host.textContent = '';
  for (const row of datasetInventory()) {
    const li = el('li', row.ready ? 'is-ready' : 'is-missing');
    li.append(
      el('span', 'mark', row.ready ? '✓' : '·'),
      el('span', 'readiness-name', row.name),
      el('span', 'readiness-detail text-small text-muted', row.detail));
    if (row.source) li.querySelector('.readiness-name').title = `Source: ${row.source}`;
    host.append(li);
  }
}

function refreshReadiness() {
  const host = $('readiness-list');
  if (!host) return;
  renderReadiness(host);
  const rows = datasetInventory();
  const ready = rows.filter((r) => r.ready).length;
  const note = $('data-ready-note');
  if (note) {
    note.textContent = `${ready} of ${rows.length} ready. `
      + (bakedIn()
        ? 'Everything ticked is built into this file and loads when you open it — '
          + 'nothing is fetched and nothing leaves your machine. '
        : 'Nothing is built into this file, so each dataset is loaded below. ')
      + 'Loading your own copy of anything replaces what is here.';
  }
  const build = $('readiness-build');
  if (build) {
    build.hidden = !canBuildCrosswalk();
    build.disabled = !canBuildCrosswalk();
  }
}

/* Whether this build carries its data with it, which is what separates the
   copy handed to a reader from the one used to prepare it. */
function bakedIn() {
  return document.querySelector('script[data-payload]') != null;
}

/* --- The briefing ----------------------------------------------------------

   What a senior reader should get from opening the file: what is in it, what it
   says, and what governs quoting any of it. Every figure here is computed by
   another tab and read back -- nothing is measured twice, so nothing can
   disagree with the tab it came from -- and every figure carries how it was
   arrived at, because a headline is exactly where a modelled number gets
   quoted as a counted one. */

const fmtPts = (v) => (v == null || !isFinite(v) ? '--' : `${(v * 100).toFixed(1)} pts`);

/* Counted: the agency reported this number for this area. Modelled: it was
   moved onto a geography its source does not use. Smoothed: municipal ballots,
   which are spread by distance because you may vote anywhere in the city. */
const PROVENANCE = {
  counted: ['Counted', 'Reported for these areas by the agency that ran the election.'],
  modelled: ['Modelled geography', 'Moved between geographies that share no boundaries; read '
    + '“How to read this” before quoting it.'],
  smoothed: ['Smoothed, not assigned', 'Municipal ballots are spread by distance because you '
    + 'may vote at any place in the city.'],
};

function headlineFindings() {
  const out = [];
  const push = (headline, figure, detail, badge) => out.push({ headline, figure, detail, badge });

  const rows = (state.turnout.rows || []).filter((r) => r.agg != null);
  if (rows.length) {
    const electors = rows.reduce((a, r) => a + r.electors, 0);
    const expected = rows.reduce((a, r) => a + (r.expected || 0), 0);
    push('Aggregate turnout across the ranked areas',
      fmtPct(electors > 0 ? expected / electors : null),
      `${fmtInt(rows.length)} ${UNIT_NAMES[state.turnout.unit]}, ${fmtInt(electors)} electors`,
      state.pairs ? 'modelled' : 'counted');

    /* The question this atlas was built to answer: where turnout is highest,
       and by how much it beats the quietest areas. A decile each end, because
       single areas are small enough to be noise. */
    const sorted = rows.slice().sort((a, b) => b.agg - a.agg);
    const decile = Math.max(1, Math.round(rows.length / 10));
    const mean = (v) => v.reduce((a, r) => a + r.agg, 0) / v.length;
    push('Busiest tenth of areas over the quietest tenth',
      fmtPts(mean(sorted.slice(0, decile)) - mean(sorted.slice(-decile))),
      `${fmtPct(mean(sorted.slice(0, decile)))} against ${fmtPct(mean(sorted.slice(-decile)))}, `
      + `${fmtInt(decile)} areas each end`,
      state.pairs ? 'modelled' : 'counted');
    push('Highest aggregate turnout', sorted[0] ? fmtPct(sorted[0].agg) : '--',
      sorted.slice(0, 3).map((r) => r.label).filter(Boolean).join(' · '),
      state.pairs ? 'modelled' : 'counted');
  }

  const c = state.lastCorrelation;
  if (c && c.result && c.result.r != null) {
    /* A negative r headlined "track each other" says the opposite of the
       number underneath it. */
    push(`${c.fedParty} and ${c.provParty} `
      + (c.result.r < 0 ? 'move against each other' : 'track each other'), fmtNum(c.result.r, 2),
      `Pearson r across ${fmtInt(c.result.nEffective ?? c.result.n ?? (c.rows || []).length)} `
      + 'independent sources',
      'modelled');
  }

  const table = (state.socio.table || []).filter((t) => t.r != null);
  if (table.length) {
    const best = table.slice().sort((a, b) => Math.abs(b.r) - Math.abs(a.r))[0];
    const outcome = socioOutcome(state.socio.outcome).label.toLowerCase();
    push(`Strongest census association with ${outcome}`, fmtNum(best.r, 2),
      `${best.label} — ${outcome} ${best.r < 0 ? 'falls' : 'rises'} as it rises, `
      + `across ${fmtInt(best.nEffective ?? best.n)} independent sources`,
      'modelled');
  }

  if (state.muni) {
    push(`Municipal ${state.muni.race.toLowerCase()} (2022)`, fmtInt(state.muni.ballots),
      'ballots cast citywide; party share is mapped, turnout by area is not',
      'smoothed');
  }
  return out;
}

const CAVEATS = [
  ['The three geographies share no boundaries.',
   'Federal polling divisions, provincial voting areas and census areas are drawn by different '
   + 'agencies. Results are moved between them by a measured overlap, so any figure sitting on a '
   + 'geography its source does not use is an estimate, not a count.'],
  ['A correlation here is about neighbourhoods, not people.',
   'It says areas with more of something had more of something else. It does not say the people '
   + 'with the first did the second, and the difference is not a technicality.'],
  ['Spreading one measurement over five areas does not make five observations.',
   'The 2024 provincial results are reported by voting place and shared out over the areas each '
   + 'one served, so every r reports the number of independent sources beside the number of areas '
   + 'and widens its confidence interval to match.'],
  ['There is no municipal turnout by area, anywhere in this atlas.',
   'You may vote at any place in Vancouver and in 2022 most people did, so ballots are smoothed by '
   + 'distance rather than assigned. Measured against the federal turnout surface any municipal '
   + 'turnout map agrees at about r 0.2 however it is built. Party share survives that; turnout '
   + 'does not, so it is not offered.'],
];

function refreshOverview() {
  const host = $('overview-findings');
  if (!host) return;
  renderReadiness($('overview-readiness'));

  const scope = $('overview-scope');
  const bits = [`${fmtInt(state.fed.active.length)} federal polling divisions`];
  if (state.prov.active.length) bits.push(`${fmtInt(state.prov.active.length)} provincial voting areas`);
  if (state.da.active.length) bits.push(`${fmtInt(state.da.active.length)} dissemination areas`);
  scope.textContent = `${$('area-filter').selectedOptions[0].textContent.trim()} — ${bits.join(', ')}. `
    + 'UBC and the University Endowment Lands sit in Electoral Area A, outside the city, and are '
    + 'left out unless Area is widened on the Map tab.';

  host.textContent = '';
  const findings = headlineFindings();
  if (!findings.length) {
    const p = el('p', 'text-small');
    p.textContent = canBuildCrosswalk()
      ? 'Nothing is computed yet. The crosswalk between the geographies has not been built — '
        + 'it takes a few seconds and is the button on the Data tab.'
      : 'Nothing is computed yet. Load results and a second geography on the Data tab, then build '
        + 'the crosswalk.';
    host.append(p);
    return;
  }
  const grid = el('div', 'findings');
  for (const f of findings) {
    const card = el('div', 'finding');
    const [badgeLabel, badgeWhy] = PROVENANCE[f.badge] || PROVENANCE.modelled;
    const badge = el('span', `badge badge-${f.badge}`, badgeLabel);
    badge.title = badgeWhy;
    card.append(
      el('div', 'finding-figure', f.figure),
      el('div', 'finding-headline', f.headline),
      el('div', 'finding-detail text-small text-muted', f.detail),
      badge);
    grid.append(card);
  }
  host.append(grid);
}

function renderCaveats() {
  const host = $('overview-caveats');
  if (!host) return;
  host.textContent = '';
  for (const [head, body] of CAVEATS) {
    const li = el('li');
    li.append(el('strong', null, head), document.createTextNode(' '), el('span', 'text-muted', body));
    host.append(li);
  }
}

/* --- Provenance --------------------------------------------------------------

   A build with data baked in redistributes that data to whoever it is handed
   to. Every licence involved permits that with attribution, so the attribution
   travels in the file rather than in a covering email nobody keeps. */

const SOURCES = [
  ['Elections Canada', '2025 polling-division boundaries and poll-by-poll results',
   'Open Government Licence – Canada', 'https://open.canada.ca/en/open-government-licence-canada'],
  ['Elections BC', '2024 voting areas and results by voting place',
   'Elections BC Open Data Licence', 'https://www.elections.bc.ca/docs/EBC-Open-Data-Licence.pdf'],
  ['City of Vancouver', '2022 municipal election results and voting places',
   'Open Government Licence – Vancouver', 'https://opendata.vancouver.ca/pages/licence/'],
  ['Statistics Canada', '2021 Census Profile, dissemination geography and the Geographic Attribute File',
   'Statistics Canada Open Licence', 'https://www.statcan.gc.ca/en/reference/licence'],
  ['OpenStreetMap contributors, CARTO', 'street basemap tiles, fetched at runtime and optional',
   'ODbL', 'https://www.openstreetmap.org/copyright'],
];

function renderSources() {
  const host = $('overview-sources');
  if (!host) return;
  host.textContent = '';
  for (const [who, what, licence, href] of SOURCES) {
    const li = el('li');
    const a = el('a', null, licence);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    li.append(el('strong', null, who), document.createTextNode(` — ${what}. `), a, document.createTextNode('.'));
    host.append(li);
  }
  const note = $('overview-sources-note');
  if (note) {
    note.textContent = bakedIn()
      ? 'This copy carries those datasets inside it, so passing the file on passes them on too. '
        + 'Every licence above allows that with attribution, which is what this list is. The '
        + 'Elections BC one to read before a copy goes outside the organisation that '
        + 'prepared it.'
      : 'This copy carries no agency data — each dataset is loaded from the Data tab and stays on '
        + 'this machine. A build made with a payload does carry them, and then this list is the '
        + 'attribution that travels with it.';
  }
}

/* Which copy is this. The dirty flag is the one that matters at handoff: a
   build made from a working tree with uncommitted changes matches no commit,
   so it says so instead of showing an id that does not describe it. */
function renderStamp() {
  const host = $('overview-stamp');
  if (!host) return;
  const node = document.getElementById('build-stamp');
  let stamp = null;
  try { stamp = node ? JSON.parse(node.textContent) : null; } catch (err) { stamp = null; }
  host.textContent = '';
  if (!stamp) { host.hidden = true; return; }
  host.hidden = false;
  const bits = [`Built ${stamp.built}`];
  if (stamp.commit) bits.push(`commit ${stamp.commit}`);
  bits.push(bakedIn() ? 'data baked in' : 'no data baked in');
  host.append(el('span', null, bits.join(' · ')));
  if (stamp.dirty) {
    host.append(el('span', 'badge badge-dirty',
      'built from uncommitted changes — not reproducible from that commit'));
  }
}
