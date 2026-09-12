const { load } = require('./harness');
const { Analysis: An, Results: R, Turnout: T } =
  load(['a-geo.js', 'e-analysis.js', 'f-results.js', 'f2-turnout.js'], ['Analysis', 'Results', 'Turnout']);
let fails = 0;
const ok = (n, c, e = '') => { if (c) console.log(`  PASS  ${n}`); else { console.log(`  FAIL  ${n} ${e}`); fails++; } };
const near = (n, a, b, tol = 1e-12) =>
  ok(`${n} (${a == null ? 'null' : Number(a).toFixed(6)} ~ ${b})`, a != null && Math.abs(a - b) <= tol,
     `diff ${a == null ? 'null' : Math.abs(a - b)}`);
const drain = (gen) => { let r = gen.next(); while (!r.done) r = gen.next(); return r.value; };
const cell = (x0, y0, w, h, props) => ({ type: 'Feature', properties: props, geometry: { type: 'Polygon',
  coordinates: [[[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h], [x0, y0]]] } });
const unit = (total, electors, rejected = 0, extra = {}) => ({
  total, electors, rejected, parties: new Map([['A', total * 0.6], ['B', total * 0.4]]),
  rows: 1, district: '59035', poll: '1', mergeWith: '', flags: { void: false, noPoll: false },
  mergedGroup: null, ...extra });

// Offset grids, as in test-analysis.js: every interior federal cell is split
// 25/25/25/25 across four provincial cells.
const S = 0.02, X0 = -123.16, Y0 = 49.20;
const fed = [], prov = [];
for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) fed.push(cell(X0 + i * S, Y0 + j * S, S, S, { id: `F${i}${j}` }));
for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) prov.push(cell(X0 + (i + .5) * S, Y0 + (j + .5) * S, S, S, { id: `P${i}${j}` }));
const cw = drain(An.crosswalkRunner(fed, prov, { spacingM: 25 }));
const pairs = An.crosswalkPairs(cw);
const labels = { fed: (i) => fed[i].properties.id, prov: (i) => prov[i].properties.id };

console.log('\n== The rate ==');
near('rate = (valid + rejected) / electors', T.rate(unit(300, 500, 6)), 0.612);
ok('no electors -> null, not Infinity', T.rate(unit(300, 0)) === null);
ok('missing unit -> null', T.rate(null) === null);

console.log('\n== Electors and rejected ballots move through the crosswalk ==');
const fedValues = new Map();
fed.forEach((f, i) => fedValues.set(i, unit(100 + i, 400 + 3 * i, 2 + (i % 3))));
const same = drain(An.crosswalkRunner(fed, fed.map((f) => JSON.parse(JSON.stringify(f))), { spacingM: 25 }));
const back = An.redistribute(An.crosswalkPairs(same), fedValues, { from: 'fed' });
near('identical geography: electors land unchanged', back.get(5).electors, fedValues.get(5).electors, 1e-9);
near('identical geography: rejected land unchanged', back.get(5).rejected, fedValues.get(5).rejected, 1e-9);
const moved = An.redistribute(pairs, fedValues, { from: 'fed' });
let sumE = 0; for (const v of moved.values()) sumE += v.electors;
let expE = 0; for (const p of pairs) expE += fedValues.get(p.fi).electors * p.shareOfFed;
near('offset grids: electors conserved through redistribution', sumE, expE, 1e-9);

