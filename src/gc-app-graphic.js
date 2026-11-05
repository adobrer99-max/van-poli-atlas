/* --- Balagan graphic --------------------------------------------------------

   The map as it stands -- the same areas, the same colours, the part of the
   region in view -- redrawn inside The Balagan's frame and saved as a PNG at
   the media kit's sizes, so a finding on the map is one click from a Substack
   or Instagram graphic. The frame follows the kit's own (balagan-kit.html,
   frame()): a mono kicker in brass, the finding as the title, an italic
   subtitle, then a brass rule over the source on the left and the masthead and
   Substack address on the right. The kit's fonts are embedded in this file
   (j-balagan-fonts.css) so the PNG looks the same on any machine, offline.

   Nothing here changes the map; it reads the drawn paths and the legend. */

const GRAPHIC = {
  colours: { ink: '#1B2A40', slate: '#4A5568', brass: '#C9922A', parchment: '#F5F0E8',
             crimson: '#B52B2B', paper: '#FAFAF8', rule: '#DDD4C4' },
  sizes: {
    substack: { w: 1456, h: 1024, label: 'Substack inline (1456 × 1024)' },
    ig45: { w: 1080, h: 1350, label: 'Instagram 4:5 (1080 × 1350)' },
    igsq: { w: 1080, h: 1080, label: 'Instagram square (1080 × 1080)' },
  },
  fonts: {
    display: "'Libre Franklin', 'Helvetica Neue', Arial, sans-serif",
    body: "'Source Serif 4', Georgia, serif",
    mono: "'IBM Plex Mono', 'Courier New', monospace",
  },
};
GRAPHIC.themes = {
  parchment: { bg: GRAPHIC.colours.parchment, ink: GRAPHIC.colours.ink, body: GRAPHIC.colours.slate,
               accent: GRAPHIC.colours.brass, line: 'rgba(27,42,64,.35)', nodata: '#E0D8C8' },
  paper: { bg: GRAPHIC.colours.paper, ink: GRAPHIC.colours.ink, body: GRAPHIC.colours.slate,
           accent: GRAPHIC.colours.brass, line: 'rgba(27,42,64,.3)', nodata: '#E9E4DA' },
  ink: { bg: GRAPHIC.colours.ink, ink: GRAPHIC.colours.parchment, body: '#C9CFD8',
         accent: GRAPHIC.colours.brass, line: 'rgba(245,240,232,.35)', nodata: '#33445E' },
};

/* Colour that means a direction (a swing either way, one election ahead of
   the other), not an amount. */
const DIVERGING = new Set(['gap', 'turnout-delta', 'muni-swing', 'muni-swing-rel']);
/* A shading value as the legend prints it: shares and turnouts as percents,
   counts as whole numbers, a census variable as it comes. */
function graphicFormat(mode, v) {
  if (v == null || !isFinite(v)) return '–';
  if (['muni-ballots', 'points-count', 'points-weight', 'nonvoters-count'].includes(mode)) return fmtInt(v);
  if (mode === 'variable') return fmtNum(v, 1);
  return `${Math.round(v * 100)}%`;
}

const gfx = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const measureCtx = document.createElement('canvas').getContext('2d');
  function measure(str, f) {
    measureCtx.font = `${f.style || 'normal'} ${f.weight || 400} ${f.size}px ${f.family}`;
    return measureCtx.measureText(str).width + (f.tracking || 0) * str.length;
  }
  /* Words onto lines within a width, shrinking the type until it fits the
     lines allowed -- the kit's fit(). */
  function fit(str, f, width, { maxLines = 3, minSize = 12, lh = 1.2 } = {}) {
    let size = f.size;
    for (;;) {
      const ff = { ...f, size };
      const words = String(str).split(/\s+/).filter(Boolean);
      const lines = [];
      let cur = '';
      for (const w of words) {
        const next = cur ? `${cur} ${w}` : w;
        if (measure(next, ff) > width && cur) { lines.push(cur); cur = w; } else cur = next;
      }
      if (cur) lines.push(cur);
      if (lines.length <= maxLines || size <= minSize) return { lines, font: ff, lh: size * lh };
      size = Math.max(minSize, size * 0.94);
    }
  }
  function el(parent, name, attrs = {}, text) {
    const n = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }
  function text(parent, str, x, y, f, fill, attrs = {}) {
    return el(parent, 'text', { x, y, fill, 'font-family': f.family, 'font-size': f.size,
      'font-weight': f.weight || 400, 'font-style': f.style || 'normal',
      'letter-spacing': f.tracking || null, ...attrs }, str);
  }
  function lines(parent, block, x, y, fill) {
    block.lines.forEach((l, i) => text(parent, l, x, y + i * block.lh, block.font, fill));
    return y + block.lines.length * block.lh;
  }
  return { NS, measure, fit, el, text, lines };
})();

