const { load } = require('./harness');
const { Analysis: An, Geo } = load(['a-geo.js','e-analysis.js'], ['Analysis','Geo']);
let fails = 0;
const ok = (n, c, e = '') => { if (c) console.log(`  PASS  ${n}`); else { console.log(`  FAIL  ${n} ${e}`); fails++; } };
const near = (n, a, b, tol) => ok(`${n} (${a == null ? 'null' : a.toFixed(5)} ~ ${b})`, a != null && Math.abs(a - b) <= tol, `diff ${a == null ? 'null' : Math.abs(a-b)}`);

const drain = (gen) => { let r = gen.next(); while (!r.done) r = gen.next(); return r.value; };
const cell = (x0, y0, w, h, props) => ({ type:'Feature', properties: props, geometry:{ type:'Polygon',
  coordinates: [[[x0,y0],[x0+w,y0],[x0+w,y0+h],[x0,y0+h],[x0,y0]]] } });

console.log('\n== Crosswalk against analytically known overlaps ==');
// Federal grid: 4x4 cells of 0.02 deg starting at (-123.16, 49.20).
// Provincial grid: the same grid shifted half a cell both ways, so every
// interior federal cell is split 25/25/25/25 across four provincial cells.
const S = 0.02, X0 = -123.16, Y0 = 49.20;
const fed = [], prov = [];
for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) fed.push(cell(X0 + i*S, Y0 + j*S, S, S, { id:`F${i}${j}` }));
for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) prov.push(cell(X0 + (i+0.5)*S, Y0 + (j+0.5)*S, S, S, { id:`P${i}${j}` }));

const cw = drain(An.crosswalkRunner(fed, prov, { spacingM: 25 }));
ok('layers overlap', cw.overlap === true);
const pairs = An.crosswalkPairs(cw);

// Federal cell (1,1) is interior: it must split evenly across 4 provincial cells.
const interior = fed.findIndex(f => f.properties.id === 'F11');
const forInterior = pairs.filter(p => p.fi === interior);
ok('interior federal cell overlaps exactly 4 provincial cells', forInterior.length === 4,
   `got ${forInterior.length}`);
for (const p of forInterior) near(`  share of F11 in ${prov[p.pi].properties.id}`, p.shareOfFed, 0.25, 0.01);
near('shares of F11 sum to 1', forInterior.reduce((s,p)=>s+p.shareOfFed,0), 1, 0.005);

// A provincial cell fully inside the federal grid draws from 4 federal cells.
const pIdx = prov.findIndex(f => f.properties.id === 'P11');
const forProv = pairs.filter(p => p.pi === pIdx);
ok('interior provincial cell overlaps exactly 4 federal cells', forProv.length === 4, `got ${forProv.length}`);
near('shares of P11 sum to 1', forProv.reduce((s,p)=>s+p.shareOfProv,0), 1, 0.005);

console.log('\n== Redistribution conserves votes ==');
// Give every federal cell votes; move them onto provincial cells.
const fedValues = new Map();
fed.forEach((f, i) => fedValues.set(i, { total: 100 + i, parties: new Map([['A', 60 + i], ['B', 40]]) }));
const moved = An.redistribute(pairs, fedValues, { from: 'fed' });
let movedTotal = 0; for (const v of moved.values()) movedTotal += v.total;
// Only the interior 3x3 of the federal grid is fully covered by provincial
// cells, so the conserved quantity is the vote mass inside the overlap.
let expected = 0;
for (const p of pairs) expected += fedValues.get(p.fi).total * p.shareOfFed;
near('total votes preserved through redistribution', movedTotal, expected, 1e-9);
let movedA = 0; for (const v of moved.values()) movedA += v.parties.get('A') || 0;
let expectedA = 0; for (const p of pairs) expectedA += fedValues.get(p.fi).parties.get('A') * p.shareOfFed;
near('party votes preserved', movedA, expectedA, 1e-9);

