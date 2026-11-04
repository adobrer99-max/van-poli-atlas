"""Read Burnaby's results by voting machine out of the council attachment.

    python3 tools/burnaby/ocr_results.py \
        --pdf "Attachment 1 - Voting Participation and Detailed Results.pdf" \
        --totals arearesults.json --out burnaby-2026-machines.json [--work dir]

The City of Burnaby publishes votes per voting machine (tabulator) only in this
PDF, and its text cannot be extracted: every page draws its text in a font
whose glyph codes stand for the wrong characters, differently on every page.
So the numbers are read from the page images, with tesseract, and checked.

What makes that safe is the layout, which is fixed. Each race is a run of
tables; each table takes the next six candidates in alphabetical order (the
order the city's results site lists them in) and gives all 57 voting machines,
in order, before the next table starts. So the candidate a number belongs to
is known from where it sits, not read from a header, and:

  1. Every page is rendered at 300 dpi and binarised (which removes the
     shaded row backgrounds that turn 5s into 9s), and every line carrying a
     number in the vote columns is a machine's row.
  2. Rows are dealt out in order: 57 to the first table, 57 to the next, ...
     A table that does not get exactly 57 rows with the right number of cells
     stops the run.
  3. Every cell is then read again on its own, enlarged, digits only.
  4. Every candidate's 57 machines must add up to the total the city publishes
     on its results site (arearesults.json). A column that is off is re-read at
     other thresholds and scales, and the combination of readings that makes it
     add up is taken; if none does, it is reported, and results.py refuses a
     file that has any.

Needs pdftoppm (poppler) and tesseract on the PATH, and Pillow."""
import argparse, collections, itertools, json, os, re, subprocess, tempfile
from PIL import Image, ImageOps

MACHINES = 57
GROUP = 6
NUMBER = re.compile(r'^[\dOoSsIl|$vVBg]{1,5}$')


def tsv(img):
    out = subprocess.run(['tesseract', img, '-', '--psm', '6', 'tsv'], capture_output=True, text=True).stdout
    lines = out.splitlines()
    head = lines[0].split('\t')
    words = []
    for line in lines[1:]:
        f = line.split('\t')
        if len(f) < len(head) or not f[-1].strip():
            continue
        d = dict(zip(head, f))
        for k in ('left', 'top', 'width', 'height'):
            d[k] = int(d[k])
        words.append(d)
    return words


def lines_of(words):
    words = sorted(words, key=lambda w: (w['top'] + w['height'] / 2, w['left']))
    out, cur, cy = [], [], None
    for w in words:
        c = w['top'] + w['height'] / 2
        if cur and abs(c - cy) > 18:
            out.append(cur); cur = []
        cur.append(w)
        cy = c if len(cur) == 1 else (cy * (len(cur) - 1) + c) / len(cur)
    if cur:
        out.append(cur)
    return [sorted(l, key=lambda w: w['left']) for l in out]


CACHE = {}


