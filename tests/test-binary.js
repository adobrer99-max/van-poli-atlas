const fs = require('fs');
const { load } = require('./harness');
const { BinaryFormats: B, TextFormats: T, Geo } =
  load(['a-geo.js', 'b-text.js', 'c-binary.js'], ['BinaryFormats', 'TextFormats', 'Geo']);
let fails = 0;
const ok = (n, c, e = '') => { if (c) console.log(`  PASS  ${n}`); else { console.log(`  FAIL  ${n} ${e}`); fails++; } };
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const read = (p) => new Uint8Array(fs.readFileSync(p));
const decode = (b) => T.decodeBytes(b);

(async () => {
  console.log('\n== Inverse Albers vs independently computed control points ==');
  const control = JSON.parse(fs.readFileSync('fixtures/albers_control.json', 'utf8'));
  const inv = Geo.project('EPSG:3005');
  let worst = 0;
  for (const c of control) {
    const [lon, lat] = inv(c.x, c.y);
    // metres of ground error
    const dx = (lon - c.lon) * 111320 * Math.cos(lat * Math.PI / 180);
    const dy = (lat - c.lat) * 110540;
    worst = Math.max(worst, Math.hypot(dx, dy));
  }
  ok(`round-trips all ${control.length} control points within 1 mm (worst ${(worst * 1000).toFixed(4)} mm)`, worst < 0.001);

  console.log('\n== SHP / DBF ==');
  const shapes = B.readShp(read('fixtures/va.shp'));
  eq('three shapes read', shapes.length, 3);
  eq('first shape is a Polygon', shapes[0].type, 'Polygon');
  eq('third shape carries its hole', shapes[2].coordinates.length, 2);
  const dbf = B.readDbf(read('fixtures/va.dbf'), decode);
  eq('dbf field names', dbf.fields.map((f) => f.name), ['ED_NAME', 'VA_CODE', 'ELECTORS']);
  eq('dbf row count', dbf.rows.length, 3);
  eq('character field trimmed', dbf.rows[0].ED_NAME, 'Vancouver-Fairview');
  eq('VA code keeps its leading zero', dbf.rows[0].VA_CODE, '015');
  eq('numeric field parsed as number', dbf.rows[1].ELECTORS, 437);

  console.log('\n== ZIP (deflate) ==');
  const zip = B.readZip(read('fixtures/va_shapefile.zip'));
  eq('entries listed', [...zip.keys()].sort(), ['VotingAreas/va.dbf', 'VotingAreas/va.prj', 'VotingAreas/va.shp']);
  const prj = decode(await zip.get('VotingAreas/va.prj')());
  eq('prj inflated and recognised', Geo.crsFromWkt(prj), 'EPSG:3005');
  const shpFromZip = B.readShp(await zip.get('VotingAreas/va.shp')());
  eq('shp inflated from zip matches direct read', shpFromZip.length, shapes.length);
  eq('inflated geometry identical', JSON.stringify(shpFromZip[2]), JSON.stringify(shapes[2]));

  console.log('\n== ZIP (stored) ==');
  const stored = B.readZip(read('fixtures/va_stored.zip'));
  const storedShp = B.readShp(await stored.get('va.shp')());
  eq('stored entry read without inflate', storedShp.length, 3);

  console.log('\n== KMZ ==');
  const kmz = B.readZip(read('fixtures/va.kmz'));
  const kmlText = decode(await kmz.get('doc.kml')());
  const kf = T.kmlToFeatures(kmlText);
  eq('three placemarks from kmz', kf.length, 3);
  eq('kmz attribute preserved', kf[0].properties.VA_CODE, '015');

  console.log('\n== Shapefile reprojection lands on the KML geometry ==');
  // The same three voting areas exist as BC Albers shapefile and lon/lat KML.
  // Reprojecting the shapefile must reproduce the KML coordinates.
  const project = Geo.project('EPSG:3005');
  const reproj = shapes.map((g) => ({
    type: g.type,
    coordinates: g.coordinates.map((ring) => ring.map(([x, y]) => project(x, y))),
  }));
  const shpBox = Geo.bboxOf(reproj[0]);
  const kmlBox = Geo.bboxOf(kf[0].geometry);
  const drift = Math.max(...shpBox.map((v, i) => Math.abs(v - kmlBox[i])));
  ok(`reprojected shapefile matches KML bbox within 1e-7 deg (max ${drift.toExponential(2)})`, drift < 1e-7,
     `shp=${JSON.stringify(shpBox.map(v=>+v.toFixed(6)))} kml=${JSON.stringify(kmlBox.map(v=>+v.toFixed(6)))}`);

  console.log('\n== Area of a reprojected voting area ==');
  const areaKm2 = Geo.areaM2(reproj[0]) / 1e6;
  // 0.02 deg lon x 0.02 deg lat at 49.26N is about 1.45 x 2.22 km
  ok(`plausible area ${areaKm2.toFixed(3)} km2`, areaKm2 > 2.5 && areaKm2 < 4.5);

  console.log('\n== Ring grouping ==');
  const cw = [[0,0],[0,10],[10,10],[10,0],[0,0]];            // clockwise outer
  const ccwHole = [[3,3],[7,3],[7,7],[3,7],[3,3]];           // counter-clockwise hole
  const cw2 = [[20,0],[20,10],[30,10],[30,0],[20,0]];
  eq('outer + hole + second outer -> 2 polygons',
     B.groupRings([cw, ccwHole, cw2]).map((p) => p.length), [2, 1]);

  console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll binary-format tests passed.\n');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
