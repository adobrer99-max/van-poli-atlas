const fs = require('fs');
const { load } = require('./harness');
const { Analysis: An, Geo } = load(['a-geo.js','e-analysis.js'], ['Analysis','Geo']);
const fed = JSON.parse(fs.readFileSync('boundaries/fed_polls.geojson','utf8')).features;
const VAN = new Set(['59035','59036','59037','59038','59039','59040']);
const vanFed = fed.filter(f => VAN.has(f.properties.fed) && !f.properties.jurisdiction);
console.log(`federal polls: ${fed.length} total, ${vanFed.length} in the six Vancouver ridings`);

// Synthetic provincial layer: ~800 cells over the Vancouver extent, offset so
// it shares no boundaries with the federal grid (the realistic hard case).
const b = (() => { let e=[Infinity,Infinity,-Infinity,-Infinity];
  for (const f of vanFed) { const g = Geo.bboxOf(f.geometry);
    e=[Math.min(e[0],g[0]),Math.min(e[1],g[1]),Math.max(e[2],g[2]),Math.max(e[3],g[3])]; } return e; })();
console.log('Vancouver extent:', b.map(v=>+v.toFixed(4)).join(', '));
const NX = 32, NY = 25;
const prov = [];
for (let i=0;i<NX;i++) for (let j=0;j<NY;j++) {
  const w=(b[2]-b[0])/NX, h=(b[3]-b[1])/NY;
  const x0=b[0]+i*w+w*0.13, y0=b[1]+j*h+h*0.37;
  prov.push({ type:'Feature', properties:{ va:`${i}-${j}` }, geometry:{ type:'Polygon',
    coordinates:[[[x0,y0],[x0+w,y0],[x0+w,y0+h],[x0,y0+h],[x0,y0]]] } });
}
console.log(`synthetic provincial voting areas: ${prov.length}`);

for (const spacingM of [60, 40, 25]) {
  const t0 = Date.now();
  const fedIndex = Geo.buildIndex(vanFed), provIndex = Geo.buildIndex(prov);
  const tIdx = Date.now() - t0;
  const t1 = Date.now();
  const gen = An.crosswalkRunner(vanFed, prov, { spacingM, fedIndex, provIndex });
  let r = gen.next(); let steps = 0;
  while (!r.done) { r = gen.next(); steps++; }
  const cw = r.value;
  const ms = Date.now() - t1;
  const pairs = An.crosswalkPairs(cw);
  // Every federal poll's shares must sum to 1 (within sampling noise).
  const bad = [];
  const sums = new Map();
  for (const p of pairs) sums.set(p.fi, (sums.get(p.fi)||0) + p.shareOfFed);
  for (const [fi, s] of sums) if (Math.abs(s-1) > 0.02) bad.push([fi, s]);
  console.log(`  spacing ${String(spacingM).padStart(3)}m: index ${tIdx}ms, crosswalk ${ms}ms, ` +
    `${cw.points.toLocaleString()} pts, ${pairs.length.toLocaleString()} overlaps, ` +
    `${steps} progress steps, ${bad.length} polls whose shares stray from 1`);
}

// How much does spacing change the answer? Compare 25m against 60m.
const mk = (s) => { const g = An.crosswalkRunner(vanFed, prov, { spacingM: s });
  let r = g.next(); while (!r.done) r = g.next(); return An.crosswalkPairs(r.value); };
const coarse = new Map(mk(60).map(p => [p.fi+'|'+p.pi, p.shareOfFed]));
const fine = mk(25);
let maxDiff = 0, sumDiff = 0, n = 0;
for (const p of fine) {
  const c = coarse.get(p.fi+'|'+p.pi);
  if (c == null) continue;
  maxDiff = Math.max(maxDiff, Math.abs(c - p.shareOfFed)); sumDiff += Math.abs(c - p.shareOfFed); n++;
}
console.log(`\n60m vs 25m lattice on ${n} shared overlaps: mean |diff| ${(sumDiff/n).toFixed(4)}, max ${maxDiff.toFixed(4)}`);
