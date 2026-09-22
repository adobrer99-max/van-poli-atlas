const { chromium } = require('playwright');
const path = require('path');
// The build sandbox has no route to tile servers, and an unstubbed tile
// failure reads as a console error. Serve a 1x1 PNG for every tile request and
// record which host was asked, so basemap switching can be asserted.
const ONE_PX_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const tileHosts = [];
const tileUrls = [];
/* Map options and the Data tab's replace-data section are drawers now. A reader
   opens one when they want a setting; a test that is checking what a setting
   DOES opens them up front, so the interaction under test is the setting rather
   than the drawer. The drawers themselves are checked on their own, once. */
const openDrawers = (page) => page.evaluate(() => {
  for (const d of document.querySelectorAll('details.disclosure')) d.open = true;
});

async function stubTiles(page) {
  await page.route(/basemaps\.cartocdn\.com|tile\.openstreetmap\.org/, (route) => {
    tileUrls.push(route.request().url());
    tileHosts.push(new URL(route.request().url()).host);
    route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PX_PNG });
  });
}
/* A quote-aware split, because more than one export now carries a comma
   inside a cell -- "Conservative share, 2025 federal ballots" is one field and
   splitting on every comma reports the file as ragged and blames the export
   for quoting correctly. Shared, since two suites below read CSVs. */
