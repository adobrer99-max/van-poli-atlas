"""Build real SHP/DBF/PRJ/KMZ fixtures so the browser readers are tested
against actual binary files rather than mocks. The forward Albers here is an
independent implementation of the inverse used in the atlas."""
import math, struct, zipfile, os, datetime, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tools.shp import write_shp, write_dbf   # the shapefile writers live with the tools

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

def lcc_forward(lon, lat, lat1=49.0, lat2=77.0, lat0=63.390675, lon0=-(91 + 52 / 60),
                x0=6_200_000.0, y0=3_000_000.0):
    """Snyder, Lambert Conformal Conic (ellipsoidal, 2SP), forward. EPSG:3347
    defaults: NAD83 / Statistics Canada Lambert."""
    r = math.radians
    def t_of(phi):
        s = math.sin(phi)
        return math.tan(math.pi / 4 - phi / 2) / ((1 - E * s) / (1 + E * s)) ** (E / 2)
    p1, p2, p0 = r(lat1), r(lat2), r(lat0)
    m1, m2 = m_of(math.sin(p1), math.cos(p1)), m_of(math.sin(p2), math.cos(p2))
    t1, t2, t0 = t_of(p1), t_of(p2), t_of(p0)
    n = (math.log(m1) - math.log(m2)) / (math.log(t1) - math.log(t2))
    F = m1 / (n * t1 ** n)
    rho0 = A * F * t0 ** n
    rho = A * F * t_of(r(lat)) ** n
    theta = n * r(lon - lon0)
    return (x0 + rho * math.sin(theta), y0 + rho0 - rho * math.cos(theta))


def parallel_arc_m(lat, dlon):
    """Length in metres of dlon degrees of longitude along the parallel at lat."""
    phi = math.radians(lat)
    N = A / math.sqrt(1 - E2 * math.sin(phi) ** 2)
    return N * math.cos(phi) * math.radians(dlon)


# Esri-style, as Statistics Canada ships it: no AUTHORITY, parameters in Esri spelling.
STATCAN_LCC_WKT = (
    'PROJCS["PCS_Lambert_Conformal_Conic",GEOGCS["GCS_North_American_1983",'
    'DATUM["D_North_American_1983",SPHEROID["GRS_1980",6378137.0,298.257222101]],'
    'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],'
    'PROJECTION["Lambert_Conformal_Conic"],PARAMETER["False_Easting",6200000.0],'
    'PARAMETER["False_Northing",3000000.0],PARAMETER["Central_Meridian",-91.86666666666667],'
    'PARAMETER["Standard_Parallel_1",49.0],PARAMETER["Standard_Parallel_2",77.0],'
    'PARAMETER["Latitude_Of_Origin",63.390675],UNIT["Meter",1.0]]')

BC_ALBERS_WKT = (
    'PROJCS["NAD83 / BC Albers",GEOGCS["NAD83",DATUM["North_American_Datum_1983",'
    'SPHEROID["GRS 1980",6378137,298.257222101,AUTHORITY["EPSG","7019"]],'
    'AUTHORITY["EPSG","6269"]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433],'
    'AUTHORITY["EPSG","4269"]],PROJECTION["Albers_Conic_Equal_Area"],'
    'PARAMETER["standard_parallel_1",50],PARAMETER["standard_parallel_2",58.5],'
    'PARAMETER["latitude_of_center",45],PARAMETER["longitude_of_center",-126],'
    'PARAMETER["false_easting",1000000],PARAMETER["false_northing",0],'
    'UNIT["metre",1,AUTHORITY["EPSG","9001"]],AUTHORITY["EPSG","3005"]]')


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

# The same for Statistics Canada Lambert: cities across the country, the
# projection origin, and a pair of points on the 49th parallel (a standard
# parallel, where the scale factor is exactly 1) with their true separation.
with open("fixtures/lcc_control.json", "w") as fh:
    import json
    named = [("Vancouver", -123.1207, 49.2827), ("Toronto", -79.3832, 43.6532),
             ("Whitehorse", -135.0568, 60.7212), ("St. John's", -52.7126, 47.5615),
             ("origin", -(91 + 52 / 60), 63.390675), ("Winnipeg", -97.1384, 49.8951)]
    pair = [(-100.0, 49.0), (-99.99, 49.0)]
    json.dump({
        "points": [{"name": nm, "lon": lo, "lat": la,
                    "x": lcc_forward(lo, la)[0], "y": lcc_forward(lo, la)[1]}
                   for nm, lo, la in named],
        "parallel_pair": {"a": lcc_forward(*pair[0]), "b": lcc_forward(*pair[1]),
                          "arc_m": parallel_arc_m(49.0, 0.01)},
    }, fh, indent=1)

# The three Fairview cells again, in Statistics Canada Lambert with the Esri
# .prj StatCan ships, so the ingest path is checked end to end.
lcc_polys = []
for ed, code, _ in vas:
    lo0, la0, lo1, la1 = {"015": (-123.14, 49.25, -123.12, 49.27),
                          "016": (-123.12, 49.25, -123.10, 49.27),
                          "022": (-123.10, 49.25, -123.08, 49.27)}[code]
    corners = [(lo0, la0), (lo1, la0), (lo1, la1), (lo0, la1), (lo0, la0)]
    ring = [lcc_forward(lo, la) for lo, la in corners]
    lcc_polys.append([list(reversed(ring))])            # clockwise outer
write_shp("fixtures/da_lcc.shp", lcc_polys)
write_dbf("fixtures/da_lcc.dbf",
          [("DAUID", "C", 8, 0), ("DGUID", "C", 21, 0), ("LANDAREA", "N", 12, 4)],
          [{"DAUID": f"5915{100 + i:04d}", "DGUID": f"2021S05125915{100 + i:04d}", "LANDAREA": 0.4}
           for i in range(len(vas))])
