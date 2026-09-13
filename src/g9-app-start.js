/* --- Start ---------------------------------------------------------------
   Boot sequence and the close of the application IIFE opened in
   g1-app-core.js. New application files are inserted before this one in
   build.py so they share the same scope. */

/* The boundary payload is a sibling of #atlas, not a child of it. */
const payload = document.getElementById('federal-polls');
if (!payload) throw new Error('The embedded federal boundary layer is missing.');
state.fed.all = prepareFederal(JSON.parse(payload.textContent).features);

/* --- Datasets baked into the build ----------------------------------------

   Preparing this atlas's data means downloads from four agencies, a
   multi-gigabyte census profile and a command line. Reading the finished map
   should mean opening a file. So a build can carry its data with it, and a
   reader opens one HTML file with everything already loaded.

   The rule that makes this safe: a baked-in dataset goes in through the SAME
   function the file input calls, with a real File built from the inlined
   bytes. There is no second parsing path to drift out of step with the one
   people actually exercise -- the payload is, quite literally, the file being
   chosen for you.

   Order matters and is not alphabetical. Boundaries must exist before the
   results that land on them, and before a census profile that is filtered to
   the study area as it is read. Each step is awaited for that reason.

   What is never baked in: anything from section 5. An elector roll is names
   and home addresses; it is read in the tab on the campaign's own device and
   the atlas has no business carrying it anywhere. */

function payloadFile(node) {
  const name = node.dataset.filename || 'payload';
  /* A genuine File, so every loader downstream behaves exactly as it does for
     a file a person picked. */
  return new File([new TextEncoder().encode(node.textContent)], name);
}

async function adoptPayloads() {
  const nodes = [...document.querySelectorAll('script[data-payload]')];
  if (!nodes.length) return null;
  const by = {};
  for (const n of nodes) (by[n.dataset.payload] ||= []).push(n);
  const done = [], failed = [];
  /* Each step names the loader the Data tab uses for that input. Anything
     absent from the payload is simply skipped, so a build can carry one
     dataset or all of them. */
  const steps = [
    ['prov-geo', (f) => loadProvincialBoundaries(f[0])],
    ['da-geo', (f) => loadCensusLayer('da', f[0])],
    ['db-geo', (f) => loadCensusLayer('db', f[0])],
    ['geo-attr', (f) => loadGeoAttributes(f[0])],
    ['census', (f) => loadCensusProfile(f[0])],
    ['fed-results', (f) => loadResultFiles(f, 'fed')],
    ['prov-results', (f) => loadResultFiles(f, 'prov')],
    ['prov-electors', (f) => loadProvincialElectors(f[0])],
    ['muni-places', (f) => loadMuniFile(f[0], 'places')],
    ['muni-results', (f) => loadMuniFile(f, 'results')],
  ];
  for (const [key, run] of steps) {
    if (!by[key]) continue;
    try {
      await run(by[key].map(payloadFile));
      done.push(key);
    } catch (err) {
      /* One unreadable payload must not take the rest of the atlas with it.
         The others still load, every file input still works, and the reader is
         told which one failed rather than left with a quietly emptier map. */
      failed.push(`${key}: ${err.message || err}`);
    }
  }
  return { done, failed };
}



draw();
$('basemap').value = defaultBasemap();
applyCartoKey(cartoKey);
$('carto-key').value = cartoKey;
$('carto-key').addEventListener('change', (e) => applyCartoKey(e.target.value));
$('carto-key').addEventListener('input', (e) => { if (!e.target.value.trim()) applyCartoKey(''); });
populateFinders();
refreshCrosswalkStatus();
refreshPartySelectors();
refreshTurnout();
refreshDaShadeVars();
refreshSocio();
refreshResults(true);

/* The payloads load after the first draw, so the map is on screen while they
   arrive rather than after. Each one updates the page as it lands, exactly as
   it would if somebody were choosing the files by hand. */
adoptPayloads().then((payload) => {
  if (!payload) return;
  const LABEL = {
    'prov-geo': 'provincial voting areas', 'da-geo': 'dissemination areas',
    'db-geo': 'dissemination blocks', 'geo-attr': 'block populations',
    census: 'census variables', 'fed-results': 'federal 2025 results',
    'prov-results': 'provincial 2024 results', 'prov-electors': 'provincial electors',
    'muni-places': 'municipal voting places', 'muni-results': 'municipal 2022 results',
  };
  const names = payload.done.map((k) => LABEL[k] || k);
  if (names.length) {
    setStatus('status-payload', 'ok', [
      `Built into this file, with nothing to load: ${names.join(', ')}.`,
      el('p', 'text-small text-muted',
        'Each was read by the same code that reads a file you choose, so loading your own '
        + 'below simply replaces it. Nothing here was uploaded and nothing is fetched: the '
        + 'data is inside this file.'),
      el('p', 'text-small text-muted',
        'Contains information from Elections Canada, Elections BC, the City of Vancouver and '
        + 'Statistics Canada, used under their respective open licences. None of those agencies '
        + 'has endorsed this work or is responsible for it.'),
    ]);
  }
  if (payload.failed.length) {
    setStatus('status-payload', 'error', [
      'Some data built into this file could not be read. Everything else still works, and you '
      + 'can load these yourself below.',
      ...payload.failed.map((f) => el('p', 'text-small', f)),
    ]);
  }
  $('payload-note').hidden = !names.length && !payload.failed.length;
});

/* Watch the map's own box, not #atlas: the atlas changes height on every tab
   switch, and a Leaflet map only needs telling when its container resized. */
let resizeTimer = null, lastMapWidth = 0;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const w = root.querySelector('.map-wrap').getBoundingClientRect().width;
    if (w && w !== lastMapWidth) { lastMapWidth = w; map.invalidateSize({ animate: false }); }
    if (state.lastCorrelation && !$('panel-corr').hidden) {
      drawScatter(state.lastCorrelation.result, state.lastCorrelation.fedParty,
        state.lastCorrelation.provParty);
    }
    if (state.turnout.rows && !$('panel-turnout').hidden) refreshTurnout();
    if (state.socio.table && !$('panel-socio').hidden) drawSocioScatter();
  }, 120);
}).observe(root);
$('tab-map').addEventListener('click', () => setTimeout(() => map.invalidateSize({ animate: false }), 0));

/* The tab row scrolls sideways when it is wider than the screen. Fade whichever
   edge it can still scroll towards, so a phone shows that there are more tabs
   rather than a row that looks complete at "Compare". */
const tabRow = root.querySelector('.nav[role="tablist"]');
const markTabScroll = () => {
  const max = tabRow.scrollWidth - tabRow.clientWidth;
  tabRow.classList.toggle('can-scroll-start', tabRow.scrollLeft > 1);
  tabRow.classList.toggle('can-scroll-end', max > 1 && tabRow.scrollLeft < max - 1);
};
tabRow.addEventListener('scroll', markTabScroll, { passive: true });
new ResizeObserver(markTabScroll).observe(tabRow);
markTabScroll();
/* For the browser console and the test suites: the live state, read-only by
   convention. */
window.vanPoliAtlas = { state, crossPair, map, selectAt, fedValues, provValues };
})();