/* What is on the map now: every drawn area of the shaded layers, with the
   colour it is painted, and the legend's rows. */
function graphicLayers() {
  const out = [];
  const fedParty = $('shade-party-fed').value, provParty = $('shade-party-prov').value;
  const take = (g, pane, show) => {
    if (!$(show).checked) return;
    const mode = pane === 'fed' ? $('shade-by').value : $('shade-prov-by').value;
    g.selectAll('path').each(function (d) {
      if (!d || !d.geometry) return;
      const cs = getComputedStyle(this);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      let value = null;
      try { value = shadeValue(pane, d, mode, fedParty, provParty); } catch (e) { value = null; }
      out.push({ pane, mode, feature: d, value: value != null && isFinite(value) ? value : null,
                 fill: cs.fill, fillOpacity: +cs.fillOpacity || 0,
                 stroke: cs.stroke, strokeWidth: parseFloat(cs.strokeWidth) || 1 });
    });
  };
  take(gFed, 'fed', 'show-fed');
  take(gProv, 'prov', 'show-prov');
  return out;
}
function graphicLegend() {
  return [...$('map-legend').querySelectorAll('.legend-item')].map((row) => {
    const sw = row.querySelector('.swatch');
    const label = row.textContent.trim();
    if (!sw) return { note: label };
    const cs = getComputedStyle(sw);
    const outline = sw.classList.contains('swatch-outline') || sw.classList.contains('swatch-da');
    return { label, colour: outline ? null : cs.backgroundColor };
  }).filter((r) => r.label && !/^Provincial \(2024\) voting area$|^Census \(2021\) dissemination area$/.test(r.label));
}

/* A sensible first draft of the words, from what is on screen. The title is
   left as a prompt: it should state the finding, which only the author knows. */
function graphicDefaults() {
  const legend = graphicLegend().filter((r) => !r.note);
  const shown = legend[0]?.label || '';
  const sources = [];
  const fedShown = $('show-fed').checked && $('shade-by').value !== 'none';
  const provShown = $('show-prov').checked && state.prov.active.length && $('shade-prov-by').value !== 'none';
  const muni = /municipal|2026|2022/i.test(shown) && state.muni;
  if (fedShown && !muni) sources.push('Elections Canada, 2025 general election, polling divisions');
  if (provShown && !muni) sources.push('Elections BC, 2024 general election, voting areas');
  if (muni) sources.push(`${CITY.cityName}, ${shown.match(/20\d\d/)?.[0] || '2026'} results by voting place, smoothed onto `
    + (fedShown ? 'federal polling divisions' : 'provincial voting areas'));
  return {
    kicker: CITY.id === 'metro' ? 'METRO VANCOUVER' : `${CITY.name.toUpperCase()} VOTES`,
    title: '',
    subtitle: shown ? shown.replace(/\s+—\s+darker is higher$/, '') + '.' : '',
    source: sources.join('; ') || 'Elections Canada; Elections BC',
  };
}

