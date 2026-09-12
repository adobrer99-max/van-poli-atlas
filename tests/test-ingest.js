const fs = require('fs');
const { load } = require('./harness');
const { Ingest, Geo } = load(['a-geo.js','b-text.js','c-binary.js','d-ingest.js'], ['Ingest','Geo']);
let fails = 0;
const ok = (n, c, e = '') => { if (c) console.log(`  PASS  ${n}`); else { console.log(`  FAIL  ${n} ${e}`); fails++; } };
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const read = (p) => new Uint8Array(fs.readFileSync(p));
const enc = (s) => new TextEncoder().encode(s);

(async () => {
  console.log('\n== Zipped shapefile in BC Albers ==');
  const z = await Ingest.loadBoundaries('va_shapefile.zip', read('fixtures/va_shapefile.zip'));
  eq('feature count', z.features.length, 3);
  eq('CRS read from .prj', z.crs, 'EPSG:3005');
  eq('attributes joined from dbf', z.features[0].properties.ED_NAME, 'Vancouver-Fairview');
  const bb = Geo.bboxOf(z.features[0].geometry);
  ok('reprojected into Vancouver lon/lat', bb[0] > -123.2 && bb[2] < -123.0 && bb[1] > 49.2 && bb[3] < 49.3,
     JSON.stringify(bb.map(v => +v.toFixed(4))));
  eq('no warnings for a complete archive', z.warnings, []);

  console.log('\n== KMZ and KML ==');
  const kmz = await Ingest.loadBoundaries('va.kmz', read('fixtures/va.kmz'));
  eq('kmz features', kmz.features.length, 3);
  eq('kmz treated as lon/lat', kmz.crs, 'EPSG:4326');
  const kml = await Ingest.loadBoundaries('va.kml', read('fixtures/va.kml'));
  eq('kml features', kml.features.length, 3);
  // Shapefile route and KML route must agree on geometry.
  const a = Geo.bboxOf(z.features[0].geometry), b = Geo.bboxOf(kml.features[0].geometry);
  ok('shapefile and KML agree to 1e-7 deg', Math.max(...a.map((v,i)=>Math.abs(v-b[i]))) < 1e-7);

  console.log('\n== GeoJSON ==');
  const plain = JSON.stringify({ type:'FeatureCollection', features:[
    { type:'Feature', properties:{ VA:'001' }, geometry:{ type:'Polygon', coordinates:[[[-123.1,49.2],[-123.0,49.2],[-123.0,49.3],[-123.1,49.3],[-123.1,49.2]]] } } ]});
  const g = await Ingest.loadBoundaries('x.geojson', enc(plain));
  eq('wgs84 geojson passes through', g.crs, 'EPSG:4326');
  eq('coordinates untouched', g.features[0].geometry.coordinates[0][0], [-123.1,49.2]);

  const albersGj = JSON.stringify({ type:'FeatureCollection',
    crs:{ type:'name', properties:{ name:'urn:ogc:def:crs:EPSG::3005' } },
    features:[{ type:'Feature', properties:{}, geometry:{ type:'Polygon',
      coordinates:[[[1200000,460000],[1202000,460000],[1202000,462000],[1200000,462000],[1200000,460000]]] } }]});
  const ag = await Ingest.loadBoundaries('x.json', enc(albersGj));
  eq('legacy crs member honoured', ag.crs, 'EPSG:3005');
  const abb = Geo.bboxOf(ag.features[0].geometry);
  ok('albers geojson reprojected', abb[0] > -124 && abb[0] < -122 && abb[1] > 48.9 && abb[1] < 49.6,
     JSON.stringify(abb.map(v=>+v.toFixed(4))));

  // No crs member, projected coordinates -> sniffed from extent.
  const sniffed = await Ingest.loadBoundaries('x.json', enc(albersGj.replace(/"crs":\{[^}]*\}[^,]*,/, '')));
  eq('extent sniffing recovers BC Albers', sniffed.crs, 'EPSG:3005');

  console.log('\n== Geometry normalisation ==');
  const mixed = JSON.stringify({ type:'FeatureCollection', features:[
    { type:'Feature', properties:{n:1}, geometry:{ type:'Point', coordinates:[-123,49] } },
    { type:'Feature', properties:{n:2}, geometry:{ type:'GeometryCollection', geometries:[
        { type:'Polygon', coordinates:[[[-123.1,49.2],[-123.0,49.2],[-123.0,49.3],[-123.1,49.2]]] },
        { type:'Polygon', coordinates:[[[-122.9,49.2],[-122.8,49.2],[-122.8,49.3],[-122.9,49.2]]] } ] } } ]});
  const m = await Ingest.loadBoundaries('m.geojson', enc(mixed));
  eq('point dropped, collection kept', m.features.length, 1);
  eq('GeometryCollection flattened to MultiPolygon', m.features[0].geometry.type, 'MultiPolygon');
  ok('warned about the dropped point', m.warnings.some(w => /skipped/i.test(w)), JSON.stringify(m.warnings));

  console.log('\n== Error messages ==');
  const fail = async (name, bytes, re) => {
    try { await Ingest.loadBoundaries(name, bytes); ok(`${name} should have thrown`, false); }
    catch (e) { ok(`${name}: ${e.message.slice(0,58)}...`, re.test(e.message), e.message); }
  };
  await fail('t.json', enc(JSON.stringify({ type:'Topology', objects:{} })), /TopoJSON/);
  await fail('a.shp', new Uint8Array(8), /zip it together/i);
  await fail('empty.geojson', enc(JSON.stringify({ type:'FeatureCollection', features:[] })), /No polygon features/);
  const emptyZip = read('fixtures/va.kmz').slice();
  await fail('notazip.zip', new Uint8Array([1,2,3,4]), /Not a ZIP/);

  console.log('\n== Tables ==');
  const t = await Ingest.loadTable('r.csv', enc('District,VA,Party,Votes\nVancouver-Fairview,015,BC NDP,321\n'));
  eq('header', t.header, ['District','VA','Party','Votes']);
  eq('row', t.rows[0], ['Vancouver-Fairview','015','BC NDP','321']);

  console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll ingest tests passed.\n');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
