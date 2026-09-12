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

  /* Field descriptors: 32 bytes each from offset 32 up to the 0x0d terminator. */
  function dbfFields(bytes, headerLen, decode) {
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
    return fields;
  }

  function dbfRow(bytes, base, fields, decode) {
    if (bytes[base] === 0x2a) return null; // deleted
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
    return row;
  }

  /* options.keep(i) decides whether row i is parsed at all; a skipped row is
     null so the row index still lines up with the shapes in the .shp. */
  function readDbf(bytes, decode, options = {}) {
    const keep = options.keep || null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const numRecords = view.getUint32(4, true);
    const headerLen = view.getUint16(8, true);
    const recordLen = view.getUint16(10, true);
    const fields = dbfFields(bytes, headerLen, decode);
    const rows = [];
    for (let r = 0; r < numRecords; r++) {
      const base = headerLen + r * recordLen;
      if (base + recordLen > bytes.byteLength) break;
      rows.push(keep && !keep(r) ? null : dbfRow(bytes, base, fields, decode));
    }
    return { fields, rows };
  }

  /* --- Streaming ----------------------------------------------------------
     A national dissemination-block shapefile is over a gigabyte; the reader
     below walks a ReadableStream of chunks with a small carry buffer so the
     file never has to sit in memory whole. */
  function chunkCursor(stream) {
    const reader = stream.getReader();
    let buf = new Uint8Array(0), o = 0, done = false;
    return {
      get buffer() { return buf; },
      get offset() { return o; },
      advance(n) { o += n; },
      /* Ensure n bytes are available from the cursor; false at end of stream. */
      async need(n) {
        while (buf.byteLength - o < n) {
          if (done) return false;
          const r = await reader.read();
          if (r.done) { done = true; return buf.byteLength - o >= n; }
          const chunk = r.value instanceof Uint8Array ? r.value : new Uint8Array(r.value);
          const merged = new Uint8Array(buf.byteLength - o + chunk.byteLength);
          merged.set(buf.subarray(o));
          merged.set(chunk, buf.byteLength - o);
          buf = merged; o = 0;
        }
        return true;
      },
      view() { return new DataView(buf.buffer, buf.byteOffset, buf.byteLength); },
      async cancel() { try { await reader.cancel(); } catch (e) { /* already closed */ } },
    };
  }

  async function readDbfStream(stream, decode, options = {}) {
    const keep = options.keep || null;
    const cur = chunkCursor(stream);
    if (!(await cur.need(32))) throw new Error('Not a DBF (too short).');
    let view = cur.view();
    const numRecords = view.getUint32(cur.offset + 4, true);
    const headerLen = view.getUint16(cur.offset + 8, true);
    const recordLen = view.getUint16(cur.offset + 10, true);
    if (!(await cur.need(headerLen))) throw new Error('Truncated DBF header.');
    const fields = dbfFields(cur.buffer.subarray(cur.offset), headerLen, decode);
    cur.advance(headerLen);
    const rows = [];
    for (let r = 0; r < numRecords; r++) {
      if (!(await cur.need(recordLen))) break;
      rows.push(keep && !keep(r) ? null : dbfRow(cur.buffer, cur.offset, fields, decode));
      cur.advance(recordLen);
    }
    await cur.cancel();
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

  /* The bounding box every polygon record carries right after its shape type. */
  const recordBox = (view, body) => [
    view.getFloat64(body + 4, true), view.getFloat64(body + 12, true),
    view.getFloat64(body + 20, true), view.getFloat64(body + 28, true),
  ];

  /* One polygon record starting at `body` (just after the 8-byte record
     header). keep(bbox, index) can reject it from its header bbox alone, before
     a single point is read; a rejected or non-areal record is null. */
  function shpRecord(view, body, keep, index) {
    const type = view.getInt32(body, true);
    /* 5/15/25 are Polygon, PolygonZ and PolygonM. Z and M values trail the
       X/Y block, so the same offsets read all three. */
    if (type !== 5 && type !== 15 && type !== 25) return null;
    if (keep && !keep(recordBox(view, body), index)) return null;
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
    return polys.length === 0 ? null
      : polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] }
      : { type: 'MultiPolygon', coordinates: polys };
  }

  /* The file header's bounding box (bytes 36-68), in the file's own units. */
  function shpHeaderBox(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 100 || view.getInt32(0, false) !== 9994) return null;
    return [view.getFloat64(36, true), view.getFloat64(44, true), view.getFloat64(52, true), view.getFloat64(60, true)];
  }

  function readShp(bytes, options = {}) {
    const keep = options.keep || null;
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
      shapes.push(shpRecord(view, body, keep, shapes.length));
      o = body + contentLen;
    }
    return shapes;
  }

  async function readShpStream(stream, options = {}) {
    const keep = options.keep || null;
    const cur = chunkCursor(stream);
    if (!(await cur.need(100))) throw new Error('Not a shapefile (too short).');
    if (cur.view().getInt32(cur.offset, false) !== 9994) throw new Error('Not a shapefile (.shp signature missing).');
    const header = cur.buffer.slice(cur.offset, cur.offset + 100);
    cur.advance(100);
    const shapes = [];
    while (await cur.need(8)) {
      const contentLen = cur.view().getInt32(cur.offset + 4, false) * 2;
      if (!(await cur.need(8 + contentLen))) break;
      shapes.push(shpRecord(cur.view(), cur.offset + 8, keep, shapes.length));
      cur.advance(8 + contentLen);
    }
    await cur.cancel();
    return Object.assign(shapes, { headerBox: shpHeaderBox(header) });
  }

  /* --- ZIP from a Blob ------------------------------------------------------
     Same directory walk as readZip, but only the tail and the central
     directory are read up front; each entry is opened from its own byte range,
     as a whole (bytes) or as a stream. Entries are the same async openers
     readZip returns, with .size and .stream added. */
  async function readZipBlob(blob) {
    const size = blob.size;
    const tailStart = Math.max(0, size - 66000);
    const tail = new Uint8Array(await blob.slice(tailStart, size).arrayBuffer());
    const tview = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    const eocdLocal = findEocd(tview, tail.byteLength);
    if (eocdLocal < 0) throw new Error('Not a ZIP archive (no end-of-central-directory record).');
    let count = tview.getUint16(eocdLocal + 10, true);
    let cdSize = tview.getUint32(eocdLocal + 12, true);
    let cdOffset = tview.getUint32(eocdLocal + 16, true);
    if ((count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) && eocdLocal >= 20 &&
        tview.getUint32(eocdLocal - 20, true) === 0x07064b50) {
      const z64 = Number(tview.getBigUint64(eocdLocal - 20 + 8, true));
      const rec = new DataView(await blob.slice(z64, z64 + 56).arrayBuffer());
      if (rec.getUint32(0, true) === 0x06064b50) {
        count = Number(rec.getBigUint64(32, true));
        cdSize = Number(rec.getBigUint64(40, true));
        cdOffset = Number(rec.getBigUint64(48, true));
      }
    }
    const cd = new Uint8Array(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
    const view = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
    const entries = [];
    let o = 0;
    for (let i = 0; i < count && o + 46 <= cd.byteLength; i++) {
      if (view.getUint32(o, true) !== SIG_CD) break;
      const nameLen = view.getUint16(o + 28, true);
      const extraLen = view.getUint16(o + 30, true);
      const commentLen = view.getUint16(o + 32, true);
      const entry = {
        name: new TextDecoder('utf-8').decode(cd.subarray(o + 46, o + 46 + nameLen)),
        method: view.getUint16(o + 10, true),
        compressedSize: view.getUint32(o + 20, true),
        uncompressedSize: view.getUint32(o + 24, true),
        offset: view.getUint32(o + 42, true),
      };
      if (extraLen) zip64Patch(new DataView(cd.buffer, cd.byteOffset + o + 46 + nameLen, extraLen), entry);
      entries.push(entry);
      o += 46 + nameLen + extraLen + commentLen;
    }
    const files = new Map();
    for (const e of entries) {
      if (e.name.endsWith('/')) continue;
      const dataStart = async () => {
        const lh = new DataView(await blob.slice(e.offset, e.offset + 30).arrayBuffer());
        if (lh.getUint32(0, true) !== SIG_LOCAL) throw new Error(`Corrupt ZIP entry: ${e.name}`);
        return e.offset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
      };
      if (e.method !== 0 && e.method !== 8) {
        files.set(e.name, async () => { throw new Error(`Unsupported ZIP compression method ${e.method} for ${e.name}`); });
        continue;
      }
      const open = async () => {
        const start = await dataStart();
        const raw = new Uint8Array(await blob.slice(start, start + e.compressedSize).arrayBuffer());
        return e.method === 0 ? raw : inflateRaw(raw);
      };
      open.size = e.uncompressedSize;
      open.compressedSize = e.compressedSize;
      open.stream = async () => {
        const start = await dataStart();
        const raw = blob.slice(start, start + e.compressedSize).stream();
        return e.method === 0 ? raw : raw.pipeThrough(new DecompressionStream('deflate-raw'));
      };
      files.set(e.name, open);
    }
    return files;
  }

  return { readZip, readZipBlob, readDbf, readDbfStream, readShp, readShpStream, shpHeaderBox,
           inflateRaw, groupRings };
})();
