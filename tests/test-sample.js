const fs = require('fs');
const { load } = require('./harness');
const { Analysis: An, Geo, Turnout } = load(['a-geo.js', 'e-analysis.js', 'f2-turnout.js'], ['Analysis', 'Geo', 'Turnout']);
let fails = 0;
const ok = (n, c, e = '') => { if (c) console.log(`  PASS  ${n}`); else { console.log(`  FAIL  ${n} ${e}`); fails++; } };
const near = (n, a, b, tol) => ok(`${n} (${a == null ? 'null' : (+a).toFixed(5)} ~ ${b})`, a != null && Math.abs(a - b) <= tol, `diff ${a == null ? 'null' : Math.abs(a - b)}`);
const drain = (gen) => { let r = gen.next(); while (!r.done) r = gen.next(); return r.value; };
const cell = (x0, y0, w, h, props) => ({ type: 'Feature', properties: props, geometry: { type: 'Polygon',
  coordinates: [[[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h], [x0, y0]]] } });

/* The lattice runner exactly as it was before the sample table existed, so
   the new code is checked against the old numbers rather than against itself. */
function legacyRunner(fedFeatures, provFeatures, spacingM) {
  const fedIndex = Geo.buildIndex(fedFeatures), provIndex = Geo.buildIndex(provFeatures);
  const minX = Math.max(fedIndex.extent[0], provIndex.extent[0]), minY = Math.max(fedIndex.extent[1], provIndex.extent[1]);
  const maxX = Math.min(fedIndex.extent[2], provIndex.extent[2]), maxY = Math.min(fedIndex.extent[3], provIndex.extent[3]);
  const cells = new Map(), fedCount = new Float64Array(fedFeatures.length), provCount = new Float64Array(provFeatures.length);
  const dLat = spacingM / 110574, rows = Math.max(1, Math.ceil((maxY - minY) / dLat));
  let points = 0;
  for (let r = 0; r < rows; r++) {
    const lat = minY + (r + 0.5) * dLat;
    const dLon = spacingM / (111320 * Math.cos(lat * Math.PI / 180));
    for (let x = minX + dLon / 2; x <= maxX; x += dLon) {
      points++;
      const fi = fedIndex.hit(x, lat), pi = provIndex.hit(x, lat);
      if (fi < 0 && pi < 0) continue;
      if (fi >= 0) fedCount[fi]++;
      if (pi >= 0) provCount[pi]++;
      if (fi >= 0 && pi >= 0) { const key = fi * provFeatures.length + pi; cells.set(key, (cells.get(key) || 0) + 1); }
    }
  }
  return { cells, fedCount, provCount, points };
}
function sameCells(name, a, b) {
  let same = a.cells.size === b.cells.size && a.points === b.points;
  for (const [k, v] of a.cells) if (b.cells.get(k) !== v) { same = false; break; }
  for (let i = 0; i < a.fedCount.length && same; i++) if (a.fedCount[i] !== b.fedCount[i]) same = false;
  for (let i = 0; i < a.provCount.length && same; i++) if (a.provCount[i] !== b.provCount[i]) same = false;
  ok(`${name}: ${a.cells.size} cells, ${a.points} points, identical`, same);
}

// Federal grid: 4x4 cells of 0.02 deg; provincial grid the same, shifted half a
// cell both ways; blocks: every federal cell split into four quarters.
const S = 0.02, X0 = -123.16, Y0 = 49.20;
const fed = [], prov = [], blocks = [];
for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) fed.push(cell(X0 + i * S, Y0 + j * S, S, S, { id: `F${i}${j}` }));
for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) prov.push(cell(X0 + (i + 0.5) * S, Y0 + (j + 0.5) * S, S, S, { id: `P${i}${j}` }));
for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (const [qx, qy, q] of [[0, 0, 'SW'], [1, 0, 'SE'], [0, 1, 'NW'], [1, 1, 'NE']]) {
  blocks.push(cell(X0 + i * S + qx * S / 2, Y0 + j * S + qy * S / 2, S / 2, S / 2, { id: `B${i}${j}${q}`, fed: i * 4 + j, q }));
}
const F = (id) => fed.findIndex((f) => f.properties.id === id);
const P = (id) => prov.findIndex((f) => f.properties.id === id);

console.log('\n== The sample table reproduces the old lattice cell for cell ==');
sameCells('offset grids at 25 m', drain(An.crosswalkRunner(fed, prov, { spacingM: 25 })), legacyRunner(fed, prov, 25));
const van = JSON.parse(fs.readFileSync('boundaries/fed_polls.geojson', 'utf8')).features
  .filter((f) => ['59035', '59036', '59037', '59038', '59039', '59040'].includes(f.properties.fed) && !f.properties.jurisdiction);
