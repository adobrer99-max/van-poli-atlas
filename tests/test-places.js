/* Voting-place results: reading Elections BC's 2024 layout, building
   catchments, and spreading ballots onto voting areas without losing one. */
const { load } = require('./harness');
const { Places, Geo, Turnout, Analysis } = load(
  ['a-geo.js', 'b-text.js', 'c-binary.js', 'd-ingest.js', 'e-analysis.js',
   'f-results.js', 'f2-turnout.js', 'f3-census.js', 'f4-places.js'],
  ['Places', 'Geo', 'Turnout', 'Analysis']);

let fails = 0;
const ok = (n, c, e = '') => { if (c) console.log(`  PASS  ${n}`); else { console.log(`  FAIL  ${n} ${e}`); fails++; } };
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const near = (n, a, b, tol = 1e-9) => ok(n, Math.abs(a - b) <= tol, `got ${a} want ${b}`);

/* The real file's header, verbatim. */
const HEADER = ['event_year', 'electoral_district_abbreviation', 'electoral_district_name',
  'address_standard_id', 'voting_location', 'voting_opportunity', 'geocode_ready', 'valid_votes',
  'rejected_ballots', 'total_ballots', 'winning_party', 'winning_party_share', 'margin_over_second',
  'combined_results', 'results_reported_under', 'bc_green_party_votes', 'bc_green_party_share',
  'bc_ndp_votes', 'bc_ndp_share', 'communist_party_of_bc_votes', 'communist_party_of_bc_share',
  'conservative_party_votes', 'conservative_party_share', 'independent_votes', 'independent_share',
  'longitude', 'latitude', 'street_address', 'locality', 'building_name', 'geocode_source'];

const row = ({ ed = 'AAA', opportunity = 'Final voting', ready = 'yes', green = 0, ndp = 0, com = 0,
               con = 0, ind = 0, rejected = 0, lon = '', lat = '', name = '', address = '' }) => {
  const valid = green + ndp + com + con + ind;
  const r = HEADER.map(() => '');
  const at = (col, v) => { r[HEADER.indexOf(col)] = String(v); };
  at('event_year', 2024); at('electoral_district_abbreviation', ed);
  at('electoral_district_name', 'District ' + ed); at('voting_opportunity', opportunity);
  at('geocode_ready', ready); at('valid_votes', valid); at('rejected_ballots', rejected);
  at('total_ballots', valid + rejected); at('bc_green_party_votes', green); at('bc_ndp_votes', ndp);
  at('communist_party_of_bc_votes', com); at('conservative_party_votes', con);
  at('independent_votes', ind); at('longitude', lon); at('latitude', lat);
  at('building_name', name); at('street_address', address);
  return r;
};

console.log('\n== Reading the layout by name ==');
const layout = Places.detectPlaceLayout(HEADER);
ok('a voting-place file is recognised', layout !== null);
eq('district column', HEADER[layout.district], 'electoral_district_abbreviation');
eq('opportunity column', HEADER[layout.opportunity], 'voting_opportunity');
eq('coordinate columns', [HEADER[layout.lon], HEADER[layout.lat]], ['longitude', 'latitude']);
eq('rejected column', HEADER[layout.rejected], 'rejected_ballots');
eq('geocode switch found', HEADER[layout.ready], 'geocode_ready');
eq('party columns, shares excluded', layout.parties.map((p) => p.name),
   ['BC Green Party', 'BC NDP', 'Communist Party of BC', 'Conservative Party', 'Independent']);
ok('valid_votes is not read as a party', !layout.parties.some((p) => /valid/i.test(p.column)));
eq('a results-by-voting-area file is not mistaken for one',
   Places.detectPlaceLayout(['Electoral District', 'Voting Area', 'Party', 'Votes']), null);
eq('acronyms and small words in party names',
   ['bc_ndp', 'communist_party_of_bc', 'conservative_party'].map(Places.partyLabel),
   ['BC NDP', 'Communist Party of BC', 'Conservative Party']);

console.log('\n== Located and unlocated rows ==');
/* Four areas in two rows, with a final-voting place on the same meridian above
   and below them, so the northern pair is plainly nearer the northern hall and
   the southern pair the southern one. */
const rows = [
  row({ ed: 'AAA', opportunity: 'Final voting', lon: -123.19, lat: 49.28, ndp: 300, con: 100, rejected: 4, name: 'North Hall' }),
  row({ ed: 'AAA', opportunity: 'Final voting', lon: -123.19, lat: 49.24, ndp: 100, con: 300, rejected: 0, name: 'South Hall' }),
  row({ ed: 'AAA', opportunity: 'Advance voting', lon: -123.15, lat: 49.26, ndp: 200, con: 200, rejected: 8, name: 'North Hall' }),
  row({ ed: 'AAA', opportunity: 'Vote by mail', ready: 'no', ndp: 40, con: 60, rejected: 0 }),
  row({ ed: 'AAA', opportunity: 'Final voting - out-of-district', ready: 'no', ndp: 10, con: 10 }),
  row({ ed: 'BBB', opportunity: 'Final voting', lon: -123.30, lat: 49.20, ndp: 50, green: 50, name: 'Elsewhere Hall' }),
];
const read = Places.readPlaces({ header: HEADER, rows }, layout);
eq('located rows', read.places.length, 4);
eq('unlocated rows', read.unlocated.length, 2);
ok('a row whose geocode_ready says no is not located',
   read.unlocated.every((p) => /mail|out-of-district/i.test(p.opportunity)));
