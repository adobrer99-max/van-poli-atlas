/* Reading a file of places and putting it on a geography: the coordinate
   shapes, the pair-order trap, address normalisation grounded in the real
   City of Vancouver street list, and the join that an elector roll needs. */
const { load } = require('./harness');
const { Points: P, Geo } = load(
  ['a-geo.js', 'b-text.js', 'c-binary.js', 'd-ingest.js', 'e-analysis.js',
   'f-results.js', 'f2-turnout.js', 'f3-census.js', 'f4-places.js', 'f5-summary.js',
   'f6-points.js'],
  ['Points', 'Geo']);

let fails = 0;
const ok = (n, c, e = '') => { if (c) console.log(`  PASS  ${n}`); else { console.log(`  FAIL  ${n} ${e}`); fails++; } };
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

console.log('\n== Normalising a street, against how Vancouver actually writes them ==');
/* The city's own file is not internally consistent: 386 of its streets end ST
   and none end STREET, while 77 end DRIVE and none end DR. Both directions
   have to fold to one spelling or a roll written the other way matches
   nothing. */
eq('AV and AVENUE reach the same street', P.normalizeStreet('W 16TH AV'), P.normalizeStreet('West 16th Avenue'));
eq('ST and STREET too', P.normalizeStreet('MAIN ST'), P.normalizeStreet('Main Street'));
eq('and DR and DRIVE, which the city writes the other way round',
   P.normalizeStreet('ANZIO DRIVE'), P.normalizeStreet('Anzio Dr.'));
eq('a leading direction folds to one letter', P.normalizeStreet('EAST BROADWAY'), P.normalizeStreet('E Broadway'));
/* W KENT AV NORTH: the last token is a direction, so the street type is the
   one before it. Taking the last token as the type loses the AV entirely. */
eq('a trailing direction is not mistaken for the street type',
   P.normalizeStreet('W KENT AV NORTH'), 'W KENT AVE N');
ok('and it still differs from its southern twin',
   P.normalizeStreet('W KENT AV NORTH') !== P.normalizeStreet('W KENT AV SOUTH'));
/* ST. CATHERINES ST is Saint at the front and Street at the back. Expanding
   every ST would make it STREET CATHERINES STREET. */
eq('a leading Saint survives a trailing Street', P.normalizeStreet('ST. CATHERINES ST'), 'ST CATHERINES ST');
eq('however the other file spells Saint', P.normalizeStreet('Saint Catherines St'), P.normalizeStreet('ST. CATHERINES ST'));
eq('an apostrophe is folded away', P.normalizeStreet("CAPTAIN'S COVE"), P.normalizeStreet('CAPTAINS COVE'));
eq('a street that is all name keeps all of it', P.normalizeStreet('KINGSWAY'), 'KINGSWAY');
eq('and BROADWAY is a name, not a type', P.normalizeStreet('BROADWAY'), 'BROADWAY');

console.log('\n== The civic number, and the unit in front of it ==');
const want = P.addressKey('3449', 'ANZIO DRIVE');
for (const [n, s] of [['101-3449', 'Anzio Dr'], ['#101 3449', 'ANZIO DRIVE'],
                      ['Suite 101, 3449', 'anzio drive'], ['UNIT 101-3449', 'Anzio DR.']]) {
  eq(`a unit prefix is dropped: "${n}"`, P.addressKey(n, s), want);
}
ok('a different number is a different key', P.addressKey('3451', 'ANZIO DRIVE') !== want);
eq('one column holding the lot splits the same way',
   (() => { const a = P.splitAddress('101-3449 Anzio Drive'); return P.addressKey(a.number, a.street); })(), want);
eq('a postal code folds case and spacing', P.postalKey('v5k 1a1'), P.postalKey('V5K1A1'));

console.log('\n== The pair-order trap ==');
/* GeoJSON is [lon, lat]; the city's geo_point_2d is "lat, lon". Reversed,
   every Vancouver address lands in the Indian Ocean with a plausible row
   count and no error at all. */
