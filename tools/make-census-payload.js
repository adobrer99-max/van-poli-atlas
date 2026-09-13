#!/usr/bin/env node
/* Turn filter_census.py's output into a payload build.py can bake into the
   atlas, so a reader opens one file and the census layer is already there.

   The point of this is who has to do what. Preparing census data means four
   downloads from Statistics Canada, a multi-gigabyte provincial profile and a
   command line. Reading the finished map should mean opening an HTML file.
   Those are different jobs for different people, and today they are welded
   together because every stakeholder has to load four files through the Data
   tab before they can see anything. This welds them apart: one person runs
   this once, and everyone else gets a file that already knows about Vancouver.

   Usage:
     node tools/make-census-payload.js --in census/ [--out boundaries/]
                                       [--precision 5] [--keep DAUID,DGUID]

   --in is the --out-dir you gave filter_census.py. It needs two things from
   there: the clipped dissemination-area boundaries (lda_*_clip.zip) and
   starter.csv. Everything else that script writes stays an optional load --
   the full characteristic list is 20-30 MB and has no business in a file
   people email each other.

   This is JavaScript rather than Python like filter_census.py on purpose. The
   boundary files are Statistics Canada Lambert (EPSG:3347) and have to reach
   lon/lat; that projection is implemented and tested once, in src/a-geo.js,
   and running it here means the coordinates baked into the build are produced
   by the same code that would have read the shapefile in the browser. A second
   implementation in Python is a second thing to be wrong.

   Inputs are files you download yourself; nothing here is redistributed, so
   this does not run in CI. */
const fs = require('fs');
const path = require('path');
const { load } = require('../tests/harness');

const { Ingest, TextFormats, Census } = load(
  ['a-geo.js', 'b-text.js', 'c-binary.js', 'd-ingest.js', 'e-analysis.js',
   'f-results.js', 'f2-turnout.js', 'f3-census.js'],
  ['Ingest', 'TextFormats', 'Census']);

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

if (has('help') || has('h') || !arg('in')) {
  console.log(fs.readFileSync(__filename, 'utf8')
    .split('\n').slice(1).filter((l) => l.startsWith('   ') || l.startsWith('/*'))
    .join('\n').replace(/^\/\*\s*/, ''));
  process.exit(arg('in') ? 0 : 1);
}

const inDir = arg('in');
const outDir = arg('out', 'boundaries');
const precision = parseInt(arg('precision', '5'), 10);
const keepProps = arg('keep', 'DAUID,DGUID').split(',').map((s) => s.trim()).filter(Boolean);

/* Five decimal places is about a metre at this latitude. The boundaries are
   drawn at city scale and hit-tested against points that are themselves
   geocoded to a building, so more than that is bytes nobody sees. */
const round = (v) => {
  const f = Math.pow(10, precision);
  return Math.round(v * f) / f;
};
function roundGeometry(g) {
  const walk = (c) => (typeof c[0] === 'number' ? [round(c[0]), round(c[1])] : c.map(walk));
  return { type: g.type, coordinates: walk(g.coordinates) };
}

function findOne(dir, re, what) {
  const hits = fs.readdirSync(dir).filter((f) => re.test(f));
  if (!hits.length) {
    throw new Error(`No ${what} in ${dir} (looked for ${re}). Run filter_census.py first — `
      + 'its --out-dir is what --in wants.');
  }
  if (hits.length > 1) {
    throw new Error(`More than one ${what} in ${dir}: ${hits.join(', ')}. Leave one.`);
  }
  return path.join(dir, hits[0]);
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });

  /* --- The boundaries ----------------------------------------------------- */
  const shpPath = findOne(inDir, /^lda_.*_clip\.zip$/i, 'clipped dissemination-area boundary file');
  const loaded = await Ingest.loadBoundaries(path.basename(shpPath), fs.readFileSync(shpPath), {});
  if (!loaded.features.length) throw new Error(`${shpPath} holds no areas.`);

  const key = Census.suggestGeoKey(loaded.features);
  if (!key) {
    throw new Error('No id field was found on these areas, so nothing could be joined to them. '
      + `They carry: ${Object.keys(loaded.features[0].properties).join(', ')}.`);
  }
  const kept = keepProps.filter((p) => p in loaded.features[0].properties);
  if (!kept.includes(key)) kept.push(key);
  const features = loaded.features.map((f) => {
    const props = {};
    for (const p of kept) props[p] = f.properties[p];
    return { type: 'Feature', properties: props, geometry: roundGeometry(f.geometry) };
  });
  const geo = { type: 'FeatureCollection', features };
  const geoPath = path.join(outDir, 'census_da.geojson');
  fs.writeFileSync(geoPath, JSON.stringify(geo));

  /* --- The starter variables ---------------------------------------------- */
  const starterPath = path.join(inDir, 'starter.csv');
  if (!fs.existsSync(starterPath)) {
    throw new Error(`${starterPath} is missing. filter_census.py writes it beside the clipped `
      + 'boundaries; if it did not, its --profile was probably the wrong product.');
  }
  const starterText = fs.readFileSync(starterPath, 'utf8');
  const table = TextFormats.parseDelimited(starterText);
  const wide = Census.readWide(table);
  /* A payload whose ids do not match the boundaries it ships with would fail
     silently on someone else's machine, with an empty map and no reason given.
     It is cheap to check here and impossible to check there. */
  const ids = new Set(features.map((f) => Census.geoKey(f.properties[key])));
  const geoCol = table.header.indexOf(wide.geoColumn);
  const starterIds = new Set(table.rows.map((r) => Census.geoKey(r[geoCol])).filter(Boolean));
  let matched = 0;
  for (const geoId of starterIds) if (ids.has(geoId)) matched++;
  const outStarter = path.join(outDir, 'census_starter.csv');
  fs.writeFileSync(outStarter, starterText);

  const kb = (p) => `${(fs.statSync(p).size / 1024).toFixed(0)} KB`;
  console.log(`${geoPath}: ${features.length} dissemination areas, ${kb(geoPath)}`);
  console.log(`   id field ${key}, properties ${kept.join(', ')}, ${precision} decimal places`);
  console.log(`${outStarter}: ${wide.geographies} geographies, ${wide.variables.length} variables, ${kb(outStarter)}`);
  console.log(`   ${matched} of ${starterIds.size} join to a boundary`);
  if (matched === 0) {
    console.error('\nNONE of the starter rows match a boundary id. The profile and the '
      + 'boundaries are probably from different geographic levels or different years; '
      + 'baking this in would ship an empty map.');
    process.exit(1);
  }
  if (matched < ids.size * 0.9) {
    console.error(`\nOnly ${matched} of ${ids.size} areas would carry data. Check that the `
      + 'profile and the boundaries cover the same study area before baking this in.');
  }
  console.log('\nNow rebuild:  python3 build.py');
})().catch((err) => { console.error(String(err.message || err)); process.exit(1); });
