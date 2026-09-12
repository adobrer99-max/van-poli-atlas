"""Build real SHP/DBF/PRJ/KMZ fixtures so the browser readers are tested
against actual binary files rather than mocks. The forward Albers here is an
independent implementation of the inverse used in the atlas."""
import math, struct, zipfile, os, datetime

A = 6378137.0
F = 1 / 298.257222101
E2 = F * (2 - F)
E = math.sqrt(E2)

def q_of(sin_phi):
    return (1 - E2) * (sin_phi / (1 - E2 * sin_phi**2)
                       - (1 / (2 * E)) * math.log((1 - E * sin_phi) / (1 + E * sin_phi)))

def m_of(sin_phi, cos_phi):
    return cos_phi / math.sqrt(1 - E2 * sin_phi**2)

def bc_albers_forward(lon, lat, lat1=50.0, lat2=58.5, lat0=45.0, lon0=-126.0,
                      x0=1_000_000.0, y0=0.0):
    """Snyder, Albers Equal Area Conic (ellipsoidal), forward."""
    r = math.radians
    s1, c1 = math.sin(r(lat1)), math.cos(r(lat1))
    s2, c2 = math.sin(r(lat2)), math.cos(r(lat2))
    m1, m2 = m_of(s1, c1), m_of(s2, c2)
    q1, q2, q0 = q_of(s1), q_of(s2), q_of(math.sin(r(lat0)))
    n = (m1**2 - m2**2) / (q2 - q1)
    C = m1**2 + n * q1
    rho0 = A * math.sqrt(C - n * q0) / n
    q = q_of(math.sin(r(lat)))
    rho = A * math.sqrt(C - n * q) / n
    theta = n * r(lon - lon0)
    return (x0 + rho * math.sin(theta), y0 + rho0 - rho * math.cos(theta))

BC_ALBERS_WKT = (
    'PROJCS["NAD83 / BC Albers",GEOGCS["NAD83",DATUM["North_American_Datum_1983",'
    'SPHEROID["GRS 1980",6378137,298.257222101,AUTHORITY["EPSG","7019"]],'
    'AUTHORITY["EPSG","6269"]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],'
    'AUTHORITY["EPSG","4269"]],PROJECTION["Albers_Conic_Equal_Area"],'
    'PARAMETER["standard_parallel_1",50],PARAMETER["standard_parallel_2",58.5],'
    'PARAMETER["latitude_of_center",45],PARAMETER["longitude_of_center",-126],'
    'PARAMETER["false_easting",1000000],PARAMETER["false_northing",0],'
    'UNIT["metre",1,AUTHORITY["EPSG","9001"]],AUTHORITY["EPSG","3005"]]')


def write_shp(path, polygons):
    """polygons: list of list-of-rings; each ring a list of (x, y)."""
    records = b""
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
        records += struct.pack(">ii", i, len(content) // 2) + content
    total_words = (100 + len(records)) // 2
    header = struct.pack(">i", 9994) + b"\0" * 20 + struct.pack(">i", total_words)
    header += struct.pack("<ii", 1000, 5)
    header += struct.pack("<4d", gx0, gy0, gx1, gy1) + struct.pack("<4d", 0, 0, 0, 0)
    with open(path, "wb") as fh:
        fh.write(header + records)


def write_dbf(path, fields, rows, encoding="utf-8"):
    """fields: [(name, type, length, decimals)]"""
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
    with open(path, "wb") as fh:
        fh.write(out)


def rect(lon0, lat0, lon1, lat1, project=True):
    corners = [(lon0, lat0), (lon1, lat0), (lon1, lat1), (lon0, lat1), (lon0, lat0)]
    if project:
        return [bc_albers_forward(lo, la) for lo, la in corners]
    return corners


os.makedirs("fixtures", exist_ok=True)

# Three provincial-style voting areas covering a slice of Vancouver, plus one
# with a hole, expressed in BC Albers to exercise the reprojection path.
vas = [
    ("Vancouver-Fairview",   "015", rect(-123.14, 49.25, -123.12, 49.27)),
    ("Vancouver-Fairview",   "016", rect(-123.12, 49.25, -123.10, 49.27)),
    ("Vancouver-Mount Pleasant", "022", rect(-123.10, 49.25, -123.08, 49.27)),
]
polys = [[ring] for _, _, ring in vas]
# give the third a hole
hole = rect(-123.098, 49.256, -123.092, 49.264)
hole_ccw = list(reversed(hole))
polys[2] = [polys[2][0], hole_ccw]
# shapefile convention: outer rings clockwise. Our rect() walks counter-clockwise
# in projected space, so reverse the outers and leave the hole as-is.
polys = [[list(reversed(rings[0]))] + rings[1:] for rings in polys]

write_shp("fixtures/va.shp", polys)
write_dbf("fixtures/va.dbf",
          [("ED_NAME", "C", 40, 0), ("VA_CODE", "C", 6, 0), ("ELECTORS", "N", 8, 0)],
          [{"ED_NAME": ed, "VA_CODE": code, "ELECTORS": 400 + i * 37}
           for i, (ed, code, _) in enumerate(vas)])
with open("fixtures/va.prj", "w") as fh:
    fh.write(BC_ALBERS_WKT)

with zipfile.ZipFile("fixtures/va_shapefile.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for ext in ("shp", "dbf", "prj"):
        z.write(f"fixtures/va.{ext}", f"VotingAreas/va.{ext}")

# A stored (uncompressed) entry too, so both ZIP methods are covered.
with zipfile.ZipFile("fixtures/va_stored.zip", "w", zipfile.ZIP_STORED) as z:
    z.write("fixtures/va.shp", "va.shp")
    z.write("fixtures/va.dbf", "va.dbf")
    z.write("fixtures/va.prj", "va.prj")

kml_parts = []
for ed, code, ring in vas:
    lonlat = rect(*{"015": (-123.14, 49.25, -123.12, 49.27),
                    "016": (-123.12, 49.25, -123.10, 49.27),
                    "022": (-123.10, 49.25, -123.08, 49.27)}[code], project=False)
    coords = " ".join(f"{lo},{la},0" for lo, la in lonlat)
    kml_parts.append(f"""  <Placemark><name>VA {code}</name>
    <ExtendedData><SchemaData schemaUrl="#va">
      <SimpleData name="ED_NAME">{ed}</SimpleData>
      <SimpleData name="VA_CODE">{code}</SimpleData>
    </SchemaData></ExtendedData>
    <Polygon><outerBoundaryIs><LinearRing><coordinates>{coords}</coordinates>
    </LinearRing></outerBoundaryIs></Polygon></Placemark>""")
kml = ('<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">'
       '<Document><name>Voting areas</name>\n' + "\n".join(kml_parts) + '\n</Document></kml>')
with open("fixtures/va.kml", "w", encoding="utf-8") as fh:
    fh.write(kml)
with zipfile.ZipFile("fixtures/va.kmz", "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("doc.kml", kml)

# Control points for cross-checking the inverse projection.
with open("fixtures/albers_control.json", "w") as fh:
    import json
    pts = [(-123.1207, 49.2827), (-123.02, 49.31), (-126.0, 45.0),
           (-118.5, 55.2), (-130.1, 54.0), (-123.0, 49.0)]
    json.dump([{"lon": lo, "lat": la,
                "x": bc_albers_forward(lo, la)[0], "y": bc_albers_forward(lo, la)[1]}
               for lo, la in pts], fh, indent=1)

for f in sorted(os.listdir("fixtures")):
    print(f"  {f:26s} {os.path.getsize('fixtures/'+f):8d} bytes")
