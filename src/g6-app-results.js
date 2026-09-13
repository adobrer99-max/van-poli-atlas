/* --- Results tab -------------------------------------------------------------
   What the loaded files say, before anything is moved, spread or modelled.
   The maths is in f5-summary.js; this file picks the side, draws the tiles,
   the party bars, the district table, the channel breakdown and the busiest
   units, and exports the lot. */

/* Cached per side, because a summary is a full pass over the table and the
   tab is re-rendered on every results change. Cleared by refreshResults. */
let summaryCache = { fed: null, prov: null };

function summaryFor(side) {
  if (summaryCache[side]) return summaryCache[side];
  const store = side === 'fed' ? state.fedResults : state.provResults;
  if (!store) return null;
  let summary = null;
  /* The supplied denominator is a provincial file; the federal results carry
     their own elector counts per poll. */
  const electors = side === 'prov' ? state.provElectors : null;
  if (store.kind === 'places' && store.read) {
    summary = Summary.fromPlaces(store.read, { electors });
  } else if (store.table && store.mapping) {
    const keyOpts = store.keyOpts || { ignoreLeadingZeros: true, ignoreCase: true };
    const agg = Results.aggregate(store.table, store.mapping, keyOpts);
    summary = Summary.fromUnits(agg.units, {
      unitName: side === 'fed' ? 'polling divisions' : 'voting areas',
      districtName: side === 'fed' ? (code) => federalDistrictName(code) : null,
      electors,
    });
  }
  summaryCache[side] = summary;
  return summary;
}

/* Elections Canada numbers its districts; the boundary layer knows the names,
   so a summary of a results file can borrow them. */
function federalDistrictName(code) {
  const f = state.fed.all.find((x) => String(x.fedNum) === String(code));
  return f ? f.fedName : null;
}

const SIDE_LABEL = { fed: 'Federal (2025)', prov: 'Provincial (2024)' };

function resultsSidesAvailable() {
  return ['fed', 'prov'].filter((s) => (s === 'fed' ? state.fedResults : state.provResults));
}

function resultsSide() {
  const available = resultsSidesAvailable();
  const wanted = $('results-side') ? $('results-side').value : '';
  return available.includes(wanted) ? wanted : available[0] || null;
}

function refreshResults(invalidate) {
  if (!$('results-status')) return;
  if (invalidate) summaryCache = { fed: null, prov: null };
  const available = resultsSidesAvailable();
  const sel = $('results-side');
  const previous = sel.value;
  fillSelect(sel, available.map((s) => ({ value: s, label: SIDE_LABEL[s] })),
    available.includes(previous) ? previous : (available[0] || ''));
  sel.disabled = available.length < 2;
  $('results-side-wrap').hidden = available.length === 0;

  const side = resultsSide();
  const summary = side ? summaryFor(side) : null;
  const body = $('results-body');
  if (!summary || !summary.ballots) {
    setStatus('results-status', 'idle', [
      'Load federal or provincial results on the Data tab; this tab reports what is in them, '
      + 'before any of it is moved onto another geography.']);
    body.hidden = true;
    return;
  }
  body.hidden = false;
  renderResultsStats(side, summary);
  renderResultsParties(summary);
  renderResultsDistricts(summary);
  renderResultsChannels(summary);
  renderResultsLargest(side, summary);

  const units = summary.districts.reduce((a, d) => a + d.units, 0);
  const where = summary.kind === 'places'
    ? `${fmtInt(units)} reported rows across ${fmtInt(summary.located.places)} voting places`
    : `${fmtInt(units)} ${summary.unitName}`;
  const lines = [`${fmtInt(summary.ballots)} ballots across ${fmtInt(summary.districts.length)} `
    + `electoral districts, from ${where}. Counts as reported, with nothing moved or estimated.`];
  if (summary.turnout == null) {
    lines.push(el('p', 'text-small text-muted',
      'This file carries no registered-voter count, so there is no turnout to report here. '
      + 'Elections BC publishes one per district in the Statement of Votes; load it in '
      + 'section 3 of the Data tab.'));
  } else if (summary.electorsFrom === 'supplied') {
    lines.push(el('p', 'text-small text-muted',
      `Turnout is ballots over registered voters, the denominator taken from the file you `
      + `loaded${summary.electorsComplete ? '' : ` — only ${fmtInt(summary.districtsWithElectors)} `
        + `of ${fmtInt(summary.districts.length)} districts have one, so the city figure covers `
        + 'those alone'}.`));
  }
  if (summary.located) {
    lines.push(el('p', 'text-small text-muted',
      `${fmtPct(summary.located.share)} of ballots were cast somewhere with a location `
      + `(${fmtInt(summary.located.places)} voting places); the rest have none and can only be `
      + 'spread across a district. See the Method tab.'));
  }
  setStatus('results-status', 'ok', lines);
}

function renderResultsStats(side, s) {
  const host = $('results-stats');
  host.textContent = '';
  const stat = (label, value, note) => {
    const box = el('div', 'viz-stat');
    box.append(el('div', 'viz-stat-value', value), el('div', 'text-small text-muted', label));
    if (note) box.append(el('div', 'text-small text-muted', note));
    return box;
  };
  host.append(
    stat('ballots', fmtInt(s.ballots), `${fmtInt(s.valid)} valid`),
    stat('rejected', fmtInt(s.rejected), s.rejectedShare != null ? fmtPct(s.rejectedShare, 2) + ' of ballots' : null),
    stat('leading party', s.winner ? s.winner.name : '--',
      s.winner ? `${fmtPct(s.winner.share)} of the valid vote` : null),
    s.turnout != null
      ? stat('turnout', fmtPct(s.turnout), `${fmtInt(s.electors)} registered`)
      : stat('districts', fmtInt(s.districts.length),
        [...s.districtsWon].map(([p, n]) => `${p} ${n}`).join(' · ') || null),
  );
}