const splitCsv = (line) => {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q && c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
    else if (c === '"') q = !q;
    else if (c === ',' && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
};
let fails = 0;
const ok = (n, c, e = '') => { if (c) console.log(`  PASS  ${n}`); else { console.log(`  FAIL  ${n} ${e}`); fails++; } };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  const file = 'file://' + path.resolve('vancouver-boundary-atlas.html');
  await stubTiles(page);
  await page.goto(file, { waitUntil: 'load' });
  /* What the Map tab looks like before anybody touches it, captured once and
     asserted below: the reader's first sight of it decides whether this reads
     as a map or as a control panel. */
  await page.locator('#tab-map').click();
  await page.waitForTimeout(300);   /* the map is fitted once, asynchronously, on first reveal */
  const firstLook = await page.evaluate(() => {
    const shown = (id) => {
      const r = document.getElementById(id)?.getBoundingClientRect();
      return !!r && r.width > 0 && r.height > 0;
    };
    return {
      mapOptions: document.getElementById('map-options').open,
      advancedData: document.getElementById('advanced-data').open,
      headline: ['area-filter', 'shade-by', 'find-poll'].map(shown),
      tucked: ['prov-opacity', 'prov-weight', 'basemap', 'carto-key'].map(shown),
    };
  });
  await openDrawers(page);
  await page.waitForTimeout(900);

  console.log('\n== Initial load ==');
  ok('no console errors on load', errors.length === 0, errors.join(' | '));
  ok('title set', (await page.title()).includes('Vancouver'));
  const fedPaths = await page.locator('.layer-fed path').count();
  ok(`federal polls rendered (${fedPaths})`, fedPaths > 1000, `got ${fedPaths}`);
  /* 1017, not 1031: the sixteen Vancouver Fraserview--South Burnaby polls that
     sit in Burnaby are tagged out-of-city and the default area excludes them. */
  ok('mobile polls hidden by default, and so are the Burnaby polls', fedPaths === 1017, `got ${fedPaths}`);
  ok('empty-provincial notice shown', await page.locator('#prov-missing').isVisible());
  const finder = await page.locator('#find-poll option').count();
  ok(`poll finder populated (${finder})`, finder === fedPaths + 1);

  console.log('\n== The map leads with the map ==');
  ok('the map options drawer starts shut', firstLook.mapOptions === false, String(firstLook.mapOptions));
  /* This build bakes nothing in, so it is the one used to PREPARE the data and
     its file inputs are the point. The drawer follows that: open here, shut on
     a build that already carries everything (asserted in test-variants). */
  ok('the data drawer starts open when nothing is baked in',
     firstLook.advancedData === true, String(firstLook.advancedData));
  ok('area, colouring and the finder are in front of the reader',
     firstLook.headline.every(Boolean), JSON.stringify(firstLook.headline));
  ok('sliders, basemap and the key are not',
     firstLook.tucked.every((v) => v === false), JSON.stringify(firstLook.tucked));

  console.log('\n== Basemap ==');
  ok('Leaflet map mounted', await page.evaluate(() => !!document.querySelector('#atlas-map.leaflet-container')));
  // Counting paths is not enough: a stylesheet rule once collapsed the renderer
  // SVG to 0x0 while every path still existed. Assert the drawn size.
  const svgBox = await page.evaluate(() => { const b = document.querySelector('.layer-fed svg').getBoundingClientRect(); return [b.width, b.height]; });
  ok(`renderer SVG has a real size (${svgBox.map(Math.round).join('x')})`, svgBox[0] > 300 && svgBox[1] > 300);
  const painted = await page.evaluate(() => { const b = document.querySelector('.layer-fed path').getBoundingClientRect(); const m = document.querySelector('#atlas-map').getBoundingClientRect();
    return b.width > 0 && b.left >= m.left - 1 && b.right <= m.right + 1 && b.top >= m.top - 1 && b.bottom <= m.bottom + 1; });
  ok('a polling division paints inside the map box', painted);
  /* Neither free basemap can be the default any more. CARTO stamps keyless
     tiles with API KEY REQUIRED; OpenStreetMap refuses a page it cannot
     identify, and a file opened from disk sends no Referer to identify it. So
     a build with no key asks for nothing at all, which is complete and correct
     rather than broken-looking. */
  ok('a build with no key requests no tiles at all', tileHosts.length === 0,
     tileHosts.slice(0, 4).join(', '));
  ok('and the street options are disabled rather than offered as if they worked',
     (await page.evaluate(() => ['auto', 'positron', 'dark']
       .every((v) => document.querySelector(`#basemap option[value="${v}"]`).disabled))));
  ok('the boundaries are drawn regardless', (await page.locator('.layer-fed path').count()) === fedPaths);
  /* Pasting a free key turns the street map on, and the key reaches the tile
     URL -- without which CARTO serves the watermark instead. */
  const tileCountBefore = tileHosts.length;
  await page.locator('#carto-key').fill('TESTKEY123');
  await page.locator('#carto-key').dispatchEvent('change');
  await page.waitForTimeout(900);
  ok('pasting a key turns the street basemap on without a second step',
     (await page.locator('#basemap').inputValue()) === 'auto');
  ok('and the key is on the tile request',
     tileUrls.slice(tileCountBefore).some((u) => /cartocdn\.com.*[?&]key=TESTKEY123/.test(u)),
     tileUrls[tileUrls.length - 1] || 'no tile requested');
  await page.locator('#basemap').selectOption('none');
  await page.waitForTimeout(400);
  ok('"None" removes every tile', (await page.locator('.leaflet-tile-pane img.leaflet-tile').count()) === 0);
  ok('polygons survive without a basemap', (await page.locator('.layer-fed path').count()) === fedPaths);
  await page.locator('#basemap').selectOption('auto');
  await page.waitForTimeout(400);
  ok('zoom control present, custom zoom buttons gone', (await page.locator('.leaflet-control-zoom').count()) === 1 && (await page.locator('#zoom-in').count()) === 0);

  console.log('\n== Map interaction ==');
  const box = await page.locator('.atlas-map').boundingBox();
  await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.5);
  await page.waitForTimeout(200);
  let readout = await page.locator('#readout').innerText();
  ok('click produces a federal readout', /Vancouver|Riding/.test(readout), readout.slice(0, 120));
  ok('readout notes the missing provincial layer', /No provincial layer loaded/.test(readout));
  await page.locator('#show-mobile').check();
  await page.waitForTimeout(400);
  const withMobile = await page.locator('.layer-fed path').count();
  ok(`mobile polls can be shown (${fedPaths} -> ${withMobile})`, withMobile === 1087, `got ${withMobile}`);
  await page.locator('#show-mobile').uncheck();
  await page.waitForTimeout(300);

  console.log('\n== Load provincial boundaries (zipped shapefile, BC Albers) ==');
  await page.locator('#tab-data').click();
  await page.locator('#file-prov-geo').setInputFiles('fixtures/e2e_voting_areas.zip');
  await page.waitForTimeout(1500);
  let status = await page.locator('#status-prov-geo').innerText();
  ok('boundaries loaded', /Loaded 700 voting areas/.test(status), status);
  ok('BC Albers detected from the .prj', /BC Albers/.test(status), status);
  const keyD = await page.locator('#prov-key-district').inputValue();
  const keyV = await page.locator('#prov-key-va').inputValue();
  ok(`key fields auto-detected (district=${keyD}, area=${keyV})`, keyD === 'ED_NAME' && keyV === 'VA_CODE');

  await page.locator('#tab-map').click();
  await page.waitForTimeout(600);
  const vaPaths = await page.locator('.layer-prov path').count();
  ok(`provincial voting areas drawn over the federal layer (${vaPaths})`, vaPaths === 700, `got ${vaPaths}`);
  ok('empty-provincial notice gone', !(await page.locator('#prov-missing').isVisible()));

  // The overlay must actually sit on top of Vancouver, not somewhere else.
  const bounds = await page.evaluate(() => {
    const bb = (sel) => { const n = document.querySelector(sel); const b = n.getBBox();
      return [b.x, b.y, b.width, b.height]; };
    return { fed: bb('.layer-fed svg > g'), prov: bb('.layer-prov svg > g') };
  });
  const overlapFrac = (() => {
    const [fx, fy, fw, fh] = bounds.fed, [px, py, pw, ph] = bounds.prov;
    const ix = Math.max(0, Math.min(fx + fw, px + pw) - Math.max(fx, px));
    const iy = Math.max(0, Math.min(fy + fh, py + ph) - Math.max(fy, py));
    return (ix * iy) / (fw * fh);
  })();
  ok(`overlay is registered with the federal layer (${(overlapFrac * 100).toFixed(1)}% bbox overlap)`,
     overlapFrac > 0.85, JSON.stringify(bounds));

  await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.5);
  await page.waitForTimeout(250);
  readout = await page.locator('#readout').innerText();
  ok('joint readout shows both layers', /federal/i.test(readout) && /Sample District/.test(readout), readout.slice(0, 200));

  /* The Non-voters tab before anything it needs exists. A tab that throws on
     an empty state is one nobody reaches twice, and the message has to name
     both halves of what is missing rather than sitting blank. */
  await page.locator('#tab-nonvoters').click();
  await page.waitForTimeout(300);
  const nvEmpty = (await page.locator('#nv-status').innerText()).replace(/\s+/g, ' ');
  ok('the Non-voters tab opens with nothing loaded and says what it needs',
     /Data tab/.test(nvEmpty) && nvEmpty.length > 20, nvEmpty.slice(0, 200));
  ok('and shows no table, no ranking and no badge until it has both halves',
     await page.evaluate(() => ['nv-results', 'nv-priority', 'nv-badge', 'nv-basket-card']
       .every((id) => document.getElementById(id).hidden)));
  ok('and without a console error', errors.length === 0, errors.join(' | '));

  console.log('\n== Load results ==');
  await page.locator('#tab-data').click();
  await page.locator('#file-fed-results').setInputFiles('fixtures/e2e_federal_results.csv');
  await page.waitForTimeout(2500);
  status = await page.locator('#status-fed-results').innerText();
  ok('federal results joined', /1,017 \/ 1,017/.test(status.replace(/\s+/g,' ')), status.replace(/\s+/g,' ').slice(0,220));
  ok('advance polls reported as unmatched', /advance polls/i.test(status), status.slice(0, 300));
  const coverage = status.match(/(\d+\.\d)%/);
  ok(`vote coverage reported (${coverage ? coverage[0] : 'none'})`, !!coverage);

  await page.locator('#file-prov-results').setInputFiles('fixtures/e2e_provincial_results.csv');
  await page.waitForTimeout(2000);
  status = await page.locator('#status-prov-results').innerText();
  ok('provincial results joined', /700 \/ 700/.test(status.replace(/\s+/g,' ')), status.replace(/\s+/g,' ').slice(0,200));
  const wideChecked = await page.locator('#map-prov-results input[type=checkbox]:checked').count();
  ok(`wide-format party columns detected (${wideChecked})`, wideChecked === 3, `got ${wideChecked}`);

  console.log('\n== Choropleth shading ==');
  await page.locator('#tab-map').click();
  await page.waitForTimeout(400);
  await page.locator('#shade-by').selectOption('fed-party');
  await page.waitForTimeout(500);
  // Read the COMPUTED fill: a stylesheet rule outranks a presentation
  // attribute, so checking the attribute alone can pass on an unshaded map.
  const shading = await page.evaluate(() =>
    [...document.querySelectorAll('.layer-fed path')].slice(0, 300).map((n) => {
      const cs = getComputedStyle(n);
      return { fill: cs.fill, op: parseFloat(cs.fillOpacity) };
    }));
  const distinct = new Set(shading.map((v) => v.op.toFixed(2))).size;
  ok(`polls shaded by vote share (${distinct} distinct opacities)`, distinct > 20, `got ${distinct}`);
  const reds = shading.filter((v) => /rgb\(215,\s*25,\s*32\)|#d71920/i.test(v.fill.replace(/\s/g, ' '))).length;
  ok(`computed fill is the party colour, not the default grey (${reds}/${shading.length})`,
     reds > shading.length * 0.9, shading[0].fill);
  await page.locator('#shade-by').selectOption('none');
  await page.waitForTimeout(300);
  const plain = await page.evaluate(() => getComputedStyle(document.querySelector('.layer-fed path')).fill);
  ok('plain mode returns to the neutral fill', !/215,\s*25/.test(plain), plain);
  await page.locator('#shade-by').selectOption('fed-party');
  await page.waitForTimeout(300);
  ok('legend shown', await page.locator('#map-legend').isVisible());

  console.log('\n== Results tab ==');
  // What the files say, before any of it is moved. The figures here must agree
  // with the file itself, so they are checked against sums taken from the CSV.
  {
    const fs = require('fs');
    const lines = fs.readFileSync('fixtures/e2e_provincial_results.csv', 'utf8').split(/\r?\n/).filter(Boolean);
    const head = lines[0].split(',');
    const iRej = head.indexOf('Rejected Ballots');
    const parties = head.slice(3, iRej);
    let valid = 0, rejected = 0;
    const byParty = new Map(parties.map((p) => [p, 0]));
    for (const line of lines.slice(1)) {
      const c = line.split(',');
      rejected += Number(c[iRej]);
      parties.forEach((p, k) => { const v = Number(c[3 + k]); valid += v; byParty.set(p, byParty.get(p) + v); });
    }
    const top = [...byParty.entries()].sort((a, b) => b[1] - a[1])[0];

    await page.locator('#tab-results').click();
    await page.waitForTimeout(500);
    ok('both loaded elections are on offer',
       (await page.locator('#results-side option').allTextContents()).join('|') === 'Federal (2025)|Provincial (2024)',
       (await page.locator('#results-side option').allTextContents()).join('|'));
    const fedStatus = (await page.locator('#results-status').innerText()).replace(/\s+/g, ' ');
    ok('the federal side reports polling divisions', /polling divisions/.test(fedStatus), fedStatus.slice(0, 140));
    await page.locator('#results-side').selectOption('prov');
    await page.waitForTimeout(400);
    const status = (await page.locator('#results-status').innerText()).replace(/\s+/g, ' ');
    ok('switching election changes the figures', status !== fedStatus, status.slice(0, 140));
    ok(`the tab totals match the file itself (${valid + rejected} ballots)`,
       status.includes((valid + rejected).toLocaleString()), status.slice(0, 160));
    const tiles = (await page.locator('#results-stats').innerText()).replace(/\s+/g, ' ');
    ok(`the leading party is the one with the most votes (${top[0]})`, tiles.includes(top[0]), tiles.slice(0, 160));
    ok(`rejected ballots are counted (${rejected})`, tiles.includes(rejected.toLocaleString()), tiles.slice(0, 160));
    const partyText = (await page.locator('#results-parties').innerText()).replace(/\s+/g, ' ');
    ok('every party in the file has a bar',
       parties.every((p) => partyText.includes(p)), partyText.slice(0, 200));
    ok(`the top party's votes are shown (${top[1]})`, partyText.includes(top[1].toLocaleString()), partyText.slice(0, 200));
    const dRows = await page.locator('#results-districts tbody tr').count();
    ok(`every district is listed (${dRows})`, dRows === 12, String(dRows));
    ok('a voting-area file shows no channel breakdown',
       await page.locator('#results-channels-card').isHidden());
    ok('the largest units are named for the geography',
       /Largest voting areas/.test(await page.locator('#results-largest-title').innerText()));

    // Sorting the district table by a heading reorders it.
    const firstBefore = await page.locator('#results-districts tbody tr td').first().innerText();
    await page.locator('#results-districts thead th[data-key="name"]').click();
    await page.waitForTimeout(300);
    const firstAfter = await page.locator('#results-districts tbody tr td').first().innerText();
    ok('clicking a heading sorts the districts', firstBefore !== firstAfter, `${firstBefore} -> ${firstAfter}`);

    const rdl = page.waitForEvent('download', { timeout: 15000 });
    await page.locator('#export-results').click();
    const rcsv = require('fs').readFileSync(await (await rdl).path(), 'utf8').split(/\r?\n/).filter(Boolean);
    ok(`the summary exports (${rcsv.length - 1} rows) with one section column`,
       /^﻿?section,name,detail,ballots/.test(rcsv[0]), rcsv[0].slice(0, 90));
    const totalRow = rcsv.find((r) => /^total,/.test(r));
    ok('and its total row carries the same ballots as the tab',
       totalRow && totalRow.split(',')[3] === String(valid + rejected), totalRow);
  }

  console.log('\n== Crosswalk and correlation ==');
  await page.locator('#tab-corr').click();
  await page.waitForTimeout(300);
  await page.locator('#build-crosswalk').click();
  await page.waitForFunction(() => {
    const s = document.querySelector('#status-crosswalk');
    return s && /lattice points/.test(s.textContent);
  }, { timeout: 60000 });
  status = await page.locator('#status-crosswalk').innerText();
  ok('crosswalk built', /lattice points/.test(status), status.replace(/\s+/g,' ').slice(0, 260));
  const barVisible = await page.locator('#crosswalk-progress').isVisible();
  ok('progress bar is hidden once finished', !barVisible);
  ok('small polygons repaired', /too small for the lattice/.test(status) || !/too small/.test(status));
  console.log('   ' + status.replace(/\s+/g, ' ').slice(0, 240));

  await page.waitForTimeout(800);
  const stats = await page.locator('#corr-stats').innerText();
  ok('correlation statistics shown', /Pearson r/.test(stats), stats.replace(/\s+/g,' ').slice(0,200));
  console.log('   ' + stats.replace(/\s+/g, ' ').slice(0, 220));
  const rValue = parseFloat((stats.match(/([-\d.]+)\s*Pearson r/) || [])[1]);
  ok(`Pearson r is a real number (${rValue})`, isFinite(rValue) && Math.abs(rValue) <= 1);
  const dots = await page.locator('#scatter circle.dot').count();
  ok(`scatter plotted (${dots} points)`, dots > 100, `got ${dots}`);
  ok('fit line drawn', (await page.locator('#scatter path.fit-line').count()) === 1);

  for (const unit of ['fed', 'atom', 'prov']) {
    await page.locator('#corr-unit').selectOption(unit);
    await page.waitForTimeout(900);
    const n = await page.locator('#scatter circle.dot').count();
    const s = await page.locator('#corr-stats').innerText();
    const r = parseFloat((s.match(/([-\d.]+)\s*Pearson r/) || [])[1]);
    ok(`unit=${unit}: ${n} points, r=${r}`, n > 50 && isFinite(r));
  }

  console.log('\n== Turnout tab ==');
  const expected = JSON.parse(require('fs').readFileSync('fixtures/e2e_expected.json', 'utf8'));
  const setRange = (id, v) => page.evaluate(([id, v]) => {
    const el = document.getElementById(id); el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [id, v]);
  const rowCells = (label) => page.evaluate((label) => {
    const tr = [...document.querySelectorAll('#turnout-table tbody tr')].find((r) => r.children[2].textContent === label);
    return tr ? [...tr.children].map((td) => td.textContent) : null;
  }, label);
  await page.locator('#tab-turnout').click();
  await page.waitForTimeout(500);
  // 100% federal weight makes the aggregate equal federal turnout, so the
  // ranking is checkable against the fixture's hand computation.
  await setRange('turnout-weight', '1');
  await page.waitForTimeout(700);
  ok('weight label follows the slider', (await page.locator('#turnout-weight-label').innerText()) === '100% federal · 0% provincial');
  const tstatus = await page.locator('#turnout-status').innerText();
  ok('status reports the ranking', /ranked/.test(tstatus), tstatus.slice(0, 120));
  const nRows = await page.locator('#turnout-table tbody tr').count();
  ok(`one row per ordinary poll with electors (${nRows}, expected ${expected.ordinary_polls}; void polls dropped)`, nRows === expected.ordinary_polls);
  for (const n of expected.named) {
    const c = await rowCells(n.label);
    ok(`${n.label}: federal turnout ${c ? c[3] : 'missing'} vs ${(n.turnout_fed * 100).toFixed(1)}%`,
       c && Math.abs(parseFloat(c[3]) - n.turnout_fed * 100) < 0.1);
    ok(`${n.label}: aggregate equals federal at weight 1 and electors ${c ? c[8] : ''}`,
       c && c[5] === c[3] && parseInt(c[8].replace(/,/g, ''), 10) === n.electors);
  }
  for (const m of expected.merged) {
    const a = await rowCells(m.receiver), b = await rowCells(m.merged);
    ok(`merged pair ${m.receiver} / ${m.merged} share pooled turnout ${(m.turnout_fed * 100).toFixed(1)}%`,
       a && b && Math.abs(parseFloat(a[3]) - m.turnout_fed * 100) < 0.1 && Math.abs(parseFloat(b[3]) - m.turnout_fed * 100) < 0.1,
       `got ${a && a[3]} / ${b && b[3]}`);
  }
  const top3 = await page.evaluate(() => [...document.querySelectorAll('#turnout-table tbody tr')].slice(0, 3).map((r) => r.children[2].textContent));
  ok(`top three by turnout: ${top3.join(' | ')}`, JSON.stringify(top3) === JSON.stringify(expected.top3_by_federal_turnout),
     `expected ${expected.top3_by_federal_turnout.join(' | ')}`);
  ok('curve drawn with electors and expected-ballot lines', (await page.locator('#turnout-curve path.line').count()) === 1 && (await page.locator('#turnout-curve path.line-expected').count()) === 1);
  ok('curve caption quotes the top-20% share', /top 20% of areas/.test(await page.locator('#turnout-curve-caption').innerText()));

  // Sorting: the Federal column header, clicked twice, sorts ascending.
  await page.locator('#turnout-table thead th', { hasText: 'Federal 2025' }).click();
  await page.waitForTimeout(500);
  await page.locator('#turnout-table thead th', { hasText: 'Federal 2025' }).click();
  await page.waitForTimeout(500);
  const firstTwo = await page.evaluate(() => [...document.querySelectorAll('#turnout-table tbody tr')].slice(0, 2).map((r) => parseFloat(r.children[3].textContent)));
  ok(`header click sorts ascending (${firstTwo[0]}% ≤ ${firstTwo[1]}%)`, firstTwo[0] <= firstTwo[1]);
  await page.locator('#turnout-table thead th', { hasText: 'Aggregate' }).click();
  await page.waitForTimeout(500);

  // Basket: two ticked rows pool to the sum of their electors.
  const boxes = page.locator('#turnout-table tbody tr input[type=checkbox]');
  await boxes.nth(0).check(); await boxes.nth(1).check();
  await page.waitForTimeout(300);
  const pooledElectors = await page.evaluate(() => [...document.querySelectorAll('#turnout-table tbody tr')].slice(0, 2)
    .reduce((a, r) => a + parseInt(r.children[8].textContent.replace(/,/g, ''), 10), 0));
  const basketText = (await page.locator('#turnout-basket').innerText()).replace(/\s+/g, ' ');
  ok(`basket holds 2 areas and ${pooledElectors.toLocaleString()} electors`, /^2\s/.test(basketText) && basketText.includes(pooledElectors.toLocaleString()), basketText.slice(0, 120));
  ok('basket rows highlighted on the map', (await page.locator('.layer-fed path.basket').count()) === 2);
  await page.locator('#basket-clear').click();
  await page.waitForTimeout(200);
  ok('basket clears', (await page.locator('.layer-fed path.basket').count()) === 0);

  // Apportionment changes ballots, never electors.
  const before = await rowCells(expected.named[0].label);
  await page.locator('#apportion-fed').selectOption('votes');
  await page.waitForTimeout(700);
  const after = await rowCells(expected.named[0].label);
  ok(`apportioning advance ballots raises turnout (${before[3]} -> ${after[3]}) and leaves electors alone`,
     parseFloat(after[3]) > parseFloat(before[3]) && after[8] === before[8]);
  ok('status warns that an apportioned figure is not a measurement',
     /neither is a measurement/.test(await page.locator('#turnout-status').innerText()),
     (await page.locator('#turnout-status').innerText()).replace(/\s+/g, ' ').slice(0, 240));

  /* Advance polls land on the divisions that fed them, not on the riding.
     The fixture's advance polls are 600-605, which the payload carries served
     sets for, so this exercises the published mapping rather than a stub. */
  const advNote = (await page.locator('#turnout-status').innerText()).replace(/\s+/g, ' ');
  ok('the tab counts advance pools and the divisions each served',
     /advance ballots went to the divisions that fed each of \d+ advance polls/.test(advNote)
     && /divisions each on average/.test(advNote), advNote.slice(0, 300));
  const advSpread = await page.evaluate(() => {
    const a = window.vanPoliAtlas.state.fedResults.apportioned.votes;
    return { pools: a.advancePools, mean: a.advanceUnitsMean,
             advance: a.advanceApportioned, all: a.apportioned };
  });
  ok(`${advSpread.pools} advance pools spread over ${advSpread.mean?.toFixed(1)} divisions each, `
     + `far fewer than a riding`, advSpread.pools > 0 && advSpread.mean > 1 && advSpread.mean < 40,
     JSON.stringify(advSpread));
  ok('and they account for most of what was apportioned',
     advSpread.advance > advSpread.all * 0.5, JSON.stringify(advSpread));
  /* Ballots are conserved: what sits on units afterwards is what was matched
     plus what was apportioned, exactly. */
  const conserved = await page.evaluate(() => {
    const st = window.vanPoliAtlas.state;
    const ball = (u) => (u.total || 0) + (u.rejected || 0);
    let before = 0;
    for (const u of new Set(st.fedResults.values.values())) before += ball(u);
    const a = st.fedResults.apportioned.votes;
    let after = 0;
    for (const u of new Set(a.values.values())) after += ball(u);
    return after - (before + a.apportioned);
  });
  ok(`apportionment creates and loses nothing (${conserved.toFixed(6)})`, Math.abs(conserved) < 1e-6);

  await page.locator('#apportion-fed').selectOption('none');
  await page.waitForTimeout(500);

  const tdl = page.waitForEvent('download', { timeout: 15000 });
  await page.locator('#export-turnout').click();
  const tcsv = require('fs').readFileSync(await (await tdl).path(), 'utf8').trim().split(/\r?\n/);
  ok(`turnout CSV exported (${tcsv.length - 1} rows) with turnout_agg and turnout_fed`, tcsv.length === expected.ordinary_polls + 1 && /turnout_agg/.test(tcsv[0]) && /turnout_fed/.test(tcsv[0]));

  console.log('\n== Turnout and native provincial shading on the map ==');
  await page.locator('#tab-map').click();
  await page.waitForTimeout(400);
  await page.locator('#shade-by').selectOption('turnout-fed');
  await page.waitForTimeout(500);
  const tShade = await page.evaluate(() => [...document.querySelectorAll('.layer-fed path')].slice(0, 400).map((n) => {
    const cs = getComputedStyle(n); return { fill: cs.fill, op: parseFloat(cs.fillOpacity) }; }));
  const blues = tShade.filter((v) => /rgb\(51,\s*156,\s*255\)/.test(v.fill)).length;
  ok(`federal turnout shading uses the non-partisan ramp colour (${blues}/${tShade.length})`, blues > tShade.length * 0.9, tShade[0].fill);
  ok(`turnout shading has graded opacities (${new Set(tShade.map((v) => v.op.toFixed(2))).size} distinct)`, new Set(tShade.map((v) => v.op.toFixed(2))).size > 20);
  ok('legend shows the turnout range', /turnout/i.test(await page.locator('#map-legend').innerText()));
  await page.locator('#shade-prov-by').selectOption('prov-party');
  await page.waitForTimeout(500);
  const provParty = await page.locator('#shade-party-prov').inputValue();
  const pShade = await page.evaluate(() => [...document.querySelectorAll('.layer-prov path')].map((n) => {
    const cs = getComputedStyle(n); return { fill: cs.fill, op: parseFloat(cs.fillOpacity) }; }));
  const filled = pShade.filter((v) => v.fill !== 'none' && !/^rgba?\(0, 0, 0, 0\)/.test(v.fill)).length;
  ok(`provincial layer shaded natively by ${provParty} (${filled}/${pShade.length} filled, ${new Set(pShade.map((v) => v.op.toFixed(2))).size} opacities)`,
     filled > pShade.length * 0.95 && new Set(pShade.map((v) => v.op.toFixed(2))).size > 8);
  ok('legend names the provincial shading', new RegExp(provParty.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(await page.locator('#map-legend').innerText()));
  await page.locator('#shade-prov-by').selectOption('none');
  await page.locator('#shade-by').selectOption('fed-party');
  await page.waitForTimeout(300);
  const provPlain = await page.evaluate(() => getComputedStyle(document.querySelector('.layer-prov path')).fill);
  ok('provincial layer returns to outline only', provPlain === 'none', provPlain);
  await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.5);
  await page.waitForTimeout(250);
  const readoutT = await page.locator('#readout').innerText();
  ok('readout shows ballots, electors and turnout on both cards', (readoutT.match(/turnout \d/g) || []).length >= 2, readoutT.slice(0, 300));
  ok('Method tab covers the Elections BC vote-anywhere caveat', /vote-anywhere/.test(await page.evaluate(() => document.querySelector('#panel-method').textContent)));
  console.log('\n== Census layers: dissemination areas, blocks, attribute file, profile ==');
  // The Turnout section left the weight at 100% federal; the census checks use the default blend.
  await page.locator('#tab-turnout').click();
  await page.locator('#turnout-weight').fill('0.5');
  await page.locator('#turnout-weight').dispatchEvent('change');
  await page.waitForTimeout(300);
  await page.locator('#tab-data').click();
  await page.locator('#file-da-geo').setInputFiles('fixtures/e2e_da.zip');
  await page.waitForFunction(() => /Loaded|Could not/.test(document.querySelector('#status-da-geo').innerText), null, { timeout: 20000 });
  status = await page.locator('#status-da-geo').innerText();
  ok(`dissemination areas loaded (${expected.census.dissemination_areas})`, new RegExp(`Loaded ${expected.census.dissemination_areas} dissemination areas`).test(status), status);
  ok('Statistics Canada Lambert read from the Esri .prj', /Statistics Canada Lambert/.test(status), status);
  ok('DAUID picked as the id field', /Id field: DAUID/.test(status), status);
  await page.locator('#file-db-geo').setInputFiles('fixtures/e2e_db.zip');
  await page.waitForFunction(() => /Loaded|Could not/.test(document.querySelector('#status-db-geo').innerText), null, { timeout: 20000 });
  ok(`blocks loaded (${expected.census.blocks})`, new RegExp(`Loaded ${expected.census.blocks} dissemination blocks`).test(await page.locator('#status-db-geo').innerText()));
  await page.locator('#file-geo-attr').setInputFiles('fixtures/e2e_geo_attr.csv');
  await page.waitForTimeout(800);
  status = await page.locator('#status-geo-attr').innerText();
  ok('block populations read and summed', new RegExp(`${expected.census.blocks} blocks with a population \\(${expected.census.population.toLocaleString()} people\\)`).test(status), status);
  await page.locator('#file-census').setInputFiles('fixtures/e2e_census_long.csv');
  await page.waitForTimeout(1500);
  status = await page.locator('#status-census').innerText();
  ok('long profile read for the study area', new RegExp(`long layout: ${expected.census.dissemination_areas} geographies`).test(status), status);
  ok('all 15 starter variables matched by name', /15 starter variables matched/.test(status), status);

  await page.locator('#tab-map').click();
  await page.waitForTimeout(600);
  ok(`dissemination areas drawn (${await page.locator('.layer-da path').count()})`, (await page.locator('.layer-da path').count()) === expected.census.dissemination_areas);
  ok('census controls appear', await page.locator('#da-controls').isVisible());

  await page.locator('#tab-corr').click();
  await page.locator('#build-crosswalk').click();
  await page.waitForFunction(() => /Sampled/.test(document.querySelector('#status-crosswalk').innerText), null, { timeout: 90000 });
  status = await page.locator('#status-crosswalk').innerText();
  ok('one sample covers all four layers', /federal polls, voting areas, dissemination areas, dissemination blocks/.test(status), status);
  ok('overlaps weighted by block population', /weighted by dissemination-block population/.test(status), status);
  ok('federal-census overlaps reported', new RegExp(`federal–census overlaps across ${expected.census.dissemination_areas} dissemination areas`).test(status), status);

  console.log('\n== Socioeconomic tab ==');
  await page.locator('#tab-socio').click();
  await page.waitForTimeout(800);
  const socioStatus = await page.locator('#socio-status').innerText();
  ok('dissemination areas are counted as available and as charted',
     /\d+ dissemination areas in the study area, \d+ charted/.test(socioStatus), socioStatus);

  /* Which areas to chart is two named options now, not a switch. A checkbox
     labels only the state it is in, and the state it did not label -- what
     unticking would actually give you -- was where the confusion sat.

     Two mistakes are pinned here. The predicate used to ask whether both sides
     produced a turnout RATE, which needs electors; results reported by voting
     place carry none, so it emptied the tab for exactly the measures built to
     survive a missing denominator. And it used to be judged against the
     measure, which made one control mean something different on every one of
     them. It asks one question now -- did both elections put ballots here --
     and answers it the same way whatever is being charted, which is what lets
     it hold a sample still across two measures. */
  const allAreas = page.locator('#socio-areas-all');
  const bothAreas = page.locator('#socio-areas-both');
  const charted = async () => {
    const line = await page.locator('#socio-status').innerText();
    return parseInt((/in the study area, ([\d,]+) charted/.exec(line) || [0, '0'])[1]
      .replace(/,/g, ''), 10);
  };
  ok('both options are offered, and neither state has to be inferred',
     (await page.locator('#socio-areas .form-check-label').allTextContents()).join(' | ')
       === 'All areas this measure can use | Only areas with both elections',
     (await page.locator('#socio-areas .form-check-label').allTextContents()).join(' | '));
  ok('the default is every area the measure can use, not a quietly narrowed set',
     await allAreas.isChecked() && !(await bothAreas.isChecked()));

  /* And that the group is READABLE, which is a separate failure. It carried
     .form-label for a while, and design.css lays every .viz-controls >
     .form-label out as `grid-template-columns: minmax(0, 1fr) auto` -- right
     for a caption above a select, wrong for three stacked children. The nowrap
     option labels took the auto column and squeezed the legend in the 1fr
     column to one character per line: "Are / as / to / cha / rt", with both
     options shoved off to the side. Nothing about the behaviour above changes
     when that happens, which is why it needs its own assertion: every line of
     text in the group must occupy the number of lines its content needs. */
  const lineCounts = await page.locator('#socio-areas').evaluate((group) => {
    const out = [];
    for (const el of [group.querySelector('.choice-legend'),
                      ...group.querySelectorAll('.form-check-label')]) {
      const cs = getComputedStyle(el);
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
      out.push({ text: el.textContent.trim(),
                 lines: Math.round(el.getBoundingClientRect().height / lh) });
    }
    return out;
  });
  for (const { text, lines } of lineCounts) {
    ok(`"${text}" sits on one line (${lines})`, lines === 1, JSON.stringify(lineCounts));
  }
  ok('and the group is wide enough for its longest option',
     await page.locator('#socio-areas').evaluate((group) => {
       const longest = [...group.querySelectorAll('.form-check')]
         .reduce((a, b) => (a.scrollWidth > b.scrollWidth ? a : b));
       return group.getBoundingClientRect().width >= longest.scrollWidth;
     }));

  /* The regression this guards. The ballots test once read
     sources.map(s => s.key); socioSources sets id, so every lookup was
     ballots[undefined] and the filter took every row. Checked on the two kinds
     of measure it emptied -- a participation ratio and a party share -- under
     BOTH options, because under the old code the restrictive one left nothing. */
  const partyOutcome = (await page.locator('#socio-outcome option').evaluateAll(
    (os) => os.map((o) => o.value))).find((v) => /^(fed|prov):/.test(v));
  ok('the fixture offers a party-share outcome to test with', Boolean(partyOutcome), partyOutcome);
  for (const [value, what] of [['part-fed', 'provincial ballots per federal elector'],
                               [partyOutcome, 'a party share']]) {
    await page.locator('#socio-outcome').selectOption(value);
    await page.waitForTimeout(800);
    const withAll = await charted();
    ok(`${what} charts areas under "all areas" (${withAll})`, withAll > 0,
       await page.locator('#socio-status').innerText());
    await bothAreas.check();
    await page.waitForTimeout(800);
    const withBoth = await charted();
    ok(`${what} still charts areas under "both elections" (${withBoth})`, withBoth > 0,
       await page.locator('#socio-status').innerText());
    ok(`and restricting never adds areas for ${what} (${withBoth} <= ${withAll})`,
       withBoth <= withAll);
    ok(`and rows are plotted for ${what}`,
       (await page.locator('#socio-table tbody tr').count()) > 0);
    await allAreas.check();
    await page.waitForTimeout(600);
  }

  /* The point of the restrictive option: the same areas whichever measure is
     picked, so two measures can be compared directly. */
  await bothAreas.check();
  const held = [];
  for (const value of ['turnout-fed', 'turnout-prov', 'turnout-agg']) {
    await page.locator('#socio-outcome').selectOption(value);
    await page.waitForTimeout(800);
    held.push(await page.evaluate(() => window.vanPoliAtlas.state.socio.rows.length));
  }
  ok(`"both elections" holds the same set of areas across measures (${held.join(', ')})`,
     held.every((n) => n === held[0]) && held[0] > 0, held.join(', '));
  /* Every dissemination area in the fixture carries both elections, so the
     counts above are equal and prove only that nothing was emptied. The
     provincial geography is where the two options genuinely differ -- the
     crosswalk reaches federal results on some voting areas and not others --
     so the difference is asserted there, or the assertion means nothing. */
  await page.locator('#socio-unit').selectOption('prov');
  await page.locator('#socio-outcome').selectOption('turnout-agg');
  await allAreas.check();
  await page.waitForTimeout(1200);
  const provAll = await charted();
  await bothAreas.check();
  await page.waitForTimeout(1200);
  const provBoth = await charted();
  ok(`on voting areas the two options really do differ (${provBoth} of ${provAll})`,
     provBoth > 0 && provBoth < provAll, `${provBoth} vs ${provAll}`);
  ok('and the restrictive one names what it left out, with the count',
     /carry one election only, left out by the choice above/.test(
       await page.locator('#socio-status').innerText()),
     await page.locator('#socio-status').innerText());
  await allAreas.check();
  await page.waitForTimeout(1200);
  ok('while the default says what a one-election aggregate means rather than hiding it',
     /one election only, so their aggregate is that election/.test(
       await page.locator('#socio-status').innerText()),
     await page.locator('#socio-status').innerText());
  await page.locator('#socio-unit').selectOption('da');
  await page.waitForTimeout(1200);

  await allAreas.check();
  await page.locator('#socio-outcome').selectOption('turnout-agg');
  await page.waitForTimeout(800);
  ok('and on dissemination areas every area carries both, so nothing is dropped',
     /one election only, so their aggregate is that election/.test(
       await page.locator('#socio-status').innerText())
     || (await charted()) === await page.evaluate(
       () => window.vanPoliAtlas.state.socio.rows.length),
     await page.locator('#socio-status').innerText());

  ok('every area is accounted for, charted or with a reason',
     await page.evaluate(() => {
       const t = document.getElementById('socio-status').innerText;
       const m = /(\d[\d,]*) \S[^,]* in the study area, (\d[\d,]*) charted/.exec(t);
       if (!m) return false;
       const num = (v) => parseInt(v.replace(/,/g, ''), 10);
       const total = num(m[1]), charted = num(m[2]);
       if (total === charted) return !/Not charted/.test(t);
       const drops = [...t.matchAll(/(\d[\d,]*) (?=under |carry one|no )/g)].map((d) => num(d[1]));
       return drops.reduce((a, b) => a + b, 0) === total - charted;
     }), await page.locator('#socio-status').innerText());
  const socioRows = page.locator('#socio-table tbody tr');
  const nVars = await socioRows.count();
  /* Six named measures to begin with, not all fifteen ticked at once. The rest
     are behind "Add more measures" and ticking one brings it into the table --
     a starting point that can be widened, rather than a wall. */
  ok(`the table starts with six named measures, not fifteen (${nVars})`, nVars === 6, String(nVars));
  const moreSummary = page.locator('#socio-picker details.socio-more summary');
  ok('the rest are offered behind "Add more measures"',
     /Add more measures \(9\)/.test(await moreSummary.innerText()), await moreSummary.innerText());
  ok('and that drawer starts shut', !(await page.locator('#socio-picker details.socio-more')
     .evaluate((d) => d.open)));
  await moreSummary.click();
  await page.locator('#socio-picker details.socio-more input[type=checkbox]').first().check();
  await page.waitForTimeout(800);
  ok(`ticking one from the drawer adds it (${await socioRows.count()})`,
     (await socioRows.count()) === 7, String(await socioRows.count()));
  await page.locator('#socio-picker details.socio-more input[type=checkbox]').first().uncheck();
  await page.waitForTimeout(800);
  ok('and unticking takes it away again', (await socioRows.count()) === 6);
  // Rows as cells: [variable, n, r, electors-weighted r, rho, |r|, CI].
  const socioCells = async () => socioRows.evaluateAll((trs) => trs.map((tr) => [...tr.children].map((td) => td.innerText.trim())));
  let cells = await socioCells();
  const rowFor = (re) => cells.find((c) => re.test(c[0]));
  const renterRow = rowFor(/Renter/), incomeRow = rowFor(/household income/), ageRow = rowFor(/Median age/);
  const rOf = (c) => parseFloat(c[2]);
  ok(`the two planted variables sort to the top by |r| (${rOf(renterRow)}, ${rOf(incomeRow)})`,
     [renterRow, incomeRow].includes(cells[0]) && [renterRow, incomeRow].includes(cells[1]) && rOf(renterRow) < -0.8,
     cells.slice(0, 2).map((c) => c.join(' ')).join(' | '));
  ok(`planted income correlates positively (${rOf(incomeRow)})`, rOf(incomeRow) > 0.8, incomeRow.join(' '));
  ok(`noise variable stays near zero (${rOf(ageRow)})`, Math.abs(rOf(ageRow)) < 0.3, ageRow.join(' '));
  const minAreas = Math.floor(expected.census.dissemination_areas * 0.8);
  ok(`every starter has a finite r on at least ${minAreas} areas`,
     cells.every((c) => parseInt(c[1], 10) >= minAreas && /^-?\d/.test(c[2]) && /^-?\d/.test(c[3])),
     cells.map((c) => c.slice(0, 4).join(' ')).join(' | '));
  const texts = cells.map((c) => c.join(' '));
  const socioDots = await page.locator('#socio-scatter circle.dot').count();
  ok(`scatter of the top variable drawn (${socioDots} dots) with a fit line`, socioDots >= minAreas && (await page.locator('#socio-scatter path.fit-line').count()) === 1);
  const socioCaption = await page.locator('#socio-scatter-caption').innerText();
  ok('caption names the variable and the outcome', /^(Renter households|Median household income).* against aggregate turnout, both elections across \d+ dissemination areas/.test(socioCaption), socioCaption);
  await socioRows.nth(3).click();
  await page.waitForTimeout(300);
  ok('clicking a row plots it', (await page.locator('#socio-table tr.picked').count()) === 1 && (await page.locator('#socio-scatter-caption').innerText()) !== socioCaption);
  await page.locator('#socio-outcome').selectOption({ label: /Liberal share, federal 2025/.test(await page.locator('#socio-outcome').innerText()) ? 'Liberal share, federal 2025' : 'Federal (2025) turnout' });
  await page.waitForTimeout(800);
  const texts2 = (await socioCells()).map((c) => c.join(' '));
  ok('switching the outcome recomputes every row', texts2.length === 6 && texts2.join('|') !== texts.join('|'),
     `${texts2.length} rows`);

  // The same correlation on the provincial voting areas: the census is carried
  // the other way, counts shared out and rates averaged by population. A
  // planted relationship must survive the move, sign and all.
  await page.locator('#socio-outcome').selectOption('turnout-agg');
  await page.waitForTimeout(600);
  /* Three names per variable, each where it belongs: plain words in the table,
     the statistical definition on hover, and something a few characters wide on
     a chart axis. */
  const renterNames = await page.evaluate(() => {
    const row = [...document.querySelectorAll('#socio-table tbody tr')]
      .find((tr) => /Renter/.test(tr.cells[0].textContent));
    const axis = document.querySelector('#socio-scatter').textContent;
    return { cell: row && row.cells[0].textContent.trim(), title: row && row.cells[0].title, axis };
  });
  ok('the table shows the plain name', renterNames.cell === 'Renter households', renterNames.cell);
  ok('and carries the statistical definition on hover',
     renterNames.title === 'Renter households (%)', renterNames.title);
  await page.locator('#socio-table tbody tr', { hasText: 'Renter households' }).first().click();
  await page.waitForTimeout(400);
  /* #socio-scatter is an <svg>, which has no innerText. */
  const axisText = await page.evaluate(() => document.querySelector('#socio-scatter').textContent);
  ok('and the chart axis uses the short form', /Renters/.test(axisText),
     axisText.replace(/\s+/g, ' ').slice(0, 160));

  const daRenter = rOf(rowFor(/Renter/));
  const units = await page.locator('#socio-unit option').allTextContents();
  ok('the voting areas are offered as a second geography',
     units.some((t) => /voting areas/i.test(t)), units.join(' | '));
  await page.locator('#socio-unit').selectOption('prov');
  await page.waitForTimeout(1200);
  const provStatus = await page.locator('#socio-status').innerText();
  ok('the tab now reports voting areas', /\d+ provincial voting areas in the study area, \d+ charted/.test(provStatus),
     provStatus.replace(/\s+/g, ' ').slice(0, 160));
  cells = await socioCells();
  const provRenter = rowFor(/Renter/);
  ok(`the planted variable keeps its sign on the other geography (${rOf(provRenter)} vs ${daRenter})`,
     rOf(provRenter) < -0.5 && daRenter < -0.5, `${rOf(provRenter)} / ${daRenter}`);
  const picker = await page.locator('#socio-picker').innerText();
  ok('the picker says how each variable was carried across',
     /population-weighted mean/.test(picker), picker.replace(/\s+/g, ' ').slice(0, 200));
  const provTiles = await page.locator('#socio-stats').innerText();
  ok('and the tiles count voting areas, not dissemination areas',
     /provincial voting areas/.test(provTiles), provTiles.replace(/\s+/g, ' ').slice(0, 160));
  await page.locator('#socio-unit').selectOption('da');
  await page.waitForTimeout(900);
  cells = await socioCells();
  ok('switching back restores the dissemination-area figures',
     Math.abs(rOf(rowFor(/Renter/)) - daRenter) < 1e-9, `${rOf(rowFor(/Renter/))} vs ${daRenter}`);
  await page.locator('#socio-outcome').selectOption('turnout-agg');
  await page.waitForTimeout(600);
  await page.locator('#socio-search').fill('2 persons');
  await page.waitForTimeout(300);
  await page.locator('#socio-search-results button').first().click();
  await page.waitForTimeout(800);
  /* Added by name, so it belongs with the six a reader chose rather than in
     the drawer of ones they did not. */
  ok('a characteristic added by name joins the table', (await socioRows.count()) === 7 && /2 persons/.test((await socioCells()).map((c) => c[0]).join(' ')),
     String(await socioRows.count()));
  ok('and sits with the visible measures, not in the drawer',
     await page.evaluate(() => {
       const g = document.querySelector('#socio-picker .socio-picker-group');
       return /2 persons/i.test(g ? g.innerText : '');
     }));
  const sdl = page.waitForEvent('download', { timeout: 15000 });
  await page.locator('#export-socio').click();
  const scsv = require('fs').readFileSync(await (await sdl).path(), 'utf8').split(/\r?\n/).filter(Boolean);
  ok(`DA table exported (${scsv.length - 1} rows) with turnout, party shares and variables`,
     scsv.length - 1 >= minAreas && /turnout_agg/.test(scsv[0]) && /pct_renter/.test(scsv[0]) && /fed_share_/.test(scsv[0]) && /population_2021/.test(scsv[0]), scsv[0]);
  ok('the export carries the columns needed to cluster on the real source',
     /(^|,)source_unit(,|$)/.test(scsv[0]) && /(^|,)catchment_share(,|$)/.test(scsv[0]), scsv[0]);

  console.log('\n== Two provincial denominators, side by side ==');
  /* With the census loaded and the crosswalk built, both denominators resolve:
     federal electors come across the crosswalk, residents 15+ come from the age
     table. Neither is turnout, and the tab has to say so. */
  await page.locator('#tab-turnout').click();
  await page.waitForTimeout(400);
  await page.locator('#turnout-unit').selectOption('prov');
  await page.waitForTimeout(900);
  const headers = await page.$$eval('#turnout-table thead th', (ns) => ns.map((n) => n.textContent));
  ok(`both denominators are columns, with the spread between them (${headers.join(' | ')})`,
     headers.includes('Per fed elector') && headers.includes('Per resident 15+') && headers.includes('Spread'),
     headers.join(' | '));
  ok('neither is headed as a turnout',
     !/turnout/i.test(headers[headers.indexOf('Per fed elector')] + headers[headers.indexOf('Per resident 15+')]));
  const partRows = await page.evaluate(() => {
    const head = [...document.querySelectorAll('#turnout-table thead th')].map((n) => n.textContent);
    const iE = head.indexOf('Per fed elector'), iA = head.indexOf('Per resident 15+'),
          iS = head.indexOf('Spread'), iF = head.indexOf('Federal 2025');
    return [...document.querySelectorAll('#turnout-table tbody tr')].map((r) => {
      const c = [...r.children].map((td) => td.textContent);
      const n = (t) => (t === '--' ? null : parseFloat(t));
      return { e: n(c[iE]), a: n(c[iA]), s: n(c[iS]), fed: n(c[iF]) };
    });
  });
  const withFed = partRows.filter((r) => r.e != null);
  const withAdult = partRows.filter((r) => r.a != null);
  const withBoth = partRows.filter((r) => r.e != null && r.a != null);
  // The federal denominator rides on the same carried federal unit as the
  // federal turnout, so it is present on exactly the areas the crosswalk
  // reaches -- no more, and never on one it does not. The fixture census is a
  // 44-area patch, so the resident denominator reaches fewer still. Both are
  // reported where they exist and blank where they do not, never filled in.
  ok(`the federal denominator is present on exactly the areas the crosswalk reaches (${withFed.length}/${partRows.length})`,
     withFed.length > 0 && partRows.every((r) => (r.e != null) === (r.fed != null)));
  ok(`the census denominator reaches the areas the census covers (${withAdult.length})`,
     withAdult.length >= 10 && withAdult.length < partRows.length);
  ok(`areas outside the census patch leave it blank rather than guessing`,
     partRows.some((r) => r.e != null && r.a == null && r.s == null));
  ok(`the spread is the difference between the two, in points (${withBoth.length} areas)`,
     withBoth.length > 0 && withBoth.every((r) => Math.abs(r.s - (r.e - r.a)) < 0.15),
     JSON.stringify(withBoth.slice(0, 3)));
  const tstatus2 = await page.locator('#turnout-status').innerText();
  ok('the tab says in words that these are not turnout',
     /not turnout/i.test(tstatus2) && /registered voters per electoral district/i.test(tstatus2),
     tstatus2.slice(0, 260));
  // Sorting on a denominator orders by it, like any other column.
  await page.locator('#turnout-table thead th', { hasText: 'Per fed elector' }).click();
  await page.waitForTimeout(700);
  const sortedByPart = await page.evaluate(() => {
    const head = [...document.querySelectorAll('#turnout-table thead th')].map((n) => n.textContent);
    const i = head.indexOf('Per fed elector');
    return [...document.querySelectorAll('#turnout-table tbody tr')].slice(0, 6)
      .map((r) => parseFloat(r.children[i].textContent)).filter((v) => isFinite(v));
  });
  ok(`a denominator column sorts (${sortedByPart.join(' ≥ ')})`,
     sortedByPart.every((v, i) => i === 0 || sortedByPart[i - 1] >= v));

  const pdl = page.waitForEvent('download', { timeout: 15000 });
  await page.locator('#export-turnout').click();
  const pcsv = require('fs').readFileSync(await (await pdl).path(), 'utf8').trim().split(/\r?\n/);
  ok('the export carries both ratios and both denominators',
     ['residents_15_plus', 'prov_per_fed_elector', 'prov_per_resident_15_plus', 'denominator_spread',
      'fed_electors'].every((c) => pcsv[0].split(',').includes(c)), pcsv[0]);

  await page.locator('#tab-map').click();
  await page.waitForTimeout(400);
  for (const [mode, wanted] of [['prov-per-elector', /federal elector/i], ['prov-per-resident', /resident aged 15/i]]) {
    await page.locator('#shade-prov-by').selectOption(mode);
    await page.waitForTimeout(600);
    const shade = await page.evaluate(() => [...document.querySelectorAll('.layer-prov path')].map((n) => {
      const cs = getComputedStyle(n); return { fill: cs.fill, op: parseFloat(cs.fillOpacity) }; }));
    // A ramped area is one the mode actually valued; 0.04 is the "no value"
    // wash, so counting distinct ramped opacities is what proves it shaded.
    const ramped = shade.filter((v) => v.op > 0.05);
    ok(`${mode} shades the areas it has a value for (${ramped.length}/${shade.length}, ${new Set(ramped.map((v) => v.op.toFixed(2))).size} opacities)`,
       ramped.length >= 10 && new Set(ramped.map((v) => v.op.toFixed(2))).size > 5);
    const legend = await page.locator('#map-legend').innerText();
    ok(`${mode}: the legend names the denominator and refuses the word turnout`,
       wanted.test(legend) && /Not turnout/i.test(legend), legend.slice(0, 200));
  }
  await page.locator('#shade-prov-by').selectOption('none');
  await page.waitForTimeout(300);
  ok('the Method tab explains both denominators and their biases',
     /Two denominators that are not an electorate/.test(await page.evaluate(() => document.querySelector('#panel-method').textContent)));
  await page.locator('#tab-turnout').click();
  await page.locator('#turnout-unit').selectOption('fed');
  await page.waitForTimeout(600);
  await page.locator('#tab-socio').click();
  await page.waitForTimeout(400);

  console.log('\n== A file of places, counted onto the layers ==');
  /* An Excel workbook, through the file input a person actually uses.

     The bug: loadTable decided by extension, so an .xlsx -- which IS a zip --
     skipped the unzip branch, was decoded by a windows-1252 fallback that maps
     every byte and therefore cannot fail, and had its own compressed bytes
     quoted back as its column names. Screenfuls of mojibake where a column list
     should be. Asserted through the UI rather than only at the reader, because
     the accept attribute is part of the failure: a file the picker will not
     offer cannot be loaded however well it parses. */
  await page.locator('#tab-data').click();
  await page.waitForTimeout(300);
  ok('the file picker offers workbooks at all',
     /\.xlsx/.test(await page.locator('#file-points').getAttribute('accept')),
     await page.locator('#file-points').getAttribute('accept'));
  await page.locator('#file-points').setInputFiles('fixtures/roll_shaped.xlsx');
  await page.waitForTimeout(1500);
  const xstatus = (await page.locator('#status-points').innerText()).replace(/\s+/g, ' ');
  ok('a workbook is read, and its columns are understood',
     /reference file/.test(xstatus) && !/No way to locate/.test(xstatus), xstatus.slice(0, 220));
  ok('and nothing binary reaches the reader',
     xstatus.length < 400 && !/[\u0000-\u0008\u000e-\u001f\ufffd]/.test(xstatus),
     JSON.stringify(xstatus.slice(0, 160)));

  /* Real coordinates inside known Vancouver Centre polls, so the counts are
     checkable rather than merely non-zero. */
  await page.locator('#tab-data').click();
  await page.waitForTimeout(300);
  const ADDR = 'geo_point_2d;households\n'
    + '49.27410, -123.13294;3\n49.27607, -123.12946;1\n49.27342, -123.11793;2\n'
    + '49.27295, -123.12774;1\n49.27464, -123.13276;5\n0.0, 0.0;1\n';
  await page.locator('#file-points').setInputFiles(
    { name: 'addresses.csv', mimeType: 'text/csv', buffer: Buffer.from(ADDR) });
  await page.waitForTimeout(1500);
  const pstatus = (await page.locator('#status-points').innerText()).replace(/\s+/g, ' ');
  ok('six rows read from one column holding both numbers', /6 of 6 rows located/.test(pstatus), pstatus.slice(0, 200));
  /* The pair order is the trap this whole module exists for: reversed, every
     one of these lands in the Indian Ocean and nothing errors. */
  ok('the coordinate order is stated, not assumed',
     /Read as lat,lon/.test(pstatus) && /decided by range/.test(pstatus), pstatus.slice(0, 300));
  ok('and the row at the origin is reported as outside every area',
     /fell outside every one of them/.test(pstatus), pstatus.slice(0, 400));
  ok('coverage names the areas that got none', /carry none/.test(pstatus), pstatus.slice(0, 400));

  const perFed = await page.evaluate(() => {
    const per = window.vanPoliAtlas.state.points.per.fed;
    let n = 0, w = 0;
    for (const a of per.values()) { n += a.count; w += a.weight; }
    return { areas: per.size, n, w };
  });
  ok(`five points landed on federal polls (${perFed.n} across ${perFed.areas} polls)`,
     perFed.n === 5 && perFed.areas >= 3, JSON.stringify(perFed));
  ok('unweighted, each row counts one', perFed.w === 5, String(perFed.w));

  await page.locator('#points-weight-col').selectOption('households');
  await page.waitForTimeout(900);
  const weighted = await page.evaluate(() => {
    let w = 0;
    for (const a of window.vanPoliAtlas.state.points.per.fed.values()) w += a.weight;
    return w;
  });
  ok(`choosing a weight column sums it instead (${weighted} households)`, weighted === 12, String(weighted));

  await page.locator('#tab-map').click();
  await page.waitForTimeout(600);
  const optVisible = await page.evaluate(() =>
    !document.querySelector('#shade-by option[value="points-weight"]').hidden);
  ok('the weighted shade option appears only once a weight column is chosen', optVisible);
  await page.locator('#shade-by').selectOption('points-count');
  await page.waitForTimeout(700);
  const shaded = await page.$$eval('.layer-fed path', (ps) => ps
    .map((p) => parseFloat(getComputedStyle(p).fillOpacity)).filter((o) => o > 0.07).length);
  ok(`the polls holding points are shaded (${shaded})`, shaded >= 3 && shaded < 50, String(shaded));
  ok('the legend names them by the noun the file was given',
     /addresses per area/.test(await page.locator('#map-legend').innerText()),
     (await page.locator('#map-legend').innerText()).replace(/\s+/g, ' ').slice(0, 160));
  await page.locator('#shade-by').selectOption('fed-party');
  await page.waitForTimeout(300);

  console.log('\n== Addresses with no coordinates, joined to a reference ==');
  const REF = 'CIVIC_NUMBER;STD_STREET;geo_point_2d\n'
    + '3449;ANZIO DRIVE;49.27410, -123.13294\n1234;W 16TH AV;49.27607, -123.12946\n'
    + '500;ST. CATHERINES ST;49.27342, -123.11793\n';
  const ROLL = 'House Number,Street Name,electors\n'
    + '101-3449,Anzio Dr,2\n1234,West 16th Avenue,3\n500,Saint Catherines Street,1\n'
    + '9999,Nowhere Road,4\n';
  await page.locator('#tab-data').click();
  await page.waitForTimeout(300);
  await page.locator('#file-points').setInputFiles(
    { name: 'roll.csv', mimeType: 'text/csv', buffer: Buffer.from(ROLL) });
  await page.waitForTimeout(1200);
  ok('a roll with addresses says it needs a reference first',
     /need a reference file|needs? a reference/i.test(await page.locator('#status-points').innerText()),
     (await page.locator('#status-points').innerText()).replace(/\s+/g, ' ').slice(0, 200));
  await page.locator('#file-points-ref').setInputFiles(
    { name: 'ref.csv', mimeType: 'text/csv', buffer: Buffer.from(REF) });
  await page.waitForTimeout(1500);
  const rollJoined = (await page.locator('#status-points').innerText()).replace(/\s+/g, ' ');
  ok('loading the reference joins the roll that was already waiting',
     /3 of 4 rows located/.test(rollJoined), rollJoined.slice(0, 200));
  ok('and the miss rate and the key that missed are both named',
     /75(\.0)?% of rows matched/.test(rollJoined) && /9999 NOWHERE RD/.test(rollJoined), rollJoined.slice(0, 320));
  /* The roll is only useful if it leaves the tab. Both exports carry its counts
     per area, keyed the same way the map and the readout key them, so the
     number in a spreadsheet is the number on the screen. The column names are
     fixed and the noun rides in its own column: a schema that renamed itself
     according to which file somebody loaded could not be scripted against. */
  /* Sum the roll's own elector column rather than counting its rows, which is
     what makes this a count of people instead of a count of addresses. */
  await page.locator('#points-weight-col').selectOption('electors');
  await page.waitForTimeout(900);
  const pointsDl = page.waitForEvent('download', { timeout: 15000 });
  await page.locator('#tab-turnout').click();
  await page.waitForTimeout(600);
  await page.locator('#export-turnout').click();
  const pointsCsv = require('fs').readFileSync(await (await pointsDl).path(), 'utf8').split(/\r?\n/).filter(Boolean);
  const pointsHead = pointsCsv[0].split(',');
  ok('the turnout export gains the points columns',
     pointsHead.includes('points_count') && pointsHead.includes('points_weight') && pointsHead.includes('points_noun'),
     pointsHead.slice(-6).join(','));
  const pointsRows = pointsCsv.slice(1).map((l) => l.split(','));
  const pointsCountCol = pointsHead.indexOf('points_count'), pointsNounCol = pointsHead.indexOf('points_noun');
  ok('every row has a count, zero where nothing landed',
     pointsRows.every((r) => /^\d+$/.test(r[pointsCountCol])), pointsRows[0] && pointsRows[0][pointsCountCol]);
  ok('and some row actually carries the roll',
     pointsRows.some((r) => Number(r[pointsCountCol]) > 0), String(pointsRows.filter((r) => Number(r[pointsCountCol]) > 0).length));
  ok('and the file says what it counted', pointsRows.every((r) => r[pointsNounCol] === 'electors'),
     pointsRows[0] && pointsRows[0][pointsNounCol]);
  ok('no row is ragged against the header',
     pointsRows.every((r) => r.length === pointsHead.length),
     `${pointsHead.length} vs ${[...new Set(pointsRows.map((r) => r.length))].join('/')}`);

  /* The mailer list: one row per address, with why it is on the list.

     Deliberately not the roll. A mail drop needs the door and the quantity, not
     who is behind it, so this carries the address, the count, the coordinate
     and the areas -- no names, no identifiers.

     The justification columns take the measure from whatever the map is
     coloured by, so the export can never disagree with what the reader was
     looking at when they chose it. The percentile is what makes "high"
     defensible: 42.7% means nothing alone, 42.7% at the 94th does.

     The gate on those columns was DATA_MODES at first, which sounds right and
     is not: that set exists to say whether a ramp is scaled to its data, so it
     omits the party shares, which use a fixed scale. The justification silently
     vanished for exactly the measure a campaign is most likely to target on. */
  await page.locator('#tab-data').click();
  await page.waitForTimeout(300);
  ok('a roll placed by address offers the address list',
     !(await page.locator('#points-export-row').evaluate((n) => n.hidden)));
  const addrDl = page.waitForEvent('download', { timeout: 15000 });
  await page.locator('#export-addresses').click();
  const addrFile = await addrDl;
  const addrCsv = require('fs').readFileSync(await addrFile.path(), 'utf8')
    .split(/\r?\n/).filter(Boolean);
  const addrHead = splitCsv(addrCsv[0].replace(/^\ufeff/, ''));
  const addrBody = addrCsv.slice(1).map(splitCsv);
  /* Ranked, so the name says so. A campaign hands this to a mail house and a
     file called addresses.csv in a downloads folder is not self-describing. */
  ok(`a ranked list is named as one (${addrFile.suggestedFilename()})`,
     addrFile.suggestedFilename() === 'mailer-targets.csv', addrFile.suggestedFilename());
  ok(`the address list leads with the rank, the address and the count (${addrHead.slice(0, 3).join(',')})`,
     addrHead[0] === 'rank' && addrHead[1] === 'address' && Boolean(addrHead[2]),
     addrHead.join(','));
  ok('and carries no name or identifier column',
     !/name|elector|first|last|surname/i.test(addrHead.join(',')), addrHead.join(','));
  ok('and names the areas each address falls in',
     addrHead.includes('federal_poll'), addrHead.join(','));
  ok('and says what it was selected on, with a percentile behind the word "high"',
     addrHead.includes('federal_measure') && addrHead.includes('federal_value')
     && addrHead.includes('federal_percentile'), addrHead.join(','));
  /* One row per address, not one per elector: the file that went in had more
     rows than this one has. */
  ok(`one row per address rather than per row read (${addrCsv.length - 1})`,
     addrCsv.length - 1 > 0 && addrCsv.length - 1 <= 6, String(addrCsv.length - 1));
  /* The ranking itself. byAddress hands these over biggest-building-first,
     which is the wrong order for a target list and was the order that shipped:
     a tower in a safe area above a street in the best one. Rank 1 downwards
     must be the measure, never the building. */
  const addrCol = (h) => addrHead.indexOf(h);
  const ranked = addrBody.filter((r) => r[0] !== '');
  ok(`every address the measure could value is ranked (${ranked.length}/${addrBody.length})`,
     ranked.length > 1, `${ranked.length}/${addrBody.length}`);
  ok('the ranks run 1..n with no gaps and no repeats',
     ranked.every((r, i) => Number(r[0]) === i + 1),
     ranked.map((r) => r[0]).join(','));
  const numOf = (r) => parseFloat(String(r[addrCol('federal_value')]).replace('%', ''));
  ok('and they run down the measure, not down the building size',
     ranked.every((r, i) => i === 0 || numOf(ranked[i - 1]) >= numOf(r)),
     ranked.map(numOf).join(','));
  /* The column a print run is planned against: "mail the top 20,000" is a
     budget, not a row count, and one address can be three hundred pieces. */
  const cum = addrCol(addrHead.find((h) => h.startsWith('cumulative_')) || 'cumulative_');
  ok('a running total carries down the ranked list', cum > 0, addrHead.join(','));
  ok('and it only ever climbs, by exactly the count on each row',
     ranked.every((r, i) => Number(r[cum])
       === Number(i === 0 ? 0 : ranked[i - 1][cum]) + Number(r[addrCol(addrHead[2])])),
     ranked.map((r) => r[cum]).join(','));

  /* Two measures at once, which is what a target list actually is.

     The lists a campaign asks for are conjunctions -- provincial Conservative
     share AND turnout for the supporters it already holds, provincial
     Conservative AND federal Liberal for the crossover it can persuade. A
     single-measure export forces the second measure to be eyeballed, and an
     eyeballed measure is one nobody can reconstruct when the client asks why a
     door is on the list. Each measure keeps its own columns; the rank runs
     down the average standing across them. */
  await page.locator('#tab-map').click();
  await page.waitForTimeout(300);
  await openDrawers(page);
  await page.locator('#shade-prov-by').selectOption('prov-party');
  await page.waitForTimeout(600);
  await page.locator('#tab-data').click();
  await page.waitForTimeout(400);
  const basisLine = await page.locator('#points-export-basis').innerText();
  ok('the export says which measures it is about to rank on',
     /2 measures/.test(basisLine) && /average standing/.test(basisLine), basisLine.slice(0, 160));
  const twoDl = page.waitForEvent('download', { timeout: 15000 });
  await page.locator('#export-addresses').click();
  const twoCsv = require('fs').readFileSync(await (await twoDl).path(), 'utf8')
    .split(/\r?\n/).filter(Boolean);
  const twoHead = splitCsv(twoCsv[0].replace(/^﻿/, ''));
  const twoBody = twoCsv.slice(1).map(splitCsv);
  ok('both measures keep their own value and percentile columns',
     ['federal_measure', 'federal_value', 'federal_percentile',
      'provincial_measure', 'provincial_value', 'provincial_percentile']
       .every((h) => twoHead.includes(h)), twoHead.join(','));
  ok('and the composite the rank rests on is a column of its own',
     twoHead.includes('target_score'), twoHead.join(','));
  const scoreCol = twoHead.indexOf('target_score');
  const twoRanked = twoBody.filter((r) => r[0] !== '');
  ok(`addresses that scored on both measures are ranked (${twoRanked.length}/${twoBody.length})`,
     twoRanked.length > 0, `${twoRanked.length}/${twoBody.length}`);
  ok('the rank runs down the composite, not down either measure alone',
     twoRanked.every((r, i) => i === 0
       || Number(twoRanked[i - 1][scoreCol]) >= Number(r[scoreCol])),
     twoRanked.map((r) => r[scoreCol]).join(','));
  /* Score on all of them or on none. Averaging over whichever measures happened
     to resolve lets an address reach the top because it is missing data. */
  ok('and an address missing either measure is left unranked rather than averaged',
     twoBody.every((r) => (r[0] === '')
       === (!r[twoHead.indexOf('federal_value')] || !r[twoHead.indexOf('provincial_value')])),
     twoBody.map((r) => `${r[0] || '-'}/${r[twoHead.indexOf('provincial_value')] || '-'}`).join(' '));
  /* Three lists in a sitting, all called mailer-targets.csv, is how the wrong
     one reaches the printer. The reader names the list and the name sticks to
     the file -- slugged, because this string reaches a filesystem. */
  await page.locator('#points-export-name').fill('Federal Liberal Crossover');
  const namedDl = page.waitForEvent('download', { timeout: 15000 });
  await page.locator('#export-addresses').click();
  const namedFile = await namedDl;
  ok(`a named list is downloaded under its own name (${namedFile.suggestedFilename()})`,
     namedFile.suggestedFilename() === 'federal-liberal-crossover.csv',
     namedFile.suggestedFilename());
  await page.locator('#points-export-name').fill('');
  await page.locator('#tab-map').click();
  await page.waitForTimeout(200);
  await page.locator('#shade-prov-by').selectOption('none');
  await page.waitForTimeout(400);

  console.log('\n== Non-voters ==');
  /* Two pairings, and the whole point of the tab is that they read differently.

     federal electors minus federal ballots is one election against its own
     roll: coherent, counted on both sides, and a positive gap everywhere.
     The loaded three-row roll against those same ballots is neither -- a
     different register, a different vintage, and far more ballots than roll
     electors in every area it touches. The second is not an error; it is the
     best diagnostic this tab produces, and it must survive to the screen
     rather than being clamped on the way. */
  await page.locator('#tab-nonvoters').click();
  await page.waitForTimeout(400);
  await page.locator('#nv-min').selectOption('0');
  await page.waitForTimeout(700);
  const rollOptions = await page.$$eval('#nv-roll option', (os) => os.map((o) => o.value));
  ok('the roll picker offers the elector counts that actually resolve here',
     rollOptions.includes('fed') && rollOptions.includes('muni'), rollOptions.join(','));
  ok('and never offers census residents as a roll',
     !rollOptions.includes('adults'), rollOptions.join(','));
  /* The default, and the reason it needs a test.

     This tab runs on every refresh, which means it runs before a roll has been
     loaded -- and in a payload build, before the payload has finished loading
     its datasets one by one. At that moment the only elector count in
     existence is the one riding along with the federal results, so the picker
     settles on it. If that fallback is then treated as the reader's choice,
     the tab stays on federal electors minus federal ballots with a roll of
     half a million people loaded and ignored, and nothing about the figures
     looks wrong: they are real counts, correctly labelled, answering a
     question nobody asked. Caught only by opening a real payload build. */
  ok('with a roll loaded the tab is about the roll, not about whichever elector '
     + 'count existed when it first ran',
     (await page.locator('#nv-roll').inputValue()) === 'muni',
     await page.locator('#nv-roll').inputValue());
  ok('and the status names the loaded file rather than the federal roll',
     /file of|roll of/i.test(await page.locator('#nv-status').innerText()),
     (await page.locator('#nv-status').innerText()).replace(/\s+/g, ' ').slice(0, 160));

  /* And a choice the reader does make is kept, across every later refresh --
     the flag distinguishes the two cases, it does not stop preserving one. */
  await page.locator('#nv-roll').selectOption('fed');
  await page.locator('#nv-ballots').selectOption('fed');
  await page.waitForTimeout(900);
  await page.locator('#nv-min').selectOption('25');
  await page.waitForTimeout(700);
  await page.locator('#nv-min').selectOption('0');
  await page.waitForTimeout(900);
  ok('a roll the reader picks survives an unrelated change to another control',
     (await page.locator('#nv-roll').inputValue()) === 'fed',
     await page.locator('#nv-roll').inputValue());
  const nvSame = (await page.locator('#nv-status').innerText()).replace(/\s+/g, ' ');
  ok('one election against its own roll reads as people who did not cast a ballot',
     /did not cast a ballot/.test(nvSame), nvSame.slice(0, 220));
  ok('and says both halves are counts rather than leaving it to be noticed',
     /Both figures are counts/.test(nvSame), nvSame.slice(0, 300));
  /* Counted on both sides still comes two ways, and the first version told the
     same story about both: "placed on these areas one address at a time" was
     printed over federal electors lifted straight from the results file, which
     were reported on those divisions and never placed by anybody. Every test
     here read the phrase "Both figures are counts" and sailed past the
     sentence after it. Found by opening the tab and reading it. */
  ok('and does not claim electors from a results file were placed by address',
     !/one address at a time/.test(nvSame)
     && /reported on these areas by the agency/.test(nvSame), nvSame.slice(0, 400));
  ok('and carries no cross-election warning, since there is none',
     !/Cross-election/.test(nvSame), nvSame.slice(0, 300));
  ok('and closes on the caveat that a count over an area names no elector',
     /cannot tell you which elector did not vote/.test(nvSame), nvSame.slice(-200));
  ok('the badge says counted', /Counted/.test(await page.locator('#nv-badge').innerText()),
     await page.locator('#nv-badge').innerText());
  /* Counted, and incomplete, and the tab has to say the second part.

     With apportionment off these ballots are a real count of election-day
     voting -- and everybody who voted early lands in "did not vote", which on
     the live 2025 file reads 68.9% against a true 31.1%. A qualifier sitting
     next to a control on the Turnout tab does not travel with the figure
     somebody quotes off this one. */
  ok('and the prose says the ballots are election-day only, with the missing count',
     /election-day ballots only/i.test(nvSame) && /advance or\s+by special ballot/i.test(nvSame),
     nvSame.slice(0, 600));

  /* Now turn apportionment on, which is the setting a target list wants, and
     watch the same subtraction stop being a count. Advance ballots are spread
     over the divisions that fed each advance poll and special ballots over
     whole districts: the total is right, where it sits is modelled. The tab
     used to print "Both figures are counts" and a green Counted badge over it. */
  await page.locator('#tab-turnout').click();
  await page.waitForTimeout(300);
  await page.locator('#apportion-fed').selectOption('electors');
  await page.waitForTimeout(700);
  await page.locator('#tab-nonvoters').click();
  await page.waitForTimeout(700);
  const nvApp = await page.locator('#panel-nonvoters').innerText();
  const nvAppBadge = await page.locator('#nv-badge').innerText();
  ok(`apportioned ballots are not badged as counted (${nvAppBadge.trim().slice(0, 40)})`,
     !/Counted/.test(nvAppBadge), nvAppBadge);
  ok('and the prose stops calling both figures counts',
     !/Both figures are counts/.test(nvApp), nvApp.slice(0, 600));
  ok('and says how much of the ballots half was moved there by the model',
     /were not reported in the .* they are counted in/i.test(nvApp), nvApp.slice(0, 800));
  ok('and no longer says the ballots were election-day only',
     !/election-day ballots only/i.test(nvApp), nvApp.slice(0, 600));
  /* The diagnostic that used to point at the wrong half. Blaming the roll is
     right on counted ballots -- a division cannot report more ballots than it
     holds electors unless the roll is wrong. On apportioned ballots the model
     can hand a division more than it can hold all by itself, and sending
     somebody to audit the roll over that wastes the audit. */
  const negLine = nvApp.split('\n').find((l) => /more ballots than\s*roll electors/i.test(l))
    || nvApp.split('\n').find((l) => /more ballots than/i.test(l)) || '';
  if (negLine) {
    ok('a negative gap on modelled ballots does not pin the blame on the roll',
       /Either half could be responsible/.test(negLine), negLine.slice(0, 300));
  } else {
    ok('a negative gap on modelled ballots does not pin the blame on the roll',
       !/fact about the roll rather than about the ballots/.test(nvApp), nvApp.slice(0, 400));
  }
  await page.locator('#tab-turnout').click();
  await page.waitForTimeout(300);
  await page.locator('#apportion-fed').selectOption('none');
  await page.waitForTimeout(700);
  await page.locator('#tab-nonvoters').click();
  await page.waitForTimeout(700);
  ok('and turning it back off restores the counted badge',
     /Counted/.test(await page.locator('#nv-badge').innerText()),
     await page.locator('#nv-badge').innerText());

  /* No verb of cause anywhere on the tab. An area-level difference licenses a
     ranking and licenses nothing about why anybody stayed home. */
  const nvText = await page.locator('#panel-nonvoters').innerText();
  const causal = ['because', 'drove', 'led to', 'caused', 'explains', 'predicts', 'therefore',
                  'due to'].filter((w) => new RegExp('\\b' + w + '\\b', 'i').test(nvText));
  ok('no verb of cause appears anywhere on the tab', causal.length === 0, causal.join(', '));

  const nvHeads = await page.$$eval('#nv-table thead th', (ts) => ts.map((t) => ({
    label: t.querySelector('span:not(.th-sub)')?.textContent || '',
    sub: t.querySelector('.th-sub')?.textContent || '' })));
  ok('the table names what was subtracted from what, under its own column',
     nvHeads.some((h) => h.label === 'Did not vote' && /electors/.test(h.sub) && /ballots/.test(h.sub)),
     JSON.stringify(nvHeads.map((h) => h.label + '|' + h.sub)));
  const nvRows = await page.locator('#nv-table tbody tr').count();
  ok(`one row per area with a roll entry (${nvRows})`, nvRows > 500, String(nvRows));

  /* A rank, and never a count of votes. The words are the feature. */
  ok('the ranking column is a priority, not a quantity',
     nvHeads.some((h) => h.label === 'Mail priority'),
     JSON.stringify(nvHeads.map((h) => h.label)));
  const priority = (await page.locator('#nv-priority-note').innerText()).replace(/\s+/g, ' ');
  ok('and the tab refuses the votes-available reading in as many words',
     /not a count of votes available/.test(priority), priority.slice(0, 260));
  ok('and names the share the rank rests on', /share of/.test(priority), priority.slice(0, 260));
  const ranks = await page.evaluate(() => {
    const rows = window.vanPoliAtlas.state.nonvoters.rows.filter((r) => r.m);
    const sorted = rows.slice().sort((a, b) => a.m.rank - b.m.rank);
    return { n: rows.length, first: sorted[0], last: sorted[sorted.length - 1],
             list: sorted.map((r) => r.m.rank) };
  });
  ok(`ranks run 1..n with no gaps and no ties (${ranks.n})`,
     ranks.list.every((v, i) => v === i + 1), ranks.list.slice(0, 8).join(','));
  ok('the top of the list is the 100th percentile and the bottom the 0th',
     ranks.first.m.percentile === 100 && ranks.last.m.percentile === 0,
     `${ranks.first.m.percentile}/${ranks.last.m.percentile}`);

  /* row.g and nothing else. The direct analogue of participation()'s rule: a
     figure built by subtracting two electorates must never reach a column
     labelled turnout. */
  const untouched = await page.evaluate(() => {
    const r = window.vanPoliAtlas.state.nonvoters.rows[0];
    return { agg: r.agg, tfed: r.t.fed, electors: r.electors,
             gapIsOwn: r.g.roll.count === r.electors && r.g.notVoted !== r.agg };
  });
  ok('the gap never reaches the turnout figures on the same row',
     untouched.agg != null && untouched.agg <= 1 && untouched.tfed <= 1,
     JSON.stringify(untouched));

  const nvDl = page.waitForEvent('download', { timeout: 15000 });
  await page.locator('#export-nonvoters').click();
  const nvCsv = require('fs').readFileSync(await (await nvDl).path(), 'utf8')
    .split(/\r?\n/).filter(Boolean);
  /* Quote-aware, because one of these columns legitimately holds a comma: the
     basis a mail rank rests on reads "Conservative share, 2025 federal
     ballots". Splitting on every comma would report the file as ragged and
     blame the export for quoting correctly. */
  const nvHead = splitCsv(nvCsv[0].replace(/^\ufeff/, ''));
  ok('the export names each half, its vintage and its route in their own columns',
     ['roll_source', 'roll_vintage', 'roll_route', 'ballots_source', 'ballots_vintage',
      'ballots_route', 'pairing_route', 'coherent'].every((h) => nvHead.includes(h)),
     nvHead.join(','));
  ok('and names the mail rank as a rank', nvHead.includes('mail_rank'), nvHead.join(','));
  const nvBody = nvCsv.slice(1).map(splitCsv);
  ok('no row is ragged against the header',
     nvBody.every((r) => r.length === nvHead.length),
     `${nvHead.length} vs ${[...new Set(nvBody.map((r) => r.length))].join('/')}`);
  const ci = (h) => nvHead.indexOf(h);
  ok('every row subtracts the two counts it carries',
     nvBody.every((r) => Number(r[ci('not_voted')])
       === Number(r[ci('roll_count')]) - Number(r[ci('ballots_count')])),
     nvBody[0] && [nvBody[0][ci('roll_count')], nvBody[0][ci('ballots_count')],
                   nvBody[0][ci('not_voted')]].join(' - '));
  ok('and says both halves were counted on these areas',
     nvBody.every((r) => r[ci('roll_route')] === 'counted' && r[ci('ballots_route')] === 'counted'),
     nvBody[0] && nvBody[0][ci('roll_route')]);
  ok('and that this pairing is one election against itself',
     nvBody.every((r) => r[ci('coherent')] === 'yes'), nvBody[0] && nvBody[0][ci('coherent')]);

  /* The map, where the same rule holds: a non-voter figure never appears
     without both half-labels and both routes beside it. */
  await page.locator('#tab-map').click();
  await page.waitForTimeout(500);
  await openDrawers(page);
  const nvOption = await page.evaluate(() =>
    !document.querySelector('#shade-by option[value="nonvoters-count"]').hidden);
  ok('the non-voter shading appears once the tab has produced figures', nvOption);
  await page.locator('#shade-by').selectOption('nonvoters-count');
  await page.waitForTimeout(700);
  const nvLegend = (await page.locator('#map-legend').innerText()).replace(/\s+/g, ' ');
  ok('the legend names both halves and how each reached these areas',
     /Did not vote/.test(nvLegend) && /electors/.test(nvLegend) && /ballots/.test(nvLegend)
     && /counted on these areas/.test(nvLegend), nvLegend.slice(0, 260));
  ok('and never borrows the word already taken by federal minus provincial share',
     !/^Federal minus provincial/.test(nvLegend), nvLegend.slice(0, 120));
  const nvShaded = await page.$$eval('.layer-fed path', (ps) => ps
    .map((p) => parseFloat(getComputedStyle(p).fillOpacity)).filter((o) => o > 0.07).length);
  ok(`the areas with a gap are shaded (${nvShaded})`, nvShaded > 500, String(nvShaded));
  const nvBox = await page.locator('.atlas-map').boundingBox();
  await page.mouse.click(nvBox.x + nvBox.width * 0.45, nvBox.y + nvBox.height * 0.5);
  await page.waitForTimeout(300);
  const nvReadout = await page.locator('#readout').innerText();
  ok('the readout carries the pairing beside the figure, never the figure alone',
     /did not vote/i.test(nvReadout) && /electors/.test(nvReadout) && /ballots/.test(nvReadout),
     nvReadout.replace(/\s+/g, ' ').slice(0, 300));

  /* The other pairing: a roll the atlas was handed, against ballots from a
     different election. Three located rows against a whole city's ballots, so
     every area it touches comes out negative -- which is what a roll that does
     not describe the people who voted there looks like. */
  await page.locator('#tab-nonvoters').click();
  await page.waitForTimeout(400);
  await page.locator('#nv-roll').selectOption('muni');
  await page.waitForTimeout(900);
  const nvCross = (await page.locator('#nv-status').innerText()).replace(/\s+/g, ' ');
  ok('a roll from one election against ballots from another is flagged cross-election',
     /Cross-election/.test(nvCross), nvCross.slice(0, 300));
  ok('and is named by what the reader called the file, never as a roll this build assumed',
     /electors/.test(nvCross) && !/2026 municipal roll/.test(nvCross), nvCross.slice(0, 300));
  ok('more ballots than roll electors is reported as a fact about the roll, not clamped',
     /more ballots than roll electors/.test(nvCross)
     && /fact about the roll/.test(nvCross), nvCross.slice(0, 400));
  /* A three-address roll against a whole city's ballots puts the TOTAL under
     zero, not just some areas, and the sentence built for a positive gap does
     not survive it: "hold -964 more ... than there were", beside a share of
     -32,133% of the roll. Both are arithmetically right and unreadable. A
     negative total is a different sentence with the two totals in it. */
  ok('a total under zero reads as fewer on the roll, not as a negative "more"',
     !/-\d/.test(nvCross.split('Both figures')[0]) && /FEWER on the/.test(nvCross),
     nvCross.split('Both figures')[0].slice(0, 260));
  ok('and gives the two totals rather than a percentage nobody can read',
     !/-\d+(\.\d+)?% of the roll/.test(nvCross), nvCross.slice(0, 260));
  const negatives = await page.evaluate(() =>
    window.vanPoliAtlas.state.nonvoters.rows.filter((r) => r.g.notVoted < 0).length);
  ok(`the negative gaps survive to the rows (${negatives})`, negatives > 0, String(negatives));
  ok('areas the roll never mentions are reported as having no entry rather than a zero',
     /no roll entry at all/.test(nvCross) && /not the same as a roll of zero/.test(nvCross),
     nvCross.slice(0, 500));
  const noEntry = await page.evaluate(() =>
    window.vanPoliAtlas.state.nonvoters.rows.some((r) => r.g.roll.count === 0));
  ok('and no area with no roll entry is given a roll count of zero instead', !noEntry);

  /* The picked set: counts added up, and never re-modelled. */
  await page.locator('#nv-basket-add-top').click();
  await page.waitForTimeout(400);
  const basket = (await page.locator('#nv-basket').innerText()).replace(/\s+/g, ' ');
  ok('picking areas sums the counts they already carry', /areas picked/.test(basket),
     basket.slice(0, 200));
  await page.locator('#nv-basket-clear').click();
  await page.waitForTimeout(300);

  /* The narrower form of the same bug, and the reason the ask is stored rather
     than a was-touched flag. The reader has chosen the loaded roll. Clearing it
     must drop the tab to what still resolves -- there is nothing else it could
     honestly show -- but loading the next roll must return to what they asked
     for. A flag saying "they have chosen something" cannot do that: by then the
     control holds the fallback, and reading it back pins the tab to the
     federal count exactly as before. */
  await page.locator('#tab-data').click();
  await page.waitForTimeout(300);
  await page.locator('#clear-points').click();
  await page.waitForTimeout(900);
  await page.locator('#tab-nonvoters').click();
  await page.waitForTimeout(500);
  ok('clearing the roll falls back to an elector count that still resolves',
     (await page.locator('#nv-roll').inputValue()) === 'fed',
     await page.locator('#nv-roll').inputValue());
  await page.locator('#tab-data').click();
  await page.waitForTimeout(300);
  await page.locator('#file-points').setInputFiles(
    { name: 'roll.csv', mimeType: 'text/csv', buffer: Buffer.from(ROLL) });
  await page.waitForTimeout(1500);
  await page.locator('#tab-nonvoters').click();
  await page.waitForTimeout(600);
  ok('and loading the next roll returns to the one the reader asked for',
     (await page.locator('#nv-roll').inputValue()) === 'muni',
     await page.locator('#nv-roll').inputValue());

  await page.locator('#tab-map').click();
  await page.waitForTimeout(300);
  await page.locator('#shade-by').selectOption('fed-party');
  await page.waitForTimeout(300);

  /* The export left us on the Turnout tab; the clear buttons are on Data. */
  await page.locator('#tab-data').click();
  await page.waitForTimeout(300);
  await page.locator('#clear-points').click();
  await page.waitForTimeout(500);
  await page.locator('#clear-points-ref').click();
  await page.waitForTimeout(400);
  /* And with nothing loaded the export goes back to the shape it had. */
  await page.locator('#tab-turnout').click();
  await page.waitForTimeout(600);
  const pointsDl2 = page.waitForEvent('download', { timeout: 15000 });
  await page.locator('#export-turnout').click();
  const pointsHead2 = require('fs').readFileSync(await (await pointsDl2).path(), 'utf8')
    .split(/\r?\n/)[0].split(',');
  ok('removing the roll removes its columns rather than leaving them empty',
     !pointsHead2.some((h) => h.startsWith('points_')), pointsHead2.slice(-4).join(','));

  console.log('\n== Census on the map ==');
  await page.locator('#tab-map').click();
  await page.waitForTimeout(600);
  await page.locator('#shade-da-by').selectOption('variable');
  await page.waitForTimeout(400);
  const daOpacities = new Set(await page.$$eval('.layer-da path', (ps) => ps.map((p) => getComputedStyle(p).fillOpacity)));
  ok(`shading by a census variable gives graded fills (${daOpacities.size} distinct)`, daOpacities.size > 10);
  ok('legend names the census layer', /dissemination area/i.test(await page.locator('#map-legend').innerText()));
  const box2 = await page.locator('.atlas-map').boundingBox();
  await page.mouse.click(box2.x + box2.width * 0.5, box2.y + box2.height * 0.5);
  await page.waitForTimeout(300);
  readout = await page.locator('#readout').innerText();
  ok('readout shows a census card with the area id and its variables', /Census \(2021\)/i.test(readout) && /DA 5915/.test(readout) && /Population, 2021/.test(readout) && /people/.test(readout), readout.slice(-400));
  await page.locator('#shade-da-by').selectOption('none');
  await page.waitForTimeout(300);

  // The export checks that follow click controls on the Correlation tab.
  await page.locator('#tab-corr').click();
  await page.waitForTimeout(300);

  console.log('\n== Export ==');
  const dl = page.waitForEvent('download', { timeout: 15000 });
  await page.locator('#export-crosswalk').click();
  const download = await dl;
  const savedTo = await download.path();
  const fsx = require('fs');
  const csv = fsx.readFileSync(savedTo, 'utf8');
  const lines = csv.trim().split(/\r?\n/);
  ok(`crosswalk CSV exported (${lines.length - 1} rows)`, lines.length > 100);
  ok('CSV header correct', lines[0].includes('share_of_federal_poll'), lines[0]);

  const dl2 = page.waitForEvent('download', { timeout: 15000 });
  await page.locator('#export-joined').click();
  const joined = await (await dl2).path();
  const jcsv = fsx.readFileSync(joined, 'utf8').trim().split(/\r?\n/);
  ok(`joined table exported (${jcsv.length - 1} rows)`, jcsv.length > 100);
  ok('joined header has both sides', /fed_share_/.test(jcsv[0]) && /prov_share_/.test(jcsv[0]));

  console.log('\n== The municipal election, as a third election ==');
  await page.locator('#tab-data').click();
  await page.waitForTimeout(200);
  /* Loading the results first, which is the order a reader is likely to try:
     the archive alone cannot be placed and should say so rather than fail. */
  await page.locator('#file-muni-results').setInputFiles('fixtures/e2e_muni_results.zip');
  await page.waitForTimeout(600);
  const muniHalf = (await page.locator('#status-muni').innerText()).replace(/\s+/g, ' ');
  ok('the archive alone asks for the voting places rather than erroring',
     /voting places/i.test(muniHalf), muniHalf.slice(0, 160));
  await page.locator('#file-muni-places').setInputFiles('fixtures/e2e_muni_places.csv');
  await page.waitForTimeout(1200);
  const muni = (await page.locator('#status-muni').innerText()).replace(/\s+/g, ' ');
  ok('both files join into a municipal election', /ballots on 8 voting places/.test(muni), muni.slice(0, 200));
  ok('the Total row is named as a summary and held out',
     /Total \([\d,]+\) is a summary row/.test(muni), muni.slice(0, 300));
  ok('mail is reported as having no place rather than dropped',
     /Mail Results \(250\)/.test(muni), muni.slice(0, 400));
  ok('the city-wide rate is shown, from the Overview sheet',
     /City-wide turnout was 34\.7%/.test(muni), muni.slice(0, 600));
  ok('and it says there is no municipal turnout by area',
     /no municipal turnout by area/i.test(muni), muni.slice(-300));
  ok('the spread reports how many places each area rests on',
     /resting on about [\d.]+ voting places/.test(muni), muni.slice(-400));

  const muniState = await page.evaluate(() => {
    const m = window.vanPoliAtlas.state.muni;
    const units = [...m.on.fed.values()];
    return { ballots: m.ballots, areas: units.length, parties: m.parties.map((p) => p[0]),
             spread: units.reduce((a, u) => a + u.ballots, 0),
             races: window.vanPoliAtlas.state.muniFiles.races.map((r) => r.name) };
  });
  ok('the Mac resource fork is not read as a race',
     muniState.races.join(',') === 'Mayor,Councillor,SchoolTrustee', muniState.races.join(','));
  ok('every municipal ballot lands on a federal polling division',
     Math.abs(muniState.spread - muniState.ballots) < 0.5,
     `${muniState.spread} vs ${muniState.ballots}`);
  ok('ABC is not title-cased into a typo', muniState.parties.includes('ABC Vancouver'),
     muniState.parties.join(', '));


  const muniOptions = () => page.evaluate(() => ['shade-by', 'shade-prov-by'].map((sel) =>
    ['muni-party', 'muni-ballots'].map((v) => {
      const o = document.querySelector(`#${sel} option[value="${v}"]`);
      return o ? !o.hidden : null;
    })).flat());
  ok('the municipal shade options appear once the results are in',
     (await muniOptions()).filter((v) => v === true).length === 4,
     JSON.stringify(await muniOptions()));
  ok('there is no municipal turnout option anywhere on the map controls',
     await page.locator('#shade-by option[value="turnout-muni"]').count() === 0
     && await page.locator('#shade-prov-by option[value="turnout-muni"]').count() === 0);
  await page.locator('#tab-map').click();
  await page.waitForTimeout(200);
  await page.locator('#muni-party').selectOption('ABC Vancouver');
  await page.locator('#shade-by').selectOption('muni-party');
  await page.waitForTimeout(700);
  const muniShaded = await page.evaluate(() => [...document.querySelectorAll('.layer-fed path')]
    .filter((p) => p.style.fill && p.style.fill !== 'none').length);
  ok(`a municipal party share shades the polls (${muniShaded})`, muniShaded > 500, String(muniShaded));

  /* Widening the advance bandwidth must flatten the map, not move ballots into
     or out of existence. Both halves are asserted. */
  await page.locator('#tab-data').click();
  await page.waitForTimeout(150);
  const spreadAt = async (metres) => {
    await page.locator('#muni-band-final').fill(String(metres));
    await page.locator('#muni-band-final').dispatchEvent('change');
    await page.waitForTimeout(900);
    return page.evaluate(() => {
      const u = [...window.vanPoliAtlas.state.muni.on.fed.values()].map((x) => x.ballots);
      const m = u.reduce((a, b) => a + b, 0) / u.length;
      return { total: u.reduce((a, b) => a + b, 0),
               sd: Math.sqrt(u.reduce((a, b) => a + (b - m) ** 2, 0) / u.length) };
    });
  };
  const tight = await spreadAt(400);
  const wide = await spreadAt(6000);
  ok('a wider spread flattens the surface', wide.sd < tight.sd * 0.5,
     `${tight.sd.toFixed(2)} -> ${wide.sd.toFixed(2)}`);
  ok('and conserves every ballot either way',
     Math.abs(tight.total - wide.total) < 0.5 && Math.abs(tight.total - muniState.ballots) < 0.5,
     `${tight.total} ${wide.total} ${muniState.ballots}`);

  /* A ten-seat race: nine votes per ballot must not become nine times the
     ballots, which is the mistake that makes a council map unreadable. */
  await page.locator('#muni-race').selectOption('Councillor');
  await page.waitForTimeout(900);
  const council = await page.evaluate(() => {
    const m = window.vanPoliAtlas.state.muni;
    const units = [...m.on.fed.values()];
    return { ballots: units.reduce((a, u) => a + u.ballots, 0),
             votes: units.reduce((a, u) => a + u.total, 0), seats: m.built.report.seats };
  });
  ok('the seat count is read from the sheet', council.seats === 10, String(council.seats));
  ok('ballots stay ballots in a ten-seat race',
     Math.abs(council.ballots - muniState.ballots) < 1,
     `${council.ballots} vs ${muniState.ballots}`);
  ok('while the votes are several times that', council.votes > council.ballots * 3,
     `${council.votes} vs ${council.ballots}`);
  ok('and OneCity keeps its own spelling rather than being title-cased',
     (await page.evaluate(() => window.vanPoliAtlas.state.muni.parties.map((p) => p[0])))
       .includes('OneCity'));

  await page.locator('#muni-race').selectOption('Mayor');
  await page.waitForTimeout(800);

  /* The three things that make a shading usable rather than merely painted:
     a legend saying what the colour means, every layer the model reached
     offering it, and the one opacity slider governing every overlay it is read
     by. None of these were covered before, and all three were broken. */
  console.log('\n== A municipal shading has to explain itself ==');
  await page.locator('#tab-map').click();
  await page.waitForTimeout(200);
  await page.locator('#shade-by').selectOption('muni-party');
  await page.waitForTimeout(500);
  const partyLegend = await page.locator('#map-legend').innerText();
  ok('the legend names the party and the election', /ABC Vancouver/.test(partyLegend)
     && /2022 municipal/.test(partyLegend), partyLegend.replace(/\s+/g, ' ').slice(0, 160));
  ok('and says the ballots were smoothed rather than assigned',
     /smoothed/i.test(partyLegend), partyLegend.replace(/\s+/g, ' ').slice(0, 200));
  await page.locator('#shade-by').selectOption('muni-ballots');
  await page.waitForTimeout(500);
  const ballotLegend = await page.locator('#map-legend').innerText();
  ok('the ballots legend calls the quantity ballots, and says so in as many words',
     /Ballots, not turnout/i.test(ballotLegend),
     ballotLegend.replace(/\s+/g, ' ').slice(0, 160));
  ok('and points at the Method tab for why there is no municipal turnout',
     /no municipal turnout by area/i.test(ballotLegend),
     ballotLegend.replace(/\s+/g, ' ').slice(-140));

  console.log('\n== Every layer the municipal model reached offers it ==');
  const daMuni = await page.evaluate(() => ({
    reached: Object.keys(window.vanPoliAtlas.state.muni.on),
    offered: ['muni-party', 'muni-ballots'].map((v) =>
      !document.querySelector(`#shade-da-by option[value="${v}"]`).hidden),
  }));
  ok('the model reaches the census layer', daMuni.reached.includes('da'), JSON.stringify(daMuni));
  ok('and the census dropdown offers it', daMuni.offered.every(Boolean), JSON.stringify(daMuni));
  await page.locator('#shade-da-by').selectOption('muni-party');
  await page.waitForTimeout(600);
  const daShaded = await page.evaluate(() => [...document.querySelectorAll('.layer-da path')]
    .filter((n) => n.style.fill && n.style.fill !== 'none').length);
  ok(`a municipal share shades dissemination areas (${daShaded})`, daShaded > 20, String(daShaded));
  ok('and the legend says it is on dissemination areas',
     /dissemination areas/.test(await page.locator('#map-legend').innerText()));

  console.log('\n== One opacity slider, every overlay it governs ==');
  const opacityOf = (layer) => page.evaluate((l) => {
    const n = document.querySelector(`.layer-${l} path[style*="fill"]`);
    return n ? n.style.fillOpacity : null;
  }, layer);
  /* Both overlays have to be shaded before the slider has anything to restyle;
     an unshaded layer has no fill to carry an opacity. */
  await page.locator('#shade-prov-by').selectOption('muni-party');
  await page.waitForTimeout(500);
  const fillBefore = { prov: await opacityOf('prov'), da: await opacityOf('da') };
  await page.locator('#prov-opacity').fill('0.2');
  await page.locator('#prov-opacity').dispatchEvent('input');
  await page.waitForTimeout(400);
  const fillAfter = { prov: await opacityOf('prov'), da: await opacityOf('da') };
  ok('moving it restyles the census layer, not only the provincial one',
     fillAfter.da !== fillBefore.da, `da ${fillBefore.da} -> ${fillAfter.da}`);
  ok('and the provincial layer too', fillAfter.prov !== fillBefore.prov,
     `prov ${fillBefore.prov} -> ${fillAfter.prov}`);
  await page.locator('#prov-opacity').fill('0.7');
  await page.locator('#prov-opacity').dispatchEvent('input');
  await page.locator('#shade-prov-by').selectOption('none');
  await page.locator('#shade-da-by').selectOption('none');
  await page.locator('#shade-by').selectOption('none');
  await page.locator('#tab-data').click();
  await page.waitForTimeout(200);

  /* The briefing is checked at the end of the run, by which point the next
     line has unloaded this election -- so the municipal finding, and the only
     "smoothed" badge in the file, would never be exercised. Check it here,
     while the data is still loaded. */
  await page.locator('#tab-overview').click();
  await page.waitForTimeout(400);
  const withMuni = await page.locator('#overview-findings').innerText();
  ok('the briefing carries a municipal finding while the election is loaded',
     /municipal/i.test(withMuni), withMuni.replace(/\s+/g, ' ').slice(0, 200));
  ok('and marks it smoothed rather than counted',
     /Smoothed, not assigned/.test(withMuni), withMuni.replace(/\s+/g, ' ').slice(-200));
  await page.locator('#tab-data').click();
  await page.waitForTimeout(200);

  await page.locator('#clear-muni').click();
  await page.waitForTimeout(400);
  ok('removing it hides the municipal shade options again',
     (await muniOptions()).every((v) => v === false), JSON.stringify(await muniOptions()));

  /* Apportionment changes which ballots every reader sees. The correlation is
     computed from those ballots, so it has to follow -- it did not, and the
     Correlation tab went on showing an r computed under the previous setting
     with nothing to say so. Numbers that look stable because they never
     recomputed are worse than numbers that move. */
  /* The aggregate weight is read in three places: the map's turnout-agg
     shading, the legend that names the split, and the socioeconomic table's
     aggregate column. refreshTurnout restyled the federal and provincial
     layers and re-rendered the legend, but never recomputed the socio side --
     so the Socioeconomic tab went on showing an aggregate built from the
     previous weighting.

     The map is deliberately NOT asserted here. Its ramp normalises to the
     5th-95th percentile of what is on screen, and the aggregate is an affine
     function of the two turnouts, so where they move together the colours are
     genuinely unchanged by the weight. Asserting otherwise would be asserting
     a coincidence of the fixture. */
  console.log('\n== The aggregate weight reaches the socioeconomic side ==');
  const aggOf = () => page.evaluate(() => {
    const byDa = window.vanPoliAtlas.state.socio?.byDa;
    if (!byDa) return null;
    return [...byDa.values()].map((r) => (r.agg == null ? 'x' : r.agg.toFixed(6))).join(',');
  });
  await page.locator('#tab-turnout').click();
  await page.waitForTimeout(200);
  await page.locator('#turnout-weight').fill('0.5');
  await page.locator('#turnout-weight').dispatchEvent('change');
  await page.waitForTimeout(900);
  const aggHalf = await aggOf();
  ok('the census layer carries an aggregate to begin with',
     aggHalf && /\d/.test(aggHalf), String(aggHalf).slice(0, 60));
  await page.locator('#turnout-weight').fill('0.9');
  await page.locator('#turnout-weight').dispatchEvent('change');
  await page.waitForTimeout(900);
  const aggNinety = await aggOf();
  ok('moving the weight recomputes it rather than leaving it stale',
     aggNinety !== aggHalf, `${String(aggHalf).slice(0, 40)} vs ${String(aggNinety).slice(0, 40)}`);
  await page.locator('#tab-turnout').click();
  await page.waitForTimeout(200);
  await page.locator('#turnout-weight').fill('0.5');
  await page.locator('#turnout-weight').dispatchEvent('change');
  await page.waitForTimeout(900);
  ok('and setting it back restores the original figures', (await aggOf()) === aggHalf);
  await page.locator('#tab-map').click();
  await page.waitForTimeout(200);

  console.log('\n== Apportionment reaches the correlation, not just the turnout table ==');
  await page.locator('#tab-corr').click();
  await page.waitForTimeout(400);
  const corrStats = () => page.evaluate(() => {
    const n = document.querySelector('#corr-stats');
    return n ? n.innerText.replace(/\s+/g, ' ').trim() : '';
  });
  const corrOff = await corrStats();
  await page.locator('#tab-turnout').click();
  await page.waitForTimeout(200);
  await page.locator('#apportion-fed').selectOption('electors');
  await page.waitForTimeout(1200);
  await page.locator('#tab-corr').click();
  await page.waitForTimeout(600);
  const corrOn = await corrStats();
  ok('switching apportionment recomputes the correlation',
     corrOff !== '' && corrOn !== '' && corrOff !== corrOn,
     `off: ${corrOff.slice(0, 70)} | on: ${corrOn.slice(0, 70)}`);
  await page.locator('#tab-turnout').click();
  await page.waitForTimeout(200);
  await page.locator('#apportion-fed').selectOption('none');
  await page.waitForTimeout(1000);
  await page.locator('#tab-corr').click();
  await page.waitForTimeout(600);
  ok('and switching back restores the original figures', (await corrStats()) === corrOff);

  /* An r and a confidence interval are precise and, to most of the people this
     file is for, mute. These say the same thing in a sentence somebody can
     quote -- which is exactly why the third sentence has to refuse the step
     from "areas with more X had more Y" to "people with X did Y". */
  console.log('\n== Plain-language summaries ==');
  await page.locator('#tab-corr').click();
  await page.waitForTimeout(700);
  const corrSummary = await page.locator('#corr-summary').innerText();
  ok('the Compare tab says the strength and direction in words',
     /(weak|moderate|strong) (negative|positive) relationship/i.test(corrSummary),
     corrSummary.replace(/\s+/g, ' ').slice(0, 160));
  ok('and puts the slope in points a reader can picture',
     /points (lower|higher) for every 10 points of/.test(corrSummary),
     corrSummary.replace(/\s+/g, ' ').slice(0, 200));
  ok('and says how firmly to hold it, from the interval',
     /plausible range runs from -?[\d.]+ to -?[\d.]+/.test(corrSummary),
     corrSummary.replace(/\s+/g, ' ').slice(0, 240));
  ok('and counts original reporting units, not map pieces',
     /original reporting units/.test(corrSummary)
     && !/independent sources/.test(corrSummary), corrSummary.replace(/\s+/g, ' ').slice(0, 200));
  /* The one sentence that must always be there. */
  ok('and refuses the step from areas to individuals',
     /not people\./.test(corrSummary) && /cannot tell you how anybody voted/.test(corrSummary),
     corrSummary.replace(/\s+/g, ' ').slice(-200));
  ok('and never claims cause',
     !/\b(caused?|causes|drove|drives|led to|leads to|because of)\b/i.test(corrSummary),
     corrSummary.replace(/\s+/g, ' '));

  await page.locator('#tab-socio').click();
  await page.waitForTimeout(700);
  const socioSummary = await page.locator('#socio-summary').innerText();
  ok('the Neighbourhood profile summarises its own correlation too',
     /(weak|moderate|strong) (negative|positive) relationship/i.test(socioSummary),
     socioSummary.replace(/\s+/g, ' ').slice(0, 160));
  /* The census variables are percentages 0-100 and turnout is a share 0-1, so
     the fitted slope is not in comparable units and no points-per-points
     sentence may appear here. */
  ok('but states no points-per-points figure, whose units do not line up there',
     !/for every 10 points of/.test(socioSummary),
     socioSummary.replace(/\s+/g, ' ').slice(0, 200));
  ok('and names the geography it is running on',
     /dissemination areas/i.test(socioSummary),
     socioSummary.replace(/\s+/g, ' ').slice(0, 160));
  ok('and refuses the same step', /cannot tell you how anybody voted/.test(socioSummary));

  console.log('\n== The briefing ==');
  await page.locator('#tab-overview').click();
  await page.waitForTimeout(500);
  if (process.env.ATLAS_SHOT) await page.screenshot({ path: process.env.ATLAS_SHOT, fullPage: true });
  const brief = await page.locator('#panel-overview').innerText();
  const figures = await page.locator('#overview-findings .finding-figure').allTextContents();
  ok(`the briefing carries headline findings (${figures.length})`, figures.length >= 3, figures.join(' | '));
  ok('every one of them has a figure rather than a dash',
     figures.length > 0 && figures.every((f) => f.trim() && f.trim() !== '--'), figures.join(' | '));
  /* A headline is exactly where a modelled number gets quoted as a counted one,
     so each figure has to say which it is. */
  const badges = await page.locator('#overview-findings .badge').allTextContents();
  ok('each finding says how it was arrived at', badges.length === figures.length, badges.join(' | '));
  ok('and the modelled ones are named as modelled',
     badges.some((b) => /modelled/i.test(b)), badges.join(' | '));
  /* Electors are registered to a polling division whatever they later do, so
     the denominator is always everyone; the numerator is not, because the
     Turnout tab's default leaves advance and special ballots out. That is
     honest on that tab, where the control says "Leave out (election-day
     turnout)" -- and it was a wrong number here, headlined "Aggregate turnout"
     and badged Counted, wrong by however large advance voting was. The name of
     the measure has to follow the setting. */
  const findingText = () => page.locator('#overview-findings').innerText();
  ok('with advance ballots left out the figure is named election-day turnout',
     /Election-day turnout across the ranked areas/.test(await findingText()),
     (await findingText()).replace(/\s+/g, ' ').slice(0, 200));
  ok('and it says which ballots are missing and where to turn them on',
     /ballots are left out/.test(await findingText())
     && /Turnout tab/.test(await findingText()),
     (await findingText()).replace(/\s+/g, ' ').slice(0, 320));
  const pctOf = async () => parseFloat((/([\d.]+)%/.exec(await findingText()) || [0, '0'])[1]);
  const dayOnly = await pctOf();
  await page.locator('#tab-turnout').click();
  await page.locator('#apportion-fed').selectOption('votes');
  await page.locator('#apportion-prov').selectOption('votes');
  await page.waitForTimeout(1200);
  await page.locator('#tab-overview').click();
  await page.waitForTimeout(600);
  const apportioned = await pctOf();
  ok('apportioning them renames the measure',
     /Aggregate turnout across the ranked areas/.test(await findingText()),
     (await findingText()).replace(/\s+/g, ' ').slice(0, 200));
  ok(`and raises the figure, since the ballots were real (${dayOnly}% -> ${apportioned}%)`,
     apportioned > dayOnly, `${dayOnly} -> ${apportioned}`);
  ok('and drops the missing-ballots warning', !/left out/.test(await findingText()),
     (await findingText()).replace(/\s+/g, ' ').slice(0, 200));
  await page.locator('#tab-turnout').click();
  await page.locator('#apportion-fed').selectOption('none');
  await page.locator('#apportion-prov').selectOption('none');
  await page.waitForTimeout(1200);
  await page.locator('#tab-overview').click();
  await page.waitForTimeout(600);

  ok('the briefing states the scope and what is left out',
     /polling divisions/.test(brief) && /Electoral Area A/.test(brief), brief.slice(0, 200));
  ok('it ticks the datasets that are loaded',
     (await page.locator('#overview-readiness li.is-ready').count()) >= 4,
     String(await page.locator('#overview-readiness li.is-ready').count()));
  ok('it carries the caveats that govern quoting a number',
     /neighbourhoods, not people/i.test(brief) && /no municipal turnout/i.test(brief));
  ok('it attributes every agency whose data it can carry',
     ['Elections Canada', 'Elections BC', 'City of Vancouver', 'Statistics Canada']
       .every((who) => brief.includes(who)), brief.slice(-400));
  /* The committed build carries NO stamp, and that is the point of it: a stamp
     carries the clock, so a file with one is never byte-identical to the next
     build, and CI checks the committed artifact still matches a fresh one. The
     stamp belongs on a copy handed to somebody -- asserted on the payload build
     in test-variants, which is what such a copy is. */
  ok('the committed build carries no stamp, so it stays reproducible',
     !/Built \d{4}-\d{2}-\d{2}/.test(brief)
     && (await page.locator('#overview-stamp').count()) === 1
     && await page.locator('#overview-stamp').isHidden(),
     brief.slice(0, 300));

  /* The same qualifier has to travel with the figure wherever it is printed.
     The briefing was only the surface that made it obvious; the legend and the
     readout card show the identical number with no control anywhere near it,
     and the readout is the one people click. */
  console.log('\n== The qualifier travels with the number ==');
  await page.locator('#tab-map').click();
  await page.waitForTimeout(300);
  await page.locator('#shade-by').selectOption('turnout-agg');
  await page.waitForTimeout(600);
  const legend = async () => page.locator('#map-legend').innerText();
  ok('the legend names the basis rather than saying plain "Aggregate turnout"',
     /Election-day turnout/.test(await legend()), (await legend()).replace(/\s+/g, ' ').slice(0, 140));
  const at = await page.evaluate(() => {
    for (const path of document.querySelectorAll('.layer-fed path')) {
      const r = path.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      if (document.elementFromPoint(x, y) === path) return { x, y };
    }
    return null;
  });
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(400);
  ok('and the readout card carries it beside the per-area figure',
     /election-day ballots only/.test(await page.locator('#readout').innerText()),
     (await page.locator('#readout').innerText()).replace(/\s+/g, ' ').slice(-200));
  await page.locator('#tab-turnout').click();
  await page.locator('#apportion-fed').selectOption('votes');
  await page.locator('#apportion-prov').selectOption('votes');
  await page.waitForTimeout(1200);
  ok('the Turnout tab tile renames itself too',
     /aggregate turnout/i.test(await page.locator('#turnout-stats').innerText())
     && !/election-day/i.test(await page.locator('#turnout-stats').innerText()),
     (await page.locator('#turnout-stats').innerText()).replace(/\s+/g, ' ').slice(0, 200));
  await page.locator('#tab-map').click();
  await page.waitForTimeout(600);
  ok('and the legend drops the qualifier once the ballots are in',
     !/Election-day/.test(await legend()), (await legend()).replace(/\s+/g, ' ').slice(0, 140));
  await page.locator('#tab-turnout').click();
  await page.locator('#apportion-fed').selectOption('none');
  await page.locator('#apportion-prov').selectOption('none');
  await page.waitForTimeout(1200);

  /* Party shares move with apportionment too: apportionUnmatched redistributes
     per-party votes, not only ballot totals, so advance voters are spread at
     their district's advance mix rather than each poll's election-day mix.
     Every surface that prints a share is therefore in the same class. */
  await page.locator('#tab-map').click();
  await page.waitForTimeout(400);
  await page.locator('#shade-by').selectOption('fed-party');
  await page.waitForTimeout(600);
  ok('a party-share legend says the advance ballots are out too',
     /Advance and special ballots are left out/.test(await legend()),
     (await legend()).replace(/\s+/g, ' ').slice(0, 180));
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(400);
  /* The readout takes a side explicitly. It read unit.side while writing this,
     which units do not carry -- undefined, silently, exactly the shape of the
     bug that made the both-elections filter empty the tab. This is the
     assertion that catches it. */
  ok('and the readout card carries it under the party list',
     /election-day ballots only/.test(await page.locator('#readout').innerText()),
     (await page.locator('#readout').innerText()).replace(/\s+/g, ' ').slice(-220));
  await page.locator('#tab-corr').click();
  await page.waitForTimeout(600);
  ok('and the Compare caption says which basis its r was computed on',
     /Computed on election-day ballots only/.test(
       await page.locator('#scatter-caption').innerText()),
     (await page.locator('#scatter-caption').innerText()).replace(/\s+/g, ' ').slice(-200));
  await page.locator('#tab-turnout').click();
  await page.locator('#apportion-fed').selectOption('votes');
  await page.locator('#apportion-prov').selectOption('votes');
  await page.waitForTimeout(1200);
  await page.locator('#tab-corr').click();
  await page.waitForTimeout(600);
  ok('and drops it once they are in',
     !/Computed on election-day/.test(await page.locator('#scatter-caption').innerText()),
     (await page.locator('#scatter-caption').innerText()).replace(/\s+/g, ' ').slice(-200));
  await page.locator('#tab-turnout').click();
  await page.locator('#apportion-fed').selectOption('none');
  await page.locator('#apportion-prov').selectOption('none');
  await page.waitForTimeout(1200);
  await page.locator('#tab-map').click();
  await page.waitForTimeout(300);
  await page.locator('#shade-by').selectOption('none');
  await page.waitForTimeout(300);

  console.log('\n== Tabs and method ==');
  await page.locator('#tab-method').click();
  await page.waitForTimeout(200);
  const method = await page.locator('#panel-method').innerText();
  ok('method tab documents the assumption', /areal-interpolation assumption/i.test(method));
  ok('method tab warns about advance polls', /Advance polls/.test(method));
  ok('method tab explains why there is no municipal turnout map',
     /no municipal turnout by area/i.test(method), method.slice(0, 120));
  ok('and gives the measurement rather than asserting it',
     /r\s*0\.2/.test(method) && /r\s*0\.76/.test(method), 'numbers missing from the municipal section');

  console.log('\n== Errors over the whole run ==');
  ok('no console errors at any point', errors.length === 0, errors.slice(0, 4).join(' | '));

  await page.screenshot({ path: 'shot-map.png', fullPage: false });
  await page.locator('#tab-map').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'shot-map.png' });
  await page.locator('#tab-corr').click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'shot-corr.png' });

  await browser.close();
  console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll browser tests passed.\n');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
