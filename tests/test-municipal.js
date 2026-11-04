/* Vancouver's municipal election: two files joined by an integer, a race sheet
   with a title above its header and blank columns between its candidates, and
   the smoothing that a vote-anywhere election needs before its ballots can be
   put on a map at all.

   The fixtures here are synthetic but shaped exactly like the city's files,
   including the parts that caused trouble: the Total row at the bottom, the
   merged-cell gaps, the thousands separators, and two places sharing a
   facility name. */
const { load } = require('./harness');
const { Municipal: M, Places: P, Ingest, Geo } = load(
  ['a-geo.js', 'b-text.js', 'c-binary.js', 'd-ingest.js', 'e-analysis.js',
   'f-results.js', 'f2-turnout.js', 'f3-census.js', 'f4-places.js', 'f5-summary.js',
   'f6-points.js', 'f7-municipal.js'],
  ['Municipal', 'Places', 'Ingest', 'Geo']);

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

/* The open-data portal's dataset page exports its own index under a filename
   that reads exactly like results -- municipal-election-results.csv -- so it is
   the likeliest wrong file to arrive. It carries the address of the right one,
   which is worth saying instead of "no race sheet was found". */
console.log('\n== The portal index is not the results ==');
const catalogue = {
  header: ['Election', 'Link to CSV', 'Link to XLS', 'Link to Attributes'],
  rows: [
    ['2025 Municipal By-Election', 'https://example.invalid/2025.zip', 'https://example.invalid/2025.xls', 'https://example.invalid/a'],
    ['2022 Municipal Election', 'https://example.invalid/2022.zip', 'https://example.invalid/2022.xls', 'https://example.invalid/a'],
    ['2018 Municipal Election', 'https://example.invalid/2018.zip', 'https://example.invalid/2018.xls', 'https://example.invalid/a'],
  ],
};
const hit = M.catalogueLink(catalogue);
ok('the index is recognised as an index', hit != null);
eq('and the link it names is the one for the year asked for', hit && hit.url, 'https://example.invalid/2022.zip');
eq('and it can list what else is on offer', hit && hit.elections.length, 3);
eq('a year that is not there names no link rather than the wrong one',
   M.catalogueLink(catalogue, '1999').url, null);
ok('a race sheet is not mistaken for the index', M.catalogueLink(mayor) == null);
ok('nor is the voting-places file', M.catalogueLink(placeTable) == null);

/* 2026 changed four things about the same two files, any one of which stopped
   the 2022 reader: the id column is headed "Precinct", the places export
   writes its integer key as "10.0", the coordinates sit in a column called
   "geometry" that holds a "lat, lon" pair rather than GeoJSON, and Advance
   Only now marks a building that held nothing else -- so the advance place
   at a building that also voted on the day reads No. The fixtures copy those
   shapes from the real files, including the candidate header that breaks
   across a line before its party. */
console.log('\n== The 2026 files ==');
const places26Csv = [
  'voting_place_id;facility_name;facility_address;location;advance_only;supercentre;ice;accessbility;bike_rack_location;nearest_transit_within_5_min_walk;local_area;geometry',
  '10.0;Dunbar Community Centre;4747 Dunbar Street;Gymnasium;NO;YES;NO;accessible;near entrance;#007;Dunbar-Southlands;49.24380814, -123.1859217',
  '50.0;Mount Pleasant Community Centre;1 Kingsway;Gym;NO;YES;NO;accessible;near entrance;"#003, #008\nSkytrain: Main St";Mount Pleasant;49.2626, -123.1002',
  '210.0;Dunbar Community Centre;4747 Dunbar Street;Gymnasium;NO;YES;NO;accessible;near entrance;#007;Dunbar-Southlands;49.24380814, -123.1859217',
  '228.0;Fraser Lands Church;3185 SE Marine Drive;Hall;YES;YES;NO;accessible;near entrance;#100;Killarney;49.2089, -123.0420',
  '101.0;UBC - AMS Student Nest;6133 University Blvd;Atrium;NO;NO;NO;accessible;near entrance;#099;UBC Lands & UEL;49.2667, -123.2499',
  '301.0;UBC - AMS Student Nest;6133 University Blvd;Atrium;NO;NO;NO;accessible;near entrance;#099;UBC Lands & UEL;49.2667, -123.2499',
  '7.0;Morris J. Wosk Centre for Dialogue;580 W Hastings Street;Concourse;NO;YES;NO;accessible;on Seymour;#003;Downtown;49.28428113, -123.1130153',
  '207.0;Morris J. Wosk Centre for Dialogue;580 West Hastings Street;Concourse;NO;YES;NO;accessible;on Seymour;#003;Downtown;49.28428113, -123.1130153',
  '12.0;Lord Kitchener Elementary School;3455 West King Edward Avenue;Gym;NO;YES;NO;accessible;front;#025;Dunbar-Southlands;49.2484, -123.1795',
  '312.0;Lord Kitchener Elementary School;3455 West King Edward Avenue;Gym;NO;YES;NO;accessible;front;#025;Kitsilano;49.2700, -123.1600',
].join('\n');
const vp26 = M.readVotingPlaces(await Ingest.loadTable('voting-places-2026.csv', Buffer.from(places26Csv)));
eq('every 2026 place is read', vp26.count, 10);
eq('and every one is located from the geometry column', vp26.unlocated, 0);
ok('"10.0" is keyed as 10, the way the race sheet writes it', vp26.byId.has('10') && !vp26.byId.has('10.0'));
near('the pair in "geometry" is read latitude first', vp26.byId.get('10').lat, 49.2438, 1e-3);
near('and longitude second', vp26.byId.get('10').lon, -123.1859, 1e-3);
ok('the day-of place is not advance', vp26.byId.get('10').advanceOnly === false);
ok('the second row for the same building is its advance place', vp26.byId.get('210').advanceOnly === true);
ok('a building marked Advance Only stays advance', vp26.byId.get('228').advanceOnly === true);
ok('the advance place at the Nest is advance, and outside the city',
   vp26.byId.get('301').advanceOnly === true && vp26.byId.get('301').outsideCity === true);
