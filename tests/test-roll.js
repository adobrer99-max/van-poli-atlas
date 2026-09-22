const { load } = require('./harness');
const { Roll, Turnout, Analysis, Geo } = load(
  ['a-geo.js', 'b-text.js', 'c-binary.js', 'd-ingest.js', 'e-analysis.js', 'f-results.js',
   'f2-turnout.js', 'f3-census.js', 'f4-places.js', 'f5-summary.js', 'f6-points.js',
   'f7-municipal.js', 'f8-roll.js'],
  ['Roll', 'Turnout', 'Analysis', 'Geo']);
let fails = 0;
const ok = (n, c, e = '') => { if (c) console.log(`  PASS  ${n}`); else { console.log(`  FAIL  ${n} ${e}`); fails++; } };
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

/* Rows shaped the way Turnout.rowsOnUnit builds them, because that is what the
   tab hands over -- Roll hangs row.g beside row.t and row.p on the very same
   objects, and the whole point is that it disturbs nothing it finds there. */
const unit = (total, electors, rejected = 0) => ({
  total, electors, rejected, parties: new Map([['A', Math.round(total * 0.6)],
                                               ['B', total - Math.round(total * 0.6)]]),
});
const makeRows = () => ([
  { key: '0', label: 'poll 1', by: { fed: unit(600, 1000), prov: unit(500, 900) },
    electors: 1000, t: { fed: 0.6, prov: 0.556 }, agg: 0.578, partial: false,
    ballots: { fed: 600, prov: 500 }, expected: 578, p: { spread: 0.04 } },
  { key: '1', label: 'poll 2', by: { fed: unit(300, 400), prov: unit(250, 380) },
    electors: 400, t: { fed: 0.75, prov: 0.658 }, agg: 0.704, partial: false,
    ballots: { fed: 300, prov: 250 }, expected: 282, p: { spread: 0.09 } },
  { key: '2', label: 'poll 3', by: { fed: unit(900, 1000), prov: unit(800, 950) },
    electors: 1000, t: { fed: 0.9, prov: 0.842 }, agg: 0.871, partial: false,
    ballots: { fed: 900, prov: 800 }, expected: 871, p: { spread: 0.06 } },
]);

/* A roll counted onto these areas by address: the count per area the tab gets
   from Points.assignToLayer. Deliberately NOT equal to row.electors.

   Every area here has MORE on the roll than ballots cast, so the base fixture
   has an unambiguous positive gap everywhere and the negative case gets its own
   test rather than turning up by accident in others. It did: 850 against 900
   ballots made poll 3 negative, the ranking correctly refused it, and the
   expectation was the thing that was wrong. */
const ROLL = { 0: 1200, 1: 450, 2: 1100 };
const rollOf = (r) => (ROLL[r.key] == null ? null : ROLL[r.key]);
const ballotsOf = (side) => (r) => (r.ballots ? r.ballots[side] : null);

console.log('\n== It writes to one place ==');
/* The single most valuable test here, and the direct analogue of the one
   guarding participation(): a modelled figure must never reach something
   labelled turnout. If row.g can be deleted and leave the row byte-identical,
   nothing else was touched. */
{
  const rows = makeRows();
  const before = JSON.stringify(rows.map((r) => ({ ...r, by: null })));
  Roll.gap(rows, { roll: 'muni', ballots: 'fed', rollOf, ballotsOf: ballotsOf('fed'),
                   rollViaAddresses: true, target: 'fed' });
  ok('every row got a gap', rows.every((r) => r.g), JSON.stringify(rows.map((r) => Boolean(r.g))));
  for (const r of rows) delete r.g;
  eq('and removing it leaves t, agg, expected, electors, ballots and p untouched',
     JSON.stringify(rows.map((r) => ({ ...r, by: null }))), before);
}

console.log('\n== It never reads row.electors ==');
/* row.electors is "the first source with a non-zero count", which on a
   provincial row silently yields FEDERAL electors. Right for its own purpose
   and catastrophic here: it would answer a question about one electorate with
   the size of another, and nothing would look wrong. */
{
  const rows = makeRows();
  Roll.gap(rows, { roll: 'muni', ballots: 'fed', rollOf, ballotsOf: ballotsOf('fed'),
                   rollViaAddresses: true, target: 'fed' });
  eq('the roll count is the roll, not the electors already on the row',
     rows.map((r) => r.g.roll.count), [1200, 450, 1100]);
  ok('which differs from row.electors, so a mix-up would have shown',
     rows.every((r) => r.g.roll.count !== r.electors));
  const noRoll = makeRows();
  Roll.gap(noRoll, { roll: 'muni', ballots: 'fed', rollOf: () => null,
                     ballotsOf: ballotsOf('fed'), rollViaAddresses: true });
  ok('and with no roll there is no gap at all, rather than one built from electors',
     noRoll.every((r) => !r.g));
}

