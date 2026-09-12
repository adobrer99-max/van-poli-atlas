/* --- Start ---------------------------------------------------------------
   Boot sequence and the close of the application IIFE opened in
   g1-app-core.js. New application files are inserted before this one in
   build.py so they share the same scope. */

/* The boundary payload is a sibling of #atlas, not a child of it. */
const payload = document.getElementById('federal-polls');
if (!payload) throw new Error('The embedded federal boundary layer is missing.');
state.fed.all = prepareFederal(JSON.parse(payload.textContent).features);
draw();
populateFinders();
refreshCrosswalkStatus();
refreshPartySelectors();

let resizeTimer = null;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    draw();
    if (state.lastCorrelation) {
      drawScatter(state.lastCorrelation.result, state.lastCorrelation.fedParty,
        state.lastCorrelation.provParty);
    }
  }, 120);
}).observe(root);
})();