ok('one building spelled two ways is still one building', vp26.byId.get('207').advanceOnly === true);
ok('but a shared name 2.5 km away is a different building', vp26.byId.get('312').advanceOnly === false);
eq('three were inferred, not read, and the count says so', vp26.inferredAdvance, 3);

const mayor26Csv = [
  '2026 MAYOR Results by Location (Vote for  1)   ,,,,,,,,,,,,',
  'Precinct,Times Cast,Undervotes,,Overvotes,"50 HARDWICK, Colleen\n(TEAM) ",,"51 FRY, Pete\n(GREEN) ",,"55 CALIMAN, Amauri\n ",,Total Votes',
  'City,,,,,,,,,,,',
  'City of Vancouver,,,,,,,,,,,',
  '10 - Dunbar Community Centre,"1,200",10,,0,100,,"1,000",,90,,"1,190"',
  '50 - Mount Pleasant Community Centre,900,5,,1,50,,800,,44,,894',
  '210 - Dunbar Community Centre,"2,000",20,,0,300,,"1,600",,80,,"1,980"',
  '400 - Mail Results,500,5,,0,100,,390,,5,,495',
  '401 - SVO Results,50,0,,0,10,,38,,2,,50',
  'Total,"4,650",40,,1,560,,"3,828",,221,,"4,609"',
].join('\n');
const mayor26 = await Ingest.loadTable('2026MunicipalElectionsResult_ResultsMayor.csv', Buffer.from(mayor26Csv));
const race26 = M.detectRace(mayor26);
ok('a sheet headed "Precinct" is a race sheet', Boolean(race26));
eq('the party is read across the line break', race26.candidates.map((c) => c.party), ['TEAM', 'GREEN', 'CALIMAN']);
eq('and Total Votes is not a candidate', race26.candidates.length, 3);
const out26 = M.toPlacesTable(mayor26, vp26, { district: 'CoV' });
eq('three places matched', out26.report.matched, 3);
eq('mail and special voting are kept, unplaced',
   out26.report.unplaced.map((u) => u.id), ['400', '401']);
const read26 = P.readPlaces(out26.table, P.detectPlaceLayout(out26.table.header));
ok('the 2xx place goes in as advance', P.isFinalVoting(read26.places[2].opportunity) === false);
eq('no total disagrees with its parts', read26.warnings.length, 0);
eq('the year comes off the title', M.yearOf(race26.title), '2026');
eq('the blank heading rows are neither places nor summaries',
   out26.report.summaries.map((x) => x.label), ['Total']);
eq('races sort the way the ballot does',
   ['Q1', 'SchoolTrustee', 'Councillor', 'ParkCommissioner', 'Mayor']
     .sort((a, b) => M.raceRank(a) - M.raceRank(b)),
   ['Mayor', 'Councillor', 'ParkCommissioner', 'SchoolTrustee', 'Q1']);

