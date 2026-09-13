#!/usr/bin/env node
/* Turn the files you downloaded into a payload build.py can bake into the
   atlas, so a reader opens one file and everything is already loaded.

   The point of this is who has to do what. Preparing this atlas's data means
   downloads from four agencies, a multi-gigabyte census profile and a command
   line. Reading the finished map should mean opening a file. Those are
   different jobs for different people, and without this they are welded
   together, because every reader has to load eight files through the Data tab
   before they can see anything.

   Usage:
     node tools/make-payload.js --out payload \
         [--census census/]                 filter_census.py's output directory
         [--fed-results dir-or-file ...]    Elections Canada poll-by-poll CSVs
         [--prov-geo file]                  Elections BC voting areas
         [--prov-results file]              provincial results
         [--prov-electors file]             registered voters by district
         [--muni-results file]              the city's results archive
         [--muni-places file]               the city's voting places
         [--precision 5] [--no-clip]

   Each input is converted to the plainest text form the atlas reads -- a
   shapefile becomes lon/lat GeoJSON, an archive becomes the CSVs inside it --
   and written under --out in a directory named for the loader that reads it.
   build.py inlines those; the app hands each one to the very same function the
   Data tab's file input calls. There is no second parsing path to drift.

   Boundaries are rounded to five decimal places, about a metre, which is well
   past what a city-scale map or a building-level hit test can use.

   WHAT THIS WILL NOT TAKE: an elector roll, or anything else from section 5.
   That is names and home addresses. It is read in the browser tab on the
   campaign's own device, and a file people pass around has no business
   carrying it. There is deliberately no flag for it.

   This is JavaScript rather than Python like filter_census.py because the
   boundary files are Statistics Canada Lambert and BC Albers, and those
   projections are implemented and tested once, in src/a-geo.js. Running them
   here means the coordinates baked into the build are produced by the same
   code that would have read the file in the browser.

   Inputs are files you download yourself; nothing here is redistributed, so
   this does not run in CI. */
const fs = require('fs');
const path = require('path');
const { load } = require('../tests/harness');

const { Ingest, TextFormats, BinaryFormats, Census, Geo } = load(
  ['a-geo.js', 'b-text.js', 'c-binary.js', 'd-ingest.js', 'e-analysis.js',
   'f-results.js', 'f2-turnout.js', 'f3-census.js'],
  ['Ingest', 'TextFormats', 'BinaryFormats', 'Census', 'Geo']);

const argv = process.argv;
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
/* Repeatable flags: --fed-results a.csv --fed-results b.csv, or one directory. */
const args = (name) => argv.reduce((out, a, i) =>
  (a === `--${name}` && argv[i + 1] ? out.concat(argv[i + 1]) : out), []);

if (argv.includes('--help') || argv.length < 3) {
  console.log(fs.readFileSync(__filename, 'utf8')
    .split('\n').slice(1, 45).join('\n').replace(/^\/\*\s*/, ''));
  process.exit(0);
}

const outDir = arg('out', 'payload');
const precision = parseInt(arg('precision', '5'), 10);
const round = (v) => { const f = 10 ** precision; return Math.round(v * f) / f; };
const roundGeometry = (g) => {
  const walk = (c) => (typeof c[0] === 'number' ? [round(c[0]), round(c[1])] : c.map(walk));
  return { type: g.type, coordinates: walk(g.coordinates) };
};

/* Only what would break the HTML attribute the name is carried in, or a path.
   Everything else stays: the app reads meaning out of these filenames -- which
   race a municipal sheet is, which district a federal file covers -- so
   flattening them to underscores breaks detection in ways that look like
   missing data rather than like a renamed file. */
const safeName = (name) => path.basename(name).replace(/["'<>\\]/g, '').trim();

const written = [];
function put(key, name, text) {
  const dir = path.join(outDir, key);
  fs.mkdirSync(dir, { recursive: true });
  const at = path.join(dir, name);
  fs.writeFileSync(at, text);
  written.push({ key, name, bytes: Buffer.byteLength(text) });
}

/* The study area, as a bounding box with the same 2 km margin the Data tab's
   "clip to the study area" switch uses. A provincial order covers all of
   British Columbia -- 5,778 voting areas and about 49 MB of GeoJSON -- and
   baking that in to look at one city would be absurd, so boundaries are
   clipped here exactly as they would be on the way in. */
const studyFeatures = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'boundaries', 'fed_polls.geojson'), 'utf8')).features;
const studyIndex = Geo.buildIndex(studyFeatures);

const studyBox = (() => {
  const fc = { features: studyFeatures };
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const walk = (c) => {
    if (typeof c[0] === 'number') {
      w = Math.min(w, c[0]); e = Math.max(e, c[0]);
      s = Math.min(s, c[1]); n = Math.max(n, c[1]);
    } else c.forEach(walk);
  };
  for (const f of fc.features) walk(f.geometry.coordinates);
  const dLat = 2000 / 110574;
  const dLon = 2000 / (111320 * Math.cos(((s + n) / 2) * Math.PI / 180));
  return [w - dLon, s - dLat, e + dLon, n + dLat];
})();

/* A boundary file of any kind -> lon/lat GeoJSON, through the atlas's own
   reader, so the projection maths is the same on disk as on screen. */
