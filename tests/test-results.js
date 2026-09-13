const fs = require('fs');
const { load } = require('./harness');
const { Results: R, TextFormats: T, Geo } =
  load(['a-geo.js','b-text.js','f-results.js'], ['Results','TextFormats','Geo']);
let fails = 0;
const ok=(n,c,e='')=>{ if(c) console.log(`  PASS  ${n}`); else { console.log(`  FAIL  ${n} ${e}`); fails++; } };
const eq=(n,a,b)=>ok(n, JSON.stringify(a)===JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

const fed = JSON.parse(fs.readFileSync('boundaries/fed_polls.geojson','utf8')).features;
const van = fed.filter(f => f.properties.fed === '59035'); // Vancouver Centre
console.log(`\nUsing ${van.length} real polling divisions from riding 59035`);

// Build an Elections Canada shaped results file for those polls, plus advance
// polls (600 series) that have no boundary at all -- the real situation.
const EC_HEADER = ['Electoral District Number/Numéro de circonscription',
  'Electoral District Name_English/Nom de circonscription_Anglais',
  'Polling Station Number/Numéro du bureau de scrutin',
  'Polling Station Name/Nom du bureau de scrutin',
  'Rejected Ballots for Polling Station/Bulletins rejetés du bureau',
  'Electors for Polling Station/Électeurs du bureau',
  "Candidate's Family Name/Nom de famille du candidat",
  'Political Affiliation Name_English/Appartenance politique_Anglais',
  'Candidate Poll Votes Count/Votes du candidat pour le bureau'];
const PARTIES = ['Liberal','Conservative','NDP-New Democratic Party','Green Party'];
let rows = [], expectedOrdinary = 0, expectedAdvance = 0;
van.forEach((f, i) => {
  const pollNum = f.properties.poll.split('-')[0];
  PARTIES.forEach((party, k) => {
    const votes = 20 + ((i * 7 + k * 13) % 90);
    rows.push([f.properties.fed, 'Vancouver Centre', pollNum, `Station ${pollNum}`,
               '3', '520', 'Smith', party, String(votes)]);
    expectedOrdinary += votes;
  });
});
for (let adv = 600; adv < 610; adv++) {
  PARTIES.forEach((party, k) => {
    const votes = 300 + k * 40;
    rows.push(['59035','Vancouver Centre',String(adv),`Advance poll ${adv}`,'8','2200','Smith',party,String(votes)]);
    expectedAdvance += votes;
  });
}
const csv = [EC_HEADER, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\r\n');
const table = T.parseDelimited(csv);

console.log('\n== Column detection on an Elections Canada layout ==');
const mapping = R.detectLayout(table.header, table.rows);
eq('layout', mapping.layout, 'long');
eq('district column', table.header[mapping.district], EC_HEADER[0]);
eq('poll column', table.header[mapping.poll], EC_HEADER[2]);
eq('party column', table.header[mapping.party], EC_HEADER[7]);
eq('votes column', table.header[mapping.votes], EC_HEADER[8]);
eq('electors column', table.header[mapping.electors], EC_HEADER[5]);
eq('rejected column', table.header[mapping.rejected], EC_HEADER[4]);

console.log('\n== Join to the real boundary layer ==');
const joined = R.join(van, { district:'fed', poll:'poll', federalSuffixes:true }, table, mapping);
eq('every polling division matched', joined.report.matchedFeatures, van.length);
eq('no boundary left unmatched', joined.report.unmatchedFeatures.length, 0);
ok(`matched votes = ordinary votes only (${joined.report.matchedVotes} vs ${expectedOrdinary})`,
   joined.report.matchedVotes === expectedOrdinary);
ok(`advance polls reported as unmatched rows (${joined.report.unmatchedRowCount} units, ${joined.report.unmatchedVotes} votes)`,
   joined.report.unmatchedRowCount === 10 && joined.report.unmatchedVotes === expectedAdvance);
const pct = 100 * joined.report.matchedVotes / joined.report.tableVotes;
console.log(`  geographic coverage: ${pct.toFixed(1)}% of votes in this file sit in a mapped polling division`);
ok('coverage is below 100% because advance polls have no boundary', pct < 100 && pct > 50);
eq('parties ranked by votes', joined.parties.map(p=>p[0]).sort(), PARTIES.slice().sort());
const unit = joined.values.get(0);
ok('electors taken as max, not summed', unit.electors === 520, `got ${unit.electors}`);
ok('rejected ballots taken as max', unit.rejected === 3, `got ${unit.rejected}`);
ok('per-poll total is the sum across parties', unit.total === [...unit.parties.values()].reduce((a,b)=>a+b,0));

console.log('\n== Leading-zero and case differences are handled ==');
const padded = table.rows.map(r => { const c=r.slice(); c[2]='00'+c[2]; return c; });
const j2 = R.join(van, { district:'fed', poll:'poll', federalSuffixes:true },
                  { header: table.header, rows: padded }, mapping);
eq('zero-padded poll numbers still match', j2.report.matchedFeatures, van.length);
ok('and the report says zeros were ignored', j2.report.ignoredLeadingZeros === true);

console.log('\n== A genuinely wrong join is reported, not hidden ==');
const wrong = table.rows.map(r => { const c=r.slice(); c[2]='X'+c[2]; return c; });
const j3 = R.join(van, { district:'fed', poll:'poll', federalSuffixes:true },
                  { header: table.header, rows: wrong }, mapping);
eq('nothing matches', j3.report.matchedFeatures, 0);
ok('and every boundary is listed as unmatched', j3.report.unmatchedFeatures.length === van.length);

console.log('\n== Wide format (one column per party) ==');
const wideHeader = ['District','Voting Area','Registered Voters','BC NDP','BC Conservative','BC Green','Total Rejected'];
const wideRows = [
  ['Vancouver-Fairview','015','1200','540','410','150','6'],
  ['Vancouver-Fairview','016','1100','600','300','120','4'],
];
const wm = R.detectLayout(wideHeader, wideRows);
eq('wide layout detected', wm.layout, 'wide');
eq('party columns found', wm.partyColumns.map(i=>wideHeader[i]), ['BC NDP','BC Conservative','BC Green']);
eq('elector column excluded from parties', wm.partyColumns.includes(2), false);
const provFeatures = [
  { type:'Feature', properties:{ ED_NAME:'Vancouver-Fairview', VA_CODE:'015' }, geometry:null },
  { type:'Feature', properties:{ ED_NAME:'Vancouver-Fairview', VA_CODE:'016' }, geometry:null },
];
const jw = R.join(provFeatures, { district:'ED_NAME', poll:'VA_CODE' },
                  { header: wideHeader, rows: wideRows }, wm);
eq('wide join matched both areas', jw.report.matchedFeatures, 2);
eq('votes summed across party columns', jw.values.get(0).total, 1100);
eq('party votes read correctly', jw.values.get(1).parties.get('BC NDP'), 600);

console.log('\n== Full 18-column Elections Canada header ==');
const EC18 = ['Electoral District Number/Numéro de circonscription', 'Electoral District Name_English/Nom de circonscription_Anglais',
  'Electoral District Name_French/Nom de circonscription_Français', 'Polling Station Number/Numéro du bureau de scrutin',
  'Polling Station Name/Nom du bureau de scrutin', 'Void Poll Indicator/Indicateur de bureau supprimé',
  'No Poll Held Indicator/Indicateur de bureau sans scrutin', 'Merge With/Fusionné avec',
  'Rejected Ballots for Polling Station/Bulletins rejetés du bureau', 'Electors for Polling Station/Électeurs du bureau',
  "Candidate's Family Name/Nom de famille du candidat", "Candidate's Middle Name/Second prénom du candidat",
  "Candidate's First Name/Prénom du candidat", 'Political Affiliation Name_English/Appartenance politique_Anglais',
  'Political Affiliation Name_French/Appartenance politique_Français', 'Candidate Poll Votes Count/Votes du candidat pour le bureau',
  'Incumbent Indicator/Indicateur_Candidat sortant', 'Elected Candidate Indicator/Indicateur_Candidat élu'];
const m18 = R.detectLayout(EC18, [EC18.map(() => '1')]);
eq('18-column layout', [m18.layout, m18.district, m18.poll, m18.party, m18.votes, m18.electors, m18.rejected, m18.mergeWith, m18.voidPoll, m18.noPoll],
   ['long', 0, 3, 13, 15, 9, 8, 7, 5, 6]);

console.log('\n== Key property suggestion ==');
const s = R.suggestKeyProperties(provFeatures);
eq('district property suggested', s.district, 'ED_NAME');
eq('voting area property suggested', s.poll, 'VA_CODE');
// Elections BC's own column names (WHSE_ADMIN_BOUNDARIES.EBC_VOTING_AREAS_BS11_POLY_SVW).
const ebc = ['VHA001', 'VHA002', 'VKE001', 'VKE002'].map((c, i) => ({ properties: {
  VOTING_AREA_POLY_ID: 24453 + i, BOUNDARY_SET_ID: 11, ED_ABBREVIATION: c.slice(0, 3), VA_CODE: c.slice(3),
  EDVA_CODE: c, VA_TYPE: 'Areal', DATA_ACCESS_LEVEL: 'Public', GAZETTE_DATE: '20240919',
  FEATURE_AREA_SQM: 1000 * i, FEATURE_LENGTH_M: 100 * i, OBJECTID: 169136 + i, SE_ANNO_CAD_DATA: null,
  'SHAPE.AREA': 0, 'SHAPE.LEN': 0 } }));
const se = R.suggestKeyProperties(ebc);
eq('Elections BC district column ED_ABBREVIATION suggested', se.district, 'ED_ABBREVIATION');
eq('Elections BC voting area column VA_CODE suggested', se.poll, 'VA_CODE');

console.log('\n== Federal poll suffix variants ==');
eq('plain poll', R.federalPollVariants('12-0').sort(), ['12','12-0'].sort());
ok('suffix 1 offers the A spelling', R.federalPollVariants('164-1').includes('164A'));

console.log('\n== Split polls, and a riding that leaves the study area ==');
/* The real shapes from Elections Canada's 2025 poll-by-poll files: a busy
   division split into 10A and 10B on the day while the boundary still draws
   one polygon for 10-0; advance polls in the 600 series with no polygon by
   design; and an ordinary poll that has no polygon because it sits outside the
   study area, which is a different thing and must not be spread as if it were
   an advance poll. */
const SP_HEADER = ['Electoral District Number/Numéro de circonscription',
  'Polling Division Number/Numéro de section de vote',
  'Combined with No./Résultats combinés à ceux du n°',
  'Rejected Ballots for poll/Bulletins rejetés du bureau',
  'Electors for poll/Électeurs du bureau',
  'Political Affiliation Name_English/Appartenance politique_Anglais',
  'Candidate Vote Count/Votes du candidat'];
const sp = [];
const addSp = (poll, electors, rejected, red, blue) => {
  sp.push(['59035', poll, '', String(rejected), String(electors), 'Red', String(red)]);
  sp.push(['59035', poll, '', String(rejected), String(electors), 'Blue', String(blue)]);
};
addSp('1', 400, 1, 60, 40);          // an ordinary poll, matches 1-0
addSp('2A', 250, 1, 30, 20);         // poll 2 split on the day; boundary says 2-0
addSp('2B', 260, 0, 25, 35);
addSp('600', 0, 3, 300, 200);        // advance: no polygon by design
addSp('490', 500, 2, 70, 30);        // ordinary number, no polygon: outside the study area
const spMapping = R.detectLayout(SP_HEADER, sp);
ok('the 2025 spelling of the merge column is detected',
   spMapping.mergeWith >= 0 && /Combined with/.test(SP_HEADER[spMapping.mergeWith]),
   String(spMapping.mergeWith));

const twoPolls = van.filter((f) => ['1-0', '2-0'].includes(f.properties.poll));
ok(`the fixture riding has both polygons (${twoPolls.length})`, twoPolls.length === 2);
const spJoin = R.join(twoPolls, { district: 'fed', poll: 'poll', federalSuffixes: true },
  { header: SP_HEADER, rows: sp }, spMapping, null);

ok(`both halves of poll 2 pooled into its polygon (${spJoin.report.splitPolls} parent synthesised)`,
   spJoin.report.splitPolls === 1);
const byPoll = new Map([...spJoin.values.values()].map((u) => [u.poll, u]));
eq('poll 2 carries the sum of its halves',
   [byPoll.get('2').total, byPoll.get('2').electors, byPoll.get('2').rejected], [110, 510, 1]);
eq('and both parties are summed, not one of them',
   [byPoll.get('2').parties.get('Red'), byPoll.get('2').parties.get('Blue')], [55, 55]);
ok('the halves stop being units of their own, so nothing is counted twice',
   ![...spJoin.values.values()].some((u) => /[AB]$/.test(u.poll)),
   [...spJoin.values.values()].map((u) => u.poll).join(','));
ok('every polygon found a result', spJoin.report.matchedFeatures === 2);

const adv = spJoin.report.unmatchedByAdvancePoll.get('59035|600');
const np = spJoin.report.noPolygonByDistrict.get('59035');
eq('the advance poll is kept by itself, for the divisions that fed it',
   [adv.units, adv.total, adv.district, adv.advPoll], [1, 500, '59035', '600']);
ok('so it is not left in the district-wide pool',
   !spJoin.report.unmatchedByDistrict.has('59035'),
   JSON.stringify([...spJoin.report.unmatchedByDistrict.keys()]));
eq('the ordinary poll with no polygon is kept apart from it', [np.units, np.total, np.electors], [1, 100, 500]);
ok('and is reported as such', spJoin.report.noPolygonUnits === 1 && spJoin.report.noPolygonVotes === 102,
   `${spJoin.report.noPolygonUnits} / ${spJoin.report.noPolygonVotes}`);
const share = spJoin.report.inAreaShare.get('59035');
/* 400 + 510 electors inside, 500 outside. */
ok(`the in-area share of the district's electorate is measured (${share.toFixed(3)})`,
   Math.abs(share - 910 / 1410) < 1e-9, String(share));

const already = sp.concat([['59035', '2', '', '0', '999', 'Red', '7'], ['59035', '2', '', '0', '999', 'Blue', '3']]);
const joinAlready = R.join(twoPolls, { district: 'fed', poll: 'poll', federalSuffixes: true },
  { header: SP_HEADER, rows: already }, spMapping, null);
ok('a file that already reports the parent is left alone, never doubled',
   joinAlready.report.splitPolls === 0
   && [...joinAlready.values.values()].find((u) => u.poll === '2').total === 10);

const other = R.join(twoPolls, { district: 'fed', poll: 'poll' },
  { header: SP_HEADER, rows: sp }, spMapping, null);
ok('a file that is not Elections Canada numbering is untouched by any of this',
   other.report.splitPolls === 0 && other.report.noPolygonUnits === 0
   && other.report.unmatchedByAdvancePoll.size === 0
   && other.report.unmatchedByDistrict.has('59035'));

/* Special ballots and mail carry no poll number at all, so they stay the
   district's to spread however good the advance-poll data is. */
const withSpecial = sp.concat([['59035', 'S/R 1', '', '0', '0', 'Red', '40'],
                               ['59035', 'S/R 1', '', '0', '0', 'Blue', '60']]);
const specialJoin = R.join(twoPolls, { district: 'fed', poll: 'poll', federalSuffixes: true },
  { header: SP_HEADER, rows: withSpecial }, spMapping, null);
eq('special ballots stay riding-wide, beside the advance polls that do not',
   [specialJoin.report.unmatchedByDistrict.get('59035').total,
    specialJoin.report.unmatchedByAdvancePoll.size], [100, 1]);

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll results tests passed.\n');
process.exit(fails?1:0);