/* A bar per party, width by share, coloured the way the map colours it. */
function renderResultsParties(s) {
  const host = $('results-parties');
  host.textContent = '';
  const top = s.parties[0]?.share || 1;
  for (const p of s.parties) {
    const row = el('div', 'party-row');
    row.append(el('span', 'party-name', p.name));
    const track = el('span', 'party-track');
    const fill = el('span', 'party-fill');
    fill.style.width = `${Math.max(0.5, (p.share / top) * 100)}%`;
    fill.style.background = partyColour(p.name);
    track.append(fill);
    row.append(track, el('span', 'party-value', `${fmtInt(p.votes)}  ${fmtPct(p.share)}`));
    host.append(row);
  }
}

const DISTRICT_COLUMNS = [
  { key: 'name', label: 'District', get: (d) => d.name, fmt: (v) => v, left: true },
  { key: 'ballots', label: 'Ballots', get: (d) => d.ballots, fmt: fmtInt },
  { key: 'turnout', label: 'Turnout', get: (d) => d.turnout, fmt: (v) => fmtPct(v) },
  { key: 'winner', label: 'Leading', get: (d) => d.winner?.name ?? null, fmt: (v) => v, left: true },
  { key: 'margin', label: 'Margin', get: (d) => d.margin, fmt: (v) => fmtPct(v, 1) },
  { key: 'units', label: 'Units', get: (d) => d.units, fmt: fmtInt },
];

function sortedDistricts(s) {
  const { sortKey, sortDir } = state.results;
  const col = DISTRICT_COLUMNS.find((c) => c.key === sortKey) || DISTRICT_COLUMNS[1];
  const dir = sortDir === 'asc' ? 1 : -1;
  return [...s.districts].sort((a, b) => {
    const x = col.get(a), y = col.get(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir;
  });
}

function renderResultsDistricts(s) {
  const table = $('results-districts');
  table.textContent = '';
  /* A file with no elector count would otherwise show a column of dashes. */
  const columns = DISTRICT_COLUMNS.filter((c) =>
    c.key !== 'turnout' || s.districts.some((d) => d.turnout != null));
  const thead = el('thead'), hr = el('tr');
  for (const c of columns) {
    const th = el('th', c.left ? 'text-start' : null, c.label);
    if (c.key === state.results.sortKey) th.classList.add('sorted', state.results.sortDir);
    th.dataset.key = c.key;
    th.addEventListener('click', () => {
      const r = state.results;
      if (r.sortKey === c.key) r.sortDir = r.sortDir === 'desc' ? 'asc' : 'desc';
      else { r.sortKey = c.key; r.sortDir = c.key === 'name' || c.key === 'winner' ? 'asc' : 'desc'; }
      refreshResults();
    });
    hr.append(th);
  }
  thead.append(hr);
  const tbody = el('tbody');
  for (const d of sortedDistricts(s)) {
    const tr = el('tr');
    for (const c of columns) {
      const v = c.get(d);
      const td = el('td', c.left ? 'text-start' : null, v == null ? '--' : c.fmt(v));
      if (c.key === 'winner' && d.winner) td.style.color = partyColour(d.winner.name);
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
}

/* Only a voting-place file knows how a ballot was cast. Where the breakdown
   exists it is the most useful thing on the tab, because it says how much of
   the count can be placed on a map at all. */
function renderResultsChannels(s) {
  const card = $('results-channels-card');
  if (!s.channels) { card.hidden = true; return; }
  card.hidden = false;
  const host = $('results-channels');
  host.textContent = '';
  const top = s.channels[0]?.ballots || 1;
  for (const c of s.channels) {
    const row = el('div', 'party-row');
    row.append(el('span', 'party-name', c.name));
    const track = el('span', 'party-track');
    const fill = el('span', 'party-fill');
    fill.style.width = `${Math.max(0.5, (c.ballots / top) * 100)}%`;
    fill.style.background = 'var(--viz-series-1)';
    track.append(fill);
    row.append(track, el('span', 'party-value', `${fmtInt(c.ballots)}  ${fmtPct(c.share)}`));
    host.append(row);
  }
}

function renderResultsLargest(side, s) {
  const host = $('results-largest');
  host.textContent = '';
  $('results-largest-title').textContent = s.kind === 'places'
    ? 'Busiest voting places' : `Largest ${s.unitName}`;
  const list = el('ol', 'ranked-list');
  for (const u of s.largest) {
    const li = el('li');
    li.append(el('span', 'ranked-name', u.name || u.label));
    const detail = s.kind === 'places'
      ? `${u.district} · ${u.opportunity}`
      : (u.turnout != null ? `turnout ${fmtPct(u.turnout)}` : u.district || '');
    li.append(el('span', 'text-small text-muted', detail),
      el('span', 'ranked-value', `${fmtInt(u.ballots)} ballots`));
    list.append(li);
  }
  host.append(list);
}

/* --- Wiring ---------------------------------------------------------------- */

$('results-side').addEventListener('change', () => refreshResults());
$('export-results').addEventListener('click', () => {
  const side = resultsSide();
  const summary = side ? summaryFor(side) : null;
  if (!summary) { $('results-note').textContent = 'Nothing to export yet.'; return; }
  const name = `vancouver-${side === 'fed' ? 'federal-2025' : 'provincial-2024'}-summary.csv`;
  const rows = Summary.toCsv(summary, SIDE_LABEL[side]);
  downloadCsv(name, rows);
  $('results-note').textContent = `Saved ${name} (${fmtInt(rows.length - 1)} rows).`;
});
