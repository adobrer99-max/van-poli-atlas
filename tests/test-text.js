const { load } = require('./harness');
const T = load(['b-text.js'], ['TextFormats']).TextFormats;
let fails = 0;
const ok = (n, c, e = '') => { if (c) console.log(`  PASS  ${n}`); else { console.log(`  FAIL  ${n} ${e}`); fails++; } };
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

console.log('\n== Delimited text ==');
// Shaped like a real Elections Canada poll-results file: bilingual headers
// containing slashes, a quoted field containing a comma, and CRLF endings.
const ecCsv = '﻿"Electoral District Number/Numéro de circonscription","Polling Station Number/Numéro du bureau de scrutin",'
  + '"Polling Station Name/Nom du bureau de scrutin","Political Affiliation Name_English/Appartenance politique_Anglais",'
  + '"Candidate Poll Votes Count/Votes du candidat pour le bureau"\r\n'
  + '59035,1,"Roundhouse Community Centre, Davie St","Liberal",142\r\n'
  + '59035,1,"Roundhouse Community Centre, Davie St","Conservative",88\r\n'
  + '59035,"12A","St. Paul\'s Hospital","Liberal",7\r\n';
const p = T.parseDelimited(ecCsv);
eq('BOM stripped from first header', p.header[0], 'Electoral District Number/Numéro de circonscription');
eq('delimiter sniffed as comma', p.delimiter, ',');
eq('row count', p.rows.length, 3);
eq('quoted field with embedded comma', p.rows[0][2], 'Roundhouse Community Centre, Davie St');
eq('alphanumeric poll number kept as text', p.rows[2][1], '12A');
eq('accented header survives', p.header[1].includes('Numéro'), true);

const semi = T.parseDelimited('a;b;c\n1;2;3\n');
eq('semicolon delimiter sniffed', semi.delimiter, ';');
eq('semicolon row', semi.rows[0], ['1', '2', '3']);

const tabbed = T.parseDelimited('a\tb\n1\t2\n');
eq('tab delimiter sniffed', tabbed.delimiter, '\t');

const multiline = T.parseDelimited('a,b\n"line one\nline two",2\n');
eq('newline inside quoted field', multiline.rows[0][0], 'line one\nline two');
const doubled = T.parseDelimited('a,b\n"say ""hi""",2\n');
eq('doubled quotes unescaped', doubled.rows[0][0], 'say "hi"');
eq('blank trailing line ignored', T.parseDelimited('a,b\n1,2\n\n').rows.length, 1);

console.log('\n== Encoding fallback ==');
const cp1252 = new Uint8Array([0x4d, 0x6f, 0x6e, 0x74, 0x72, 0xe9, 0x61, 0x6c]); // "Montréal" in cp1252
eq('windows-1252 fallback', T.decodeBytes(cp1252), 'Montréal');
eq('utf-8 preferred', T.decodeBytes(new TextEncoder().encode('Montréal')), 'Montréal');

console.log('\n== XML ==');
const x = T.parseXml('<?xml version="1.0"?><a xmlns:k="urn:x"><k:b id="1">hi</k:b><c/><d><![CDATA[<raw>]]></d><!-- note --><e>a &amp; b &#233;</e></a>');
const a = T.findAll(x, 'a')[0];
eq('namespace prefix stripped', T.findAll(x, 'b').length, 1);
eq('attribute read', T.findAll(x, 'b')[0].attrs.id, '1');
eq('element text', T.childText(a, 'b'), 'hi');
eq('self-closing element', T.findAll(x, 'c').length, 1);
eq('CDATA preserved verbatim', T.childText(a, 'd'), '<raw>');
eq('entities decoded', T.childText(a, 'e'), 'a & b é');
eq('comment skipped', T.findAll(x, 'note').length, 0);
// A > inside an attribute value must not end the tag.
eq('gt inside attribute', T.findAll(T.parseXml('<r><n v="a>b">t</n></r>'), 'n')[0].attrs.v, 'a>b');

console.log('\n== KML ==');
const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
 <Placemark><name>VA 001</name>
  <ExtendedData><SchemaData schemaUrl="#s">
    <SimpleData name="ED_NAME">Vancouver-Strathcona</SimpleData>
    <SimpleData name="VA_NUMBER">001</SimpleData>
  </SchemaData></ExtendedData>
  <Polygon><outerBoundaryIs><LinearRing><coordinates>
    -123.1,49.2,0 -123.0,49.2,0 -123.0,49.3,0 -123.1,49.3,0 -123.1,49.2,0
  </coordinates></LinearRing></outerBoundaryIs>
  <innerBoundaryIs><LinearRing><coordinates>
    -123.08,49.22,0 -123.02,49.22,0 -123.02,49.28,0 -123.08,49.28,0 -123.08,49.22,0
  </coordinates></LinearRing></innerBoundaryIs>
  </Polygon></Placemark>
 <Placemark><name>VA 002</name>
  <Data name="ED_NAME"><value>Vancouver-Mount Pleasant</value></Data>
  <MultiGeometry>
   <Polygon><outerBoundaryIs><LinearRing><coordinates>-123.2,49.2 -123.15,49.2 -123.15,49.25 -123.2,49.2</coordinates></LinearRing></outerBoundaryIs></Polygon>
   <Polygon><outerBoundaryIs><LinearRing><coordinates>-123.3,49.2 -123.25,49.2 -123.25,49.25 -123.3,49.2</coordinates></LinearRing></outerBoundaryIs></Polygon>
  </MultiGeometry></Placemark>
 <Placemark><name>a point, not an area</name><Point><coordinates>-123,49</coordinates></Point></Placemark>
</Document></kml>`;
const f = T.kmlToFeatures(kml);
eq('two polygonal placemarks (point skipped)', f.length, 2);
eq('SimpleData became a property', f[0].properties.ED_NAME, 'Vancouver-Strathcona');
eq('VA number kept as text', f[0].properties.VA_NUMBER, '001');
eq('name property', f[0].properties.name, 'VA 001');
eq('polygon with hole has 2 rings', f[0].geometry.coordinates.length, 2);
eq('3D coordinates reduced to lon/lat', f[0].geometry.coordinates[0][0], [-123.1, 49.2]);
eq('MultiGeometry -> MultiPolygon', f[1].geometry.type, 'MultiPolygon');
eq('two parts', f[1].geometry.coordinates.length, 2);
eq('Data/value became a property', f[1].properties.ED_NAME, 'Vancouver-Mount Pleasant');
// unclosed ring must be closed
const openRing = T.kmlToFeatures('<kml><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 1,0 1,1</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>');
eq('unclosed ring is closed', openRing[0].geometry.coordinates[0].length, 4);
eq('closing point equals first', openRing[0].geometry.coordinates[0][3], [0, 0]);

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll text-format tests passed.\n');
process.exit(fails ? 1 : 0);
