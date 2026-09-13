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
const NODE_SUITES = ['test-geo', 'test-lcc', 'test-text', 'test-binary', 'test-ingest', 'test-analysis',
  'test-sample', 'test-slivers', 'test-repair', 'test-results', 'test-turnout', 'test-census',
  'test-places', 'test-summary', 'test-points', 'test-municipal', 'test-perf'];
const BROWSER_SUITES = ['test-browser', 'test-variants'];
/* Python suites cover the local tools in tools/; they run with the node ones. */
const PYTHON_SUITES = ['test-shp-tools', 'test-filter-census', 'test-clip-geojson'];

const args = new Set(process.argv.slice(2));
const suites = args.has('--all') ? NODE_SUITES.concat(BROWSER_SUITES)
  : args.has('--browser') ? BROWSER_SUITES : NODE_SUITES;

const fixtures = ['fixtures/albers_control.json', 'fixtures/va_shapefile.zip', 'fixtures/e2e_expected.json',
  'fixtures/e2e_ebc_order.zip'];
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
const run = (suite, cmd, file) => {
  console.log(`\n### ${suite}`);
  const result = spawnSync(cmd, [file], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\n${suite} failed (${result.status == null ? result.signal || result.error : 'exit ' + result.status}).`);
    process.exit(result.status || 1);
  }
};
for (const suite of suites) run(suite, process.execPath, path.join(__dirname, suite + '.js'));
const python = !args.has('--browser');
if (python) for (const suite of PYTHON_SUITES) run(suite, process.platform === 'win32' ? 'python' : 'python3', path.join(__dirname, suite + '.py'));
const total = suites.length + (python ? PYTHON_SUITES.length : 0);
console.log(`\nAll ${total} suites passed in ${((Date.now() - started) / 1000).toFixed(0)} s.`);