const VAN = [-123.27, 49.19, -123.02, 49.32];
const latLon = [[49.2522, -123.0296], [49.2611, -123.1139]];
const lonLat = [[-123.0296, 49.2522], [-123.1139, 49.2611]];
eq('a longitude outside +/-90 settles it on its own', P.detectPairOrder(latLon, null),
   { order: 'lat,lon', by: 'range' });
eq('and the other way round', P.detectPairOrder(lonLat, null), { order: 'lon,lat', by: 'range' });
/* Both in range: only the study area can say. Vancouver has no such pair, so
   this is a constructed one. */
const ambiguous = [[49.25, 50.1], [49.26, 50.2]];
eq('with both in range and no extent, it says it assumed',
   P.detectPairOrder(ambiguous, null).by, 'assumed');
const near = [[49.2522, 60], [49.26, 61]];
ok('an extent breaks the tie and says so',
   P.detectPairOrder(near, [49, 49.2, 61, 49.3]).by === 'study area');

const PAIR_H = ['id', 'geo_point_2d'];
const PAIR_R = [['a', '49.2522, -123.0296'], ['b', '49.2611, -123.1139']];
const pairLayout = P.detectPointLayout(PAIR_H, PAIR_R, { extent: VAN });
eq('the layout records the order it found', [pairLayout.kind, pairLayout.order.order], ['pair', 'lat,lon']);
const pairRead = P.readPoints({ header: PAIR_H, rows: PAIR_R }, pairLayout);
ok(`read back inside Vancouver (${pairRead.points[0].lon.toFixed(3)}, ${pairRead.points[0].lat.toFixed(3)})`,
   pairRead.points.every((p) => p.lon > -124 && p.lon < -122 && p.lat > 48 && p.lat < 50));
/* Forced the wrong way, the same rows land in the sea. This is what the
   detection is for. */
const wrong = P.readPoints({ header: PAIR_H, rows: PAIR_R },
  { ...pairLayout, order: { order: 'lon,lat', by: 'forced' } });
ok('forced the wrong way, the points leave the country entirely',
   wrong.points.every((p) => p.lon > 40 && p.lat < -100));

console.log('\n== The three coordinate shapes ==');
const shapes = {
  lonlat: { header: ['longitude', 'latitude'], rows: [['-123.0296', '49.2522']] },
  geometry: { header: ['id', 'Geom'], rows: [['a', '{"coordinates": [-123.0296, 49.2522], "type": "Point"}']] },
  pair: { header: ['geo_point_2d'], rows: [['49.2522, -123.0296']] },
};
for (const [kind, t] of Object.entries(shapes)) {
  const L = P.detectPointLayout(t.header, t.rows, { extent: VAN });
  const r = P.readPoints(t, L);
  ok(`${kind}: one point at the same place`, L.kind === kind && r.points.length === 1
     && Math.abs(r.points[0].lon + 123.0296) < 1e-9 && Math.abs(r.points[0].lat - 49.2522) < 1e-9,
     JSON.stringify(r.points));
}
const bad = P.detectPointLayout(['name', 'colour'], [['a', 'red']]);
ok('a file with no way to be located at all is refused', bad === null);
const broken = P.readPoints({ header: ['longitude', 'latitude'], rows: [['', ''], ['x', 'y'], ['-123.1', '49.2']] },
  P.detectPointLayout(['longitude', 'latitude'], []));
eq('rows that cannot be read are counted, not silently dropped',
   [broken.points.length, broken.report.unreadable], [1, 2]);

console.log('\n== The join an elector roll needs ==');
/* A reference file with coordinates, and a roll with addresses spelled the way
   another agency would spell them. */