/* The graphic as an SVG string, ready to show or to rasterise. */
function graphicSvg(spec) {
  const size = GRAPHIC.sizes[spec.size] || GRAPHIC.sizes.substack;
  const W = size.w, H = size.h;
  const T = GRAPHIC.themes[spec.theme] || GRAPHIC.themes.parchment;
  const F = GRAPHIC.fonts;
  const s = Math.min(W, H) / 1080;
  const m = Math.round(72 * s);
  const svg = gfx.el(null, 'svg', { xmlns: gfx.NS, width: W, height: H, viewBox: `0 0 ${W} ${H}` });
  const style = gfx.el(svg, 'style');
  style.textContent = document.getElementById('balagan-fonts')?.textContent || '';
  gfx.el(svg, 'rect', { x: 0, y: 0, width: W, height: H, fill: T.bg });
  const width = W - 2 * m;
  let y = m;
  if (spec.kicker) {
    const f = { family: F.mono, size: Math.round(22 * s), weight: 600, tracking: 3 * s };
    gfx.text(svg, String(spec.kicker).toUpperCase(), m, y + f.size, f, T.accent);
    y += f.size + Math.round(18 * s);
  }
  const title = spec.title || 'Write the finding here';
  {
    const block = gfx.fit(title, { family: F.display, size: Math.round(60 * s), weight: 700 }, width,
      { maxLines: 3, minSize: Math.round(36 * s), lh: 1.12 });
    y = gfx.lines(svg, block, m, y + block.font.size * 0.92, spec.title ? T.ink : T.body)
      - block.lh + block.font.size * 0.3 + Math.round(14 * s);
  }
  if (spec.subtitle) {
    const block = gfx.fit(spec.subtitle, { family: F.body, size: Math.round(28 * s), style: 'italic' }, width,
      { maxLines: 3, minSize: Math.round(20 * s), lh: 1.3 });
    y = gfx.lines(svg, block, m, y + block.font.size, T.body) - block.lh + block.font.size * 0.4 + Math.round(10 * s);
  }

  /* Footer, as the kit draws it. */
  const fs = Math.round(17 * s);
  const footY = H - m + fs * 0.3;
  gfx.el(svg, 'line', { x1: m, x2: W - m, y1: footY - fs * 2.1, y2: footY - fs * 2.1,
                        stroke: T.accent, 'stroke-width': Math.max(1.5, 2 * s) });
  const mastF = { family: F.display, size: Math.round(24 * s), weight: 700, tracking: 1.5 * s };
  const mastW = gfx.measure('THE BALAGAN', mastF);
  gfx.text(svg, 'THE BALAGAN', W - m, footY, mastF, T.ink, { 'text-anchor': 'end' });
  if (spec.handle !== false) {
    gfx.text(svg, 'adamdobrer.substack.com', W - m, footY - mastF.size * 1.15,
      { family: F.mono, size: Math.round(14 * s), tracking: 0.5 * s }, T.body, { 'text-anchor': 'end' });
  }
  if (spec.source) {
    const label = /^source/i.test(spec.source) ? spec.source : `SOURCE — ${spec.source}`;
    const block = gfx.fit(label, { family: F.mono, size: fs, tracking: 0.4 * s },
      W - m - mastW - Math.round(28 * s) - m, { maxLines: 2, minSize: Math.round(12 * s), lh: 1.3 });
    gfx.lines(svg, block, m, footY - (block.lines.length - 1) * block.lh, T.body);
  }
  const bottom = footY - fs * 2.1 - Math.round(28 * s);
  const top = y + Math.round(24 * s);

  /* What to draw: every shaded area of the layers on the map, and the
     voting-area outlines only if asked for -- unshaded, they are an overlay
     for finding your way on screen and drown a graphic. */
  const drawn = graphicLayers().filter((l) => {
    const shaded = l.fill && l.fill !== 'none' && l.fillOpacity > 0;
    l.shaded = shaded;
    return shaded || l.pane === 'fed' || spec.outlines;
  });
  /* The scale. The shaded layer's own values, in view, decide it: the map
     paints a value as strength of colour, and the graphic says which values
     its lightest and darkest stand for. Stretched, the ramp runs from the 5th
     to the 95th percentile of the areas drawn, so a race won 40 to 60
     everywhere does not come out flat; otherwise it is the atlas's own scale
     (0 to 60% for a party's share, the data's range for turnout and counts).
     Modes whose colour carries a direction -- a swing, a gap -- keep the
     map's colours and get no ramp. */
  const scaled = drawn.filter((l) => l.shaded && l.value != null);
  const mode = scaled.length ? scaled[0].mode : null;
  const ramp = (() => {
    if (!mode || DIVERGING.has(mode) || mode === 'catchment' || mode === 'type' || mode === 'flat') return null;
    const vals = scaled.filter((l) => l.mode === mode).map((l) => l.value).sort((a, b) => a - b);
    if (vals.length < 2) return null;
    if (spec.stretch) {
      const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * (vals.length - 1)))];
      const lo = q(0.05), hi = q(0.95);
      if (!(hi > lo)) return null;
      return { lo, hi, clipLo: vals[0] < lo, clipHi: vals[vals.length - 1] > hi, stretched: true };
    }
    const dom = DATA_MODES.has(mode) ? state.shadeDomain[scaled[0].pane] : null;
    if (dom) return { lo: dom.lo, hi: dom.hi, clipLo: vals[0] < dom.lo, clipHi: vals[vals.length - 1] > dom.hi };
    return { lo: 0, hi: 0.6, clipLo: false, clipHi: vals[vals.length - 1] > 0.6 };
  })();
  const opacityOf = (l) => {
    if (!ramp || l.mode !== mode || l.value == null) return l.fillOpacity;
    const t = Math.max(0, Math.min(1, (l.value - ramp.lo) / (ramp.hi - ramp.lo)));
    return 0.12 + 0.83 * t;
  };
  const fmtValue = (v) => graphicFormat(mode, v);

  /* The legend, under the map: a swatch and a line per row, notes in italic;
     when the shading is stretched, a bar from lighter to darker under the
     first row says which way it runs. */
  const legend = graphicLegend();
  const lf = { family: F.mono, size: Math.round(16 * s), tracking: 0.3 * s };
  const nf = { family: F.body, size: Math.round(17 * s), style: 'italic' };
  const rowH = Math.round(26 * s);
  const barH = Math.round(12 * s);
  const firstColoured = legend.findIndex((r) => !r.note && r.colour);
  const legendH = legend.length
    ? legend.length * rowH + Math.round(14 * s) + (ramp && firstColoured >= 0 ? barH + Math.round(30 * s) : 0) : 0;
  let ly = bottom - legendH + Math.round(14 * s) + lf.size;
  legend.forEach((r, i) => {
    if (r.note) {
      const b = gfx.fit(r.note, nf, width, { maxLines: 1, minSize: Math.round(12 * s) });
      gfx.text(svg, b.lines[0], m, ly, b.font, T.body);
      ly += rowH;
      return;
    }
    const sw = Math.round(18 * s);
    gfx.el(svg, 'rect', { x: m, y: ly - sw + 3 * s, width: sw, height: sw, fill: r.colour || 'none',
      stroke: r.colour ? 'none' : T.ink, 'stroke-width': r.colour ? null : 1.5 * s });
    const label = r.label.replace(/\s+—\s+darker is higher$/, '');
    const b = gfx.fit(label, lf, width - sw - 12 * s, { maxLines: 1, minSize: Math.round(11 * s) });
    gfx.text(svg, b.lines[0], m + sw + Math.round(12 * s), ly, b.font, T.ink);
    ly += rowH;
    if (ramp && i === firstColoured) {
      const id = 'g-ramp';
      const grad = gfx.el(gfx.el(svg, 'defs'), 'linearGradient', { id });
      gfx.el(grad, 'stop', { offset: '0', 'stop-color': r.colour, 'stop-opacity': 0.12 });
      gfx.el(grad, 'stop', { offset: '1', 'stop-color': r.colour, 'stop-opacity': 0.95 });
      const barW = Math.min(width * 0.45, 420 * s);
      gfx.el(svg, 'rect', { x: m, y: ly - lf.size + 2 * s, width: barW, height: barH, fill: `url(#${id})` });
      const tf = { family: F.mono, size: Math.round(13 * s), tracking: 0.3 * s };
      const loText = fmtValue(ramp.lo) + (ramp.clipLo ? ' or less' : '');
      const hiText = fmtValue(ramp.hi) + (ramp.clipHi ? ' or more' : '');
      gfx.text(svg, loText, m, ly + barH + Math.round(4 * s), tf, T.body);
      gfx.text(svg, hiText, m + barW, ly + barH + Math.round(4 * s), tf, T.body, { 'text-anchor': 'end' });
      ly += barH + Math.round(30 * s);
    }
  });

  /* The map: the part of the drawn areas in view, as large as the space left
     allows. Web Mercator, as on screen, done flat: the features keep whatever
     ring winding their files had, which a spherical projection would read as
     the rest of the globe. */
  const box = { x: m, y: top, w: width, h: bottom - legendH - top };
  const merc = (lon, lat) => [lon * Math.PI / 180,
    -Math.log(Math.tan(Math.PI / 4 + Math.max(-85, Math.min(85, lat)) * Math.PI / 360))];
  const vb = map.getBounds();
  const [vx0, vy1] = merc(vb.getWest(), vb.getSouth());
  const [vx1, vy0] = merc(vb.getEast(), vb.getNorth());
  const raw = d3.geoPath(d3.geoTransform({ point(lon, lat) { const p = merc(lon, lat); this.stream.point(p[0], p[1]); } }));
  let [mx0, my0, mx1, my1] = [Infinity, Infinity, -Infinity, -Infinity];
  const inView = drawn.filter((l) => {
    const [[a, c], [bb, d]] = raw.bounds(l.feature);
    if (bb < vx0 || a > vx1 || d < vy0 || c > vy1) return false;
    if (l.shaded || l.pane === 'fed') {
      mx0 = Math.min(mx0, a); my0 = Math.min(my0, c); mx1 = Math.max(mx1, bb); my1 = Math.max(my1, d);
    }
    return true;
  });
  if (!isFinite(mx0)) { [mx0, my0, mx1, my1] = [vx0, vy0, vx1, vy1]; }
  /* The data's extent, but never more than the view. */
  mx0 = Math.max(mx0, vx0); my0 = Math.max(my0, vy0); mx1 = Math.min(mx1, vx1); my1 = Math.min(my1, vy1);
  const k = Math.min(box.w / (mx1 - mx0), box.h / (my1 - my0));
  const ox = box.x + (box.w - k * (mx1 - mx0)) / 2, oy = box.y + (box.h - k * (my1 - my0)) / 2;
  const path = d3.geoPath(d3.geoTransform({
    point(lon, lat) { const [x, y] = merc(lon, lat); this.stream.point(ox + k * (x - mx0), oy + k * (y - my0)); },
  }));
  const clip = gfx.el(gfx.el(svg, 'defs'), 'clipPath', { id: 'g-view' });
  gfx.el(clip, 'rect', { x: ox, y: oy, width: k * (mx1 - mx0), height: k * (my1 - my0) });
  const g = gfx.el(svg, 'g', { 'clip-path': 'url(#g-view)' });
  for (const pane of ['fed', 'prov']) {
    for (const l of inView.filter((x) => x.pane === pane)) {
      gfx.el(g, 'path', { d: path(l.feature),
        fill: l.shaded ? l.fill : (pane === 'fed' ? T.nodata : 'none'),
        'fill-opacity': l.shaded ? opacityOf(l) : 1,
        stroke: pane === 'prov' && !l.shaded ? T.accent : T.line,
        'stroke-width': (pane === 'prov' && !l.shaded ? 1 : 0.4) * s, 'stroke-linejoin': 'round' });
    }
  }
  return new XMLSerializer().serializeToString(svg);
}

