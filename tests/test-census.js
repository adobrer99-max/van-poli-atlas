const { load } = require('./harness');
const { Census, TextFormats: T, Analysis: An, Geo } =
  load(['a-geo.js', 'b-text.js', 'e-analysis.js', 'f3-census.js'], ['Census', 'TextFormats', 'Analysis', 'Geo']);
let fails = 0;
const ok = (n, c, e = '') => { if (c) console.log(`  PASS  ${n}`); else { console.log(`  FAIL  ${n} ${e}`); fails++; } };
const eq = (n, a, b) => ok(n, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const near = (n, a, b, tol = 1e-12) => ok(`${n} (${a} ~ ${b})`, a != null && Math.abs(a - b) <= tol);

/* A Census Profile as StatCan lays it out: one row per characteristic per
   geography, leading spaces for the hierarchy, a count and a rate column each
   followed by its own SYMBOL column, and suppression symbols. Three DAs. */
const HEADER = ['CENSUS_YEAR', 'DGUID', 'ALT_GEO_CODE', 'GEO_LEVEL', 'GEO_NAME', 'TNR_SF', 'TNR_LF', 'DATA_QUALITY_FLAG',
  'CHARACTERISTIC_ID', 'CHARACTERISTIC_NAME', 'CHARACTERISTIC_NOTE', 'C1_COUNT_TOTAL', 'SYMBOL', 'C2_COUNT_MEN+', 'SYMBOL',
  'C3_COUNT_WOMEN+', 'SYMBOL', 'C10_RATE_TOTAL', 'SYMBOL', 'C11_RATE_MEN+', 'SYMBOL', 'C12_RATE_WOMEN+', 'SYMBOL'];
const CHARS = [
  [1, 'Population, 2021'],
  [6, 'Population density per square kilometre'],
  [8, 'Total - Age groups of the population - 100% data'],
  [9, '  0 to 14 years'],
  [10, '  15 to 64 years'],
  [11, '  65 years and over'],
  [39, 'Median age of the population'],
  [50, 'Total - Private households by household size - 100% data'],
  [51, '  1 person'],
  [52, '  2 persons'],
  [57, 'Average household size'],
  [115, 'Median total income of household in 2020 ($)'],
  [345, 'Prevalence of low income based on the Low-income measure, after tax (LIM-AT) (%)'],
  [1416, 'Total - Private households by tenure - 25% sample data'],
  [1417, '  Owner'],
  [1418, '  Renter'],
  [1500, 'Total - Immigrant status and period of immigration for the population in private households - 25% sample data'],
  [1501, '  Non-immigrants'],
  [1502, '  Immigrants'],
  [1506, '    2011 to 2015'],
  [1507, '    2016 to 2021'],
  [1900, 'Total - Mobility status 1 year ago - 25% sample data'],
  [1901, '  Non-movers'],
  [1902, '  Movers'],
  [1910, 'Total - Mobility status 5 years ago - 25% sample data'],
  [1911, '  Non-movers'],
  [1912, '  Movers'],
  [1998, 'Total - Highest certificate, diploma or degree for the population aged 15 years and over in private households - 25% sample data'],
  [2000, "  Bachelor's degree or higher"],
  [2010, 'Total - Highest certificate, diploma or degree for the population aged 25 to 64 years in private households - 25% sample data'],
  [2014, "  Bachelor's degree or higher"],
  [2224, 'Unemployment rate'],
];
const DAS = [
  { code: '59150101', name: '0101', v: { 1: 500, 6: 4000, 8: 500, 9: 80, 10: 340, 11: 80, 39: 41.2, 50: 200, 51: 60, 52: 80, 57: 2.5, 115: 90000, 345: 12.5,
      1416: 200, 1417: 120, 1418: 80, 1500: 480, 1501: 300, 1502: 180, 1506: 20, 1507: 30, 1900: 480, 1901: 400, 1902: 80, 1910: 480, 1911: 250, 1912: 230,
      1998: 400, 2000: 200, 2010: 300, 2014: 180, 2224: 6.1 } },
  { code: '59150102', name: '0102', v: { 1: 1000, 6: 8000, 8: 1000, 9: 100, 10: 700, 11: 200, 39: 45.0, 50: 450, 51: 225, 52: 150, 57: 2.2, 115: 60000, 345: 20,
      1416: 450, 1417: 90, 1418: 360, 1500: 980, 1501: 400, 1502: 580, 1506: 50, 1507: 98, 1900: 980, 1901: 900, 1902: 80, 1910: 980, 1911: 490, 1912: 490,
      1998: 850, 2000: 300, 2010: 600, 2014: 240, 2224: 9.3 } },
  { code: '59150103', name: '0103', v: { 1: 300, 6: 1500, 8: 300, 9: 60, 10: 200, 11: 40, 39: 38.9, 50: 100, 51: 20, 52: 40, 57: 3.0, 115: null, 345: 'x',
      1416: 100, 1417: 75, 1418: 25, 1500: 290, 1501: 250, 1502: 40, 1506: 5, 1507: '..', 1900: 290, 1901: 280, 1902: 10, 1910: 290, 1911: 200, 1912: 90,
      1998: 250, 2000: 50, 2010: 180, 2014: 'F', 2224: 4.0 } },
];
const rows = [];
for (const da of DAS) {
  for (const [id, name] of CHARS) {
    const v = da.v[id];
    const count = v == null ? '' : String(v);
    rows.push(['2021', '2021S0512' + da.code, da.code, 'Dissemination area', da.name, '3.1', '7.7', '00000', String(id), name, '',
      count, v === 'x' || v === 'F' || v === '..' ? v : '', '', '', '', '', '', '', '', '', '', '']);
  }
}
const csv = [HEADER, ...rows].map((r) => r.map((c) => (/[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c)).join(',')).join('\r\n');

console.log('\n== Long Census Profile: layout, pivot, hierarchy ==');
const table = T.parseDelimited(csv);
const layout = Census.detectProfileLayout(table.header);
ok('layout detected by name', layout && layout.name === 9 && layout.count === 11 && layout.rate === 17 && layout.charId === 8 && layout.dguid === 1 && layout.altCode === 2, JSON.stringify(layout));
eq('the SYMBOL column right after each value column is the one used', [layout.countSymbol, layout.rateSymbol], [12, 18]);
const profile = Census.parseLongProfile(table, layout);
eq('three geographies, all characteristics', [profile.geographies, profile.characteristics.length], [3, CHARS.length]);
eq('geography level read', profile.geoLevel, 'Dissemination area');
const renter = profile.byCharId.get(1418), tenure = profile.byCharId.get(1416);
eq('indentation gives depth and parent', [renter.depth, renter.parentId, tenure.depth, tenure.parentId], [1, 1416, 0, null]);
eq('deeper nesting resolves to the nearest ancestor', profile.byCharId.get(1507).parentId, 1502);
const g1 = profile.byGeo.get('59150101');
near('a count', g1.count[renter.index], 80);
ok('suppressed and blank cells are NaN', Number.isNaN(profile.byGeo.get('59150103').count[profile.byCharId.get(345).index])
   && Number.isNaN(profile.byGeo.get('59150103').count[profile.byCharId.get(115).index]));
ok('keep() filters geographies', Census.parseLongProfile(table, layout, { keep: (geo) => geo !== '59150102' }).geographies === 2);

console.log('\n== Starter variables ==');
const derived = Census.deriveVariables(profile);
eq('every starter matched', derived.unmatched, []);
const byKey = new Map(derived.variables.map((v) => [v.key, v]));
near('pct_renter = 100 * Renter / tenure total', byKey.get('pct_renter').values.get('59150102'), 100 * 360 / 450);
near('pct_65_plus', byKey.get('pct_65_plus').values.get('59150101'), 16);
ok('Movers resolved under the 5-year total, not the 1-year one', byKey.get('pct_movers_5yr').id === 1912 && /5 years/.test(byKey.get('pct_movers_5yr').over));
near('pct_movers_5yr', byKey.get('pct_movers_5yr').values.get('59150102'), 50);
ok("Bachelor's resolved under the 25-64 total", byKey.get('pct_bachelor_plus').id === 2014);
near('pct_recent_immigrant is a share of the population, not of immigrants', byKey.get('pct_recent_immigrant').values.get('59150102'), 100 * 98 / 980);
near('median income is a plain count', byKey.get('median_hh_income').values.get('59150101'), 90000);
ok('a suppressed cell yields no value rather than zero', !byKey.get('pct_lim_at').values.has('59150103') && !byKey.get('pct_bachelor_plus').values.has('59150103'));
eq('the match report names the row that fired', derived.matched.find((m) => m.key === 'pct_renter'), { key: 'pct_renter', id: 1418, name: 'Renter', over: 'Total - Private households by tenure - 25% sample data' });
const anyChar = Census.characteristicVariable(profile, 51, 'count');
eq('any characteristic can become a variable', [anyChar.key, anyChar.values.get('59150101')], ['c51', 60]);
ok('an unknown id is null', Census.characteristicVariable(profile, 999999) === null);
/* The profile carries "0 to 14 years" and an age total but no "15 and over"
   line, and a per-area denominator of adult residents needs the second. It is
   the total less the first -- a count, so it shares out across a crosswalk
   rather than being averaged. */
near('pop_15_plus is the age total less the 0-to-14 band',
     byKey.get('pop_15_plus').values.get('59150101'), 500 - 80);
near('and again where the split is different', byKey.get('pop_15_plus').values.get('59150102'), 1000 - 100);
eq('it is a count, not a rate or a share', byKey.get('pop_15_plus').use, 'complement');
const noAge = Census.deriveVariables(profile, [
  { key: 'pop_15_plus', label: 'x', name: /^Nowhere near an age band$/i, use: 'complement',
    over: /^Total - Age groups of the population/i },
  { key: 'no_total', label: 'y', name: /^0 to 14 years$/i, use: 'complement', over: /^No such total$/i },
]);
eq('a complement with either half missing is absent, never zero', noAge.unmatched, ['pop_15_plus', 'no_total']);

const missing = Census.deriveVariables(profile, [{ key: 'nope', label: 'x', name: /^Nothing here$/, use: 'count' }]);
eq('unmatched starters are listed', missing.unmatched, ['nope']);

console.log('\n== Wide tables ==');
const wideHeader = ['DGUID', 'DAUID', 'pct_renter', 'median_hh_income', 'note'];
const wideRows = [['2021S051259150101', '59150101', '40.0', '90,000', 'a'], ['2021S051259150102', '59150102', '80', '', 'b'], ['2021S051259150103', '59150103', 'x', '55000', 'c']];
const wide = Census.readWide({ header: wideHeader, rows: wideRows });
eq('geography column found', wide.geoColumn, 'DAUID');
eq('numeric columns become variables; text columns do not', wide.variables.map((v) => v.key), ['pct_renter', 'median_hh_income']);
eq('values keyed by the trailing code, commas stripped', [wide.variables[1].values.get('59150101'), wide.variables[0].values.has('59150103')], [90000, false]);
eq('DGUID and DAUID spell the same key', [Census.geoKey('2021S051259150101'), Census.geoKey('59150101'), Census.geoKey(' 2021S051359150101001 ')], ['59150101', '59150101', '59150101001']);
/* A starter file is one the atlas computed itself, so the name is known and the
   header is a programmer's identifier. Naming the variable after its header put
   "pct_renter" in the census picker, the map legend, the Compare table, the
   target list and the column headings of the CSV a client opens -- while a
   build reading the raw profile showed "Renter households" for the same number.
   Same atlas, same variable, two names, and the identifier went to the client. */
eq('a column that IS a starter key takes the curated name',
   wide.variables.map((v) => v.label), ['Renter households', 'Median household income']);
eq('and the short and precise forms come with it, for the table and its tooltip',
   [wide.variables[0].short, wide.variables[0].precise], ['Renters', 'Renter households (%)']);
eq('while the key itself is untouched, because everything joins on it',
   wide.variables.map((v) => v.key), ['pct_renter', 'median_hh_income']);
/* Renaming on a guess would be worse than the identifier: somebody's own table
   is theirs to name, and a header this does not recognise is left alone. */
const ownTable = Census.readWide({ header: ['DAUID', 'doors_knocked', 'pct_renter'],
  rows: [['59150101', '12', '40'], ['59150102', '30', '80']] });
eq('a column nobody curated keeps the header it arrived with',
   ownTable.variables.map((v) => v.label), ['doors_knocked', 'Renter households']);

console.log('\n== Geographic Attribute File ==');
const gaf = Census.readGeoAttributes({ header: ['DBUID', 'DBPOP2021', 'DBTDWELL2021', 'DBURDWELL2021', 'DAUID', 'CSDUID', 'CSDNAME'],
  rows: [['5915010101', '120', '50', '48', '59150101', '5915022', 'Vancouver'], ['5915010102', '380', '150', '140', '59150101', '5915022', 'Vancouver'],
         ['5915010201', '1000', '400', '390', '59150102', '5915022', 'Vancouver'], ['5915010202', 'x', '', '', '59150102', '5915022', 'Vancouver']] });
eq('block population read', gaf.dbPop.get('5915010102'), 380);
eq('DA population is the sum of its blocks', [gaf.daPop.get('59150101'), gaf.daPop.get('59150102')], [500, 1000]);
eq('suppressed block has no population entry', gaf.dbPop.has('5915010202'), false);
eq('columns reported', gaf.columns, { db: 'DBUID', pop: 'DBPOP2021', da: 'DAUID' });
let threw = null; try { Census.readGeoAttributes({ header: ['A', 'B'], rows: [] }); } catch (e) { threw = e.message; }
ok('missing columns are an error, not silence', /DBUID/.test(threw || ''));

console.log('\n== Joining to features ==');
const feats = [{ properties: { DAUID: '59150102', DGUID: '2021S051259150102' } }, { properties: { DAUID: '59150101', DGUID: '2021S051259150101' } }, { properties: { DAUID: '59159999' } }];
eq('DAUID suggested as the key', Census.suggestGeoKey(feats), 'DAUID');
const blockFeats = [{ properties: { DBUID: '5915010101', DGUID: '2021S05135915010101', DAUID: '59150101' } },
  { properties: { DBUID: '5915010102', DGUID: '2021S05135915010102', DAUID: '59150101' } }];
eq('a block layer keys by DBUID, not the shared DAUID', Census.suggestGeoKey(blockFeats), 'DBUID');
const joined = Census.joinToFeatures(feats, 'DAUID', byKey.get('pct_renter').values);
eq('joined by DAUID', [joined.get(0), joined.get(1), joined.has(2)], [80, 40, false]);
const joined2 = Census.joinToFeatures(feats, 'DGUID', byKey.get('pct_renter').values);
eq('joined by DGUID gives the same', [joined2.get(0), joined2.get(1)], [80, 40]);

console.log('\n== A planted variable correlates perfectly with turnout on DAs ==');
// Three DAs with turnout 0.5, 0.6, 0.7 and a variable defined as 20 + 100 * turnout.
const pts = [[0.5, 70], [0.6, 80], [0.7, 90]].map(([t, v]) => ({ x: v, y: t, weight: 100 }));
const r = An.correlateXY(pts);
near('r = 1', r.r, 1, 1e-12);
near('weighted r = 1', r.rWeighted, 1, 1e-12);

console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll census tests passed.\n');
process.exit(fails ? 1 : 0);
