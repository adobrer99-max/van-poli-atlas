const { chromium } = require('playwright');
const path = require('path');
let fails = 0;
const ok = (n, c, e = '') => { if (c) console.log(`  PASS  ${n}`); else { console.log(`  FAIL  ${n} ${e}`); fails++; } };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  const file = 'file://' + path.resolve('vancouver-boundary-atlas.html');
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
    return { fed: bb('.layer-fed'), prov: bb('.layer-prov') };
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
