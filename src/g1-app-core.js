/* ---------------------------------------------------------------------------
   The atlas application: map overlay, data loading, and the correlation view.
--------------------------------------------------------------------------- */
(() => {
const root = document.getElementById('atlas');
const $ = (id) => root.querySelector('#' + id);
const el = (tag, className, text) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
};
const fmtInt = (n) => Math.round(n).toLocaleString();
const fmtPct = (n, dp = 1) => (n == null || !isFinite(n)) ? '--' : (n * 100).toFixed(dp) + '%';
const fmtNum = (n, dp = 3) => (n == null || !isFinite(n)) ? '--' : n.toFixed(dp);

/* The six ridings that make up the City of Vancouver in the 2023
   representation order; UBC and UEL sit in Quadra but outside the city. */
const VANCOUVER_FEDS = new Set(['59035', '59036', '59037', '59038', '59039', '59040']);
const FED_NAMES = {
  '59035': 'Vancouver Centre', '59036': 'Vancouver East',
  '59037': 'Vancouver Fraserview—South Burnaby', '59038': 'Vancouver Granville',
  '59039': 'Vancouver Kingsway', '59040': 'Vancouver Quadra',
};
const POLL_TYPE = { N: 'ordinary', M: 'mobile', S: 'single building' };

const state = {
  fed: { all: [], active: [], index: null },
  prov: { all: [], active: [], index: null, keyDef: null, meta: null },
  fedResults: null,
  provResults: null,
  crosswalk: null,
  pairs: null,
  coverage: null,
  selection: { fed: null, prov: null },
  lastCorrelation: null,
  turnout: { unit: 'fed', weight: 0.5, apportion: { fed: 'none', prov: 'none' },
             minElectors: 50, rows: null, basket: new Set(), sortKey: 'agg', sortDir: 'desc' },
  shadeDomain: {},
  /* Census geography: dissemination areas are drawn and analysed; dissemination
     blocks only weight the crosswalk. Both trim to the federal extent like the
     provincial layer. */
  da: { all: [], active: [], index: null, keyProp: null, meta: null, census: null, variables: [],
        pop: null, shadeVar: null },
  db: { all: [], active: [], index: null, keyProp: null, meta: null, pop: null },
  geoAttr: null,
  /* One lattice sample over every loaded layer, and the crosswalks derived
     from it, cached by layer pair. */
  sample: null,
  cross: new Map(),
  weightingInEffect: null,
  results: { sortKey: 'ballots', sortDir: 'desc' },
  provElectors: null,
  /* Ballots per federal elector and per resident aged 15 and over, by voting
     area. Neither is turnout; see recomputeProvincialParticipation. */
  provPart: null,
  /* A loaded file of places -- addresses, an elector roll -- counted onto each
     layer. `per` is keyed by layer, then by the feature's own index. */
  points: null,
  /* Vancouver's municipal election. Held apart from fedResults and provResults
     because it is a different kind of measurement: you may vote at any voting
     place in the city, so its ballots are smoothed onto areas rather than
     assigned, and it carries no per-area turnout at any point. */
  muni: null,
  muniFiles: { places: null, races: null, overview: null },
  socio: { outcome: 'turnout-agg', minElectors: 50, selected: new Set(), extra: new Map(),
           rows: null, byDa: null, table: null, sortKey: 'absR', sortDir: 'desc', picked: null },
  /* Electors on a roll minus ballots cast, per area, for the pairing the
     Non-voters tab currently has selected. `on` is keyed by layer and then by
     the feature's own index, the way `points` and `muni` are, so the map and
     the readout read it without knowing which tab produced it. */
  /* The measures a target list is ranked on, chosen explicitly and in order.

     Empty is not "nothing to rank on": the export falls back to whatever the
     map is showing, which is how it worked before this existed and is still the
     shortest path for a single measure. What this list adds is the case the map
     cannot express -- three census indicators at once, which are one selector
     and one variable picker on the map and therefore one measure however many
     the reader wants. */
  targets: [],
  /* What was heard at the door: a support score and a contact count per
     address, and the reader's own price list for the answers in their file.
     Never the file itself -- names, notes and numbers are dropped in the read
     and there is no flag that would bake any of it into a shared build. */
  canvass: null,
  nonvoters: { unit: 'fed', roll: '', ballots: 'fed', minRoll: 50, party: '', weight: 1,
               rows: null, on: {}, below: {}, pairing: null, basket: new Set(),
               /* What the reader asked for, as distinct from what is in force.
                  Null until they touch the picker, and written only by them.

                  A payload build loads its datasets one after another, so this
                  tab runs before a roll has been read and falls back to
                  whatever elector count exists by then. Keeping the fallback as
                  if it were a choice pinned the tab to federal electors minus
                  federal ballots with a roll of half a million people loaded
                  and unused. Holding the ASK rather than a was-touched flag
                  also survives the source going away and coming back: clearing
                  a roll drops `roll` to what still resolves, and loading the
                  next one returns to what was asked for. */
               rollWanted: null, ballotsWanted: null,
               sortKey: 'g.notVoted', sortDir: 'desc' },
};

/* Results for one side, apportioned if the Turnout tab asked for it. Every
   reader of results goes through these so the map, the readout and the tab
   agree on which ballots are being counted. */
function resultsFor(side) {
  const store = side === 'fed' ? state.fedResults : state.provResults;
  if (!store || !store.values) return null;
  const mode = state.turnout.apportion[side];
  if (mode === 'none') return store.values;
  const ap = store.apportioned && store.apportioned[mode];
  /* An empty apportionment is not an apportionment. Results reported by
     voting place have nothing left over to apportion -- every ballot was
     already spread -- and an empty Map here would blank the whole side. */
  return ap && ap.values.size ? ap.values : store.values;
}
const fedValues = () => resultsFor('fed');
const provValues = () => resultsFor('prov');

/* Whether the provincial side has an electorate to divide by.

   Elections BC publishes registered voters per electoral district and never per
   voting area, and the 2024 results arrive per voting place with no elector
   column at all -- so with those files this is false, and every provincial
   turnout figure the atlas can form is blank. Not blank as in missing for some
   areas: blank for all of them, in every election the data covers.

   That is a fact about the loaded file rather than a constant, which is why it
   is asked rather than declared. The results reader already maps an electors
   column, so a provincial file that carries one per area makes the rate real,
   and the day Elections BC publishes that file the option comes back on its own
   instead of waiting for somebody to remember this line. */
function provTurnoutPossible() {
  const pv = provValues();
  if (!pv) return false;
  for (const u of pv.values()) if (u && u.electors > 0) return true;
  return false;
}

/* --- Party colours ---------------------------------------------------------
   Conventional Canadian party colours where the party is recognisable, and a
   stable fallback palette otherwise so a party never changes colour mid-session. */
const PARTY_COLOURS = [
  [/\b(liberal|lib)\b/i, '#d71920'],
  [/\bconservative|\bcpc\b|tory/i, '#1a4782'],
  [/\bndp\b|new democratic/i, '#f37021'],
  [/\bgreen\b/i, '#3d9b35'],
  [/bloc|quebecois/i, '#33b2cc'],
  [/people'?s party|\bppc\b/i, '#4b306a'],
  [/\bbc united\b|\bsocial credit\b/i, '#c8102e'],
  [/independent|no affiliation/i, '#8a8a8a'],
];
const FALLBACK_COLOURS = ['#7b5ea7', '#0f8b8d', '#c06c84', '#b08968', '#4a6fa5', '#9a6324'];
const colourCache = new Map();
function partyColour(name) {
  if (colourCache.has(name)) return colourCache.get(name);
  let c = null;
  for (const [re, hex] of PARTY_COLOURS) if (re.test(name)) { c = hex; break; }
  if (!c) c = FALLBACK_COLOURS[colourCache.size % FALLBACK_COLOURS.length];
  colourCache.set(name, c);
  return c;
}

/* --- Feature preparation --------------------------------------------------- */

function prepareFederal(features) {
  return features.map((f, i) => {
    Geo.normalizeWinding(f.geometry);
    const p = f.properties;
    const num = parseInt(p.poll, 10);
    return {
      ...f,
      idx: i,
      key: `${p.fed}/${p.poll}`,
      fedNum: p.fed,
      fedName: FED_NAMES[p.fed] || `Riding ${p.fed}`,
      poll: p.poll,
      pollNum: isFinite(num) ? num : null,
      pollType: p.type,
      outsideCity: Boolean(p.jurisdiction),
      jurisdiction: p.jurisdiction || null,
      locality: p.locality || null,
      /* The advance poll this division reported to, published by Elections
         Canada. It is what lets an advance poll's ballots land on the ten or
         so divisions that fed it instead of the whole riding. */
      advPoll: p.adv || null,
      inVancouver: VANCOUVER_FEDS.has(p.fed) && !p.jurisdiction,
      label: `${FED_NAMES[p.fed] || p.fed} · poll ${p.poll.replace(/-0$/, '')}`,
    };
  });
}

const isPointLike = (f) => f.pollType === 'M' || f.pollType === 'S';

/* Two ridings reach past the city line, and only one of them is UBC. Quadra
   covers the University Endowment Lands; Fraserview--South Burnaby is a third
   Burnaby by electors. The locality on the poll says which, so the option
   named "+ UBC / UEL" adds UBC and nothing else -- Burnaby appears only under
   "everything in the file", like the other Metro ridings in the payload. */
const UBC_LOCALITY = 'Metro Vancouver A';

/* The study area: what the Area control admits, mobile polls included. This is
   a statement about geography, so nothing that only changes the drawing is
   allowed to narrow it. */
function federalStudyArea() {
  const area = $('area-filter').value;
  return state.fed.all.filter((f) => {
    if (area !== 'all' && !VANCOUVER_FEDS.has(f.fedNum)) return false;
    if (area === 'van' && f.outsideCity) return false;
    if (area === 'van-ubc' && f.outsideCity && f.locality !== UBC_LOCALITY) return false;
    return true;
  });
}

/* What is drawn and ranked: the study area, less anything the reader has
   switched off. */
function activeFederal() {
  const showMobile = $('show-mobile').checked;
  return federalStudyArea().filter((f) => showMobile || !isPointLike(f));
}

/* Provincial features are trimmed to those touching the federal extent so a
   province-wide download does not drag the whole of BC into every redraw. */
function activeProvincial(fedExtent) {
  if (!state.prov.all.length || !fedExtent) return [];
  const [x0, y0, x1, y1] = fedExtent;
  return state.prov.all.filter((f) => {
    const b = Geo.bboxOf(f.geometry);
    return b[0] <= x1 && b[2] >= x0 && b[1] <= y1 && b[3] >= y0;
  });
}

/* Any other layer trims the same way. */
function activeWithin(layer, fedExtent) {
  if (!layer.all.length || !fedExtent) return [];
  const [x0, y0, x1, y1] = fedExtent;
  return layer.all.filter((f) => {
    const b = Geo.bboxOf(f.geometry);
    return b[0] <= x1 && b[2] >= x0 && b[1] <= y1 && b[3] >= y0;
  });
}

function extentOf(features) {
  let e = [Infinity, Infinity, -Infinity, -Infinity];
  for (const f of features) {
    const b = Geo.bboxOf(f.geometry);
    if (!isFinite(b[0])) continue;
    e = [Math.min(e[0], b[0]), Math.min(e[1], b[1]), Math.max(e[2], b[2]), Math.max(e[3], b[3])];
  }
  return isFinite(e[0]) ? e : null;
}

/* Label a provincial feature from whichever fields were chosen as its key. */
function provLabel(f) {
  const k = state.prov.keyDef;
  if (!k) return 'Voting area';
  const d = k.district ? String(f.properties[k.district] ?? '').trim() : '';
  const v = k.poll ? String(f.properties[k.poll] ?? '').trim() : '';
  return d && v ? `${d} · VA ${v}` : (v || d || 'Voting area');
}

/* --- Map ------------------------------------------------------------------- */

/* --- Map (Leaflet) ----------------------------------------------------------
   One pane and one SVG renderer per layer, so `.layer-fed path` and
   `.layer-prov path` stay countable and stylable exactly as before. Every
   path gets its feature bound as d3's __data__, which lets the d3-style
   callbacks below (fill, classes, basket marks) keep working untouched on
   selections of the panes. Clicks are handled once at map level with a
   latlng; hit-testing stays in Geo, so the readout is always point-based.
   Shift-click is the basket gesture, so Leaflet's shift-drag box zoom is off. */
/* A centre and zoom at construction matter: Leaflet defers adding layers
   until the map has a view, and draw() binds each path's feature the moment
   the layer is added. Without a view the paths would not exist yet. */
const map = L.map($('atlas-map'), {
  center: [49.25, -123.12], zoom: 12,
  zoomSnap: 0.25, zoomControl: true, attributionControl: true, boxZoom: false,
  worldCopyJump: false, maxZoom: 20, minZoom: 9,
});
map.createPane('fed').classList.add('layer-fed');
map.getPane('fed').style.zIndex = 410;
map.createPane('prov').classList.add('layer-prov');
map.getPane('prov').style.zIndex = 420;
const fedLayer = L.geoJSON(null, {
  pane: 'fed', renderer: L.svg({ pane: 'fed' }), className: 'poll', weight: 0.6, fill: true,
}).addTo(map);
const provLayer = L.geoJSON(null, {
  pane: 'prov', renderer: L.svg({ pane: 'prov' }), className: 'va', fill: false,
}).addTo(map);
/* Voting places sit above every polygon: they are the thing the provincial
   results were actually reported at, and the catchments below them are only a
   model of who went where. */
map.createPane('places').classList.add('layer-places');
map.getPane('places').style.zIndex = 430;
const placesLayer = L.layerGroup([], { pane: 'places' }).addTo(map);

map.createPane('da').classList.add('layer-da');
map.getPane('da').style.zIndex = 405;
const daLayer = L.geoJSON(null, {
  pane: 'da', renderer: L.svg({ pane: 'da' }), className: 'da', fill: false,
}).addTo(map);
const gFed = d3.select(map.getPane('fed'));
const gProv = d3.select(map.getPane('prov'));
const gDa = d3.select(map.getPane('da'));

/* Basemaps. Tiles are the only thing in the file that ever touches the
   network; without them the boundaries and every analysis still work, which is
   why "None" is a first-class choice here rather than a failure state.

   Both free options changed under this atlas within a month of each other, and
   the way they changed decides the design:

   CARTO stamped keyless tiles with API KEY REQUIRED at the end of August 2026.
   The key is free and takes a minute to get, and a build can carry one, so
   this is a solvable problem.

   OpenStreetMap's standard tiles cannot be used here at all. Their usage
   policy requires a Referer or User-Agent that identifies the application, and
   a page opened from a file:// URL sends no Referer -- so the request arrives
   unidentified and comes back 403 Access blocked. No amount of code fixes
   that: a browser will not let a script set either header. It is kept as an
   option because the atlas can also be served over http, where a Referer does
   go, but it is labelled rather than offered as though it worked.

   So the default is None unless the build carries a CARTO key, which is the
   honest position: a map with no basemap is complete and correct, and a map
   covered in somebody's billing notice or in 403 tiles is neither. */

const cartoKeyNode = document.getElementById('carto-key-payload');
let cartoKey = cartoKeyNode ? cartoKeyNode.textContent.trim() : '';

const keyed = (url) => (cartoKey ? `${url}?key=${encodeURIComponent(cartoKey)}` : url);
const BASEMAPS = {
  positron: {
    url: () => keyed('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'),
    subdomains: 'abcd', maxZoom: 20, needsKey: true,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  },
  dark: {
    url: () => keyed('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'),
    subdomains: 'abcd', maxZoom: 20, needsKey: true,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  },
  osm: {
    url: () => 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    subdomains: 'abc', maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
};

let tileLayer = null, tileErrors = 0, tileLoaded = false;
const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');
function resolveBasemap(mode) {
  if (mode === 'auto') return darkScheme.matches ? 'dark' : 'positron';
  return mode;
}

/* The default is whichever basemap will actually work where the file is
   opened, which is not the same question in both places.

   Served over http or https, the browser sends a Referer, OpenStreetMap can
   identify the page, and their standard tiles are fine for a tool with a
   handful of users -- so that is the default and it needs no key.

   Opened from disk there is no Referer, OSM returns 403 Access blocked, and
   CARTO wants a key. So a file:// build defaults to a street map only if it
   carries a CARTO key, and otherwise to None: boundaries only, which is
   complete and correct rather than a grid of error tiles. */
const servedOverHttp = /^https?:$/.test(window.location.protocol);
function defaultBasemap() {
  if (servedOverHttp) return 'osm';
  return cartoKey ? 'auto' : 'none';
}

function applyCartoKey(value) {
  cartoKey = String(value || '').trim();
  for (const id of ['positron', 'dark', 'auto']) {
    const option = $('basemap').querySelector(`option[value="${id}"]`);
    if (option) option.disabled = !cartoKey;
  }
  if (!cartoKey && ['positron', 'dark', 'auto'].includes($('basemap').value)) {
    $('basemap').value = 'none';
  } else if (cartoKey && $('basemap').value === 'none') {
    /* Somebody who pastes a key wants to see streets; making them then choose
       a basemap as well is a second step for no reason. */
    $('basemap').value = 'auto';
  }
  setBasemap($('basemap').value);
}
function setBasemap(mode) {
  if (tileLayer) { map.removeLayer(tileLayer); tileLayer = null; }
  tileErrors = 0; tileLoaded = false;
  $('basemap-note').hidden = true;
  const key = resolveBasemap(mode);
  const def = BASEMAPS[key];
  root.classList.toggle('basemap-none', !def);
  if (!def) return;
  tileLayer = L.tileLayer(def.url(), {
    subdomains: def.subdomains, maxZoom: def.maxZoom, attribution: def.attribution, detectRetina: false,
  });
  /* Eight failures with nothing loaded is offline, not a slow tile -- or, far
     more likely now, a provider refusing the request. The note says which,
     because "the tiles are not loading" sends someone to check their wifi when
     the answer is a missing key or a usage policy. */
  tileLayer.on('tileerror', () => {
    tileErrors++;
    if (tileErrors >= 8 && !tileLoaded) {
      $('basemap-note').hidden = false;
      const why = key === 'osm' && !servedOverHttp
        ? 'OpenStreetMap refuses tiles to a page it cannot identify, and a file opened from disk '
          + 'sends nothing to identify it. Serve this page over http, choose None, or paste a '
          + 'CARTO key above.'
        : def.needsKey && !cartoKey
          ? 'CARTO needs a free API key since August 2026. Paste one above, or choose None.'
          : 'The tiles are not loading. The map and every figure on it still work; choose None to stop asking.';
      $('basemap-note').textContent = why;
    }
  });
  tileLayer.on('tileload', () => { tileLoaded = true; $('basemap-note').hidden = true; });
  tileLayer.addTo(map);
}
darkScheme.addEventListener('change', () => { if ($('basemap').value === 'auto') setBasemap('auto'); });

/* How a figure was arrived at, in three words, shared by every surface that
   shows one -- the briefing's finding cards, the Compare tiles, the
   Neighbourhood profile tiles. It lives here rather than beside the briefing
   because those two tabs are built before it, and a vocabulary that only some
   surfaces can reach is how two of them end up disagreeing.

   Counted: the agency reported this number for this area. Modelled: it was
   moved onto a geography its source does not use. Smoothed: municipal ballots,
   which are spread by distance because you may vote anywhere in the city. */
const PROVENANCE = {
  counted: ['Counted', 'Reported for these areas by the agency that ran the election.'],
  modelled: ['Modelled geography', 'Moved between geographies that share no boundaries; read '
    + '“How to read this” before quoting it.'],
  smoothed: ['Smoothed, not assigned', 'Municipal ballots are spread by distance because you '
    + 'may vote at any place in the city.'],
};

/* What the turnout figures anywhere in this atlas actually divide by what.

   Electors are registered to a polling division whatever they later do, so the
   denominator is always everyone. The numerator is not: advance and special
   ballots are reported without a boundary, and the Turnout tab's default is to
   leave them out, which is honest there because the control says so in as many
   words -- "Leave out (election-day turnout)".

   A headline that repeats the number without that qualifier turns a defensible
   election-day figure into a wrong turnout figure, and it is wrong by however
   large advance voting was. So the name of the measure changes with the
   setting, and every surface that prints one of these figures -- the briefing,
   the map legend, the readout card, the Turnout tab's own tiles -- takes its
   wording from here. A qualifier that lives next to one control does not travel
   with the number, and the number is what gets quoted. */
/* The same question for one side, because a federal card must not be qualified
   by the provincial setting or the other way round. */
function sideBasisShort(side) {
  const a = state.turnout.apportion || {};
  const loaded = side === 'fed' ? state.fedResults : state.provResults;
  return loaded && a[side] === 'none' ? 'election-day ballots only' : '';
}

function turnoutBasis() {
  const a = state.turnout.apportion || {};
  const loose = [];
  if (state.fedResults && a.fed === 'none') loose.push('federal advance and special');
  if (state.provResults && a.prov === 'none') loose.push('provincial advance and absentee');
  const modelled = Boolean(state.pairs);
  if (!loose.length) {
    return { name: 'Aggregate turnout', short: '', badge: modelled ? 'modelled' : 'counted', note: '' };
  }
  const whole = loose.length === 2 || !state.pairs;
  return {
    name: whole ? 'Election-day turnout' : 'Aggregate turnout, partly election-day',
    short: whole ? 'election-day ballots only' : 'partly election-day',
    badge: modelled ? 'modelled' : 'counted',
    note: ` — ${loose.join(' and ')} ballots are left out, so this is below `
      + 'the turnout the agency reports. Apportion them on the Turnout tab to include them.',
  };
}

function fitAll() {
  const extent = extentOf(state.fed.active) || extentOf(state.prov.active);
  if (extent) map.fitBounds([[extent[1], extent[0]], [extent[3], extent[2]]], { padding: [12, 12], animate: false });
  else map.setView([49.25, -123.12], 12);
}

/* The value a feature is shaded by, for one layer and one mode. Federal modes
   read the 2025 results by feature index; the provincial-on-federal modes need
   the crosswalk (state.provOnFed); the provincial layer's own modes read the
   2024 results by f.__idx and need no crosswalk at all. */
function shadeValue(layerKey, f, mode, fedParty, provParty, muniParty) {
  if (mode === 'none' || mode === 'type' || mode === 'flat') return null;
  if (POINT_MODES.has(mode)) return pointsValue(layerKey, f, mode);
  if (MUNI_MODES.has(mode)) return muniValue(layerKey, f, mode, muniParty);
  if (NONVOTER_MODES.has(mode)) return nonvotersValue(layerKey, f, mode);
  if (layerKey === 'prov') {
    if (PART_MODES.has(mode)) {
      const p = state.provPart && state.provPart.get(f.__idx);
      if (!p) return null;
      return mode === 'prov-per-elector' ? p.perFedElector : p.perAdult;
    }
    const u = provValues()?.get(f.__idx);
    if (!u) return null;
    if (mode === 'prov-party') return provParty ? Analysis.shareOf(u, provParty) : null;
    if (mode === 'turnout-prov') return Turnout.rate(u);
    return null;
  }
  if (layerKey === 'da') {
    if (mode === 'variable') return state.da.shadeVar ? (state.da.shadeVar.get(f.__idx) ?? null) : null;
    const row = state.socio.byDa && state.socio.byDa.get(f.__idx);
    if (!row) return null;
    if (mode === 'turnout-agg') return row.agg;
    if (mode === 'turnout-fed') return row.t.fed;
    if (mode === 'turnout-prov') return row.t.prov;
    return null;
  }
  const fedUnit = fedValues()?.get(f.idx);
  const provOnFed = state.provOnFed && state.provOnFed.get(f.idx);
  const fedShare = fedUnit && fedParty ? Analysis.shareOf(fedUnit, fedParty) : null;
  const provShare = provOnFed && provParty ? Analysis.shareOf(provOnFed, provParty) : null;
  const tf = Turnout.rate(fedUnit), tp = Turnout.rate(provOnFed);
  switch (mode) {
    case 'fed-party': return fedShare;
    case 'prov-party': return provShare;
    case 'gap': return fedShare == null || provShare == null ? null : fedShare - provShare;
    case 'turnout-fed': return tf;
    case 'turnout-prov': return tp;
    case 'turnout-agg': {
      /* Same rule as Turnout.score: a weighted mean over the sides present. */
      const w = state.turnout.weight;
      let num = 0, den = 0;
      if (tf != null) { num += w * tf; den += w; }
      if (tp != null) { num += (1 - w) * tp; den += 1 - w; }
      return den > 0 ? num / den : null;
    }
    case 'turnout-delta': return tf == null || tp == null ? null : tf - tp;
    default: return null;
  }
}

const TYPE_FILL = { N: 'var(--muted)', M: 'var(--viz-series-5)', S: 'var(--viz-series-6)' };
const TURNOUT_MODES = new Set(['turnout-fed', 'turnout-prov', 'turnout-agg']);
/* Provincial ballots over a denominator that is not a provincial electorate.
   They ramp like a turnout because they are the same shape of number, and they
   are kept out of TURNOUT_MODES because they are not one. */
const PART_MODES = new Set(['prov-per-elector', 'prov-per-resident']);
/* A loaded point file, counted or weighted, on whichever layer is being
   shaded. Both ramp on the data like the turnout modes do. */
const POINT_MODES = new Set(['points-count', 'points-weight']);
/* The municipal election offers a party share and a ballots-cast surface, and
   deliberately no turnout. Measured against the federal turnout surface, a
   municipal rate built from voting places agrees at about r 0.2 however it is
   smoothed -- the voting place network, not the electorate, is most of what
   such a map would show. The city-wide rate the city publishes is shown on the
   Results tab instead, as the single figure it honestly is. */
const MUNI_MODES = new Set(['muni-party', 'muni-ballots']);
/* Electors on a roll minus ballots cast, from the Non-voters tab. Deliberately
   not called `gap-*`: `gap` is already this atlas's name for federal minus
   provincial party share, three lines up in the same select, and one word
   meaning two things in one legend is how a wrong screenshot happens. */
const NONVOTER_MODES = new Set(['nonvoters-count', 'nonvoters-share']);

/* What the municipal spread put on this feature, keyed the way each layer
   indexes itself. */
function muniUnit(layerKey, f) {
  const on = state.muni && state.muni.on && state.muni.on[layerKey];
  if (!on) return null;
  return on.get(layerKey === 'fed' ? f.idx : f.__idx) || null;
}

/* muniParty is for callers that know which party they mean rather than which
   party the map is showing -- a target list names its own, and reading the
   selector there would rank a file by a party nobody chose for it. Omitted, it
   falls back to the selector, which is what every shading path wants. */
function muniValue(layerKey, f, mode, muniParty) {
  const u = muniUnit(layerKey, f);
  if (!u) return null;
  if (mode === 'muni-ballots') return u.ballots;
  const party = muniParty != null ? muniParty : ($('muni-party') ? $('muni-party').value : '');
  return party ? Analysis.shareOf(u, party) : null;
}

/* A municipal shading names itself the same way on whichever layer is carrying
   it, and says "smoothed" where the number is a model's output rather than a
   count of anything that happened inside the area. */
function muniLegend(mode, layerKey, on) {
  const where = { fed: 'on federal polls', prov: 'on voting areas', da: 'on dissemination areas' }[layerKey];
  if (mode === 'muni-party') {
    const party = $('muni-party') ? $('muni-party').value : '';
    if (!party) return [];
    return [[partyColour(party), `${party} share, 2022 municipal, ${where}`],
            ['note', 'Smoothed by distance from each voting place, not assigned: you may vote '
             + 'anywhere in Vancouver, so a ballot says less about where its voter lives.']];
  }
  const dom = state.shadeDomain[layerKey];
  return [['var(--viz-series-3)',
           `2022 municipal ballots ${where}, smoothed`
           + (dom ? ` — ${fmtInt(dom.lo)} to ${fmtInt(dom.hi)}` : '')],
          ['note', 'Ballots, not turnout. This atlas reports no municipal turnout by area; '
           + '“How to read this” says why.']];
}

/* What a loaded point file put on this feature. Keyed by the feature's own
   index, which is `idx` federally and `__idx` everywhere else. */
function pointsValue(layerKey, f, mode) {
  const per = state.points && state.points.per && state.points.per[layerKey];
  if (!per) return null;
  const a = per.get(layerKey === 'fed' ? f.idx : f.__idx);
  if (!a) return null;
  return mode === 'points-weight' ? a.weight : a.count;
}

/* What the Non-voters tab put on this feature, for the selected pairing. Keyed
   the same way as the points and municipal surfaces. Absent means the roll
   never mentioned this area, which is not a non-voter count of zero -- a
   division outside the city the roll was drawn for has no entry at all, and
   shading it as an empty area would say something false about it. */
function nonvotersValue(layerKey, f, mode) {
  const on = state.nonvoters && state.nonvoters.on && state.nonvoters.on[layerKey];
  if (!on) return null;
  const a = on.get(layerKey === 'fed' ? f.idx : f.__idx);
  if (!a) return null;
  return mode === 'nonvoters-share' ? a.share : a.notVoted;
}

/* One rule holds on every surface this feature has: a non-voter figure never
   appears without both halves of the subtraction named beside it. muniLegend
   is the working precedent, and for the same reason -- the number alone reads
   as a measurement of one thing when it is the difference between two. */
function nonvotersLegend(mode, layerKey) {
  const nv = state.nonvoters;
  const on = nv && nv.on && nv.on[layerKey];
  if (!on || !on.size || !nv.pairing) return [];
  const dom = state.shadeDomain[layerKey];
  const share = mode === 'nonvoters-share';
  const range = dom ? (share ? ` — ${fmtPct(dom.lo, 0)} to ${fmtPct(dom.hi, 0)}`
                             : ` — ${fmtInt(dom.lo)} to ${fmtInt(dom.hi)}`) : '';
  const out = [['var(--viz-series-4)',
    `Did not vote${share ? ', share of roll' : ''} · ${nv.pairing.label}${range}`]];
  out.push(['note', `${routePhrase(nv.pairing.rollRoute, 'the roll')}; `
    + `${routePhrase(nv.pairing.ballotRoute, 'the ballots')}.`]);
  return out;
}

/* How a half of the subtraction reached this geography, in the atlas's own
   three words. `interpolated` is the vocabulary f8-roll.js uses and
   `modelled geography` is the one every other surface here uses; they are the
   same claim, and the reader should only ever meet the second. */
const ROUTE_PROVENANCE = { counted: 'counted', interpolated: 'modelled', smoothed: 'smoothed' };
function routePhrase(route, who) {
  if (route === 'counted') return `${who} were counted on these areas`;
  if (route === 'smoothed') {
    return `${who} were spread by distance from each voting place, not counted inside these areas`;
  }
  return `${who} were moved onto these areas from the geography they were reported on`;
}

/* The same figure, for the readout, phrased for whichever file is loaded. */
/* Which id a layer keys its points by: the federal features carry idx and the
   others __idx. One copy of that choice, because the readout and both exports
   have to agree on it and two copies is one too many. */
function pointsFor(layerKey, feature) {
  const p = state.points;
  if (!p || !p.per || !p.per[layerKey] || !feature) return null;
  return p.per[layerKey].get(layerKey === 'fed' ? feature.idx : feature.__idx) || null;
}

/* The columns a loaded file of places adds to an export, or null when none is
   loaded -- in which case the export keeps exactly the shape it had.

   The names are fixed rather than built from the noun. A schema that renames
   its own columns depending on which file somebody loaded is one no script can
   be written against; the noun rides along in its own column instead, so the
   file still says whether those counts are electors or addresses. */
function pointsColumns(layerKey, featureOf) {
  const p = state.points;
  if (!p || !p.per || !p.per[layerKey]) return null;
  const weighted = Boolean(p.weighted);
  return {
    headers: ['points_count', ...(weighted ? ['points_weight'] : []), 'points_noun'],
    of: (row) => {
      const a = pointsFor(layerKey, featureOf(row));
      return [a ? a.count : 0, ...(weighted ? [a ? a.weight : 0] : []),
              weighted ? (p.weightNoun || p.noun || 'points') : (p.noun || 'points')];
    },
  };
}

function pointsLine(layerKey, f) {
  const p = state.points;
  if (!p || !p.per || !p.per[layerKey]) return null;
  const a = pointsFor(layerKey, f);
  const noun = p.noun || 'points';
  if (!a) return `no ${noun} here`;
  return p.weighted
    ? `${fmtInt(a.count)} ${noun} · ${fmtInt(a.weight)} ${p.weightNoun || 'weighted'}`
    : `${fmtInt(a.count)} ${noun}`;
}
/* The municipal line on a readout card. It says "ballots", never "turnout",
   and it says smoothed, because the number is a model's output rather than a
   count of anything that happened inside this area. */
function muniLine(layerKey, f) {
  const u = muniUnit(layerKey, f);
  if (!state.muni) return null;
  if (!u) return 'no municipal ballots reached this area';
  const party = $('muni-party') ? $('muni-party').value : '';
  const share = party ? Analysis.shareOf(u, party) : null;
  return `${fmtInt(u.ballots)} municipal ballots (smoothed)`
    + (share == null ? '' : ` · ${party} ${fmtPct(share)}`);
}

/* The non-voter line on a readout card. Both half-labels travel with it, and
   the word "counted" appears only where both halves were. */
function nonvotersLine(layerKey, f) {
  const nv = state.nonvoters;
  const on = nv && nv.on && nv.on[layerKey];
  if (!on || !on.size || !nv.pairing) return null;
  const id = layerKey === 'fed' ? f.idx : f.__idx;
  const a = on.get(id);
  if (!a) {
    /* Two different absences, and only one of them is the interesting one. An
       area held out by the minimum does have a roll entry; saying it has none
       would report a setting on this tab as a fact about the roll. */
    const small = nv.below && nv.below[layerKey] && nv.below[layerKey].get(id);
    return small != null
      ? `${fmtInt(small)} on the roll — under the minimum this tab is set to, so it is out of `
        + 'the table and the ranking'
      : 'no roll entry for this area, which is not a roll of zero';
  }
  return `${fmtInt(a.notVoted)} did not vote (${fmtPct(a.share)} of the roll) · `
    + `${nv.pairing.label} · ${ROUTE_PROVENANCE[nv.pairing.route]}`
    + (a.mailRank ? ` · mail priority ${fmtInt(a.mailRank)}` : '');
}

/* Modes whose ramp follows the data on the map rather than a fixed scale. */
const DATA_MODES = new Set([...TURNOUT_MODES, ...PART_MODES, ...POINT_MODES,
                            ...NONVOTER_MODES, 'muni-ballots', 'variable']);

/* Turnout ramps are data-driven -- 5th to 95th percentile of what is on the
   map -- because a fixed scale would either wash out or saturate depending on
   the election. Party shares keep a fixed 60% saturation so a 40% share looks
   the same in every riding. */
function shadeDomain(layerKey, sel, mode, fedParty, provParty) {
  const vals = [];
  sel.each((f) => {
    const v = shadeValue(layerKey, f, mode, fedParty, provParty);
    if (v != null && isFinite(v)) vals.push(v);
  });
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * (vals.length - 1)))];
  const lo = q(0.05), hi = q(0.95);
  return { lo, hi: hi > lo ? hi : lo + 1e-9, n: vals.length };
}

