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

  /* Pair up the .shp/.dbf/.prj members of a zipped shapefile by stem. */
  async function shapefileFromZip(zip, warnings) {
    let stem = null;
    for (const name of zip.keys()) {
      if (name.includes('__MACOSX') || baseName(name).startsWith('.')) continue;
      if (extensionOf(name) === 'shp') { stem = name.replace(/\.shp$/i, ''); break; }
    }
    if (stem === null) return null;
    const at = async (ext) => {
      for (const [name, open] of zip) {
        if (name.toLowerCase() === (stem + '.' + ext).toLowerCase()) return open();
      }
      return null;
    };
    const shpBytes = await at('shp');
    const geometries = BinaryFormats.readShp(shpBytes);
    const dbfBytes = await at('dbf');
    let rows = [];
    if (dbfBytes) {
      rows = BinaryFormats.readDbf(dbfBytes, TextFormats.decodeBytes).rows;
    } else {
      warnings.push('No .dbf in the archive, so the shapes arrived without attributes. '
        + 'Include the .dbf to label the voting areas.');
    }
    const prjBytes = await at('prj');
    const declared = prjBytes ? Geo.crsFromWkt(TextFormats.decodeBytes(prjBytes)) : null;
    if (!prjBytes) warnings.push('No .prj in the archive; the coordinate system was inferred from the extent.');
    const features = [];
    geometries.forEach((geometry, i) => {
      if (!geometry) return;
      features.push({ type: 'Feature', properties: rows[i] || {}, geometry });
    });
    return { features, declared, label: baseName(stem) + '.shp' };
  }

  /* --- Boundary files ---------------------------------------------------- */

  async function loadBoundaries(fileName, bytes) {
    const warnings = [];
    const ext = extensionOf(fileName);
    let features = [], declared = null, label = fileName;

    const fromText = (text, how) => {
      if (how === 'kml') return { features: TextFormats.kmlToFeatures(text), declared: 'EPSG:4326' };
      const obj = JSON.parse(text);
      if (obj && obj.type === 'Topology') {
        throw new Error('This is TopoJSON. Convert it to GeoJSON first (mapshaper.org will do it).');
      }
      return { features: featuresFromGeoJson(obj), declared: crsFromGeoJson(obj) };
    };

    if (ext === 'zip' || ext === 'kmz') {
      const zip = BinaryFormats.readZip(bytes);
      const shp = await shapefileFromZip(zip, warnings);
      if (shp) {
        ({ features, declared, label } = shp);
      } else {
        const inner = await firstMatchingEntry(zip, (n) => /\.(kml|geojson|json)$/i.test(n));
        if (!inner) {
          throw new Error('The archive holds no .shp, .kml or .geojson. '
            + `It contains: ${[...zip.keys()].slice(0, 8).join(', ') || '(nothing)'}.`);
        }
        const text = TextFormats.decodeBytes(inner.bytes);
        ({ features, declared } = fromText(text, extensionOf(inner.name) === 'kml' ? 'kml' : 'json'));
        label = baseName(inner.name);
      }
    } else if (ext === 'kml') {
      ({ features, declared } = fromText(TextFormats.decodeBytes(bytes), 'kml'));
    } else if (ext === 'shp') {
      throw new Error('A .shp on its own has no attributes or projection. '
        + 'Zip it together with the matching .dbf and .prj and load the .zip.');
    } else {
      ({ features, declared } = fromText(TextFormats.decodeBytes(bytes), 'json'));
    }

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
    return { features: normalized, crs, crsLabel: Geo.crsName(crs), label, warnings };
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

  return { loadBoundaries, loadTable, normalizeFeature, crsFromGeoJson, overallExtent };
})();
