const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
// The build sandbox has no route to tile servers, and an unstubbed tile
// failure reads as a console error. Serve a 1x1 PNG for every tile request and
// record which host was asked, so basemap switching can be asserted.
const ONE_PX_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const tileHosts = [];
/* The atlas opens on the briefing, and map settings live in a drawer. A test
   that is checking what a map setting DOES starts where that setting is: on the
   Map tab, with the drawers open, so the interaction under test is the setting
   and not the route to it. Which tab the atlas opens on, that the drawers start
   shut, and that a baked-in build shuts the data drawer are each asserted on
   their own -- in test-browser, and below for the payload build. */
const openDrawers = async (page) => {
  await page.locator('#tab-map').click();
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('details.disclosure')) d.open = true;
  });
  await page.waitForTimeout(250);
};

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
    await stubTiles(page); await page.goto(FILE); await openDrawers(page); await page.waitForTimeout(500);
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
    await stubTiles(page); await page.goto(FILE); await openDrawers(page); await page.waitForTimeout(500);
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
      await stubTiles(page); await page.goto(FILE); await openDrawers(page); await page.waitForTimeout(500);
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
    await stubTiles(page); await page.goto(FILE); await openDrawers(page); await page.waitForTimeout(600);
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
    /* Opened from disk with no key, the atlas asks for no tiles at all --
       there is no free basemap it can legitimately fetch from a file:// page,
       and a grid of 403s is worse than clean boundaries. */
    const tilesOf = () => page.evaluate(() =>
      [...document.querySelectorAll('.leaflet-tile-pane img.leaflet-tile')].map((i) => i.src));
    const defaultTiles = await tilesOf();
    ok(`a keyless file:// build asks for no tiles, dark scheme or not (${defaultTiles.length})`,
       defaultTiles.length === 0, defaultTiles[0]);
    /* With a key, "auto" still follows the colour scheme, which is the whole
       point of keeping it. */
    await page.locator('#carto-key').fill('TESTKEY123');
    await page.locator('#carto-key').dispatchEvent('change');
    await page.waitForTimeout(1000);
    const darkTiles = await tilesOf();
    ok(`a key under a dark scheme picks the dark tiles (${darkTiles.length} tiles)`,
       darkTiles.length > 0 && darkTiles.every((u) => /dark_all/.test(u)), darkTiles[0]);
    await page.screenshot({ path:'shot-dark.png' });
    await page.close();
  }

  console.log('\n== Narrow viewport ==');
  {
    const page = await browser.newPage({ viewport:{width:390,height:840} });
    const errs=[]; page.on('pageerror',e=>errs.push(e.message));
    await stubTiles(page); await page.goto(FILE); await openDrawers(page); await page.waitForTimeout(700);
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
    await stubTiles(page); await page.goto(FILE); await openDrawers(page); await page.waitForTimeout(500);
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
    await stubTiles(page); await page.goto(FILE); await openDrawers(page); await page.waitForTimeout(500);
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

    // The Results tab is the one place that reports a place file as it arrived:
    // by channel, with the located share stated rather than implied.
    await page.locator('#tab-results').click(); await page.waitForTimeout(600);
    const rs = (await page.locator('#results-status').innerText()).replace(/\s+/g, ' ');
    ok('the summary counts every ballot in the file',
       rs.includes(want.ballots.toLocaleString()), rs.slice(0, 180));
    ok('and names rows and places separately, since they differ',
       new RegExp(`${want.rows} reported rows across ${want.located} voting places`).test(rs), rs.slice(0, 200));
    ok('a file with no elector column says there is no turnout to report',
       /no registered-voter count/.test(rs), rs.slice(0, 260));
    const channels = (await page.locator('#results-channels').innerText()).replace(/\s+/g, ' ');
    ok('how people voted is broken out by opportunity',
       /Final voting/.test(channels) && /Advance voting/.test(channels) && /Vote by mail/.test(channels),
       channels.slice(0, 200));
    ok('the busiest voting places are listed',
       /Busiest voting places/.test(await page.locator('#results-largest-title').innerText()));
    const turnoutCols = await page.$$eval('#results-districts thead th', (ths) => ths.map((t) => t.innerText));
    ok('and the turnout column is dropped rather than shown as dashes',
       !turnoutCols.includes('Turnout'), turnoutCols.join(','));

    // Elections BC keeps the denominator in the Statement of Votes. Given it,
    // turnout is a measurement: ballots over registered voters.
    await page.locator('#tab-data').click();
    await page.locator('#file-prov-electors').setInputFiles('fixtures/e2e_prov_electors.csv');
    await page.waitForFunction(() => /registered voters|Could not/.test(document.querySelector('#status-prov-electors').innerText),
      null, { timeout: 20000 });
    const est = (await page.locator('#status-prov-electors').innerText()).replace(/\s+/g, ' ');
    ok('the denominator column is read, not the "who voted" column beside it',
       /from Electoral District and Registered voters\./.test(est), est.slice(0, 200));
    await page.locator('#tab-results').click(); await page.waitForTimeout(700);
    const withT = await page.$$eval('#results-districts thead th', (ths) => ths.map((t) => t.innerText));
    ok('the turnout column comes back once there is a denominator',
       withT.includes('Turnout'), withT.join(','));
    const firstRow = await page.$$eval('#results-districts tbody tr td', (tds) => tds.slice(0, 3).map((t) => t.innerText));
    ok(`and it is a real rate, not a dash or 100% (${firstRow[2]})`,
       /^\d/.test(firstRow[2]) && parseFloat(firstRow[2]) > 20 && parseFloat(firstRow[2]) < 99, firstRow.join(' | '));
    const rstat = (await page.locator('#results-status').innerText()).replace(/\s+/g, ' ');
    ok('and the tab says where the denominator came from',
       /denominator taken from the file you loaded/.test(rstat), rstat.slice(0, 220));
    await page.locator('#tab-map').click(); await page.waitForTimeout(200);
    await page.locator('#tab-map').click(); await page.waitForTimeout(300);

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
    // --- Two denominators, on the geography the ballots actually landed on ---
    // This is the shape of the real thing: results by voting place, no elector
    // column anywhere in them, a census loaded and a crosswalk built. Neither
    // denominator is a provincial electorate, and both have to be right.
    await page.locator('#tab-turnout').click();
    await page.locator('#turnout-unit').selectOption('prov');
    await page.waitForTimeout(1200);
    const part = await page.evaluate(() => {
      const st = window.vanPoliAtlas.state;
      const out = { areas: 0, withFed: 0, withAdult: 0, withBoth: 0, badRatio: 0, badSpread: 0,
                    ballots: 0, electors: 0, adults: 0, differ: 0 };
      for (const p of (st.provPart || new Map()).values()) {
        out.areas++;
        if (p.perFedElector != null) {
          out.withFed++;
          if (Math.abs(p.perFedElector - p.ballots / p.fedElectors) > 1e-9) out.badRatio++;
        }
        if (p.perAdult != null) {
          out.withAdult++;
          if (Math.abs(p.perAdult - p.ballots / p.adults) > 1e-9) out.badRatio++;
        }
        if (p.perFedElector != null && p.perAdult != null) {
          out.withBoth++;
          if (Math.abs(p.spread - (p.perFedElector - p.perAdult)) > 1e-12) out.badSpread++;
          if (Math.abs(p.spread) > 1e-6) out.differ++;
          out.ballots += p.ballots; out.electors += p.fedElectors; out.adults += p.adults;
        }
      }
      return out;
    });
    ok(`both denominators land on voting areas (${part.withFed} federal, ${part.withAdult} resident, `
       + `${part.withBoth} with both, of ${part.areas})`,
       part.withFed > 0 && part.withAdult > 0 && part.withBoth > 0);
    ok('every ratio is its own ballots over its own denominator', part.badRatio === 0, String(part.badRatio));
    ok('and the spread is exactly the difference between them', part.badSpread === 0, String(part.badSpread));
    ok('the two denominators disagree, which is the reason for reporting both',
       part.differ > part.withBoth * 0.9, `${part.differ}/${part.withBoth}`);
    // Conservation: a count shared out across a crosswalk can lose mass where the
    // target layer does not reach, but it can never gain any. Without this, a
    // share bug would show up only as an implausible-looking ratio.
    const carried = await page.evaluate(() => {
      const st = window.vanPoliAtlas.state;
      let native = 0;
      for (const f of st.fed.active) {
        const u = st.fedResults.values.get(f.idx);
        if (u && u.electors > 0) native += u.electors;
      }
      let onProv = 0;
      for (const p of (st.provPart || new Map()).values()) onProv += p.fedElectors || 0;
      return { native, onProv };
    });
    ok(`federal electors carried onto voting areas conserve mass `
       + `(${Math.round(carried.onProv).toLocaleString()} of ${Math.round(carried.native).toLocaleString()})`,
       carried.onProv > 0 && carried.onProv <= carried.native * 1.0001,
       JSON.stringify(carried));
    const pooled = { fed: part.ballots / part.electors, adult: part.ballots / part.adults };
    ok(`pooled over the covered areas: ${(pooled.fed * 100).toFixed(1)}% of federal electors vs `
       + `${(pooled.adult * 100).toFixed(1)}% of residents 15+`,
       isFinite(pooled.fed) && isFinite(pooled.adult) && pooled.fed > 0 && pooled.adult > 0);
    // A district-level registered-voter count is loaded further up. It gives the
    // Results tab a real turnout per district, and must not make either of these
    // one: a proxy that quietly becomes "turnout" once any elector file exists
    // is exactly the failure this is built to avoid.
    const stillProxy = await page.evaluate(() => {
      const rows = window.vanPoliAtlas.state.turnout.rows || [];
      const withP = rows.filter((r) => r.p && (r.p.perFedElector != null || r.p.perAdult != null));
      return { rows: rows.length, withP: withP.length, anyProvTurnout: rows.some((r) => r.t.prov != null) };
    });
    ok(`a district elector file does not turn a proxy into turnout `
       + `(${stillProxy.withP} rows carry a denominator, provincial turnout per area: `
       + `${stillProxy.anyProvTurnout ? 'reported' : 'still blank'})`,
       stillProxy.withP > 0 && stillProxy.anyProvTurnout === false);
    const theads = await page.$$eval('#turnout-table thead th', (ns) => ns.map((n) => n.textContent));
    ok(`the ranked table heads them by their denominators (${theads.slice(-3).join(' | ')})`,
       theads.includes('Per fed elector') && theads.includes('Per resident 15+') && theads.includes('Spread'));

    ok('no errors anywhere in the voting-place path', errs.length === 0, errs.slice(0, 3).join(' | '));
    await page.screenshot({ path: 'shot-places.png' });
    await page.close();
  }

  console.log('\n== Unhelpful input is reported clearly ==');
  {
    const page = await browser.newPage({ viewport:{width:1200,height:900} });
    const errs=[]; page.on('pageerror',e=>errs.push(e.message));
    await stubTiles(page); await page.goto(FILE); await openDrawers(page); await page.waitForTimeout(500);
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
    await page.goto(FILE); await openDrawers(page); await page.waitForTimeout(600);
    /* A keyless file:// build asks for no tiles, so there is nothing to fail.
       A key is pasted first, which is the case where a reader would actually
       be waiting for tiles that never come. */
    await page.locator('#carto-key').fill('TESTKEY123');
    await page.locator('#carto-key').dispatchEvent('change');
    await page.waitForTimeout(2500);
    ok('offline note appears once tiles keep failing', await page.locator('#basemap-note').isVisible());
    ok('and it says why rather than just that they failed',
       /key|identify|not loading/i.test(await page.locator('#basemap-note').innerText()),
       await page.locator('#basemap-note').innerText());
    ok('boundaries still drawn', (await page.locator('.layer-fed path').count()) > 1000);
    /* Click a point that is genuinely inside a polling division rather than a
       fixed fraction of the map box. The fraction moves with the page's layout
       -- collapsing the options drawer raised the map and made 45%/50% English
       Bay -- and a readout test should fail when the readout breaks, not when
       the page gets shorter. */
    const at = await page.evaluate(() => {
      for (const path of document.querySelectorAll('.layer-fed path')) {
        const r = path.getBoundingClientRect();
        const x = r.x + r.width / 2, y = r.y + r.height / 2;
        if (document.elementFromPoint(x, y) === path) return { x, y };
      }
      return null;
    });
    ok('a polling division is reachable by mouse', at != null, JSON.stringify(at));
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(300);
    ok('click readout still works offline', /Vancouver|Riding/.test(await page.locator('#readout').innerText()));
    await page.locator('#basemap').selectOption('none'); await page.waitForTimeout(300);
    ok('choosing None hides the note', !(await page.locator('#basemap-note').isVisible()));
    ok('no page errors offline', errs.length === 0, errs.join('|'));
    await page.close();
  }

  /* --- A build with the census layer baked in ------------------------------
     Preparing census data is four Statistics Canada downloads and a command
     line; reading the finished map should be opening a file. So the build can
     bake the layer in, and this checks that a reader who does that gets a
     working layer with nothing to load -- and, just as importantly, that a
     build WITHOUT one still works, since the repository ships no census data.

     Everything happens in a temp directory: the committed atlas is built from
     no payload and must stay that way, so no part of this writes into the
     working tree. */
  console.log('\n== A build with the census layer baked in ==');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-census-'));
  try {
    const payload = path.join(work, 'payload');
    const census = path.join(work, 'census');
    fs.mkdirSync(census, { recursive: true });
    fs.copyFileSync('fixtures/e2e_da.zip', path.join(census, 'lda_000b21a_e_clip.zip'));
    fs.copyFileSync('fixtures/e2e_census_starter.csv', path.join(census, 'starter.csv'));
    const made = spawnSync('node', ['tools/make-payload.js', '--census', census,
      '--fed-results', 'fixtures/e2e_federal_results.csv', '--out', payload], { encoding: 'utf8' });
    ok('the payload tool runs', made.status === 0, (made.stderr || made.stdout || '').slice(0, 300));
    ok('it converts the boundaries and names what it wrote',
       /da-geo: 63 dissemination areas/.test(made.stdout), made.stdout.slice(0, 300));
    /* An elector roll must have no way in. There is deliberately no flag for it,
       and this is the assertion that keeps it that way.

       --points-ref is the one nearby flag that IS allowed, and the line between
       them is what the flag carries rather than what it is called: the city's
       property addresses are open data describing buildings, and a roll is
       names and home addresses of people. So the pattern forbids a roll flag by
       every name it might plausibly take while permitting that one explicitly,
       and the checks below pin what it is for -- a guard that can be widened by
       renaming a flag is not a guard. */
    const payloadTool = fs.readFileSync('tools/make-payload.js', 'utf8');
    ok('there is no flag that would bake in a roll of people',
       !/--points(?!-ref)|--roll|--elector(s)?-roll|--voters?\b/.test(payloadTool),
       (payloadTool.match(/--[a-z-]+/g) || []).join(' '));
    ok('and the one address flag there is says it takes buildings, not people',
       /--points-ref/.test(payloadTool)
       && /PROPERTY ADDRESSES, which are open data and\s*\*?\s*carry no people/.test(payloadTool),
       'the --points-ref documentation must state what it carries');
    ok('and the refusal is still written down where somebody adding a flag will read it',
       /WHAT THIS WILL NOT TAKE: an elector roll/.test(payloadTool));
    /* And the build must have no key for one either: a flag is only half of it. */
    ok('no payload key would carry a roll',
       !/"(points|roll|electors-roll)"/.test(fs.readFileSync('build.py', 'utf8')),
       (fs.readFileSync('build.py', 'utf8').match(/PAYLOAD_KEYS[^)]*\)/) || [''])[0]);
    /* Half a payload must fail loudly: boundaries with no variables draw an
       empty map and variables with no boundaries have nothing to join to,
       and either would ship as a working build that shows nothing. */
    /* A directory with nothing the build recognises must say so rather than
       produce an atlas that silently carries nothing. */
    const emptyDir = path.join(work, 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });
    const empty = spawnSync('python3', ['build.py', '--payload', emptyDir,
      '--out', path.join(work, 'empty.html')], { encoding: 'utf8' });
    ok('an empty payload directory refuses to build rather than baking in nothing',
       empty.status !== 0 && /holds nothing to bake in/.test(empty.stderr || empty.stdout),
       (empty.stderr || empty.stdout || '').slice(0, 160));

    const built = path.join(work, 'atlas-census.html');
    const build = spawnSync('python3', ['build.py', '--payload', payload, '--out', built],
      { encoding: 'utf8' });
    ok('the build bakes it in', build.status === 0 && /baked in: .*da-geo/.test(build.stdout),
       (build.stderr || build.stdout || '').slice(0, 200));

    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    await stubTiles(page);
    await page.goto('file://' + built);
    /* A build that carries its data leads with what it has, not with eight file
       inputs, so the replace-data drawer starts shut here -- the opposite of the
       keyless build in test-browser, where loading files is the whole job. */
    const advancedShut = await page.evaluate(() => document.getElementById('advanced-data').open);
    /* On the day a roll arrives, loading it is the whole job -- and it is the
       one section that can never be baked in, so it must not sit inside a
       drawer labelled "replace or add data" that a baked build keeps shut.
       Read here, before openDrawers forces every disclosure open, or it proves
       nothing. */
    await page.locator('#tab-data').click();
    await page.waitForTimeout(300);
    const rollReachable = await page.evaluate(() => {
      const r = document.getElementById('file-points').getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    await openDrawers(page);
    await page.waitForTimeout(1000);
    await page.waitForTimeout(1500);
    const st = await page.evaluate(() => {
      const s = window.vanPoliAtlas.state;
      return { das: s.da.all.length, active: s.da.active.length, bundled: s.censusBundled,
               key: s.da.keyProp, vars: s.da.census ? s.da.census.variables.length : 0,
               fed: Boolean(s.fedResults) };
    });
    ok('the areas are there with nothing loaded', st.das === 63 && st.active === 63, JSON.stringify(st));
    ok('and so are the starter variables', st.vars >= 14, JSON.stringify(st));
    ok('the id field was found', st.key === 'DAUID', String(st.key));
    ok('the federal results came in through the same loader too', st.fed === true, JSON.stringify(st));
    await page.locator('#tab-data').click();
    await page.waitForTimeout(200);
    const note = (await page.locator('#status-payload').innerText()).replace(/\s+/g, ' ');
    /* A payload build is a copy handed to somebody, so it is the one that has
       to answer "which copy is this?" -- and say when it was made from a tree
       with uncommitted changes, which matches no commit. */
    await page.locator('#tab-overview').click();
    await page.waitForTimeout(300);
    const stamp = await page.locator('#overview-stamp').innerText();
    ok('a build made for handing out stamps itself', /Built \d{4}-\d{2}-\d{2}/.test(stamp), stamp);
    ok('and says it carries data', /data baked in/.test(stamp), stamp);
    await page.locator('#tab-data').click();
    await page.waitForTimeout(200);
    ok('a baked-in build starts with the replace-data drawer shut',
       advancedShut === false, String(advancedShut));
    ok('and the roll input is still reachable without opening it',
       rollReachable === true, String(rollReachable));
    /* A baked dataset that fails to load must say so where the reader looks.
       loadPointFile handles its own errors, which is right beside a file input
       and wrong for a payload: adoptPayloads can only record what it is told,
       so a build whose reference failed reported "built into this file, with
       nothing to load" while the reason sat in a collapsed drawer. */
    const badDir = path.join(work, 'badref');
    fs.mkdirSync(path.join(badDir, 'points-ref'), { recursive: true });
    fs.writeFileSync(path.join(badDir, 'points-ref', 'civic-addresses.csv'),
      'NAME,COLOUR\nfoo,red\nbar,blue\n');
    const badOut = path.join(work, 'badref.html');
    spawnSync('python3', ['build.py', '--payload', badDir, '--out', badOut], { encoding: 'utf8' });
    const badPage = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await stubTiles(badPage);
    await badPage.goto('file://' + badOut);
    await badPage.waitForTimeout(1500);
    const badNote = (await badPage.locator('#status-payload').innerHTML()).replace(/<[^>]+>/g, ' ');
    ok('a baked dataset that cannot be read is reported as failed, not as loaded',
       /could not be read/i.test(badNote), badNote.replace(/\s+/g, ' ').slice(0, 200));
    ok('and the reason names the dataset and what it wanted',
       /points-ref/.test(badNote) && /longitude and latitude/.test(badNote),
       badNote.replace(/\s+/g, ' ').slice(0, 260));
    await badPage.close();

    ok('the checklist ticks what was baked in',
       /✓/.test(await page.locator('#readiness-list').innerText()),
       (await page.locator('#readiness-list').innerText()).replace(/\s+/g, ' ').slice(0, 200));
    ok('the Data tab lists what was built in',
       /dissemination areas/.test(note) && /federal 2025 results/.test(note), note.slice(0, 200));
    ok('and says loading your own replaces it', /replaces it/.test(note), note.slice(0, 240));
    ok('and names the agencies whose data it carries',
       /Elections Canada/.test(note) && /Statistics Canada/.test(note), note.slice(-160));
    /* The layer has to be usable, not merely present: shading by a census
       variable is the thing a stakeholder opens the file to do. */
    await page.locator('#tab-map').click();
    await page.waitForTimeout(200);
    await page.locator('#shade-da-var').selectOption('median_hh_income');
    await page.locator('#shade-da-by').selectOption('variable');
    await page.waitForTimeout(600);
    const shaded = await page.evaluate(() => [...document.querySelectorAll('.layer-da path')]
      .filter((n) => n.style.fill && n.style.fill !== 'none').length);
    ok(`the bundled layer shades by a census variable (${shaded})`, shaded > 40, String(shaded));
    ok('no page errors with a baked-in layer', errs.length === 0, errs.slice(0, 3).join(' | '));
    await page.close();
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  /* The committed build has no payload, and must open perfectly well without
     one -- this repository ships no census data. */
  const plain = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const plainErrs = []; plain.on('pageerror', (e) => plainErrs.push(e.message));
  await stubTiles(plain);
  await plain.goto(FILE); await openDrawers(plain);
  await plain.waitForTimeout(700);
  const none = await plain.evaluate(() => ({
    das: window.vanPoliAtlas.state.da.all.length,
    payloads: document.querySelectorAll('script[data-payload]').length,
    fed: window.vanPoliAtlas.state.fed.all.length }));
  ok('the committed build carries no payload at all', none.das === 0 && none.payloads === 0,
     JSON.stringify(none));
  ok('and is otherwise a complete atlas', none.fed > 1000 && plainErrs.length === 0,
     JSON.stringify(none) + plainErrs.join('|'));
  await plain.close();

  await browser.close();
  console.log(fails ? `\n${fails} FAILURE(S)\n` : '\nAll variant tests passed.\n');
  process.exit(fails?1:0);
})().catch(e=>{ console.error('ERROR',e); process.exit(1); });