const REF_H = ['CIVIC_NUMBER', 'STD_STREET', 'geo_point_2d'];
const REF_R = [
  ['3449', 'ANZIO DRIVE', '49.2522, -123.0296'],
  ['1234', 'W 16TH AV', '49.2580, -123.1500'],
  ['500', 'ST. CATHERINES ST', '49.2700, -123.0800'],
  ['77', 'W KENT AV NORTH', '49.2100, -123.1000'],
];
const refLayout = P.detectPointLayout(REF_H, REF_R, { extent: VAN });
const ref = P.buildReference({ header: REF_H, rows: REF_R }, refLayout);
eq('the reference indexes every row', [ref.keys, ref.duplicates, ref.unusable], [4, 0, 0]);

const ROLL_H = ['House Number', 'Street Name', 'electors'];
const ROLL_R = [
  ['3449', 'Anzio Dr', '2'],
  ['101-1234', 'West 16th Avenue', '3'],
  ['500', 'Saint Catherines Street', '1'],
  ['77', 'W Kent Ave N', '4'],
  ['9999', 'Nowhere Rd', '1'],
];
const rollLayout = P.detectPointLayout(ROLL_H, ROLL_R, { weightColumn: 'electors' });
eq('a roll with addresses and no coordinates needs the reference', rollLayout.kind, 'address');
const roll = P.readPoints({ header: ROLL_H, rows: ROLL_R }, rollLayout, { reference: ref.map });
eq('four of five addresses land, however they were spelled',
   [roll.report.matched, roll.report.read], [4, 4]);
eq('and the one that did not is named rather than absorbed', roll.report.misses, ['9999 NOWHERE RD']);
ok(`the miss rate is reported (${(roll.report.missRate * 100).toFixed(0)}%)`,
   Math.abs(roll.report.missRate - 0.2) < 1e-9);
eq('the weight column is summed, not just the rows counted',
   roll.points.reduce((a, p) => a + p.weight, 0), 10);

/* --- New construction, told apart from a broken join ----------------------
   The property extract baked into a build is a snapshot. Vancouver keeps
   building, so a 2026 roll will carry addresses that were not standing when
   the extract was taken, and those misses are expected and harmless. A miss on
   a street the reference has never heard of is not harmless -- it is usually a
   column picked wrong or a spelling the normaliser does not cover. One number
   covering both hides whichever is the smaller. */
/* A column is chosen by its name, so the pick has to survive contact with the
   rows. The city's property extract carries both a Geom and a geo_point_2d,
   and an export that empties one of them still has its header. */
console.log('\n== A named column that holds nothing is not the one ==');
const BOTH_H = ['CIVIC_NUMBER', 'STD_STREET', 'Geom', 'geo_point_2d'];
const emptyGeom = [['100', 'Main St', '{}', '49.2522, -123.0296']];
eq('an empty geometry column is passed over for the one that parses',
   P.detectPointLayout(BOTH_H, emptyGeom, { extent: VAN }).kind, 'pair');
const goodGeom = [['100', 'Main St', '{"type":"Point","coordinates":[-123.03,49.25]}',
                   '49.2522, -123.0296']];
eq('a geometry column that does parse still wins',
   P.detectPointLayout(BOTH_H, goodGeom, { extent: VAN }).kind, 'geometry');
eq('and with neither readable it falls back to the address key rather than to nothing',
   P.detectPointLayout(BOTH_H, [['100', 'Main St', '{}', '']], { extent: VAN }).kind, 'address');
/* With no rows to check against there is nothing to verify, and the header is
   all there is to go on -- unchanged behaviour for a caller that passes none. */
eq('with no sample rows the header still decides',
   P.detectPointLayout(BOTH_H, [], { extent: VAN }).kind, 'geometry');

console.log('\n== New construction against an unknown street ==');
const NEW_H = ['House Number', 'Street Name'];
const NEW_R = [
  ['3449', 'Anzio Dr'],            // in the reference
  ['3451', 'Anzio Dr'],            // street known, number not: built since
  ['3453', 'ANZIO DRIVE'],         // same, spelled the long way
  ['12', 'Nonesuch Close'],        // street the reference has never seen
];
const newLayout = P.detectPointLayout(NEW_H, NEW_R, {});
const built = P.readPoints({ header: NEW_H, rows: NEW_R }, newLayout,
  { reference: ref.map, referenceStreets: ref.streets });
