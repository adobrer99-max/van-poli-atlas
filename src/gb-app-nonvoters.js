/* --- Non-voters tab ----------------------------------------------------------

   Electors on a roll, minus ballots cast, area by area. The maths is in
   f8-roll.js; this file is wiring and words, and the words are most of it.

   NOT AN EXTENSION OF TURNOUT, on purpose. That tab's contract is one
   election's ballots over that election's own electors, and every figure here
   is cross-source by construction -- a roll drawn for one election against
   ballots cast in another. Its ranks follow the aggregate turnout too, and the
   ranking that matters here is by the number who did not vote. Two rank
   semantics on one table is how a wrong number gets screenshotted.

   The rows are the same objects, though: rowsOnUnit builds them, Turnout.score
   fills t/agg/expected, and Roll.gap hangs row.g beside them without touching
   anything it finds there. Nothing is recomputed -- only the table, the words
   and the export are new. */

const NV_UNIT_NAMES = { fed: 'federal (2025) polling divisions',
                        prov: 'provincial (2024) voting areas' };
const NV_UNIT_ONE = { fed: 'polling division', prov: 'voting area' };

/* The feature id a layer keys its counts by, for a row of rowsOnUnit's. Going
   through turnoutFeature rather than state[unit].active is deliberate: once a
   crosswalk exists the row key is a crosswalk-local index, not an index into
   the active features, and the two are not the same list. */
function nvFeature(unit, row) {
  return turnoutFeature(unit, +row.key);
}
function nvFeatureId(unit, row) {
  const f = nvFeature(unit, row);
  if (!f) return null;
  return unit === 'fed' ? f.idx : f.__idx;
}

/* --- Where each half comes from --------------------------------------------

   Both are the caller's business rather than f8's, which knows nothing about
   how a layer indexes its features. Each returns a number or null, and null
   means ABSENT -- an area the roll never reached is not an area with no
   electors on it. That distinction is what lets the UBC and UEL divisions come
   out with no entry rather than with a gap the size of their whole electorate:
   those electors are on Vancouver's roll for the school trustee ballot, and
   the city's property file does not address land outside the city. */

/* Every elector count that resolves for at least one area, with the label the
   picker shows. Availability is measured rather than assumed: a source is
   offered when it actually produces a number here, so a picker never offers a
   denominator that would blank the tab.

   ORDER IS THE DEFAULT. A loaded roll comes first, ahead of the elector counts
   that ride along with a results file, because a reader who has gone to the
   trouble of loading one wants this tab to be about it. The picker falls to
   the first entry whenever the reader has not chosen, so this order is what
   the tab settles on by itself. */
function nvRollSources(rows, unit) {
  const out = [];
  const p = state.points;
  if (p && p.per && p.per[unit]) {
    /* A roll is one row per elector, so counting rows counts people. A file
       already aggregated to one row per address carries the people in a column
       instead, and the reader named that column on the Data tab -- so where one
       was chosen it is the elector count, and the row count would be a count of
       doors. Both are named by whichever noun applies. */
    const weighted = Boolean(p.weighted);
    const noun = (weighted ? p.weightNoun : p.noun) || p.noun || 'rows';
    out.push({
      id: 'muni',
      /* Named by what the reader called the file, never by what this atlas was
         built expecting. ROLL_SOURCES.muni reads "2026 municipal roll", which
         is right for the electors list this exists for and false about any
         other file dropped in the same slot. */
      label: `The loaded file of places (${noun})`,
      rollLabel: /elector/i.test(noun) ? 'roll of electors' : `loaded file of ${noun}`,
      rollVintage: '',
      /* A file of points is counted onto every layer by point-in-polygon, with
         no interpolation anywhere -- the one elector count in this atlas that
         is a genuine count on geographies it was never published for. Whether
         its rows arrived as coordinates or were looked up from addresses does
         not change that; where the lookup had to estimate a door, the prose
         below says how often. */
      viaAddresses: true,
      of: (row) => {
        const id = nvFeatureId(unit, row);
        if (id == null) return null;
        const a = p.per[unit].get(id);
        return a ? (weighted ? a.weight : a.count) : null;
      },
    });
  }
  for (const side of ['fed', 'prov']) {
    const of = (row) => {
      const u = row.by[side];
      return u && u.electors > 0 ? u.electors : null;
    };
    if (!rows.some((r) => of(r) != null)) continue;
    const meta = Roll.ROLL_SOURCES[side];
    out.push({ id: side, label: `${meta.vintage} ${meta.label}`, viaAddresses: false, of });
  }
  return out;
}

