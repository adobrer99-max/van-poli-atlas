"""Turn Richmond's published results PDFs into race sheets the atlas reads.

    python3 tools/richmond/results.py \
        --results 2026_Election_Results_Poll_by_Poll_Candidate.pdf \
        --ballots 2026_Election_Results_Total_Ballots_Cast_per_voting_opportunity.pdf \
        --slates tools/richmond/slates-2026.csv --year 2026 \
        --out richmond-2026-results.zip

The City of Richmond publishes its results by voting place only as PDFs: one
wide table, candidates down the side and voting places across the top, with the
column headings set sideways. pdfplumber reads the table; the headings come out
with each line reversed, which is undone here. Each place is keyed by its code
-- RC01, RE11, RS04, ADV 3, and MBV for mail and mobile voting -- and named
from the ballots-cast PDF, whose names are not mangled.

The output is one CSV per race in the shape the City of Vancouver uses, so the
atlas's existing reader takes it unchanged:

    2026 MAYOR Results by Location (Vote for 1)
    Voting Place ID,Times Cast,"HOWARD, Rob (Rob Howard - Richmond Forward)",...
    RC01 - Spul'u'kwuks Elementary School,1419,...

The bracket is what the atlas groups by. For mayor it is the candidate, with
the elector organization beside the name, because a mayoral race is read by
person. For council and school trustee it is the elector organization, since
with eight or seven seats the slate total is the figure that means anything; an
independent is their own group. The slate lists are the City's declarations of
candidates (2026) and, for 2022, VoteMate's candidate list, kept beside this
script.

Two elector organizations appear under different spellings in the two years'
lists: the Richmond Independent Team of Electors (RITE Richmond) and the
Richmond Citizens' Association ("Richmond Citizens (RCA)" on the 2026 ballot).
They are one organization each, so the slate lists spell each one the same way
in both years -- RITE Richmond, and Richmond Citizens Association, without
brackets, because the atlas reads the group from the bracket -- and the swing
map can compare them. Nothing else is equated.

Every candidate row is checked against its own total before anything is
written: the voting-place columns must add up to the Total Votes column."""
import argparse, csv, io, re, subprocess, sys, unicodedata, zipfile

try:
    import pdfplumber
except ImportError:
    sys.exit('pip install pdfplumber')

SEATS = {'MAYOR': 1, 'COUNCILLOR': 8, 'SCHOOL TRUSTEE': 7}
SHEET = {'MAYOR': 'Mayor', 'COUNCILLOR': 'Councillor', 'SCHOOL TRUSTEE': 'SchoolTrustee'}
OFFICE = {'Mayor': 'MAYOR', 'Councillor': 'COUNCILLOR', 'School Trustee': 'SCHOOL TRUSTEE'}
CODE = re.compile(r'\b(ADV|RC|RE|RS)(?![A-Za-z])\D{0,12}?(\d{1,2})\b')


def code_of(text):
    t = text or ''
    if re.search(r'mail|mobile|\bMBV\b', t, re.I):
        return 'MBV'
    m = CODE.search(t)
    if not m:
        return None
    k, n = m.group(1).upper(), int(m.group(2))
    return f'ADV {n}' if k == 'ADV' else f'{k}{n:02d}'


def unrotate(s):
    """A sideways heading arrives with its lines in reverse order and each line
    spelled backwards."""
    if not s:
        return ''
    return ' '.join(line[::-1] for line in reversed(s.split('\n')))


def key(name):
    s = unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode().lower()
    s = re.sub(r"[\"'“”.]|the cat guy", ' ', s)
    return frozenset(w for w in re.split(r'[^a-z]+', s) if len(w) > 1)


def read_slates(path):
    out = {}
    with open(path, encoding='utf-8') as fh:
        for r in csv.DictReader(fh):
            out[(OFFICE[r['office']], key(r['candidate']))] = (r['candidate'], r['elector_organization'].strip())
    return out


