"""Name each division after its voting place, from the city's ballots-cast PDF.

    python3 5_name.py 2026_Election_Results_Total_Ballots_Cast_per_voting_opportunity.pdf \
        richmond_divisions.geojson richmond-voting-divisions.geojson"""
import json, re, subprocess, sys

pdf, src, out = sys.argv[1:4]
text = subprocess.run(['pdftotext', '-layout', pdf, '-'], capture_output=True, text=True).stdout
names = {}
for line in text.splitlines():
    m = re.match(r'^\s*(R[CES])\s*(\d+)\s{2,}(.*?)(?:\s{2,}[\d,]+)?\s*$', line)
    if m:
        names[f'{m.group(1)}{int(m.group(2)):02d}'] = m.group(3).strip()
fc = json.load(open(src))
for f in fc['features']:
    f['properties']['name'] = names.get(f['properties']['id'], '')
json.dump(fc, open(out, 'w'), separators=(',', ':'))
print(out, len(fc['features']), 'divisions,', sum(1 for f in fc['features'] if f['properties']['name']), 'named')