function nvBallotSources(rows, unit) {
  const out = [];
  for (const side of ['fed', 'prov']) {
    const of = (row) => (row.ballots && row.ballots[side] != null ? row.ballots[side] : null);
    if (!rows.some((r) => of(r) != null)) continue;
    const meta = Roll.BALLOT_SOURCES[side];
    out.push({ id: side, label: `${meta.vintage} ${meta.label}`, of,
               unitOf: (row) => row.by[side] || null });
  }
  const on = state.muni && state.muni.on && state.muni.on[unit];
  if (on && on.size) {
    out.push({
      id: 'muni', label: '2022 municipal ballots (smoothed)',
      of: (row) => {
        const id = nvFeatureId(unit, row);
        const u = id == null ? null : on.get(id);
        return u ? u.ballots : null;
      },
      unitOf: (row) => {
        const id = nvFeatureId(unit, row);
        return id == null ? null : (on.get(id) || null);
      },
    });
  }
  return out;
}

/* Areas where the municipal smoothing hit its ceiling.

   muniTargets caps each area's modelled ballots at its own federal electorate,
   so a municipal-paired gap cannot go negative however the world behaves: a
   zero there is arithmetic, not a finding. The smoother reports how many areas
   were bound but not which, so the ceiling is recognised here instead -- an
   area sitting at its cap took every ballot the model was allowed to give it.

   Do not be tempted to cap the municipal model at the municipal roll once one
   is loaded. It looks like an improvement and it would floor every municipal
   gap at zero, which destroys the one diagnostic this tab produces. */
function nvCappedAreas(unit) {
  const on = state.muni && state.muni.on && state.muni.on[unit];
  if (!on) return null;
  const values = unit === 'fed' ? fedValues() : provValues();
  if (!values) return null;
  const ids = new Set();
  for (const [id, u] of on) {
    const cap = values.get(id)?.electors || 0;
    if (cap > 0 && u.ballots >= cap * 0.999) ids.add(String(id));
  }
  return ids.size ? ids : null;
}

/* Parties on whichever ballots are being subtracted, so the mail rank is built
   from a share of the same election the ballots came from. */
