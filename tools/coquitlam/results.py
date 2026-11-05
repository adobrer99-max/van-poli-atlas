"""Turn Coquitlam's results per tabulator into the race sheets and voting places
the atlas reads, in the shape the City of Vancouver uses.

    python3 tools/coquitlam/results.py \
        --results 2026-General-Local-Election---Results-by-Voting-Place.pdf \
        --places tools/coquitlam/places-2026.csv \
        --year 2026 --out-results coquitlam-2026-results.zip \
        --out-places coquitlam-voting-places-2026.csv

--results is the city's "Results by Voting Place" PDF (coquitlam.ca/1188),
"Results per Tabulator": a table per race, a row per tabulator ("Glen
Elementary - Tab 2", "ADV - TCPCC - Tab 1", "Mail Ballot Voting - Tab 1") and a
Total row. It is read with pdftotext -layout. A row whose name wraps over
several lines is still one line of numbers, and the rows come in the same order
in every race, so the names are taken from the Mayor table and the numbers of
the other tables are matched to them in order. Every candidate's tabulators
must add up to the Total row, or nothing is written.

--places gives each voting place's address (tools/coquitlam/places-2026.csv,
with its source), geocoded with the Province's address geocoder
(geocoder.api.gov.bc.ca). Two tabulators at one place are one point carrying
two rows. Advance places are named "(advance)". Mail ballots and the special
voting opportunity have no place.

Coquitlam votes anywhere, as Vancouver does, so the atlas smooths each place's
ballots over the areas around it. Every 2026 candidate ran as an independent
(VoteMate's candidate list), so every race is read by candidate. The city does
not publish ballots per tabulator; Times Cast is the tabulator's mayoral
votes."""
import argparse, csv, io, json, re, subprocess, sys, urllib.parse, urllib.request, zipfile

SHEET = {'Mayor': 'Mayor', 'Councillor': 'Councillor', 'School Trustee': 'SchoolTrustee'}
NUM = r'\d{1,3}(?:,\d{3})*'


def geocode(address):
    q = urllib.parse.urlencode({'addressString': address, 'maxResults': 1, 'minScore': 90})
    with urllib.request.urlopen(f'https://geocoder.api.gov.bc.ca/addresses.json?{q}', timeout=60) as r:
        f = json.load(r)['features']
    if not f:
        raise SystemExit(f'The geocoder could not place "{address}".')
    return f[0]['geometry']['coordinates'], f[0]['properties']['score']