/* SVG to PNG at full size. The fonts travel inside the SVG, so the image
   renders with them even though an <img> cannot see the page's fonts. */
async function graphicPng(spec) {
  const size = GRAPHIC.sizes[spec.size] || GRAPHIC.sizes.substack;
  const url = URL.createObjectURL(new Blob([graphicSvg(spec)], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = size.w; canvas.height = size.h;
    canvas.getContext('2d').drawImage(img, 0, 0, size.w, size.h);
    return await new Promise((ok) => canvas.toBlob(ok, 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

function graphicSpec() {
  return { kicker: $('g-kicker').value.trim(), title: $('g-title').value.trim(),
           subtitle: $('g-subtitle').value.trim(), source: $('g-source').value.trim(),
           size: $('g-size').value, theme: $('g-theme').value, handle: $('g-handle').checked,
           stretch: $('g-stretch').checked, outlines: $('g-outlines').checked };
}
let graphicTimer = null;
function graphicPreview() {
  clearTimeout(graphicTimer);
  graphicTimer = setTimeout(() => {
    const spec = graphicSpec();
    $('g-preview').innerHTML = graphicSvg(spec);
    const svg = $('g-preview').querySelector('svg');
    svg.removeAttribute('width'); svg.removeAttribute('height');
  }, 120);
}
async function openGraphic() {
  await document.fonts.ready;
  for (const f of ["700 20px 'Libre Franklin'", "italic 400 20px 'Source Serif 4'",
                   "600 20px 'IBM Plex Mono'", "400 20px 'IBM Plex Mono'"]) {
    try { await document.fonts.load(f); } catch (e) { /* the fallbacks will do */ }
  }
  const d = graphicDefaults();
  for (const k of ['kicker', 'subtitle', 'source']) $('g-' + k).value = d[k];
  $('g-title').value = '';
  $('graphic-dialog').showModal();
  graphicPreview();
  $('g-title').focus();
}
$('graphic-open').addEventListener('click', openGraphic);
for (const id of ['g-kicker', 'g-title', 'g-subtitle', 'g-source', 'g-size', 'g-theme', 'g-handle',
                  'g-stretch', 'g-outlines']) {
  $(id).addEventListener('input', graphicPreview);
}
$('g-close').addEventListener('click', () => $('graphic-dialog').close());
$('g-download').addEventListener('click', async () => {
  const spec = graphicSpec();
  const btn = $('g-download');
  btn.disabled = true;
  try {
    const blob = await graphicPng(spec);
    const a = document.createElement('a');
    const slug = (spec.title || spec.kicker || 'map').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    a.href = URL.createObjectURL(blob);
    a.download = `balagan-${slug}-${spec.size}.png`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } finally {
    btn.disabled = false;
  }
});