eq('parties ranked by votes', read.parties.map(([n]) => n).slice(0, 2), ['BC NDP', 'Conservative Party']);
eq('districts seen', read.districts, ['AAA', 'BBB']);
near('every ballot in the file is counted once', read.ballots,
     404 + 400 + 408 + 100 + 20 + 100, 1e-9);
eq('only final voting earns a catchment',
   read.places.filter((p) => p.final).map((p) => p.opportunity),
   ['Final voting', 'Final voting', 'Final voting']);
ok('an out-of-district final row is not final voting', !Places.isFinalVoting('Final voting - out-of-district'));

console.log('\n== Catchments ==');
const cell = (w, s, size, props) => ({
  properties: props,
  geometry: { type: 'Polygon', coordinates: [[[w, s], [w + size, s], [w + size, s + size], [w, s + size], [w, s]]] },
});
/* AAA holds four cells; the two northern ones sit nearer North Hall, the two
   southern ones nearer South Hall. BBB holds one cell far to the west. */
const features = [
  cell(-123.22, 49.27, 0.02, { ED_ABBREVIATION: 'AAA', VA_CODE: '001' }),
  cell(-123.18, 49.27, 0.02, { ED_ABBREVIATION: 'AAA', VA_CODE: '002' }),
  cell(-123.22, 49.23, 0.02, { ED_ABBREVIATION: 'AAA', VA_CODE: '003' }),
  cell(-123.12, 49.23, 0.02, { ED_ABBREVIATION: 'AAA', VA_CODE: '004' }),
  cell(-123.32, 49.19, 0.02, { ED_ABBREVIATION: 'BBB', VA_CODE: '001' }),
  cell(-123.50, 49.19, 0.02, { ED_ABBREVIATION: 'CCC', VA_CODE: '001' }),
];
const pointOf = (f) => Geo.representativePoint(f.geometry);
const assigned = Places.assignAreas(features, read.places, { pointOf });
eq('catchments built', assigned.catchments, 3);
eq('every area of a district with a place is assigned', assigned.placedFeatures, 5);
eq('the northern cells go to the northern hall',
   [assigned.assignment[0], assigned.assignment[1]], [0, 0]);
eq('the southern cells go to the southern hall',
   [assigned.assignment[2], assigned.assignment[3]], [1, 1]);
eq('a district with no place of its own is reported, not guessed',
   assigned.districtsWithoutPlace, ['CCC']);
eq('and none of its areas is assigned', assigned.assignment[5], -1);
ok('the advance place earns no catchment', !assigned.byPlace.has(2), 'index 2 is the advance row');
ok('distance is recorded in metres', assigned.distanceM[0] > 100 && assigned.distanceM[0] < 5000,
   String(assigned.distanceM[0]));

console.log('\n== Spreading ballots by population ==');
/* Cell 0 holds three times the people of cell 1, so it takes three quarters of
   North Hall's ballots; cells 2 and 3 weigh the same and split South Hall's
   evenly. The three place-less rows -- advance, mail, out-of-district -- are
   spread over all four cells of AAA in proportion to the same population. */
const pop = [300, 100, 100, 100, 100, 100];
const spread = Places.spreadToAreas(features, read, assigned, { weightOf: (i) => pop[i] });
const u = (i) => spread.values.get(i);
const AAA_POP = 600;
const SPREAD_NDP = 200 + 40 + 10;         // advance + mail + out-of-district
const SPREAD_CON = 200 + 60 + 10;
const SPREAD_BALLOTS = 408 + 100 + 20;

near('cell 0: three quarters of North Hall plus half the district spread',
     u(0).parties.get('BC NDP'), 300 * 0.75 + SPREAD_NDP * (300 / AAA_POP));
near('cell 1: one quarter plus one sixth',
     u(1).parties.get('BC NDP'), 300 * 0.25 + SPREAD_NDP * (100 / AAA_POP));
near('South Hall splits evenly between its two areas',
     u(2).parties.get('Conservative Party'), u(3).parties.get('Conservative Party'));
near('and each of those is half the hall plus a sixth of the spread',
     u(2).parties.get('Conservative Party'), 300 * 0.5 + SPREAD_CON * (100 / AAA_POP));
near('rejected ballots ride along with the votes', u(0).rejected, 4 * 0.75 + 8 * (300 / AAA_POP));

