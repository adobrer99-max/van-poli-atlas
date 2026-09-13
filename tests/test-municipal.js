/* Vancouver's municipal election: two files joined by an integer, a race sheet
   with a title above its header and blank columns between its candidates, and
   the smoothing that a vote-anywhere election needs before its ballots can be
   put on a map at all.

   The fixtures here are synthetic but shaped exactly like the city's files,
   including the parts that caused trouble: the Total row at the bottom, the
   merged-cell gaps, the thousands separators, and two places sharing a
   facility name. */
const { load } = require('./harness');
const { Municipal: M, Places: P, Ingest } = load(
  ['a-geo.js', 'b-text.js', 'c-binary.js', 'd-ingest.js', 'e-analysis.js',
   'f-results.js', 'f2-turnout.js', 'f3-census.js', 'f4-places.js', 'f5-summary.js',
   'f6-points.js', 'f7-municipal.js'],
  ['Municipal', 'Places', 'Ingest']);

let fails = 0;
const ok = (n, c, e = '') => { if (c) console.log(`  PASS  ${n}`); else { console.log(`  FAIL  ${n} ${e}`); fails++; } };
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const near = (n, a, b, tol = 1e-6) => ok(n, Math.abs(a - b) <= tol, `got ${a} want ${b}`);

console.log('\n== A candidate column, and the party in its brackets ==');
eq('the bracket is the party', M.candidateParty('51 STEWART, Kennedy (Forward with Kennedy Stewart)'),
   'Forward with Kennedy Stewart');
eq('two candidates of one party give one name', M.candidateParty('7 SIM, Ken (ABC Vancouver)'), 'ABC Vancouver');
eq('a candidate with no bracket is their own party', M.candidateParty('50 SHOTTHA, Satwant'), 'SHOTTHA');
eq('the ballot number in front is not part of the name', M.candidateParty('3 LY, Mark'), 'LY');
eq('a blank column names nobody', M.candidateParty('   '), null);
/* A name with a bracket inside it, which is not the party. Only a bracket at
   the very end is the affiliation. */
eq('only a trailing bracket counts', M.candidateParty('9 SMITH (Bob), Jane (TEAM)'), 'TEAM');

console.log('\n== The voting places file ==');
/* Two rows share a facility name -- the city has 21 such pairs, because one
   building hosts both an advance place and a final-day one. */
const placesCsv = [
  'Voting Place ID;Facility Name;Facility Address;Advance Only;Supercentre;Local Area;geo_point_2d',
  '1;Dunbar Community Centre;4747 Dunbar Street;No;Yes;Dunbar-Southlands;"49.2452, -123.1855"',
  '2;Dunbar Community Centre;4747 Dunbar Street;Yes;No;Dunbar-Southlands;"49.2452, -123.1855"',
  '3;Mount Pleasant Community Centre;1 Kingsway;No;Yes;Mount Pleasant;"49.2626, -123.1002"',
  '4;Britannia Community Services Centre;1661 Napier Street;No;No;Grandview-Woodland;"49.2757, -123.0710"',
  '401;University Hill Secondary School;3228 Ross Drive;No;No;UBC Lands & UEL;"49.2497, -123.2400"',
].join('\n');

