"""Synthetic stand-ins for the Elections BC and Elections Canada downloads, used
only to drive the browser test. Clearly-fake district names so these files can
never be mistaken for real boundaries."""
import json, math, os, struct, zipfile, random
exec(open("tests/make-fixtures.py").read().split("os.makedirs")[0])  # reuse projection + writers
BC_ALBERS_WKT = (
    'PROJCS["NAD83 / BC Albers",GEOGCS["NAD83",DATUM["North_American_Datum_1983",'
    'SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],'
    'UNIT["degree",0.0174532925199433]],PROJECTION["Albers_Conic_Equal_Area"],'
    'PARAMETER["standard_parallel_1",50],PARAMETER["standard_parallel_2",58.5],'
    'PARAMETER["latitude_of_center",45],PARAMETER["longitude_of_center",-126],'
    'PARAMETER["false_easting",1000000],PARAMETER["false_northing",0],'
    'UNIT["metre",1],AUTHORITY["EPSG","3005"]]')

fed = json.load(open("boundaries/fed_polls.geojson"))
VAN = {"59035","59036","59037","59038","59039","59040"}
van = [f for f in fed["features"]
       if f["properties"]["fed"] in VAN and "jurisdiction" not in f["properties"]]

xs, ys = [], []
def walk(c):
    if isinstance(c[0], (int, float)): xs.append(c[0]); ys.append(c[1])
    else:
        for k in c: walk(k)
for f in van: walk(f["geometry"]["coordinates"])
x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)

# ~700 voting areas on a grid offset from the federal one, so nothing lines up.
NX, NY = 28, 25
w, h = (x1 - x0) / NX, (y1 - y0) / NY
polys, attrs = [], []
random.seed(7)
for i in range(NX):
    for j in range(NY):
        ax = x0 + i * w + w * 0.29
        ay = y0 + j * h + h * 0.41
        ring = [(ax, ay), (ax + w, ay), (ax + w, ay + h), (ax, ay + h), (ax, ay)]
        proj = [bc_albers_forward(lo, la) for lo, la in ring]
        polys.append([list(reversed(proj))])          # clockwise outer
        district = f"Sample District {1 + (i * NY + j) // 60}"
        attrs.append({"ED_NAME": district, "VA_CODE": f"{i:02d}{j:02d}", "ELECTORS": 300 + (i * 7 + j * 3) % 400})

write_shp("fixtures/e2e_va.shp", polys)
write_dbf("fixtures/e2e_va.dbf",
          [("ED_NAME","C",40,0), ("VA_CODE","C",8,0), ("ELECTORS","N",8,0)], attrs)
open("fixtures/e2e_va.prj","w").write(BC_ALBERS_WKT)
with zipfile.ZipFile("fixtures/e2e_voting_areas.zip","w",zipfile.ZIP_DEFLATED) as z:
    for ext in ("shp","dbf","prj"):
        z.write(f"fixtures/e2e_va.{ext}", f"e2e_va.{ext}")
print(f"provincial layer: {len(polys)} voting areas")

# Federal results in the Elections Canada layout, with advance polls.
EC_HEADER = ['Electoral District Number/Numéro de circonscription',
  'Electoral District Name_English/Nom de circonscription_Anglais',
  'Polling Station Number/Numéro du bureau de scrutin',
  'Polling Station Name/Nom du bureau de scrutin',
  'Void Poll Indicator/Indicateur de bureau supprimé',
  'No Poll Held Indicator/Indicateur de bureau sans scrutin',
  'Merge With/Fusionné avec',
  'Rejected Ballots for Polling Station/Bulletins rejetés du bureau',
  'Electors for Polling Station/Électeurs du bureau',
  "Candidate's Family Name/Nom de famille du candidat",
  'Political Affiliation Name_English/Appartenance politique_Anglais',
  'Candidate Poll Votes Count/Votes du candidat pour le bureau']
FED_PARTIES = ['Liberal','Conservative','NDP-New Democratic Party','Green Party']
rows = []
# A west-to-east gradient so the correlation has real structure to find.
def gradient(f):
    b = f["geometry"]["coordinates"][0]
    lon = sum(p[0] for p in b) / len(b)
    return (lon - x0) / (x1 - x0)

