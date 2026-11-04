"""Turn Surrey's published results into the race sheets and voting places the
atlas reads, in the shape the City of Vancouver uses.

    python3 tools/surrey/results.py \
        --results electionresultspercandidate.html \
        --turnout Voter-Turnout-by-Poll.pdf \
        --locations where-vote.html \
        --year 2026 --out-results surrey-2026-results.zip \
        --out-places surrey-voting-places-2026.csv

Surrey votes anywhere, as Vancouver does: any elector may vote at any of the
city's locations, so the atlas smooths each place's ballots over the areas
around it rather than assigning them.

Inputs, all from the City of Surrey:
  --results    the "Votes for Candidate per Poll" page of the results site
               (electionresults.surrey.ca/electionresultspercandidate.html):
               one table per race, a row per poll (GV01..., ADV80..., Mail
               Ballot) and a Total row.
  --turnout    Voter-Turnout-by-Poll.pdf, the ballots cast at each poll, which
               becomes the Times Cast column.
  --locations  the "Where to vote" page, which gives each location's address.
               Addresses are geocoded with the City's own public geocoder; the
               few it cannot place come from the City's schools layer.

A location with two polls (GV03A, GV03B: two gyms) is one point carrying two
rows. Advance polls are named "(advance)" so the atlas never mistakes the
election-day poll in the same building for an advance one.

Mayor is read by candidate, council and school trustee by elector
organization; an independent is their own group, as for Richmond. Every
candidate's polls are checked against the Total row before anything is
written."""
import argparse, csv, difflib, html, io, json, re, subprocess, sys, urllib.parse, urllib.request, zipfile

GEOCODER = ('https://gisservices.surrey.ca/arcgis/rest/services/Composite_Geocoder/'
            'GeocodeServer/findAddressCandidates')
SCHOOLS = 'https://gisservices.surrey.ca/arcgis/rest/services/OpenData/MapServer/156/query'
SHEET = {'MAYOR': 'Mayor', 'COUNCILLOR': 'Councillor', 'SCHOOL TRUSTEE': 'SchoolTrustee'}


def clean(c):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', c))).strip()


def num(s):
    s = s.replace(',', '').strip()
    return int(s) if s.isdigit() else 0


def key(name):
    s = re.sub(r'\(.*?\)', ' ', name.lower())
    s = re.sub(r'\b(school|ecole|école|the)\b', ' ', s)
    return ' '.join(re.findall(r'[a-z0-9]+', s))


def read_races(path):
    s = open(path, encoding='utf-8').read()
    parts = re.split(r'(<table class="stattable".*?</table>)', s, flags=re.S)
    races = []
    for k, p in enumerate(parts):
        if not p.startswith('<table'):
            continue
        m = re.search(r'(Mayor|Councillor|School Trustee)\s*\(Vote for (\d+)\)\s*$', clean(parts[k - 1]))
        if not m:
            continue
        rows = [[clean(c) for c in re.findall(r'<t[dh][^>]*>(.*?)</t[dh]>', r, flags=re.S)]
                for r in re.findall(r'<tr[^>]*>(.*?)</tr>', p, flags=re.S)]
        header, body = rows[0], rows[1:]
        total = next(r for r in body if r[0].lower() == 'total')
        polls = [r for r in body if r[0].lower() != 'total']
        for i, cand in enumerate(header[1:], 1):
            got = sum(num(r[i]) for r in polls)
            if got != num(total[i]):
                sys.exit(f'{m.group(1)} {cand}: polls add to {got}, Total says {total[i]}')
        races.append({'office': m.group(1).upper(), 'seats': int(m.group(2)),
                      'candidates': header[1:], 'polls': polls, 'total': total})
    if not races:
        sys.exit('No race tables found in ' + path)
    return races


def read_turnout(path):
    text = subprocess.run(['pdftotext', '-layout', path, '-'], capture_output=True, text=True).stdout
    out = {}
    for line in text.splitlines():
        m = re.match(r'^\s*((?:GV|ADV)\d+[A-Z]?|Mail Ballot)\b.*?(\d[\d,]*)\s*(?:ADV=|GV=|$)', line)
        if m:
            out[m.group(1)] = int(m.group(2).replace(',', ''))
    return out


def read_locations(path):
    s = open(path, encoding='utf-8').read()
    t = re.sub(r'<script.*?</script>|<style.*?</style>', '', s, flags=re.S)
    lines = [l.strip() for l in html.unescape(re.sub(r'<[^>]+>', '\n', t)).split('\n') if l.strip()]
    locs, buf, started = [], '', False
    for l in lines:
        if not started:
            started = bool(re.search(r'Locations listed below', l))
            continue
        if re.match(r'^(Advance voting|Accessib|Vote by mail|Mail ballot)', l, re.I):
            break
        buf = (buf + ' ' + l).strip()
        m = re.match(r'^(.*?)\s*(\(advance voting location\))?\s*:\s*(.+)$', buf)
        if m:
            locs.append({'name': m.group(1).strip(), 'addr': m.group(3).strip()})
            buf = ''
        elif not re.search(r'Elementary|Secondary|Centre|School|Hall|\(', buf):
            buf = ''          # a community heading
    return locs


