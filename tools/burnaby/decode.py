"""Decode a PDF whose fonts carry no usable character map, page by page.

Burnaby's results attachment draws its text in fonts whose glyph codes stand
for the wrong characters -- a different substitution on every page, but a
fixed one within a page. OCR of the same page reads the characters, error-
prone digit by digit but right most of the time; lining up the PDF's words
with the OCR's words at the same place on the page gives each glyph code many
votes, and the majority is its character. The page's own text is then read
exactly, from the PDF, with every glyph decoded, which no OCR error survives
unless it outvoted the right reading on that page."""
import collections, re
import pdfplumber

TOKEN = re.compile(r'\(cid:\d+\)|.')


def toks(s):
    return TOKEN.findall(s)


def page_map(page, ocr_words, dpi=300):
    S = dpi / 72
    votes = collections.defaultdict(collections.Counter)
    for w in page.extract_words(keep_blank_chars=False):
        t = toks(w['text'])
        x0, y0, x1, y1 = w['x0'] * S, w['top'] * S, w['x1'] * S, w['bottom'] * S
        for q in ocr_words:
            qx0, qy0 = q['left'], q['top']
            qx1, qy1 = qx0 + q['width'], qy0 + q['height']
            ix = max(0, min(x1, qx1) - max(x0, qx0))
            iy = max(0, min(y1, qy1) - max(y0, qy0))
            if ix * iy > 0.5 * (qx1 - qx0) * (qy1 - qy0):
                txt = q['text']
                core = [c for c in t]
                # glyph runs often end in a space glyph the OCR does not report
                if len(core) == len(txt) + 1:
                    core = core[:-1]
                if len(core) == len(txt):
                    for a, b in zip(core, txt):
                        votes[a][b] += 1
                break
    cmap, purity = {}, {}
    for a, c in votes.items():
        (b, n), total = c.most_common(1)[0], sum(c.values())
        cmap[a], purity[a] = b, n / total
    return cmap, purity, votes


def decode_words(page, cmap):
    out = []
    for w in page.extract_words(keep_blank_chars=False):
        t = toks(w['text'])
        out.append({'text': ''.join(cmap.get(c, '?') for c in t).strip(),
                    'raw': t, 'x0': w['x0'], 'x1': w['x1'], 'top': w['top'], 'bottom': w['bottom']})
    return out