function nvParties(rows, ballotSource) {
  if (!ballotSource || !ballotSource.unitOf) return [];
  const seen = new Set();
  for (const row of rows) {
    const u = ballotSource.unitOf(row);
    if (u && u.parties) for (const name of u.parties.keys()) seen.add(name);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/* --- The tab ---------------------------------------------------------------- */

/* Refills a picker from what is actually available, keeping the reader's
   choice where it survives and falling to the first option where it does not.
   Returns the selection in force. */
function nvSyncSelect(id, sources, current) {
  const node = $(id);
  if (!node) return current;
  const keep = sources.some((s) => s.id === current) ? current : (sources[0] ? sources[0].id : '');
  fillSelect(node, sources.map((s) => ({ value: s.id, label: s.label })), keep);
  node.disabled = sources.length === 0;
  return keep;
}

function refreshNonvoters() {
  const statusHost = $('nv-status');
  if (!statusHost) return;
  const nv = state.nonvoters;
  nv.unit = $('nv-unit').value;
  nv.minRoll = parseFloat($('nv-min').value) || 0;
  nv.weight = parseFloat($('nv-weight').value) || 1;

  const hide = (...ids) => { for (const id of ids) if ($(id)) $(id).hidden = true; };
  const clear = (message) => {
    nv.rows = null; nv.on = {}; nv.below = {}; nv.pairing = null;
    hide('nv-results', 'nv-priority', 'nv-basket-card', 'nv-badge');
    $('nv-stats').textContent = '';
    setStatus('nv-status', 'idle', [message]);
    restyleForNonvoters();
  };

  const sources = turnoutSources();
  if (!sources.length) {
    clear('Load federal or provincial results on the Data tab, then a roll under “A file of '
      + 'places”. This tab subtracts one from the other.');
    return;
  }
  const labels = {
    fed: (i) => turnoutFeature('fed', i)?.label ?? `poll ${i}`,
    prov: (i) => provLabel(turnoutFeature('prov', i)),
  };
  /* minElectors stays 0 here on purpose. rowsOnUnit's own minimum reads
     row.electors -- "the first source with a non-zero count", which on a
     provincial row is the FEDERAL electorate -- and the control above this
     table says "electors", meaning the ones on the roll the reader picked.
     Filtering on the roll count below is the only reading of it that matches
     what the label promises. */
  const all = Turnout.rowsOnUnit(nv.unit, sources, labels, { minElectors: 0 });
  Turnout.score(all, { weights: { fed: 0.5, prov: 0.5 } });

  const rollSources = nvRollSources(all, nv.unit);
  const ballotSources = nvBallotSources(all, nv.unit);
  /* What was asked for decides; what is merely in force does not.

     rollWanted is null until the reader touches the picker, and null lets the
     preference order in nvRollSources decide afresh on every refresh. Reading
     the control instead would be wrong in both directions: nvSyncSelect
     refills it, so an untouched picker hands back its own fallback as though
     it were a choice, and a choice whose source has gone away is overwritten
     there and cannot come back when the source does.

     That first direction is the whole bug this fixes. A payload build loads
     its datasets in sequence, so this tab ran before a roll had been read and
     settled on the only elector count that existed at that moment; keeping
     that pinned the tab to federal electors minus federal ballots with a roll
     of half a million people loaded and ignored. Nothing looked wrong -- the
     figures were real counts, correctly labelled, answering a question nobody
     had asked. */
  nv.roll = nvSyncSelect('nv-roll', rollSources, nv.rollWanted);
  nv.ballots = nvSyncSelect('nv-ballots', ballotSources, nv.ballotsWanted);
  const roll = rollSources.find((s) => s.id === nv.roll);
  const ballots = ballotSources.find((s) => s.id === nv.ballots);
  if (!roll || !ballots) {
    clear(rollSources.length
      ? 'No ballots are loaded for this area type yet — see the Data tab.'
      : 'No elector count reaches these areas yet. Load a roll under “A file of places” on the '
        + 'Data tab, or federal results, which carry an elector count of their own.');
    return;
  }

  Roll.gap(all, {
    roll: roll.id, ballots: ballots.id, target: nv.unit,
    rollOf: roll.of, ballotsOf: ballots.of,
    rollViaAddresses: roll.viaAddresses,
    rollLabel: roll.rollLabel, rollVintage: roll.rollVintage,
    cappedIds: nvCappedAreas(nv.unit), idOf: (row) => String(nvFeatureId(nv.unit, row)),
  });

  const noRoll = all.filter((r) => !r.g).length;
  const small = all.filter((r) => r.g && r.g.roll.count < nv.minRoll);
  const tooSmall = small.length;
  const rows = all.filter((r) => r.g && r.g.roll.count >= nv.minRoll);
  /* Held for the readout alone: an area under the minimum is out of the table
     and out of the ranking, and it is still not an area the roll never
     reached. The map does not shade it either way. */
  nv.below = { [nv.unit]: new Map(small.map((r) => [nvFeatureId(nv.unit, r), r.g.roll.count])) };
  if (!rows.length) {
    /* Two different failures, and the minimum is only one of them. Reporting
       "no area carries at least 0" would send a reader to a control that is
       already as low as it goes. */
    clear(nv.minRoll > 0
      ? `No area carries at least ${fmtInt(nv.minRoll)} on the ${roll.label.toLowerCase()}. `
        + 'Lower the minimum, or check that the roll joined — the Data tab reports its match rate.'
      : `Nothing on the ${roll.label.toLowerCase()} reached any of these ${fmtInt(all.length)} `
        + 'areas. The Data tab reports the roll\u2019s match rate, which is where to look first.');
    return;
  }

  /* The share the rank leans on, from the same election the ballots came from.
     Refilled every refresh, since switching the ballots side changes which
     parties there are to pick from. */
  const parties = nvParties(rows, ballots);
  const partyNode = $('nv-party');
  if (parties.length) {
    const chosen = partyNode.value || nv.party;
    const keep = parties.includes(chosen) ? chosen : parties[0];
    fillSelect(partyNode, parties.map((name) => ({ value: name, label: name })), keep);
    nv.party = keep;
    Roll.mailScore(rows, {
      shareOf: (row) => {
        const u = ballots.unitOf ? ballots.unitOf(row) : null;
        return u ? Analysis.shareOf(u, nv.party) : null;
      },
      weight: nv.weight,
      basis: `${nv.party} share, ${ballots.label}`,
    });
  } else {
    nv.party = '';
    for (const row of rows) delete row.m;
  }
  $('nv-priority').hidden = parties.length === 0;

  const pairing = rows[0].g;
  nv.pairing = { label: pairing.label, route: pairing.route,
                 rollRoute: pairing.roll.route, ballotRoute: pairing.ballots.route,
                 rollLabel: pairing.roll.label, ballotLabel: pairing.ballots.label,
                 coherent: pairing.coherent,
                 /* Counted by point-in-polygon, or counted by the agency. Both
                    are counts and they are not the same claim. */
                 viaAddresses: Boolean(roll.viaAddresses) };
  rows.forEach((r) => { r.basketKey = nvBasketKey(nv.unit, r); });
  nv.rows = sortNonvoterRows(rows);
  nv.on = { [nv.unit]: new Map(rows.map((r) => [nvFeatureId(nv.unit, r), {
    notVoted: r.g.notVoted, share: r.g.notVotedShare,
    mailRank: r.m ? r.m.rank : null, label: r.label,
  }])) };

  const s = Roll.summary(rows);
  renderNonvoterStats(s, roll, ballots);
  renderNonvoterBadge(pairing);
  setStatus('nv-status', 'ok', nonvoterProse(rows, s, { roll, ballots, noRoll, tooSmall }));
  renderNonvoterPriorityNote(rows, ballots);
  $('nv-results').hidden = false;
  $('nv-basket-card').hidden = false;
  renderNonvoterTable(nv.rows);
  renderNonvoterBasket();
  restyleForNonvoters();
}

function renderNonvoterStats(s, roll, ballots) {
  const host = $('nv-stats');
  host.textContent = '';
  const stat = (label, value, note) => {
    const box = el('div', 'viz-stat');
    box.append(el('div', 'viz-stat-value', value), el('div', 'text-small text-muted', label));
    if (note) box.append(el('div', 'text-small text-muted', note));
    return box;
  };
  host.append(
    stat('did not vote', fmtInt(s.notVoted), fmtPct(s.share) + ' of the roll'),
    stat('on the roll', fmtInt(s.rollTotal), roll.label.toLowerCase()),
    stat('ballots cast', fmtInt(s.ballotTotal), ballots.label),
    stat('areas with a roll entry', fmtInt(s.areas)),
  );
}

/* Beside the figures rather than a tab away, and taking the weaker of the two
   halves: a subtraction is only as firm as its softer side. */
function renderNonvoterBadge(pairing) {
  const host = $('nv-badge');
  if (!host) return;
  host.textContent = '';
  const kind = pairing.route === 'counted' ? 'counted'
    : pairing.route === 'smoothed' ? 'smoothed' : 'modelled';
  const [label, why] = PROVENANCE[pairing.route === 'interpolated' ? 'modelled' : pairing.route];
  const badge = el('span', `badge badge-${kind}`,
    pairing.route === 'counted' ? `${label} · ${pairing.label}` : `${label} · read caveat`);
  badge.title = why;
  host.append(badge);
  if (!pairing.coherent) {
    const cross = el('span', 'badge badge-modelled', 'Cross-election');
    cross.title = `${pairing.roll.label} against ${pairing.ballots.label}: a roll drawn for one `
      + 'election and ballots cast in another count different people in the same place.';
    host.append(document.createTextNode(' '), cross);
  }
  host.hidden = false;
}

/* --- What to say about it ---------------------------------------------------

   Four beats, the same shape correlationSummary uses: the finding, how firmly
   to hold it, what the qualifier reflects, and the fixed caveat. One deliberate
   adaptation -- a counted fact carries no confidence interval, so beat two is
   the provenance of each half and beat three the diagnostic counts. That is the
   honest analogue of "how firmly", rather than a weakening of it.

   No verb of cause appears in anything below, and a test checks that. */
function nonvoterProse(rows, s, ctx) {
  const nv = state.nonvoters;
  const unitName = NV_UNIT_NAMES[nv.unit];
  const one = NV_UNIT_ONE[nv.unit];
  const p = nv.pairing;
  const out = [];

  /* 1. The finding. Phrased differently where the two halves are the same
        election, since only then is "did not vote" a statement about the same
        people rather than a difference between two electorates. */
  /* A negative total is a different sentence, not the same one with a minus
     sign in it. "hold -964 more than there were" does not parse, and the share
     that goes with it read -32,133% -- arithmetically correct over a roll
     smaller than the ballots, and useless as a rate. Where the roll comes out
     under the ballots in aggregate, say so in words and give the two totals,
     which is the thing a reader can actually act on. */
  const short = s.notVoted < 0;
  out.push(el('p', null, short
    ? `${fmtInt(s.areas)} ${unitName} hold ${fmtInt(-s.notVoted)} FEWER on the ${p.rollLabel} `
      + `than there were ${p.ballotLabel} cast in them — ${fmtInt(s.rollTotal)} against `
      + `${fmtInt(s.ballotTotal)}. The roll does not describe the people who voted here.`
    : p.coherent
      ? `${fmtInt(s.notVoted)} electors did not cast a ballot, across ${fmtInt(s.areas)} `
        + `${unitName} — ${fmtPct(s.share)} of the ${p.rollLabel}.`
      : `${fmtInt(s.areas)} ${unitName} hold ${fmtInt(s.notVoted)} more on the ${p.rollLabel} than `
        + `there were ${p.ballotLabel} cast in them — ${fmtPct(s.share)} of the roll.`));

  /* 2. How each half reached this geography.

        Counted on both sides still comes two ways, and the first version told
        the same story about both: "the roll was placed on these areas one
        address at a time" was printed over federal electors taken straight
        from the results file, which were reported on those divisions and never
        placed by anybody. A false sentence about provenance, in the tab whose
        whole purpose is to get provenance right, and no test caught it because
        every test read the phrase "Both figures are counts". */
  const both = p.rollRoute === 'counted' && p.ballotRoute === 'counted';
  out.push(el('p', 'text-small text-muted', !both
    ? `${capitalise(routePhrase(p.rollRoute, 'the roll'))}, and `
      + `${routePhrase(p.ballotRoute, 'the ballots')}. `
      + 'A subtraction is only as firm as its softer half, so this one is not a count.'
    : p.viaAddresses
      ? 'Both figures are counts. The roll was placed on these areas one address at a time; the '
        + 'ballots were reported on them.'
      : 'Both figures are counts, reported on these areas by the agency that ran the election.'));
  const rep = ctx.roll.id === 'muni' ? (state.points && state.points.report) : null;
  if (rep && rep.snapped) {
    const located = rep.matched + rep.snapped;
    out.push(el('p', 'text-small text-muted',
      `${fmtPct(rep.snapped / located)} of the roll rows behind these counts were placed beside the `
      + `nearest number on their own street rather than looked up, typically `
      + `${fmtInt(rep.snapGapMedian)} numbers away. That is an estimate of where a door is; the `
      + 'Data tab reports the spread of it.'));
  }
  if (!p.coherent) {
    out.push(el('p', 'text-small text-warning',
      `Cross-election: the ${p.rollLabel} and the ${p.ballotLabel} count different people in the `
      + 'same place. Somebody registered since the ballots were cast is on one side of this '
      + 'subtraction and not the other.'));
  }

  /* 3. The diagnostic counts, which is what this tab is worth most for. */
  if (s.negative) {
    out.push(el('p', 'text-small text-warning',
      `${fmtInt(s.negative)} ${one}${s.negative === 1 ? '' : 's'} came out with more ballots than `
      + 'roll electors. In those the roll does not describe the people who voted there, which is a '
      + 'fact about the roll rather than about the ballots.'));
  }
  if (s.capped) {
    out.push(el('p', 'text-small text-warning',
      `${fmtInt(s.capped)} ${one}${s.capped === 1 ? '' : 's'} sit at the ceiling the municipal `
      + `model works under — each area's own `
      + 'federal electorate. A gap of zero there is arithmetic rather than a finding, and those '
      + 'rows are shown in italic.'));
  }
  if (ctx.noRoll) {
    out.push(el('p', 'text-small text-muted',
      `${fmtInt(ctx.noRoll)} ${unitName} have no roll entry at all, which is not the same as a roll `
      + 'of zero and is left out of every figure above. The divisions covering UBC and the '
      + 'University Endowment Lands are the expected case: those electors are on Vancouver’s '
      + 'roll for the school trustee ballot, and the city’s property file does not address '
      + 'land outside the city.'));
  }
  if (ctx.tooSmall) {
    out.push(el('p', 'text-small text-muted',
      `${fmtInt(ctx.tooSmall)} more carry fewer than ${fmtInt(nv.minRoll)} on the roll and are left `
      + 'out by the minimum above; a share over a handful of electors moves several points on one '
      + 'person.'));
  }

  /* 4. The fixed caveat, adapted rather than copied. correlationSummary says a
        correlation cannot tell you how anybody voted; this sits closer to the
        individual than that -- a roll really is a list of people -- so the
        caveat has to bite on the other edge. The atlas holds the count. */
  out.push(el('p', 'text-small text-muted',
    `This is about ${unitName}, not people. What is held here is a count for each area and no `
    + 'names: a total across a whole area cannot tell you which elector did not vote.'));
  return out;
}

const capitalise = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);

/* The mail surface, saying exactly what the rank is and is not. The unit of
   action is an area -- mail goes to a geography, not to a person picked out by
   an inferred belief -- so an area-level score is the matched instrument here.
   What it must never become is a count of votes. */
function renderNonvoterPriorityNote(rows, ballots) {
  const host = $('nv-priority-note');
  if (!host) return;
  const nv = state.nonvoters;
  const ranked = rows.filter((r) => r.m);
  host.textContent = '';
  if (!ranked.length) {
    host.append(el('span', null,
      'No area has both a positive number who did not vote and a party share, so there is nothing '
      + 'to rank.'));
    return;
  }
  const lean = nv.weight > 1 ? 'leaning on the share'
    : nv.weight < 1 ? 'leaning on the raw number who did not vote'
      : 'weighting the two evenly';
  const excluded = rows.length - ranked.length;
  host.append(el('span', null,
    `${fmtInt(ranked.length)} ${NV_UNIT_NAMES[nv.unit]} ranked from the number who did not vote and `
    + `the ${nv.party} share of ${ballots.label} in each, ${lean}. The rank orders areas against `
    + 'one another. It is not a count of votes available: that would be a claim about how '
    + 'particular people would vote, and nothing here measures that.'
    + (excluded
      ? ` ${fmtInt(excluded)} are left out — an area where everybody on the roll voted is not a `
        + 'mail target, and one with more ballots than roll electors is a sign the roll is wrong '
        + 'about that area rather than a smaller target.'
      : '')));
}

/* --- Table ------------------------------------------------------------------ */

/* Every column carries both half-labels in its second header line, so a
   screenshot of the table alone still says what was subtracted from what. */
const NONVOTER_COLUMNS = [
  { key: 'rank', label: '#', sub: 'by did not vote', get: (r) => r.rank, fmt: fmtInt },
  { key: 'label', label: 'Area', get: (r) => r.label, fmt: (v) => v, left: true },
  { key: 'g.roll.count', label: 'On the roll', get: (r) => r.g.roll.count, fmt: fmtInt },
  { key: 'g.ballots.count', label: 'Ballots cast', get: (r) => r.g.ballots.count, fmt: fmtInt },
  { key: 'g.notVoted', label: 'Did not vote', get: (r) => r.g.notVoted, fmt: fmtInt },
  { key: 'g.notVotedShare', label: 'Share', get: (r) => r.g.notVotedShare, fmt: fmtPct },
  { key: 'm.rank', label: 'Mail priority', sub: 'rank, not votes',
    get: (r) => (r.m ? r.m.rank : null), fmt: fmtInt },
  { key: 'm.percentile', label: 'Percentile', get: (r) => (r.m ? r.m.percentile : null),
    fmt: (v) => `${Math.round(v)}` },
];

/* A column of dashes says nothing, exactly as on the Turnout tab: with no
   party share there is no rank, and the two columns that carry one go. */
function nonvoterColumns(rows) {
  const ranked = rows.some((r) => r.m);
  const p = state.nonvoters.pairing;
  const subs = {
    'g.roll.count': p ? p.rollLabel : '',
    'g.ballots.count': p ? p.ballotLabel : '',
    'g.notVoted': p ? p.label : '',
    'g.notVotedShare': p ? `of the ${p.rollLabel}` : '',
  };
  return NONVOTER_COLUMNS
    .filter((c) => ranked || !c.key.startsWith('m.'))
    .map((c) => ({ ...c, sub: subs[c.key] != null ? subs[c.key] : c.sub }));
}

/* Ranks always follow the number who did not vote, whatever the table is
   sorted by -- the Turnout tab's rule, for the same reason. The mail rank is a
   second ordering with a second name and its own column, never folded into
   this one. */
function sortNonvoterRows(rows) {
  const nv = state.nonvoters;
  const columns = nonvoterColumns(rows);
  if (!columns.some((c) => c.key === nv.sortKey)) { nv.sortKey = 'g.notVoted'; nv.sortDir = 'desc'; }
  const byGap = rows.slice().sort((a, b) => b.g.notVoted - a.g.notVoted);
  byGap.forEach((r, i) => { r.rank = i + 1; });
  if (nv.sortKey === 'g.notVoted' && nv.sortDir === 'desc') return byGap;
  const column = columns.find((c) => c.key === nv.sortKey);
  const sign = nv.sortDir === 'desc' ? -1 : 1;
  return rows.slice().sort((a, b) => {
    const x = column.get(a), y = column.get(b);
    /* Not negated the way the numeric branch is. A descending number is the
       largest first, so sign flips the subtraction; a descending name is Z to
       A, which is what sign alone already gives localeCompare. Both minus
       signs sorted the Area column backwards from what its arrow claimed. */
    if (typeof x === 'string' || typeof y === 'string') {
      return sign * String(x).localeCompare(String(y), undefined, { numeric: true });
    }
    if (x == null && y == null) return 0;
    if (x == null) return 1;                 // nulls sink either way
    if (y == null) return -1;
    return sign * (x - y);
  });
}

function renderNonvoterTable(rows) {
  const table = $('nv-table');
  table.textContent = '';
  const columns = nonvoterColumns(rows);
  const thead = el('thead'), hr = el('tr');
  hr.append(el('th', 'text-start', ''));
  for (const c of columns) {
    const th = el('th', c.left ? 'text-start' : null);
    th.append(el('span', null, c.label));
    if (c.sub) th.append(el('span', 'th-sub text-small text-muted', c.sub));
    if (c.key === state.nonvoters.sortKey) th.classList.add('sorted', state.nonvoters.sortDir);
    th.dataset.key = c.key;
    th.addEventListener('click', () => {
      const nv = state.nonvoters;
      if (nv.sortKey === c.key) nv.sortDir = nv.sortDir === 'desc' ? 'asc' : 'desc';
      else { nv.sortKey = c.key; nv.sortDir = c.key === 'label' ? 'asc' : 'desc'; }
      nv.rows = sortNonvoterRows(nv.rows || []);
      renderNonvoterTable(nv.rows);
    });
    hr.append(th);
  }
  thead.append(hr);
  const tbody = el('tbody');
  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const tr = el('tr');
    tr.dataset.key = r.basketKey || '';
    /* The same italic the Turnout tab gives a row built from one election: a
       row whose zero is the model's ceiling rather than the electorate's. */
    if (r.g.capped) tr.classList.add('partial');
    if (r.g.notVoted < 0) tr.classList.add('over');
    if (r.basketKey && state.nonvoters.basket.has(r.basketKey)) tr.classList.add('in-basket');
    const td0 = el('td', 'text-start');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = tr.classList.contains('in-basket');
    cb.disabled = !r.basketKey;
    cb.setAttribute('aria-label', `Add ${r.label} to the picked set`);
    cb.addEventListener('change', () => toggleNonvoterBasket(r.basketKey));
    td0.append(cb); tr.append(td0);
    for (const c of columns) {
      const v = c.get(r);
      tr.append(el('td', c.left ? 'text-start' : null, v == null ? '--' : c.fmt(v)));
    }
    frag.append(tr);
  }
  tbody.append(frag);
  table.append(thead, tbody);
}