ok('the reference reports how many streets it knows', ref.streetCount >= 3, String(ref.streetCount));
eq('a number missing from a known street is counted as new construction',
   built.report.newOnKnownStreet.count, 2);
eq('and the unknown street is counted apart', built.report.unknownStreet.count, 1);
eq('both are sampled by key, not just totalled',
   [built.report.newOnKnownStreet.sample.includes('3451 ANZIO DR'),
    built.report.unknownStreet.sample.includes('12 NONESUCH CLOSE')], [true, true]);
ok('and the split is marked as available', built.report.classified);

/* Without the street set there is nothing to tell them apart with, and saying
   so beats guessing: every miss falls to the unknown bucket and classified is
   false, so a reader is not shown a new-construction count that means nothing. */
const unsplit = P.readPoints({ header: NEW_H, rows: NEW_R }, newLayout, { reference: ref.map });
eq('with no street set, nothing is claimed about which kind of miss it is',
   [unsplit.report.newOnKnownStreet.count, unsplit.report.unknownStreet.count,
    unsplit.report.classified], [0, 3, false]);

/* The noun in "carries at least one ___" is whatever the reader typed, and a
   bare .replace(/s$/) put "addresse" in the line they see first. */
console.log('\n== Making the reader\'s own noun singular ==');
for (const [plural, one] of [['addresses', 'address'], ['electors', 'elector'],
                             ['properties', 'property'], ['households', 'household'],
                             ['rows', 'row'], ['voters', 'voter']]) {
  eq(`${plural} -> ${one}`, P.singular(plural), one);
}
eq('a word with no plural is left as it is', P.singular('people'), 'people');
eq('and -us is not a plural ending', P.singular('census'), 'census');
eq('nor is -is', P.singular('analysis'), 'analysis');
eq('an empty noun does not throw', P.singular(''), '');

console.log('\n== Putting them on a layer ==');
const cell = (x0, y0, w, h, id) => ({ type: 'Feature', properties: { id }, geometry: { type: 'Polygon',
  coordinates: [[[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h], [x0, y0]]] } });
const feats = [cell(-123.20, 49.20, 0.10, 0.10, 'A'), cell(-123.10, 49.20, 0.10, 0.10, 'B'),
               cell(-123.00, 49.20, 0.10, 0.10, 'C')];
feats.forEach((f) => Geo.normalizeWinding(f.geometry));
const index = Geo.buildIndex(feats);
const pts = [
  { lon: -123.15, lat: 49.25, weight: 5 }, { lon: -123.16, lat: 49.26, weight: 1 },
  { lon: -123.05, lat: 49.25, weight: 2 }, { lon: -122.50, lat: 49.25, weight: 9 },
];
const a = P.assignToLayer(pts, index, (i) => feats[i].properties.id);
eq('each point lands in exactly one area', [a.inside, a.outside], [3, 1]);
eq('counts and weights are kept apart', [a.per.get('A').count, a.per.get('A').weight], [2, 6]);
eq('and a point outside every polygon is counted, not discarded', a.outside, 1);
ok('the area with nothing in it simply has no entry', !a.per.has('C'));
const cov = P.coverage(a.per, ['A', 'B', 'C'], { disclosureBelow: 2 });
eq('coverage names the empty areas', [cov.areas, cov.empty], [3, 1]);
ok(`and how many are small enough to be disclosive (${cov.sparse})`, cov.sparse === 1);

console.log('\n== The shape of the misses ==');
/* 80.1% against the real roll, and the row count alone could not say what kind
   of failure it was. A roll has one row per elector, so a tower is hundreds of
   rows at one address: tens of thousands of unmatched rows collapsing to a
   couple of thousand addresses means the reference lacks the address those
   residents write, and no work on the normaliser would touch it. Spread across
   nearly as many addresses as rows means the keying is wrong. Opposite fixes,
   so the report has to tell them apart. */