function rampT(mode, v, domain) {
  if (mode === 'gap') return Math.min(1, Math.abs(v) / 0.3);
  if (mode === 'turnout-delta') return Math.min(1, Math.abs(v) / 0.15);
  if (DATA_MODES.has(mode) && domain) {
    return Math.max(0, Math.min(1, (v - domain.lo) / (domain.hi - domain.lo)));
  }
  return Math.min(1, v / 0.6);
}

function fillColour(mode, v, fedParty, provParty) {
  if (mode === 'gap') return v >= 0 ? partyColour(fedParty) : partyColour(provParty);
  if (mode === 'turnout-delta') return v >= 0 ? 'var(--viz-series-1)' : 'var(--viz-series-2)';
  if (mode === 'variable') return 'var(--viz-series-3)';
  if (TURNOUT_MODES.has(mode)) return 'var(--viz-series-1)';
  if (mode === 'prov-per-elector') return 'var(--viz-series-4)';
  if (mode === 'prov-per-resident') return 'var(--viz-series-5)';
  if (POINT_MODES.has(mode)) return 'var(--viz-series-6)';
  if (mode === 'muni-ballots') return 'var(--viz-series-3)';
  if (mode === 'muni-party') return partyColour($('muni-party') ? $('muni-party').value : '');
  if (mode === 'fed-party') return partyColour(fedParty);
  if (mode === 'prov-party') return partyColour(provParty);
  return 'var(--muted)';
}

