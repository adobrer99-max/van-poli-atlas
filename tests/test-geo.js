const { load } = require('./harness');
const { Geo } = load(['a-geo.js'], ['Geo']);

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name} ${extra}`); fails++; }
};

console.log('\n== BC Albers (EPSG:3005) invariants ==');
const inv = Geo.project('EPSG:3005');

// Origin invariant: false easting / northing sit on the projection centre.
let p = inv(1000000, 0);
ok('inverse(1000000,0) -> (-126, 45)', Math.abs(p[0] + 126) < 1e-9 && Math.abs(p[1] - 45) < 1e-9, JSON.stringify(p));

// Central meridian invariant: x = FE means lon = lon0 at every northing.
let cmOK = true;
for (const y of [200000, 600000, 1200000, 1700000]) {
  const q = inv(1000000, y);
  if (Math.abs(q[0] + 126) > 1e-9) { cmOK = false; console.log('    lon at y=' + y + ':', q[0]); }
}
ok('x=FE stays on the central meridian', cmOK);

// Symmetry about the central meridian.
const l = inv(1000000 - 300000, 900000), r = inv(1000000 + 300000, 900000);
ok('east/west symmetry about lon0',
   Math.abs((-126 - l[0]) - (r[0] + 126)) < 1e-9 && Math.abs(l[1] - r[1]) < 1e-9,
   JSON.stringify([l, r]));

// Plausible BC extent: Vancouver must land where Vancouver is.
const van = inv(1200000, 460000);
ok('(1200000,460000) lands in SW British Columbia',
   van[0] > -124 && van[0] < -122 && van[1] > 48.8 && van[1] < 49.8, JSON.stringify(van));

console.log('\n== Equal-area property (independent check of the standard parallels) ==');
// For a true equal-area projection, planar area == geodesic area on the ellipsoid.
// Geo.areaM2 is a separate spherical-excess routine, so agreement cross-validates
// the Albers constants n and C. Edges are densified first: a straight line in the
// projected plane is a curve on the globe, and comparing only corners would
// measure that curvature rather than the projection.
function planarArea(ring) { // shoelace in projected metres
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s / 2);
}
function densify(corners, n) {
  const out = [];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i], b = corners[(i + 1) % corners.length];
    for (let k = 0; k < n; k++) {
      out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
    }
  }
  return out;
}
for (const [name, x0, y0, w, h] of [
  ['small cell near Vancouver', 1200000, 460000, 2000, 2000],
  ['mid cell central BC', 1000000, 900000, 50000, 50000],
  ['large cell northern BC', 1100000, 1500000, 100000, 80000],
]) {
  const corners = [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]];
  const dense = densify(corners, 400);
  const lonlat = dense.map(([x, y]) => inv(x, y));
  const planar = planarArea(dense);
  const geodesic = Geo.areaM2({ type: 'Polygon', coordinates: [lonlat.concat([lonlat[0]])] });
  const relErr = Math.abs(planar - geodesic) / planar;
  ok(`${name}: planar vs geodesic area within 0.05%`, relErr < 0.0005,
     `planar=${planar.toExponential(4)} geodesic=${geodesic.toExponential(4)} relErr=${(relErr*100).toFixed(4)}%`);
}

console.log('\n== UTM zone 10N ==');
const utm = Geo.project('EPSG:26910');
const u = utm(500000, 5457150); // central meridian of zone 10 is -123
ok('x=500000 sits on lon -123', Math.abs(u[0] + 123) < 1e-9, JSON.stringify(u));
ok('northing 5457150 is near 49.27N', Math.abs(u[1] - 49.27) < 0.05, JSON.stringify(u));

console.log('\n== Web Mercator ==');
const wm = Geo.project('EPSG:3857');
const w2 = wm(-13703000, 6318000);
ok('Web Mercator lands near Vancouver', Math.abs(w2[0] + 123.1) < 0.2 && Math.abs(w2[1] - 49.26) < 0.2, JSON.stringify(w2));

console.log('\n== CRS sniffing ==');
ok('lon/lat extent -> 4326', Geo.crsFromExtent(-123.3, 49.1, -122.9, 49.4) === 'EPSG:4326');
ok('BC Albers extent -> 3005', Geo.crsFromExtent(1180000, 440000, 1220000, 480000) === 'EPSG:3005');
ok('UTM extent -> 26910', Geo.crsFromExtent(480000, 5440000, 520000, 5470000) === 'EPSG:26910');
const bcPrj = 'PROJCS["NAD83 / BC Albers",GEOGCS["NAD83",DATUM["North_American_Datum_1983",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Albers_Conic_Equal_Area"],PARAMETER["standard_parallel_1",50],PARAMETER["standard_parallel_2",58.5],PARAMETER["latitude_of_center",45],PARAMETER["longitude_of_center",-126],PARAMETER["false_easting",1000000],PARAMETER["false_northing",0],UNIT["metre",1],AUTHORITY["EPSG","3005"]]';
ok('.prj WKT -> EPSG:3005', Geo.crsFromWkt(bcPrj) === 'EPSG:3005', Geo.crsFromWkt(bcPrj));
ok('geographic WKT -> 4326', Geo.crsFromWkt('GEOGCS["NAD83",DATUM["D",SPHEROID["GRS 1980",6378137,298.257222101]]]') === 'EPSG:4326');

console.log('\n== Point in polygon ==');
const square = { type: 'Polygon', coordinates: [[[0,0],[10,0],[10,10],[0,10],[0,0]]] };
ok('inside', Geo.inGeometry(5, 5, square));
ok('outside', !Geo.inGeometry(15, 5, square));
const donut = { type: 'Polygon', coordinates: [
  [[0,0],[10,0],[10,10],[0,10],[0,0]], [[3,3],[7,3],[7,7],[3,7],[3,3]] ] };
ok('hole is excluded', !Geo.inGeometry(5, 5, donut));
ok('ring between hole and edge is inside', Geo.inGeometry(1, 1, donut));

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll geo tests passed.\n');
process.exit(fails ? 1 : 0);