const shapeRef = P.buildReference(
  { header: ['CIVIC_NUMBER', 'STD_STREET', 'longitude', 'latitude'],
    rows: [['1', 'KNOWN ST', '-123.1', '49.28']] },
  P.detectPointLayout(['CIVIC_NUMBER', 'STD_STREET', 'longitude', 'latitude'],
                      [['1', 'KNOWN ST', '-123.1', '49.28']]));
const rollHeader = ['CIVIC_NUMBER', 'STD_STREET'];
const tower = { header: rollHeader, rows: [] };
for (let i = 0; i < 40; i++) tower.rows.push(['999', 'KNOWN ST']);   // one address
const spread = { header: rollHeader, rows: [] };
for (let i = 0; i < 40; i++) spread.rows.push([String(2000 + i), 'KNOWN ST']); // forty
const shapeLayout = P.detectPointLayout(rollHeader, tower.rows);
const towerReport = P.readPoints(tower, shapeLayout,
  { reference: shapeRef.map, referenceStreets: shapeRef.streets }).report;
const spreadReport = P.readPoints(spread, shapeLayout,
  { reference: shapeRef.map, referenceStreets: shapeRef.streets }).report;
eq('forty electors at one unmatched address are forty rows', towerReport.missRows, 40);
eq('but one distinct address', towerReport.missKeys, 1);
eq('while forty at separate addresses are forty of each',
   [spreadReport.missRows, spreadReport.missKeys], [40, 40]);
ok('and the busiest unmatched address is named, with its count',
   towerReport.topMisses[0].key === '999 KNOWN ST' && towerReport.topMisses[0].rows === 40,
   JSON.stringify(towerReport.topMisses[0]));

console.log('\n== A lone direction has one canonical position ==');
/* "E 10TH AVENUE" and "10TH AVE E" are one street. The City's property file
   leads with the direction; the electors roll trails it in a column of its own.
   Keying them apart would miss every directional avenue in Vancouver -- most of
   the East Side -- while reporting a clean read and the right row count.

   The 100% rehearsal could not have caught it: it respelled the property file's
   OWN addresses, so both sides of that join shared one convention. It took a
   real second agency to surface it, which is the argument for this test. */
for (const [a, b] of [['10TH AVE E', 'E 10TH AVENUE'],
                      ['KING EDWARD AVE E', 'E KING EDWARD AVE'],
                      ['10TH AVENUE EAST', 'E 10TH AVE'],
                      ['41ST AVE W', 'WEST 41ST AVENUE']]) {
  eq(`"${a}" and "${b}" are the same street`, P.addressKey('1883', a), P.addressKey('1883', b));
}
/* Two tokens is enough. The guard used to require three, which excluded
   exactly the streets with no type at all -- and in Vancouver that is Broadway.
   "BROADWAY E" never had its direction taken off while "E BROADWAY" did, so the
   two keyed differently and every address on East and West Broadway missed,
   reported as a street the reference had never heard of. Found against the real
   roll at an 80.1% match rate, not against any fixture. */
for (const [a, b] of [['BROADWAY E', 'E BROADWAY'], ['BROADWAY W', 'W BROADWAY']]) {
  eq(`"${a}" and "${b}" are the same street, with no type between them`,
     P.addressKey('1209', a), P.addressKey('1209', b));
}
/* And the compound directions written out: SW Marine Drive is a real street,
   and an agency spelling it "Southwest" was missing one spelling it "SW". */
for (const [a, b] of [['SW MARINE DR', 'SOUTHWEST MARINE DRIVE'],
                      ['NE MARINE DR', 'NORTHEAST MARINE DRIVE']]) {
  eq(`"${a}" and "${b}" are the same street`, P.addressKey('1', a), P.addressKey('1', b));
}

