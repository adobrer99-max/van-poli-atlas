#!/usr/bin/env node
/* Runs the test suites in order and stops at the first failure.

     node tests/run.js             the node suites (no browser needed)
     node tests/run.js --browser   the two Playwright suites
     node tests/run.js --all       both, node first

   Every suite is a plain script that exits non-zero on failure, so this is
   only sequencing plus two checks that turn the usual first-run mistakes into
   one clear line instead of a wall of failures. */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const NODE_SUITES = ['test-geo', 'test-text', 'test-binary', 'test-ingest', 'test-analysis',
  'test-slivers', 'test-repair', 'test-results', 'test-turnout', 'test-perf'];
const BROWSER_SUITES = ['test-browser', 'test-variants'];

const args = new Set(process.argv.slice(2));
const suites = args.has('--all') ? NODE_SUITES.concat(BROWSER_SUITES)
  : args.has('--browser') ? BROWSER_SUITES : NODE_SUITES;

const fixtures = ['fixtures/albers_control.json', 'fixtures/va_shapefile.zip', 'fixtures/e2e_expected.json'];
const missing = fixtures.filter((f) => !fs.existsSync(path.join(root, f)));
if (missing.length) {
  console.error(`Test fixtures are missing (${missing.join(', ')}). Generate them first:\n  npm run fixtures`);
  process.exit(1);
}
if (suites.some((s) => BROWSER_SUITES.includes(s))) {
  try {
    require.resolve('playwright');
  } catch {
    console.error('Playwright is not installed. Run:\n  npm ci && npx playwright install chromium');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(root, 'vancouver-boundary-atlas.html'))) {
    console.error('The built atlas is missing. Run:\n  npm run build');
    process.exit(1);
  }
}

const started = Date.now();
for (const suite of suites) {
  console.log(`\n### ${suite}`);
  const result = spawnSync(process.execPath, [path.join(__dirname, suite + '.js')],
    { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\n${suite} failed (${result.status == null ? result.signal : 'exit ' + result.status}).`);
    process.exit(result.status || 1);
  }
}
console.log(`\nAll ${suites.length} suites passed in ${((Date.now() - started) / 1000).toFixed(0)} s.`);
