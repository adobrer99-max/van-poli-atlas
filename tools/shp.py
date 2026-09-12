"""Shapefile and DBF reading and writing with the standard library only.

Used by the fixture generators in tests/ and by tools/filter-census.py, which
clips Statistics Canada's national boundary files down to a study area on the
user's machine so the browser never has to hold a gigabyte of polygons.

Reading is record-oriented and streams from an open file object, so a .shp
inside a .zip can be walked through zipfile without extracting it. Only
polygon records (shape types 5, 15, 25) are interpreted; everything else is
passed through by bytes.
"""
import datetime
import io
import os
import struct
import zipfile

POLYGON_TYPES = (5, 15, 25)


# --- DBF --------------------------------------------------------------------

def read_dbf_header(fh):
    """Returns (fields, header_len, record_len, num_records); fields are
    (name, type, length, decimals) tuples."""
    head = fh.read(32)
    if len(head) < 32:
        raise ValueError("not a DBF: header too short")
    num_records, header_len, record_len = struct.unpack("<IHH", head[4:12])
    fields = []
    pos = 32
    while pos < header_len - 1:
        desc = fh.read(32)
        if not desc or desc[0] == 0x0D:
            break
        name = desc[:11].split(b"\0", 1)[0].decode("ascii", "replace")
        fields.append((name, chr(desc[11]), desc[16], desc[17]))
        pos += 32
    fh.seek(header_len)
    return fields, header_len, record_len, num_records


def _convert(ftype, raw):
    text = raw.strip()
    if ftype in ("N", "F"):
        if not text:
            return None
        try:
            return int(text) if b"." not in text else float(text)
        except ValueError:
            return None
    if ftype == "L":
        return True if text in (b"Y", b"y", b"T", b"t") else False if text in (b"N", b"n", b"F", b"f") else None
    return text.decode("cp1252", "replace")


def iter_dbf_rows(fh, encoding="cp1252"):
    """Yields (index, row_dict) for every record; deleted records yield None."""
    fields, header_len, record_len, num_records = read_dbf_header(fh)
    for i in range(num_records):
        rec = fh.read(record_len)
        if len(rec) < record_len:
            break
        if rec[0] == 0x2A:
            yield i, None
            continue
        row, pos = {}, 1
        for name, ftype, length, _ in fields:
            raw = rec[pos:pos + length]
            pos += length
            if ftype in ("N", "F", "L"):
                row[name] = _convert(ftype, raw)
            else:
                row[name] = raw.decode(encoding, "replace").strip()
        yield i, row


def read_dbf(path_or_fh, encoding="cp1252"):
    if hasattr(path_or_fh, "read"):
        return list(iter_dbf_rows(path_or_fh, encoding))
    with open(path_or_fh, "rb") as fh:
        return list(iter_dbf_rows(fh, encoding))


# --- SHP --------------------------------------------------------------------

def read_shp_header(fh):
    """Returns (file_length_bytes, shape_type, bbox) and leaves fh at byte 100."""
    head = fh.read(100)
    if len(head) < 100 or struct.unpack(">i", head[:4])[0] != 9994:
        raise ValueError("not a shapefile: bad signature")
    file_len = struct.unpack(">i", head[24:28])[0] * 2
    shape_type = struct.unpack("<i", head[32:36])[0]
    bbox = struct.unpack("<4d", head[36:68])
    return file_len, shape_type, bbox


def iter_shp_records(fh):
    """Yields (index, shape_type, bbox_or_None, record_bytes). record_bytes is
    the full record including its 8-byte header, so it can be copied verbatim
    into a clipped file. bbox is read for polygon records only."""
    read_shp_header(fh)
    i = 0
    while True:
        head = fh.read(8)
        if len(head) < 8:
            return
        content_len = struct.unpack(">i", head[4:8])[0] * 2
        content = fh.read(content_len)
        if len(content) < content_len:
            return
        shape_type = struct.unpack("<i", content[:4])[0] if content_len >= 4 else 0
        bbox = struct.unpack("<4d", content[4:36]) if shape_type in POLYGON_TYPES and content_len >= 36 else None
        yield i, shape_type, bbox, head + content
        i += 1


