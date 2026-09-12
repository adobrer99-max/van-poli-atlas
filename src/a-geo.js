/* ---------------------------------------------------------------------------
   Geo core: coordinate reference systems, point-in-polygon, spatial indexing.
   Everything here is plain arithmetic so the atlas stays a single offline file.
--------------------------------------------------------------------------- */
const Geo = (() => {
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;

  /* --- GRS80 / WGS84 ellipsoid (NAD83 and WGS84 differ by well under a metre
         at this latitude, which is far below polling-boundary precision). --- */
  const A = 6378137.0, F = 1 / 298.257222101;
  const E2 = F * (2 - F), E = Math.sqrt(E2);

  /* Authalic radius helper q(phi) -- Snyder (3-12). */
  const qOf = (sinPhi) =>
    (1 - E2) * (sinPhi / (1 - E2 * sinPhi * sinPhi) -
      (1 / (2 * E)) * Math.log((1 - E * sinPhi) / (1 + E * sinPhi)));
  const mOf = (sinPhi, cosPhi) => cosPhi / Math.sqrt(1 - E2 * sinPhi * sinPhi);

  /* Latitude from authalic q by Newton iteration -- Snyder (3-16). */
  function phiFromQ(q) {
    let phi = Math.asin(Math.max(-1, Math.min(1, q / 2)));
    for (let i = 0; i < 12; i++) {
      const s = Math.sin(phi), c = Math.cos(phi);
      if (Math.abs(c) < 1e-12) break;
      const t = 1 - E2 * s * s;
      const d = (t * t / (2 * c)) *
        (q / (1 - E2) - s / t + (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)));
      phi += d;
      if (Math.abs(d) < 1e-12) break;
    }
    return phi;
  }

  /* Albers Equal Area Conic inverse. BC Albers (EPSG:3005) is the default. */
  function albersInverse(opts) {
    const { lat1, lat2, lat0, lon0, x0, y0 } = opts;
    const s1 = Math.sin(lat1 * D2R), c1 = Math.cos(lat1 * D2R);
    const s2 = Math.sin(lat2 * D2R), c2 = Math.cos(lat2 * D2R);
    const m1 = mOf(s1, c1), m2 = mOf(s2, c2);
    const q1 = qOf(s1), q2 = qOf(s2), q0 = qOf(Math.sin(lat0 * D2R));
    const n = Math.abs(q2 - q1) < 1e-12 ? s1 : (m1 * m1 - m2 * m2) / (q2 - q1);
    const C = m1 * m1 + n * q1;
    const rho0 = A * Math.sqrt(Math.max(0, C - n * q0)) / n;
    return (x, y) => {
      const xs = x - x0, ys = rho0 - (y - y0);
      const sign = n < 0 ? -1 : 1;
      const rho = sign * Math.hypot(xs, ys);
      const theta = Math.atan2(sign * xs, sign * ys);
      const q = (C - (rho * rho * n * n) / (A * A)) / n;
      return [lon0 + (theta / n) * R2D, phiFromQ(q) * R2D];
    };
  }

  /* Transverse Mercator inverse (UTM). */
  function tmInverse(opts) {
    const { lon0, k0, x0, y0 } = opts;
    const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
    const ep2 = E2 / (1 - E2);
    return (x, y) => {
      const xs = x - x0, ys = y - y0;
      const M = ys / k0;
      const mu = M / (A * (1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 ** 3 / 256));
      const p1 = mu +
        (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) +
        (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu) +
        (151 * e1 ** 3 / 96) * Math.sin(6 * mu) +
        (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
      const sp = Math.sin(p1), cp = Math.cos(p1), tp = Math.tan(p1);
      const C1 = ep2 * cp * cp, T1 = tp * tp;
      const N1 = A / Math.sqrt(1 - E2 * sp * sp);
      const R1 = A * (1 - E2) / Math.pow(1 - E2 * sp * sp, 1.5);
      const D = xs / (N1 * k0);
      const lat = p1 - (N1 * tp / R1) * (D * D / 2 -
        (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24 +
        (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720);
      const lon = lon0 * D2R + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 +
        (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / cp;
      return [lon * R2D, lat * R2D];
    };
  }

  const webMercatorInverse = (x, y) => [
    (x / 20037508.342789244) * 180,
    R2D * (2 * Math.atan(Math.exp((y / 20037508.342789244) * Math.PI)) - Math.PI / 2),
  ];

  const CRS = {
    'EPSG:4326': { name: 'WGS 84 / NAD 83 lon-lat', inverse: null },
    'EPSG:3005': {
      name: 'BC Albers (EPSG:3005)',
      inverse: albersInverse({ lat1: 50, lat2: 58.5, lat0: 45, lon0: -126, x0: 1000000, y0: 0 }),
    },
    'EPSG:3153': {
      name: 'BC Albers / NAD83(CSRS) (EPSG:3153)',
      inverse: albersInverse({ lat1: 50, lat2: 58.5, lat0: 45, lon0: -126, x0: 1000000, y0: 0 }),
    },
    'EPSG:26910': {
      name: 'NAD83 / UTM zone 10N',
      inverse: tmInverse({ lon0: -123, k0: 0.9996, x0: 500000, y0: 0 }),
    },
    'EPSG:26909': {
      name: 'NAD83 / UTM zone 9N',
      inverse: tmInverse({ lon0: -129, k0: 0.9996, x0: 500000, y0: 0 }),
    },
    'EPSG:26911': {
      name: 'NAD83 / UTM zone 11N',
      inverse: tmInverse({ lon0: -117, k0: 0.9996, x0: 500000, y0: 0 }),
    },
    'EPSG:3857': { name: 'Web Mercator (EPSG:3857)', inverse: webMercatorInverse },
  };

  /* Read a .prj WKT well enough to pick the right inverse. */
  function crsFromWkt(wkt) {
    if (!wkt) return null;
    const w = wkt.replace(/\s+/g, ' ');
    const up = w.toUpperCase();
    const epsg = /AUTHORITY\s*\[\s*"EPSG"\s*,\s*"(\d+)"\s*\]\s*\]\s*$/i.exec(w);
    if (epsg && CRS['EPSG:' + epsg[1]]) return 'EPSG:' + epsg[1];
    if (!/PROJCS/i.test(up)) return 'EPSG:4326';
    if (/ALBERS/.test(up)) {
      const num = (key) => {
        const m = new RegExp('PARAMETER\\s*\\[\\s*"' + key + '"\\s*,\\s*(-?[\\d.]+)', 'i').exec(w);
        return m ? parseFloat(m[1]) : null;
      };
      const lat1 = num('standard_parallel_1'), lat2 = num('standard_parallel_2');
      const lat0 = num('latitude_of_center') ?? num('latitude_of_origin');
      const lon0 = num('longitude_of_center') ?? num('central_meridian');
      const x0 = num('false_easting') ?? 0, y0 = num('false_northing') ?? 0;
      if ([lat1, lat2, lat0, lon0].every((v) => v != null)) {
        const key = 'WKT:Albers';
        CRS[key] = {
          name: `Albers (${lat1}/${lat2}, ${lon0})`,
          inverse: albersInverse({ lat1, lat2, lat0, lon0, x0, y0 }),
        };
        return key;
      }
      return 'EPSG:3005';
    }
    if (/MERCATOR_AUXILIARY_SPHERE|POPULAR VISUALISATION|WEB[ _]MERCATOR|PSEUDO-MERCATOR/.test(up)) {
      return 'EPSG:3857';
    }
    if (/TRANSVERSE_MERCATOR/.test(up)) {
      const m = /PARAMETER\s*\[\s*"central_meridian"\s*,\s*(-?[\d.]+)/i.exec(w);
      const cm = m ? parseFloat(m[1]) : -123;
      const zone = Math.round((cm + 183) / 6);
      return CRS['EPSG:' + (26900 + zone)] ? 'EPSG:' + (26900 + zone) : 'EPSG:26910';
    }
    return null;
  }

  /* Fall back to coordinate magnitudes when no .prj travels with the data. */
  function crsFromExtent(minX, minY, maxX, maxY) {
    if (maxX <= 180 && minX >= -180 && maxY <= 90 && minY >= -90) return 'EPSG:4326';
    if (minX > 2e5 && maxX < 2.0e6 && minY > 3e5 && maxY < 1.9e6) return 'EPSG:3005';
    if (minX > 1.6e5 && maxX < 8.4e5 && minY > 4.5e6 && maxY < 7.0e6) return 'EPSG:26910';
    if (Math.abs(maxX) <= 20037509 && Math.abs(maxY) <= 20037509) return 'EPSG:3857';
    return null;
  }

  const project = (crsKey) => (CRS[crsKey] && CRS[crsKey].inverse) || null;
  const crsName = (key) => (CRS[key] ? CRS[key].name : key || 'unknown');

  /* --- Geometry ---------------------------------------------------------- */

  /* Ray casting against one ring; ring is a flat array of [x, y]. */
  function inRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  /* A polygon is [outerRing, ...holes]; multipolygons are arrays of those. */
  function inPolygon(x, y, poly) {
    if (!inRing(x, y, poly[0])) return false;
    for (let i = 1; i < poly.length; i++) if (inRing(x, y, poly[i])) return false;
    return true;
  }

  function inGeometry(x, y, geom) {
    if (geom.type === 'Polygon') return inPolygon(x, y, geom.coordinates);
    if (geom.type === 'MultiPolygon') {
      for (const p of geom.coordinates) if (inPolygon(x, y, p)) return true;
    }
    return false;
  }

  function bboxOf(geom) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const walk = (c) => {
      if (typeof c[0] === 'number') {
        if (c[0] < minX) minX = c[0];
        if (c[0] > maxX) maxX = c[0];
        if (c[1] < minY) minY = c[1];
        if (c[1] > maxY) maxY = c[1];
      } else for (const k of c) walk(k);
    };
    if (geom && geom.coordinates) walk(geom.coordinates);
    return [minX, minY, maxX, maxY];
  }

  /* Area is measured on the authalic sphere: the sphere with the same surface
     area as the ellipsoid. Both halves of that substitution are required --
     the authalic radius AND authalic latitudes. Geodetic latitudes in a
     spherical formula leave a latitude-dependent error of order e^2 (~0.3%
     here) that the authalic latitude removes. */
  const Q_P = qOf(1);
  const R_AUTHALIC = A * Math.sqrt(Q_P / 2);
  const sinAuthalic = (latDeg) => qOf(Math.sin(latDeg * D2R)) / Q_P;

  /* Spherical-excess ring area in m^2; sign gives winding. */
  function ringAreaM2(ring) {
    if (ring.length < 3) return 0;
    let total = 0;
    let prev = sinAuthalic(ring[ring.length - 1][1]);
    for (let i = 0; i < ring.length; i++) {
      const j = i === 0 ? ring.length - 1 : i - 1;
      const cur = sinAuthalic(ring[i][1]);
      total += (ring[i][0] - ring[j][0]) * D2R * (2 + prev + cur);
      prev = cur;
    }
    return (total * R_AUTHALIC * R_AUTHALIC) / 2;
  }

  function areaM2(geom) {
    const polyArea = (poly) => poly.reduce(
      (sum, ring, i) => sum + (i === 0 ? 1 : -1) * Math.abs(ringAreaM2(ring)), 0);
    if (!geom) return 0;
    if (geom.type === 'Polygon') return Math.abs(polyArea(geom.coordinates));
    if (geom.type === 'MultiPolygon') {
      return geom.coordinates.reduce((s, p) => s + Math.abs(polyArea(p)), 0);
    }
    return 0;
  }

  /* d3-geo reads polygons on the sphere and takes the interior to be the side
     to the RIGHT of the ring direction, so exterior rings must run clockwise
     (negative shoelace) and holes counter-clockwise. RFC 7946 mandates exactly
     the opposite, so a standards-compliant GeoJSON -- what ogr2ogr, mapshaper
     and most APIs emit -- renders as the whole globe minus the polygon unless
     the winding is normalised on the way in. */
  const signedArea2 = (ring) => {
    let s = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      s += a[0] * b[1] - b[0] * a[1];
    }
    return s / 2;
  };

  function windPolygon(rings) {
    return rings.map((ring, i) => {
      const area = signedArea2(ring);
      const wantNegative = i === 0;          // exterior clockwise, holes the other way
      const isNegative = area < 0;
      return isNegative === wantNegative ? ring : ring.slice().reverse();
    });
  }

  function normalizeWinding(geom) {
    if (!geom) return geom;
    if (geom.type === 'Polygon') {
      geom.coordinates = windPolygon(geom.coordinates);
    } else if (geom.type === 'MultiPolygon') {
      geom.coordinates = geom.coordinates.map(windPolygon);
    }
    return geom;
  }

  /* A point guaranteed to lie inside the geometry. The centroid of a
     C-shaped or ring-shaped polygon can fall outside it, so fall back to the
     widest interior span of a horizontal scan line. */
  function representativePoint(geom) {
    const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
    let best = null, bestArea = -Infinity;
    for (const poly of polys) {
      const a = Math.abs(ringAreaM2(poly[0]));
      if (a > bestArea) { bestArea = a; best = poly; }
    }
    if (!best) return null;
    const ring = best[0];
    let cx = 0, cy = 0;
    for (const pt of ring) { cx += pt[0]; cy += pt[1]; }
    cx /= ring.length; cy /= ring.length;
    if (inPolygon(cx, cy, best)) return [cx, cy];

    const crossings = [];
    for (const r of best) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const yi = r[i][1], yj = r[j][1];
        if ((yi > cy) !== (yj > cy)) {
          crossings.push(r[j][0] + ((r[i][0] - r[j][0]) * (cy - yj)) / (yi - yj));
        }
      }
    }
    crossings.sort((a, b) => a - b);
    let widest = 0, px = null;
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const span = crossings[i + 1] - crossings[i];
      if (span > widest) { widest = span; px = (crossings[i] + crossings[i + 1]) / 2; }
    }
    if (px != null) return [px, cy];
    return [ring[0][0], ring[0][1]];
  }

  /* Uniform-grid index over feature bounding boxes. Polling polygons are
     small and evenly sized, so a flat grid beats a tree here. */
  function buildIndex(features, cells = 96) {
    const boxes = features.map((f) => bboxOf(f.geometry));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of boxes) {
      if (!isFinite(b[0])) continue;
      minX = Math.min(minX, b[0]); minY = Math.min(minY, b[1]);
      maxX = Math.max(maxX, b[2]); maxY = Math.max(maxY, b[3]);
    }
    if (!isFinite(minX)) return { boxes, query: () => [], extent: null };
    const w = (maxX - minX) || 1e-9, h = (maxY - minY) || 1e-9;
    const grid = new Map();
    const cx = (x) => Math.max(0, Math.min(cells - 1, Math.floor(((x - minX) / w) * cells)));
    const cy = (y) => Math.max(0, Math.min(cells - 1, Math.floor(((y - minY) / h) * cells)));
    boxes.forEach((b, i) => {
      if (!isFinite(b[0])) return;
      for (let gx = cx(b[0]); gx <= cx(b[2]); gx++) {
        for (let gy = cy(b[1]); gy <= cy(b[3]); gy++) {
          const k = gx * cells + gy;
          let bucket = grid.get(k);
          if (!bucket) grid.set(k, (bucket = []));
          bucket.push(i);
        }
      }
    });
    return {
      boxes,
      extent: [minX, minY, maxX, maxY],
      query(x, y) {
        if (x < minX || x > maxX || y < minY || y > maxY) return [];
        return grid.get(cx(x) * cells + cy(y)) || [];
      },
      /* Index of the first feature whose polygon contains the point. */
      hit(x, y) {
        const cand = this.query(x, y);
        for (const i of cand) {
          const b = boxes[i];
          if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue;
          if (inGeometry(x, y, features[i].geometry)) return i;
        }
        return -1;
      },
    };
  }

  return {
    CRS, crsFromWkt, crsFromExtent, project, crsName, R_AUTHALIC,
    inRing, inPolygon, inGeometry, bboxOf, areaM2, buildIndex, representativePoint,
    normalizeWinding, signedArea2,
  };
})();