console.log('\n== Absent is not zero ==');
{
  const rows = makeRows();
  Roll.gap(rows, { roll: 'muni', ballots: 'fed', rollViaAddresses: true,
                   rollOf: (r) => (r.key === '1' ? null : ROLL[r.key]),
                   ballotsOf: ballotsOf('fed') });
  ok('an area the roll never mentions has no gap, not a gap of its whole electorate',
     rows[1].g === undefined && rows[0].g && rows[2].g);
  eq('and the summary counts only the areas that have one', Roll.summary(rows).areas, 2);
}

console.log('\n== Negative is a result ==');
/* More ballots than roll electors means the roll does not describe the people
   who voted there. Clamping it would hide a denominator error rather than find
   one, and this is the best diagnostic the file produces. */
{
  const rows = makeRows();
  Roll.gap(rows, { roll: 'muni', ballots: 'fed', rollViaAddresses: true,
                   rollOf: (r) => (r.key === '2' ? 800 : ROLL[r.key]),
                   ballotsOf: ballotsOf('fed') });
  eq('900 ballots against 800 on the roll gives -100, not 0', rows[2].g.notVoted, -100);
  eq('and it is counted', Roll.negativeGap(rows), 1);
  ok('the share goes negative with it rather than being floored',
     rows[2].g.notVotedShare < 0, String(rows[2].g.notVotedShare));
}

console.log('\n== Each half carries its route, and the weaker one wins ==');
{
  eq('a roll of addresses is counted on every layer it is dropped on',
     [Roll.routeOf('muni', 'fed', true), Roll.routeOf('muni', 'prov', true),
      Roll.routeOf('muni', 'da', true)], ['counted', 'counted', 'counted']);
  eq('federal electors are counted on federal polls and interpolated elsewhere',
     [Roll.routeOf('fed', 'fed', false), Roll.routeOf('fed', 'prov', false)],
     ['counted', 'interpolated']);
  eq('municipal ballots are smoothed wherever they land',
     Roll.routeOf('muni', 'fed', false), 'smoothed');
  eq('and a subtraction takes the weaker of its two halves',
     [Roll.weaker('counted', 'counted'), Roll.weaker('counted', 'interpolated'),
      Roll.weaker('interpolated', 'smoothed')],
     ['counted', 'interpolated', 'smoothed']);

  const rows = makeRows();
  Roll.gap(rows, { roll: 'muni', ballots: 'fed', rollOf, ballotsOf: ballotsOf('fed'),
                   rollViaAddresses: true, target: 'fed' });
  eq('a counted roll minus counted ballots is a counted subtraction', rows[0].g.route, 'counted');
  const onProv = makeRows();
  Roll.gap(onProv, { roll: 'muni', ballots: 'fed', rollOf, ballotsOf: ballotsOf('fed'),
                     rollViaAddresses: true, target: 'prov' });
  eq('but federal ballots on a provincial area make the whole thing interpolated',
     onProv[0].g.route, 'interpolated');

  /* The ballots side can be modelled on its own native geography, and routeOf
     cannot see it: apportioning advance and special ballots spreads a majority
     of the 2025 federal total over divisions that never reported them, and
     that is a control on the Turnout tab rather than a property of the source.
     Without the override the tab printed "Both figures are counts" and a green
     Counted badge over a figure that was 55% model. */
  const apportioned = makeRows();
  Roll.gap(apportioned, { roll: 'muni', ballots: 'fed', rollOf, ballotsOf: ballotsOf('fed'),
                          rollViaAddresses: true, target: 'fed', ballotRoute: 'interpolated' });
  eq('a caller may say the ballots were modelled on their own geography',
     apportioned[0].g.ballots.route, 'interpolated');
  eq('and the subtraction takes the weaker half, as it does for any other route',
     apportioned[0].g.route, 'interpolated');
  eq('without the override touching the roll side',
     apportioned[0].g.roll.route, 'counted');
  const noOverride = makeRows();
  Roll.gap(noOverride, { roll: 'muni', ballots: 'fed', rollOf, ballotsOf: ballotsOf('fed'),
                         rollViaAddresses: true, target: 'fed', ballotRoute: null });
  eq('and a null override leaving routeOf to answer as before',
     noOverride[0].g.route, 'counted');
}

console.log('\n== Cross-election is stated, not left to be noticed ==');
{
  const rows = makeRows();
  Roll.gap(rows, { roll: 'muni', ballots: 'fed', rollOf, ballotsOf: ballotsOf('fed'),
                   rollViaAddresses: true });
  ok('a 2026 roll against 2025 ballots is flagged incoherent', !rows[0].g.coherent);
  eq('and counted', Roll.incoherent(rows), 3);
  eq('with a label naming both halves and both years',
     rows[0].g.label, '2026 municipal roll minus 2025 federal ballots');
  const same = makeRows();
  Roll.gap(same, { roll: 'fed', ballots: 'fed', rollOf, ballotsOf: ballotsOf('fed') });
  ok('the same election against itself is coherent', same[0].g.coherent);
}

