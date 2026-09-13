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

  /* The "only areas with both elections" switch used to ask whether both sides
     produced a turnout RATE. Results reported by voting place carry no
     electors, so that question emptied the tab for the very outcomes built to
     survive a missing denominator. It now asks about ballots, and switches
     itself off for an outcome that reads one election, because there is then
     nothing for it to exclude. */
  const bothBox = page.locator('#socio-both-only');
  const bothLabel = page.locator('#socio-both-only-label');
  ok('the both-elections switch is live for the aggregate',
     !(await bothBox.isDisabled()), await bothLabel.innerText());
  await page.locator('#socio-outcome').selectOption('turnout-fed');
  await page.waitForTimeout(800);
  const oneSided = await page.locator('#socio-status').innerText();
  ok('a one-election outcome switches the filter off',
     await bothBox.isDisabled(), await bothLabel.innerText());
  ok('and says why in the label',
     /not used by this outcome/i.test(await bothLabel.innerText()), await bothLabel.innerText());
  ok('and still charts areas rather than emptying the tab',
     /in the study area, [1-9]\d* charted/.test(oneSided), oneSided);
  await page.locator('#socio-outcome').selectOption('turnout-agg');
  await page.waitForTimeout(800);
  ok('the filter comes back for an outcome that reads both',
     !(await bothBox.isDisabled()), await bothLabel.innerText());
  /* The regression this guards. The ballots test used to read
     sources.map(s => s.key); socioSources sets id, so every lookup was
     ballots[undefined], every row counted as one-sided, and leaving the box
     ticked emptied the tab for exactly the non-turnout outcomes that branch
     existed to rescue. Checked on both kinds that were affected -- a
     participation ratio and a party share -- with the box left TICKED, which
     is the state that used to empty them. */
  const partyOutcome = (await page.locator('#socio-outcome option').evaluateAll(
    (os) => os.map((o) => o.value))).find((v) => /^(fed|prov):/.test(v));
  ok('the fixture offers a party-share outcome to test with', Boolean(partyOutcome), partyOutcome);
  for (const [value, what] of [['part-fed', 'provincial ballots per federal elector'],
                               [partyOutcome, 'a party share']]) {
    await page.locator('#socio-outcome').selectOption(value);
    await page.waitForTimeout(800);
    const line = await page.locator('#socio-status').innerText();
    const charted = parseInt((/in the study area, ([\d,]+) charted/.exec(line) || [0, '0'])[1]
      .replace(/,/g, ''), 10);
    ok(`${what} keeps its rows with the box still ticked (${charted})`, charted > 0, line);
    ok(`and the box is ticked but inert for ${what}`,
       await bothBox.isChecked() && await bothBox.isDisabled(),
       `checked=${await bothBox.isChecked()} disabled=${await bothBox.isDisabled()}`);
    ok(`and rows are plotted for ${what}`,
       (await page.locator('#socio-table tbody tr').count()) > 0);
  }
  await page.locator('#socio-outcome').selectOption('turnout-agg');
  await page.waitForTimeout(800);

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
  ok(`table lists the 15 starter variables (${nVars})`, nVars === 15);
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
  ok('switching the outcome recomputes every row', texts2.length === 15 && texts2.join('|') !== texts.join('|'));

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
  ok('a characteristic added by name joins the table', (await socioRows.count()) === 16 && /2 persons/.test((await socioCells()).map((c) => c[0]).join(' ')));
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
  await page.locator('#clear-points').click();
  await page.waitForTimeout(500);
  await page.locator('#clear-points-ref').click();
  await page.waitForTimeout(400);

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
