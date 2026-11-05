"""Turn the Township of Langley's results by precinct into the race sheets and
voting places the atlas reads.

    python3 tools/langley-township/results.py --results by-precinct.json \
        --places tools/langley-township/places-2026.csv \
        --slates tools/langley-township/slates-2026.csv \
        --out-results langley-township-2026-results.zip \
        --out-places langley-township-voting-places-2026.csv

--results is the Township's "2026 Municipal Election Results By Precinct"
layer, as ArcGIS JSON:

    https://services5.arcgis.com/frpHL0Fv8koQRVWY/arcgis/rest/services/
        2026_Municipal_Election_Results_By_Precinct/FeatureServer/0/
        query?where=1%3D1&outFields=*&f=json

a row per candidate per precinct; Elected_Position says the race (1 mayor,
2 councillor, 3 school trustee). Every candidate's precincts add up to the
total on the Township's results page; the slates are from that page.
Eligible voters could vote at any location, so the atlas smooths each place's
ballots. "Special 1" and "Special 2" have no place."""
import argparse, collections, csv, io, json, os, re, sys, zipfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from wide_results import geocode, person

RACE = {1: ('Mayor', 1, 'Mayor'), 2: ('Councillor', 8, 'Councillor'), 3: ('School Trustee', 5, 'SchoolTrustee')}


def main():
    ap = argparse.ArgumentParser()
    for f in ('results', 'places', 'slates', 'out-results', 'out-places'):
        ap.add_argument('--' + f, required=True)
    ap.add_argument('--year', default='2026')
    a = ap.parse_args()
    rows = [f['attributes'] for f in json.load(open(a.results))['features']]
    precincts = list(dict.fromkeys(r['Precinct'] for r in rows))
    votes = collections.defaultdict(dict)
    for r in rows:
        votes[(r['Elected_Position'], r['Ballot_Candidate'])][r['Precinct']] = r['Votes']
    places = {r['place']: r for r in csv.DictReader(open(a.places, encoding='utf-8'))}
    slates = {r['candidate']: r['elector_organization'] for r in csv.DictReader(open(a.slates, encoding='utf-8'))}

    ids, out_places, at = {}, [], {}
    for k, pr in enumerate(precincts, 1):
        if pr.startswith('Special'):
            ids[pr] = f'MBV{k} - {pr}'
            continue
        adv = pr.startswith('ADV - ')
        key = pr[6:] if adv else pr
        if key not in places:
            sys.exit(f'No address for "{key}" in {a.places}')
        p = places[key]
        if p['address'] not in at:
            at[p['address']] = geocode(p['address'])
        lon, lat = at[p['address']]
        code = f'P{k:02d}'
        ids[pr] = f'{code} - {p["name"]}'
        out_places.append([code, p['name'] + (' (advance)' if adv else ''), p['address'],
                           'Yes' if adv else 'No', f'{lat:.6f}, {lon:.6f}'])
    cast = {pr: sum(v.get(pr, 0) for (pos, _), v in votes.items() if pos == 1) for pr in precincts}
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        for pos, (race, seats, sheet) in RACE.items():
            cands = sorted((c for (p, c) in votes if p == pos), key=lambda c: -sum(votes[(pos, c)].values()))
            heads = []
            for c in cands:
                name = person(c)
                if ' De ' in name:
                    name = name.replace(' De ', ' de ')
                slate = slates.get(name, '')
                group = (f'{name} – {slate}' if race == 'Mayor' else slate) if slate else name
                parts = name.split()
                heads.append(f'{parts[-1].upper()}, {" ".join(parts[:-1])} ({group})')
            o = io.StringIO()
            w = csv.writer(o)
            w.writerow([f'{a.year} {race.upper()} Results by Location (Vote for {seats})'])
            w.writerow(['Voting Place ID', 'Times Cast'] + heads)
            for pr in precincts:
                w.writerow([ids[pr], cast[pr]] + [votes[(pos, c)].get(pr, 0) for c in cands])
            z.writestr(f'{a.year}LangleyTownshipResults_{sheet}.csv', o.getvalue())
            print(f'{race}: {len(cands)} candidates over {len(precincts)} precincts, '
                  f'{sum(1 for c in cands if person(c).replace(" De ", " de ") in slates)} with a slate')
    open(a.out_results, 'wb').write(buf.getvalue())
    with open(a.out_places, 'w', newline='', encoding='utf-8') as fh:
        w = csv.writer(fh)
        w.writerow(['Voting Place ID', 'Facility Name', 'Facility Address', 'Advance Only', 'geo_point_2d'])
        w.writerows(out_places)
    print(f'{a.out_places}: {len(out_places)} places, {sum(1 for p in out_places if p[3] == "Yes")} advance')


if __name__ == '__main__':
    main()
