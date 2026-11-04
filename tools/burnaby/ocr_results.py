"""Read Burnaby's results by voting machine out of the council attachment.

    python3 tools/burnaby/ocr_results.py \
        --pdf "Attachment 1 - Voting Participation and Detailed Results.pdf" \
        --totals arearesults.json --out burnaby-2026-machines.json

The City of Burnaby publishes votes per voting machine (tabulator) only in this
PDF, and its text layer is unusable: the fonts carry no character map, so every
extractor returns noise. The pages are therefore read as pictures, with
tesseract:

  1. Each page is rendered at 300 dpi and binarised, which removes the shaded
     row backgrounds that otherwise turn 5s into 9s.
  2. A first pass finds the words and where they are: the section titles say
     which race a table belongs to, the header row names the candidates, and
     every line with a number in each candidate column is a machine.
  3. Every number cell is then read again on its own, enlarged, with only
     digits allowed.
  4. Each candidate's machines must add up to the total the city publishes on
     its results site (arearesults.json). Where a column is off, its cells are
     re-read at other thresholds and scales, and the combination that makes the
     column add up is kept. A column that still does not add up stops the run:
     nothing is written that disagrees with the city's own totals.

Needs pdftoppm (poppler) and tesseract on the PATH, and Pillow."""
import argparse, difflib, itertools, json, os, re, subprocess, sys, tempfile
from collections import defaultdict
from PIL import Image, ImageOps

RACES = {'mayor': 'Mayor', 'councillor': 'Councillor', 'school trustee': 'School Trustee'}


def tsv(img, psm=6, extra=()):
    out = subprocess.run(['tesseract', img, '-', '--psm', str(psm), *extra, 'tsv'],
                         capture_output=True, text=True).stdout.splitlines()
    head = out[0].split('\t')
    rows = []
    for line in out[1:]:
        f = line.split('\t')
        if len(f) < len(head) or not f[-1].strip():
            continue
        d = dict(zip(head, f))
        for k in ('left', 'top', 'width', 'height', 'block_num', 'par_num', 'line_num'):
            d[k] = int(d[k])
        rows.append(d)
    return rows


CACHE = {}


def read_cell(page, box, threshold=150, scale=3):
    k = f'{getattr(page, "filename", "")}|{box}|{threshold}|{scale}'
    if k in CACHE:
        return CACHE[k]
    CACHE[k] = v = _read_cell(page, box, threshold, scale)
    return v


def _read_cell(page, box, threshold=150, scale=3):
    x0, y0, x1, y1 = box
    crop = page.crop((x0, y0, x1, y1)).convert('L')
    crop = crop.point(lambda v: 0 if v < threshold else 255)
    crop = ImageOps.expand(crop.resize((crop.width * scale, crop.height * scale)), 20, fill=255)
    with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as fh:
        crop.save(fh.name)
        txt = subprocess.run(['tesseract', fh.name, '-', '--psm', '7', '-c',
                              'tessedit_char_whitelist=0123456789'], capture_output=True, text=True).stdout
        os.unlink(fh.name)
    d = re.sub(r'\D', '', txt)
    return int(d) if d else None