def main():
    ap = argparse.ArgumentParser()
    for f in ('results', 'places', 'year', 'out-results', 'out-places'):
        ap.add_argument('--' + f, required=True)
    a = ap.parse_args()
    text = subprocess.run(['pdftotext', '-layout', a.results, '-'], capture_output=True, text=True,
                          check=True).stdout
    parts = re.split(r'^\s*(Mayor|Councillor|School Trustee) \(Vote for (\d+)\)\s*$', text, flags=re.M)
    races = {}
    for i in range(1, len(parts), 3):
        races[parts[i]] = (int(parts[i + 1]), parts[i + 2])

    # Names of the tabulators, from the Mayor table, whose rows never wrap.
    seats, body = races['Mayor']
    labels = []
    for line in body.splitlines():
        m = re.match(rf'^(\S.*?)\s{{2,}}({NUM}(?:\s+{NUM})+)\s*$', line)
        if m and m.group(1) != 'Total':
            labels.append(m.group(1).strip())

    data = {}
    for race, (seats, body) in races.items():
        lines = body.splitlines()
        total = next([int(x.replace(',', '')) for x in l.split()[1:]] for l in lines
                     if l.strip().startswith('Total'))
        n = len(total)
        # A row is a line that ends in one number per candidate; the name
        # before it may be cut off or wrapped onto the lines around it.
        rows = []
        for line in lines:
            toks = line.split()
            if line.strip().startswith('Total') or len(toks) < n:
                continue
            tail = toks[-n:]
            if all(re.fullmatch(NUM, t) for t in tail):
                rows.append([int(t.replace(',', '')) for t in tail])
        if len(rows) != len(labels):
            sys.exit(f'{race}: {len(rows)} rows of {n} numbers, but {len(labels)} tabulators in the Mayor table')
        for j in range(n):
            s = sum(r[j] for r in rows)
            if s != total[j]:
                sys.exit(f'{race}: column {j + 1} adds up to {s}, the Total row says {total[j]}')
        data[race] = (seats, rows, total)
        print(f'{race}: {n} candidates, {len(rows)} tabulators, all columns add up to the Total row')

    cands = {}
    for r in csv.DictReader(open(a.places.replace('places-', 'candidates-'), encoding='utf-8')):
        cands.setdefault(r['office'], []).append(r['candidate'])
    for race, (seats, rows, total) in data.items():
        if len(cands.get(race, [])) != len(total):
            sys.exit(f'{race}: {len(total)} columns but {len(cands.get(race, []))} names in the candidates file')

    places = {r['place']: r for r in csv.DictReader(open(a.places, encoding='utf-8'))}
    ids, out_places, at = [], [], {}
    for k, lab in enumerate(labels, 1):
        place = re.sub(r'\s*-\s*Tab\s*\d+$', '', lab)
        adv = place.startswith('ADV - ')
        place = place[6:] if adv else place
        code = f'T{k:02d}'
        if re.match(r'(Mail Ballot|Special Voting)', place):
            ids.append(f'MBV{k} - {place}')
            continue
        if place not in places:
            sys.exit(f'No address for "{place}" in {a.places}')
        p = places[place]
        if p['address'] not in at:
            at[p['address']] = geocode(p['address'])
        (lon, lat), score = at[p['address']]
        ids.append(f'{code} - {p["name"]}')
        out_places.append([code, p['name'] + (' (advance)' if adv else f' (tabulator {k})'), p['address'],
                           'Yes' if adv else 'No', f'{lat:.6f}, {lon:.6f}'])

    # A tabulator with no votes in any race (a spare that was never used,
    # "Smiling Creek Elementary - Tab 2" in 2026) is left out.
    empty = [all(not any(rows[i]) for _, rows, _ in data.values()) for i in range(len(labels))]
    for i in range(len(labels)):
        if empty[i]:
            print(f'{labels[i]}: no votes in any race; left out')
    out_places = [p for p in out_places if not empty[int(p[0][1:]) - 1]]
    mayor_rows = data['Mayor'][1]
    cast = [sum(r) for r in mayor_rows]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        for race, (seats, rows, total) in data.items():
            heads = []
            for n in cands[race]:
                parts = n.split()
                heads.append(f'{parts[-1].upper()}, {" ".join(parts[:-1])} ({n})')
            o = io.StringIO()
            w = csv.writer(o)
            w.writerow([f'{a.year} {race.upper()} Results by Location (Vote for {seats})'])
            w.writerow(['Voting Place ID', 'Times Cast'] + heads)
            for i, r in enumerate(rows):
                if empty[i]:
                    continue
                w.writerow([ids[i], cast[i]] + r)
            z.writestr(f'{a.year}CoquitlamResults_{SHEET[race]}.csv', o.getvalue())
    open(a.out_results, 'wb').write(buf.getvalue())
    with open(a.out_places, 'w', newline='', encoding='utf-8') as fh:
        w = csv.writer(fh)
        w.writerow(['Voting Place ID', 'Facility Name', 'Facility Address', 'Advance Only', 'geo_point_2d'])
        w.writerows(out_places)
    print(f'{a.out_places}: {len(out_places)} tabulators with a place, '
          f'{sum(1 for p in out_places if p[3] == "Yes")} advance; {len(labels) - len(out_places)} without')


if __name__ == '__main__':
    main()
