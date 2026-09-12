/* ---------------------------------------------------------------------------
   Ingest: turn whatever file the user drops in into WGS84 polygon features,
   or into a header/rows table. Accepts the shapes Elections BC and Elections
   Canada actually publish: GeoJSON, KML, KMZ, and zipped shapefiles.
--------------------------------------------------------------------------- */
const Ingest = (() => {
  const extensionOf = (name) => (name.toLowerCase().match(/\.([a-z0-9]+)$/) || [, ''])[1];
  const baseName = (path) => path.split('/').pop();

  /* Old-style GeoJSON carried a crs member; RFC 7946 dropped it but Esri and
     DataBC exports still emit one. */
  function crsFromGeoJson(obj) {
    const name = obj && obj.crs && obj.crs.properties && obj.crs.properties.name;
    if (typeof name !== 'string') return null;
    const m = name.match(/EPSG:{1,2}(\d+)/i) || name.match(/EPSG[:_](\d+)/i);
    if (m) return 'EPSG:' + m[1];
    if (/CRS84|4326/.test(name)) return 'EPSG:4326';
    return null;
  }

  const geometriesOf = (geometry, out = []) => {
    if (!geometry) return out;
    if (geometry.type === 'GeometryCollection') {
      for (const g of geometry.geometries || []) geometriesOf(g, out);
    } else out.push(geometry);
    return out;
  };

  /* Keep only areal geometry and flatten each feature to one Polygon or
     MultiPolygon so downstream code has a single shape to reason about. */
  function normalizeFeature(feature) {
    const polys = [];
    for (const g of geometriesOf(feature.geometry)) {
      if (g.type === 'Polygon') polys.push(g.coordinates);
      else if (g.type === 'MultiPolygon') for (const p of g.coordinates) polys.push(p);
    }
    if (!polys.length) return null;
    return {
      type: 'Feature',
      properties: feature.properties || {},
      geometry: Geo.normalizeWinding(polys.length === 1
        ? { type: 'Polygon', coordinates: polys[0] }
        : { type: 'MultiPolygon', coordinates: polys }),
    };
  }

  function featuresFromGeoJson(obj) {
    if (!obj || typeof obj !== 'object') return [];
    if (obj.type === 'FeatureCollection') return (obj.features || []);
    if (obj.type === 'Feature') return [obj];
    if (obj.type && obj.coordinates) return [{ type: 'Feature', properties: {}, geometry: obj }];
    return [];
  }

  function overallExtent(features) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const f of features) {
      const b = Geo.bboxOf(f.geometry);
      if (!isFinite(b[0])) continue;
      minX = Math.min(minX, b[0]); minY = Math.min(minY, b[1]);
      maxX = Math.max(maxX, b[2]); maxY = Math.max(maxY, b[3]);
    }
    return [minX, minY, maxX, maxY];
  }

  function reprojectInPlace(features, project) {
    if (!project) return;
    const cache = new Map();
    const conv = (pt) => {
      const key = pt[0] + ',' + pt[1];
      let v = cache.get(key);
      if (!v) { v = project(pt[0], pt[1]); cache.set(key, v); }
      return v;
    };
    for (const f of features) {
      const walk = (c) => (typeof c[0][0] === 'number' ? c.map(conv) : c.map(walk));
      f.geometry.coordinates = walk(f.geometry.coordinates);
    }
  }

  /* Settles the CRS from whatever evidence travelled with the file, then
     converts to lon/lat. Returns the label to show in the UI. */
  function toWgs84(features, declaredCrs, warnings) {
    const extent = overallExtent(features);
    let crs = declaredCrs;
    if (!crs || !Geo.CRS[crs]) {
      const sniffed = Geo.crsFromExtent(extent[0], extent[1], extent[2], extent[3]);
      if (declaredCrs && !Geo.CRS[declaredCrs]) {
        warnings.push(`Coordinate system ${declaredCrs} is not built in; `
          + `treating the data as ${sniffed ? Geo.crsName(sniffed) : 'unknown'} based on its extent.`);
      }
      crs = sniffed;
    }
    if (!crs) {
      warnings.push('Could not identify the coordinate system. Coordinates were left as-is, '
        + 'so the layer will not line up. Re-export as GeoJSON in WGS84 (EPSG:4326).');
      return 'unknown';
    }
    reprojectInPlace(features, Geo.project(crs));
    return crs;
  }

  async function firstMatchingEntry(zip, test) {
    for (const [name, open] of zip) {
      if (baseName(name).startsWith('.') || name.includes('__MACOSX')) continue;
      if (test(name)) return { name, bytes: await open() };
    }
    return null;
  }

  /* Entries above this many bytes are parsed from a stream instead of being
     inflated whole: a national dissemination-block shapefile is ~1.1 GB. */
  const STREAM_THRESHOLD = 256 * 1024 * 1024;

  /* The first 100 bytes of a .shp, read without inflating the rest, give the
     file's own bounding box -- enough to sniff its coordinate system. */
  async function peekShpHeader(open) {
    if (!open.stream) return BinaryFormats.shpHeaderBox(await open());
    const reader = (await open.stream()).getReader();
    let buf = new Uint8Array(0);
    while (buf.byteLength < 100) {
      const { value, done } = await reader.read();
      if (done) break;
      const merged = new Uint8Array(buf.byteLength + value.byteLength);
      merged.set(buf); merged.set(value, buf.byteLength);
      buf = merged;
    }
    try { await reader.cancel(); } catch (e) { /* stream already finished */ }
    return BinaryFormats.shpHeaderBox(buf);
  }

  /* A record is kept when its bounding box, taken to lon/lat, overlaps the
     study-area box. Four corners are exact for an axis-aligned box in lon/lat
     and within metres for census polygons in a conic projection; the caller
     pads the box. */
  function bboxKeep(target, inverse) {
    const [tx0, ty0, tx1, ty1] = target;
    return (box) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]]) {
        const q = inverse ? inverse(x, y) : [x, y];
        if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0];
        if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1];
      }
      return x1 >= tx0 && x0 <= tx1 && y1 >= ty0 && y0 <= ty1;
    };
  }

  const bboxTouches = (a, b) => a[2] >= b[0] && a[0] <= b[2] && a[3] >= b[1] && a[1] <= b[3];

  /* Pair up the .shp/.dbf/.prj members of a zipped shapefile by stem. The .prj
     is read first so a study-area box can filter records before any geometry
     is parsed; entries too big to hold whole are streamed. */
  async function shapefileFromZip(zip, warnings, options = {}) {
    let stem = null;
    for (const name of zip.keys()) {
      if (name.includes('__MACOSX') || baseName(name).startsWith('.')) continue;
      if (extensionOf(name) === 'shp') { stem = name.replace(/\.shp$/i, ''); break; }
    }
    if (stem === null) return null;
    const opener = (ext) => {
      for (const [name, open] of zip) {
        if (name.toLowerCase() === (stem + '.' + ext).toLowerCase()) return open;
      }
      return null;
    };
    const shpOpen = opener('shp'), dbfOpen = opener('dbf'), prjOpen = opener('prj');
    const declared = prjOpen ? Geo.crsFromWkt(TextFormats.decodeBytes(await prjOpen())) : null;
    if (!prjOpen) warnings.push('No .prj in the archive; the coordinate system was inferred from the extent.');

    const streamAbove = options.streamAbove ?? STREAM_THRESHOLD;
    const big = (open) => Boolean(open && open.stream && open.size > streamAbove);

    let keep = null, filtered = false;
    if (options.bbox) {
      let crs = declared && Geo.CRS[declared] ? declared : null;
      if (!crs) {
        const hb = await peekShpHeader(shpOpen);
        crs = hb ? Geo.crsFromExtent(hb[0], hb[1], hb[2], hb[3]) : null;
      }
      if (crs) { keep = bboxKeep(options.bbox, Geo.project(crs)); filtered = true; }
      else warnings.push('Could not identify the coordinate system, so the file was read whole instead of clipped to the study area.');
    }
    const geometries = big(shpOpen)
      ? await BinaryFormats.readShpStream(await shpOpen.stream(), { keep })
      : BinaryFormats.readShp(await shpOpen(), { keep });
    let rows = [];
    if (dbfOpen) {
      const keepRow = keep ? (i) => geometries[i] != null : null;
      rows = big(dbfOpen)
        ? (await BinaryFormats.readDbfStream(await dbfOpen.stream(), TextFormats.decodeBytes, { keep: keepRow })).rows
        : BinaryFormats.readDbf(await dbfOpen(), TextFormats.decodeBytes, { keep: keepRow }).rows;
    } else {
      warnings.push('No .dbf in the archive, so the shapes arrived without attributes. '
        + 'Include the .dbf to label the areas.');
    }
    const features = [];
    geometries.forEach((geometry, i) => {
      if (!geometry) return;
      features.push({ type: 'Feature', properties: rows[i] || {}, geometry });
    });
    return { features, declared, label: baseName(stem) + '.shp', records: geometries.length, filtered };
  }

  /* --- Boundary files ---------------------------------------------------- */

  /* source: a Uint8Array, or a File/Blob (read lazily, so a zipped shapefile
     far larger than memory can still be clipped to the study area).
     options.bbox: [minLon, minLat, maxLon, maxLat] -- keep only features whose
     bounding box touches it; options.streamAbove overrides STREAM_THRESHOLD. */
  async function loadBoundaries(fileName, source, options = {}) {
    const warnings = [];
    const ext = extensionOf(fileName);
    const isBlob = typeof Blob !== 'undefined' && source instanceof Blob;
    const bytesOf = async () => (isBlob ? new Uint8Array(await source.arrayBuffer()) : source);
    let features = [], declared = null, label = fileName, records = null, filtered = false;

    const fromText = (text, how) => {
      if (how === 'kml') return { features: TextFormats.kmlToFeatures(text), declared: 'EPSG:4326' };
      const obj = JSON.parse(text);
      if (obj && obj.type === 'Topology') {
        throw new Error('This is TopoJSON. Convert it to GeoJSON first (mapshaper.org will do it).');
      }
      return { features: featuresFromGeoJson(obj), declared: crsFromGeoJson(obj) };
    };

    if (ext === 'zip' || ext === 'kmz') {
      const zip = isBlob ? await BinaryFormats.readZipBlob(source) : BinaryFormats.readZip(source);
      const shp = await shapefileFromZip(zip, warnings, options);
      if (shp) {
        ({ features, declared, label, records, filtered } = shp);
      } else {
        const inner = await firstMatchingEntry(zip, (n) => /\.(kml|geojson)$/i.test(n))
          || await firstMatchingEntry(zip, (n) => /\.json$/i.test(n));
        if (!inner) {
          throw new Error('The archive holds no .shp, .kml or .geojson. '
            + `It contains: ${[...zip.keys()].slice(0, 8).join(', ') || '(nothing)'}.`);
        }
        const text = TextFormats.decodeBytes(inner.bytes);
        ({ features, declared } = fromText(text, extensionOf(inner.name) === 'kml' ? 'kml' : 'json'));
        label = baseName(inner.name);
      }
    } else if (ext === 'kml') {
      ({ features, declared } = fromText(TextFormats.decodeBytes(await bytesOf()), 'kml'));
    } else if (ext === 'shp') {
      throw new Error('A .shp on its own has no attributes or projection. '
        + 'Zip it together with the matching .dbf and .prj and load the .zip.');
    } else {
      ({ features, declared } = fromText(TextFormats.decodeBytes(await bytesOf()), 'json'));
    }
    if (records == null) records = features.length;

    const normalized = [];
    let dropped = 0;
    for (const f of features) {
      const n = normalizeFeature(f);
      if (n) normalized.push(n); else dropped++;
    }
    if (!normalized.length) {
      throw new Error('No polygon features were found in this file. '
        + (dropped ? `${dropped} non-polygon features were skipped.` : ''));
    }
    if (dropped) {
      warnings.push(`${dropped} non-polygon features (points or lines) were skipped.`);
    }
    const crs = toWgs84(normalized, declared, warnings);
    let kept = normalized;
    if (options.bbox) {
      kept = normalized.filter((f) => bboxTouches(Geo.bboxOf(f.geometry), options.bbox));
      filtered = true;
      if (!kept.length) {
        throw new Error('None of the polygons in this file touch the study area. '
          + 'Untick the clipping option to load it whole, or check that it covers Vancouver.');
      }
    }
    return { features: kept, crs, crsLabel: Geo.crsName(crs), label, warnings,
             records, kept: kept.length, filtered };
  }

  /* --- Tables ------------------------------------------------------------ */

  async function loadTable(fileName, bytes) {
    let name = fileName, data = bytes;
    if (extensionOf(fileName) === 'zip') {
      const zip = BinaryFormats.readZip(bytes);
      const inner = await firstMatchingEntry(zip, (n) => /\.(csv|tsv|txt)$/i.test(n));
      if (!inner) {
        throw new Error('The archive holds no .csv. '
          + `It contains: ${[...zip.keys()].slice(0, 8).join(', ') || '(nothing)'}.`);
      }
      name = baseName(inner.name);
      data = inner.bytes;
    }
    const text = TextFormats.decodeBytes(data);
    const table = TextFormats.parseDelimited(text);
    if (!table.header.length) throw new Error(`${name} has no header row.`);
    return { ...table, name };
  }

  return { loadBoundaries, loadTable, normalizeFeature, crsFromGeoJson, overallExtent, STREAM_THRESHOLD, bboxKeep };
})();
