const fs = require('fs');
const { load } = require('./harness');
const { Geo } = load(['a-geo.js'], ['Geo']);
let fails = 0;
const ok = (n, c, e = '') => { if (c) console.log(`  PASS  ${n}`); else { console.log(`  FAIL  ${n} ${e}`); fails++; } };
const LON0 = -(91 + 52 / 60);

console.log('\n== Statistics Canada Lambert (EPSG:3347) vs an independent forward ==');
const control = JSON.parse(fs.readFileSync('fixtures/lcc_control.json', 'utf8'));
const inv = Geo.project('EPSG:3347');
let worst = 0;
for (const c of control.points) {
  const [lon, lat] = inv(c.x, c.y);
  const dx = (lon - c.lon) * 111320 * Math.cos(lat * Math.PI / 180), dy = (lat - c.lat) * 110540;
  worst = Math.max(worst, Math.hypot(dx, dy));
}
ok(`all ${control.points.length} control points invert within 1 mm (worst ${(worst * 1000).toFixed(5)} mm)`, worst < 0.001);
const o = inv(6200000, 3000000);
ok('false origin inverts to (-91 52\', 63.390675)', Math.abs(o[0] - LON0) < 1e-9 && Math.abs(o[1] - 63.390675) < 1e-9, JSON.stringify(o));
let cm = true;
for (const y of [1e6, 2e6, 4e6]) if (Math.abs(inv(6200000, y)[0] - LON0) > 1e-9) cm = false;
ok('x = FE stays on the central meridian', cm);
const l = inv(6200000 - 500000, 2e6), r = inv(6200000 + 500000, 2e6);
ok('east/west symmetry about the central meridian',
   Math.abs((LON0 - l[0]) - (r[0] - LON0)) < 1e-9 && Math.abs(l[1] - r[1]) < 1e-9, JSON.stringify([l, r]));
ok('EPSG:3348 shares the parameters', Geo.project('EPSG:3348')(4018834.4, 2007337.2)[1].toFixed(6) === inv(4018834.4, 2007337.2)[1].toFixed(6));

console.log('\n== Conformal checks ==');
// On a standard parallel the scale factor is exactly 1, so two points 0.01 deg
// apart on the 49th parallel must be as far apart on the plane as on the ellipsoid.
const { a, b, arc_m } = control.parallel_pair;
const planar = Math.hypot(a[0] - b[0], a[1] - b[1]);
ok(`scale is 1 on the 49th parallel (${planar.toFixed(4)} vs ${arc_m.toFixed(4)} m)`, Math.abs(planar - arc_m) / arc_m < 1e-6);
// One standard parallel: the false origin sits at (lon0, lat0).
const one = Geo.lccInverse({ lat1: 49, lat2: 49, lat0: 49, lon0: -100, x0: 0, y0: 0 });
const oo = one(0, 0);
ok('single-parallel form inverts its origin', Math.abs(oo[0] + 100) < 1e-9 && Math.abs(oo[1] - 49) < 1e-9, JSON.stringify(oo));

console.log('\n== CRS sniffing ==');
const prj = fs.readFileSync('fixtures/da_lcc.prj', 'utf8');
ok('Statistics Canada Esri .prj -> EPSG:3347', Geo.crsFromWkt(prj) === 'EPSG:3347', Geo.crsFromWkt(prj));
const other = prj.replace('"Standard_Parallel_1",49.0', '"Standard_Parallel_1",50.0');
ok('other parallels -> WKT:LCC', Geo.crsFromWkt(other) === 'WKT:LCC', Geo.crsFromWkt(other));
const p2 = Geo.project('WKT:LCC')(6200000, 3000000);
ok('the parsed projection inverts its own origin', Math.abs(p2[0] - LON0) < 1e-6 && Math.abs(p2[1] - 63.390675) < 1e-6, JSON.stringify(p2));
const withAuth = prj.slice(0, -1) + ',AUTHORITY["EPSG","3347"]]';
ok('an AUTHORITY of 3347 is honoured', Geo.crsFromWkt(withAuth) === 'EPSG:3347');
ok('Vancouver box in 3347 -> EPSG:3347', Geo.crsFromExtent(4.0e6, 1.98e6, 4.05e6, 2.02e6) === 'EPSG:3347');
ok('Halifax box in 3347 -> EPSG:3347', Geo.crsFromExtent(8.3e6, 1.3e6, 8.5e6, 1.5e6) === 'EPSG:3347');
ok('Web Mercator Vancouver box still -> EPSG:3857', Geo.crsFromExtent(-1.371e7, 6.3e6, -1.369e7, 6.32e6) === 'EPSG:3857');
ok('BC Albers box unchanged', Geo.crsFromExtent(1180000, 440000, 1220000, 480000) === 'EPSG:3005');
ok('UTM box unchanged', Geo.crsFromExtent(480000, 5440000, 520000, 5470000) === 'EPSG:26910');

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll Lambert tests passed.\n');
process.exit(fails ? 1 : 0);