/* --- The picked set --------------------------------------------------------- */

function nvBasketKey(unit, row) {
  const f = nvFeature(unit, row);
  if (!f) return null;
  return unit === 'fed' ? f.key : f.__key;
}

function toggleNonvoterBasket(key) {
  if (!key) return;
  const b = state.nonvoters.basket;
  if (b.has(key)) b.delete(key); else b.add(key);
  const row = $('nv-table').querySelector(`tr[data-key="${CSS.escape(key)}"]`);
  if (row) {
    row.classList.toggle('in-basket', b.has(key));
    const cb = row.querySelector('input[type=checkbox]');
    if (cb) cb.checked = b.has(key);
  }
  renderNonvoterBasket();
}

/* Summed, never re-modelled: these are the same counts the table shows, added
   up. The share is over the picked roll rather than over the areas, so a large
   area cannot be outvoted by a handful of small ones. */
function renderNonvoterBasket() {
  const host = $('nv-basket');
  if (!host) return;
  host.textContent = '';
  const rows = (state.nonvoters.rows || []).filter((r) => r.basketKey
    && state.nonvoters.basket.has(r.basketKey));
  let rollTotal = 0, notVoted = 0;
  for (const r of rows) { rollTotal += r.g.roll.count; notVoted += r.g.notVoted; }
  const stat = (label, value, note) => {
    const box = el('div', 'viz-stat');
    box.append(el('div', 'viz-stat-value', value), el('div', 'text-small text-muted', label));
    if (note) box.append(el('div', 'text-small text-muted', note));
    return box;
  };
  host.append(
    stat('areas picked', fmtInt(rows.length)),
    stat('on the roll', fmtInt(rollTotal)),
    stat('did not vote', fmtInt(notVoted), rollTotal > 0 ? `${fmtPct(notVoted / rollTotal)} of them` : null),
  );
  const note = $('nv-basket-note');
  if (note) {
    note.textContent = rows.length
      ? 'Counts, added up. Doors are not areas: the addresses export on the Data tab is what a '
        + 'mail house needs, and several electors behind one door is one drop.'
      : 'Tick areas in the table below, or add the top of the ranking.';
  }
}

