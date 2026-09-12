const fs = require('fs');
const { load } = require('./harness');
const { Analysis: An, Geo } = load(['a-geo.js','e-analysis.js'], ['Analysis','Geo']);
let fails = 0;
const ok = (n,c,e='') => { if(c) console.log(`  PASS  ${n}`); else { console.log(`  FAIL  ${n} ${e}`); fails++; } };

console.log('\n== representativePoint stays inside awkward shapes ==');
const cShape = { type:'Polygon', coordinates:[[ [0,0],[10,0],[10,3],[3,3],[3,7],[10,7],[10,10],[0,10],[0,0] ]] };
const rp = Geo.representativePoint(cShape);
ok(`C-shape point ${JSON.stringify(rp)} is inside`, Geo.inGeometry(rp[0], rp[1], cShape));
const ring = { type:'Polygon', coordinates:[
  [[0,0],[10,0],[10,10],[0,10],[0,0]], [[1,1],[9,1],[9,9],[1,9],[1,1]] ] };
const rp2 = Geo.representativePoint(ring);
ok(`thin ring point ${JSON.stringify(rp2)} is inside`, Geo.inGeometry(rp2[0], rp2[1], ring));
const multi = { type:'MultiPolygon', coordinates:[
  [[[0,0],[1,0],[1,1],[0,1],[0,0]]], [[[50,50],[60,50],[60,60],[50,60],[50,50]]] ] };
const rp3 = Geo.representativePoint(multi);
ok(`multipolygon picks the larger part ${JSON.stringify(rp3)}`, rp3[0] > 49 && Geo.inGeometry(rp3[0], rp3[1], multi));

console.log('\n== Tiny federal polls survive the crosswalk ==');
const fed = JSON.parse(fs.readFileSync('boundaries/fed_polls.geojson','utf8')).features;
const VAN = new Set(['59035','59036','59037','59038','59039','59040']);
const van = fed.filter(f => VAN.has(f.properties.fed) && !f.properties.jurisdiction);
let e=[Infinity,Infinity,-Infinity,-Infinity];
for (const f of van){const g=Geo.bboxOf(f.geometry);
  e=[Math.min(e[0],g[0]),Math.min(e[1],g[1]),Math.max(e[2],g[2]),Math.max(e[3],g[3])];}
const NX=32,NY=25,prov=[];
for(let i=0;i<NX;i++)for(let j=0;j<NY;j++){
  const w=(e[2]-e[0])/NX,h=(e[3]-e[1])/NY,x0=e[0]+i*w+w*0.13,y0=e[1]+j*h+h*0.37;
  prov.push({type:'Feature',properties:{va:`${i}-${j}`},geometry:{type:'Polygon',
    coordinates:[[[x0,y0],[x0+w,y0],[x0+w,y0+h],[x0,y0+h],[x0,y0]]]}});
}
const fedIndex = Geo.buildIndex(van), provIndex = Geo.buildIndex(prov);
const g = An.crosswalkRunner(van, prov, { spacingM: 25, fedIndex, provIndex });
let r = g.next(); while(!r.done) r = g.next();
const cw = r.value;

const tiny = van.map((f,i)=>i).filter(i => Geo.areaM2(van[i].geometry) < 200);
const before = new Set(An.crosswalkPairs(cw).map(p=>p.fi));
const missingBefore = tiny.filter(i => !before.has(i));
console.log(`  ${tiny.length} polls under 200 m2; ${missingBefore.length} missed by the raw 25 m lattice`);

const repaired = An.repairSmallFeatures(cw, van, prov, { fed: fedIndex, prov: provIndex }, 6);
const pairs = An.crosswalkPairs(cw);
const after = new Set(pairs.map(p=>p.fi));
const missingAfter = tiny.filter(i => !after.has(i));
ok(`repair recovered every tiny poll (${missingBefore.length} -> ${missingAfter.length} missing)`, missingAfter.length === 0);
console.log(`  repaired ${repaired.fed.length} federal features, ${repaired.prov.length} provincial`);

// A repaired tiny poll must sit wholly in one voting area.
const sample = tiny.find(i => repaired.fed.includes(i));
const its = pairs.filter(p => p.fi === sample);
ok(`tiny poll ${van[sample].properties.fed}/${van[sample].properties.poll} assigned to exactly one voting area`, its.length === 1, `got ${its.length}`);
ok('and gets its full weight', Math.abs(its[0].shareOfFed - 1) < 1e-9, `share=${its[0].shareOfFed}`);
// Its share of the containing VA must be small but non-zero and area-proportional.
const areaRatio = Geo.areaM2(van[sample].geometry) / Geo.areaM2(prov[its[0].pi].geometry);
ok(`its share of the voting area tracks the area ratio (${its[0].shareOfProv.toExponential(2)} vs ${areaRatio.toExponential(2)})`,
   its[0].shareOfProv > 0 && Math.abs(its[0].shareOfProv - areaRatio) / areaRatio < 0.35);

console.log('\n== No votes are lost ==');
const values = new Map();
van.forEach((f,i)=>values.set(i,{total:300,parties:new Map([['LPC',150],['CPC',90],['NDP',60]])}));
const moved = An.redistribute(pairs, values, { from:'fed' });
let movedTotal=0; for(const v of moved.values()) movedTotal+=v.total;
const cov = An.coverage(cw);
let expected=0; van.forEach((f,i)=>{ expected += 300 * (cov.fed[i] || 0); });
ok(`redistributed votes match coverage-weighted total (${movedTotal.toFixed(1)} vs ${expected.toFixed(1)})`,
   Math.abs(movedTotal-expected) < 1, `diff ${Math.abs(movedTotal-expected).toFixed(3)}`);
const allIn = van.filter((f,i)=>cov.fed[i] > 0.999).length;
console.log(`  ${allIn} of ${van.length} polls sit wholly inside the provincial layer`);

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nSmall-feature repair verified.\n');
process.exit(fails?1:0);