/* Inline style, not a presentation attribute: the .poll / .va stylesheet rules
   set default fills, and a stylesheet rule always beats an attribute in SVG.
   A null value removes the inline style so the stylesheet applies again. */
const LAYER_SERIES = { prov: 'var(--viz-series-2)', da: 'var(--viz-series-3)' };
/* Catchment colours mean only "served by the same voting place". They cycle,
   they carry no order, and no catchment owns one -- which is why the legend
   says so rather than listing them. */
const CATCHMENT_FILL = ['var(--viz-series-1)', 'var(--viz-series-2)', 'var(--viz-series-3)',
  'var(--viz-series-4)', 'var(--viz-series-5)', 'var(--viz-series-6)'];

/* The catchment a voting area belongs to, or -1 when it only ever took a
   district-wide spread and so belongs to none. */
function catchmentOf(f) {
  const store = state.provResults;
  if (store?.kind !== 'places' || !store.assigned || f.__idx == null) return -1;
  return store.assigned.assignment[f.__idx] ?? -1;
}

function styleLayer(layerKey, sel) {
  const fedParty = $('shade-party-fed').value;
  const provParty = $('shade-party-prov').value;
  const mode = layerKey === 'fed' ? $('shade-by').value
    : layerKey === 'prov' ? $('shade-prov-by').value : $('shade-da-by').value;
  const domain = DATA_MODES.has(mode) ? shadeDomain(layerKey, sel, mode, fedParty, provParty) : null;
  state.shadeDomain[layerKey] = domain;
  /* The provincial and census layers are overlays: outline-only unless shaded,
     and their fill strength follows the one slider. */
  const isOverlay = layerKey !== 'fed';
  const base = isOverlay ? parseFloat($('prov-opacity').value) : 1;
  const series = LAYER_SERIES[layerKey] || 'var(--muted)';
  sel.style('fill', (f) => {
    if (isOverlay && mode === 'none') return null;
    if (isOverlay && mode === 'flat') return series;
    if (mode === 'type') return TYPE_FILL[f.pollType] || 'var(--muted)';
    if (mode === 'catchment') {
      const c = catchmentOf(f);
      return c < 0 ? null : CATCHMENT_FILL[c % CATCHMENT_FILL.length];
    }
    const v = shadeValue(layerKey, f, mode, fedParty, provParty);
    if (v == null) return series;
    return fillColour(mode, v, fedParty, provParty);
  }).style('fill-opacity', (f) => {
    if (isOverlay && mode === 'none') return null;
    if (isOverlay && mode === 'flat') return base * 0.35;
    if (mode === 'none') return 0.28;
    if (mode === 'type') return f.pollType === 'N' ? 0.28 : 0.75;
    /* An area with no catchment stays unfilled, so the two routes a ballot can
       take onto the map are told apart at a glance. */
    /* Stronger than the data ramps: this mode exists to make the partition
       legible, and a pale wash of six cycling colours is not. */
    if (mode === 'catchment') return catchmentOf(f) < 0 ? 0 : base * 0.8;
    const v = shadeValue(layerKey, f, mode, fedParty, provParty);
    if (v == null) return isOverlay ? 0.04 : 0.06;
    /* Capped below full opacity so the outlines stay readable underneath. */
    return base * (0.10 + 0.68 * rampT(mode, v, domain));
  });
}
const applyFederalStyle = (sel) => styleLayer('fed', sel);
const applyProvincialStyle = (sel) => styleLayer('prov', sel);
const applyDaStyle = (sel) => styleLayer('da', sel);

