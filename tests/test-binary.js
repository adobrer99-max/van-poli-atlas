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

  console.log('\n== Filtered and streamed reads ==');
  const shpBytes = read('fixtures/e2e_va.shp'), dbfBytes = read('fixtures/e2e_va.dbf');
  const all = B.readShp(shpBytes);
  const hb = B.shpHeaderBox(shpBytes);
  const mid = [(hb[0] + hb[2]) / 2, (hb[1] + hb[3]) / 2];
  const box = [mid[0] - 3000, mid[1] - 3000, mid[0] + 3000, mid[1] + 3000];   // metres, BC Albers
  const keep = (b) => b[2] >= box[0] && b[0] <= box[2] && b[3] >= box[1] && b[1] <= box[3];
  const some = B.readShp(shpBytes, { keep });
  eq('a filtered read keeps every record slot', some.length, all.length);
  const keptIdx = some.map((g, i) => (g ? i : -1)).filter((i) => i >= 0);
  const brute = all.map((g, i) => (g && keep(Geo.bboxOf(g)) ? i : -1)).filter((i) => i >= 0);
  eq(`kept exactly the records whose box touches the window (${keptIdx.length} of ${all.length})`, keptIdx, brute);
  ok('kept geometries are identical', keptIdx.every((i) => JSON.stringify(some[i]) === JSON.stringify(all[i])));
  const rowsAll = B.readDbf(dbfBytes, decode).rows;
  const rowsSome = B.readDbf(dbfBytes, decode, { keep: (i) => some[i] != null }).rows;
  ok('dbf rows filtered in step with the shapes', rowsSome.length === rowsAll.length
     && rowsSome.every((r, i) => (r == null) === (some[i] == null))
     && keptIdx.every((i) => JSON.stringify(rowsSome[i]) === JSON.stringify(rowsAll[i])));
  const chunked = (bytes, size) => new ReadableStream({ start(c) {
    for (let o = 0; o < bytes.byteLength; o += size) c.enqueue(bytes.subarray(o, Math.min(bytes.byteLength, o + size)));
    c.close();
  } });
  const streamed = await B.readShpStream(chunked(shpBytes, 777), { keep });
  eq('streamed .shp equals the whole-file read', JSON.stringify(streamed), JSON.stringify(some));
  eq('streamed .shp reports the header box', streamed.headerBox.map((v) => +v.toFixed(3)), hb.map((v) => +v.toFixed(3)));
  const streamedRows = (await B.readDbfStream(chunked(dbfBytes, 501), decode, { keep: (i) => some[i] != null })).rows;
  eq('streamed .dbf equals the whole-file read', JSON.stringify(streamedRows), JSON.stringify(rowsSome));

  console.log('\n== ZIP from a Blob ==');
  for (const name of ['va_shapefile.zip', 'va_stored.zip']) {
    const zbytes = read('fixtures/' + name);
    const a = B.readZip(zbytes), b = await B.readZipBlob(new Blob([zbytes]));
    eq(`${name}: same entries`, [...b.keys()].sort(), [...a.keys()].sort());
    for (const [n, open] of a) {
      const x = await open(), y = await b.get(n)();
      ok(`${name}: ${n} bytes equal (${x.byteLength})`, x.byteLength === y.byteLength && x.every((v, i) => v === y[i]) && b.get(n).size === x.byteLength);
      const r = (await b.get(n).stream()).getReader();
      const chunks = []; let t;
      while (!(t = await r.read()).done) chunks.push(t.value);
      const joined = new Uint8Array(chunks.reduce((sum, c) => sum + c.byteLength, 0));
      let o = 0; for (const c of chunks) { joined.set(c, o); o += c.byteLength; }
      ok(`${name}: ${n} streams the same bytes`, joined.byteLength === x.byteLength && joined.every((v, i) => v === x[i]));
    }
  }

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

  console.log('\n== What a file actually is ==');
  /* An extension is a claim; the first bytes are evidence. This exists because
     trusting the claim let a workbook through as text: decodeBytes falls back
     to windows-1252, which maps EVERY byte to a character, so it can never fail
     and the failure surfaced instead as screenfuls of mojibake quoted back to
     the reader as the file's column names. */
  const xlsxBytes = read('fixtures/roll_shaped.xlsx');
  eq('a workbook sniffs as a zip by its first bytes', B.sniffFormat(xlsxBytes).id, 'zip');
  eq('and as an Excel workbook once its entries are known',
     B.sniffZipContents([...B.readZip(xlsxBytes).keys()]).id, 'xlsx');
  eq('a PDF is recognised', B.sniffFormat(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])).id, 'pdf');
  eq('an older .xls is recognised, so it can be told apart from a .xlsx',
     B.sniffFormat(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1])).id, 'ole');
  ok('plain text is not mistaken for any of them',
     B.sniffFormat(new TextEncoder().encode('a,b,c\n1,2,3\n')) === null);
  ok('and neither is an empty file', B.sniffFormat(new Uint8Array([])) === null);

  console.log('\n== Excel workbooks ==');
  const book = await B.readXlsx(xlsxBytes);
  /* The header is on row 6 under a disclaimer, as the real roll's is. Taking
     row 1 would name every column after a sentence about postal codes. */
  eq('the header row is found rather than assumed to be the first', book.headerRow, 5);
  eq('and it is the header', book.header,
     ['Elector', 'FirstName', 'LastName', 'PropertyAddress',
      'StreetNumb', 'StreetName', 'StreetTyp', 'LocalArea']);
  eq('four data rows follow it', book.rows.length, 4);
  eq('shared strings are resolved', book.rows[0][1], 'DOMENICO');
  eq('numbers come through as their digits', book.rows[0][0], '110155');

  /* The one that matters most. An empty cell is OMITTED from the XML, not
     written blank, so a reader that counts cells as they arrive shifts every
     value after the gap one column left -- and produces a perfectly plausible
     table with the wrong data in it. Position has to come from r="C7". */
  eq('an omitted cell leaves a hole rather than shifting the row left',
     book.rows[1], ['540029', '', 'WI-AFEDZI', '706-1833 FRANCES ST',
                    '1833', 'FRANCES', 'ST', 'Grandview-Woodland']);
  eq('and the column after the hole is still the right column',
     book.rows[1][2], 'WI-AFEDZI');

  eq('an inline string is read', book.rows[2][1], 'DIRAN');
  /* Excel splits a string across runs when its formatting changes part way. */
  eq('rich text is joined across its runs, not truncated at the first',
     book.rows[3][1], 'RICH TEXT CELL');

  eq('the sheet read is named', book.sheet, 'Query1');
  eq('and the others are listed, so taking the first is visible', book.sheets, ['Query1', 'Notes']);
  eq('a named sheet can be asked for', (await B.readXlsx(xlsxBytes, { sheet: 'Notes' })).sheet, 'Notes');

  eq('column letters map to indices', [0, 25, 26, 27, 701].map((_, i) =>
     B.columnIndex(['A', 'Z', 'AA', 'AB', 'ZZ'][i])), [0, 25, 26, 27, 701]);

  console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll binary-format tests passed.\n');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