let e = [Infinity, Infinity, -Infinity, -Infinity];
for (const f of van) { const g = Geo.bboxOf(f.geometry); e = [Math.min(e[0], g[0]), Math.min(e[1], g[1]), Math.max(e[2], g[2]), Math.max(e[3], g[3])]; }
const synth = [];
for (let i = 0; i < 32; i++) for (let j = 0; j < 25; j++) {
  const w = (e[2] - e[0]) / 32, h = (e[3] - e[1]) / 25;
  synth.push(cell(e[0] + i * w + w * 0.13, e[1] + j * h + h * 0.37, w, h, { va: `${i}-${j}` }));
}
sameCells('Vancouver polls vs 800 synthetic areas at 40 m', drain(An.crosswalkRunner(van, synth, { spacingM: 40 })), legacyRunner(van, synth, 40));

console.log('\n== Anchor extent: an edge cell keeps its true coverage ==');
const layers = [{ features: fed }, { features: prov }, { features: blocks }];
const sample = drain(An.sampleLattice(layers, { spacingM: 25 }));   // extent = the federal grid
ok(`sample stored ${sample.n} of ${sample.points} points across ${sample.hits.length} layers`, sample.hits.length === 3 && sample.n > 0 && sample.n <= sample.points);
const cw = An.crosswalkBetween(sample, 0, 1);
const cov = An.coverage(cw);
near('corner cell F00 is a quarter inside the provincial layer', cov.a[F('F00')], 0.25, 0.01);
near('edge cell F10 is half inside', cov.a[F('F10')], 0.5, 0.01);
near('interior cell F11 is wholly inside', cov.a[F('F11')], 1, 1e-9);
const old = drain(An.crosswalkRunner(fed, prov, { spacingM: 25 }));
ok('the two-layer runner (intersection extent) reports the corner cell as fully covered, as before',
   Math.abs(An.coverage(old).fed[F('F00')] - 1) < 1e-9);
const pairs = An.crosswalkPairs(cw);
const f11 = pairs.filter((p) => p.ai === F('F11'));
ok('pairs carry both namings', f11.every((p) => p.fi === p.ai && p.pi === p.bi && p.shareOfFed === p.shareOfA && p.shareOfProv === p.shareOfB));
near('F11 still splits evenly (share of one quarter)', f11.find((p) => p.bi === P('P11')).shareOfA, 0.25, 0.01);

console.log('\n== Weights ==');
const flat = new Float64Array(sample.n).fill(2.5);
const cwFlat = An.crosswalkBetween(sample, 0, 1, { weights: flat });
const pFlat = new Map(An.crosswalkPairs(cwFlat).map((p) => [p.ai + '|' + p.bi, p]));
let maxDiff = 0;
for (const p of pairs) { const q = pFlat.get(p.ai + '|' + p.bi); maxDiff = Math.max(maxDiff, Math.abs(q.shareOfA - p.shareOfA), Math.abs(q.shareOfB - p.shareOfB)); }
ok(`a constant weight changes no share (max diff ${maxDiff.toExponential(1)})`, maxDiff < 1e-12);

const popNE = blocks.map((b) => (b.properties.q === 'NE' ? 100 : 0));
const w = An.pointWeights(sample, 2, popNE);
const hitsB = sample.hits[2];
const perBlock = new Float64Array(blocks.length), cntBlock = new Float64Array(blocks.length);
for (let p = 0; p < sample.n; p++) if (hitsB[p] >= 0) { perBlock[hitsB[p]] += w[p]; cntBlock[hitsB[p]]++; }
const ne = blocks.findIndex((b) => b.properties.q === 'NE');
near(`a populated block's points carry its whole population (${cntBlock[ne]} points)`, perBlock[ne], 100, 1e-9);
const onePoint = hitsB.findIndex((h) => h === ne);
near('each of its points carries pop / points', w[onePoint], 100 / cntBlock[ne], 1e-12);
ok('points in empty blocks weigh nothing', [...hitsB].every((h, p) => h < 0 || blocks[h].properties.q === 'NE' || w[p] === 0));
const cwW = An.crosswalkBetween(sample, 0, 1, { weights: w });
const pw = An.crosswalkPairs(cwW);
ok('population-weighted crosswalk marks itself weighted', cwW.weighted === true && cwW.areaFallback.a.length === 0);
const f11w = pw.filter((p) => p.ai === F('F11'));
near('with people only in the NE quarter, all of F11 goes to P11', f11w.find((p) => p.bi === P('P11')).shareOfA, 1, 1e-9);
ok('and nothing to its other three neighbours', f11w.filter((p) => p.bi !== P('P11')).every((p) => p.shareOfA === 0));