console.log('\n== Identical geographies reproduce the source exactly ==');
const same = drain(An.crosswalkRunner(fed, fed.map(f => JSON.parse(JSON.stringify(f))), { spacingM: 25 }));
const samePairs = An.crosswalkPairs(same);
ok('one-to-one crosswalk', samePairs.length === fed.length, `got ${samePairs.length}`);
ok('every share is 1', samePairs.every(p => Math.abs(p.shareOfFed - 1) < 1e-12 && Math.abs(p.shareOfProv - 1) < 1e-12));
const back = An.redistribute(samePairs, fedValues, { from: 'fed' });
near('votes land unchanged', back.get(5).total, fedValues.get(5).total, 1e-9);

console.log('\n== Statistics ==');
// Reference values computed independently below in Python.
const xs = [1, 2, 3, 4, 5, 6, 7, 8], ys = [2, 1, 4, 3, 7, 5, 9, 8];
near('pearson r', An.pearson(xs, ys), 0.89489051649, 1e-9);
near('spearman rho', An.spearman(xs, ys), 0.90476190476, 1e-9);
const fit = An.linearFit(xs, ys);
near('slope', fit.slope, 1.05952380952, 1e-9);
near('intercept', fit.intercept, 0.10714285714, 1e-9);
near('perfect positive', An.pearson([1,2,3],[2,4,6]), 1, 1e-12);
near('perfect negative', An.pearson([1,2,3],[6,4,2]), -1, 1e-12);
ok('constant series has no correlation', An.pearson([1,2,3],[5,5,5]) === null);
ok('too few points', An.pearson([1,2],[3,4]) === null);
// Ranks with ties must be averaged.
ok('tied ranks averaged', JSON.stringify(An.rankOf([10, 20, 20, 30])) === JSON.stringify([1, 2.5, 2.5, 4]),
   JSON.stringify(An.rankOf([10,20,20,30])));
const ci = An.pearsonCI(0.89489051649, 8);
ok(`Fisher CI brackets r (${ci[0].toFixed(3)}, ${ci[1].toFixed(3)})`, ci[0] < 0.8949 && ci[1] > 0.8949);

console.log('\n== Weighted correlation responds to weights ==');
// One outlier with a tiny weight should barely move the weighted coefficient.
const wx = [0.1,0.2,0.3,0.4,0.5,0.9], wy = [0.1,0.2,0.3,0.4,0.5,0.1];
const rPlain = An.pearson(wx, wy);
const rW = An.pearson(wx, wy, [10,10,10,10,10,0.001]);
ok(`weighting down the outlier raises r (${rPlain.toFixed(3)} -> ${rW.toFixed(3)})`, rW > rPlain + 0.4);

console.log('\n== End-to-end correlation on the offset grids ==');
const provValues = new Map();
// Build provincial results that are a known linear function of position so the
// correlation with the federal pattern is predictable and strong.
prov.forEach((f, i) => {
  const share = 0.2 + 0.05 * (i % 4);
  provValues.set(i, { total: 200, parties: new Map([['NDP', 200 * share], ['Other', 200 * (1 - share)]]) });
});
const fedValues2 = new Map();
fed.forEach((f, i) => {
  const share = 0.25 + 0.05 * (i % 4);
  fedValues2.set(i, { total: 150, parties: new Map([['LPC', 150 * share], ['Other', 150 * (1 - share)]]) });
});
const labels = { fed: (i) => fed[i].properties.id, prov: (i) => prov[i].properties.id };
for (const unit of ['prov', 'fed', 'atom']) {
  const rows = An.comparisonRows(cw, pairs, fedValues2, provValues, unit, labels, 0);
  const res = An.correlate(rows, 'LPC', 'NDP');
  ok(`unit=${unit}: n=${res.n}, r=${res.r == null ? 'n/a' : res.r.toFixed(3)}`, res.n > 0 && res.r != null);
  ok(`unit=${unit}: shares stay within [0,1]`, res.points.every(p => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1));
  ok(`unit=${unit}: strong positive correlation recovered`, res.r > 0.6, `r=${res.r}`);
}

console.log('\n== Disjoint layers are reported, not crashed ==');
const far = [cell(-100, 10, 1, 1, { id: 'X' })];
const none = drain(An.crosswalkRunner(fed, far, { spacingM: 200 }));
ok('no overlap flagged', none.overlap === false);
ok('no pairs', An.crosswalkPairs(none).length === 0);

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll analysis tests passed.\n');
process.exit(fails ? 1 : 0);
