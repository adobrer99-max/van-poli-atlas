const fs = require('fs');
const { load } = require('./harness');
const { Ingest, Geo } = load(['a-geo.js','b-text.js','c-binary.js','d-ingest.js'], ['Ingest','Geo']);
let fails = 0;
const ok = (n, c, e = '') => { if (c) console.log(`  PASS  ${n}`); else { console.log(`  FAIL  ${n} ${e}`); fails++; } };
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const read = (p) => new Uint8Array(fs.readFileSync(p));
const enc = (s) => new TextEncoder().encode(s);

(async () => {
  const fail = async (name, bytes, re, options) => {
    try { await Ingest.loadBoundaries(name, bytes, options); ok(`${name} should have thrown`, false); }
    catch (e) { ok(`${name}: ${e.message.slice(0, 58)}...`, re.test(e.message), e.message); }
  };
  console.log('\n== Zipped shapefile in BC Albers ==');
  const z = await Ingest.loadBoundaries('va_shapefile.zip', read('fixtures/va_shapefile.zip'));
  eq('feature count', z.features.length, 3);
  eq('CRS read from .prj', z.crs, 'EPSG:3005');
  eq('attributes joined from dbf', z.features[0].properties.ED_NAME, 'Vancouver-Fairview');
  const bb = Geo.bboxOf(z.features[0].geometry);
  ok('reprojected into Vancouver lon/lat', bb[0] > -123.2 && bb[2] < -123.0 && bb[1] > 49.2 && bb[3] < 49.3,
     JSON.stringify(bb.map(v => +v.toFixed(4))));
  eq('no warnings for a complete archive', z.warnings, []);

  console.log('\n== Zipped shapefile in Statistics Canada Lambert (Esri .prj) ==');
  const lcc = await Ingest.loadBoundaries('da_lcc.zip', read('fixtures/da_lcc.zip'));
  eq('feature count', lcc.features.length, 3);
  eq('CRS read from the Esri .prj', lcc.crs, 'EPSG:3347');
  eq('DAUID attribute kept', lcc.features[0].properties.DAUID, '59150100');
  const lb = Geo.bboxOf(lcc.features[0].geometry), ab = Geo.bboxOf(z.features[0].geometry);
  ok('Lambert and Albers routes agree to 1e-7 deg', Math.max(...lb.map((v, i) => Math.abs(v - ab[i]))) < 1e-7,
     JSON.stringify([lb, ab]));

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

  console.log('\n== Clipping a big file to the study area while loading ==');
  const zb = new Blob([read('fixtures/e2e_voting_areas.zip')]);
  const whole = await Ingest.loadBoundaries('e2e_voting_areas.zip', zb);
  eq('a Blob loads like bytes', whole.features.length, 700);
  eq('records reported', [whole.records, whole.kept, whole.filtered], [700, 700, false]);
  const box = [-123.12, 49.24, -123.08, 49.27];
  const touches = (f) => { const b = Geo.bboxOf(f.geometry); return b[2] >= box[0] && b[0] <= box[2] && b[3] >= box[1] && b[1] <= box[3]; };
  const inBox = whole.features.filter(touches).length;
  const clipped = await Ingest.loadBoundaries('e2e_voting_areas.zip', zb, { bbox: box });
  ok(`clipped load keeps the ${inBox} areas touching the box (got ${clipped.kept} of ${clipped.records})`,
     clipped.features.length === inBox && clipped.records === 700 && clipped.kept === inBox && clipped.filtered === true);
  ok('the clipped features are the same objects as in the whole load', clipped.features.every(touches)
     && JSON.stringify(clipped.features.map((f) => f.properties.VA_CODE)) === JSON.stringify(whole.features.filter(touches).map((f) => f.properties.VA_CODE)));
  const streamed = await Ingest.loadBoundaries('e2e_voting_areas.zip', zb, { bbox: box, streamAbove: 0 });
  ok('the streaming path gives the same layer', streamed.features.length === inBox
     && JSON.stringify(streamed.features[0]) === JSON.stringify(clipped.features[0]));
  const gj = await Ingest.loadBoundaries('e2e_va.geojson', new Blob([read('fixtures/e2e_va.geojson')]), { bbox: box });
  eq('a GeoJSON layer is clipped to the same count', gj.features.length, inBox);
  await fail('e2e_va.geojson', enc(JSON.stringify({ type: 'FeatureCollection', features: [
    { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-100, 40], [-99, 40], [-99, 41], [-100, 40]]] } }] })), /touch the study area/, { bbox: box });

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
  await fail('t.json', enc(JSON.stringify({ type:'Topology', objects:{} })), /TopoJSON/);
  await fail('a.shp', new Uint8Array(8), /zip it together/i);
  await fail('empty.geojson', enc(JSON.stringify({ type:'FeatureCollection', features:[] })), /No polygon features/);
  const emptyZip = read('fixtures/va.kmz').slice();
  await fail('notazip.zip', new Uint8Array([1,2,3,4]), /Not a ZIP/);

  console.log('\n== Tables ==');
  const t = await Ingest.loadTable('r.csv', enc('District,VA,Party,Votes\nVancouver-Fairview,015,BC NDP,321\n'));
  eq('header', t.header, ['District','VA','Party','Votes']);
  eq('row', t.rows[0], ['Vancouver-Fairview','015','BC NDP','321']);

  console.log('\n== A table out of whatever was dropped on it ==');
  /* The bug this pins. loadTable decided by EXTENSION -- extensionOf(f) ===
     'zip' -- so an .xlsx, which is a zip, skipped the unzip branch entirely and
     fell through to the text path. decodeBytes then "succeeded", because its
     windows-1252 fallback maps every byte to some character and can never fail,
     and the delimited parser turned the compressed bytes into a header. What
     the reader saw was the file's own binary quoted back as its column names. */
  const book = await Ingest.loadTable('roll_shaped.xlsx', read('fixtures/roll_shaped.xlsx'));
  eq('an Excel workbook is read as a table, by its bytes and not its extension',
     book.header, ['Elector', 'FirstName', 'LastName', 'PropertyAddress',
                   'StreetNumb', 'StreetName', 'StreetTyp', 'LocalArea']);
  eq('and its rows survive the trip', book.rows.length, 4);
  eq('and it says which sheet it read', book.sheet, 'Query1');
  eq('and that it was a workbook rather than a delimited file', book.format, 'xlsx');
  /* The extension is now evidence of nothing: the same bytes under a wrong name
     still read correctly, which is the whole point of sniffing. */
  eq('a workbook named .csv is still read as a workbook',
     (await Ingest.loadTable('mislabelled.csv', read('fixtures/roll_shaped.xlsx'))).header.length, 8);

  const refuses = async (what, name, bytes, re) => {
    try {
      await Ingest.loadTable(name, bytes);
      ok(`${what} should have been refused`, false);
    } catch (e) {
      ok(`${what}: ${e.message.slice(0, 72)}`, re.test(e.message), e.message.slice(0, 200));
      /* The point of the whole exercise: the message says what the file IS. It
         must never contain the file's own bytes, which is what made the old
         error unreadable. */
      ok(`  and the message carries no raw bytes`, e.message.length < 400
         && !/[\u0000-\u0008\u000e-\u001f\ufffd]/.test(e.message), JSON.stringify(e.message.slice(0, 120)));
    }
  };
  await refuses('a PDF', 'notes.pdf',
                new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25]),
                /is a PDF, not a table/);
  await refuses('an older .xls', 'roll.xls',
                new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]),
                /older Office file.*save as \.xlsx or CSV/s);
  await refuses('a PNG', 'map.png',
                new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
                /is a PNG image, not a table/);

  /* And the paths that already worked must keep working. */
  const stillCsv = await Ingest.loadTable('plain.csv', enc('A,B\n1,2\n'));
  eq('a plain CSV is untouched by any of this', [stillCsv.header, stillCsv.rows[0]], [['A', 'B'], ['1', '2']]);

  console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll ingest tests passed.\n');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
