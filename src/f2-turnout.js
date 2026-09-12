/* ---------------------------------------------------------------------------
   Turnout: the rate itself, apportionment of the ballots that have no polygon,
   comparison rows across any number of elections on a common geography, and
   the ranking, cumulative curve and basket summaries the Turnout tab shows.

   Turnout is never stored on a unit. It is always ballots / electors computed
   on demand, so every derived unit -- redistributed, apportioned, pooled --
   reports the figure its counts imply.
--------------------------------------------------------------------------- */
const Turnout = (() => {

  const ballots = (u) => (u ? (u.total || 0) + (u.rejected || 0) : 0);
  const rate = (u) => (u && u.electors > 0 ? ballots(u) / u.electors : null);

  const cloneUnit = (u) => ({
    ...u,
    parties: new Map(u.parties),
    flags: u.flags ? { ...u.flags } : undefined,
    apportioned: u.apportioned || 0,
  });

  /* --- Apportionment ------------------------------------------------------

     Advance polls and special ballots have no boundary, so the join leaves
     them as unmatched rows. Spread each district's unmatched ballots over its
     matched units, either in proportion to the ballots each already has
     (which multiplies every turnout in the district by one constant) or to its
     electors (which adds one constant). Both keep the within-district ranking;
     both change cross-district comparisons; neither is a measurement, and the
     Method tab says so. Electors are never touched: the advance-poll elector
     counts overlap the ordinary polls' and must not be added. */
  function apportionUnmatched(values, unmatchedByDistrict, { basis = 'votes', keyOpts } = {}) {
    const clones = new Map();
    const out = new Map();
    for (const [idx, u] of values) {
      if (!clones.has(u)) clones.set(u, cloneUnit(u));
      out.set(idx, clones.get(u));
    }
    const byDistrict = new Map();
    for (const c of clones.values()) {
      const d = Results.normalizePart(c.district, keyOpts);
      if (!byDistrict.has(d)) byDistrict.set(d, []);
      byDistrict.get(d).push(c);
    }
    const weightOf = basis === 'electors' ? (u) => u.electors : (u) => ballots(u);
    let apportioned = 0, districts = 0;
    for (const [d, extra] of unmatchedByDistrict) {
      const members = byDistrict.get(d);
      const pool = extra.total + extra.rejected;
      if (!members || !(pool > 0)) continue;
      const sum = members.reduce((a, u) => a + weightOf(u), 0);
      if (!(sum > 0)) continue;
      for (const u of members) {
        const s = weightOf(u) / sum;
        u.total += extra.total * s;
        u.rejected += extra.rejected * s;
        u.apportioned += pool * s;
        for (const [p, v] of extra.parties) u.parties.set(p, (u.parties.get(p) || 0) + v * s);
      }
      apportioned += pool;
      districts++;
    }
    return { values: out, apportioned, districts };
  }

  /* --- Rows on a common geography ------------------------------------------

     sources: [{ id, values: Map<index, unit>, pairs, side }].
     target:  a source id ('fed' | 'prov' | 'da' ...) or 'atom'. A source native
     to the target is used as-is; any other is moved through its crosswalk
     pairs, from the side it sits on ('a' or 'b'; a source without a side is
     'a' when its id is 'fed' and 'b' otherwise, which is the federal-provincial
     crosswalk's convention); a source with no pairs is left out, so a
     federal-only ranking works before a provincial layer exists. Each row
     carries `by[sourceId]` and a reference elector count from the target's
     native source, or the first source present. */
  const sideOf = (s) => s.side || (s.id === 'fed' ? 'a' : 'b');

  function rowsOnUnit(target, sources, labels, { minElectors = 0 } = {}) {
    const rows = new Map();
    const ensure = (key, label) => {
      let r = rows.get(key);
      if (!r) rows.set(key, (r = { key, label, by: {} }));
      return r;
    };
    if (target === 'atom') {
      const withPairs = sources.find((s) => s.pairs);
      if (!withPairs) return [];
      const aSrc = sources.find((s) => s.pairs && sideOf(s) === 'a');
      const bSrc = sources.find((s) => s.pairs && sideOf(s) === 'b');
      const labelA = (aSrc && labels[aSrc.id]) || labels.fed;
      const labelB = (bSrc && labels[bSrc.id]) || labels.prov;
      for (const p of withPairs.pairs) {
        const ai = Analysis.pairIndex(p, 'a'), bi = Analysis.pairIndex(p, 'b');
        const row = ensure(`${ai}|${bi}`, `${labelA(ai)} × ${labelB(bi)}`);
        for (const s of sources) {
          const side = sideOf(s);
          const u = s.values.get(Analysis.pairIndex(p, side));
          if (u) row.by[s.id] = Analysis.scaledUnit(u, Analysis.pairShare(p, side));
        }
      }
    } else {
      for (const s of sources) {
        let onTarget;
        if (s.id === target) onTarget = s.values;
        else if (s.pairs) onTarget = Analysis.redistribute(s.pairs, s.values, { from: sideOf(s) });
        else continue;
        for (const [idx, u] of onTarget) ensure(String(idx), labels[target](idx)).by[s.id] = u;
      }
    }
    const out = [];
    for (const row of rows.values()) {
      const ref = row.by[target] || row.by.fed || row.by.prov || Object.values(row.by)[0];
      row.electors = ref ? ref.electors : 0;
      if (row.electors < minElectors) continue;
      out.push(row);
    }
    return out;
  }

  /* Combined turnout per row: a weighted mean over the sides that have a
     rate, flagged partial when any configured side is missing. */
  function score(rows, { weights = { fed: 0.5, prov: 0.5 } } = {}) {
    const sides = Object.keys(weights);
    for (const row of rows) {
      const t = {}, present = [];
      let num = 0, den = 0;
      for (const s of sides) {
        const r = rate(row.by[s]);
        t[s] = r;
        if (r != null && isFinite(r)) {
          present.push(s);
          num += (weights[s] || 0) * r;
          den += weights[s] || 0;
        }
      }
      row.t = t;
      row.agg = den > 0 ? num / den : null;
      row.partial = present.length < sides.length;
      row.min = present.length ? Math.min(...present.map((s) => t[s])) : null;
      row.delta = t.fed != null && t.prov != null ? t.fed - t.prov : null;
      row.ballots = {};
      for (const s of sides) row.ballots[s] = ballots(row.by[s]);
      row.expected = row.agg != null ? row.agg * row.electors : null;
    }
    return rows;
  }

  const valueOf = (row, key) => (key.startsWith('t.') ? row.t[key.slice(2)] : row[key]);

  /* Sorted copy with 1-based ranks; nulls sink to the bottom either way. */
  function rank(rows, key = 'agg', dir = 'desc') {
    const sorted = rows.slice().sort((a, b) => {
      const x = valueOf(a, key), y = valueOf(b, key);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return dir === 'desc' ? y - x : x - y;
    });
    sorted.forEach((r, i) => { r.rank = i + 1; });
    return sorted;
  }

  /* "The top X% of areas hold Y% of electors" -- and of expected ballots. */
  function cumulative(rows, key = 'agg') {
    const sorted = rank(rows.filter((r) => valueOf(r, key) != null), key, 'desc');
    const totalE = sorted.reduce((a, r) => a + r.electors, 0);
    const totalX = sorted.reduce((a, r) => a + (r.expected || 0), 0);
    let e = 0, x = 0;
    return sorted.map((r, i) => {
      e += r.electors;
      x += r.expected || 0;
      return {
        key: r.key,
        shareOfAreas: (i + 1) / sorted.length,
        shareOfElectors: totalE > 0 ? e / totalE : 0,
        shareOfExpected: totalX > 0 ? x / totalX : 0,
      };
    });
  }

  /* Pooled turnout of a chosen set of rows, per side and combined. */
  function basketSummary(rows, keys, { weights = { fed: 0.5, prov: 0.5 } } = {}) {
    const sel = rows.filter((r) => keys.has(r.key));
    const per = {};
    let num = 0, den = 0;
    for (const s of Object.keys(weights)) {
      let E = 0, B = 0;
      for (const r of sel) {
        const u = r.by[s];
        if (u && u.electors > 0) { E += u.electors; B += ballots(u); }
      }
      per[s] = { electors: E, ballots: B, rate: E > 0 ? B / E : null };
      if (per[s].rate != null) { num += weights[s] * per[s].rate; den += weights[s]; }
    }
    return {
      count: sel.length,
      electors: sel.reduce((a, r) => a + r.electors, 0),
      expected: sel.reduce((a, r) => a + (r.expected || 0), 0),
      per,
      agg: den > 0 ? num / den : null,
    };
  }

  function toCsv(rows, sides = ['fed', 'prov']) {
    const f = (v, dp = 6) => (v == null || !isFinite(v) ? '' : Number(v).toFixed(dp));
    const header = ['rank', 'unit_key', 'unit_label', 'electors',
      ...sides.flatMap((s) => [`${s}_ballots`, `${s}_electors`, `${s}_apportioned`, `turnout_${s}`]),
      'turnout_agg', 'turnout_min', 'turnout_delta', 'expected_ballots', 'partial'];
    const out = [header];
    for (const r of rows) {
      out.push([r.rank ?? '', r.key, r.label, f(r.electors, 2),
        ...sides.flatMap((s) => [f(r.ballots?.[s], 2), f(r.by[s]?.electors, 2),
          f(r.by[s]?.apportioned, 2), f(r.t?.[s])]),
        f(r.agg), f(r.min), f(r.delta), f(r.expected, 2), r.partial ? 'yes' : 'no']);
    }
    return out;
  }

  return { ballots, rate, cloneUnit, apportionUnmatched, rowsOnUnit, score, rank, cumulative,
           basketSummary, toCsv };
})();