console.log('\n== A zero-population feature falls back to area ==');
const popPark = popNE.slice();
blocks.forEach((b, i) => { if (b.properties.fed === F('F22')) popPark[i] = 0; });
const wPark = An.pointWeights(sample, 2, popPark);
const cwPark = An.crosswalkBetween(sample, 0, 1, { weights: wPark });
ok('the park cell is listed as an area fallback', cwPark.areaFallback.a.includes(F('F22')), JSON.stringify(cwPark.areaFallback));
const f22 = An.crosswalkPairs(cwPark).filter((p) => p.ai === F('F22'));
ok('its four overlaps carry area shares again', f22.length === 4 && f22.every((p) => Math.abs(p.shareOfA - 0.25) < 0.01), JSON.stringify(f22.map((p) => +p.shareOfA.toFixed(3))));
near('the fallback weight is the mean point weight', cwPark.fallbackWeight, wPark.reduce((a, b) => a + b, 0) / sample.n, 1e-9);

console.log('\n== A third layer as the target: turnout is invariant, with and without weights ==');
const fedVals = new Map(), provVals = new Map();
fed.forEach((f, i) => { const E = 300 + 37 * i; fedVals.set(i, { total: 0.6 * E - 3, rejected: 3, electors: E, parties: new Map([['A', 0.6 * E - 3]]) }); });
prov.forEach((f, i) => { const E = 500 + 11 * i; provVals.set(i, { total: 0.6 * E - 5, rejected: 5, electors: E, parties: new Map([['X', 0.6 * E - 5]]) }); });
const labels = { fed: (i) => fed[i].properties.id, prov: (i) => prov[i].properties.id, db: (i) => blocks[i].properties.id };
for (const [name, weights] of [['area', null], ['population', w]]) {
  const fedDb = An.crosswalkPairs(An.crosswalkBetween(sample, 0, 2, { weights }));
  const provDb = An.crosswalkPairs(An.crosswalkBetween(sample, 1, 2, { weights }));
  const rows = Turnout.score(Turnout.rowsOnUnit('db',
    [{ id: 'fed', values: fedVals, pairs: fedDb, side: 'a' }, { id: 'prov', values: provVals, pairs: provDb, side: 'a' }],
    labels, { minElectors: 1 }), { weights: { fed: 0.5, prov: 0.5 } });
  const both = rows.filter((r) => r.by.fed && r.by.prov);
  const worst = Math.max(...both.map((r) => Math.max(Math.abs(r.t.fed - 0.6), Math.abs(r.t.prov - 0.6), Math.abs(r.agg - 0.6))));
  ok(`${name}: ${both.length} blocks carry both elections at exactly 0.6 (worst ${worst.toExponential(1)})`, both.length > 30 && worst < 1e-12);
  let moved = 0; for (const r of rows) if (r.by.fed) moved += r.by.fed.electors;
  let expected = 0; for (const p of fedDb) expected += fedVals.get(p.ai).electors * p.shareOfA;
  near(`${name}: federal electors conserved onto blocks`, moved, expected, 1e-9);
}

console.log('\n== Small-feature repair with the new names ==');
const tiny = cell(X0 + 1.7 * S, Y0 + 1.7 * S, 0.00003, 0.00003, { id: 'T' });
const withTiny = fed.concat([tiny]);
const s2 = drain(An.sampleLattice([{ features: withTiny }, { features: prov }], { spacingM: 25 }));
const cw2 = An.crosswalkBetween(s2, 0, 1);
const rep = An.repairSmallFeatures(cw2, withTiny, prov, { a: s2.indexes[0], b: s2.indexes[1] });
ok('the 3 m polygon was repaired', rep.a.includes(withTiny.length - 1) && rep.fed === rep.a);
const tp = An.crosswalkPairs(cw2).filter((p) => p.ai === withTiny.length - 1);
ok('and sits wholly in P11', tp.length === 1 && tp[0].bi === P('P11') && Math.abs(tp[0].shareOfA - 1) < 1e-9, JSON.stringify(tp));

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll sample-table tests passed.\n');
process.exit(fails ? 1 : 0);
