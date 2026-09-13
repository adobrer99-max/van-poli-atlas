/* The Results summary: reading the loaded files back without modelling
   anything, from either shape results arrive in. */
const { load } = require('./harness');
const { Summary, Results, Places } = load(
  ['a-geo.js', 'b-text.js', 'c-binary.js', 'd-ingest.js', 'e-analysis.js',
   'f-results.js', 'f2-turnout.js', 'f3-census.js', 'f4-places.js', 'f5-summary.js'],
  ['Summary', 'Results', 'Places']);

let fails = 0;
const ok = (n, c, e = '') => { if (c) console.log(`  PASS  ${n}`); else { console.log(`  FAIL  ${n} ${e}`); fails++; } };
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const near = (n, a, b, tol = 1e-9) => ok(n, a != null && Math.abs(a - b) <= tol, `got ${a} want ${b}`);

console.log('\n== Results by voting area ==');
/* A wide file: two districts, two areas each, with electors and rejected
   ballots so turnout and the rejected share have something to report. */
const HEADER = ['District', 'Voting Area', 'Registered Voters', 'Alpha', 'Beta', 'Rejected Ballots'];
const ROWS = [
  ['North', '001', '1000', '600', '300', '10'],
  ['North', '002', '1000', '500', '400', '0'],
  ['South', '001', '500', '100', '300', '5'],
  ['South', '002', '500', '150', '250', '5'],
];
const mapping = Results.detectLayout(HEADER, ROWS);
const agg = Results.aggregate({ header: HEADER, rows: ROWS }, mapping, { ignoreLeadingZeros: true, ignoreCase: true });
const areas = Summary.fromUnits(agg.units, { unitName: 'voting areas' });

eq('every ballot in the file is counted', [areas.valid, areas.rejected, areas.ballots], [2600, 20, 2620]);
near('the rejected share is of ballots, not of votes', areas.rejectedShare, 20 / 2620);
eq('parties are ranked by votes', areas.parties.map((p) => [p.name, p.votes]), [['Alpha', 1350], ['Beta', 1250]]);
near('a share is of valid votes', areas.parties[0].share, 1350 / 2600);
near('the margin is a gap in percentage points of the valid vote', areas.margin, 100 / 2600);
eq('the winner is named', areas.winner.name, 'Alpha');
near('turnout comes from the elector counts the file carried', areas.turnout, 2620 / 3000);

eq('districts are listed, busiest first', areas.districts.map((d) => d.code), ['North', 'South']);
const north = areas.districts.find((d) => d.code === 'North');
const south = areas.districts.find((d) => d.code === 'South');
eq('a district carries its own totals', [north.ballots, north.valid, north.rejected], [1810, 1800, 10]);
eq('and its own winner', [north.winner.name, south.winner.name], ['Alpha', 'Beta']);
near('a district margin is its own', south.margin, (550 - 250) / 800);
near('and so is its turnout', north.turnout, 1810 / 2000);
eq('who won how many districts', [...areas.districtsWon], [['Alpha', 1], ['Beta', 1]]);
eq('the largest units are ranked', areas.largest.map((u) => u.ballots), [910, 900, 405, 405]);
eq('a unit is labelled by district and area', areas.largest[0].label, 'North · 001');
eq('a voting-area file has no channel breakdown', areas.channels, null);
eq('nor a located share', areas.located, null);

console.log('\n== A file with no elector column ==');
const NO_E = ['District', 'Voting Area', 'Alpha', 'Beta'];
const noE = Summary.fromUnits(Results.aggregate(
  { header: NO_E, rows: [['North', '001', '10', '5']] },
  Results.detectLayout(NO_E, [['North', '001', '10', '5']]), {}).units);
ok('turnout is null, never zero and never guessed', noE.turnout === null, String(noE.turnout));
ok('and the district agrees', noE.districts[0].turnout === null);

console.log('\n== Results by voting place ==');
const PH = ['electoral_district_abbreviation', 'electoral_district_name', 'voting_opportunity',
            'geocode_ready', 'valid_votes', 'rejected_ballots', 'total_ballots',
            'alpha_votes', 'beta_votes', 'longitude', 'latitude', 'building_name'];
const prow = (ed, name, opp, ready, a, b, rej, lon, lat, place) =>
  [ed, name, opp, ready, String(a + b), String(rej), String(a + b + rej), String(a), String(b),
   lon == null ? '' : String(lon), lat == null ? '' : String(lat), place];
const PROWS = [
  prow('AAA', 'District AAA', 'Final voting', 'yes', 300, 100, 4, -123.19, 49.28, 'North Hall'),
  prow('AAA', 'District AAA', 'Advance voting', 'yes', 500, 200, 6, -123.19, 49.26, 'North Hall'),
  prow('AAA', 'District AAA', 'Vote by mail', 'no', 40, 60, 0, null, null, ''),
  prow('BBB', 'District BBB', 'Final voting', 'yes', 100, 200, 0, -123.30, 49.20, 'South Hall'),
];
const layout = Places.detectPlaceLayout(PH);
const read = Places.readPlaces({ header: PH, rows: PROWS }, layout);
const places = Summary.fromPlaces(read);

eq('located and unlocated rows are both counted in the totals',
   [places.valid, places.rejected, places.ballots], [1500, 10, 1510]);