/* Bind the feature to its Leaflet-drawn path so d3 selections of the pane
   see it as the datum. */
function bindPaths(layerGroup, decorate) {
  layerGroup.eachLayer((l) => {
    const el = l.getElement();
    if (!el) return;
    el.__data__ = l.feature;
    if (decorate) decorate(el, l.feature);
  });
}

let layersSignature = null, extentSignature = null;

/* Recomputes the active sets and indexes; rebuilds the Leaflet layers only
   when the active sets actually changed (results loading merely restyles). */
/* What the readout says under a voting area whose numbers were modelled from a
   voting place rather than reported for the area itself. */
function provPlaceLine(feature, unit) {
  const store = state.provResults;
  if (store?.kind !== 'places' || !unit) return null;
  const bits = [];
  if (unit.place) {
    const metres = unit.placeDistanceM;
    bits.push(`Assigned to ${unit.place.name || 'a voting place'}`
      + (isFinite(metres) ? `, ${fmtInt(Math.round(metres))} m away` : ''));
  }
  const fromPlaces = unit.fromPlaces || 0, fromDistrict = unit.fromDistrict || 0;
  const all = fromPlaces + fromDistrict;
  if (all > 0) {
    bits.push(`${fmtPct(fromPlaces / all)} of its ballots came from that place, `
      + `the rest spread across the district`);
  }
  if (!bits.length) return null;
  const p = el('p', 'text-small text-muted', bits.join('. ') + '.');
  return p;
}

