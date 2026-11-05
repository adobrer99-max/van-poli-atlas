"""Cut Elections BC's 2024 results down to one city, in the shape the atlas reads.

    python3 tools/prov_results.py --city "City of Richmond" \
        --results provincial_voting_results_by_voting_place.csv \
        --places voting_places.json --vas-per-muni vaspermuni_20240919.csv \
        --sov statement-of-votes.txt --out-dir payload-src/

Writes two files into --out-dir:

  prov-results/provincial_2024_voting_places_<city>.csv
      one row per voting place and voting opportunity, for every electoral
      district with a voting area in the city: valid, rejected and total
      ballots, a column of votes per party, and the place's longitude and
      latitude where it has one. The same columns as the Vancouver file the
      atlas has always read.
  prov-electors/provincial_2024_registered_voters_<city>.csv
      registered voters per district, the denominator for turnout.

Inputs, all from Elections BC through the BC Data Catalogue:

  --results       "Provincial Voting Results", provincial_voting_results_by_
                  voting_place.csv: a row per candidate per voting place.
  --places        "Provincial Voting Places" (WHSE_HUMAN_CULTURAL_ECONOMIC.
                  EBC_VOTING_PLACES_SP) as GeoJSON in lon/lat, from
                  openmaps.gov.bc.ca/geo/pub/wfs ... &srsName=EPSG:4326.
                  Places are matched by ADDRESS_STANDARD_ID, the 2024 entry
                  first.
  --vas-per-muni  "Electoral district voting area to municipal boundary
                  conversion table", the 2024 one: which districts reach the
                  city.
  --sov           the 2024 Statement of Votes as text (pdftotext -layout),
                  whose summary table gives registered voters per district.

A district that crosses the city line (Richmond-Queensborough takes in
Queensborough, in New Westminster) is kept whole: its results are reported
for the whole district, and its voting places outside the city are kept too,
because their ballots are spread over that district's voting areas.

Where a place cannot be located, or the ballots have no place (mail, special
and telephone voting, out-of-district), geocode_ready is "no" and the atlas
spreads those ballots over the district. Standard library only."""
import argparse, collections, csv, json, os, re

NO_PLACE = re.compile(r'out-of-district|mail|special|telephone', re.I)


def slug(s):
    return re.sub(r'[^a-z0-9]+', '_', s.lower()).strip('_')


def main():
    ap = argparse.ArgumentParser()
    for f in ('city', 'results', 'places', 'vas-per-muni', 'sov', 'out-dir'):
        ap.add_argument('--' + f, required=True)
    ap.add_argument('--year', default='2024')
    a = ap.parse_args()

    vas = list(csv.DictReader(open(a.vas_per_muni, encoding='utf-8-sig')))
    eds = sorted({r['Electoral District Code'] for r in vas if r['Legal Name'] == a.city})
    if not eds:
        raise SystemExit(f'No voting area is in "{a.city}" (the table names cities as "City of Richmond").')
    names = {r['Electoral District Code']: r['Electoral District Name'] for r in vas}

    loc = {}
    for f in json.load(open(a.places))['features']:
        p = f['properties']
        sid = str(p.get('ADDRESS_STANDARD_ID') or '')
        if not sid or not f.get('geometry'):
            continue
        rank = 0 if str(p.get('EVENT_NAME', '')).startswith(a.year) else 1
        if sid not in loc or rank < loc[sid][0]:
            x, y = f['geometry']['coordinates'][:2]
            loc[sid] = (rank, x, y, p.get('STREET_ADDRESS') or '', p.get('BUILDING_NAME') or '')

    rows = collections.OrderedDict()
    parties = []
    for r in csv.DictReader(open(a.results, encoding='utf-8-sig')):
        if r['EVENT_YEAR'] != a.year or 'General Election' not in r['EVENT_NAME'] or r['ED_ABBREVIATION'] not in eds:
            continue
        k = (r['ED_ABBREVIATION'], r['ADDRESS_STANDARD_ID'], r['VOTING_LOCATION'], r['VOTING_OPPORTUNITY'])
        row = rows.setdefault(k, collections.Counter())
        n = int(r['VOTES_CONSIDERED'] or 0)
        if r['VOTE_CATEGORY'] == 'Rejected':
            row['rejected_ballots'] += n
        else:
            col = slug(r['AFFILIATION'] or 'Independent') + '_votes'
            if col not in parties:
                parties.append(col)
            row[col] += n
            row['valid_votes'] += n

    head = ['event_year', 'electoral_district_abbreviation', 'electoral_district_name', 'address_standard_id',
            'voting_location', 'voting_opportunity', 'geocode_ready', 'valid_votes', 'rejected_ballots',
            'total_ballots'] + parties + ['longitude', 'latitude', 'street_address', 'building_name', 'geocode_source']
    stem = slug(re.sub(r'^City of ', '', a.city))
    out = os.path.join(a.out_dir, 'prov-results', f'provincial_{a.year}_voting_places_{stem}.csv')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    placed = unplaced = 0
    with open(out, 'w', newline='', encoding='utf-8') as fh:
        w = csv.writer(fh)
        w.writerow(head)
        for (ed, sid, where, opp), c in rows.items():
            at = loc.get(sid) if sid and not NO_PLACE.search(opp) else None
            total = c['valid_votes'] + c['rejected_ballots']
            if at:
                placed += total
            else:
                unplaced += total
            w.writerow([a.year, ed, names[ed], sid, where, opp, 'yes' if at else 'no', c['valid_votes'],
                        c['rejected_ballots'], total] + [c[p] for p in parties]
                       + ([f'{at[1]:.6f}', f'{at[2]:.6f}', at[3], at[4], f'Elections BC Provincial Voting Places {a.year}']
                          if at else ['', '', '', '', '']))

    # Registered voters: the summary table's "Total registered" column, the
    # last plain number on a district's line, before its % who voted.
    reg = {}
    for line in open(a.sov, encoding='utf-8'):
        for ed in eds:
            n = names[ed]
            m = re.match(r'\s*' + re.escape(n) + r'\s{2,}(.*)$', line)
            if m:
                nums = re.findall(r'[\d,]+(?:\.\d+)?%?', m.group(1))
                vals = [x for x in nums if not x.endswith('%')]
                # the summary row: party votes, valid, rejected, voted,
                # registered and a percentage (a contents line has one number)
                if len(vals) >= 5 and nums[-1].endswith('%'):
                    reg.setdefault(ed, int(vals[-1].replace(',', '')))
    missing = [names[e] for e in eds if e not in reg]
    if missing:
        raise SystemExit(f'No registered-voter count found in {a.sov} for: {", ".join(missing)}')
    out2 = os.path.join(a.out_dir, 'prov-electors', f'provincial_{a.year}_registered_voters_{stem}.csv')
    os.makedirs(os.path.dirname(out2), exist_ok=True)
    with open(out2, 'w', newline='', encoding='utf-8') as fh:
        w = csv.writer(fh)
        w.writerow(['Electoral District', 'Registered Voters'])
        for ed in eds:
            w.writerow([names[ed], reg[ed]])

    print(f'{a.city}: {len(eds)} districts ({" ".join(eds)}), {len(rows)} rows, '
          f'{placed + unplaced:,} ballots, {placed / max(1, placed + unplaced):.0%} at a located place')
    print(f'  {out}\n  {out2}')


if __name__ == '__main__':
    main()