def read_ballots(path):
    text = subprocess.run(['pdftotext', '-layout', path, '-'], capture_output=True, text=True).stdout
    names, ballots, pending = {}, {}, None
    for line in text.splitlines():
        m = re.match(r'^\s*(ADV\s*\d+|R[CES]\s*\d+|MBV)\s{2,}(.*?)(?:\s{2,}([\d,]+))?\s*$', line)
        if m:
            code = code_of(m.group(1))
            names[code] = re.sub(r'\s+', ' ', m.group(2)).strip()
            if m.group(3):
                ballots[code] = int(m.group(3).replace(',', ''))
                pending = None
            else:
                pending = code
            continue
        n = re.match(r'^\s*([\d,]+)\s*$', line)
        if n and pending:
            ballots[pending] = int(n.group(1).replace(',', ''))
            pending = None
    return names, ballots


def read_results(path):
    """The one page that carries every voting place; checked, not assumed."""
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            tables = page.extract_tables()
            if not tables:
                continue
            header = [unrotate(h) for h in tables[0][0]]
            codes = [code_of(h) for h in header[2:]]
            if None in codes:
                continue
            rows, office = [], None
            for t in tables:
                for r in t:
                    if r[0] and 'etadidnaC' in r[0]:
                        continue
                    label = re.sub(r'\s+', ' ', (r[0] or '')).strip()
                    if not (r[1] or '').strip():
                        office = label.upper()
                        continue
                    votes = [int((c or '0').replace(',', '') or 0) for c in r[1:]]
                    if sum(votes[1:]) != votes[0]:
                        sys.exit(f'{label}: places add to {sum(votes[1:])}, total says {votes[0]}')
                    rows.append((office, label, votes[0], dict(zip(codes, votes[1:]))))
            return codes, rows
    sys.exit('No page of that PDF carries the whole table of voting places.')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--results', required=True)
    ap.add_argument('--ballots', required=True)
    ap.add_argument('--slates', required=True)
    ap.add_argument('--year', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()

    names, ballots = read_ballots(a.ballots)
    codes, rows = read_results(a.results)
    slates = read_slates(a.slates)
    missing = [c for c in codes if c not in names]
    if missing:
        sys.exit(f'No name for {missing} in the ballots PDF')

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as z:
        for office in SEATS:
            cands = [r for r in rows if r[0] == office]
            if not cands:
                continue
            heads = []
            for _, label, total, _ in cands:
                hit = slates.get((office, key(label)))
                if not hit:
                    # One letter off ("STARRET" in the 2022 results, "STARRETT"
                    # on the list): the closest name for the same office, if it
                    # is very close.
                    import difflib
                    flat = ' '.join(sorted(key(label)))
                    best = max(((difflib.SequenceMatcher(None, flat, ' '.join(sorted(k))).ratio(), v)
                                for (o, k), v in slates.items() if o == office),
                               default=(0, None), key=lambda t: t[0])
                    if best[0] >= 0.9:
                        print(f'  {label}: matched to {best[1][0]} on the slate list')
                        hit = best[1]
                if not hit:
                    sys.exit(f'{label} ({office}) is not in {a.slates}')
                declared, slate = hit
                parts = label.split()
                surname_first = f'{parts[-1].upper()}, {" ".join(parts[:-1])}'
                # The ballot's nickname ("The Cat Guy") is dropped from the
                # group label: the atlas title-cases labels, and a quoted
                # phrase does not survive that.
                person = re.sub(r"\s*(''|\")[^'\"]*(''|\")\s*", ' ', label).strip()
                if office == 'MAYOR':
                    group = f'{person} – {slate}' if slate else person
                else:
                    group = slate or person
                heads.append(f'{surname_first} ({group})')
            out = io.StringIO()
            w = csv.writer(out)
            w.writerow([f'{a.year} {office} Results by Location (Vote for {SEATS[office]})'])
            w.writerow(['Voting Place ID', 'Times Cast'] + heads)
            for c in codes:
                w.writerow([f'{c} - {names[c]}', ballots.get(c, '')]
                           + [r[3][c] for r in cands])
            z.writestr(f'{a.year}RichmondResults_{SHEET[office]}.csv', out.getvalue())
            print(f'{office}: {len(cands)} candidates, {sum(r[2] for r in cands):,} votes, '
                  f'{len(codes)} places')
    with open(a.out, 'wb') as fh:
        fh.write(buf.getvalue())
    print(f'{a.out}: ballots {sum(ballots.values()):,} across {len(ballots)} places')


if __name__ == '__main__':
    main()