console.log('\n== A roll is named by the reader, never by what this build expected ==');
/* ROLL_SOURCES.muni reads "2026 municipal roll", which is right for the file
   this was built for and a lie about any other file dropped in the same slot --
   and a wrong vintage does not stop at the label, it propagates into
   `coherent`. So the caller can name its own roll, and the tab does. */
{
  const rows = makeRows();
  Roll.gap(rows, { roll: 'muni', ballots: 'fed', rollOf, ballotsOf: ballotsOf('fed'),
                   rollViaAddresses: true, rollLabel: 'roll of electors', rollVintage: '' });
  eq('the override reaches the roll half', rows[0].g.roll.label, 'roll of electors');
  eq('and the subtraction label, with no vintage invented for it',
     rows[0].g.label, 'roll of electors minus 2025 federal ballots');
  ok('and nothing claims a vintage the atlas was never told',
     !/20\d\d roll of electors/.test(rows[0].g.label), rows[0].g.label);
  const same = makeRows();
  Roll.gap(same, { roll: 'fed', ballots: 'fed', rollOf, ballotsOf: ballotsOf('fed') });
  eq('and a source the atlas does know keeps its own name',
     same[0].g.roll.label, '2025 federal electors');
}

console.log('\n== A gap floored by arithmetic says so ==');
/* muniTargets caps the municipal smoothing at federal electors per division,
   so a municipal-paired gap cannot go negative however the world behaves. A
   zero there is the ceiling, not a finding, and must not read as one. */
{
  const rows = makeRows();
  Roll.gap(rows, { roll: 'muni', ballots: 'muni', rollOf, ballotsOf: ballotsOf('fed'),
                   rollViaAddresses: true, cappedIds: new Set(['1']), idOf: (r) => r.key });
  eq('the area where the model hit its ceiling is flagged',
     rows.map((r) => r.g.capped), [false, true, false]);
  eq('and counted', Roll.capped(rows), 1);
}

console.log('\n== Mail priority is a rank, never a count of votes ==');
{
  const rows = makeRows();
  Roll.gap(rows, { roll: 'muni', ballots: 'fed', rollOf, ballotsOf: ballotsOf('fed'),
                   rollViaAddresses: true });
  Roll.mailScore(rows, { shareOf: (r) => Analysis.shareOf(r.by.fed, 'A'),
                         basis: 'A share, federal 2025' });
  const ranked = rows.filter((r) => r.m).sort((a, b) => a.m.rank - b.m.rank);
  eq('every area with a gap and a share is ranked', ranked.length, 3);
  eq('ranks run 1..n with no gaps and no ties', ranked.map((r) => r.m.rank), [1, 2, 3]);
  ok('the biggest score leads', ranked[0].m.score >= ranked[1].m.score);
  eq('the top of the list is the 100th percentile and the bottom the 0th',
     [ranked[0].m.percentile, ranked[ranked.length - 1].m.percentile], [100, 0]);
  ok('and the basis travels with it, so the rank can say what it rests on',
     ranked.every((r) => r.m.basis === 'A share, federal 2025'));
  /* An area where everybody voted is not a mail target, and a negative gap is
     not a smaller one -- it is a sign the roll is wrong about that area. */
  const none = makeRows();
  Roll.gap(none, { roll: 'muni', ballots: 'fed', rollViaAddresses: true,
                   rollOf: (r) => (r.key === '2' ? 800 : ROLL[r.key]),
                   ballotsOf: ballotsOf('fed') });
  Roll.mailScore(none, { shareOf: (r) => Analysis.shareOf(r.by.fed, 'A') });
  ok('an area with a negative gap is left out of the ranking entirely',
     none[2].m === undefined);
  /* The score is carried, because withholding it only gets it recomputed in a
     spreadsheet with no label attached -- but it is a score, not votes. */
  ok('the score is available beside the rank', ranked.every((r) => isFinite(r.m.score)));
}

console.log('\n== The summary adds up ==');
{
  const rows = makeRows();
  Roll.gap(rows, { roll: 'muni', ballots: 'fed', rollOf, ballotsOf: ballotsOf('fed'),
                   rollViaAddresses: true });
  const s = Roll.summary(rows);
  eq('roll total', s.rollTotal, 1200 + 450 + 1100);
  eq('ballot total', s.ballotTotal, 600 + 300 + 900);
  eq('and the difference is the number who did not vote', s.notVoted, s.rollTotal - s.ballotTotal);
  ok('the share is over the roll, not over the areas',
     Math.abs(s.share - s.notVoted / s.rollTotal) < 1e-12);
  eq('with the routes counted so prose can say what kind of figure it is',
     [s.counted, s.interpolated, s.smoothed], [3, 0, 0]);
}

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll roll tests passed.\n');
process.exit(fails ? 1 : 0);