console.log('\n== Invariance: uniform turnout survives every common geography ==');
// Every source unit has turnout exactly 0.6 with wildly different electors.
const fedU = new Map(), provU = new Map();
fed.forEach((f, i) => { const e = 200 + 37 * i; fedU.set(i, unit(0.58 * e, e, 0.02 * e)); });
prov.forEach((f, i) => { const e = 350 + 11 * i; provU.set(i, unit(0.55 * e, e, 0.05 * e)); });
const sources = [{ id: 'fed', values: fedU, pairs }, { id: 'prov', values: provU, pairs }];
for (const target of ['prov', 'fed', 'atom']) {
  const rows = T.score(T.rowsOnUnit(target, sources, labels), { weights: { fed: 0.5, prov: 0.5 } });
  const both = rows.filter((r) => r.by.fed && r.by.prov);
  const worst = Math.max(...both.map((r) => Math.max(Math.abs(r.t.fed - 0.6), Math.abs(r.t.prov - 0.6), Math.abs(r.agg - 0.6))));
  ok(`target=${target}: ${both.length} rows with both sides, all at 0.6 (worst drift ${worst.toExponential(1)})`, worst < 1e-12);
  ok(`target=${target}: rows with a side missing are flagged partial`, rows.filter((r) => !(r.by.fed && r.by.prov)).every((r) => r.partial));
}
// A federal-only ranking needs no provincial layer at all.
const fedOnly = T.score(T.rowsOnUnit('fed', [{ id: 'fed', values: fedU, pairs: null }], labels), { weights: { fed: 1 } });
ok(`federal-only rows: ${fedOnly.length} of ${fed.length}, none partial`, fedOnly.length === fed.length && fedOnly.every((r) => !r.partial && Math.abs(r.agg - 0.6) < 1e-12));

console.log('\n== Apportionment of ballots that have no polygon ==');
const vals = new Map();
fed.forEach((f, i) => vals.set(i, unit(100 + 15 * i, 300 + 20 * i, 1 + (i % 4), { district: i < 8 ? '59035' : '59036' })));
const extra = new Map([
  ['59035', { total: 900, rejected: 10, parties: new Map([['A', 500], ['B', 400]]), units: 3 }],
  ['59036', { total: 400, rejected: 0, parties: new Map([['A', 100], ['B', 300]]), units: 2 }],
]);
for (const basis of ['votes', 'electors']) {
  const { values: ap, apportioned } = T.apportionUnmatched(vals, extra, { basis });
  near(`${basis}: total apportioned equals the district pools`, apportioned, 1310, 1e-9);
  const gained = [...ap.values()].reduce((a, u) => a + T.ballots(u), 0) - [...vals.values()].reduce((a, u) => a + T.ballots(u), 0);
  near(`${basis}: ballots gained across all units equal the pools`, gained, 1310, 1e-9);
  ok(`${basis}: electors untouched`, [...ap.keys()].every((k) => ap.get(k).electors === vals.get(k).electors));
  ok(`${basis}: originals untouched`, vals.get(0).total === 100 && (vals.get(0).apportioned || 0) === 0);
  const ratio = (k) => T.rate(ap.get(k)) / T.rate(vals.get(k));
  const shift = (k) => T.rate(ap.get(k)) - T.rate(vals.get(k));
  const inD1 = [0, 1, 2, 3, 4, 5, 6, 7], inD2 = [8, 9, 10, 11, 12, 13, 14, 15];
  if (basis === 'votes') {
    ok('votes basis multiplies every turnout in a district by one constant',
       inD1.every((k) => Math.abs(ratio(k) - ratio(0)) < 1e-12) && inD2.every((k) => Math.abs(ratio(k) - ratio(8)) < 1e-12));
  } else {
    ok('electors basis adds one constant to every turnout in a district',
       inD1.every((k) => Math.abs(shift(k) - shift(0)) < 1e-12) && inD2.every((k) => Math.abs(shift(k) - shift(8)) < 1e-12));
  }
  near(`${basis}: party votes conserved`, [...ap.values()].reduce((a, u) => a + u.parties.get('A'), 0),
       [...vals.values()].reduce((a, u) => a + u.parties.get('A'), 0) + 600, 1e-9);
}

console.log('\n== Merged polls ==');
const keyOpts = { ignoreLeadingZeros: true, ignoreCase: true };
const units = new Map();
const put = (poll, total, electors, mergeWith = '') =>
  units.set(R.makeKey(['59035', poll], keyOpts), unit(total, electors, 0, { poll, mergeWith }));