(async () => {
const placeTable = await Ingest.loadTable('voting-places.csv', Buffer.from(placesCsv));
const vp = M.readVotingPlaces(placeTable);
eq('every place is read', vp.count, 5);
eq('none is left without a coordinate', vp.unlocated, 0);
eq('the id is the key, so a shared facility name keeps both', vp.sharedNames, 1);
ok('an advance-only place is flagged', vp.byId.get('2').advanceOnly === true);
ok('and is not also a supercentre', vp.byId.get('2').supercentre === false);
ok('a supercentre is flagged', vp.byId.get('1').supercentre === true);
/* geo_point_2d is latitude first. Reading it the other way round puts Dunbar
   in the Indian Ocean, so the order is asserted rather than assumed. */
near('the pair is read latitude first', vp.byId.get('1').lat, 49.2452, 1e-4);
near('and longitude second', vp.byId.get('1').lon, -123.1855, 1e-4);
ok('UBC and the UEL are marked as outside the city',
   vp.byId.get('401').outsideCity === true && vp.byId.get('1').outsideCity === false);

console.log('\n== A race sheet: a title above the header, gaps between candidates ==');
/* Column 3 and 5 are the merged-cell blanks the spreadsheet export leaves
   behind. The Total row at the bottom is the whole election again, and adding
   it to the places would double it. */
const mayorCsv = [
  '2022 MAYOR Results by Location (Vote for  1)   ,,,,,,,',
  'Voting Place ID # - Voting Place,Times Cast,Undervotes,Overvotes,"7 SIM, Ken (ABC Vancouver)",,"51 STEWART, Kennedy (Forward with Kennedy Stewart)",,"50 SHOTTHA, Satwant"',
  '1 - Dunbar Community Centre,"1,000",5,0,600,,300,,95',
  '2 - Dunbar Community Centre,500,0,0,300,,150,,50',
  '3 - Mount Pleasant Community Centre,800,0,0,200,,550,,50',
  '4 - Britannia Community Services Centre,700,0,0,150,,500,,50',
  '307 - Mail Results,100,0,0,40,,55,,5',
  'Total,"3,100",5,0,"1,290",,"1,555",,250',
  ',,,,,,,',
].join('\n');
const mayor = await Ingest.loadTable('Mayor.csv', Buffer.from(mayorCsv));
const race = M.detectRace(mayor);
ok('the header is found below the title', race.headerRow === 1);
eq('the seat count is read from the title, not guessed', race.seats, 1);
eq('three candidates, and neither blank column nor undervotes among them',
   race.candidates.map((c) => c.party), ['ABC Vancouver', 'Forward with Kennedy Stewart', 'SHOTTHA']);

const out = M.toPlacesTable(mayor, vp, { district: 'CoV' });
eq('the Total row is held out as a summary rather than added as a place',
   out.report.summaries, [{ label: 'Total', ballots: 3100 }]);
eq('and it is named, so a file that grows a second one shows up here',
   out.report.summaries.length, 1);
eq('four places matched', out.report.matched, 4);
eq('mail has no place and is kept as unplaced rather than dropped',
   out.report.unplaced, [{ id: '307', name: 'Mail Results', ballots: 100 }]);
near('ballots on a place', out.report.ballotsMatched, 3000);
eq('a one-seat race carries rejected ballots', out.table.rows[0][out.table.header.indexOf('rejected_ballots')], '5');

console.log('\n== The table is exactly what the voting-place reader already takes ==');
const layout = P.detectPlaceLayout(out.table.header);
ok('the layout is accepted unchanged', Boolean(layout));
eq('three parties', layout.parties.length, 3);
eq('and ABC is not title-cased into a typo', layout.parties[0].name, 'ABC Vancouver');
const read = P.readPlaces(out.table, layout);
eq('every row is read', read.rowsRead, 5);
eq('four carry a coordinate', read.places.length, 4);
eq('mail does not, and is held back for a district-wide spread', read.unlocated.length, 1);
near('ballots are the ballots cast, not the votes', read.ballots, 3100);
eq('no total disagrees with its parts', read.warnings.length, 0);
ok('the advance place is not given a catchment', P.isFinalVoting(read.places[1].opportunity) === false);
ok('and the final-day one is', P.isFinalVoting(read.places[0].opportunity) === true);

console.log('\n== A ten-seat race, where a ballot is not a vote ==');
const councilCsv = [
  '2022 Election COUNCILLOR Results by Location (Vote for  10)   ,,,,,',
  'Voting Place ID # - Voting Place,Times Cast,Undervotes,Overvotes,"1 A, A (ABC Vancouver)",,"2 B, B (TEAM)"',
  '1 - Dunbar Community Centre,"1,000",0,0,"6,000",,"3,000"',
  'Total,"1,000",0,0,"6,000",,"3,000"',
].join('\n');
const council = await Ingest.loadTable('Councillor.csv', Buffer.from(councilCsv));
const cOut = M.toPlacesTable(council, vp, { district: 'CoV' });
eq('the seat count comes off the title row', cOut.report.seats, 10);
eq('9,000 votes on 1,000 ballots are not 8,000 rejected ballots',
   cOut.table.rows[0][cOut.table.header.indexOf('rejected_ballots')], '0');
const cRead = P.readPlaces(cOut.table, P.detectPlaceLayout(cOut.table.header));
near('ballots stay ballots', cRead.places[0].declaredTotal, 1000);
near('while the votes stay votes', cRead.places[0].total, 9000);

console.log('\n== The city-wide rate, which is published rather than modelled ==');
const overviewCsv = [
  'City of Vancouver: 2022 Municipal Election Official Results Overview,,',
  ' Registered Voters (CoV) ,464126, Registered voters on the voters’ list ',
  ' Registered Voters (UBC Lands and UEL) ,8539, School Trustee only ',
  ' Registered Voters - Total ,472665,',
  ' Ballots Cast (CoV) ,170274,',
  ' Ballots Cast Total ,171494,',
  ' Voter Turnout ,36.28%, Ballots Cast Total / Registered Voters Total ',
].join('\n');
const ov = M.readOverview(await Ingest.loadTable('Overview.csv', Buffer.from(overviewCsv)));
eq('the city electorate', ov.electors, 464126);
eq('the city ballots', ov.ballots, 170274);
near('the city rate', ov.turnout, 170274 / 464126, 1e-9);
near('and the rate as the city publishes it, over a wider denominator',
     ov.turnoutAsPublished, 171494 / 472665, 1e-9);
ok('the two differ, which is why both are kept', Math.abs(ov.turnout - ov.turnoutAsPublished) > 0.002);

console.log('\n== Smoothing, because you may vote at any place in the city ==');
/* Four areas in a row, 1 km apart, equal electorates, and one voting place
   sitting on the first of them. Under a nearest-place rule the first area
   takes all 2,000 ballots against its 500 electors. */
const cell = (i) => ({ type: 'Polygon', coordinates: [[[i * 0.0138, 49.24], [i * 0.0138 + 0.0138, 49.24],
  [i * 0.0138 + 0.0138, 49.25], [i * 0.0138, 49.25], [i * 0.0138, 49.24]]] });
const feats = [0, 1, 2, 3].map((i) => ({ type: 'Feature', properties: { code: `A${i}` }, geometry: cell(i) }));
const one = {
  rowsRead: 1, ballots: 2000, warnings: [], unlocated: [],
  places: [{ ed: 'CoV', district: 'CoV', opportunity: 'Final voting', name: 'Hall',
             lon: 0.0069, lat: 49.245, total: 1800, rejected: 0, electors: 0,
             declaredTotal: 2000, byParty: new Map([['ABC', 1200], ['TEAM', 600]]), final: true }],
};
const opts = { pollOf: (f) => f.properties.code, districtOf: () => 'CoV', weightOf: () => 500 };
const smooth = M2Smooth(P, feats, one, opts);
function M2Smooth(P, feats, read, o) { return P.smoothToAreas(feats, read, o); }
const got = [...smooth.values.values()].reduce((a, u) => a + u.ballots, 0);
near('every ballot still lands somewhere', got, 2000, 1e-6);
ok('and it reaches all four areas, not only the one under the place',
   smooth.values.size === 4);
const b = [0, 1, 2, 3].map((i) => smooth.values.get(i).ballots);
ok('with the nearest area heaviest', b[0] > b[1] && b[1] > b[2] && b[2] > b[3], JSON.stringify(b));
ok('but not taking all of it', b[0] < 2000 * 0.9, `${b[0]}`);
const share = [0, 1, 2, 3].map((i) => {
  const u = smooth.values.get(i);
  return u.parties.get('ABC') / (u.parties.get('ABC') + u.parties.get('TEAM'));
});
ok('one place cannot produce a partisan gradient, and does not',
   share.every((v) => Math.abs(v - 2 / 3) < 1e-9), JSON.stringify(share));

console.log('\n== The cap is a ceiling, never a target ==');
/* Same geography, a place big enough to overflow its own area. The cap should
   pull the first area back to its electorate and push the rest outward, while
   still conserving every ballot. */
const big = { ...one, ballots: 4000,
  places: [{ ...one.places[0], total: 4000, declaredTotal: 4000 }] };
const capped = P.smoothToAreas(feats, big, { ...opts, capOf: () => 500, bandwidth: { finalM: 300 } });
const cb = [0, 1, 2, 3].map((i) => capped.values.get(i).ballots);
near('ballots are conserved even with a cap biting', cb.reduce((a, c) => a + c, 0), 4000, 1e-6);
ok('the cap bound at least one area', capped.report.capsBinding > 0);
const uncapped = P.smoothToAreas(feats, big, { ...opts, bandwidth: { finalM: 300 } });
ok('and it moved ballots outward rather than inventing them',
   capped.values.get(0).ballots < uncapped.values.get(0).ballots
   && capped.values.get(3).ballots > uncapped.values.get(3).ballots);
/* The reason there is a cap and not a target. Constraining every area to its
   electors times one city-wide rate returns that rate everywhere -- it does
   not estimate turnout, it asserts it. Here the cap is set at exactly the
   even share, which is what a target would do, and the result is flat. */
const forced = P.smoothToAreas(feats, big, { ...opts, capOf: () => 1000, bandwidth: { finalM: 300 }, rounds: 200 });
const fb = [0, 1, 2, 3].map((i) => forced.values.get(i).ballots);
ok('a cap tight enough to bind everywhere flattens the map completely',
   Math.max(...fb) - Math.min(...fb) < 1, JSON.stringify(fb));

console.log('\n== How many places an area’s figure actually rests on ==');
ok('an area drawing on one place counts as one',
   Math.abs(smooth.report.placesPerArea.max - 1) < 1e-9, `${smooth.report.placesPerArea.max}`);
const two = { ...one, places: [one.places[0],
  { ...one.places[0], name: 'Other', lon: 0.0069 + 0.0414, total: 1800, declaredTotal: 2000 }] };
const pair = P.smoothToAreas(feats, two, { ...opts, bandwidth: { finalM: 4000 } });
ok('an area drawing evenly on two counts as about two',
   pair.report.placesPerArea.max > 1.8 && pair.report.placesPerArea.max <= 2.0001,
   `${pair.report.placesPerArea.max}`);

console.log('\n== Which sheet in the zip is a race ==');
ok('the races are races', ['Mayor', 'Councillor', 'ParkBoard', 'SchoolTrustee', 'Q1']
  .every((n) => M.isRaceSheet(`2022MunicipalElectionResults - ${n}.csv`)));
ok('and the summaries are not', ['Overview', 'Totals']
  .every((n) => !M.isRaceSheet(`2022MunicipalElectionResults - ${n}.csv`)));
ok('the overview is found by name', M.isOverviewSheet('2022MunicipalElectionResults - Overview.csv'));

console.log('\n== A file that is not a results sheet says so ==');
let msg = '';
try { M.toPlacesTable({ header: ['a', 'b'], rows: [['1', '2']] }, vp); } catch (e) { msg = e.message; }
ok('and names what to load instead', /voting place id/i.test(msg) && /Mayor/.test(msg), msg);

console.log(fails ? `\n${fails} FAILED` : '\nAll municipal checks passed.');
process.exit(fails ? 1 : 0);
})();
