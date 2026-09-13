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
