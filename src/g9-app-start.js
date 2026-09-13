/* --- Start ---------------------------------------------------------------
   Boot sequence and the close of the application IIFE opened in
   g1-app-core.js. New application files are inserted before this one in
   build.py so they share the same scope. */

/* The boundary payload is a sibling of #atlas, not a child of it. */
const payload = document.getElementById('federal-polls');
if (!payload) throw new Error('The embedded federal boundary layer is missing.');
state.fed.all = prepareFederal(JSON.parse(payload.textContent).features);

/* The census layer, when the build has one baked in. It is optional: a clone
   without the Statistics Canada downloads builds an atlas that works exactly
   as before and loads census data from the Data tab. When it is present, a
   reader opens the file and the layer is simply there -- which is the whole
   point, because preparing census data is a command line and reading the map
   should not be.

   It takes the same route into state as a file loaded by hand, so there is
   only ever one way for a census layer to exist. */
function adoptBundledCensus() {
  const geoNode = document.getElementById('census-da');
  const starterNode = document.getElementById('census-starter');
  if (!geoNode || !starterNode) return null;
  try {
    const fc = JSON.parse(geoNode.textContent);
    const features = fc.features.map((f) => Ingest.normalizeFeature(f));
    adoptCensusLayer('da', {
      features, kept: features.length, records: features.length, filtered: false,
      crs: 'EPSG:4326', crsLabel: 'WGS 84 (EPSG:4326)', label: 'built into this file', warnings: [],
    });
    const table = TextFormats.parseDelimited(starterNode.textContent);
    state.da.census = censusSourceFromWide(table, 'built into this file');
    state.censusBundled = true;
    onCensusChanged();
    return { areas: features.length, variables: state.da.census.variables.length };
  } catch (err) {
    /* A payload that will not parse must not take the rest of the atlas down
       with it: the federal layer, the results and every file loader still
       work, and the Data tab says what happened. */
    setStatus('status-da-geo', 'error', [
      'The census layer built into this file could not be read, so it has been left out. '
      + 'Everything else works; load the boundaries and a profile below to replace it.',
      String(err.message || err)]);
    return null;
  }
}
const bundledCensus = adoptBundledCensus();

draw();
setBasemap($('basemap').value);
populateFinders();
refreshCrosswalkStatus();
refreshPartySelectors();
refreshTurnout();
refreshDaShadeVars();
refreshSocio();
refreshResults(true);

if (bundledCensus) {
  const note = (id, what) => setStatus(id, 'ok', [
    `${fmtInt(bundledCensus.areas)} dissemination areas and ${fmtInt(bundledCensus.variables)} `
    + `starter variables are built into this file — ${what} to use them.`,
    el('p', 'text-small text-muted',
      'Loading your own below replaces them. The full characteristic list is not built in: '
      + 'it is 20–30 MB, so it stays an optional load for whoever wants to go deeper.'),
    el('p', 'text-small text-muted',
      'Adapted from Statistics Canada, Census Profile, 2021 Census of Population, and the 2021 '
      + 'Geographic Attribute File. This does not constitute an endorsement by Statistics Canada.'),
  ]);
  note('status-da-geo', 'nothing to load');
  note('status-census', 'nothing to load');
}

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
/* For the browser console and the test suites: the live state, read-only by
   convention. */
window.vanPoliAtlas = { state, crossPair, map, selectAt, fedValues, provValues };
})();