# Per-poll figures first, so merges and the expected values can be derived from
# exactly what gets written.
polls = []   # dicts: fed, poll, votes{party}, rejected, electors, merge_with, type
for f in van:
    p = f["properties"]; g = gradient(f)
    base = {'Liberal': 0.20 + 0.30 * g, 'Conservative': 0.10 + 0.22 * (1 - g),
            'NDP-New Democratic Party': 0.30 * (1 - g) + 0.10, 'Green Party': 0.08}
    tot = sum(base.values())
    turnout = 220 + int(160 * (0.15 + 0.7 * g) + 25 * random.random())   # rises west to east
    polls.append({"fed": p["fed"], "poll": p["poll"], "num": p["poll"].split("-")[0], "type": p["type"],
                  "votes": {party: int(turnout * base[party] / tot) for party in FED_PARTIES},
                  "rejected": 4, "electors": turnout + 120, "merge_with": "", "void": False})

# Two merged polls per riding: the 7th ordinary poll of each riding is merged into
# the 6th. Elections Canada reports the receiver with both polls' ballots and the
# merged poll with none; both keep their own elector counts.
merges = []
for fedno in sorted(VAN):
    ordinary = [q for q in polls if q["fed"] == fedno and q["type"] == "N"]
    a, b = ordinary[5], ordinary[6]
    pooled_votes = {party: a["votes"][party] + b["votes"][party] for party in FED_PARTIES}
    pooled_rej = a["rejected"] + b["rejected"]
    a["votes"], a["rejected"] = pooled_votes, pooled_rej
    b["votes"] = {party: 0 for party in FED_PARTIES}; b["rejected"] = 0; b["merge_with"] = a["num"]
    merges.append((a, b))
# One void poll per riding: the 8th ordinary poll reports nothing at all.
for fedno in sorted(VAN):
    ordinary = [q for q in polls if q["fed"] == fedno and q["type"] == "N"]
    v = ordinary[7]
    v["void"] = True; v["votes"] = {party: 0 for party in FED_PARTIES}; v["rejected"] = 0; v["electors"] = 0

for q in polls:
    for party in FED_PARTIES:
        rows.append([q["fed"], "Sample Riding", q["num"], "Station",
                     "Y" if q["void"] else "N", "N", q["merge_with"],
                     str(q["rejected"]), str(q["electors"]), "Candidate", party, str(q["votes"][party])])
# One advance-poll row per advance poll the boundary file actually knows, so
# the fixture exercises the published division-to-advance-poll mapping the way
# the real Elections Canada files do. A riding has 12 to 20 of them.
ADV_BY_FED = {}
for f in van:
    p = f["properties"]
    if p.get("adv"):
        ADV_BY_FED.setdefault(p["fed"], set()).add(p["adv"])
for fedno in sorted(VAN):
    for adv in sorted(ADV_BY_FED.get(fedno, set()), key=int):
        for party in FED_PARTIES:
            rows.append([fedno, "Sample Riding", str(adv), f"Advance {adv}", "N", "N", "", "9", "3000",
                         "Candidate", party, str(400 + FED_PARTIES.index(party) * 55)])

# Hand-computed expectations for the browser suite. Turnout is
# (valid + rejected) / electors; merged members share the pooled figure.
FED_NAMES = {'59035': 'Vancouver Centre', '59036': 'Vancouver East',
             '59037': 'Vancouver Fraserview—South Burnaby', '59038': 'Vancouver Granville',
             '59039': 'Vancouver Kingsway', '59040': 'Vancouver Quadra'}
def label(q): return f'{FED_NAMES[q["fed"]]} · poll {q["poll"].replace("-0", "")}'
def turnout_of(q):
    for a, b in merges:
        if q is a or q is b:
            pooled = sum(a["votes"].values()) + a["rejected"] + sum(b["votes"].values()) + b["rejected"]
            return pooled / (a["electors"] + b["electors"])
    return (sum(q["votes"].values()) + q["rejected"]) / q["electors"]
ordinary_all = [q for q in polls if q["type"] == "N" and not q["void"]]
named = [q for q in polls if q["fed"] == "59035" and q["type"] == "N"][:3]
ranked = sorted(ordinary_all, key=turnout_of, reverse=True)
expected = {
    "named": [{"key": f'{q["fed"]}/{q["poll"]}', "label": label(q), "turnout_fed": turnout_of(q),
               "electors": q["electors"]} for q in named],
    "merged": [{"receiver": label(a), "merged": label(b), "turnout_fed": turnout_of(a),
                "electors_receiver": a["electors"], "electors_merged": b["electors"]} for a, b in merges[:2]],
    "top3_by_federal_turnout": [label(q) for q in ranked[:3]],
    "ordinary_polls": len(ordinary_all),
    "void_polls": sum(1 for q in polls if q["void"]),
    "advance_polls_per_riding": {fed: len(a) for fed, a in sorted(ADV_BY_FED.items())},
    "advance_ballots_per_riding": {
        fed: sum(400 + FED_PARTIES.index(p) * 55 for p in FED_PARTIES) * len(a) + 9 * len(a)
        for fed, a in sorted(ADV_BY_FED.items())},
}
json.dump(expected, open("fixtures/e2e_expected.json", "w"), indent=1)