/* The two denominators for one voting area, side by side, because a reader
   checking a single area is exactly who needs to see how far apart they are.
   Written as a share of something named, never as a turnout. */
function provPartLine(feature) {
  const p = state.provPart && state.provPart.get(feature.__idx);
  if (!p || (p.perFedElector == null && p.perAdult == null)) return null;
  const bits = [`${fmtInt(p.ballots)} ballots`];
  if (p.perFedElector != null) bits.push(`${fmtPct(p.perFedElector)} of ${fmtInt(p.fedElectors)} federal electors`);
  if (p.perAdult != null) bits.push(`${fmtPct(p.perAdult)} of ${fmtInt(p.adults)} residents 15+`);
  const line = el('p', 'text-small text-muted', bits.join(' · '));
  if (p.spread != null && Math.abs(p.spread) >= 0.1) line.classList.add('text-warning');
  return line;
}

/* --- Voting places ---------------------------------------------------------- */

/* The located places behind the provincial results, or an empty list when the
   results were reported by voting area in the usual way. */
function votingPlaces() {
  return state.provResults?.kind === 'places' ? (state.provResults.read?.places || []) : [];
}

function drawPlaces() {
  const places = votingPlaces();
  const wrap = $('show-places-wrap');
  if (wrap) wrap.hidden = places.length === 0;
  placesLayer.clearLayers();
  if (!places.length) return;
  if (!$('show-places') || !$('show-places').checked) return;
  const ballots = places.map((p) => p.total + p.rejected);
  const biggest = Math.max(1, ...ballots);
  places.forEach((p, i) => {
    /* Area, not radius, follows the ballot count, so a hall with four times
       the ballots looks twice as wide rather than four times. */
    const r = 4 + 9 * Math.sqrt(ballots[i] / biggest);
    const marker = L.circleMarker([p.lat, p.lon], {
      pane: 'places', renderer: L.svg({ pane: 'places' }),
      className: 'place' + (p.final ? ' place-final' : ' place-other'),
      radius: r, weight: 1.5, fill: true, fillOpacity: 0.55,
    });
    marker.bindTooltip(`${p.name || 'Voting place'} — ${p.opportunity}, `
      + `${fmtInt(ballots[i])} ballots`, { direction: 'top' });
    marker.addTo(placesLayer);
  });
}

/* --- Effective n -------------------------------------------------------------

   A provincial number on a voting area is a share of what one voting place
   reported, so the areas of a catchment are one observation between them.
   These helpers name that observation, so a correlation can count distinct
   sources instead of polygons. */
function provPlaceGroup(provIdx) {
  const store = state.provResults;
  if (store?.kind !== 'places' || !store.assigned) return null;
  const pi = store.assigned.assignment[provIdx];
  return pi >= 0 ? 'place:' + pi : 'district:' + (store.assigned.featureDistrict[provIdx] || '');
}

/* For a dissemination area, whichever voting area covers most of it, and that
   area's group. Cached against the crosswalk, and cleared whenever it is.
   The dominant area is kept as well as the group: an export needs the feature
   itself to say how much of it came through a catchment. */
let daGroupCache = null;
function daDominant(daIdx) {
  const store = state.provResults;
  if (store?.kind !== 'places' || !store.assigned) return null;
  if (!daGroupCache) {
    daGroupCache = new Map();
    const cp = state.prov.all.length && state.da.all.length ? crossPair('prov', 'da') : null;
    if (cp) {
      const best = new Map();
      for (const p of cp.pairs) {
        const da = Analysis.pairIndex(p, 'b'), share = Analysis.pairShare(p, 'b');
        const prev = best.get(da);
        if (!prev || share > prev.share) best.set(da, { share, prov: Analysis.pairIndex(p, 'a') });
      }
      /* `best` is keyed by crosswalk-local index into state.da.active, but
         every caller has a feature's __idx, its position in state.da.all.
         Those differ whenever the active set is a subset -- which it always
         is, since the layer is clipped with a buffer ring and then trimmed to
         the federal extent -- so the cache is keyed by __idx here, once. */
      for (const [da, b] of best) {
        const target = state.da.active[da];
        const feature = state.prov.active[b.prov];
        if (target && feature) {
          daGroupCache.set(target.__idx, { feature, group: provPlaceGroup(feature.__idx) });
        }
      }
    }
  }
  return daGroupCache.get(daIdx) || null;
}
const daPlaceGroup = (daIdx) => daDominant(daIdx)?.group ?? null;
function clearPlaceGroups() { daGroupCache = null; }

/* What fraction of a voting area's ballots came from its own voting place
   rather than a district-wide spread; null when the results did not come by
   place at all. */
function catchmentShare(provFeature) {
  const store = state.provResults;
  if (store?.kind !== 'places' || !provFeature) return null;
  const u = store.values?.get(provFeature.__idx);
  if (!u) return null;
  const all = (u.fromPlaces || 0) + (u.fromDistrict || 0);
  return all > 0 ? u.fromPlaces / all : null;
}

