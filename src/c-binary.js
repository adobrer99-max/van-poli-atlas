/* ---------------------------------------------------------------------------
   Binary format readers: ZIP (for KMZ and shapefile bundles), DBF and SHP.
   Elections BC and the BC Data Catalogue hand out zipped shapefiles and KMZ,
   so reading them directly saves a conversion step before any analysis.
--------------------------------------------------------------------------- */
const BinaryFormats = (() => {

  /* --- ZIP --------------------------------------------------------------- */

  const SIG_EOCD = 0x06054b50, SIG_CD = 0x02014b50, SIG_LOCAL = 0x04034b50;

  async function inflateRaw(bytes) {
    /* deflate-raw is what ZIP stores; DecompressionStream ships in every
       browser that can run the rest of this file. */
    const source = new ReadableStream({
      start(controller) { controller.enqueue(bytes); controller.close(); },
    });
    const inflated = source.pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(inflated).arrayBuffer());
  }

  function findEocd(view, len) {
    const scanFrom = Math.max(0, len - 66000);
    for (let i = len - 22; i >= scanFrom; i--) {
      if (view.getUint32(i, true) === SIG_EOCD) return i;
    }
    return -1;
  }

  /* ZIP64 stores real sizes in an extra field when the 32-bit slots are
     saturated. Only the three values we need are pulled out. */
  function zip64Patch(extra, entry) {
    let o = 0;
    while (o + 4 <= extra.byteLength) {
      const id = extra.getUint16(o, true), size = extra.getUint16(o + 2, true);
      if (id === 0x0001) {
        let p = o + 4;
        const read = () => { const v = Number(extra.getBigUint64(p, true)); p += 8; return v; };
        if (entry.uncompressedSize === 0xffffffff && p + 8 <= o + 4 + size) entry.uncompressedSize = read();
        if (entry.compressedSize === 0xffffffff && p + 8 <= o + 4 + size) entry.compressedSize = read();
        if (entry.offset === 0xffffffff && p + 8 <= o + 4 + size) entry.offset = read();
        return;
      }
      o += 4 + size;
    }
  }

  /* Reads the central directory and returns { name -> async () => Uint8Array }. */
  function readZip(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = findEocd(view, bytes.byteLength);
    if (eocd < 0) throw new Error('Not a ZIP archive (no end-of-central-directory record).');
    let count = view.getUint16(eocd + 10, true);
    let cdOffset = view.getUint32(eocd + 16, true);
    /* ZIP64 end-of-central-directory locator sits immediately before the EOCD. */
    if ((count === 0xffff || cdOffset === 0xffffffff) && eocd >= 20 &&
        view.getUint32(eocd - 20, true) === 0x07064b50) {
      const z64 = Number(view.getBigUint64(eocd - 20 + 8, true));
      if (view.getUint32(z64, true) === 0x06064b50) {
        count = Number(view.getBigUint64(z64 + 32, true));
        cdOffset = Number(view.getBigUint64(z64 + 48, true));
      }
    }
    const entries = [];
    let o = cdOffset;
    for (let i = 0; i < count && o + 46 <= bytes.byteLength; i++) {
      if (view.getUint32(o, true) !== SIG_CD) break;
      const method = view.getUint16(o + 10, true);
      const nameLen = view.getUint16(o + 28, true);
      const extraLen = view.getUint16(o + 30, true);
      const commentLen = view.getUint16(o + 32, true);
      const entry = {
        name: new TextDecoder('utf-8').decode(bytes.subarray(o + 46, o + 46 + nameLen)),
        method,
        compressedSize: view.getUint32(o + 20, true),
        uncompressedSize: view.getUint32(o + 24, true),
        offset: view.getUint32(o + 42, true),
      };
      if (extraLen) {
        zip64Patch(new DataView(bytes.buffer, bytes.byteOffset + o + 46 + nameLen, extraLen), entry);
      }
      entries.push(entry);
      o += 46 + nameLen + extraLen + commentLen;
    }
    const files = new Map();
    for (const e of entries) {
      if (e.name.endsWith('/')) continue;
      files.set(e.name, async () => {
        if (view.getUint32(e.offset, true) !== SIG_LOCAL) {
          throw new Error(`Corrupt ZIP entry: ${e.name}`);
        }
        const nl = view.getUint16(e.offset + 26, true);
        const xl = view.getUint16(e.offset + 28, true);
        const start = e.offset + 30 + nl + xl;
        const raw = bytes.subarray(start, start + e.compressedSize);
        if (e.method === 0) return raw;
        if (e.method === 8) return inflateRaw(raw);
        throw new Error(`Unsupported ZIP compression method ${e.method} for ${e.name}`);
      });
    }
    return files;
  }

  /* --- DBF (shapefile attribute table) ----------------------------------- */

  function readDbf(bytes, decode) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const numRecords = view.getUint32(4, true);
    const headerLen = view.getUint16(8, true);
    const recordLen = view.getUint16(10, true);
    const fields = [];
    for (let o = 32; o < headerLen - 1 && bytes[o] !== 0x0d; o += 32) {
      let end = 0;
      while (end < 11 && bytes[o + end] !== 0) end++;
      fields.push({
        name: decode(bytes.subarray(o, o + end)).trim(),
        type: String.fromCharCode(bytes[o + 11]),
        length: bytes[o + 16],
        decimals: bytes[o + 17],
      });
    }
    const rows = [];
    for (let r = 0; r < numRecords; r++) {
      const base = headerLen + r * recordLen;
      if (base + recordLen > bytes.byteLength) break;
      if (bytes[base] === 0x2a) { rows.push(null); continue; } // deleted
      const row = {};
      let o = base + 1;
      for (const f of fields) {
        const raw = decode(bytes.subarray(o, o + f.length)).trim();
        o += f.length;
        if (f.type === 'N' || f.type === 'F') {
          row[f.name] = raw === '' ? null : Number(raw);
        } else if (f.type === 'L') {
          row[f.name] = /^[YyTt]$/.test(raw) ? true : /^[NnFf]$/.test(raw) ? false : null;
        } else if (f.type === 'D') {
          row[f.name] = /^\d{8}$/.test(raw)
            ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}` : raw;
        } else {
          row[f.name] = raw;
        }
      }
      rows.push(row);
    }
    return { fields, rows };
  }

  /* --- SHP --------------------------------------------------------------- */

  const shoelace = (ring) => {
    let s = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      s += a[0] * b[1] - b[0] * a[1];
    }
    return s / 2;
  };

  /* Shapefile polygons are one flat list of rings: outer rings run clockwise
     (negative shoelace) and holes run the other way. Group them by starting a
     new polygon at every outer ring, which also tolerates files that put the
     holes in an unexpected order. */
  function groupRings(rings) {
    if (!rings.length) return [];
    const areas = rings.map(shoelace);
    const outerIsNegative = areas[0] < 0;
    const polys = [];
    for (let i = 0; i < rings.length; i++) {
      const isOuter = outerIsNegative ? areas[i] < 0 : areas[i] > 0;
      if (isOuter || !polys.length) polys.push([rings[i]]);
      else polys[polys.length - 1].push(rings[i]);
    }
    return polys;
  }

  function readShp(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getInt32(0, false) !== 9994) throw new Error('Not a shapefile (.shp signature missing).');
    const fileLen = view.getInt32(24, false) * 2;
    const end = Math.min(fileLen, bytes.byteLength);
    const shapes = [];
    let o = 100;
    while (o + 8 <= end) {
      const contentLen = view.getInt32(o + 4, false) * 2;
      const body = o + 8;
      if (body + contentLen > bytes.byteLength) break;
      const type = view.getInt32(body, true);
      /* 5/15/25 are Polygon, PolygonZ and PolygonM. Z and M values trail the
         X/Y block, so the same offsets read all three. */
      if (type === 5 || type === 15 || type === 25) {
        const numParts = view.getInt32(body + 36, true);
        const numPoints = view.getInt32(body + 40, true);
        const partsAt = body + 44;
        const pointsAt = partsAt + numParts * 4;
        const parts = [];
        for (let i = 0; i < numParts; i++) parts.push(view.getInt32(partsAt + i * 4, true));
        const rings = [];
        for (let i = 0; i < numParts; i++) {
          const from = parts[i], to = i + 1 < numParts ? parts[i + 1] : numPoints;
          const ring = [];
          for (let k = from; k < to; k++) {
            ring.push([
              view.getFloat64(pointsAt + k * 16, true),
              view.getFloat64(pointsAt + k * 16 + 8, true),
            ]);
          }
          if (ring.length >= 4) rings.push(ring);
        }
        const polys = groupRings(rings);
        shapes.push(polys.length === 0 ? null
          : polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] }
          : { type: 'MultiPolygon', coordinates: polys });
      } else {
        shapes.push(null); // null shape, or a non-areal type we do not map
      }
      o = body + contentLen;
    }
    return shapes;
  }

  return { readZip, readDbf, readShp, inflateRaw, groupRings };
})();
