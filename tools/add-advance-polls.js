#!/usr/bin/env node
/* Record which advance poll each polling division reported to.

   Forty-three per cent of the federal ballots in 2025 were cast at an advance
   poll, and an advance poll has no boundary of its own. Without knowing which
   divisions fed it, the only honest thing to do with its ballots is spread
   them across the whole riding -- about 190 divisions -- which is the crudest
   step in the atlas, applied to nearly half the vote.

   Elections Canada publishes the answer. The polling-division attribute table
   in the Electoral Geography Files carries ADV_POLL_N on every ordinary
   division: the advance poll it reported to. Each advance poll serves three to
   fourteen divisions, so knowing it shrinks the spread roughly seventeenfold.

   This tool copies that column onto the polls in boundaries/fed_polls.geojson
   as `adv`. Only the attribute table is needed -- the geometry is already in
   the payload -- so the 175 MB .shp of the same shapefile is not required.

   Usage:
     node tools/add-advance-polls.js \
         --polls boundaries/fed_polls.geojson \
         --dbf PD_CA_2025_EN.dbf \
         [--feds 59035,59036,59037,59038,59039,59040] \
         [--dry-run] [--out out.geojson]

   The source is Elections Canada, Polling Division Boundaries 2025, under the
   Open Government Licence -- Canada, the same file and the same terms the
   payload's geometry already comes under. The .dbf is a file you download
   yourself; nothing here is redistributed, so this does not run in CI.

   Matching is on FED_NUM plus PD_NUM_SFX, which is already the payload's exact
   poll spelling ("83-0"). Every payload poll that finds no row is reported
   rather than passed over, because a silent miss here would quietly send that
   division's advance ballots back to the district-wide spread. */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function parseArgs(argv) {
  const out = { dryRun: false, feds: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--polls') out.polls = next();
    else if (a === '--dbf') out.dbf = next();
    else if (a === '--feds') out.feds = new Set(next().split(',').map((s) => s.trim()));
    else if (a === '--out') out.out = next();
    else if (a === '--dry-run') out.dryRun = true;
    else { console.error(`Unknown argument: ${a}`); process.exit(2); }
  }
  for (const k of ['polls', 'dbf']) {
    if (!out[k]) { console.error(`--${k} is required. See the header of this file.`); process.exit(2); }
  }
  return out;
}

/* tools/shp.py already reads a DBF, and it is the reader the rest of the
   project trusts, so it is called rather than reimplemented here. */
function readDbf(dbfPath) {
  const script = `
import json, sys, os
sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..'))})
from tools import shp
rows = [r for _, r in shp.read_dbf(${JSON.stringify(path.resolve(dbfPath))})]
keep = ('FED_NUM', 'PD_NUM_SFX', 'PD_TYPE', 'ADV_POLL_N')
print(json.dumps([{k: r.get(k) for k in keep} for r in rows]))
`;
  const out = execFileSync('python3', ['-c', script], { maxBuffer: 1 << 28 });
  return JSON.parse(out.toString());
}

function main() {
  const opts = parseArgs(process.argv);
  const rows = readDbf(opts.dbf);
  console.log(`${opts.dbf}: ${rows.length.toLocaleString()} polling divisions`);

  /* fed + poll -> advance poll, for the ordinary divisions that have one.
     Mobile and single-building polls report no advance poll and are left
     alone; their ballots stay the district's to spread. */
  const advOf = new Map();
  for (const r of rows) {
    const adv = String(r.ADV_POLL_N == null ? '' : r.ADV_POLL_N).trim();
    if (!adv || r.PD_TYPE !== 'N') continue;
    advOf.set(`${r.FED_NUM}/${String(r.PD_NUM_SFX).trim()}`, adv);
  }
  console.log(`ordinary divisions with an advance poll: ${advOf.size.toLocaleString()}`);

  const doc = JSON.parse(fs.readFileSync(opts.polls, 'utf8'));
  const considered = doc.features.filter((f) =>
    !opts.feds || opts.feds.has(String(f.properties.fed)));
  console.log(`payload polls considered: ${considered.length} of ${doc.features.length}`);

  const served = new Map();
  const missed = [];
  let tagged = 0;
  for (const f of considered) {
    const p = f.properties;
    const adv = advOf.get(`${p.fed}/${p.poll}`);
    if (!adv) {
      /* Only an ordinary poll is expected to have one. A mobile or
         single-building poll without one is normal, not a miss. */
      if (p.type === 'N') missed.push(`${p.fed}/${p.poll}`);
      continue;
    }
    if (!opts.dryRun) p.adv = adv;
    tagged++;
    const key = `${p.fed}/${adv}`;
    if (!served.has(key)) served.set(key, 0);
    served.set(key, served.get(key) + 1);
  }

  console.log(`\ntagged: ${tagged} divisions across ${served.size} advance polls`);
  const sizes = [...served.values()].sort((a, b) => a - b);
  if (sizes.length) {
    console.log(`divisions per advance poll: ${sizes[0]} to ${sizes[sizes.length - 1]}, `
      + `median ${sizes[Math.floor(sizes.length / 2)]}`);
  }
  const byFed = new Map();
  for (const key of served.keys()) {
    const fed = key.split('/')[0];
    byFed.set(fed, (byFed.get(fed) || 0) + 1);
  }
  for (const [fed, n] of [...byFed].sort()) console.log(`  riding ${fed}: ${n} advance polls`);

  /* A division the source does not know is a division whose advance ballots
     will keep being spread across the whole riding. That is a real loss of
     precision and it is never passed over quietly. */
  if (missed.length) {
    console.log(`\nWARNING: ${missed.length} ordinary polls found no row in the source `
      + 'and keep the district-wide spread:');
    console.log('  ' + missed.slice(0, 24).join(', ') + (missed.length > 24 ? ', …' : ''));
  } else {
    console.log('\nevery ordinary poll in the payload found its advance poll.');
  }

  if (opts.dryRun) { console.log('\n--dry-run: nothing written.'); return; }
  const out = opts.out || opts.polls;
  fs.writeFileSync(out, JSON.stringify(doc));
  console.log(`\nwrote ${out}`);
}

main();