function draw() {
  state.fed.active = activeFederal();
  const fedExtent = extentOf(state.fed.active);
  state.prov.active = activeProvincial(fedExtent);
  state.da.active = activeWithin(state.da, fedExtent);
  state.db.active = activeWithin(state.db, fedExtent);
  state.fed.index = Geo.buildIndex(state.fed.active);
  state.prov.index = state.prov.active.length ? Geo.buildIndex(state.prov.active) : null;
  state.da.index = state.da.active.length ? Geo.buildIndex(state.da.active) : null;

  const signature = [state.fed.active.length, state.prov.active.length, state.prov.all.length,
    state.da.active.length, state.da.all.length, votingPlaces().length,
    $('area-filter').value, $('show-mobile').checked,
    state.fed.active[0]?.key, state.fed.active[state.fed.active.length - 1]?.key].join('|');
  if (signature !== layersSignature) {
    layersSignature = signature;
    fedLayer.clearLayers();
    fedLayer.addData({ type: 'FeatureCollection', features: state.fed.active });
    bindPaths(fedLayer, (el, f) => {
      el.classList.toggle('outside-cov', Boolean(f.outsideCity));
      el.classList.toggle('point-like', isPointLike(f));
    });
    provLayer.clearLayers();
    if (state.prov.active.length) {
      provLayer.addData({ type: 'FeatureCollection', features: state.prov.active });
    }
    bindPaths(provLayer);
    daLayer.clearLayers();
    if (state.da.active.length) {
      daLayer.addData({ type: 'FeatureCollection', features: state.da.active });
    }
    bindPaths(daLayer);
  }
  drawPlaces();
  applyFederalStyle(gFed.selectAll('path'));
  applyProvincialStyle(gProv.selectAll('path'));
  applyDaStyle(gDa.selectAll('path'));

  updateLayerVisibility();
  renderLegend();
  redrawSelection();

  const extent = fedExtent || extentOf(state.prov.active);
  const key = extent ? extent.map((v) => v.toFixed(4)).join(',') : '';
  if (key !== extentSignature) { extentSignature = key; fitAll(); }
}

/* Shade modes the loaded data cannot fill, withdrawn rather than offered.

   Each of these needs something a file may not carry: a catchment needs results
   reported by voting place, a borrowed denominator needs the layer it is
   carried from, and provincial turnout needs a provincial electorate per area,
   which Elections BC does not publish. An option that would shade nothing is
   withdrawn rather than left to paint an empty map.

   Provincial turnout is here because it was not, and the cost was a real one.
   It sat in three selectors looking exactly like the modes that work, shading
   nothing and saying nothing; picked as one measure of a target list, it took
   a hundred thousand addresses out of the ranking, because a door is ranked
   only where every chosen measure has a value. The export went out with every
   row blank. Withdrawing the option is the fix at the source: the target list
   builds itself from these selectors and skips what is hidden, so the measure
   leaves the picker, the Show/Measure controls and the map together. */
function updatePlaceControls() {
  const part = state.provPart;
  const has = (key) => {
    if (!part) return false;
    for (const p of part.values()) if (p[key] != null) return true;
    return false;
  };
  const provTurnout = provTurnoutPossible();
  const available = {
    'shade-prov-by': {
      catchment: state.provResults?.kind === 'places',
      'prov-per-elector': has('perFedElector'),
      'prov-per-resident': has('perAdult'),
      'turnout-prov': provTurnout,
    },
    /* Redistributing the provincial results onto polls moves ballots, not an
       electorate: the crosswalk cannot supply a denominator the source never
       had. And the federal-minus-provincial delta is that same blank rate with
       a subtraction in front of it, so it goes when its second half goes.
       Aggregate turnout stays -- it falls back to the federal side alone and
       says it is partial, which is a number with a caveat rather than none. */
    'shade-by': { 'turnout-prov': provTurnout, 'turnout-delta': provTurnout },
    'shade-da-by': { 'turnout-prov': provTurnout },
  };
  for (const [selectId, modes] of Object.entries(available)) {
    const sel = $(selectId);
    if (!sel) continue;
    for (const [value, ok] of Object.entries(modes)) {
      const option = sel.querySelector(`option[value="${value}"]`);
      if (option) option.hidden = !ok;
      if (!ok && sel.value === value) sel.value = 'none';
    }
  }
}

function updateLayerVisibility() {
  updatePlaceControls();
  map.getPane('fed').style.display = $('show-fed').checked ? '' : 'none';
  map.getPane('prov').style.display = $('show-prov').checked ? '' : 'none';
  map.getPane('da').style.display = $('show-da').checked ? '' : 'none';
  map.getPane('places').style.display = $('show-places').checked ? '' : 'none';
  gProv.classed('filled', $('shade-prov-by').value !== 'none');
  gDa.classed('filled', $('shade-da-by').value !== 'none');
  const hasDa = state.da.all.length > 0;
  $('da-controls').hidden = !hasDa;
  $('show-da-wrap').hidden = !hasDa;
  /* The dissemination-area finder sits with the other two finders now, above
     the map, so it needs its own wrapper to hide -- it is no longer carried
     along by #da-controls. */
  $('find-da-wrap').hidden = !hasDa;
  root.style.setProperty('--va-weight', $('prov-weight').value);
}

/* Named by the file that was loaded rather than by the control, so a legend
   over an elector roll says electors and one over an address file says
   addresses. */
function pointsLegend(mode, layerKey) {
  const p = state.points;
  if (!p) return [];
  const dom = state.shadeDomain[layerKey];
  const noun = mode === 'points-weight' ? (p.weightNoun || 'weighted total') : (p.noun || 'points');
  const range = dom ? ` — ${fmtInt(dom.lo)} to ${fmtInt(dom.hi)}` : '';
  const out = [['var(--viz-series-6)', `${noun} per area${range}`]];
  if (p.joined) {
    out.push(['note', `Placed by joining ${fmtPct(1 - (p.missRate || 0))} of rows to the reference file.`]);
  }
  return out;
}