def geocode(locs):
    for L in locs:
        u = GEOCODER + '?' + urllib.parse.urlencode(
            {'SingleLine': L['addr'], 'outSR': 4326, 'maxLocations': 1, 'f': 'json'})
        c = json.load(urllib.request.urlopen(u, timeout=60)).get('candidates') or []
        if c and c[0]['score'] >= 90:
            L['lon'], L['lat'] = c[0]['location']['x'], c[0]['location']['y']
            continue
        word = L['name'].split()[0].upper().replace("'", "''")
        u = SCHOOLS + '?' + urllib.parse.urlencode(
            {'where': f"UPPER(NAME) LIKE '%{word}%'", 'outFields': 'NAME', 'returnGeometry': 'true',
             'outSR': 4326, 'f': 'json'})
        feats = json.load(urllib.request.urlopen(u, timeout=60)).get('features') or []
        if not feats:
            sys.exit(f'Could not place {L["name"]} ({L["addr"]})')
        ring = feats[0]['geometry']['rings'][0]
        L['lon'] = sum(p[0] for p in ring) / len(ring)
        L['lat'] = sum(p[1] for p in ring) / len(ring)
        print(f'  {L["name"]}: placed from the schools layer ({feats[0]["attributes"]["NAME"]})')
    return locs


def place_of(poll_name, locs):
    k = key(poll_name)
    best = max(locs, key=lambda L: difflib.SequenceMatcher(None, k, key(L['name'])).ratio()
               + (0.5 if k.startswith(key(L['name'])) else 0))
    if difflib.SequenceMatcher(None, k, key(best['name'])).ratio() < 0.6 and not k.startswith(key(best['name'])):
        sys.exit(f'No voting location matches poll "{poll_name}"')
    return best


def proper(surname):
    """AMMONS II -> Ammons II, McCALLUM -> McCallum, VAN VLIET -> Van Vliet."""
    out = []
    for w in surname.split():
        if w.upper() in ('II', 'III', 'IV'):
            out.append(w.upper())
        elif re.match(r'^ma?c[A-Z]', w, re.I) and len(w) > 3 and w[:2].lower() == 'mc':
            out.append('Mc' + w[2:].capitalize())
        else:
            out.append('-'.join(x.capitalize() for x in w.split('-')))
    return ' '.join(out)


def group(cand, office):
    m = re.match(r'^(.*?),\s*(.*?)(?:\s+-\s+(.*))?$', cand)
    surname, given, slate = m.group(1), m.group(2), (m.group(3) or '').strip()
    person = f'{given} {proper(surname)}'.strip()
    label = f'{person} – {slate}' if office == 'MAYOR' and slate else (slate or person)
    return f'{surname}, {given} ({label.replace("(", "").replace(")", "")})'


def main():
    ap = argparse.ArgumentParser()
    for f in ('results', 'turnout', 'locations', 'year', 'out-results', 'out-places'):
        ap.add_argument('--' + f, required=True)
    a = ap.parse_args()
    races = read_races(a.results)
    turnout = read_turnout(a.turnout)
    locs = geocode(read_locations(a.locations))
    print(f'{len(locs)} locations, {len(turnout)} polls with ballots cast')

    polls = [r[0] for r in races[0]['polls']]
    places = []
    for p in polls:
        m = re.match(r'^((?:GV|ADV)\d+[A-Z]?)\s+(.*)$', p)
        if not m:
            continue                                   # Mail Ballot: no place
        code, name = m.groups()
        L = place_of(name, locs)
        adv = code.startswith('ADV')
        places.append([code, name + (' (advance)' if adv else ''), L['addr'], 'Yes' if adv else 'No',
                       f'{L["lat"]:.6f}, {L["lon"]:.6f}'])
    with open(a.out_places, 'w', newline='', encoding='utf-8') as fh:
        w = csv.writer(fh)
        w.writerow(['Voting Place ID', 'Facility Name', 'Facility Address', 'Advance Only', 'geo_point_2d'])
        w.writerows(places)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        for r in races:
            out = io.StringIO()
            w = csv.writer(out)
            w.writerow([f'{a.year} {r["office"]} Results by Location (Vote for {r["seats"]})'])
            w.writerow(['Voting Place ID', 'Times Cast'] + [group(c, r['office']) for c in r['candidates']])
            for row in r['polls']:
                m = re.match(r'^((?:GV|ADV)\d+[A-Z]?)\s+(.*)$', row[0])
                pid = f'{m.group(1)} - {m.group(2)}' if m else 'MBV - Mail Ballot'
                cast = turnout.get(m.group(1) if m else 'Mail Ballot', '')
                w.writerow([pid, cast] + [num(x) for x in row[1:]])
            z.writestr(f'{a.year}SurreyResults_{SHEET[r["office"]]}.csv', out.getvalue())
            print(f'{r["office"]}: {len(r["candidates"])} candidates, {len(r["polls"])} polls')
    open(a.out_results, 'wb').write(buf.getvalue())
    print(f'{a.out_places}: {len(places)} polls; {a.out_results}: ballots {sum(turnout.values()):,}')


if __name__ == '__main__':
    main()
