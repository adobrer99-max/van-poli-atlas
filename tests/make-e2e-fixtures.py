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
    turnout = 220 + int(160 * random.random())
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
for fedno in sorted(VAN):
    for adv in range(600, 606):
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
    "advance_ballots_per_riding": sum(400 + FED_PARTIES.index(p) * 55 for p in FED_PARTIES) * 6 + 9 * 6,
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
    total = 260 + int(140 * random.random())
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