function renderLegend() {
  const legend = $('map-legend');
  const mode = $('shade-by').value;
  const provMode = $('shade-prov-by').value;
  const fedParty = $('shade-party-fed').value, provParty = $('shade-party-prov').value;
  legend.textContent = '';
  const items = [];
  const range = (d) => (d ? ` — ${fmtPct(d.lo, 0)} to ${fmtPct(d.hi, 0)}` : '');
  /* Everything the federal layer can show about the provincial election is
     carried there by the crosswalk. Without one those modes shade nothing, and
     a legend describing them would be describing an empty map. */
  const CROSS_LEVEL = new Set(['prov-party', 'turnout-prov', 'turnout-agg', 'turnout-delta', 'gap']);
  const RESULT_MODES = new Set(['fed-party', 'prov-party', 'gap', 'turnout-fed', 'turnout-prov',
                                'turnout-agg', 'turnout-delta']);
  const crossReady = Boolean(state.provOnFed && state.provOnFed.size);
  if (CROSS_LEVEL.has(mode) && !crossReady) {
    items.push(['note', 'This shading needs the crosswalk — build it on the Compare tab.']);
  } else if (mode === 'type') {
    items.push(['var(--muted)', 'Ordinary poll'], ['var(--viz-series-5)', 'Mobile poll'],
               ['var(--viz-series-6)', 'Single building']);
  } else if (mode === 'fed-party' && fedParty) {
    items.push([partyColour(fedParty), `${fedParty} share, 2025 — darker is higher`]);
  } else if (mode === 'prov-party' && provParty) {
    items.push([partyColour(provParty), `${provParty} share, 2024, on federal polls — darker is higher`]);
  } else if (mode === 'gap') {
    items.push([partyColour(fedParty), `${fedParty} runs ahead federally`],
               [partyColour(provParty), `${provParty} runs ahead provincially`]);
  } else if (mode === 'turnout-fed') {
    items.push(['var(--viz-series-1)', `2025 federal turnout${range(state.shadeDomain.fed)}`]);
  } else if (mode === 'turnout-prov') {
    items.push(['var(--viz-series-1)', `2024 provincial turnout on federal polls${range(state.shadeDomain.fed)}`]);
  } else if (mode === 'turnout-agg') {
    const w = Math.round(state.turnout.weight * 100);
    items.push(['var(--viz-series-1)',
      `${turnoutBasis().name}, ${w}% federal / ${100 - w}% provincial${range(state.shadeDomain.fed)}`]);
    items.push(['note', 'A poll reached by only one election shows that election alone.']);
  } else if (mode === 'turnout-delta') {
    items.push(['var(--viz-series-1)', 'Federal turnout higher'], ['var(--viz-series-2)', 'Provincial turnout higher']);
  } else if (POINT_MODES.has(mode)) {
    items.push(...pointsLegend(mode, 'fed'));
  } else if (MUNI_MODES.has(mode)) {
    items.push(...muniLegend(mode, 'fed', state.muni));
  } else if (NONVOTER_MODES.has(mode)) {
    items.push(...nonvotersLegend(mode, 'fed'));
  }
  /* Every mode derived from the two elections moves with apportionment -- the
     turnout ones because the ballots move, the party ones because
     apportionUnmatched redistributes per-party votes as well. One note rather
     than a clause appended to nine labels. Municipal and points modes are not
     derived from these results and are left alone. */
  if (RESULT_MODES.has(mode) && turnoutBasis().short) {
    items.push(['note', 'Advance and special ballots are left out — apportion them on the '
      + 'Turnout tab to include them.']);
  }
  if (state.prov.active.length) {
    if (provMode === 'prov-party' && provParty) {
      items.push([partyColour(provParty), `${provParty} share, 2024, on voting areas`]);
    } else if (provMode === 'turnout-prov') {
      items.push(['var(--viz-series-1)', `2024 provincial turnout on voting areas${range(state.shadeDomain.prov)}`]);
    } else if (MUNI_MODES.has(provMode)) {
      items.push(...muniLegend(provMode, 'prov', state.muni));
    } else if (POINT_MODES.has(provMode)) {
      items.push(...pointsLegend(provMode, 'prov'));
    } else if (NONVOTER_MODES.has(provMode)) {
      items.push(...nonvotersLegend(provMode, 'prov'));
    } else if (PART_MODES.has(provMode)) {
      /* Named by its denominator every time it is drawn. The whole reason
         these exist is that neither denominator is a provincial electorate,
         and a legend reading "turnout" would undo that in one word. */
      const perElector = provMode === 'prov-per-elector';
      const dom = state.shadeDomain.prov;
      items.push([perElector ? 'var(--viz-series-4)' : 'var(--viz-series-5)',
        `2024 provincial ballots per ${perElector ? '2025 federal elector' : 'resident aged 15+'}`
        + (dom ? ` — ${fmtPct(dom.lo, 0)} to ${fmtPct(dom.hi, 0)}` : '')]);
      items.push(['note', perElector
        ? 'Not turnout: the denominator is the 2025 federal roll, not the 2024 provincial one.'
        : 'Not turnout: the denominator counts 2021 residents, not registered voters.']);
    } else if (provMode === 'catchment') {
      const n = state.provResults?.report?.catchments || 0;
      /* The colours cycle and carry no order, so the legend says what they
         mean rather than pretending to be a scale. */
      items.push([CATCHMENT_FILL[0], `${fmtInt(n)} catchments — one colour per voting place, repeating`]);
      items.push(['outline', 'No catchment: ballots spread across the district']);
    }
    items.push(['outline', 'Provincial (2024) voting area']);
  }
  if (state.da.active.length) {
    const daMode = $('shade-da-by').value;
    if (MUNI_MODES.has(daMode)) {
      items.push(...muniLegend(daMode, 'da', state.muni));
    } else if (DATA_MODES.has(daMode)) {
      const name = daMode === 'variable'
        ? ($('shade-da-var').selectedOptions[0]?.textContent || 'census variable')
        : { 'turnout-agg': turnoutBasis().name, 'turnout-fed': '2025 federal turnout',
            'turnout-prov': '2024 provincial turnout' }[daMode]
          + (turnoutBasis().short ? ` (${turnoutBasis().short})` : '');
      const dom = state.shadeDomain.da;
      const rangeText = dom ? (daMode === 'variable'
        ? ` — ${fmtNum(dom.lo, 1)} to ${fmtNum(dom.hi, 1)}` : range(dom)) : '';
      items.push([daMode === 'variable' ? 'var(--viz-series-3)' : 'var(--viz-series-1)', `${name} on dissemination areas${rangeText}`]);
    }
    items.push(['outline-da', 'Census (2021) dissemination area']);
  }
  legend.hidden = items.length === 0;
  for (const [colour, text] of items) {
    const row = el('div', 'legend-item');
    if (colour === 'note') { row.append(el('span', 'text-small text-muted', text)); legend.append(row); continue; }
    const outline = colour === 'outline' || colour === 'outline-da';
    const sw = el('span', colour === 'outline' ? 'swatch swatch-outline' : colour === 'outline-da' ? 'swatch swatch-da' : 'swatch');
    if (!outline) sw.style.background = colour;
    row.append(sw, el('span', null, text));
    legend.append(row);
  }
}

/* --- Selection and readout ------------------------------------------------- */

/* Hit-test one point against every layer; a feature given directly stands in
   for its own layer and the others are found at its interior point. */
function selectAt(lonlat, fedFeature, provFeature, daFeature) {
  const hitAll = (pt) => ({
    fed: pt && state.fed.index ? state.fed.index.hit(pt[0], pt[1]) : -1,
    prov: pt && state.prov.index ? state.prov.index.hit(pt[0], pt[1]) : -1,
    da: pt && state.da.index ? state.da.index.hit(pt[0], pt[1]) : -1,
  });
  const given = fedFeature || provFeature || daFeature;
  const pt = lonlat || (given ? Geo.representativePoint(given.geometry) : null);
  const h = hitAll(pt);
  state.selection.fed = fedFeature || (h.fed >= 0 ? state.fed.active[h.fed] : null);
  state.selection.prov = provFeature || (h.prov >= 0 ? state.prov.active[h.prov] : null);
  state.selection.da = daFeature || (h.da >= 0 ? state.da.active[h.da] : null);
  redrawSelection();
  renderReadout();
}

function redrawSelection() {
  gFed.selectAll('path').classed('selected', (f) => f === state.selection.fed);
  gProv.selectAll('path').classed('selected', (f) => f === state.selection.prov);
  gDa.selectAll('path').classed('selected', (f) => f === state.selection.da);
  /* Re-appending brings the selected outline above its neighbours. */
  gFed.selectAll('path.selected').raise();
  gProv.selectAll('path.selected').raise();
  gDa.selectAll('path.selected').raise();
}