def read_cell(path, box, threshold=150, scale=3):
    k = f'{os.path.basename(path)}|{box}|{threshold}|{scale}'
    if k in CACHE:
        return CACHE[k]
    img = Image.open(path)
    crop = img.crop(box).convert('L').point(lambda v: 0 if v < threshold else 255)
    crop = ImageOps.expand(crop.resize((crop.width * scale, crop.height * scale)), 20, fill=255)
    with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as fh:
        crop.save(fh.name)
        txt = subprocess.run(['tesseract', fh.name, '-', '--psm', '7', '-c',
                              'tessedit_char_whitelist=0123456789'], capture_output=True, text=True).stdout
    os.unlink(fh.name)
    d = re.sub(r'\D', '', txt)
    CACHE[k] = int(d) if d else None
    return CACHE[k]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pdf', required=True)
    ap.add_argument('--totals', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--work', default=None)
    a = ap.parse_args()

    contests = json.load(open(a.totals))['areaResults'][0]['1']['contestResults']
    tables = []          # (race, [candidates]) in the order the PDF prints them
    for c in contests:
        names = [x['choiceName'] for x in c['choiceResults']]
        for i in range(0, len(names), GROUP):
            tables.append((c['contestName'], names[i:i + GROUP]))
    totals = {(c['contestName'], x['choiceName']): x['votes'] for c in contests for x in c['choiceResults']}

    work = a.work or tempfile.mkdtemp()
    os.makedirs(work, exist_ok=True)
    if not any(re.match(r'p-\d+\.png$', f) for f in os.listdir(work)):
        subprocess.run(['pdftoppm', '-r', '300', '-png', a.pdf, os.path.join(work, 'p')], check=True)
    cache_at = os.path.join(work, 'cells.json')
    if os.path.exists(cache_at):
        CACHE.update(json.load(open(cache_at)))
    pages = sorted(f for f in os.listdir(work) if re.match(r'p-\d+\.png$', f))

    # 1. every machine row, in reading order, with its cells' boxes
    rows = []
    started = False
    for name in pages:
        path = os.path.join(work, name)
        # The first pages are turnout tables; the results start on the page
        # headed RESULTS PER VOTING MACHINE.
        if not started:
            head = subprocess.run(['tesseract', path, '-', '--psm', '6'], capture_output=True,
                                  text=True).stdout if not os.path.exists(path + '.txt') else open(path + '.txt').read()
            open(path + '.txt', 'w').write(head)
            if not re.search(r'RESULTS\s+PER\s+VOTING\s+MACHINE', head, re.I):
                continue
            started = True
        bw = path.replace('.png', '-bw.png')
        if not os.path.exists(bw):
            Image.open(path).convert('L').point(lambda v: 0 if v < 150 else 255).save(bw)
        for l in lines_of(tsv(bw)):
            cells = [w for w in l if w['left'] > 600 and NUMBER.match(w['text'])]
            label = ' '.join(w['text'] for w in l if w['left'] < 600)
            # the running header at the top of every page carries a date; skip it
            if l[0]['top'] < 400:
                continue
            if len(cells) >= 3 and not re.search(r'Page|Votes|Total', label, re.I):
                rows.append({'page': path, 'cells': cells, 'label': label, 'y': l[0]['top']})
    need = sum(MACHINES for _ in tables)
    print(f'{len(rows)} machine rows found; {len(tables)} tables of {MACHINES} need {need}')

    # 2. deal the rows out to the tables
    result = collections.defaultdict(dict)       # (race, candidate) -> machine -> value
    boxes = collections.defaultdict(dict)
    labels = {}
    at = 0
    for race, cands in tables:
        block = rows[at:at + MACHINES]
        at += MACHINES
        bad = [i + 1 for i, r in enumerate(block) if len(r['cells']) != len(cands)]
        # a row short of a cell: the missing one is found by the table's column positions
        xs = collections.defaultdict(list)
        for r in block:
            if len(r['cells']) == len(cands):
                for j, w in enumerate(r['cells']):
                    xs[j].append(w['left'] + w['width'] / 2)
        centres = [sum(v) / len(v) for _, v in sorted(xs.items())]
        if len(block) != MACHINES or len(centres) != len(cands):
            raise SystemExit(f'{race} {cands[0]}...: {len(block)} rows, columns unclear; '
                             f'rows with the wrong number of cells: {bad[:10]}')
        for m, r in enumerate(block, 1):
            labels.setdefault(m, r['label'])
            byj = {}
            for w in r['cells']:
                j = min(range(len(centres)), key=lambda k: abs(centres[k] - (w['left'] + w['width'] / 2)))
                byj[j] = (w['left'] - 12, w['top'] - 10, w['left'] + w['width'] + 12, w['top'] + w['height'] + 10)
            ys = [b[1] for b in byj.values()]
            for j, cand in enumerate(cands):
                box = byj.get(j)
                if box is None:     # guess the cell from the column centre and the row's height
                    c = int(centres[j])
                    box = (c - 60, min(ys), c + 60, min(ys) + 60)
                boxes[(race, cand)][m] = (r['page'], box)
                result[(race, cand)][m] = read_cell(r['page'], box)
        if bad:
            print(f'  {race} from {cands[0]}: rows {bad} were short of a cell; read by column position')

    # 4. reconcile with the official totals
    problems = []
    for key, cells in result.items():
        want = totals[key]
        if sum(v or 0 for v in cells.values()) == want and None not in cells.values():
            continue
        alts = {}
        for m, (page, box) in boxes[key].items():
            opts = {result[key][m]}
            for th, sc in ((120, 3), (180, 3), (150, 4), (150, 2), (100, 4), (200, 3)):
                opts.add(read_cell(page, box, th, sc))
            alts[m] = sorted(o for o in opts if o is not None) or [0]
        sure = {m: v[0] for m, v in alts.items() if len(v) == 1}
        unsure = [m for m in alts if len(alts[m]) > 1]
        # Which readings of the uncertain cells make the column add up: a
        # subset-sum over the alternatives, by dynamic programming.
        fixed = None
        target = want - sum(sure.values())
        # Of the combinations that add up, the one that changes the fewest
        # cells from their first reading.
        reach = {0: (0, {})}
        for m in unsure:
            nxt = {}
            for tot, (cost, pick) in reach.items():
                for v in alts[m]:
                    t, c = tot + v, cost + (v != result[key][m])
                    if t <= target and (t not in nxt or c < nxt[t][0]):
                        nxt[t] = (c, {**pick, m: v})
            reach = nxt
        if target in reach:
            fixed = reach[target][1]
        if fixed is not None:
            result[key].update(sure); result[key].update(fixed)
            print(f'  {key[0]} {key[1]}: reconciled over {len(unsure)} uncertain cells')
        else:
            problems.append({'race': key[0], 'candidate': key[1], 'official': want,
                             'read': sum(v or 0 for v in cells.values()),
                             'uncertain': {str(m): alts[m] for m in unsure}})
    json.dump(CACHE, open(cache_at, 'w'))
    out = {'machines': {str(k): v for k, v in sorted(labels.items())},
           'races': {}, 'problems': problems}
    for (race, cand), cells in result.items():
        out['races'].setdefault(race, {})[cand] = {str(m): v for m, v in sorted(cells.items())}
    json.dump(out, open(a.out, 'w'), indent=1)
    print(f'{a.out}: {len(result)} candidates x {MACHINES} machines; '
          f'{len(problems)} candidates still off their official total')
    for p in problems:
        print(f"   {p['race']} {p['candidate']}: read {p['read']}, official {p['official']}, "
              f"{len(p['uncertain'])} uncertain cells")


if __name__ == '__main__':
    main()