/* --- Export ------------------------------------------------------------------

   The {headers, of} builder stays here rather than in f8-roll.js, following
   pointsColumns: which columns an export carries is a decision about this
   table, and the maths module has no business knowing about it.

   Fixed schema names, the reader's choice in its own columns. A file that
   renames its columns depending on what somebody picked is one no script can be
   written against, and every route travels beside its half so that counted and
   modelled figures can be told apart after the file has left this tab. */
function nonvoterCsvExtra(rows) {
  const ranked = rows.some((r) => r.m);
  const headers = ['not_voted_rank', 'not_voted', 'not_voted_share',
    'roll_count', 'roll_source', 'roll_label', 'roll_vintage', 'roll_route',
    'ballots_count', 'ballots_source', 'ballots_label', 'ballots_vintage', 'ballots_route',
    'pairing_route', 'coherent', 'capped',
    ...(ranked ? ['mail_rank', 'mail_percentile', 'mail_score', 'mail_basis'] : [])];
  const f = (v, dp = 6) => (v == null || !isFinite(v) ? '' : Number(v).toFixed(dp));
  return {
    headers,
    of: (r) => {
      const g = r.g;
      return [r.rank ?? '', g.notVoted, f(g.notVotedShare),
        g.roll.count, g.roll.source, g.roll.label, g.roll.vintage, g.roll.route,
        g.ballots.count, g.ballots.source, g.ballots.label, g.ballots.vintage, g.ballots.route,
        g.route, g.coherent ? 'yes' : 'no', g.capped ? 'yes' : 'no',
        ...(ranked ? [r.m ? r.m.rank : '', r.m ? r.m.percentile : '',
                      r.m ? f(r.m.score, 4) : '', r.m ? r.m.basis : ''] : [])];
    },
  };
}