put('12', 500, 400);          // receives poll 13's ballots
put('13', 0, 300, '12');      // merged into 12, keeps its own electors
put('14', 220, 350);          // untouched
put('20', 0, 100, '99');      // names a poll that does not exist
const res = R.resolveMerges(units, keyOpts);
const u12 = units.get(R.makeKey(['59035', '12'], keyOpts)), u13 = units.get(R.makeKey(['59035', '13'], keyOpts));
ok('one group resolved, one unresolved', res.groups === 1 && res.unresolved.length === 1 && res.unresolved[0].mergeWith === '99');
near('members share one turnout', T.rate(u12), T.rate(u13));
near('group ballots conserved', u12.total + u13.total, 500, 1e-9);
near('spread pro rata to electors: 12 keeps 4/7', u12.total, 500 * 400 / 700, 1e-9);
ok('members are tagged with their group', u12.mergedGroup === u13.mergedGroup && u12.mergedGroup);
ok('an unmatched merge target leaves the unit alone', units.get(R.makeKey(['59035', '20'], keyOpts)).total === 0 && !units.get(R.makeKey(['59035', '20'], keyOpts)).mergedGroup);
// Bookkeeping style where the receiver already holds both polls' electors:
const units2 = new Map();
units2.set(R.makeKey(['59035', '12'], keyOpts), unit(500, 700, 0, { poll: '12' }));
units2.set(R.makeKey(['59035', '13'], keyOpts), unit(0, 0, 0, { poll: '13', mergeWith: '12' }));
R.resolveMerges(units2, keyOpts);
near('receiver with pooled electors keeps everything', units2.get(R.makeKey(['59035', '12'], keyOpts)).total, 500);
ok('absorbed poll with no electors takes no ballots', units2.get(R.makeKey(['59035', '13'], keyOpts)).total === 0);

console.log('\n== Scoring, ranking, cumulative ==');
const mk = (tf, tp, e) => ({ key: `${tf}|${tp}`, label: 'x', electors: e,
  by: { fed: unit(tf * e, e), prov: unit(tp * e, e) } });
const rows = [mk(0.7, 0.5, 100), mk(0.6, 0.6, 100), mk(0.4, 0.8, 100)];
T.score(rows, { weights: { fed: 1, prov: 0 } }); near('w=1 gives federal', rows[0].agg, 0.7);
T.score(rows, { weights: { fed: 0, prov: 1 } }); near('w=0 gives provincial', rows[0].agg, 0.5);
T.score(rows, { weights: { fed: 0.5, prov: 0.5 } }); near('w=0.5 gives the mean', rows[0].agg, 0.6);
near('min', rows[0].min, 0.5); near('delta = fed - prov', rows[2].delta, -0.4);
T.score(rows, { weights: { fed: 1, prov: 0 } });           // aggregates 0.7, 0.6, 0.4
const ranked = T.rank(rows, 'agg');
ok('ranked by aggregate with 1-based ranks', ranked.map((r) => r.key).join() === '0.7|0.5,0.6|0.6,0.4|0.8'
   && ranked.map((r) => r.rank).join() === '1,2,3');
const asc = T.rank(rows, 't.prov', 'asc');
ok('rank by a side ascending', asc.map((r) => r.key).join() === '0.7|0.5,0.6|0.6,0.4|0.8');
T.score(rows, { weights: { fed: 0.5, prov: 0.5 } });
const oneSide = T.score([{ key: 'k', label: 'x', electors: 100, by: { fed: unit(60, 100) } }], { weights: { fed: 0.5, prov: 0.5 } })[0];
ok('a row missing one side falls back to the present side and is partial', oneSide.agg === 0.6 && oneSide.partial && oneSide.delta === null);
const curve = T.cumulative(rows);
ok('cumulative is monotone and ends at (1,1)',
   curve.every((p, i) => i === 0 || (p.shareOfElectors >= curve[i - 1].shareOfElectors && p.shareOfAreas > curve[i - 1].shareOfAreas))
   && Math.abs(curve.at(-1).shareOfElectors - 1) < 1e-12 && Math.abs(curve.at(-1).shareOfAreas - 1) < 1e-12);
