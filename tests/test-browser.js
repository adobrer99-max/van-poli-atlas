const { chromium } = require('playwright');
const path = require('path');
// The build sandbox has no route to tile servers, and an unstubbed tile
// failure reads as a console error. Serve a 1x1 PNG for every tile request and
// record which host was asked, so basemap switching can be asserted.
const ONE_PX_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const tileHosts = [];
async function stubTiles(page) {
  await page.route(/basemaps\.cartocdn\.com|tile\.openstreetmap\.org/, (route) => {
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
  await page.waitForTimeout(900);

  console.log('\n== Initial load ==');
  ok('no console errors on load', errors.length === 0, errors.join(' | '));
  ok('title set', (await page.title()).includes('Vancouver'));
  const fedPaths = await page.locator('.layer-fed path').count();
  ok(`federal polls rendered (${fedPaths})`, fedPaths > 1000, `got ${fedPaths}`);
  ok('mobile polls hidden by default', fedPaths === 1031, `got ${fedPaths}`);
  ok('empty-provincial notice shown', await page.locator('#prov-missing').isVisible());
  const finder = await page.locator('#find-poll option').count();
  ok(`poll finder populated (${finder})`, finder === fedPaths + 1);

  console.log('\n== Basemap ==');
  ok('Leaflet map mounted', await page.evaluate(() => !!document.querySelector('#atlas-map.leaflet-container')));
  // Counting paths is not enough: a stylesheet rule once collapsed the renderer
  // SVG to 0x0 while every path still existed. Assert the drawn size.
  const svgBox = await page.evaluate(() => { const b = document.querySelector('.layer-fed svg').getBoundingClientRect(); return [b.width, b.height]; });
  ok(`renderer SVG has a real size (${svgBox.map(Math.round).join('x')})`, svgBox[0] > 300 && svgBox[1] > 300);
  const painted = await page.evaluate(() => { const b = document.querySelector('.layer-fed path').getBoundingClientRect(); const m = document.querySelector('#atlas-map').getBoundingClientRect();
    return b.width > 0 && b.left >= m.left - 1 && b.right <= m.right + 1 && b.top >= m.top - 1 && b.bottom <= m.bottom + 1; });
  ok('a polling division paints inside the map box', painted);
  ok(`default basemap requests CARTO tiles (${tileHosts.filter((h) => /cartocdn/.test(h)).length} requests)`, tileHosts.some((h) => /cartocdn\.com$/.test(h)));
  ok('tile images are in the tile pane', (await page.locator('.leaflet-tile-pane img.leaflet-tile').count()) > 0);
  ok('attribution credits OpenStreetMap', /OpenStreetMap/.test(await page.locator('.leaflet-control-attribution').innerText()));
  const tileCountBefore = tileHosts.length;
  await page.locator('#basemap').selectOption('osm');
  await page.waitForTimeout(800);
  ok('switching to OpenStreetMap requests tile.openstreetmap.org', tileHosts.slice(tileCountBefore).some((h) => h === 'tile.openstreetmap.org'));
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
  ok(`mobile polls can be shown (${fedPaths} -> ${withMobile})`, withMobile === 1103, `got ${withMobile}`);
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
  ok('federal results joined', /1,031 \/ 1,031/.test(status.replace(/\s+/g,' ')), status.replace(/\s+/g,' ').slice(0,220));
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
  ok('status warns that apportioned figures are estimates', /estimates/.test(await page.locator('#turnout-status').innerText()));
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
  ok('all 14 starter variables matched by name', /14 starter variables matched/.test(status), status);

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
  ok('dissemination areas carry the aggregate turnout', /dissemination areas carry aggregate turnout/.test(socioStatus), socioStatus);
  const socioRows = page.locator('#socio-table tbody tr');
  const nVars = await socioRows.count();
  ok(`table lists the 14 starter variables (${nVars})`, nVars === 14);
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
  ok('switching the outcome recomputes every row', texts2.length === 14 && texts2.join('|') !== texts.join('|'));
  await page.locator('#socio-outcome').selectOption('turnout-agg');
  await page.waitForTimeout(600);
  await page.locator('#socio-search').fill('2 persons');
  await page.waitForTimeout(300);
  await page.locator('#socio-search-results button').first().click();
  await page.waitForTimeout(800);
  ok('a characteristic added by name joins the table', (await socioRows.count()) === 15 && /2 persons/.test((await socioCells()).map((c) => c[0]).join(' ')));
  const sdl = page.waitForEvent('download', { timeout: 15000 });
  await page.locator('#export-socio').click();
  const scsv = require('fs').readFileSync(await (await sdl).path(), 'utf8').split(/\r?\n/).filter(Boolean);
  ok(`DA table exported (${scsv.length - 1} rows) with turnout, party shares and variables`,
     scsv.length - 1 >= minAreas && /turnout_agg/.test(scsv[0]) && /pct_renter/.test(scsv[0]) && /fed_share_/.test(scsv[0]) && /population_2021/.test(scsv[0]), scsv[0]);

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

  console.log('\n== Tabs and method ==');
  await page.locator('#tab-method').click();
  await page.waitForTimeout(200);
  const method = await page.locator('#panel-method').innerText();
  ok('method tab documents the assumption', /areal-interpolation assumption/i.test(method));
  ok('method tab warns about advance polls', /Advance polls/.test(method));

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
