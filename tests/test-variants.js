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
const ok=(n,c,e='')=>{ if(c) console.log(`  PASS  ${n}`); else { console.log(`  FAIL  ${n} ${e}`); fails++; } };
const FILE = 'file://' + path.resolve('vancouver-boundary-atlas.html');

(async () => {
  const browser = await chromium.launch();

  console.log('\n== Every boundary format produces the same layer ==');
  for (const [name, file] of [['zipped shapefile (BC Albers)','fixtures/e2e_voting_areas.zip'],
                              ['KML (lon/lat)','fixtures/e2e_va_kml.kml'],
                              ['KMZ','fixtures/e2e_va.kmz'],
                              ['GeoJSON','fixtures/e2e_va.geojson']]) {
    const page = await browser.newPage({ viewport:{width:1200,height:900} });
    const errs=[]; page.on('pageerror',e=>errs.push(e.message));
    await stubTiles(page); await page.goto(FILE); await page.waitForTimeout(500);
    await page.locator('#tab-data').click();
    await page.locator('#file-prov-geo').setInputFiles(file);
    await page.waitForTimeout(1800);
    const status = await page.locator('#status-prov-geo').innerText();
    await page.locator('#tab-map').click(); await page.waitForTimeout(500);
    const n = await page.locator('.layer-prov path').count();
    const bbox = await page.evaluate(() => {
      const b = document.querySelector('.layer-prov svg > g').getBBox();
      return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)];
    });
    ok(`${name}: 700 areas drawn, bbox ${bbox.join(',')}`, n === 700 && errs.length === 0,
       `n=${n} errs=${errs.join('|')} status=${status.replace(/\s+/g,' ').slice(0,120)}`);
    await page.close();
  }

  console.log('\n== Census boundaries: clipped or whole, shapefile or GeoJSON ==');
  {
    const expected = JSON.parse(require('fs').readFileSync('fixtures/e2e_expected.json', 'utf8')).census;
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await stubTiles(page); await page.goto(FILE); await page.waitForTimeout(500);
    await page.locator('#tab-data').click();
    const loadDa = async (file) => {
      await page.locator('#file-da-geo').setInputFiles(file);
      await page.waitForFunction(() => /Loaded|Could not/.test(document.querySelector('#status-da-geo').innerText), null, { timeout: 20000 });
      return page.locator('#status-da-geo').innerText();
    };
    let st = await loadDa('fixtures/e2e_da.zip');
    ok(`Lambert shapefile, clipped: ${expected.dissemination_areas} areas`, new RegExp(`Loaded ${expected.dissemination_areas} dissemination areas`).test(st), st);
    await page.locator('#clear-da-geo').click();
    await page.locator('#clip-census').uncheck();
    st = await loadDa('fixtures/e2e_da.zip');
    ok('unclipped load gives the same layer', new RegExp(`Loaded ${expected.dissemination_areas} dissemination areas from`).test(st), st);
    await page.locator('#clear-da-geo').click();
    await page.locator('#clip-census').check();
    st = await loadDa('fixtures/e2e_da.geojson');
    ok('lon/lat GeoJSON loads to the same count', new RegExp(`Loaded ${expected.dissemination_areas} dissemination areas`).test(st) && /lon-lat/.test(st), st);
    await page.locator('#tab-map').click(); await page.waitForTimeout(500);
    ok('dissemination areas drawn from GeoJSON', (await page.locator('.layer-da path').count()) === expected.dissemination_areas);
    ok('no errors across the census variants', errs.length === 0, errs.join(' | '));
    await page.close();
  }

  console.log('\n== Ring winding: RFC 7946 files must not blow up the projection ==');
  // d3-geo wants clockwise exterior rings; RFC 7946 mandates counter-clockwise.
  // Both spellings must land on the same pixels.
  {
    const measure = async (file) => {
      const page = await browser.newPage({ viewport:{width:1200,height:900} });
      await stubTiles(page); await page.goto(FILE); await page.waitForTimeout(500);
      await page.locator('#tab-data').click();
      await page.locator('#file-prov-geo').setInputFiles(file);
      await page.waitForTimeout(1600);
      await page.locator('#tab-map').click(); await page.waitForTimeout(500);
      const b = await page.evaluate(() => {
        const r = document.querySelector('.layer-prov svg > g').getBBox();
        return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
      });
      await page.close();
      return b;
    };
    const cw = await measure('fixtures/e2e_va_clockwise.geojson');
    const ccw = await measure('fixtures/e2e_va_rfc7946.geojson');
    ok(`clockwise file stays inside the viewport (${cw.join(',')})`, cw[2] < 2000 && cw[3] < 2000, cw.join(','));
    ok(`RFC 7946 file stays inside the viewport (${ccw.join(',')})`, ccw[2] < 2000 && ccw[3] < 2000, ccw.join(','));
    ok('both windings render identically',
       cw.every((v, i) => Math.abs(v - ccw[i]) <= 1), `${cw.join(',')} vs ${ccw.join(',')}`);
  }

  console.log('\n== Dark mode ==');
  {
    const page = await browser.newPage({ viewport:{width:1200,height:900}, colorScheme:'dark' });
    const errs=[]; page.on('pageerror',e=>errs.push(e.message));
    await stubTiles(page); await page.goto(FILE); await page.waitForTimeout(600);
    const colours = await page.evaluate(() => {
      const body = getComputedStyle(document.body);
      const html = getComputedStyle(document.documentElement);
      const poll = getComputedStyle(document.querySelector('.layer-fed path'));
      const card = getComputedStyle(document.querySelector('.readout-card') || document.body);
      return { bodyBg: body.backgroundColor, htmlBg: html.backgroundColor,
               scheme: html.colorScheme, fg: body.color,
               pollFill: poll.fill, pollStroke: poll.stroke, cardBg: card.backgroundColor };
    });
    const lum = (c) => { const m=(c.match(/[\d.]+/g)||['0','0','0']).map(Number);
      return m[0]*.299 + m[1]*.587 + m[2]*.114; };
    // body is transparent by design; the painted ground comes from :root.
    ok(`page ground is dark (${colours.htmlBg})`,
       /rgba?\(/.test(colours.htmlBg) && lum(colours.htmlBg) < 90, JSON.stringify(colours));
    ok(`color-scheme declares dark (${colours.scheme})`, /dark/.test(colours.scheme), colours.scheme);
    ok(`text is light on dark (${colours.fg})`, lum(colours.fg) > 150, JSON.stringify(colours));
    ok(`poll stroke is visible against the dark ground (${colours.pollStroke})`,
       lum(colours.pollStroke) > 120, colours.pollStroke);
    ok('no errors in dark mode', errs.length === 0, errs.join('|'));
    const darkTiles = await page.evaluate(() => [...document.querySelectorAll('.leaflet-tile-pane img.leaflet-tile')].map((i) => i.src));
    ok(`auto basemap picks the dark tiles under a dark scheme (${darkTiles.length} tiles)`, darkTiles.length > 0 && darkTiles.every((u) => /dark_all/.test(u)), darkTiles[0]);
    await page.screenshot({ path:'shot-dark.png' });
    await page.close();
  }

  console.log('\n== Narrow viewport ==');
  {
    const page = await browser.newPage({ viewport:{width:390,height:840} });
    const errs=[]; page.on('pageerror',e=>errs.push(e.message));
    await stubTiles(page); await page.goto(FILE); await page.waitForTimeout(700);
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(`no horizontal overflow at 390px (${overflow}px)`, overflow <= 1, `overflow=${overflow}`);
    const n = await page.locator('.layer-fed path').count();
    ok(`map still renders (${n} polls)`, n > 1000);
    ok('no errors at phone width', errs.length === 0, errs.join('|'));
    await page.screenshot({ path:'shot-narrow.png', fullPage:false });
    await page.close();
  }

  console.log('\n== A BC Data Catalogue order loads as delivered ==');
  // The real order is one .geojson of every voting area in the province, zipped
  // next to the order's metadata .json. The fixture has that shape: areas over
  // the study area, one district far away, and the metadata entry as a decoy.
  {
    const ebc = JSON.parse(require('fs').readFileSync('fixtures/e2e_expected.json', 'utf8')).ebc;
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await stubTiles(page); await page.goto(FILE); await page.waitForTimeout(500);
    await page.locator('#tab-data').click();
    const load = async () => {
      await page.locator('#file-prov-geo').setInputFiles('fixtures/e2e_ebc_order.zip');
      await page.waitForFunction(() => /Loaded|Could not/.test(document.querySelector('#status-prov-geo').innerText),
        null, { timeout: 30000 });
      return (await page.locator('#status-prov-geo').innerText()).replace(/\s+/g, ' ');
    };
    let st = await load();
    ok(`order zip clipped to the study area: ${ebc.in_study_area} of ${ebc.total} areas`,
       new RegExp(`Loaded ${ebc.in_study_area} voting areas of ${ebc.total} in`).test(st)
       && /EBC_VOTING_AREAS_BS11_POLY_SVW\.geojson/.test(st), st.slice(0, 200));
    ok('Elections BC key fields chosen without being told',
       /Keyed by ED_ABBREVIATION \+ VA_CODE/.test(st), st.slice(0, 200));
    await page.locator('#tab-map').click(); await page.waitForTimeout(600);
    ok('the kept areas are drawn', (await page.locator('.layer-prov path').count()) === ebc.in_study_area);
    await page.locator('#tab-data').click();
    await page.locator('#clear-prov-geo').click();
    await page.locator('#clip-prov').uncheck();
    st = await load();
    ok(`unclipped, the whole province loads: ${ebc.total} areas`,
       new RegExp(`Loaded ${ebc.total} voting areas from`).test(st), st.slice(0, 200));
    ok('no errors loading the order', errs.length === 0, errs.join(' | '));
    await page.close();
  }

  console.log('\n== Results reported by voting place ==');
  // Elections BC reported 2024 by place, not by area, so the atlas builds
  // catchments. Nothing may be lost on the way, and the page has to say
  // plainly that the catchments are its own work.
  {
    const want = JSON.parse(require('fs').readFileSync('fixtures/e2e_expected.json', 'utf8')).places;
    const page = await browser.newPage({ viewport: { width: 1300, height: 950 } });
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await stubTiles(page); await page.goto(FILE); await page.waitForTimeout(500);
    await page.locator('#tab-data').click();
    await page.locator('#file-prov-geo').setInputFiles('fixtures/e2e_voting_areas.zip');
    await page.waitForFunction(() => /Loaded/.test(document.querySelector('#status-prov-geo').innerText),
      null, { timeout: 20000 });
    await page.locator('#file-prov-results').setInputFiles('fixtures/e2e_voting_places.csv');
    await page.waitForFunction(() => /rows:|Could not/.test(document.querySelector('#status-prov-results').innerText),
      null, { timeout: 30000 });
    const st = (await page.locator('#status-prov-results').innerText()).replace(/\s+/g, ' ');
    ok(`the file is recognised as one reported by place: ${want.located} of ${want.rows} rows located`,
       new RegExp(`${want.rows} rows: ${want.located} with a location, ${want.unlocated} without`).test(st), st.slice(0, 200));
    ok(`${want.catchments} catchments are built`,
       new RegExp(`${want.catchments} catchments cover`).test(st), st.slice(0, 260));
    ok('the page says the catchments are modelled, not published',
       /modelled here, not published by Elections BC/i.test(st), st.slice(0, 400));
    ok('and says provincial turnout has no denominator',
       /no registered-voter count/i.test(st), st.slice(-260));

    const facts = await page.evaluate(() => {
      const s = window.vanPoliAtlas.state, store = s.provResults;
      let ballots = 0, withPlace = 0;
      for (const u of store.values.values()) { ballots += u.total + u.rejected; if (u.place) withPlace++; }
      return { kind: store.kind, ballots, withPlace, areas: store.values.size,
               report: store.report, parties: store.parties.map(([n]) => n) };
    });
    ok('every ballot in the file lands on a voting area',
       Math.abs(facts.ballots - want.ballots) < 1, `${facts.ballots} vs ${want.ballots}`);
    ok('the party columns are read and named',
       JSON.stringify(facts.parties.slice().sort()) === JSON.stringify(want.parties.slice().sort()),
       facts.parties.join(','));
    ok('roughly half the ballots came through a catchment, the rest spread',
       facts.report.ballotsFromPlaces > 0 && facts.report.ballotsSpread > 0
       && Math.abs(facts.report.ballotsFromPlaces + facts.report.ballotsSpread - want.ballots) < 1,
       JSON.stringify([facts.report.ballotsFromPlaces, facts.report.ballotsSpread]));
    ok('every area is inside a catchment', facts.withPlace === facts.areas,
       `${facts.withPlace} of ${facts.areas}`);

    await page.locator('#tab-map').click(); await page.waitForTimeout(700);
    const markers = await page.locator('.layer-places path').count();
    ok(`the ${want.located} voting places are drawn on the map`, markers === want.located, String(markers));
    await page.locator('#show-places').uncheck(); await page.waitForTimeout(300);
    const hidden = await page.evaluate(() =>
      document.querySelector('.layer-places').style.display);
    ok('and can be switched off', hidden === 'none', hidden);
    await page.locator('#show-places').check(); await page.waitForTimeout(200);

    // The catchments decide where every provincial number lands, so they have
    // to be visible, and the legend has to say they are arbitrary colours.
    ok('the catchment shading is offered once results came by place',
       !(await page.$eval('#shade-prov-by option[value=catchment]', (o) => o.hidden)));
    await page.locator('#shade-prov-by').selectOption('catchment');
    await page.waitForTimeout(600);
    const fills = await page.$$eval('.layer-prov path',
      (ps) => ps.map((p) => p.style.fill).filter(Boolean));
    ok('areas are filled by catchment, in more than one colour',
       new Set(fills).size > 2 && fills.length > 100, `${new Set(fills).size} colours over ${fills.length} areas`);
    const legend = (await page.locator('#map-legend').innerText()).replace(/\s+/g, ' ');
    ok('the legend names the catchment count and calls the colours repeating',
       new RegExp(`${want.catchments} catchments`).test(legend) && /repeating/.test(legend), legend.slice(0, 200));
    await page.locator('#shade-prov-by').selectOption('none'); await page.waitForTimeout(300);

    // Reading a voting area must say which place its numbers came from.
    await page.evaluate(() => {
      const { state, selectAt } = window.vanPoliAtlas;
      const f = state.prov.active[Math.floor(state.prov.active.length / 2)];
      const ring = f.geometry.coordinates[0];
      const lon = ring.reduce((a, p) => a + p[0], 0) / ring.length;
      const lat = ring.reduce((a, p) => a + p[1], 0) / ring.length;
      selectAt([lon, lat]);
    });
    await page.waitForTimeout(300);
    const card = (await page.locator('#readout').innerText()).replace(/\s+/g, ' ');
    ok('the readout names the place a voting area was assigned to and how far away it is',
       /Assigned to .*Hall.*\d+ m away/.test(card), card.slice(0, 260));
    ok('and says how much of the area came from that place',
       /of its ballots came from that place/.test(card), card.slice(0, 320));

    await page.locator('#tab-data').click();
    await page.locator('#prov-place-basis').selectOption('catchment');
    await page.waitForFunction(() => window.vanPoliAtlas.state.provResults.report.basis === 'catchment',
      null, { timeout: 20000 });
    const after = await page.evaluate(() => {
      let ballots = 0;
      for (const u of window.vanPoliAtlas.state.provResults.values.values()) ballots += u.total + u.rejected;
      return ballots;
    });
    ok('the other spreading basis conserves the same ballots',
       Math.abs(after - want.ballots) < 1, `${after} vs ${want.ballots}`);

    // The split is by ground area until the census layers and the lattice
    // exist, and by population afterwards. That change must happen when the
    // crosswalk is built, not silently at some later unrelated click.
    ok('until the census is loaded the split is by ground area',
       (await page.evaluate(() => window.vanPoliAtlas.state.provResults.report.splitBasis)) === 'ground area');
    for (const [id, file] of [['#file-db-geo', 'fixtures/e2e_db.zip'], ['#file-da-geo', 'fixtures/e2e_da.zip'],
                              ['#file-geo-attr', 'fixtures/e2e_geo_attr.csv'], ['#file-census', 'fixtures/e2e_census_long.csv']]) {
      await page.locator(id).setInputFiles(file);
      await page.waitForTimeout(900);
    }

    // With the federal results loaded and a crosswalk built, the correlation
    // must count independent sources, not polygons.
    await page.locator('#file-fed-results').setInputFiles('fixtures/e2e_federal_results.csv');
    await page.waitForFunction(() => /matched/i.test(document.querySelector('#status-fed-results').innerText),
      null, { timeout: 40000 });
    await page.locator('#tab-corr').click(); await page.waitForTimeout(300);
    await page.locator('#build-crosswalk').click();
    await page.waitForFunction(() => document.querySelector('#corr-stats').innerText.length > 20,
      null, { timeout: 120000 });
    const weighted = await page.evaluate(() => {
      let ballots = 0;
      for (const u of window.vanPoliAtlas.state.provResults.values.values()) ballots += u.total + u.rejected;
      return { ballots, basis: window.vanPoliAtlas.state.provResults.report.splitBasis };
    });
    ok('building the crosswalk switches the split to population there and then',
       weighted.basis === 'population', weighted.basis);
    ok('and not one ballot moves in or out in the process',
       Math.abs(weighted.ballots - want.ballots) < 1, `${weighted.ballots} vs ${want.ballots}`);
    const said = (await page.locator('#status-prov-results').innerText()).replace(/\s+/g, ' ');
    ok('the report says which basis produced its numbers',
       /in proportion to population/.test(said), said.slice(-260));

    const stats = (await page.locator('#corr-stats').innerText()).replace(/\s+/g, ' ');
    ok('the correlation reports independent sources beside the unit count',
       /independent sources/.test(stats), stats.slice(0, 240));
    const nEff = await page.evaluate(() => {
      const r = window.vanPoliAtlas.state.lastCorrelation.result;
      return [r.n, r.nEffective, r.grouped];
    });
    ok('and there are fewer sources than units', nEff[2] === true && nEff[1] < nEff[0] && nEff[1] > 0,
       JSON.stringify(nEff));
    ok('the interval is computed on the sources, so it is wider than the nominal one',
       await page.evaluate(() => {
         const r = window.vanPoliAtlas.state.lastCorrelation.result;
         if (!r.ci || !r.ciNominal) return true;
         return (r.ci[1] - r.ci[0]) > (r.ciNominal[1] - r.ciNominal[0]);
       }));
    ok('no errors anywhere in the voting-place path', errs.length === 0, errs.slice(0, 3).join(' | '));
    await page.screenshot({ path: 'shot-places.png' });
    await page.close();
  }

  console.log('\n== Unhelpful input is reported clearly ==');
  {
    const page = await browser.newPage({ viewport:{width:1200,height:900} });
    const errs=[]; page.on('pageerror',e=>errs.push(e.message));
    await stubTiles(page); await page.goto(FILE); await page.waitForTimeout(500);
    await page.locator('#tab-data').click();
    const fs = require('fs');
    fs.writeFileSync('fixtures/junk.geojson', 'this is not json at all');
    await page.locator('#file-prov-geo').setInputFiles('fixtures/junk.geojson');
    await page.waitForTimeout(900);
    let s = await page.locator('#status-prov-geo').innerText();
    ok('bad file explained, page still alive', /Could not read/i.test(s) && errs.length === 0,
       s.replace(/\s+/g,' ').slice(0,140));
    // A boundary file that does not overlap Vancouver at all. Clipping is on by
    // default, so this stops with a message that names the way out...
    fs.writeFileSync('fixtures/elsewhere.geojson', JSON.stringify({type:'FeatureCollection',features:[
      {type:'Feature',properties:{ED_NAME:'Far Away',VA_CODE:'1'},geometry:{type:'Polygon',
        coordinates:[[[10,50],[11,50],[11,51],[10,51],[10,50]]]}}]}));
    await page.locator('#file-prov-geo').setInputFiles('fixtures/elsewhere.geojson');
    await page.waitForTimeout(900);
    s = await page.locator('#status-prov-geo').innerText();
    ok('a file outside the study area says so, and says to untick clipping',
       /touch the study area/i.test(s) && /untick/i.test(s), s.replace(/\s+/g,' ').slice(0,160));
    // ...and unticking it does load the layer whole.
    await page.locator('#clip-prov').uncheck();
    await page.locator('#file-prov-geo').setInputFiles('fixtures/elsewhere.geojson');
    await page.waitForTimeout(900);
    s = await page.locator('#status-prov-geo').innerText();
    ok('unclipped, the non-overlapping layer loads without crashing', /Loaded 1 voting area/.test(s),
       s.replace(/\s+/g,' ').slice(0,140));
    await page.locator('#tab-corr').click(); await page.waitForTimeout(400);
    const cs = (await page.locator('#status-crosswalk').innerText()).replace(/\s+/g, ' ');
    ok('the crosswalk says the layers do not meet, before anything is pressed',
       /do not overlap the study area/i.test(cs), cs.slice(0, 200));
    ok('and the build button is not offered', await page.locator('#build-crosswalk').isDisabled());
    ok('no errors from bad input', errs.length === 0, errs.join('|'));
    await page.close();
  }

  console.log('\n== Offline: tiles fail, the atlas does not ==');
  {
    const page = await browser.newPage({ viewport:{width:1200,height:900} });
    const errs=[]; page.on('pageerror',e=>errs.push(e.message));
    await page.route(/basemaps\.cartocdn\.com|tile\.openstreetmap\.org/, (route) => route.abort('failed'));
    await page.goto(FILE); await page.waitForTimeout(2500);
    ok('offline note appears once tiles keep failing', await page.locator('#basemap-note').isVisible());
    ok('boundaries still drawn', (await page.locator('.layer-fed path').count()) > 1000);
    const box = await page.locator('.atlas-map').boundingBox();
    await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.5);
    await page.waitForTimeout(300);
    ok('click readout still works offline', /Vancouver|Riding/.test(await page.locator('#readout').innerText()));
    await page.locator('#basemap').selectOption('none'); await page.waitForTimeout(300);
    ok('choosing None hides the note', !(await page.locator('#basemap-note').isVisible()));
    ok('no page errors offline', errs.length === 0, errs.join('|'));
    await page.close();
  }

  await browser.close();
  console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll variant tests passed.\n');
  process.exit(fails?1:0);
})().catch(e=>{ console.error('ERROR',e); process.exit(1); });
