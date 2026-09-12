const fs = require('fs');
const { load } = require('./harness');
const { Analysis: An, Geo } = load(['a-geo.js','e-analysis.js'], ['Analysis','Geo']);
let fails = 0;
const ok = (n,c,e='') => { if(c) console.log(`  PASS  ${n}`); else { console.log(`  FAIL  ${n} ${e}`); fails++; } };

const fed = JSON.parse(fs.readFileSync('boundaries/fed_polls.geojson','utf8')).features;
const VAN = new Set(['59035','59036','59037','59038','59039','59040']);
const vanFed = fed.filter(f => VAN.has(f.properties.fed) && !f.properties.jurisdiction);
let e=[Infinity,Infinity,-Infinity,-Infinity];
for (const f of vanFed) { const g=Geo.bboxOf(f.geometry);
  e=[Math.min(e[0],g[0]),Math.min(e[1],g[1]),Math.max(e[2],g[2]),Math.max(e[3],g[3])]; }
const NX=32, NY=25, prov=[];
for (let i=0;i<NX;i++) for (let j=0;j<NY;j++) {
  const w=(e[2]-e[0])/NX, h=(e[3]-e[1])/NY, x0=e[0]+i*w+w*0.13, y0=e[1]+j*h+h*0.37;
  prov.push({ type:'Feature', properties:{va:`${i}-${j}`}, geometry:{type:'Polygon',
    coordinates:[[[x0,y0],[x0+w,y0],[x0+w,y0+h],[x0,y0+h],[x0,y0]]]}});
}
const run = (s) => { const g=An.crosswalkRunner(vanFed,prov,{spacingM:s});
  let r=g.next(); while(!r.done) r=g.next(); return r.value; };

const cw60 = run(60), cw25 = run(25);

console.log('\n== Sliver filtering stabilises shares across lattice resolutions ==');
for (const minShare of [0, 0.005, 0.02]) {
  const a = new Map(An.crosswalkPairs(cw60,{minShare}).map(p=>[p.fi+'|'+p.pi,p.shareOfFed]));
  const b = An.crosswalkPairs(cw25,{minShare});
  let max=0,sum=0,n=0;
  for (const p of b) { const v=a.get(p.fi+'|'+p.pi); if(v==null) continue;
    max=Math.max(max,Math.abs(v-p.shareOfFed)); sum+=Math.abs(v-p.shareOfFed); n++; }
  console.log(`  minShare ${String(minShare).padEnd(5)}: ${String(b.length).padStart(5)} overlaps, ` +
    `mean |60m-25m| ${(sum/n).toFixed(4)}, max ${max.toFixed(4)}`);
}

console.log('\n== Vote mass is preserved when slivers are dropped ==');
const values = new Map();
vanFed.forEach((f,i)=>values.set(i,{total:300,parties:new Map([['LPC',150],['CPC',90],['NDP',60]])}));
const before = An.crosswalkPairs(cw25,{minShare:0});
const after  = An.crosswalkPairs(cw25,{minShare:0.02});
const moveTotal = (pairs) => { const m=An.redistribute(pairs,values,{from:'fed'});
  let t=0; for (const v of m.values()) t+=v.total; return t; };
const t0=moveTotal(before), t1=moveTotal(after);
ok(`redistributed total unchanged after filtering (${t0.toFixed(2)} vs ${t1.toFixed(2)})`,
   Math.abs(t0-t1) < 1e-6, `diff ${Math.abs(t0-t1)}`);
ok(`filtering removed ${before.length-after.length} sliver overlaps of ${before.length}`,
   after.length < before.length);

console.log('\n== Coverage is not inflated to 1 for partly-covered polls ==');
const cov = An.coverage(cw25);
const partly = cov.fed.filter(c => c > 0.001 && c < 0.98).length;
const full = cov.fed.filter(c => c >= 0.98).length;
console.log(`  ${full} polls fully inside the provincial layer, ${partly} only partly covered`);
// Take a partly covered poll and confirm its shares still sum to its coverage.
const sums = new Map();
for (const p of after) sums.set(p.fi,(sums.get(p.fi)||0)+p.shareOfFed);
let worst = 0, worstIdx = -1;
for (const [fi,s] of sums) { const d=Math.abs(s-cov.fed[fi]); if(d>worst){worst=d;worstIdx=fi;} }
ok(`shares sum to measured coverage, not to 1 (worst drift ${worst.toExponential(2)} at poll ${worstIdx}, coverage ${cov.fed[worstIdx]?.toFixed(4)})`,
   worst < 1e-9);

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nSliver handling verified.\n');
process.exit(fails?1:0);
