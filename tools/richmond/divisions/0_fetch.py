"""Fetch what the division trace needs, into the current directory.

    python3 0_fetch.py

From the City of Richmond's public map service (the one Richmond Interactive
Map uses, through its own proxy): street centrelines, the city boundary and
the island outlines. From the city's council papers: the 2018 report whose
Schedules B, C and D to Bylaw 7244 are the voting-division maps, extracted as
byl-000.png (centre), byl-001.png (east) and byl-002.png (south).

Needs pdfimages (poppler-utils). Everything lands beside where it is run."""
import json, subprocess, urllib.parse, urllib.request

PX = 'https://maps.richmond.ca/DotNet/proxy.ashx?'
BASE = 'https://maps.richmond.ca/internal/rest/services/RIM/Public_Base_Map/MapServer'
HEAD = {'Referer': 'https://maps.richmond.ca/rim/'}


def q(layer, params):
    url = PX + f'{BASE}/{layer}/query?' + urllib.parse.urlencode(params)
    return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=HEAD), timeout=120))


def layer(n, fields, out):
    ids = sorted(q(n, {'where': '1=1', 'returnIdsOnly': 'true', 'f': 'json'})['objectIds'])
    feats = []
    for i in range(0, len(ids), 800):
        a, b = ids[i], ids[min(i + 799, len(ids) - 1)]
        feats += q(n, {'where': f'OBJECTID>={a} AND OBJECTID<={b}', 'outFields': fields,
                       'outSR': '4326', 'f': 'geojson'})['features']
    json.dump({'type': 'FeatureCollection', 'features': feats}, open(out, 'w'))
    print(out, len(feats))


layer(0, 'STREET_NAM,STREET_SUBTYPE,STR_TYPE', 'streets.geojson')
layer(3, 'OBJECTID', 'city_boundary.geojson')
layer(5, 'NAME,SHAPE_Area', 'islands.geojson')
pdf = 'vd2018.pdf'
urllib.request.urlretrieve('https://citycouncil.richmond.ca/__shared/assets/'
                           '_5_VotingDivisions2018_GP05221850457.pdf', pdf)
subprocess.run(['pdfimages', '-f', '13', '-l', '15', '-png', pdf, 'byl'], check=True)
print('byl-000.png byl-001.png byl-002.png')
