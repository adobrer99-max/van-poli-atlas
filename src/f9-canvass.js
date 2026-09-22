/* --- Canvass results -----------------------------------------------------
   What a campaign learned at the door, turned into a number per address.

   This is the first door-level fact the atlas has held. Every other measure is
   reported for an area, so two doors in the same polling division carry the
   same value on all of them; a canvass knows one house said yes and the next
   said no. That is the whole reason it is worth reading.

   The file itself is somebody else's. Campaign databases disagree about
   everything -- column names, whether support is a word or a number, whether
   one row is one contact or one elector -- so nothing here assumes a schema.
   The reader is shown the values that are actually in their file and says what
   each is worth, which is the only approach that works on a format nobody here
   has seen.

   Nothing from the file is kept beyond the mapped score and a contact count.
   Names, notes and phone numbers are read and discarded in the same pass. */

const Canvass = (() => {
  /* Text that says its own direction.

     Deliberately words only. A column of 1 to 5 is the common case and the
     ambiguous one: VAN counts 1 as strong support and 5 as strong against, and
     plenty of home-grown sheets count the other way. Guessing wrong inverts
     the entire canvass silently -- every supporter becomes an opponent and the
     list ranks the doors that told you no -- and nothing downstream could
     detect it, because an inverted scale is a perfectly well-formed scale.

     So numbers are never guessed. They are shown unmapped and the reader
     assigns them, which takes ten seconds and cannot be wrong in a way nobody
     notices. */
  const SUPPORT_WORDS = [
    [/^\s*(strong(ly)?[\s_-]*(support|yes|favou?r)|definite(ly)?[\s_-]*yes)\s*$/i, 1],
    [/^\s*(lean(ing)?[\s_-]*(support|yes|favou?r)|soft[\s_-]*(support|yes)|probabl[ey][\s_-]*yes)\s*$/i, 0.75],
    [/^\s*(undecided|unsure|maybe|neutral|not[\s_-]*sure|don'?t[\s_-]*know)\s*$/i, 0.5],
    [/^\s*(lean(ing)?[\s_-]*(against|no|oppose[d]?)|soft[\s_-]*(against|no)|probabl[ey][\s_-]*no)\s*$/i, 0.25],
    [/^\s*(strong(ly)?[\s_-]*(against|no|oppose[d]?)|definite(ly)?[\s_-]*no)\s*$/i, 0],
  ];

  /* Every distinct value in the chosen column, with how many rows carry it.

     The counts are the point. A campaign looking at "Strong Support 12,
     Refused 400, blank 9,000" learns more about its own data in one glance
     than any summary statistic would tell it, and the blanks in particular are
     the difference between a canvass that covered the city and one that
     covered a weekend. */
  function values(points) {
    const seen = new Map();
    for (const p of points) {
      const v = String(p.label == null ? '' : p.label).trim();
      seen.set(v, (seen.get(v) || 0) + 1);
    }
    return [...seen.entries()]
      .map(([value, rows]) => ({ value, rows }))
      .sort((a, b) => b.rows - a.rows || a.value.localeCompare(b.value));
  }

  /* A starting scale: the words this recognises, and null for everything else.

     Null is not a failure to be papered over -- it means "no opinion about
     what this is worth", and a value left at null takes its row out of the
     score rather than being treated as a zero. A refusal is not weak support
     and a blank is not opposition; scoring either as 0 would put doors that
     said nothing below doors that said no. */
  function guess(list) {
    const out = new Map();
    for (const { value } of list) {
      if (!value) { out.set(value, null); continue; }
      const hit = SUPPORT_WORDS.find(([re]) => re.test(value));
      out.set(value, hit ? hit[1] : null);
    }
    return out;
  }

  /* One number per door.

     A door can be canvassed more than once -- several electors, or several
     visits -- so the score is the mean of whatever was scored there. `contacts`
     counts every row at the address including the unscored ones, because "we
     knocked and they would not say" is a fact about the door that a campaign
     filtering its list wants to keep. */
  function pool(points, scale) {
    const out = new Map();
    for (const p of points) {
      if (!p.key) continue;
      const v = String(p.label == null ? '' : p.label).trim();
      const score = scale instanceof Map ? scale.get(v) : null;
      let at = out.get(p.key);
      if (!at) out.set(p.key, (at = { key: p.key, contacts: 0, scored: 0, total: 0 }));
      at.contacts += 1;
      if (score != null && isFinite(score)) { at.scored += 1; at.total += score; }
    }
    for (const at of out.values()) {
      at.support = at.scored ? at.total / at.scored : null;
    }
    return out;
  }

  /* What to say about the join, in the terms a campaign argues in. */
  function summary(list, scale, pooled) {
    const rows = list.reduce((n, v) => n + v.rows, 0);
    let mapped = 0, blank = 0;
    for (const { value, rows: n } of list) {
      if (!value) { blank += n; continue; }
      const s = scale instanceof Map ? scale.get(value) : null;
      if (s != null && isFinite(s)) mapped += n;
    }
    let doors = 0, scoredDoors = 0;
    for (const at of (pooled || new Map()).values()) {
      doors += 1;
      if (at.support != null) scoredDoors += 1;
    }
    return {
      rows,
      values: list.length,
      mapped,
      unmapped: rows - mapped - blank,
      blank,
      doors,
      scoredDoors,
    };
  }

  return { SUPPORT_WORDS, values, guess, pool, summary };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Canvass;
