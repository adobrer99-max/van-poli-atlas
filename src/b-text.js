/* ---------------------------------------------------------------------------
   Text format readers: delimited text, a small XML pull parser, and KML.
   A hand-rolled XML reader keeps this testable outside a browser and avoids
   depending on DOMParser quirks for the large KML files Elections BC ships.
--------------------------------------------------------------------------- */
const TextFormats = (() => {

  /* --- Delimited text ---------------------------------------------------- */

  /* Sniff the delimiter from the header line, ignoring quoted spans. Elections
     Canada headers are bilingual and contain slashes and commas inside quotes. */
  function sniffDelimiter(text) {
    const firstLine = (() => {
      let quoted = false;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '"') quoted = !quoted;
        else if (!quoted && (c === '\n' || c === '\r')) return text.slice(0, i);
      }
      return text.slice(0, 4096);
    })();
    const counts = [',', ';', '\t', '|'].map((d) => {
      let n = 0, quoted = false;
      for (const c of firstLine) {
        if (c === '"') quoted = !quoted;
        else if (c === d && !quoted) n++;
      }
      return [d, n];
    });
    counts.sort((a, b) => b[1] - a[1]);
    return counts[0][1] > 0 ? counts[0][0] : ',';
  }

  /* RFC 4180 with the usual real-world tolerances: BOM, CRLF or LF, doubled
     quotes inside quoted fields, and newlines inside quoted fields. */
  function parseDelimited(text, delimiter) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const d = delimiter || sniffDelimiter(text);
    const rows = [];
    let row = [], field = '', quoted = false, i = 0;
    const pushField = () => { row.push(field); field = ''; };
    const pushRow = () => {
      pushField();
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    };
    while (i < text.length) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          quoted = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"' && field === '') { quoted = true; i++; continue; }
      if (c === d) { pushField(); i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { pushRow(); i++; continue; }
      field += c; i++;
    }
    if (field !== '' || row.length) pushRow();
    if (!rows.length) return { header: [], rows: [], delimiter: d };
    const header = rows[0].map((h) => h.trim());
    return { header, rows: rows.slice(1), delimiter: d };
  }

  /* Elections Canada has shipped both UTF-8 and Windows-1252 over the years;
     a replacement character in the decode is the tell. */
  function decodeBytes(bytes) {
    const utf8 = new TextDecoder('utf-8').decode(bytes);
    if (!utf8.includes('�')) return utf8;
    try {
      return new TextDecoder('windows-1252').decode(bytes);
    } catch (_) {
      return utf8;
    }
  }

  /* --- Minimal XML ------------------------------------------------------- */

  /* Returns a tree of { name, attrs, children, text }. Namespace prefixes are
     dropped so kml:Placemark and Placemark are the same node. */
  function parseXml(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const root = { name: '#root', attrs: {}, children: [], text: '' };
    const stack = [root];
    const decodeEntity = (s) => s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X'
          ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e] || m;
    });
    let i = 0;
    while (i < text.length) {
      const lt = text.indexOf('<', i);
      if (lt < 0) break;
      if (lt > i) {
        const chunk = text.slice(i, lt);
        if (chunk.trim()) stack[stack.length - 1].text += decodeEntity(chunk);
      }
      if (text.startsWith('<!--', lt)) {
        const end = text.indexOf('-->', lt);
        i = end < 0 ? text.length : end + 3;
        continue;
      }
      if (text.startsWith('<![CDATA[', lt)) {
        const end = text.indexOf(']]>', lt);
        const stop = end < 0 ? text.length : end;
        stack[stack.length - 1].text += text.slice(lt + 9, stop);
        i = end < 0 ? text.length : end + 3;
        continue;
      }
      if (text.startsWith('<?', lt) || text.startsWith('<!', lt)) {
        const end = text.indexOf('>', lt);
        i = end < 0 ? text.length : end + 1;
        continue;
      }
      const gt = (() => {
        let q = null;
        for (let k = lt + 1; k < text.length; k++) {
          const c = text[k];
          if (q) { if (c === q) q = null; continue; }
          if (c === '"' || c === "'") { q = c; continue; }
          if (c === '>') return k;
        }
        return -1;
      })();
      if (gt < 0) break;
      const raw = text.slice(lt + 1, gt).trim();
      i = gt + 1;
      if (raw.startsWith('/')) {
        const name = raw.slice(1).trim().split(':').pop();
        for (let s = stack.length - 1; s > 0; s--) {
          if (stack[s].name === name) { stack.length = s; break; }
        }
        continue;
      }
      const selfClosing = raw.endsWith('/');
      const body = selfClosing ? raw.slice(0, -1) : raw;
      const sp = body.search(/\s/);
      const name = (sp < 0 ? body : body.slice(0, sp)).split(':').pop();
      const attrs = {};
      if (sp >= 0) {
        const attrRe = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
        let m;
        while ((m = attrRe.exec(body.slice(sp))) !== null) {
          attrs[m[1].split(':').pop()] = decodeEntity(m[3] !== undefined ? m[3] : m[4]);
        }
      }
      const node = { name, attrs, children: [], text: '' };
      stack[stack.length - 1].children.push(node);
      if (!selfClosing) stack.push(node);
    }
    return root;
  }

  const findAll = (node, name, out = []) => {
    for (const c of node.children) {
      if (c.name === name) out.push(c);
      findAll(c, name, out);
    }
    return out;
  };
  const firstChild = (node, name) => node.children.find((c) => c.name === name) || null;
  const childText = (node, name) => {
    const c = firstChild(node, name);
    return c ? c.text.trim() : '';
  };

  /* --- KML --------------------------------------------------------------- */

  const parseCoordString = (s) => {
    const out = [];
    for (const tok of s.trim().split(/\s+/)) {
      if (!tok) continue;
      const parts = tok.split(',');
      const x = parseFloat(parts[0]), y = parseFloat(parts[1]);
      if (isFinite(x) && isFinite(y)) out.push([x, y]);
    }
    return out;
  };

  const closeRing = (ring) => {
    if (ring.length > 2) {
      const a = ring[0], b = ring[ring.length - 1];
      if (a[0] !== b[0] || a[1] !== b[1]) ring.push([a[0], a[1]]);
    }
    return ring;
  };

  function kmlPolygon(node) {
    const outer = firstChild(node, 'outerBoundaryIs');
    if (!outer) return null;
    const outerRing = findAll(outer, 'coordinates').map((c) => parseCoordString(c.text))[0];
    if (!outerRing || outerRing.length < 3) return null;
    const rings = [closeRing(outerRing)];
    for (const inner of node.children.filter((c) => c.name === 'innerBoundaryIs')) {
      for (const c of findAll(inner, 'coordinates')) {
        const r = parseCoordString(c.text);
        if (r.length >= 3) rings.push(closeRing(r));
      }
    }
    return rings;
  }

  /* Placemark properties come from <name>/<description> plus either
     <ExtendedData><SchemaData><SimpleData name=..> or <Data name=..><value>. */
  function kmlProperties(placemark) {
    const props = {};
    const name = childText(placemark, 'name');
    if (name) props.name = name;
    const desc = childText(placemark, 'description');
    if (desc) props.description = desc;
    for (const sd of findAll(placemark, 'SimpleData')) {
      if (sd.attrs.name) props[sd.attrs.name] = sd.text.trim();
    }
    for (const d of findAll(placemark, 'Data')) {
      if (d.attrs.name) props[d.attrs.name] = childText(d, 'value');
    }
    return props;
  }

  function kmlToFeatures(text) {
    const doc = parseXml(text);
    const features = [];
    for (const pm of findAll(doc, 'Placemark')) {
      const polys = [];
      for (const poly of findAll(pm, 'Polygon')) {
        const rings = kmlPolygon(poly);
        if (rings) polys.push(rings);
      }
      if (!polys.length) continue;
      features.push({
        type: 'Feature',
        properties: kmlProperties(pm),
        geometry: polys.length === 1
          ? { type: 'Polygon', coordinates: polys[0] }
          : { type: 'MultiPolygon', coordinates: polys },
      });
    }
    return features;
  }

  return {
    sniffDelimiter, parseDelimited, decodeBytes,
    parseXml, findAll, firstChild, childText,
    kmlToFeatures, parseCoordString,
  };
})();