def polygon_rings(record_bytes):
    """Rings of one polygon record as lists of (x, y); [] for anything else."""
    content = record_bytes[8:]
    shape_type = struct.unpack("<i", content[:4])[0]
    if shape_type not in POLYGON_TYPES:
        return []
    num_parts, num_points = struct.unpack("<ii", content[36:44])
    parts = struct.unpack("<%di" % num_parts, content[44:44 + 4 * num_parts])
    points_at = 44 + 4 * num_parts
    pts = struct.unpack("<%dd" % (2 * num_points), content[points_at:points_at + 16 * num_points])
    xy = [(pts[2 * k], pts[2 * k + 1]) for k in range(num_points)]
    rings = []
    for p in range(num_parts):
        start = parts[p]
        end = parts[p + 1] if p + 1 < num_parts else num_points
        rings.append(xy[start:end])
    return rings


def read_shp(path_or_fh):
    """Every record's rings (a list per record; [] for null or non-polygon)."""
    if hasattr(path_or_fh, "read"):
        return [polygon_rings(rec) for _, _, _, rec in iter_shp_records(path_or_fh)]
    with open(path_or_fh, "rb") as fh:
        return [polygon_rings(rec) for _, _, _, rec in iter_shp_records(fh)]


# --- Writing ----------------------------------------------------------------