with open("fixtures/da_lcc.prj", "w") as fh:
    fh.write(STATCAN_LCC_WKT)
with zipfile.ZipFile("fixtures/da_lcc.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for ext in ("shp", "dbf", "prj"):
        z.write(f"fixtures/da_lcc.{ext}", f"da_lcc.{ext}")

# --- An Excel workbook, built by hand ---------------------------------------
#
# Written as raw XML in a zip rather than with a library, so the fixture needs
# no dependency and so the parts under test are the parts actually written here.
# It is shaped like the real electors roll it was written for, and every awkward
# thing in that file is reproduced deliberately:
#
#   * the header is NOT row 1 -- a disclaimer occupies rows 2-3, exactly as the
#     City's export does
#   * an empty cell is OMITTED from the XML rather than written blank, which is
#     what makes cell position have to come from r="C7" and not from counting
#   * strings are shared and indexed, with one rich-text run split across two
#     <t> elements, one inline string, one number and one boolean
#   * a second sheet exists, so choosing the first is a choice rather than a
#     coincidence

def xlsx_escape(t):
    return (str(t).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


def col_letters(i):
    out = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        out = chr(65 + r) + out
    return out


def write_xlsx(path, sheets):
    """sheets: [(name, [[cell, ...], ...])]. A cell of None is omitted entirely."""
    shared, index = [], {}

    def share(text):
        if text not in index:
            index[text] = len(shared)
            shared.append(text)
        return index[text]

    sheet_xml = []
    for _, grid in sheets:
        rows = []
        for r, line in enumerate(grid, start=1):
            cells = []
            for c, value in enumerate(line):
                if value is None:                      # omitted, not blank
                    continue
                ref = f"{col_letters(c)}{r}"
                if isinstance(value, bool):
                    cells.append(f'<c r="{ref}" t="b"><v>{1 if value else 0}</v></c>')
                elif isinstance(value, (int, float)):
                    cells.append(f'<c r="{ref}"><v>{value}</v></c>')
                elif isinstance(value, tuple):         # ("inline", text)
                    cells.append(f'<c r="{ref}" t="inlineStr"><is><t>'
                                 f'{xlsx_escape(value[1])}</t></is></c>')
                else:
                    cells.append(f'<c r="{ref}" t="s"><v>{share(value)}</v></c>')
            if cells:
                rows.append(f'<row r="{r}">' + "".join(cells) + "</row>")
        sheet_xml.append('<?xml version="1.0" encoding="UTF-8"?>'
                         '<worksheet xmlns="http://schemas.openxmlformats.org/'
                         'spreadsheetml/2006/main"><sheetData>'
                         + "".join(rows) + "</sheetData></worksheet>")

    # One shared string is split across two runs, which is how Excel stores a
    # string whose formatting changes part way through.
    si = []
    for text in shared:
        if text == "RICH TEXT CELL":
            si.append("<si><r><t>RICH </t></r><r><t>TEXT CELL</t></r></si>")
        else:
            si.append(f"<si><t>{xlsx_escape(text)}</t></si>")
    shared_xml = ('<?xml version="1.0" encoding="UTF-8"?>'
                  '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                  f'count="{len(shared)}" uniqueCount="{len(shared)}">'
                  + "".join(si) + "</sst>")

    book = "".join(f'<sheet name="{xlsx_escape(n)}" sheetId="{i}" r:id="rId{i}"/>'
                   for i, (n, _) in enumerate(sheets, start=1))
    workbook_xml = ('<?xml version="1.0" encoding="UTF-8"?>'
                    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/'
                    'relationships"><sheets>' + book + "</sheets></workbook>")

    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml",
                   '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.'
                   'openxmlformats.org/package/2006/content-types"/>')
        z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships '
                   'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>')
        z.writestr("xl/workbook.xml", workbook_xml)
        z.writestr("xl/sharedStrings.xml", shared_xml)
        for i, xml in enumerate(sheet_xml, start=1):
            z.writestr(f"xl/worksheets/sheet{i}.xml", xml)


DISCLAIMER = ("Disclaimer: postal codes are taken from mailing addresses and are "
              "left blank when the mailing and property addresses differ.")
ROLL_HEADER = ["Elector", "FirstName", "LastName", "PropertyAddress",
               "StreetNumb", "StreetName", "StreetTyp", "LocalArea"]
write_xlsx("fixtures/roll_shaped.xlsx", [
    ("Query1", [
        [],                                            # 1: empty
        [DISCLAIMER],                                  # 2: one cell, a note
        [],                                            # 3: empty
        [],                                            # 4: empty
        [],                                            # 5: empty
        ROLL_HEADER,                                   # 6: the header
        [110155, "DOMENICO", "ANTONIETTI", "807-131 REGIMENT SQ",
         131, "REGIMENT", "SQ", "Downtown"],
        # MiddleName equivalent omitted entirely: the gap that breaks a reader
        # which counts cells instead of reading r="C7".
        [540029, None, "WI-AFEDZI", "706-1833 FRANCES ST",
         1833, "FRANCES", "ST", "Grandview-Woodland"],
        [242267, ("inline", "DIRAN"), "GUMUCHIAN", "7307 ELLIOTT ST",
         7307, "ELLIOTT", "ST", "Victoria-Fraserview"],
        [419608, "RICH TEXT CELL", "OGBO", "203-8643 MONTCALM ST",
         8643, "MONTCALM", "ST", "Marpole"],
    ]),
    ("Notes", [["not the sheet to read"]]),
])

for f in sorted(os.listdir("fixtures")):
    print(f"  {f:26s} {os.path.getsize('fixtures/'+f):8d} bytes")