console.log('\n== 2026 sheet names ==');
const n26 = (x) => `2026MunicipalElectionsResult_${x}.csv`;
ok('every 2026 race sheet is a race',
   ['ResultsMayor', 'ResultsCouncillor', 'ResultsParkCommissioner', 'ResultsSchoolTrustee',
    'ResultsQ1', 'ResultsQ2', 'ResultsQ3'].every((x) => M.isRaceSheet(n26(x))));
ok('and the totals and overview are not', !M.isRaceSheet(n26('Election2026Totals'))
   && !M.isRaceSheet(n26('Overview')));
eq('the race is named for what it is', ['ResultsParkCommissioner', 'ResultsQ1'].map((x) => M.raceLabel(n26(x))),
   ['ParkCommissioner', 'Q1']);
eq('2022 names still read the same way', M.raceLabel('2022MunicipalElectionResults - Mayor.csv'), 'Mayor');
eq('the question sheets carry no year, so the name supplies it',
   M.yearOf('1. CAPITAL BORROWING: PARKS (Vote for  1)', '2026MunicipalElectionResults.zip'), '2026');

console.log('\n== The 2026 overview ==');
const ov26 = M.readOverview(await Ingest.loadTable('Overview.csv', Buffer.from([
  'City of Vancouver: 2026 Municipal Election Official Results Overview,,,,,,',
  ' Registered Voters (CoV) ," 474,125 ", Registered voters on the voters\' list in the City of Vancouver  ,,,,',
  ' Registered Voters (UBC Lands and UEL) ," 9,199 ", School Trustee only ,,,,',
  ' Registered Voters - Total ," 483,324 ",,,,,',
  ',,,,,,',
  ' Ballots Cast (CoV) ," 208,514 ",,,,,',
  ' Ballots Cast Total ," 209,711 ",,,,,',
  ' Voter Turnout ,43.39%, Ballots Cast Total / Registered Voters Total ,,,,',
].join('\n'))));
eq('the padded figures are read', [ov26.electors, ov26.ballots], [474125, 208514]);
near('the city rate', ov26.turnout, 208514 / 474125);
near('and the published one, which counts UBC and the UEL', ov26.turnoutAsPublished, 209711 / 483324);

console.log('\n== The newest general election, when no year is asked for ==');
const cat26 = { header: catalogue.header, rows: [
  ['2026 Public Safety', 'https://example.invalid/ps.zip', '', ''],
  ['2018 Municipal Election', 'https://example.invalid/2018.zip', '', ''],
  ['2026 Municipal Election', 'https://example.invalid/2026.zip', '', ''],
  ['2025 Municipal By-Election', 'https://example.invalid/2025.zip', '', ''],
] };
eq('is 2026, not a plebiscite or a by-election', M.catalogueLink(cat26).url, 'https://example.invalid/2026.zip');

console.log('\n== Two elections compared ==');
const races22 = ['Mayor', 'Councillor', 'ParkBoard', 'SchoolTrustee', 'Q1', 'Q2'].map((name) => ({ name }));
eq('Mayor is matched to Mayor', M.matchRace('Mayor', races22).name, 'Mayor');
eq('the park race is matched across its two names', M.matchRace('ParkCommissioner', races22).name, 'ParkBoard');
eq('a question is never matched, because the questions change', M.matchRace('Q1', races22), null);
eq('a race the other year did not hold has no match', M.matchRace('Mayor', [{ name: 'Councillor' }]), null);
eq('only parties on the ballot both times, under the same name',
   M.swingParties([['Green', 1], ['ABC Vancouver', 1], ['TEAM', 1], ['Vancouver Liberals', 1]],
                  [['ABC Vancouver', 1], ['Forward With Kennedy Stewart', 1], ['TEAM', 1]]),
   ['ABC Vancouver', 'TEAM']);
eq('and never Yes or No', M.swingParties([['Yes', 1], ['No', 1]], [['Yes', 1], ['No', 1]]), []);
const cityRead = { places: [{ total: 300, byParty: new Map([['ABC', 100]]) }],
                   unlocated: [{ total: 100, byParty: new Map([['ABC', 60]]) }] };
near('the city-wide share counts unplaced mail as well', M.cityShare(cityRead, 'ABC'), 160 / 400);
const q22 = await Ingest.loadTable('Q1.csv', Buffer.from([
  '1. CAPITAL PLAN (Vote for  1),,,,,,,',
  'Voting Place ID # - Voting Place,Times Cast,Undervotes,Overvotes,Yes,,No,,Registered Voters',
  '1 - Dunbar Community Centre,100,0,0,60,,40,,"1,200"',
].join('\n')));
eq('a Registered Voters column is not an answer anyone voted for',
   M.detectRace(q22).candidates.map((c) => c.party), ['Yes', 'No']);