function resultsList(unit, side, limit = 6) {
  if (!unit || !unit.parties.size) return null;
  const rows = [...unit.parties.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  const list = el('ul', 'result-list');
  /* apportionUnmatched redistributes per-party votes, not only ballot totals,
     so these shares move with the setting exactly as the turnout figures do --
     advance voters are spread at their district's advance mix, which is not
     each poll's election-day mix. */
  const note = side ? sideBasisShort(side) : '';
  for (const [party, votes] of rows) {
    const li = el('li');
    const dot = el('span', 'dot');
    dot.style.background = partyColour(party);
    li.append(dot, el('span', 'party', party),
      el('span', 'votes tabular-nums', `${fmtInt(votes)} (${fmtPct(unit.total ? votes / unit.total : null)})`));
    list.append(li);
  }
  if (note) list.append(el('li', 'text-small text-muted', note));
  return list;
}

function renderReadout() {
  const box = $('readout');
  box.textContent = '';
  const { fed, prov, da } = state.selection;
  if (!fed && !prov && !da) {
    box.append(el('p', 'text-muted',
      'Click anywhere on the map to read the federal polling division, the provincial voting area and the dissemination area covering that point.'));
    return;
  }
  const grid = el('div', 'readout-grid');

  const fedCard = el('div', 'readout-card');
  fedCard.append(el('h3', null, 'Federal (2025)'));
  if (fed) {
    fedCard.append(el('p', 'readout-name', fed.label));
    const bits = [`Riding ${fed.fedNum}`, `poll ${fed.poll}`,
      POLL_TYPE[fed.pollType] ? `${POLL_TYPE[fed.pollType]} poll` : null,
      /* Where this division's early voters went, so a reader can see which
         advance poll's ballots are landing here and why. */
      fed.advPoll ? `advance poll ${fed.advPoll}` : null,
      fed.jurisdiction];
    fedCard.append(el('p', 'text-small text-muted', bits.filter(Boolean).join(' · ')));
    const unit = fedValues()?.get(fed.idx);
    if (unit) {
      fedCard.append(el('p', 'text-small', `${fmtInt(unit.total)} valid votes`));
      const tl = turnoutLine(unit, 'fed');
      if (tl) fedCard.append(el('p', 'text-small' + (Turnout.rate(unit) > 1 ? ' text-warning' : ''), tl));
      const list = resultsList(unit, 'fed');
      if (list) fedCard.append(list);
    } else if (state.fedResults) {
      fedCard.append(el('p', 'text-small text-warning', 'No results row matched this polling division.'));
    }
    const fpl = pointsLine('fed', fed);
    if (fpl) fedCard.append(el('p', 'text-small text-muted', fpl));
    const fml = muniLine('fed', fed);
    if (fml) fedCard.append(el('p', 'text-small text-muted', fml));
    const fnv = nonvotersLine('fed', fed);
    if (fnv) fedCard.append(el('p', 'text-small text-muted', fnv));
  } else {
    fedCard.append(el('p', 'text-muted', 'No federal polling division at this point.'));
  }

  const provCard = el('div', 'readout-card');
  provCard.append(el('h3', null, 'Provincial (2024)'));
  if (prov) {
    provCard.append(el('p', 'readout-name', provLabel(prov)));
    const k = state.prov.keyDef || {};
    const extras = Object.entries(prov.properties)
      .filter(([key, v]) => key !== k.district && key !== k.poll && String(v ?? '').trim() !== '')
      .slice(0, 4)
      .map(([key, v]) => `${key}: ${v}`);
    if (extras.length) provCard.append(el('p', 'text-small text-muted', extras.join(' · ')));
    const unit = provValues()?.get(prov.__idx);
    if (unit) {
      provCard.append(el('p', 'text-small', `${fmtInt(unit.total)} valid votes`));
      const tl = turnoutLine(unit, 'prov');
      if (tl) provCard.append(el('p', 'text-small' + (Turnout.rate(unit) > 1 ? ' text-warning' : ''), tl));
      const list = resultsList(unit, 'prov');
      if (list) provCard.append(list);
    } else if (state.provResults) {
      provCard.append(el('p', 'text-small text-warning',
        state.provResults.kind === 'places'
          ? 'No voting place served this area — its district reported no results.'
          : 'No results row matched this voting area.'));
    }
    const placeLine = provPlaceLine(prov, unit);
    if (placeLine) provCard.append(placeLine);
    const partLine = provPartLine(prov);
    if (partLine) provCard.append(partLine);
    const pl = pointsLine('prov', prov);
    if (pl) provCard.append(el('p', 'text-small text-muted', pl));
    const ml = muniLine('prov', prov);
    if (ml) provCard.append(el('p', 'text-small text-muted', ml));
    const pnv = nonvotersLine('prov', prov);
    if (pnv) provCard.append(el('p', 'text-small text-muted', pnv));
  } else if (state.prov.all.length) {
    provCard.append(el('p', 'text-muted', 'No provincial voting area at this point.'));
  } else {
    provCard.append(el('p', 'text-muted', 'No provincial layer loaded yet — see the Data tab.'));
  }

  grid.append(fedCard, provCard);
  if (state.da.all.length) {
    const daCard = el('div', 'readout-card');
    daCard.append(el('h3', null, 'Census (2021)'));
    if (da) {
      daCard.append(el('p', 'readout-name', daLabel(da)));
      const bits = [];
      const pop = state.da.pop?.get(da.__idx);
      if (pop != null) bits.push(`${fmtInt(pop)} people`);
      const row = state.socio.byDa && state.socio.byDa.get(da.__idx);
      if (row) {
        if (row.t.fed != null) bits.push(`federal turnout ${fmtPct(row.t.fed)}`);
        if (row.t.prov != null) bits.push(`provincial turnout ${fmtPct(row.t.prov)}`);
        if (row.agg != null) bits.push(`aggregate ${fmtPct(row.agg)}`);
        /* Clicked one area at a time, with no control in sight, so the figure
           has to carry what it is rather than rely on a setting three tabs
           away. */
        if (bits.length && turnoutBasis().short) bits.push(turnoutBasis().short);
      }
      if (bits.length) daCard.append(el('p', 'text-small', bits.join(' · ')));
      const shown = state.da.variables.filter((v) => v.byFeature.has(da.__idx)).slice(0, 8);
      if (shown.length) {
        const list = el('ul', 'result-list');
        for (const v of shown) {
          const li = el('li');
          /* The readout is where somebody checks one area's numbers, so it
             carries the statistical definition rather than the plain alias. */
          li.append(el('span', 'party', v.precise || v.label),
                    el('span', 'votes tabular-nums', fmtNum(v.byFeature.get(da.__idx), 1)));
          list.append(li);
        }
        daCard.append(list);
      } else if (state.da.census) {
        daCard.append(el('p', 'text-small text-warning', 'No census row matched this area.'));
      }
    } else {
      daCard.append(el('p', 'text-muted', 'No dissemination area at this point.'));
    }
    grid.append(daCard);
  }
  box.append(grid);

  const bkey = basketKeyForSelection();
  if (bkey && state.turnout.rows) {
    const inBasket = state.turnout.basket.has(bkey);
    const bk = el('button', 'btn btn-small', inBasket ? 'Remove from turnout basket' : 'Add to turnout basket');
    bk.type = 'button';
    bk.addEventListener('click', () => toggleBasket(bkey));
    box.append(bk);
  }

  if (fed && prov && state.pairs) {
    const fi = state.fed.all.indexOf(fed);
    const overlaps = state.pairs.filter((p) => state.crosswalkFed[p.fi] === fed);
    if (overlaps.length) {
      const note = el('p', 'text-small text-muted');
      const here = overlaps.find((p) => state.crosswalkProv[p.pi] === prov);
      note.textContent = here
        ? `This polling division is split across ${overlaps.length} voting area${overlaps.length > 1 ? 's' : ''}; `
          + `${fmtPct(here.shareOfFed)} of its area lies in ${provLabel(prov)}.`
        : `This polling division is split across ${overlaps.length} voting area${overlaps.length > 1 ? 's' : ''}.`;
      box.append(note);
    }
  }
}

/* One line of ballots / electors / turnout for a readout card. */
function turnoutLine(unit, side) {
  const t = Turnout.rate(unit);
  if (t == null) return unit.electors ? null : 'No elector count in this file — turnout unavailable.';
  const bits = [`${fmtInt(Turnout.ballots(unit))} ballots`, `${fmtInt(unit.electors)} electors`,
    `turnout ${fmtPct(t)}`];
  if (unit.apportioned) bits.push(`incl. ${fmtInt(unit.apportioned)} apportioned`);
  /* It named the apportioned ballots when there were some and said nothing when
     there were none, which is self-describing in one direction only: the silent
     case is the one where the figure is below the reported turnout. */
  else if (side && sideBasisShort(side)) bits.push(sideBasisShort(side));
  if (t > 1) bits.push('over 100% — merged or mis-keyed poll');
  return bits.join(' · ');
}

map.on('click', (event) => {
  selectAt([event.latlng.lng, event.latlng.lat]);
  /* Shift-click adds the unit under the cursor to the turnout basket. */
  if (event.originalEvent && event.originalEvent.shiftKey) {
    const key = basketKeyForSelection();
    if (key) toggleBasket(key);
  }
});

function zoomToFeature(feature) {
  if (!feature) return;
  const b = Geo.bboxOf(feature.geometry);
  if (!isFinite(b[0])) return;
  map.fitBounds([[b[1], b[0]], [b[3], b[2]]], { padding: [24, 24], maxZoom: 17 });
}

/* --- The sample table and its crosswalks ------------------------------------
   buildCrosswalk (g3) samples every loaded layer once into state.sample.
   crossPair(a, b) then derives the crosswalk for any two layers on demand,
   weighted as the Compare tab asks, and caches it; the federal-provincial
   pair also fills the older state.crosswalk / state.pairs fields the rest of
   the app reads. */

/* Per-point weights from the best population layer available:
   dissemination blocks, else dissemination areas, else none (area). */
function sampleWeights() {
  const s = state.sample;
  const none = { weights: null, label: 'area', short: 'area', detail: '' };
  if (!s) return none;
  const mode = $('sample-weighting').value;
  if (mode === 'area') return none;
  const popOf = (id) => {
    const k = s.ids.indexOf(id);
    if (k < 0 || !state[id].pop) return null;
    const m = new Map();
    state[id].active.forEach((f, i) => { const v = state[id].pop.get(f.__idx); if (v != null) m.set(i, v); });
    return m.size ? { k, m } : null;
  };
  const da = (mode === 'auto' || mode === 'da') ? popOf('da') : null;
  const db = (mode === 'auto' || mode === 'db') ? popOf('db') : null;
  let weights = null, label = 'area', short = 'area', detail = '';
  if (da) { weights = Analysis.pointWeights(s, da.k, da.m, null); label = 'dissemination-area population'; short = 'area population'; }
  if (db) {
    weights = Analysis.pointWeights(s, db.k, db.m, weights);
    short = 'block population';
    detail = da ? 'area population where a block has none' : '';
    label = 'dissemination-block population' + (detail ? ` (${detail})` : '');
  }
  if (!weights && mode !== 'auto') { label = 'area (no population loaded for that layer)'; detail = 'no population loaded for that layer'; }
  return { weights, label, short, detail };
}

function crossPair(a, b) {
  const s = state.sample;
  if (!s) return null;
  const ka = s.ids.indexOf(a), kb = s.ids.indexOf(b);
  if (ka < 0 || kb < 0) return null;
  const key = a + '|' + b;
  let c = state.cross.get(key);
  if (c) return c;
  const { weights, label, short, detail } = sampleWeights();
  const cw = Analysis.crosswalkBetween(s, ka, kb, { weights });
  const repaired = Analysis.repairSmallFeatures(cw, state[a].active, state[b].active,
    { a: s.indexes[ka], b: s.indexes[kb] });
  const minShare = parseFloat($('min-overlap').value);
  c = { cw, pairs: Analysis.crosswalkPairs(cw, { minShare }), coverage: Analysis.coverage(cw), repaired, weighting: label };
  state.cross.set(key, c);
  state.weightingInEffect = label;
  state.weightingShort = short;
  state.weightingDetail = detail;
  if (a === 'fed' && b === 'prov') {
    state.crosswalk = cw; state.pairs = c.pairs; state.coverage = c.coverage;
    state.crosswalkFed = state.fed.active; state.crosswalkProv = state.prov.active;
  }
  return c;
}

/* Weighting or the sliver threshold changed: the sample stands, the
   crosswalks are rebuilt from it. */
function invalidateCross() {
  state.cross.clear();
  /* The place groups are derived from the pairs, so they die with them:
     without this, changing the weighting or the sliver threshold would leave
     the effective-n figure counting sources from the previous crosswalk. */
  clearPlaceGroups();
  state.crosswalk = null; state.pairs = null; state.coverage = null; state.provOnFed = null;
  /* Both denominators are carried across the crosswalk, so they die with it
     rather than shading the map from the previous weighting. */
  state.provPart = null;
  state.crosswalkFed = null; state.crosswalkProv = null;
  if (state.sample) crossPair('fed', 'prov');
}

/* The active sets changed: nothing derived from the sample survives. */
function invalidateSample() {
  state.sample = null;
  invalidateCross();
  state.turnout.rows = null; state.turnout.basket.clear();
  state.socio.rows = null; state.socio.byDa = null; state.socio.table = null;
  $('corr-controls').hidden = true;
  refreshCrosswalkStatus();
}
