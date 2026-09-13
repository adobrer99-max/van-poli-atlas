#!/usr/bin/env node
/* Tag the polling divisions that lie outside the study municipality.

   Federal ridings do not stop at city limits. Vancouver Quadra reaches into
   UBC and the University Endowment Lands, and Vancouver Fraserview--South
   Burnaby is a third Burnaby by electors. Left untagged, those polls are
   counted as City of Vancouver everywhere in the atlas, and -- worse -- their
   ballots are apportioned onto city polls when they have no polygon of their
   own. So each poll is measured against a boundary you supply, and the ones
   that fall outside it are marked:

       jurisdiction  a sentence the readout and the legend can print
       locality      the municipality the poll actually sits in

   The app reads nothing else: `outsideCity` is just `Boolean(jurisdiction)`,
   and the Area control on the Map tab decides what to do with it.

   Usage:
     node tools/tag-jurisdiction.js \
         --polls boundaries/fed_polls.geojson \
         --inside city.geojson \
         --jurisdiction "South Burnaby -- outside City of Vancouver" \
         --locality Burnaby \
         --feds 59037 \
         [--min-share 0.5] [--step 60] [--dry-run] [--out out.geojson]

   --inside takes any polygon file whose union is the municipality. The twelve
   Elections BC voting-area polygons for the Vancouver provincial districts do
   for the eastern edge, which is Boundary Road exactly; they do NOT do for the
   western one, because provincial Vancouver-Point Grey includes UBC and the
   UEL. Between the two the city is covered, which is why --feds exists: run it
   once per boundary you trust, over the ridings that boundary can judge.

   This is JavaScript rather than Python like the other tools on purpose. It
   loads src/a-geo.js, so the point-in-polygon test here is the same code the
   app runs at load time, and a poll can never be tagged one way on disk and
   hit-tested the other way on screen.

   Boundary inputs are files you download yourself; nothing here is
   redistributed, so this does not run in CI. */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadGeo() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'a-geo.js'), 'utf8');
  const ctx = vm.createContext({ Math, JSON, Map, Set, Array, Object, Number, String,
    isFinite, isNaN, parseFloat, parseInt, Float64Array, Int32Array, Uint32Array, console });
  vm.runInContext(src, ctx, { filename: 'a-geo.js' });
  return vm.runInContext('Geo', ctx);
}

function parseArgs(argv) {
  const out = { minShare: 0.5, step: 60, feds: null, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--polls') out.polls = next();
    else if (a === '--inside') out.inside = next();
    else if (a === '--jurisdiction') out.jurisdiction = next();
    else if (a === '--locality') out.locality = next();
    else if (a === '--feds') out.feds = new Set(next().split(',').map((s) => s.trim()));
    else if (a === '--min-share') out.minShare = parseFloat(next());
    else if (a === '--step') out.step = parseFloat(next());
    else if (a === '--out') out.out = next();
    else if (a === '--dry-run') out.dryRun = true;
    else { console.error(`Unknown argument: ${a}`); process.exit(2); }
  }
  for (const k of ['polls', 'inside', 'jurisdiction']) {
    if (!out[k]) { console.error(`--${k} is required. See the header of this file.`); process.exit(2); }
  }
  return out;
}

/* Share of a poll's ground inside the boundary, by an equal-area lattice over
   its own bounding box: points inside the poll, then how many of those are
   also inside the municipality. A poll too small to catch a lattice point --
   a single building, a mobile stop -- falls back to its representative point,
   which is inside its own polygon by construction. */
function shareInside(Geo, geom, index, step) {
  const [x0, y0, x1, y1] = Geo.bboxOf(geom);
  const dLat = step / 110574;
  const dLon = step / (111320 * Math.cos(((y0 + y1) / 2) * Math.PI / 180));
  let inPoll = 0, inside = 0;
  for (let y = y0 + dLat / 2; y < y1; y += dLat) {
    for (let x = x0 + dLon / 2; x < x1; x += dLon) {
      if (!Geo.inGeometry(x, y, geom)) continue;
      inPoll++;
      if (index.hit(x, y) >= 0) inside++;
    }
  }
  if (inPoll) return inside / inPoll;
  const p = Geo.representativePoint(geom);
  return p ? (index.hit(p[0], p[1]) >= 0 ? 1 : 0) : null;
}

function main() {
  const opts = parseArgs(process.argv);
  const Geo = loadGeo();

  const boundary = JSON.parse(fs.readFileSync(opts.inside, 'utf8')).features;
  boundary.forEach((f) => Geo.normalizeWinding(f.geometry));
  const index = Geo.buildIndex(boundary);
  console.log(`boundary: ${boundary.length} polygons from ${opts.inside}`);

  const doc = JSON.parse(fs.readFileSync(opts.polls, 'utf8'));
  const considered = doc.features.filter((f) =>
    f.geometry && (!opts.feds || opts.feds.has(f.properties.fed)));
  console.log(`polls considered: ${considered.length} of ${doc.features.length}`
    + (opts.feds ? ` (ridings ${[...opts.feds].join(', ')})` : ''));

  const tagged = [], kept = [], partial = [];
  for (const f of considered) {
    const share = shareInside(Geo, f.geometry, index, opts.step);
    if (share == null) continue;
    if (share > 0.001 && share < 0.999) partial.push({ f, share });
    if (share < opts.minShare) {
      tagged.push({ f, share });
      if (!opts.dryRun) {
        f.properties.jurisdiction = opts.jurisdiction;
        if (opts.locality) f.properties.locality = opts.locality;
      }
    } else kept.push({ f, share });
  }

  console.log(`\ninside  (share >= ${opts.minShare}): ${kept.length}`);
  console.log(`outside (share <  ${opts.minShare}): ${tagged.length}`);
  /* A clean split has nothing in the middle. Anything that does straddle is
     printed in full, because a poll cut in half by a city line is a judgement
     call and should not be made silently by a threshold. */
  if (partial.length) {
    console.log(`\npolls straddling the boundary (${partial.length}) -- check these:`);
    for (const { f, share } of partial.sort((a, b) => a.share - b.share)) {
      console.log(`  ${f.properties.fed} poll ${String(f.properties.poll).padEnd(7)} `
        + `type ${f.properties.type}  inside ${(share * 100).toFixed(1)}%`
        + (share < opts.minShare ? '  -> TAGGED' : ''));
    }
  }
  if (tagged.length) {
    console.log(`\ntagged "${opts.jurisdiction}":`);
    const byFed = new Map();
    for (const { f } of tagged) {
      const k = f.properties.fed;
      if (!byFed.has(k)) byFed.set(k, []);
      byFed.get(k).push(f.properties.poll);
    }
    for (const [fed, polls] of byFed) {
      console.log(`  ${fed}: ${polls.length} polls — ${polls.sort().join(', ')}`);
    }
  }

  if (opts.dryRun) { console.log('\n--dry-run: nothing written.'); return; }
  const out = opts.out || opts.polls;
  fs.writeFileSync(out, JSON.stringify(doc));
  console.log(`\nwrote ${out}`);
}

main();