ok('equal electors put the curve on the diagonal', curve.every((p) => Math.abs(p.shareOfAreas - p.shareOfElectors) < 1e-12));
const basket = T.basketSummary(rows, new Set(['0.7|0.5', '0.4|0.8']));
near('basket pools federal ballots over electors', basket.per.fed.rate, (70 + 40) / 200);
near('basket combined', basket.agg, ((70 + 40) / 200 + (50 + 80) / 200) / 2);
ok('csv has the aggregate column and one row per unit', T.toCsv(ranked)[0].includes('turnout_agg') && T.toCsv(ranked).length === 4);

console.log('\n== Join report: unmatched ballots by district, void polls ==');
const H = ['Electoral District Number/Numéro de circonscription', 'Polling Station Number/Numéro du bureau de scrutin',
  'Void Poll Indicator/Indicateur de bureau supprimé', 'No Poll Held Indicator/Indicateur de bureau sans scrutin',
  'Merge With/Fusionné avec', 'Rejected Ballots for Polling Station/Bulletins rejetés du bureau',
  'Electors for Polling Station/Électeurs du bureau', 'Political Affiliation Name_English/Appartenance politique_Anglais',
  'Candidate Poll Votes Count/Votes du candidat pour le bureau'];
const rowsT = [];
const add = (ed, poll, v, np, mw, rej, el, party, votes) => rowsT.push([ed, poll, v, np, mw, rej, el, party, votes].map(String));
for (const poll of ['1', '2', '3']) for (const [party, votes] of [['Liberal', 120], ['NDP', 80]]) add('59035', poll, 'N', 'N', '', 4, 500, party, votes);
add('59035', '4', 'Y', 'N', '', 0, 0, 'Liberal', 0);                       // void poll
for (const [party, votes] of [['Liberal', 300], ['NDP', 200]]) add('59035', '600', 'N', 'N', '', 9, 2000, party, votes); // advance
for (const [party, votes] of [['Liberal', 50], ['NDP', 70]]) add('59036', '601', 'N', 'N', '', 1, 900, party, votes);   // advance, other riding
const table = { header: H, rows: rowsT };
const mapping = R.detectLayout(H, rowsT);
ok('bookkeeping columns detected', mapping.mergeWith === 4 && mapping.voidPoll === 2 && mapping.noPoll === 3);
const feats = ['1-0', '2-0', '3-0', '4-0'].map((poll) => ({ type: 'Feature', properties: { fed: '59035', poll }, geometry: null }));
const joined = R.join(feats, { district: 'fed', poll: 'poll', federalSuffixes: true }, table, mapping);
const byD = joined.report.unmatchedByDistrict;
near('district 59035 unmatched total', byD.get('59035').total, 500, 1e-9);
near('district 59035 unmatched rejected', byD.get('59035').rejected, 9, 1e-9);
near('district 59036 unmatched total', byD.get('59036').total, 120, 1e-9);
near('sum over districts equals unmatchedVotes', [...byD.values()].reduce((a, d) => a + d.total, 0), joined.report.unmatchedVotes, 1e-9);
ok('void poll counted and carries no ballots', joined.report.voidPolls === 1 && joined.values.get(3).total === 0 && joined.values.get(3).flags.void);
near('electorsMatched sums matched units once', joined.report.electorsMatched, 1500, 1e-9);
ok('electors column flagged present', joined.report.electorsColumn === true);

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll turnout tests passed.\n');
process.exit(fails ? 1 : 0);