async function boundaries(key, file, keep) {
  const clip = argv.includes('--no-clip') ? null : studyBox;
  const loaded = await Ingest.loadBoundaries(path.basename(file), fs.readFileSync(file), { bbox: clip });
  if (!loaded.features.length) throw new Error(`${file} holds no areas.`);
  const props = keep && keep.length
    ? keep.filter((p) => p in loaded.features[0].properties) : null;
  /* A bounding box round Vancouver also contains Burnaby, Richmond and the
     North Shore -- 2,492 provincial voting areas where the city has about 700,
     and four fifths of the bytes describing places this atlas does not draw.
     So the clip is finished properly here: an area is kept when its own
     representative point lands inside a federal polling division, which is the
     same hit test the map readout uses. */
  const tight = !argv.includes('--no-clip') && !argv.includes('--bbox-only');
  const features = [];
  let dropped = 0;
  for (const f of loaded.features) {
    if (tight) {
      const pt = Geo.representativePoint(f.geometry);
      if (!pt || studyIndex.hit(pt[0], pt[1]) < 0) { dropped++; continue; }
    }
    const kept = {};
    for (const p of (props && props.length ? props : Object.keys(f.properties))) {
      kept[p] = f.properties[p];
    }
    features.push({ type: 'Feature', properties: kept, geometry: roundGeometry(f.geometry) });
  }
  if (!features.length) {
    throw new Error(`${file}: nothing survived the clip to the study area. `
      + 'Pass --no-clip to keep everything, or check the file covers Vancouver.');
  }
  put(key, 'boundaries.geojson', JSON.stringify({ type: 'FeatureCollection', features }));
  return { features: features.length, of: loaded.features.length, dropped,
           crs: loaded.crsLabel, clipped: Boolean(clip) };
}

/* Files as they are, for anything the atlas already reads as text. A .zip is
   unpacked, because an archive would have to be base64 to survive inlining and
   that is a third of its size again for nothing. */
async function tables(key, inputs) {
  let count = 0;
  const take = (name, text) => { put(key, safeName(name), text); count++; };
  for (const input of inputs) {
    const paths = fs.statSync(input).isDirectory()
      ? fs.readdirSync(input).map((f) => path.join(input, f)) : [input];
    for (const file of paths) {
      if (/\.zip$/i.test(file)) {
        const zip = BinaryFormats.readZip(fs.readFileSync(file));
        for (const [name, open] of zip) {
          if (name.includes('__MACOSX') || /(^|\/)\./.test(name)) continue;
          if (!/\.(csv|tsv|txt)$/i.test(name)) continue;
          take(path.basename(name), TextFormats.decodeBytes(await open()));
        }
      } else if (/\.(csv|tsv|txt)$/i.test(file)) {
        take(path.basename(file), TextFormats.decodeBytes(fs.readFileSync(file)));
      }
    }
  }
  if (!count) throw new Error(`Nothing usable for --${key} in: ${inputs.join(', ')}`);
  return count;
}
(async () => {
  fs.mkdirSync(outDir, { recursive: true });

  /* --- census, from filter_census.py's output ----------------------------- */
  const censusDir = arg('census');
  if (censusDir) {
    const one = (re, what) => {
      const hits = fs.readdirSync(censusDir).filter((f) => re.test(f));
      if (!hits.length) throw new Error(`No ${what} in ${censusDir} (looked for ${re}).`);
      if (hits.length > 1) throw new Error(`More than one ${what} in ${censusDir}: ${hits.join(', ')}`);
      return path.join(censusDir, hits[0]);
    };
    const da = await boundaries('da-geo', one(/^lda_.*_clip\.zip$/i, 'clipped dissemination areas'),
                                ['DAUID', 'DGUID']);
    console.log(`da-geo: ${da.features} dissemination areas (${da.crs})`);
    const blocks = fs.readdirSync(censusDir).filter((f) => /^ldb_.*_clip\.zip$/i.test(f));
    if (blocks.length === 1) {
      const db = await boundaries('db-geo', path.join(censusDir, blocks[0]), ['DBUID', 'DAUID', 'DGUID']);
      console.log(`db-geo: ${db.features} dissemination blocks`);
    }
    await tables('census', [one(/^starter\.csv$/i, 'starter.csv')]);
    console.log('census: starter variables');
    const gaf = fs.readdirSync(censusDir).filter((f) => /^db_population\.csv$/i.test(f));
    if (gaf.length) {
      await tables('geo-attr', [path.join(censusDir, gaf[0])]);
      console.log('geo-attr: block populations');
    }
  }

  /* --- the three elections ------------------------------------------------ */
  const provGeo = arg('prov-geo');
  if (provGeo) {
    /* Everything the atlas reads off a voting area, and nothing else: the
       order also carries OBJECTID, SHAPE.AREA, a CAD annotation blob and a
       gazette date, which together are most of a megabyte of nothing. */
    const p = await boundaries('prov-geo', provGeo,
      ['ED_ABBREVIATION', 'VA_CODE', 'EDVA_CODE', 'VA_TYPE']);
    console.log(`prov-geo: ${p.features} of ${p.of} voting areas`
      + (p.clipped ? ' kept, clipped to the study area' : ' (unclipped)') + ` (${p.crs})`);
  }
  for (const [flag, label] of [['fed-results', 'federal results'],
                               ['prov-results', 'provincial results'],
                               ['prov-electors', 'provincial electors'],
                               ['muni-results', 'municipal results'],
                               ['muni-places', 'municipal voting places']]) {
    const inputs = args(flag);
    if (!inputs.length) continue;
    console.log(`${flag}: ${await tables(flag, inputs)} file(s) — ${label}`);
  }

  if (!written.length) {
    console.error('Nothing was written. Give at least one input; --help lists them.');
    process.exit(1);
  }
  const total = written.reduce((a, w) => a + w.bytes, 0);
  console.log(`\n${outDir}: ${written.length} files, ${(total / 1024).toFixed(0)} KB total`);
  console.log(`Now build:  python3 build.py --payload ${outDir}`);
})().catch((err) => { console.error(String(err.message || err)); process.exit(1); });