console.log('\n== Richmond: voting divisions in place of voting places ==');
/* Two square divisions side by side, 0.01 degrees each, and a results sheet
   in the shape tools/richmond/results.py writes: division codes, advance
   places and a mail row in the id column. */
const sq = (x0, y0, x1, y1) => ({ type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] });
const divs = M.readDivisions({ type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { id: 'RC01', name: 'Spul\u2019u\u2019kwuks Elementary School' }, geometry: sq(-123.18, 49.16, -123.17, 49.17) },
  { type: 'Feature', properties: { id: 'rc 02' }, geometry: sq(-123.17, 49.16, -123.16, 49.17) },
] });
eq('each division is read by its code', [...divs.byId.keys()], ['RC01', 'RC02']);
eq('and is marked as divisions', divs.kind, 'divisions');
ok('with a label point inside it', Geo.inGeometry(divs.byId.get('RC01').lon, divs.byId.get('RC01').lat,
   divs.byId.get('RC01').geometry));
let threw = null;
try { M.readDivisions({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { foo: 1 }, geometry: sq(0, 0, 1, 1) }] }); }
catch (e) { threw = e.message; }
ok('a GeoJSON with no division id says what it has', /needs an id/.test(threw || ''), threw);

const rmdSheet = await Ingest.loadTable('2026RichmondResults_Councillor.csv', Buffer.from([
  '2026 COUNCILLOR Results by Location (Vote for 8)',
  'Voting Place ID,Times Cast,"LAW, Gary (Advance Richmond)","DAY, Carol (RITE Richmond)","CRUZ, Mario (Mario Cruz)"',
  'RC01 - Spul\u2019u\u2019kwuks Elementary School,100,300,200,50',
  'RC02 - Quilchena Elementary School,80,100,250,20',
  'ADV 3 - Richmond City Hall - October 7 2026,60,150,120,10',
  'MBV - Mail & Mobile Voting,10,20,30,5',
].join('\n')));
const rb = M.toPlacesTable(rmdSheet, divs, { district: 'COR' });
eq('division rows join to their division', rb.report.matched, 2);
eq('advance and mail rows are kept, without a place', rb.report.unplaced.map((u) => u.id), ['ADV 3', 'MBV']);
eq('none of them is mistaken for a summary row', rb.report.summaries.length, 0);
const rRead = P.readPlaces(rb.table, P.detectPlaceLayout(rb.table.header));
eq('the advance row reads as advance voting', rRead.unlocated.map((u) => u.opportunity),
   ['Advance voting', 'Mail and mobile voting']);
eq('an independent is their own group', rRead.parties.map(([n]) => n).sort(),
   ['Advance Richmond', 'Mario Cruz', 'RITE Richmond']);

/* Three areas: one inside each division and one straddling the line. */
const areas = [
  { geometry: sq(-123.179, 49.161, -123.175, 49.165) },
  { geometry: sq(-123.169, 49.161, -123.161, 49.169) },
  { geometry: sq(-123.172, 49.161, -123.168, 49.165) },
];
const at = new Map([...divs.byId.values()].map((d) => [`${d.lon},${d.lat}`, d.geometry]));
const placed = P.smoothToAreas(areas, rRead, {
  divisionOf: (pl) => at.get(`${pl.lon},${pl.lat}`), weightOf: () => 1,
  pollOf: (f) => '', districtOf: () => 'COR',
});
const ballotsOn = (i) => placed.values.get(i) ? placed.values.get(i).fromPlaces : 0;
const placedTotal = rRead.places.reduce((a, pl) => a + pl.total + pl.rejected, 0);
near('every division\u2019s count is conserved', ballotsOn(0) + ballotsOn(1) + ballotsOn(2), placedTotal, 1e-6);
near('an area inside RC01 takes only RC01\u2019s', ballotsOn(0) / (ballotsOn(0) + ballotsOn(2) * 0.5), 1, 0.35);
const rc02 = rRead.places.find((pl) => /RC02/.test(pl.name));
ok('the area inside RC02 takes none of RC01', ballotsOn(1) <= rc02.total + rc02.rejected + 1e-6);
ok('the straddling area takes a share of both', placed.report.onePlace === 2, `onePlace ${placed.report.onePlace}`);
eq('and the report says it was by division', placed.report.basis, 'division');

console.log(fails ? `\n${fails} FAILED` : '\nAll municipal checks passed.');
process.exit(fails ? 1 : 0);
})();