/* But only when there is exactly one. A prefix and a suffix on the same street
   mean different things, and folding them together would produce "KENT AVE W N"
   and lose which was which. */
eq('a street carrying both a prefix and a suffix keeps them where they were',
   P.addressKey('1883', 'W KENT AV NORTH'), '1883 W KENT AVE N');
ok('and it is still not confused with the same street lacking one',
   P.addressKey('1883', 'W KENT AV NORTH') !== P.addressKey('1883', 'KENT AVE W'));

console.log('\n== A street split across columns ==');
/* The electors roll splits its street three ways -- REGIMENT | SQ | E -- while
   the property reference it joins against holds the whole thing. Keying on the
   name column alone builds "131 REGIMENT" against a reference holding
   "131 REGIMENT SQ", so every row misses. Nothing errors, the row count is
   right, and the match rate is zero: the exact shape of a silent wrong answer
   this atlas keeps finding. */
const splitHeader = ['Elector', 'StreetNumb', 'StreetNumberSuf', 'StreetName',
                     'StreetTyp', 'StreetDirection', 'MailingAddress'];
const splitRows = [
  ['110155', '131', '', 'REGIMENT', 'SQ', '', 'PO BOX 1 SOMEWHERE ELSE'],
  ['430952', '1483', '', 'KING EDWARD', 'AVE', 'E', 'PO BOX 2 SOMEWHERE ELSE'],
  ['268402', '1883', 'A', '10TH', 'AVE', 'E', 'PO BOX 3 SOMEWHERE ELSE'],
];
const splitLayout = P.detectPointLayout(splitHeader, splitRows);
eq('the number column is StreetNumb, not the suffix beside it',
   splitHeader[splitLayout.number], 'StreetNumb');
eq('and the suffix is picked up as a suffix', splitHeader[splitLayout.numberSuffix], 'StreetNumberSuf');
eq('and the type and direction columns are found',
   [splitHeader[splitLayout.streetType], splitHeader[splitLayout.streetDir]],
   ['StreetTyp', 'StreetDirection']);
/* A mailing address is not where somebody lives. The roll's own disclaimer says
   the two differ often enough that postal codes are blanked when they do, so
   choosing it would place electors at their accountant's office. */
ok('a mailing-address column is never chosen as the address',
   splitLayout.address < 0 || !/mail/i.test(splitHeader[splitLayout.address]),
   String(splitHeader[splitLayout.address]));

/* A reference holding the assembled form, as the city's property file does. */
const splitRefTable = { header: ['CIVIC_NUMBER', 'STD_STREET', 'longitude', 'latitude'], rows: [
  ['131', 'REGIMENT SQ', '-123.10', '49.28'],
  ['1483', 'KING EDWARD AVE E', '-123.09', '49.25'],
  ['1883A', 'E 10TH AVENUE', '-123.07', '49.26'],
]};
const splitRefLayout = P.detectPointLayout(splitRefTable.header, splitRefTable.rows);
const splitRef = P.buildReference(splitRefTable, splitRefLayout);
const joined = P.readPoints({ header: splitHeader, rows: splitRows }, splitLayout,
                            { reference: splitRef.map, referenceStreets: splitRef.streets });
eq(`every split-street row rejoins (${joined.report.matched} of ${joined.report.rows})`,
   joined.report.matched, 3);
ok('including the one whose number carries a suffix',
   joined.points.some((p) => Math.abs(p.lat - 49.26) < 1e-9));
/* And the proof that the assembly is what did it: drop the type and direction
   columns from the layout and the same rows miss entirely. */
const crippled = { ...splitLayout, streetType: -1, streetDir: -1, numberSuffix: -1 };
const crippledJoin = P.readPoints({ header: splitHeader, rows: splitRows }, crippled,
                                  { reference: splitRef.map, referenceStreets: splitRef.streets });
eq('while keying on the name column alone matches nothing at all',
   crippledJoin.report.matched, 0);

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll point tests passed.\n');
process.exit(fails ? 1 : 0);