def shp_records(polygons):
    """polygons: list of list-of-rings; each ring a list of (x, y). Returns
    (records_bytes, index_entries, global_bbox)."""
    records = b""
    index = []
    gx0 = gy0 = float("inf"); gx1 = gy1 = float("-inf")
    for i, rings in enumerate(polygons, start=1):
        pts = [p for ring in rings for p in ring]
        x0 = min(p[0] for p in pts); y0 = min(p[1] for p in pts)
        x1 = max(p[0] for p in pts); y1 = max(p[1] for p in pts)
        gx0, gy0 = min(gx0, x0), min(gy0, y0)
        gx1, gy1 = max(gx1, x1), max(gy1, y1)
        parts, offset = [], 0
        for ring in rings:
            parts.append(offset); offset += len(ring)
        content = struct.pack("<i", 5)
        content += struct.pack("<4d", x0, y0, x1, y1)
        content += struct.pack("<ii", len(rings), len(pts))
        content += b"".join(struct.pack("<i", p) for p in parts)
        content += b"".join(struct.pack("<2d", p[0], p[1]) for p in pts)
        index.append(((100 + len(records)) // 2, len(content) // 2))
        records += struct.pack(">ii", i, len(content) // 2) + content
    return records, index, (gx0, gy0, gx1, gy1)


def shp_header(total_bytes, bbox, shape_type=5):
    header = struct.pack(">i", 9994) + b"\0" * 20 + struct.pack(">i", total_bytes // 2)
    header += struct.pack("<ii", 1000, shape_type)
    header += struct.pack("<4d", *bbox) + struct.pack("<4d", 0, 0, 0, 0)
    return header


def write_shp(path, polygons):
    """polygons: list of list-of-rings; each ring a list of (x, y)."""
    records, index, bbox = shp_records(polygons)
    with open(path, "wb") as fh:
        fh.write(shp_header(100 + len(records), bbox) + records)
    shx = os.path.splitext(path)[0] + ".shx"
    with open(shx, "wb") as fh:
        fh.write(shp_header(100 + 8 * len(index), bbox))
        fh.write(b"".join(struct.pack(">ii", off, ln) for off, ln in index))


def write_dbf(path, fields, rows, encoding="utf-8"):
    """fields: [(name, type, length, decimals)]; rows: dicts keyed by name."""
    with open(path, "wb") as fh:
        fh.write(dbf_bytes(fields, rows, encoding))


def dbf_bytes(fields, rows, encoding="utf-8"):
    record_len = 1 + sum(f[2] for f in fields)
    header_len = 32 + 32 * len(fields) + 1
    today = datetime.date.today()
    out = struct.pack("<BBBBIHH", 0x03, today.year - 1900, today.month, today.day,
                      len(rows), header_len, record_len) + b"\0" * 20
    for name, ftype, length, dec in fields:
        out += name.encode(encoding)[:11].ljust(11, b"\0")
        out += ftype.encode("ascii") + b"\0" * 4
        out += bytes([length, dec]) + b"\0" * 14
    out += b"\x0d"
    for row in rows:
        out += b" "
        for name, ftype, length, dec in fields:
            value = row.get(name, "")
            if ftype == "N":
                text = ("" if value is None else str(value)).rjust(length)
            else:
                text = str("" if value is None else value).ljust(length)
            out += text.encode(encoding)[:length].ljust(length, b" ")
    out += b"\x1a"
    return out


# --- Clipping a zipped shapefile ------------------------------------------

def shapefile_members(zf):
    """The .shp/.dbf/.prj/.shx member names sharing the first .shp's stem."""
    names = [n for n in zf.namelist() if "__MACOSX" not in n and not os.path.basename(n).startswith(".")]
    shp = next((n for n in names if n.lower().endswith(".shp")), None)
    if shp is None:
        raise ValueError("no .shp in the archive: " + ", ".join(names[:8]))
    stem = shp[:-4]
    def member(ext):
        return next((n for n in names if n.lower() == (stem + "." + ext).lower()), None)
    return {"shp": shp, "dbf": member("dbf"), "prj": member("prj"), "shx": member("shx"), "stem": os.path.basename(stem)}


def clip_zipped_shapefile(zip_path, out_zip_path, keep_row, encoding="cp1252", progress=None):
    """Copies the records whose DBF row satisfies keep_row(row) into a new
    zipped shapefile (.shp, .shx, .dbf, .prj). The .shp is streamed record by
    record from inside the archive. Returns (kept, total)."""
    with zipfile.ZipFile(zip_path) as zf:
        members = shapefile_members(zf)
        if not members["dbf"]:
            raise ValueError("the archive has no .dbf, so nothing to filter on")
        with zf.open(members["dbf"]) as fh:
            dbf_fh = io.BufferedReader(fh)
            fields, _, _, _ = read_dbf_header(dbf_fh)
            dbf_fh.seek(0) if dbf_fh.seekable() else None
        with zf.open(members["dbf"]) as fh:
            rows = [row for _, row in iter_dbf_rows(io.BufferedReader(fh), encoding)]
        keep = [row is not None and keep_row(row) for row in rows]
        kept_rows = [rows[i] for i, k in enumerate(keep) if k]
        records = b""
        index = []
        gx0 = gy0 = float("inf"); gx1 = gy1 = float("-inf")
        total = 0
        with zf.open(members["shp"]) as fh:
            for i, shape_type, bbox, rec in iter_shp_records(io.BufferedReader(fh)):
                total += 1
                if progress and total % 20000 == 0:
                    progress(total)
                if i >= len(keep) or not keep[i]:
                    continue
                if bbox:
                    gx0, gy0 = min(gx0, bbox[0]), min(gy0, bbox[1])
                    gx1, gy1 = max(gx1, bbox[2]), max(gy1, bbox[3])
                new_num = len(index) + 1
                body = rec[8:]
                index.append(((100 + len(records)) // 2, len(body) // 2))
                records += struct.pack(">ii", new_num, len(body) // 2) + body
        prj = zf.read(members["prj"]) if members["prj"] else None
    if not index:
        gx0 = gy0 = gx1 = gy1 = 0.0
    bbox = (gx0, gy0, gx1, gy1)
    stem = members["stem"] + "_clip"
    with zipfile.ZipFile(out_zip_path, "w", zipfile.ZIP_DEFLATED) as out:
        out.writestr(stem + ".shp", shp_header(100 + len(records), bbox) + records)
        out.writestr(stem + ".shx", shp_header(100 + 8 * len(index), bbox)
                     + b"".join(struct.pack(">ii", off, ln) for off, ln in index))
        out.writestr(stem + ".dbf", dbf_bytes(fields, kept_rows, encoding))
        if prj is not None:
            out.writestr(stem + ".prj", prj)
    return len(index), total