/* --- Map -------------------------------------------------------------------- */

function updateNonvoterControls() {
  const on = state.nonvoters.on || {};
  for (const [sel, layer] of [['shade-by', 'fed'], ['shade-prov-by', 'prov']]) {
    const node = $(sel);
    if (!node) continue;
    const ok = Boolean(on[layer] && on[layer].size);
    for (const value of ['nonvoters-count', 'nonvoters-share']) {
      const option = node.querySelector(`option[value="${value}"]`);
      if (!option) continue;
      option.hidden = !ok;
      if (!ok && node.value === value) node.value = 'none';
    }
  }
}

function restyleForNonvoters() {
  updateNonvoterControls();
  applyFederalStyle(gFed.selectAll('path'));
  applyProvincialStyle(gProv.selectAll('path'));
  renderLegend();
  renderReadout();
}

/* --- Wiring ------------------------------------------------------------------ */

if ($('nv-unit')) {
  for (const id of ['nv-unit', 'nv-roll', 'nv-ballots', 'nv-min', 'nv-party', 'nv-weight']) {
    /* The unit changes which features the rows are keyed by, so the picked set
       is cleared with it -- keys from one geography mean nothing on another. */
    $(id).addEventListener('change', () => {
      const nv = state.nonvoters;
      if (id === 'nv-unit') nv.basket.clear();
      /* Only a change event records an ask. fillSelect assigns `value`
         directly, which fires nothing, so refilling a picker can never promote
         its own fallback into a choice. */
      if (id === 'nv-roll') nv.rollWanted = $('nv-roll').value;
      if (id === 'nv-ballots') nv.ballotsWanted = $('nv-ballots').value;
      refreshNonvoters();
    });
  }
  $('export-nonvoters').addEventListener('click', () => {
    const rows = state.nonvoters.rows || [];
    if (!rows.length) return;
    const unit = state.nonvoters.unit;
    downloadCsv(`vancouver-nonvoters-${unit}.csv`,
      Turnout.toCsv(rows, ['fed', 'prov'], nonvoterCsvExtra(rows)));
  });
  $('nv-basket-add-top').addEventListener('click', () => {
    const n = Math.max(1, parseInt($('nv-basket-top-n').value, 10) || 50);
    const rows = state.nonvoters.rows || [];
    /* The top of whichever ranking the reader is looking at: the mail rank
       where one exists, the number who did not vote where it does not. */
    const ordered = rows.some((r) => r.m)
      ? rows.filter((r) => r.m).slice().sort((a, b) => a.m.rank - b.m.rank)
      : rows.slice().sort((a, b) => b.g.notVoted - a.g.notVoted);
    for (const r of ordered.slice(0, n)) if (r.basketKey) state.nonvoters.basket.add(r.basketKey);
    renderNonvoterTable(rows);
    renderNonvoterBasket();
  });
  $('nv-basket-clear').addEventListener('click', () => {
    state.nonvoters.basket.clear();
    renderNonvoterTable(state.nonvoters.rows || []);
    renderNonvoterBasket();
  });
}