def write_csv(path, header, rows):
    import csv
    with open(path, "w", newline="", encoding="utf-8") as fh:
        wr = csv.writer(fh); wr.writerow(header); wr.writerows(rows)
write_csv("fixtures/e2e_federal_results.csv", EC_HEADER, rows)
print(f"federal results: {len(rows)} rows")

# Provincial results by voting area, wide layout, correlated with the federal
# gradient but not identical to it.
PROV_PARTIES = ['BC NDP','BC Conservative','BC Green']
prov_header = ['Electoral District','Voting Area','Registered Voters'] + PROV_PARTIES + ['Rejected Ballots']
prov_rows = []
for a, poly in zip(attrs, polys):
    i = int(a["VA_CODE"][:2]); g = i / (NX - 1)
    ndp = 0.30 * (1 - g) + 0.14 + random.uniform(-0.03, 0.03)
    con = 0.16 + 0.26 * (1 - g) + random.uniform(-0.03, 0.03)
    grn = 0.10 + random.uniform(-0.02, 0.02)
    # Shares are scaled to sum to 0.95 of the ballots so turnout is set by the
    # total below and not by the party mix.
    scale = 0.95 / (ndp + con + grn)
    ndp, con, grn = ndp * scale, con * scale, grn * scale
    total = 260 + int(140 * (0.15 + 0.7 * g) + 20 * random.random())     # rises west to east
    prov_rows.append([a["ED_NAME"], a["VA_CODE"], str(total + 90),
                      str(int(total * ndp)), str(int(total * con)), str(int(total * grn)), "5"])
write_csv("fixtures/e2e_provincial_results.csv", prov_header, prov_rows)
print(f"provincial results: {len(prov_rows)} rows")
for n in ("e2e_voting_areas.zip","e2e_federal_results.csv","e2e_provincial_results.csv"):
    print(f"  fixtures/{n}: {os.path.getsize('fixtures/'+n):,} bytes")

# The same 700 voting areas in lon/lat, so every supported input format can be
# checked against the BC Albers shapefile above.
lonlat_feats, placemarks = [], []
for i in range(NX):
    for j in range(NY):
        ax, ay = x0 + i * w + w * 0.29, y0 + j * h + h * 0.41
        ring = [[ax, ay], [ax + w, ay], [ax + w, ay + h], [ax, ay + h], [ax, ay]]
        props = {"ED_NAME": f"Sample District {1 + (i * NY + j) // 60}", "VA_CODE": f"{i:02d}{j:02d}"}
        lonlat_feats.append({"type": "Feature", "properties": props,
                             "geometry": {"type": "Polygon", "coordinates": [ring]}})
        coords = " ".join(f"{a},{b},0" for a, b in ring)
        placemarks.append(
            f'<Placemark><name>VA {props["VA_CODE"]}</name><ExtendedData><SchemaData>'
            f'<SimpleData name="ED_NAME">{props["ED_NAME"]}</SimpleData>'
            f'<SimpleData name="VA_CODE">{props["VA_CODE"]}</SimpleData></SchemaData></ExtendedData>'
            f'<Polygon><outerBoundaryIs><LinearRing><coordinates>{coords}</coordinates>'
            f'</LinearRing></outerBoundaryIs></Polygon></Placemark>')

json.dump({"type": "FeatureCollection", "features": lonlat_feats},
          open("fixtures/e2e_va.geojson", "w"))
kml_doc = ('<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2">'
           '<Document>' + "".join(placemarks) + '</Document></kml>')
