"""Turn a city's results table -- a row per candidate, a column per voting
place -- into the race sheets and voting places the atlas reads, in the shape
the City of Vancouver uses.

    python3 tools/wide_results.py --layout tools/maple-ridge/layout-2026.json \
        --results results.pdf --out-results maple-ridge-2026-results.zip \
        --out-places maple-ridge-voting-places-2026.csv

Maple Ridge, Pitt Meadows and Port Moody all publish their results this way,
each in a PDF read with pdftotext -layout. What differs is written in the
city's layout file:

  "city", "year", "stem"   names, and the file stem of the race sheets
  "races"     {"Mayor": "Mayor", "Councillor": "Councillor", ...}: the heading
              that starts each race's table (matched at the start of a line,
              ignoring case) and the race it is
  "seats"     seats per race, for the sheet's "Vote for N" line
  "stop"      headings that end the last race (an assent vote, a turnout block)
  "columns"   one entry per number on a candidate's line, in order:
                "total"         the candidate's total, checked, not a place
                "mail", "special", "advance"
                                ballots with no place of their own
                "adv:<place>"   an advance place, with an address
                "<place>"       an election-day place, with an address
  "ballots"   optional: the heading of a row giving ballots cast per column,
              which becomes Times Cast (otherwise it is the mayoral votes)
  "slates"    optional: {"Name": "Elector organization"}; a slate printed in
              brackets after the name ("Lurbiecki, Haven (Port Moody Voice)")
              is read too. Everyone else is an independent, read by name.

--places is the city's places file (place, name, address, source); each is
located with the Province's address geocoder (geocoder.api.gov.bc.ca).

Nothing is written unless every candidate's places add up to the candidate's
total, and every place's column to the table's Total row where it has one."""
import argparse, csv, io, json, re, sys, urllib.parse, urllib.request, zipfile, subprocess

SHEET = {'Mayor': 'Mayor', 'Councillor': 'Councillor', 'School Trustee': 'SchoolTrustee'}
NUM = re.compile(r'^\d{1,3}(?:,\d{3})*$|^\d+$')


def geocode(address):
    q = urllib.parse.urlencode({'addressString': address, 'maxResults': 1, 'minScore': 90})
    with urllib.request.urlopen(f'https://geocoder.api.gov.bc.ca/addresses.json?{q}', timeout=60) as r:
        f = json.load(r)['features']
    if not f:
        raise SystemExit(f'The geocoder could not place "{address}".')
    return f[0]['geometry']['coordinates']


def person(raw):
    """'KOK, Jerry' -> 'Jerry Kok'; 'Lurbiecki, Haven' -> 'Haven Lurbiecki'."""
    if ',' not in raw:
        return raw.strip()
    last, first = [x.strip() for x in raw.split(',', 1)]
    if last.isupper():
        last = re.sub(r"(^|[\s'-])([a-z])", lambda m: m.group(1) + m.group(2).upper(), last.lower())
        last = re.sub(r'\bMc([a-z])', lambda m: 'Mc' + m.group(1).upper(), last)
    return f'{first} {last}'


