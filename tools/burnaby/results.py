"""Turn Burnaby's votes by voting machine into the race sheets and voting places
the atlas reads, in the shape the City of Vancouver uses.

    python3 tools/burnaby/results.py \
        --machines burnaby-2026-machines.json \
        --locations ElectionLocations.json \
        --slates tools/burnaby/slates-2026.csv \
        --year 2026 --out-results burnaby-2026-results.zip \
        --out-places burnaby-voting-places-2026.csv

--machines is what ocr_results.py writes: every candidate's votes on every
voting machine, already reconciled with the city's published totals.
--locations is the City's "Election Voting Locations" layer (the one its
voting-locations map draws), as ArcGIS JSON in lon/lat:

    https://services5.arcgis.com/NgSjNljtJn9hphOU/arcgis/rest/services/
        ElectionLocations_view/FeatureServer/0/query?where=1%3D1&outFields=*&outSR=4326&f=json

A machine is named for its location ("17 - Temp Cameron Community Centre -
Tab A"); it is matched to the location by name, and two machines at one
location are one point carrying two rows. Machines at an advance location are
marked Advance Only; mail ballots have no place.

The city does not publish ballots per machine, so Times Cast is the machine's
mayoral votes, which is ballots less the few that left mayor blank. Mayor is
read by candidate, council and school trustee by elector organization, as for
Richmond and Surrey."""
import argparse, csv, difflib, io, json, re, sys, zipfile

SHEET = {'Mayor': 'Mayor', 'Councillor': 'Councillor', 'School Trustee': 'SchoolTrustee'}
SEATS = {'Mayor': 1, 'Councillor': 8, 'School Trustee': 7}


def key(s):
    s = s.lower().replace('temp ', 'temporary ')
    s = re.sub(r'\b(tab\s*[a-z]|school|elementary|secondary|community|centre|the)\b', ' ', s)
    return ' '.join(re.findall(r'[a-z0-9]+', s))


def main():
    ap = argparse.ArgumentParser()
    for f in ('machines', 'locations', 'slates', 'year', 'out-results', 'out-places'):
        ap.add_argument('--' + f, required=True)
    a = ap.parse_args()
    data = json.load(open(a.machines))
    if data.get('problems'):
        sys.exit(f'{len(data["problems"])} columns in {a.machines} do not add up to the official totals.')
    feats = json.load(open(a.locations))['features']
    locs = {}
    for f in feats:
        at = f['attributes']
        if at.get('STATUS') not in ('General Voting Day', 'Advance Voting Day'):
            continue
        locs.setdefault(at['NAME'], {'name': at['NAME'], 'addr': at.get('ADDRESS') or '',
                                     'lon': f['geometry']['x'], 'lat': f['geometry']['y'],
                                     'adv': False, 'gen': False})
        locs[at['NAME']]['adv' if at['STATUS'].startswith('Advance') else 'gen'] = True
    slates = {}
    for r in csv.DictReader(open(a.slates, encoding='utf-8')):
        slates[(r['office'], r['candidate'])] = r['elector_organization'].strip()

    labels = {int(k): v for k, v in data['machines'].items()}
    places, ids = [], {}
    for m in sorted(labels):
        lab = re.sub(r'^\s*\d{1,2}\s*[-–]?\s*', '', labels[m]).strip()
        if re.search(r'mail', lab, re.I):
            ids[m] = f'MBV{m} - {lab}'
            continue
        adv = bool(re.search(r'advance', lab, re.I))
        name = re.sub(r'\b(advance( voting)?|tab\s*[a-z])\b', ' ', lab, flags=re.I)
        best = max(locs.values(), key=lambda L: difflib.SequenceMatcher(None, key(name), key(L['name'])).ratio())
        score = difflib.SequenceMatcher(None, key(name), key(best['name'])).ratio()
        if score < 0.55:
            sys.exit(f'Machine {m} "{labels[m]}" matches no voting location (best {best["name"]}, {score:.2f})')
        code = f'M{m:02d}'
        ids[m] = f'{code} - {best["name"]}'
        places.append([code, best['name'] + (' (advance)' if adv else f' (machine {m})'), best['addr'],
                       'Yes' if adv else 'No', f'{best["lat"]:.6f}, {best["lon"]:.6f}'])
    with open(a.out_places, 'w', newline='', encoding='utf-8') as fh:
        w = csv.writer(fh)
        w.writerow(['Voting Place ID', 'Facility Name', 'Facility Address', 'Advance Only', 'geo_point_2d'])
        w.writerows(places)

    mayor = data['races']['Mayor']
    cast = {m: sum((mayor[c].get(str(m)) or 0) for c in mayor) for m in labels}
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        for race, cands in data['races'].items():
            names = sorted(cands)
            heads = []
            for n in names:
                slate = slates.get((race, n), '')
                parts = n.split()
                person = n
                label = f'{person} – {slate}' if race == 'Mayor' and slate else (slate or person)
                heads.append(f'{parts[-1].upper()}, {" ".join(parts[:-1])} ({label})')
            out = io.StringIO()
            w = csv.writer(out)
            w.writerow([f'{a.year} {race.upper()} Results by Location (Vote for {SEATS[race]})'])
            w.writerow(['Voting Place ID', 'Times Cast'] + heads)
            for m in sorted(labels):
                w.writerow([ids[m], cast[m]] + [cands[n].get(str(m)) or 0 for n in names])
            z.writestr(f'{a.year}BurnabyResults_{SHEET[race]}.csv', out.getvalue())
            print(f'{race}: {len(names)} candidates over {len(labels)} machines')
    open(a.out_results, 'wb').write(buf.getvalue())
    adv = sum(1 for p in places if p[3] == 'Yes')
    print(f'{a.out_places}: {len(places)} machines with a place ({adv} advance); '
          f'{len(labels) - len(places)} mail')


if __name__ == '__main__':
    main()