def lines_of(words):
    """Group words into visual lines by their vertical centre."""
    words = sorted(words, key=lambda w: (w['top'] + w['height'] / 2, w['left']))
    lines, cur, cy = [], [], None
    for w in words:
        c = w['top'] + w['height'] / 2
        if cur and abs(c - cy) > 18:
            lines.append(cur); cur = []
        cur.append(w); cy = c if len(cur) == 1 else (cy * (len(cur) - 1) + c) / len(cur)
    if cur:
        lines.append(cur)
    return [sorted(l, key=lambda w: w['left']) for l in lines]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pdf', required=True)
    ap.add_argument('--totals', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--work', default=None)
    a = ap.parse_args()

    totals = {}
    official = json.load(open(a.totals))['areaResults'][0]['1']['contestResults']
    for c in official:
        totals[c['contestName']] = {x['choiceName']: x['votes'] for x in c['choiceResults']}
    machines_expected = None

    work = a.work or tempfile.mkdtemp()
    os.makedirs(work, exist_ok=True)
    if not any(f.startswith('p-') for f in os.listdir(work)):
        subprocess.run(['pdftoppm', '-r', '300', '-png', a.pdf, os.path.join(work, 'p')], check=True)
    pages = sorted(f for f in os.listdir(work) if re.match(r'p-\d+\.png$', f))

    cache_at = os.path.join(work, 'cells.json')
    if os.path.exists(cache_at):
        CACHE.update(json.load(open(cache_at)))
    race = None
    pending = None
    result = defaultdict(lambda: defaultdict(dict))   # race -> candidate -> machine -> cell
    labels = {}
    pagecache = {}
    for name in pages:
        path = os.path.join(work, name)
        page = pagecache.setdefault(name, Image.open(path))
        bw = path.replace('.png', '-bw.png')
        if not os.path.exists(bw):
            page.convert('L').point(lambda v: 0 if v < 150 else 255).save(bw)
        lines = lines_of(tsv(bw))
        texts = [' '.join(w['text'] for w in l) for l in lines]
        table = None           # {'race', 'centres', 'names'}
        i = 0
        while i < len(lines):
            two = texts[i] + ' ' + (texts[i + 1] if i + 1 < len(lines) else '')
            m = re.search(r'(Mayor|Councillor|School\s+Trustee)\s+Votes\s+by\s+Voting', two, re.I)
            if m and re.search(r'Votes\s+by', texts[i]):
                race = RACES[re.sub(r'\s+', ' ', m.group(1)).lower()]
                table = None
                i += 1
                continue
            if re.search(r'^\W*Voting\W+Machine\b', texts[i]) and race:
                # The header: this line's words right of the label column, and a
                # second line of header words just below it (two-line names).
                hw = [w for w in lines[i] if w['left'] > 600]
                if i + 1 < len(lines) and not any(re.search(r'\d', w['text']) for w in lines[i + 1]) \
                        and all(w['left'] > 600 for w in lines[i + 1]):
                    hw += lines[i + 1]
                    i += 1
                hw.sort(key=lambda w: w['left'])
                groups = []
                for w in sorted(hw, key=lambda w: w['left']):
                    c = w['left'] + w['width'] / 2
                    for g in groups:
                        if abs(g['c'] - c) < 150 or (w['left'] <= g['r'] + 40 and w['left'] >= g['l'] - 40):
                            g['words'].append(w); g['l'] = min(g['l'], w['left'])
                            g['r'] = max(g['r'], w['left'] + w['width']); g['c'] = (g['l'] + g['r']) / 2
                            break
                    else:
                        groups.append({'words': [w], 'l': w['left'], 'r': w['left'] + w['width'], 'c': c})
                groups.sort(key=lambda g: g['c'])
                known = list(totals[race])
                names = []
                for g in groups:
                    raw = ' '.join(w['text'] for w in sorted(g['words'], key=lambda w: (w['top'], w['left'])))
                    flat = re.sub(r'[^a-z]', '', raw.lower())
                    best = max(known, key=lambda k: difflib.SequenceMatcher(
                        None, flat, re.sub(r'[^a-z]', '', k.lower())).ratio())
                    names.append(best)
                table = {'race': race, 'centres': [g['c'] for g in groups], 'names': names}
                print(f'{name} {race}: {names}')
                pending = None
                i += 1
                continue
            if table:
                nums = [w for w in lines[i] if re.fullmatch(r'[\dOoSsIl|$vV]{1,5}', w['text']) and w['left'] > 600]
                lab = [w for w in lines[i] if w['left'] < 600]
                labtext = ' '.join(w['text'] for w in lab)
                lm = re.match(r'^(\d{1,2})\s*[-–]', labtext) or re.match(r'^(\d{1,2})\b', labtext)
                if lm and not nums:
                    pending = {'machine': int(lm.group(1)), 'label': labtext}
                elif len(nums) >= max(2, len(table['centres']) - 1):
                    machine = int(lm.group(1)) if lm else (pending['machine'] if pending else None)
                    label = labtext if lm else ((pending['label'] + ' ' + labtext) if pending else labtext)
                    if machine is None:
                        print(f'  {name}: a row with no machine number: {texts[i]}')
                    else:
                        labels.setdefault(machine, label)
                        for w in nums:
                            cx = w['left'] + w['width'] / 2
                            k = min(range(len(table['centres'])), key=lambda j: abs(table['centres'][j] - cx))
                            box = (w['left'] - 12, w['top'] - 10, w['left'] + w['width'] + 12, w['top'] + w['height'] + 10)
                            result[table['race']][table['names'][k]][machine] = {
                                'v': read_cell(page, box), 'box': box, 'page': name}
                        last = machine
                    pending = None
                elif lab and not re.search(r'Votes|Voting|Page|Council|Candidate', labtext) and 'last' in dir():
                    if last in labels and len(labels[last]) < 120:
                        labels[last] += ' ' + labtext
            i += 1

    machines_expected = max((len(c) for cands in result.values() for c in cands.values()), default=None)
    # Reconcile with the official totals.
    problems = []
    for race, cands in result.items():
        for cand, cells in cands.items():
            want = totals[race][cand]
            got = sum(c['v'] or 0 for c in cells.values())
            if got == want and all(c['v'] is not None for c in cells.values()) \
                    and (machines_expected is None or len(cells) == machines_expected):
                continue
            # re-read every cell several ways, then search for the combination that adds up
            alts = {}
            for m, c in cells.items():
                page = pagecache.setdefault(c['page'], Image.open(os.path.join(work, c['page'])))
                opts = {c['v']}
                for th, sc in ((120, 3), (180, 3), (150, 4), (150, 2), (100, 4)):
                    opts.add(read_cell(page, c['box'], th, sc))
                alts[m] = sorted(o for o in opts if o is not None) or [0]
            uncertain = [m for m in alts if len(alts[m]) > 1]
            base = {m: (alts[m][0] if len(alts[m]) == 1 else None) for m in alts}
            fixed = None
            if len(uncertain) <= 8:
                for combo in itertools.product(*(alts[m] for m in uncertain)):
                    s = sum(v for v in base.values() if v is not None) + sum(combo)
                    if s == want:
                        fixed = dict(zip(uncertain, combo)); break
            if fixed is not None:
                for m, v in fixed.items():
                    cells[m]['v'] = v
                print(f'  {race} {cand}: reconciled ({len(uncertain)} uncertain cells)')
            else:
                problems.append((race, cand, want, got, len(cells), {m: alts[m] for m in uncertain}))
    json.dump(CACHE, open(cache_at, 'w'))
    out = {'machines': labels,
           'races': {race: {cand: {str(m): c['v'] for m, c in sorted(cells.items())}
                            for cand, cells in cands.items()} for race, cands in result.items()},
           'problems': [{'race': p[0], 'candidate': p[1], 'official': p[2], 'read': p[3],
                         'machines': p[4], 'uncertain': {str(k): v for k, v in p[5].items()}} for p in problems]}
    json.dump(out, open(a.out, 'w'), indent=1)
    for race in totals:
        missing = set(totals[race]) - set(result.get(race, {}))
        if missing:
            print(f'  {race}: no column found for {sorted(missing)}')
    print(f'{a.out}: {sum(len(c) for c in result.values())} candidate columns, '
          f'{len(labels)} machines, {len(problems)} not reconciled')


if __name__ == '__main__':
    main()
