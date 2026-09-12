/* --- Start ---------------------------------------------------------------
   Boot sequence and the close of the application IIFE opened in
   g1-app-core.js. New application files are inserted before this one in
   build.py so they share the same scope. */

/* The boundary payload is a sibling of #atlas, not a child of it. */
const payload = document.getElementById('federal-polls');
if (!payload) throw new Error('The embedded federal boundary layer is missing.');
state.fed.all = prepareFederal(JSON.parse(payload.textContent).features);
draw();
setBasemap($('basemap').value);
populateFinders();
refreshCrosswalkStatus();
refreshPartySelectors();
refreshTurnout();

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
  }, 120);
}).observe(root);
$('tab-map').addEventListener('click', () => setTimeout(() => map.invalidateSize({ animate: false }), 0));
})();