let totalOut = 0;
for (const unit of spread.values.values()) totalOut += unit.total + unit.rejected;
near('every ballot in the file lands on an area', totalOut, read.ballots, 1e-6);
eq('no district is left without somewhere to put its ballots', spread.report.districtsMissing, []);
near('BBB keeps all of its own ballots', u(4).total + u(4).rejected, 100);
ok('a district with areas but no results has no unit at all', spread.values.get(5) === undefined);

console.log('\n== Where each area\'s ballots came from ==');
near('cell 0 from its own place', u(0).fromPlaces, 404 * 0.75);
near('cell 0 from the district spread', u(0).fromDistrict, SPREAD_BALLOTS * (300 / AAA_POP));
near('cell 1 from the district spread', u(1).fromDistrict, SPREAD_BALLOTS * (100 / AAA_POP));
eq('the readout can name the place an area was assigned to', u(0).place.name, 'North Hall');
eq('the two routes are counted for the status line',
   [Math.round(spread.report.ballotsFromPlaces), Math.round(spread.report.ballotsSpread)],
   [404 + 400 + 100, SPREAD_BALLOTS]);
eq('places, unlocated rows and catchments are counted',
   [spread.report.places, spread.report.unlocatedRows, spread.report.catchments], [4, 2, 3]);
eq('areas per catchment', spread.report.areasPerCatchment, { min: 1, median: 2, max: 2 });
ok('a file with no electors column says so', spread.report.electorsColumn === false);
ok('the median distance to a place is a plausible city figure',
   spread.report.medianDistanceM > 100 && spread.report.medianDistanceM < 8000,
   String(spread.report.medianDistanceM));

console.log('\n== Weighting by area when no census is loaded ==');
const flat = Places.spreadToAreas(features, read, assigned, { weightOf: () => 1 });
near('North Hall then splits evenly instead of three to one',
     flat.values.get(0).parties.get('BC NDP'), 300 * 0.5 + SPREAD_NDP * 0.25);
let flatTotal = 0;
for (const unit of flat.values.values()) flatTotal += unit.total + unit.rejected;
near('and nothing is lost either way', flatTotal, read.ballots, 1e-6);
const zeroed = Places.spreadToAreas(features, read, assigned, { weightOf: () => 0 });
let zeroTotal = 0;
for (const unit of zeroed.values.values()) zeroTotal += unit.total + unit.rejected;
near('areas that all weigh nothing split evenly rather than vanish', zeroTotal, read.ballots, 1e-6);

console.log('\n== The catchment basis ==');
const byCatchment = Places.spreadToAreas(features, read, assigned,
  { weightOf: (i) => pop[i], catchmentBasis: 'catchment' });
ok('a busier catchment takes more of the place-less ballots',
   byCatchment.values.get(0).fromDistrict > u(0).fromDistrict,
   `${byCatchment.values.get(0).fromDistrict} vs ${u(0).fromDistrict}`);
let byCatchmentTotal = 0;
for (const unit of byCatchment.values.values()) byCatchmentTotal += unit.total + unit.rejected;
near('the catchment basis conserves every ballot too', byCatchmentTotal, read.ballots, 1e-6);
eq('and the basis is recorded', byCatchment.report.basis, 'catchment');

console.log('\n== Effective n ==');
eq('five areas fed by three catchments carry three observations',
   Places.sourceUnits([0, 1, 2, 3, 4], assigned), 3);
eq('an area that only ever took a district spread counts once per district',
   Places.sourceUnits([5], assigned), 1);

console.log('\n== It drops into the turnout machinery unchanged ==');
/* No electors column, so the provincial rate must come back null rather than
   zero or Infinity, and the combined figure must fall back to the federal
   side alone and say it is partial. */
const fedUnit = { total: 100, rejected: 0, electors: 200, parties: new Map([['A', 100]]) };
const handRows = [{ key: '0', label: 'area 0', electors: 200, by: { fed: fedUnit, prov: u(0) } }];
Turnout.score(handRows, { weights: { fed: 0.5, prov: 0.5 } });
near('the federal side still has a turnout', handRows[0].t.fed, 0.5);
ok('the provincial side has none', handRows[0].t.prov === null, JSON.stringify(handRows[0].t));
near('so the combined figure is the federal one', handRows[0].agg, 0.5);
ok('and the row is flagged partial', handRows[0].partial === true);
const provTotal = u(0).total;
near('party share still works on a spread unit',
     Analysis.shareOf(u(0), 'BC NDP'), u(0).parties.get('BC NDP') / provTotal);
ok('the unit carries the fields the rest of the atlas reads',
   ['total', 'parties', 'electors', 'rejected', 'district', 'poll', 'flags'].every((k) => k in u(0)),
   Object.keys(u(0)).join(','));

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll voting-place tests passed.\n');
process.exit(fails ? 1 : 0);