eq('parties come from the party columns', places.parties.map((p) => [p.name, p.votes]),
   [['Alpha', 940], ['Beta', 560]]);
eq('the city winner is the one with the most votes', places.winner.name, 'Alpha');
eq('districts keep their readable names', places.districts.map((d) => d.name).sort(),
   ['District AAA', 'District BBB']);
const aaa = places.districts.find((d) => d.code === 'AAA');
/* AAA: final 404, advance 706, mail 100. */
eq('a district sums its own places, located or not', [aaa.ballots, aaa.valid], [1210, 1200]);
eq('and BBB is won by the other party', places.districts.find((d) => d.code === 'BBB').winner.name, 'Beta');

console.log('\n== How people voted ==');
eq('channels are ranked by ballots',
   places.channels.map((c) => [c.name, c.ballots]),
   [['Advance voting', 706], ['Final voting', 704], ['Vote by mail', 100]]);
near('a channel share is of all ballots', places.channels[0].share, 706 / 1510);
near('every channel together accounts for every ballot',
     places.channels.reduce((a, c) => a + c.ballots, 0), 1510);
eq('the located count and share are reported apart from the totals',
   [places.located.places, places.located.unlocated, places.located.ballots], [3, 1, 1410]);
near('so the part that can go on a map is visible', places.located.share, 1410 / 1510);
eq('the busiest places are ranked, with their channel',
   places.largest.map((p) => [p.name, p.opportunity, p.ballots]),
   [['North Hall', 'Advance voting', 706], ['North Hall', 'Final voting', 404], ['South Hall', 'Final voting', 300]]);
ok('an unlocated row is never listed as a place',
   places.largest.every((p) => p.name !== ''), JSON.stringify(places.largest.map((p) => p.name)));

console.log('\n== The export ==');
const csv = Summary.toCsv(places, 'Provincial 2024');
const head = csv[0];
ok('the header names both a votes and a share column per party',
   head.includes('Alpha_votes') && head.includes('Alpha_pct') && head.includes('Beta_votes'), head.join(','));
eq('every row is the same width', [...new Set(csv.map((r) => r.length))], [head.length]);
const sections = csv.slice(1).map((r) => r[0]);
eq('one total, then districts, then channels, then places',
   [...new Set(sections)], ['total', 'district', 'channel', 'place']);
const totalRow = csv.find((r) => r[0] === 'total');
eq('the total row carries the city figures', [totalRow[3], totalRow[4], totalRow[5]], [1510, 1500, 10]);
eq('and names the winner', totalRow[8], 'Alpha');
const areaCsv = Summary.toCsv(areas, 'Federal 2025');
eq('a voting-area summary exports units rather than places',
   [...new Set(areaCsv.slice(1).map((r) => r[0]))], ['total', 'district', 'unit']);
ok('turnout reaches the export as a percentage',
   areaCsv.find((r) => r[0] === 'total')[7] === (2620 / 3000 * 100).toFixed(2),
   areaCsv.find((r) => r[0] === 'total')[7]);

console.log('\n== Registered voters from their own file ==');
/* Elections BC publishes the denominator per district in the Statement of
   Votes, not in the results file: "registered voters who voted" over
   "registered voters". Vancouver-Fraserview 2024, verbatim. */
const ETABLE = { header: ['Electoral District', 'Registered voters who voted', 'Registered voters'],
                 rows: [['AAA', '1,210', '3,000'], ['BBB', '300', '1,000']] };
const electors = Summary.readElectors(ETABLE);
eq('the denominator column is chosen, not the numerator beside it',
   electors.electorColumn, 'Registered voters');
eq('counts are read through their thousands separators', [...electors.byDistrict], [['AAA', 3000], ['BBB', 1000]]);
eq('and totalled', electors.total, 4000);
const withE = Summary.fromPlaces(read, { electors });
near('a district turnout is ballots over registered voters',
     withE.districts.find((d) => d.code === 'AAA').turnout, 1210 / 3000);
near('and the city figure is every district together', withE.turnout, 1510 / 4000);
ok('the tab can say the count was supplied rather than in the results file',
   withE.districts.every((d) => d.electorsSupplied) && withE.electorsFrom === 'supplied');
ok('and that every district has one', withE.electorsComplete === true);
const partial = Summary.fromPlaces(read, { electors: { byDistrict: new Map([['AAA', 3000]]), total: 3000 } });
ok('a partial set is flagged, not silently averaged',
   partial.electorsComplete === false && partial.districtsWithElectors === 1);
ok('a file with its own elector counts keeps them',
   areas.districts.every((d) => d.electorsSupplied === false) && areas.electorsFrom === 'file');
let threw = '';
try { Summary.readElectors({ header: ['Something', 'Else'], rows: [['a', '1']] }); }
catch (e) { threw = e.message; }
ok('a table with no usable columns says which it has', /district column/.test(threw), threw);

console.log('\n== Nothing loaded ==');
const empty = Summary.fromUnits(new Map());
eq('an empty file summarises to zero, not to NaN', [empty.ballots, empty.valid, empty.rejected], [0, 0, 0]);
ok('with no winner and no margin', empty.winner === null && empty.margin === null);
ok('and no districts', empty.districts.length === 0);
ok('its export is just a header', Summary.toCsv(empty, 'Nothing').length === 2);

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll summary tests passed.\n');
process.exit(fails ? 1 : 0);