def main():
    ap = argparse.ArgumentParser()
    for f in ('layout', 'results', 'places', 'out-results', 'out-places'):
        ap.add_argument('--' + f, required=True)
    a = ap.parse_args()
    L = json.load(open(a.layout, encoding='utf-8'))
    cols = L['columns']
    text = subprocess.run(['pdftotext', '-layout', a.results, '-'], capture_output=True, text=True,
                          check=True).stdout

    races, totals_row, ballots = {}, {}, None
    race = None
    heads = [(h.lower(), r) for h, r in L['races'].items()]
    stops = [s.lower() for s in L.get('stop', [])]
    for line in text.splitlines():
        s = line.strip()
        low = s.lower()
        if not s:
            continue
        hit = next((r for h, r in heads if low.startswith(h)), None)
        if hit:
            race = hit
            races.setdefault(race, [])
            continue
        if L.get('ballots') and low.startswith(L['ballots'].lower()):
            # the row may sit on its own line below the heading, or on the
            # heading's own line
            same = [int(t.replace(',', '')) for t in s.split() if NUM.match(t)]
            if len(same) == len(cols):
                ballots = same
                race = None
            else:
                race = '__ballots'
            continue
        if any(low.startswith(x) for x in stops):
            race = None
            continue
        if race is None:
            continue
        toks = [t for t in re.split(r'\s{2,}|\s(?=\d)', s) if t and t not in ('Elected', '--')]
        nums = [t for t in toks if NUM.match(t)]
        label = ' '.join(t for t in toks if not NUM.match(t)).strip()
        if len(nums) != len(cols):
            continue
        vals = [int(n.replace(',', '')) for n in nums]
        if race == '__ballots':
            ballots = vals
            continue
        if label.lower() in ('total', 'totals'):
            totals_row[race] = vals
            continue
        races[race].append((label, vals))

    places = {r['place']: r for r in csv.DictReader(open(a.places, encoding='utf-8'))}
    t_at = cols.index('total') if 'total' in cols else None
    for race, rows in races.items():
        if not rows:
            sys.exit(f'{race}: no candidate rows were read')
        for label, vals in rows:
            if t_at is not None:
                s = sum(v for j, v in enumerate(vals) if j != t_at)
                if s != vals[t_at]:
                    sys.exit(f'{race} {label}: its places add up to {s}, its total is {vals[t_at]}')
        if race in totals_row:
            for j in range(len(cols)):
                s = sum(v[j] for _, v in rows)
                if s != totals_row[race][j]:
                    sys.exit(f'{race}: column {cols[j]} adds up to {s}, the Total row says {totals_row[race][j]}')
        print(f'{race}: {len(rows)} candidates, every one adds up'
              + (' and every column matches the Total row' if race in totals_row else ''))

    # One row per column that is not the total.
    ids, out_places, at = [], [], {}
    for j, c in enumerate(cols):
        if c == 'total':
            ids.append(None)
            continue
        if c in ('mail', 'special', 'advance'):
            ids.append(f'MBV{j + 1} - {"Mail ballots" if c == "mail" else "Special voting" if c == "special" else "Advance voting (no place given)"}')
            continue
        adv = c.startswith('adv:')
        key = c[4:] if adv else c
        if key not in places:
            sys.exit(f'No address for "{key}" in {a.places}')
        p = places[key]
        if p['address'] not in at:
            at[p['address']] = geocode(p['address'])
        lon, lat = at[p['address']]
        code = f'P{j + 1:02d}'
        ids.append(f'{code} - {p["name"]}')
        out_places.append([code, p['name'] + (' (advance)' if adv else ''), p['address'],
                           'Yes' if adv else 'No', f'{lat:.6f}, {lon:.6f}'])

    mayor = races['Mayor']
    cast = ballots or [sum(v[j] for _, v in mayor) for j in range(len(cols))]
    slates = L.get('slates', {})
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        for race, rows in races.items():
            heads = []
            for label, _ in rows:
                m = re.match(r'^(.*?)\s*\(([^)]+)\)\s*$', label)
                raw, slate = (m.group(1), m.group(2)) if m else (label, '')
                name = L.get('names', {}).get(raw, person(raw))
                slate = slate or slates.get(name, '')
                group = (f'{name} – {slate}' if race == 'Mayor' else slate) if slate else name
                parts = name.split()
                heads.append(f'{parts[-1].upper()}, {" ".join(parts[:-1])} ({group})')
            o = io.StringIO()
            w = csv.writer(o)
            w.writerow([f'{L["year"]} {race.upper()} Results by Location (Vote for {L["seats"][race]})'])
            w.writerow(['Voting Place ID', 'Times Cast'] + heads)
            for j, pid in enumerate(ids):
                if pid is None:
                    continue
                w.writerow([pid, cast[j]] + [v[j] for _, v in rows])
            z.writestr(f'{L["year"]}{L["stem"]}Results_{SHEET[race]}.csv', o.getvalue())
    open(a.out_results, 'wb').write(buf.getvalue())
    with open(a.out_places, 'w', newline='', encoding='utf-8') as fh:
        w = csv.writer(fh)
        w.writerow(['Voting Place ID', 'Facility Name', 'Facility Address', 'Advance Only', 'geo_point_2d'])
        w.writerows(out_places)
    print(f'{a.out_places}: {len(out_places)} places ({sum(1 for p in out_places if p[3] == "Yes")} advance); '
          f'Times Cast is {"the ballots row" if ballots else "the mayoral votes"}')


if __name__ == '__main__':
    main()
