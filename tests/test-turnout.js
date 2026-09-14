const { load } = require('./harness');
const { Analysis: An, Results: R, Turnout: T } =
  load(['a-geo.js', 'e-analysis.js', 'f-results.js', 'f2-turnout.js'], ['Analysis', 'Results', 'Turnout']);
let fails = 0;
const ok = (n, c, e = '') => { if (c) console.log(`  PASS  ${n}`); else { console.log(`  FAIL  ${n} ${e}`); fails++; } };
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b),
  `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
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

console.log('\n== A target geography whose own source has no electors ==');
/* The real case: 2024 provincial results arrive per voting place with no
   elector column, and Elections BC publishes registered voters per electoral
   district only. So a voting area has ballots and electors of zero, and a
   reference count taken from the native source would be zero for every row --
   and the "drop areas under 50 electors" default would then empty the table. */
const noE = new Map();
prov.forEach((f, i) => noE.set(i, unit(0.55 * (350 + 11 * i), 0, 0.05 * (350 + 11 * i))));
const mixed = [{ id: 'fed', values: fedU, pairs }, { id: 'prov', values: noE, pairs }];
const kept = T.score(T.rowsOnUnit('prov', mixed, labels, { minElectors: 50 }),
                     { weights: { fed: 0.5, prov: 0.5 } });
ok(`rows survive the default minimum: ${kept.length} of ${prov.length}`, kept.length > 0);
ok('the reference count is the federal electors carried in, never zero',
   kept.every((r) => r.electors > 0 && r.by.fed && Math.abs(r.electors - r.by.fed.electors) < 1e-9));
ok('a provincial row with no electors still reports no provincial turnout',
   kept.every((r) => r.t.prov === null && r.partial));
ok('and expected ballots stop being zero', kept.every((r) => r.expected > 0));
const strict = T.rowsOnUnit('prov', mixed, labels, { minElectors: 1e9 });
ok('the minimum still filters, on a count that means something', strict.length === 0);

console.log('\n== Two denominators, neither of them an electorate ==');
/* Provincial ballots over the federal electors already on the row, and over a
   census count supplied from outside. Never written to t, agg or expected. */
const part = T.participation(kept.map((r) => ({ ...r })), {
  side: 'prov',
  adultsOf: (r) => r.by.fed.electors * 1.25,   // more residents than registrants
});
const one = part[0];
near('ballots over the federal electors carried onto this row',
     one.p.perFedElector, T.ballots(one.by.prov) / one.by.fed.electors);
near('ballots over the supplied resident count',
     one.p.perAdult, T.ballots(one.by.prov) / (one.by.fed.electors * 1.25));
near('the spread is the difference between the two',
     one.p.spread, one.p.perFedElector - one.p.perAdult);
ok('a larger denominator always gives the smaller ratio',
   part.every((r) => r.p.perAdult < r.p.perFedElector && r.p.spread > 0));
ok('both denominators travel with the ratio, so a reader can recompute',
   part.every((r) => r.p.fedElectors > 0 && r.p.adults > 0));
ok('nothing here reaches turnout: t, agg and expected are untouched',
   part.every((r, i) => r.t.prov === null && r.agg === kept[i].agg && r.expected === kept[i].expected));

const edge = T.participation([
  { by: { prov: unit(100, 0, 4), fed: { electors: 0 } } },
  { by: { prov: unit(0, 0, 0), fed: { electors: 250 } } },
  { by: { fed: { electors: 250 } } },
], { side: 'prov', adultsOf: (r) => (r.by.prov ? null : 300) });
ok('a denominator of zero gives null, never Infinity and never zero',
   edge[0].p.perFedElector === null && edge[0].p.fedElectors === null);
near('zero ballots over a real denominator is zero, not null', edge[1].p.perFedElector, 0);
ok('and a missing resident count leaves only the spread absent',
   edge[1].p.perAdult === null && edge[1].p.spread === null);
ok('a row with no provincial ballots at all reports nothing',
   edge[2].p.ballots === null && edge[2].p.perFedElector === null && edge[2].p.perAdult === null);
ok('rows over 100% are counted rather than hidden',
   T.overOne(T.participation([{ by: { prov: unit(400, 0, 0), fed: { electors: 100 } } }],
                             { side: 'prov' }), 'perFedElector') === 1);

console.log('\n== The two denominators reach the export ==');
const pcsv = T.toCsv(T.rank(part, 'agg'));
const ph = pcsv[0];
ok('both ratios, the census denominator and the spread are columns',
   ['residents_15_plus', 'prov_per_fed_elector', 'prov_per_resident_15_plus', 'denominator_spread']
     .every((c) => ph.includes(c)), ph.join(','));
ok('the federal denominator is already a column and is not repeated',
   ph.filter((c) => c === 'fed_electors').length === 1);
ok('every row is the same width', new Set(pcsv.map((r) => r.length)).size === 1);
near('a ratio reaches the file as the number it is',
     parseFloat(pcsv[1][ph.indexOf('prov_per_fed_elector')]),
     T.rank(part, 'agg')[0].p.perFedElector, 1e-6);
const plainCsv = T.toCsv(kept);
ok('a ranking with no participation carries no participation columns',
   !plainCsv[0].includes('prov_per_fed_elector'));

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

console.log('\n== A district that straddles the edge of the study area ==');
/* Vancouver Fraserview--South Burnaby is two thirds Vancouver by electors. Its
   advance ballots were cast by the whole riding, so handing all of them to the
   two thirds that is on screen inflates it. Only that share is spread, and
   only over the units inside. */
const half = new Set([0, 1, 2, 3]);                 // four of district 59035's eight
const straddle = T.apportionUnmatched(vals, new Map([['59035', extra.get('59035')]]),
  { basis: 'electors', inArea: half, share: new Map([['59035', 0.5]]) });
const pool = extra.get('59035').total + extra.get('59035').rejected;
near('only the district\'s own share is spread', straddle.apportioned, pool * 0.5, 1e-9);
near('and the rest is withheld rather than dropped quietly', straddle.withheld, pool * 0.5, 1e-9);
let got = 0, outside = 0;
for (const [i, u] of straddle.values) {
  if (half.has(i)) got += u.apportioned || 0;
  else outside += u.apportioned || 0;
}
near('every apportioned ballot lands inside the study area', got, pool * 0.5, 1e-9);
ok('and not one lands outside it', outside === 0, String(outside));
ok('units outside keep exactly the ballots they were reported with',
   [...straddle.values].filter(([i]) => !half.has(i) && i < 8)
     .every(([i, u]) => u.total === vals.get(i).total && u.rejected === vals.get(i).rejected));
/* Without either option the behaviour is the one every other file gets. */
const plain = T.apportionUnmatched(vals, extra, { basis: 'electors' });
near('no study area and no share: the whole pool is spread, as before',
     plain.apportioned, 1310, 1e-9);
near('and nothing is withheld', plain.withheld, 0, 1e-9);
let plainSum = 0;
for (const u of new Set(plain.values.values())) plainSum += u.apportioned || 0;
near('which is still conserved across the units', plainSum, 1310, 1e-6);

console.log('\n== Advance polls land on the divisions that fed them ==');
/* Elections Canada names the advance poll each ordinary division reported to,
   so nearly half the federal vote can go to the ten or so divisions that fed
   an advance poll instead of the two hundred in its riding. */
const advOf = (i) => (i < 4 ? '600' : i < 8 ? '601' : null);   // 59035 has two advance polls
const advPools = new Map([
  ['59035|600', { total: 400, rejected: 4, parties: new Map([['A', 240], ['B', 160]]), units: 1,
                  district: '59035', advPoll: '600' }],
  ['59035|601', { total: 200, rejected: 0, parties: new Map([['A', 120], ['B', 80]]), units: 1,
                  district: '59035', advPoll: '601' }],
]);
const byAdv = T.apportionUnmatched(vals, new Map(), { basis: 'electors', byAdvance: advPools, advOf });
near('every advance ballot is placed', byAdv.apportioned, 604, 1e-9);
ok('both pools were spread, and the served sets counted',
   byAdv.advancePools === 2 && byAdv.advanceUnitsMean === 4,
   `${byAdv.advancePools} pools, mean ${byAdv.advanceUnitsMean}`);
let got600 = 0, got601 = 0, elsewhere = 0;
for (const [i, u] of byAdv.values) {
  const a = u.apportioned || 0;
  if (i < 4) got600 += a; else if (i < 8) got601 += a; else elsewhere += a;
}
near('poll 600 goes only to the four divisions that fed it', got600, 404, 1e-9);
near('and poll 601 only to its own four', got601, 200, 1e-9);
ok('no division outside a served set receives anything', elsewhere === 0, String(elsewhere));
/* Electors, not equal shares: the divisions of a served set are roughly but
   not exactly the same size, and vals gives each a different count. */
const share0 = (byAdv.values.get(0).apportioned) / 404;
const even = 1 / 4;
ok(`a bigger division takes a bigger share (${share0.toFixed(3)} against ${even} if split evenly)`,
   Math.abs(share0 - even) > 1e-6);
near('but the shares still add to one',
     [0, 1, 2, 3].reduce((a, i) => a + byAdv.values.get(i).apportioned / 404, 0), 1, 1e-9);

/* A pool whose divisions are all outside the study area gives this area
   nothing -- no share to assume, no early-voting rate to guess at. */
const onlyFirst = new Set([0, 1, 2, 3]);
const narrowed = T.apportionUnmatched(vals, new Map(),
  { basis: 'electors', byAdvance: advPools, advOf, inArea: onlyFirst });
near('an advance poll serving only ground outside the area gives it nothing',
     narrowed.apportioned, 404, 1e-9);
near('and those ballots are withheld, not moved somewhere else', narrowed.withheld, 200, 1e-9);

/* A pool the boundary file knows no divisions for falls back to the district,
   rather than vanishing. */
const unknown = new Map([['59035|699', { total: 100, rejected: 0, parties: new Map([['A', 100]]),
                                         units: 1, district: '59035', advPoll: '699' }]]);
const fall = T.apportionUnmatched(vals, new Map(), { basis: 'electors', byAdvance: unknown, advOf });
near('an advance poll with no known divisions falls back to the district', fall.apportioned, 100, 1e-9);
ok('and it lands district-wide rather than on one served set',
   fall.advancePools === 0 && [...fall.values].filter(([i]) => i < 8).every(([i, u]) => u.apportioned > 0));

/* Nothing here touches a file that has no advance mapping at all. */
const none = T.apportionUnmatched(vals, extra, { basis: 'electors' });
near('a file with no advance data behaves exactly as before', none.apportioned, 1310, 1e-9);
ok('and reports no advance pools', none.advancePools === 0 && none.advanceUnitsMean === null);

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
/* Polls 600 and 601 are advance polls, so they sit in their own bucket now,
   waiting for the divisions that fed them. The bookkeeping is the same. */
const byA = joined.report.unmatchedByAdvancePoll;
near('district 59035 unmatched total', byA.get('59035|600').total, 500, 1e-9);
near('district 59035 unmatched rejected', byA.get('59035|600').rejected, 9, 1e-9);
near('district 59036 unmatched total', byA.get('59036|601').total, 120, 1e-9);
near('sum over every unmatched pool equals unmatchedVotes',
     [...byA.values(), ...joined.report.unmatchedByDistrict.values()]
       .reduce((a, d) => a + d.total, 0), joined.report.unmatchedVotes, 1e-9);
ok('void poll counted and carries no ballots', joined.report.voidPolls === 1 && joined.values.get(3).total === 0 && joined.values.get(3).flags.void);
near('electorsMatched sums matched units once', joined.report.electorsMatched, 1500, 1e-9);
ok('electors column flagged present', joined.report.electorsColumn === true);

/* --- Columns the application adds -----------------------------------------
   A loaded file of places rides along in the export. toCsv must not need to
   know what that is, and above all the header and the rows must stay the same
   length: a header count that does not match its values shifts every column
   after it, and a spreadsheet then says something false under a name that
   looks right. */
console.log('\n== Application columns in the export ==');
const exRows = [
  { rank: 1, key: '0', label: 'A', electors: 100, by: {}, ballots: {}, t: {}, agg: 0.5, partial: false },
  { rank: 2, key: '1', label: 'B', electors: 200, by: {}, ballots: {}, t: {}, agg: 0.4, partial: false },
];
const bare = T.toCsv(exRows);
const withExtra = T.toCsv(exRows, ['fed', 'prov'],
  { headers: ['points_count', 'points_noun'], of: (r) => [r.key === '0' ? 7 : 0, 'electors'] });
eq('no extra columns leaves the export exactly as it was',
   [bare[0].length, bare.length], [T.toCsv(exRows)[0].length, 3]);
eq('the headers are appended at the end', withExtra[0].slice(-2), ['points_count', 'points_noun']);
eq('and each row carries its own values', [withExtra[1].slice(-2), withExtra[2].slice(-2)],
   [[7, 'electors'], [0, 'electors']]);
eq('the extra columns are exactly two wider', withExtra[0].length - bare[0].length, 2);

let shifted = '';
try {
  T.toCsv(exRows, ['fed', 'prov'], { headers: ['a', 'b'], of: () => ['only one'] });
} catch (e) { shifted = e.message; }
ok('a header count that does not match its values is refused, not written',
   /do not line up/.test(shifted), shifted);

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll turnout tests passed.\n');
process.exit(fails ? 1 : 0);