open("fixtures/e2e_va_kml.kml", "w", encoding="utf-8").write(kml_doc)
with zipfile.ZipFile("fixtures/e2e_va.kmz", "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("doc.kml", kml_doc)


def shoelace(r):
    return sum(r[k][0] * r[(k + 1) % len(r)][1] - r[(k + 1) % len(r)][0] * r[k][1]
               for k in range(len(r))) / 2


def rewound(want_exterior_positive, path):
    """Write the same layer with a chosen ring winding.

    d3-geo takes the interior to be right of the ring direction, so it needs
    CLOCKWISE exterior rings; RFC 7946 mandates counter-clockwise. Both
    spellings must draw the same shape, so both are kept as fixtures."""
    doc = json.loads(json.dumps({"type": "FeatureCollection", "features": lonlat_feats}))
    for f in doc["features"]:
        rings = f["geometry"]["coordinates"]
        for k, r in enumerate(rings):
            want_positive = want_exterior_positive if k == 0 else not want_exterior_positive
            if (shoelace(r) > 0) != want_positive:
                rings[k] = list(reversed(r))
    json.dump(doc, open(path, "w"))
    return shoelace(doc["features"][0]["geometry"]["coordinates"][0])


a = rewound(True, "fixtures/e2e_va_rfc7946.geojson")
b = rewound(False, "fixtures/e2e_va_clockwise.geojson")
print(f"lon/lat variants written; first-ring shoelace RFC7946 {a:+.6f}, clockwise {b:+.6f}")
for n in ("e2e_va.geojson", "e2e_va_kml.kml", "e2e_va.kmz",
          "e2e_va_rfc7946.geojson", "e2e_va_clockwise.geojson"):
    print(f"  fixtures/{n}: {os.path.getsize('fixtures/' + n):,} bytes")


# --- Census fixtures: dissemination areas, blocks, attribute file, profile ----
# A 12x10 grid of "dissemination areas" over the same extent, offset from both
# poll grids, in Statistics Canada Lambert with the Esri .prj StatCan ships;
# each split into four "blocks" with most of the people in the north-east
# quarter; a Geographic Attribute File; and a Census Profile in the long
# layout with a variable planted on the west-to-east gradient that drives the
# election results above, so the Socioeconomic tab has a known answer.
from tools import filter_census as fc

NXD, NYD = 12, 10
wd, hd = (x1 - x0) / NXD, (y1 - y0) / NYD
da_polys, da_attrs, db_polys, db_attrs, gaf_rows = [], [], [], [], []
census_values = {}
random.seed(11)

# Real dissemination areas exist where people live; the city's bounding box
# also holds water and the university lands, which have no city polls. Keep
# the cells that contain at least one whole poll, so every census area has
# election results to compare.
def poll_bbox(f):
    xs2, ys2 = [], []
    def walk2(c):
        if isinstance(c[0], (int, float)): xs2.append(c[0]); ys2.append(c[1])
        else:
            for k in c: walk2(k)
    walk2(f["geometry"]["coordinates"])
    return min(xs2), min(ys2), max(xs2), max(ys2)
poll_boxes = [poll_bbox(f) for f in van if f["properties"]["type"] == "N"]

for i in range(NXD):
    for j in range(NYD):
        ax, ay = x0 + i * wd + wd * 0.17, y0 + j * hd + hd * 0.23
        if not any(b[0] >= ax and b[2] <= ax + wd and b[1] >= ay and b[3] <= ay + hd for b in poll_boxes):
            continue
        ring = [(ax, ay), (ax + wd, ay), (ax + wd, ay + hd), (ax, ay + hd), (ax, ay)]
        da_polys.append([list(reversed([lcc_forward(lo, la) for lo, la in ring]))])
        dauid = f"5915{1 + i * NYD + j:04d}"
        da_attrs.append({"DAUID": dauid, "DGUID": "2021S0512" + dauid, "LANDAREA": round(wd * hd * 111 * 111 * 0.65, 4)})
        pop = 400 + (i * 37 + j * 11) % 300
        for q, (qx, qy, share) in enumerate([(0, 0, 0.10), (1, 0, 0.10), (0, 1, 0.10), (1, 1, 0.70)], start=1):
            bx, by = ax + qx * wd / 2, ay + qy * hd / 2
            bring = [(bx, by), (bx + wd / 2, by), (bx + wd / 2, by + hd / 2), (bx, by + hd / 2), (bx, by)]
            db_polys.append([list(reversed([lcc_forward(lo, la) for lo, la in bring]))])
            dbuid = f"{dauid}{q:02d}"
            db_attrs.append({"DBUID": dbuid, "DGUID": "2021S0513" + dbuid, "DAUID": dauid})
            bpop = int(round(pop * share))
            gaf_rows.append([dbuid, bpop, int(bpop / 2.3), int(bpop / 2.4), dauid, "5915022", "Vancouver", "59"])
        g = (ax + wd / 2 - x0) / (x1 - x0)
        hh = int(pop / 2.3)
        renter = int(hh * (0.75 - 0.5 * g + random.uniform(-0.03, 0.03)))
        census_values[dauid] = {
            1: pop, 6: int(pop / (wd * hd * 111 * 111 * 0.65)), 8: pop, 9: int(pop * 0.15), 10: int(pop * 0.65),
            11: int(pop * (0.12 + 0.16 * random.random())), 39: round(30 + 20 * random.random(), 1),
            50: hh, 51: int(hh * 0.30), 52: int(hh * 0.35), 57: round(2.0 + 0.6 * random.random(), 1),
            115: int(50000 + 60000 * g + random.uniform(-4000, 4000)), 345: round(25 - 15 * g + random.uniform(-2, 2), 1),
            1416: hh, 1417: hh - renter, 1418: renter,
            1500: pop, 1501: int(pop * 0.6), 1502: int(pop * 0.4), 1506: int(pop * 0.05), 1507: int(pop * 0.06),
            1900: pop, 1901: int(pop * 0.88), 1902: int(pop * 0.12), 1910: pop, 1911: int(pop * 0.6), 1912: int(pop * 0.4),
            1998: int(pop * 0.85), 2000: int(pop * 0.85 * 0.35), 2010: int(pop * 0.55), 2014: int(pop * 0.55 * 0.4),
            2224: round(5 + 4 * (1 - g) + random.uniform(-0.5, 0.5), 1),
        }
# A few suppressed cells, as the real files have them.
census_values[da_attrs[5]["DAUID"]][345] = "x"
census_values[da_attrs[7]["DAUID"]][2014] = "F"
census_values[da_attrs[9]["DAUID"]][115] = ".."

write_shp("fixtures/e2e_da.shp", da_polys)
write_dbf("fixtures/e2e_da.dbf", [("DAUID", "C", 8, 0), ("DGUID", "C", 21, 0), ("LANDAREA", "N", 14, 4)], da_attrs)
open("fixtures/e2e_da.prj", "w").write(STATCAN_LCC_WKT)
with zipfile.ZipFile("fixtures/e2e_da.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for ext in ("shp", "shx", "dbf", "prj"):
        z.write(f"fixtures/e2e_da.{ext}", f"lda_000b21a_e.{ext}")
write_shp("fixtures/e2e_db.shp", db_polys)
write_dbf("fixtures/e2e_db.dbf", [("DBUID", "C", 10, 0), ("DGUID", "C", 23, 0), ("DAUID", "C", 8, 0)], db_attrs)
open("fixtures/e2e_db.prj", "w").write(STATCAN_LCC_WKT)
with zipfile.ZipFile("fixtures/e2e_db.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for ext in ("shp", "shx", "dbf", "prj"):
        z.write(f"fixtures/e2e_db.{ext}", f"ldb_000b21a_e.{ext}")
# The same areas in lon/lat GeoJSON, for the format variants.
da_lonlat = []
for a, i_j in zip(da_attrs, [(i, j) for i in range(NXD) for j in range(NYD)
                             if any(b[0] >= x0 + i * wd + wd * 0.17 and b[2] <= x0 + i * wd + wd * 1.17
                                    and b[1] >= y0 + j * hd + hd * 0.23 and b[3] <= y0 + j * hd + hd * 1.23 for b in poll_boxes)]):
    i, j = i_j
    ax, ay = x0 + i * wd + wd * 0.17, y0 + j * hd + hd * 0.23
    ring = [[ax, ay], [ax + wd, ay], [ax + wd, ay + hd], [ax, ay + hd], [ax, ay]]
    da_lonlat.append({"type": "Feature", "properties": {"DAUID": a["DAUID"], "DGUID": a["DGUID"]},
                      "geometry": {"type": "Polygon", "coordinates": [ring]}})
json.dump({"type": "FeatureCollection", "features": da_lonlat}, open("fixtures/e2e_da.geojson", "w"))
write_csv("fixtures/e2e_geo_attr.csv",
          ["DBUID", "DBPOP2021", "DBTDWELL2021", "DBURDWELL2021", "DAUID", "CSDUID", "CSDNAME", "PRUID"], gaf_rows)

PROFILE_HEADER = ["CENSUS_YEAR", "DGUID", "ALT_GEO_CODE", "GEO_LEVEL", "GEO_NAME", "TNR_SF", "TNR_LF", "DATA_QUALITY_FLAG",
    "CHARACTERISTIC_ID", "CHARACTERISTIC_NAME", "CHARACTERISTIC_NOTE", "C1_COUNT_TOTAL", "SYMBOL", "C2_COUNT_MEN+", "SYMBOL",
    "C3_COUNT_WOMEN+", "SYMBOL", "C10_RATE_TOTAL", "SYMBOL", "C11_RATE_MEN+", "SYMBOL", "C12_RATE_WOMEN+", "SYMBOL"]
CHARACTERISTICS = [
    (1, "Population, 2021"), (6, "Population density per square kilometre"),
    (8, "Total - Age groups of the population - 100% data"), (9, "  0 to 14 years"), (10, "  15 to 64 years"),
    (11, "  65 years and over"), (39, "Median age of the population"),
    (50, "Total - Private households by household size - 100% data"), (51, "  1 person"), (52, "  2 persons"),
    (57, "Average household size"), (115, "Median total income of household in 2020 ($)"),
    (345, "Prevalence of low income based on the Low-income measure, after tax (LIM-AT) (%)"),
    (1416, "Total - Private households by tenure - 25% sample data"), (1417, "  Owner"), (1418, "  Renter"),
    (1500, "Total - Immigrant status and period of immigration for the population in private households - 25% sample data"),
    (1501, "  Non-immigrants"), (1502, "  Immigrants"), (1506, "    2011 to 2015"), (1507, "    2016 to 2021"),
    (1900, "Total - Mobility status 1 year ago - 25% sample data"), (1901, "  Non-movers"), (1902, "  Movers"),
    (1910, "Total - Mobility status 5 years ago - 25% sample data"), (1911, "  Non-movers"), (1912, "  Movers"),
    (1998, "Total - Highest certificate, diploma or degree for the population aged 15 years and over in private households - 25% sample data"),
    (2000, "  Bachelor's degree or higher"),
    (2010, "Total - Highest certificate, diploma or degree for the population aged 25 to 64 years in private households - 25% sample data"),
    (2014, "  Bachelor's degree or higher"), (2224, "Unemployment rate"),
]
profile_rows = []
for a in da_attrs:
    vals = census_values[a["DAUID"]]
    for cid, name in CHARACTERISTICS:
        v = vals[cid]
        symbol = v if v in ("x", "F", "..") else ""
        profile_rows.append(["2021", a["DGUID"], a["DAUID"], "Dissemination area", a["DAUID"], "2.5", "6.1", "00000",
                             cid, name, "", "" if v is None else v, symbol, "", "", "", "", "", "", "", "", "", ""])
write_csv("fixtures/e2e_census_long.csv", PROFILE_HEADER, profile_rows)

# The tool's own outputs for the same profile, so the browser reader and the
# tool are checked against each other.
import csv as _csv, io as _io, tempfile as _tempfile
with open("fixtures/e2e_census_long.csv", newline="", encoding="utf-8") as fh:
    reader = _csv.reader(fh)
    layout = fc.detect_layout(next(reader))
    profile = fc.pivot(reader, layout)
with _tempfile.TemporaryDirectory() as tmp:
    fc.write_profile_outputs(profile, tmp)
    for src, dst in (("census_da_wide.csv", "e2e_census_wide.csv"), ("starter.csv", "e2e_census_starter.csv"),
                     ("variables.csv", "e2e_census_variables.csv")):
        os.replace(os.path.join(tmp, src), os.path.join("fixtures", dst))

expected["census"] = {
    "dissemination_areas": len(da_attrs), "blocks": len(db_attrs),
    "planted_negative": "pct_renter", "planted_positive": "median_hh_income", "noise": "median_age",
    "population": sum(r[1] for r in gaf_rows),
}
json.dump(expected, open("fixtures/e2e_expected.json", "w"), indent=1)
print(f"census layer: {len(da_attrs)} dissemination areas, {len(db_attrs)} blocks, {len(profile_rows)} profile rows")


# --- An Elections BC data order, as the BC Data Catalogue delivers it ---------
# The same 700 voting areas with the columns of
# WHSE_ADMIN_BOUNDARIES.EBC_VOTING_AREAS_BS11_POLY_SVW, plus 30 areas of a
# district far from the study area, zipped next to the order's metadata files
# (the metadata .json is listed first, so a loader that grabs the first .json
# gets the wrong member).
ebc_feats = []
for n, f in enumerate(lonlat_feats, start=1):
    p = f["properties"]
    ed = "SD%02d" % int(p["ED_NAME"].split()[-1])
    ebc_feats.append({"type": "Feature", "geometry": f["geometry"], "properties": {
        "VOTING_AREA_POLY_ID": 24000 + n, "BOUNDARY_SET_ID": 11, "ED_ABBREVIATION": ed,
        "VA_CODE": p["VA_CODE"], "EDVA_CODE": ed + p["VA_CODE"], "VA_TYPE": "Areal",
        "DATA_ACCESS_LEVEL": "Public", "GAZETTE_DATE": "20240919", "FEATURE_AREA_SQM": 0.0,
        "FEATURE_LENGTH_M": 0.0, "OBJECTID": 160000 + n, "SE_ANNO_CAD_DATA": None,
        "SHAPE.AREA": 0, "SHAPE.LEN": 0}})
FAR_X, FAR_Y, FAR_NX, FAR_NY = -122.80, 53.90, 3, 10          # a grid near Prince George
for i in range(FAR_NX):
    for j in range(FAR_NY):
        ax, ay = FAR_X + i * 0.01, FAR_Y + j * 0.01
        ring = [[ax, ay], [ax + 0.01, ay], [ax + 0.01, ay + 0.01], [ax, ay + 0.01], [ax, ay]]
        code = "%03d" % (1 + i * FAR_NY + j)
        ebc_feats.append({"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [ring]}, "properties": {
            "VOTING_AREA_POLY_ID": 30000 + len(ebc_feats), "BOUNDARY_SET_ID": 11, "ED_ABBREVIATION": "FAR",
            "VA_CODE": code, "EDVA_CODE": "FAR" + code, "VA_TYPE": "Areal", "DATA_ACCESS_LEVEL": "Public",
            "GAZETTE_DATE": "20240919", "FEATURE_AREA_SQM": 0.0, "FEATURE_LENGTH_M": 0.0,
            "OBJECTID": 170000 + len(ebc_feats), "SE_ANNO_CAD_DATA": None, "SHAPE.AREA": 0, "SHAPE.LEN": 0}})
ebc_doc = {"type": "FeatureCollection", "name": "EBC_VOTING_AREAS_BS11_POLY_SVW", "features": ebc_feats}
ebc_meta = [{"title": "Provincial Electoral District Voting Areas - Gazetted 09/19/2024 (test fixture)",
             "object_name": "WHSE_ADMIN_BOUNDARIES.EBC_VOTING_AREAS_BS11_POLY_SVW", "projection_name": "epsg3005",
             "license_title": "Elections BC Open Data Licence"}]
with zipfile.ZipFile("fixtures/e2e_ebc_order.zip", "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("WHSE_ADMIN_BOUNDARIES.EBC_VOTING_AREAS_BS11_POLY_SVW_metadata.json", json.dumps(ebc_meta, indent=1))
    z.writestr("Contents of Order.txt", "Order ID: 0\nFeature Types\n - Provincial Electoral District Voting Areas (test fixture)\n")
    z.writestr("EBC_VOTING_AREAS_BS11_POLY_SVW.geojson", json.dumps(ebc_doc))
    z.writestr("licence.txt", "Test fixture: synthetic geometry, no licence applies.\n")
expected["ebc"] = {"total": len(ebc_feats), "in_study_area": len(lonlat_feats), "far": FAR_NX * FAR_NY,
                   "districts": len({f["properties"]["ED_ABBREVIATION"] for f in ebc_feats})}
json.dump(expected, open("fixtures/e2e_expected.json", "w"), indent=1)
print(f"Elections BC order fixture: {len(ebc_feats)} areas in {expected['ebc']['districts']} districts "
      f"({os.path.getsize('fixtures/e2e_ebc_order.zip'):,} bytes)")


# --- Provincial results reported by voting place, the 2024 layout -------------
# Elections BC's 2024 file has one row per place per voting opportunity, with
# the party columns named "<party>_votes" and coordinates only on the rows that
# have a place at all. Three final-voting places per district earn a catchment;
# advance voting, the district office, mail and out-of-district rows do not.
PLACE_HEADER = ['event_year', 'electoral_district_abbreviation', 'electoral_district_name',
                'voting_location', 'voting_opportunity', 'geocode_ready', 'valid_votes',
                'rejected_ballots', 'total_ballots', 'bc_ndp_votes', 'bc_conservative_votes',
                'bc_green_votes', 'longitude', 'latitude', 'street_address', 'building_name',
                'geocode_source']
by_district = {}
for a, poly in zip(attrs, polys):
    by_district.setdefault(a["ED_NAME"], []).append((a, poly))

place_rows = []
place_count = located_ballots = spread_ballots = 0
random.seed(11)
for ed in sorted(by_district):
    cells = by_district[ed]
    # Cell centres in lon/lat, taken from the same grid the polygons came from.
    centres = []
    for a, _ in cells:
        i, j = int(a["VA_CODE"][:2]), int(a["VA_CODE"][2:])
        centres.append((x0 + i * w + w * 0.79, y0 + j * h + h * 0.91))
    centres.sort()
    picks = [centres[len(centres) // 6], centres[len(centres) // 2], centres[-len(centres) // 6]]

    def row(opportunity, lon, lat, ballots, g, name):
        global place_count, located_ballots, spread_ballots
        ndp = 0.30 * (1 - g) + 0.14
        con = 0.16 + 0.26 * (1 - g)
        grn = 0.10
        scale = 0.95 / (ndp + con + grn)
        rejected = max(1, ballots // 120)
        valid = ballots - rejected
        cells3 = [int(valid * ndp * scale), int(valid * con * scale)]
        cells3.append(valid - sum(cells3))
        located = lon is not None
        if located:
            place_count += 1
            located_ballots += sum(cells3) + rejected
        else:
            spread_ballots += sum(cells3) + rejected
        place_rows.append([2024, ed, ed, name, opportunity, 'yes' if located else 'no',
                           sum(cells3), rejected, sum(cells3) + rejected, cells3[0], cells3[1], cells3[2],
                           '' if lon is None else f"{lon:.6f}", '' if lat is None else f"{lat:.6f}",
                           '' if located else '', name,
                           'Elections BC Provincial Voting Places' if located else ''])

    for k, (lon, lat) in enumerate(picks):
        g = (lon - x0) / (x1 - x0)
        row('Final voting', lon, lat, 900 + 200 * k, g, f"{ed} Hall {k + 1}")
    mid_lon, mid_lat = picks[1]
    row('Advance voting', mid_lon, mid_lat, 1400, (mid_lon - x0) / (x1 - x0), f"{ed} Advance")
    row('DEO office voting', picks[0][0], picks[0][1], 150, (picks[0][0] - x0) / (x1 - x0), f"{ed} District Office")
    row('Vote by mail', None, None, 500, 0.5, '')
    row('Final voting - out-of-district', None, None, 120, 0.5, '')

write_csv("fixtures/e2e_voting_places.csv", PLACE_HEADER, place_rows)
expected["places"] = {
    "rows": len(place_rows), "located": place_count,
    "unlocated": len(place_rows) - place_count,
    "districts": len(by_district),
    "catchments": 3 * len(by_district),
    "ballots": located_ballots + spread_ballots,
    "parties": ['BC NDP', 'BC Conservative', 'BC Green'],
}
json.dump(expected, open("fixtures/e2e_expected.json", "w"), indent=1)
print(f"voting places: {len(place_rows)} rows, {place_count} located, "
      f"{expected['places']['ballots']:,} ballots "
      f"({os.path.getsize('fixtures/e2e_voting_places.csv'):,} bytes)")


# --- Registered voters by electoral district ---------------------------------
# Elections BC publishes the denominator in the Statement of Votes, not in the
# results file: one row per district, with the voters who voted beside the
# voters registered. The first column is a decoy -- a reader that picks it
# reports a turnout of exactly 100%.
elector_rows = []
for ed in sorted(by_district):
    cells = by_district[ed]
    voted = sum(1100 + 200 * k for k in range(3)) + 1400 + 150 + 500 + 120   # as written above
    elector_rows.append([ed, voted, int(voted / 0.55)])
write_csv("fixtures/e2e_prov_electors.csv",
          ["Electoral District", "Registered voters who voted", "Registered voters"], elector_rows)
expected["electors"] = {"districts": len(elector_rows),
                        "total": sum(r[2] for r in elector_rows)}
json.dump(expected, open("fixtures/e2e_expected.json", "w"), indent=1)
print(f"registered voters: {len(elector_rows)} districts, {expected['electors']['total']:,} voters")
