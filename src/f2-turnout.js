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
  /* inArea, when given, is the set of feature indices inside the study area,
     and share says how much of each district's electorate that is. A riding
     that straddles the edge of the study area -- Vancouver Fraserview--South
     Burnaby is a third Burnaby by electors -- cast its advance ballots across
     the whole riding, so handing all of them to the half on screen inflates
     it. Only that district's share is spread, and only over the units inside.
     The remainder is withheld and reported rather than quietly dropped. */
  /* byAdvance, when given, holds the advance-poll pools the join separated out,
     and advOf(idx) says which advance poll a feature reported to. Elections
     Canada publishes that, so an advance poll's ballots go to the ten or so
     divisions that actually fed it rather than to the two hundred in its
     riding -- and a pool whose divisions are all outside the study area gives
     this area nothing, with no share to assume and no early-voting rate to
     guess at. A pool with no divisions here at all falls back to the
     district-wide spread rather than disappearing. */
  function apportionUnmatched(values, unmatchedByDistrict,
                              { basis = 'votes', keyOpts, inArea = null, share = null,
                                byAdvance = null, advOf = null } = {}) {
    const clones = new Map();
    const out = new Map();
    for (const [idx, u] of values) {
      if (!clones.has(u)) clones.set(u, cloneUnit(u));
      out.set(idx, clones.get(u));
    }
    /* Grouped from the index map rather than from the clones, because which
       units are inside is a fact about features, not about units -- and two
       merged polls share one unit. A Set dedupes that back down. */
    const byDistrict = new Map();
    for (const [idx, c] of out) {
      if (inArea && !inArea.has(idx)) continue;
      const d = Results.normalizePart(c.district, keyOpts);
      if (!byDistrict.has(d)) byDistrict.set(d, new Set());
      byDistrict.get(d).add(c);
    }
    const weightOf = basis === 'electors' ? (u) => u.electors : (u) => ballots(u);
    let apportioned = 0, districts = 0, withheld = 0;
    let advancePools = 0, advanceApportioned = 0, advanceUnits = 0;

    /* One pass per advance poll, before the district-wide one. Its divisions
       are gathered the same way the district's are: from the index map, so
       that "inside the study area" stays a fact about features. */
    const spread = (members, extra, f) => {
      const sum = [...members].reduce((a, u) => a + weightOf(u), 0);
      if (!(sum > 0)) return 0;
      const pool = (extra.total + extra.rejected) * f;
      for (const u of members) {
        const w = weightOf(u) / sum;
        u.total += extra.total * f * w;
        u.rejected += extra.rejected * f * w;
        u.apportioned += pool * w;
        for (const [p, v] of extra.parties) u.parties.set(p, (u.parties.get(p) || 0) + v * f * w);
      }
      return pool;
    };
    const fellBack = new Map();
    if (byAdvance && advOf) {
      /* Two maps, because "this pool has no divisions here" has two very
         different causes. Known-but-elsewhere means the advance poll served
         ground outside the study area and gave this area nothing -- the right
         answer, arrived at without assuming anything about how early people
         vote on either side of the line. Not-known-at-all means the boundary
         file carries none of its divisions, and its ballots would vanish if
         they were not handed back to the district-wide spread. */
      const byPoll = new Map(), byPollAnywhere = new Map();
      for (const [idx, c] of out) {
        const a = advOf(idx);
        if (a == null) continue;
        const key = `${Results.normalizePart(c.district, keyOpts)}|${a}`;
        if (!byPollAnywhere.has(key)) byPollAnywhere.set(key, new Set());
        byPollAnywhere.get(key).add(c);
        if (inArea && !inArea.has(idx)) continue;
        if (!byPoll.has(key)) byPoll.set(key, new Set());
        byPoll.get(key).add(c);
      }
      for (const [key, extra] of byAdvance) {
        const members = byPoll.get(key);
        const whole = extra.total + extra.rejected;
        if (!members || !members.size) {
          if (byPollAnywhere.has(key)) { withheld += whole; continue; }
          const acc = fellBack.get(extra.district) || { total: 0, rejected: 0, parties: new Map(), units: 0 };
          acc.total += extra.total; acc.rejected += extra.rejected; acc.units += extra.units;
          for (const [p, v] of extra.parties) acc.parties.set(p, (acc.parties.get(p) || 0) + v);
          fellBack.set(extra.district, acc);
          continue;
        }
        const moved = spread(members, extra, 1);
        if (moved > 0) { advancePools++; advanceApportioned += moved; advanceUnits += members.size; }
        apportioned += moved;
        withheld += whole - moved;
      }
    }

    /* Anything that fell back joins the district-wide pools for this pass. */
    const districtWide = fellBack.size ? new Map(unmatchedByDistrict) : unmatchedByDistrict;
    for (const [d, acc] of fellBack) {
      const cur = districtWide.get(d);
      if (!cur) { districtWide.set(d, acc); continue; }
      const merged = { total: cur.total + acc.total, rejected: cur.rejected + acc.rejected,
                       parties: new Map(cur.parties), units: cur.units + acc.units };
      for (const [p, v] of acc.parties) merged.parties.set(p, (merged.parties.get(p) || 0) + v);
      districtWide.set(d, merged);
    }

    for (const [d, extra] of districtWide) {
      const members = byDistrict.get(d);
      const whole = extra.total + extra.rejected;
      const f = share && share.has(d) ? share.get(d) : 1;
      if (!members || !members.size || !(whole * f > 0)) { withheld += whole; continue; }
      const moved = spread(members, extra, f);
      if (!moved) { withheld += whole; continue; }
      apportioned += moved;
      withheld += whole - moved;
      districts++;
    }
    return { values: out, apportioned, districts, withheld,
             advancePools, advanceApportioned,
             advanceUnitsMean: advancePools ? advanceUnits / advancePools : null };
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
      /* The reference count is whichever source actually has electors, not
         whichever geography the rows are keyed on. A provincial voting area
         carries none -- Elections BC publishes registered voters per district,
         never per area -- so preferring the native source would set every row
         to zero and the minimum below would then drop the lot. */
      const order = [row.by[target], row.by.fed, row.by.prov, ...Object.values(row.by)];
      const ref = order.find((u) => u && u.electors > 0) || order.find(Boolean);
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

  /* --- Participation, where there is no electorate to divide by -------------

     Elections BC publishes registered voters per electoral district and never
     per voting area, and the 2024 results arrive per voting place with no
     elector column at all. So the provincial side has ballots on every area
     and a denominator on none, and its turnout column is blank.

     Two denominators can be had for an area, and neither of them is a
     provincial electorate:

       federal electors   the 2025 federal roll, areally interpolated onto the
                          voting area by the crosswalk. A real electorate, but
                          the wrong election's.
       residents 15+      census population of the area, carried across the
                          same way. The right year is not on offer either, and
                          it counts residents rather than registrants, with
                          15- to 17-year-olds among them.

     Both are computed, neither is called turnout, and the spread between them
     is reported because it is the size of the choice. Nothing here is written
     to `t`, `agg`, `min`, `delta` or `expected`: those stay strictly ballots
     over electors, so a modelled ratio can never reach something labelled
     turnout. A ratio over 1 is left as it stands -- it says the denominator is
     wrong for that area, not that anyone voted twice. */
  function participation(rows, { side = 'prov', adultsOf = null } = {}) {
    for (const row of rows) {
      const u = row.by[side];
      const b = u ? ballots(u) : null;
      const e = row.by.fed ? row.by.fed.electors : 0;
      const a = adultsOf ? adultsOf(row) : null;
      const over = (den) => (b != null && den > 0 && isFinite(den) ? b / den : null);
      const p = {
        ballots: b,
        fedElectors: e > 0 ? e : null,
        adults: a > 0 && isFinite(a) ? a : null,
        perFedElector: over(e),
        perAdult: over(a),
      };
      p.spread = p.perFedElector != null && p.perAdult != null ? p.perFedElector - p.perAdult : null;
      row.p = p;
    }
    return rows;
  }

  /* How many rows came out over 100%, which is worth saying out loud rather
     than hiding: it counts the areas where the denominator plainly does not
     describe the people who voted there. */
  const overOne = (rows, key) => rows.filter((r) => r.p && r.p[key] != null && r.p[key] > 1).length;

  const valueOf = (row, key) => (
    key.startsWith('t.') ? row.t[key.slice(2)]
      : key.startsWith('p.') ? (row.p ? row.p[key.slice(2)] : null)
        : row[key]);

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

  /* `extra` lets the application add columns this module has no business
     knowing about -- a loaded file of places, for one -- without toCsv growing
     a dependency on application state. It is { headers: [...], of: (row) =>
     [...] }, and the two arrays must be the same length: a header count that
     does not match its values shifts every column after it, which is the kind
     of export bug nobody notices until a spreadsheet says something false. */
  function toCsv(rows, sides = ['fed', 'prov'], extra = null) {
    const f = (v, dp = 6) => (v == null || !isFinite(v) ? '' : Number(v).toFixed(dp));
    /* The participation columns ride along only when they were computed. Both
       denominators go in the file beside their ratios -- `fed_electors` is
       already a column, so only the census one is added -- because the point
       of reporting two is that a reader can recompute either. */
    const part = rows.some((r) => r.p);
    const header = ['rank', 'unit_key', 'unit_label', 'electors',
      ...sides.flatMap((s) => [`${s}_ballots`, `${s}_electors`, `${s}_apportioned`, `turnout_${s}`]),
      'turnout_agg', 'turnout_min', 'turnout_delta', 'expected_ballots', 'partial',
      ...(part ? ['residents_15_plus', 'prov_per_fed_elector', 'prov_per_resident_15_plus',
                  'denominator_spread'] : []),
      ...(extra ? extra.headers : [])];
    const out = [header];
    for (const r of rows) {
      out.push([r.rank ?? '', r.key, r.label, f(r.electors, 2),
        ...sides.flatMap((s) => [f(r.ballots?.[s], 2), f(r.by[s]?.electors, 2),
          f(r.by[s]?.apportioned, 2), f(r.t?.[s])]),
        f(r.agg), f(r.min), f(r.delta), f(r.expected, 2), r.partial ? 'yes' : 'no',
        ...(part ? [f(r.p?.adults, 2), f(r.p?.perFedElector), f(r.p?.perAdult), f(r.p?.spread)] : []),
        ...(extra ? extra.of(r) : [])]);
    }
    if (extra) {
      const wrong = out.find((row) => row.length !== out[0].length);
      if (wrong) {
        throw new Error(`Export columns do not line up: the header has ${out[0].length} and a row `
          + `has ${wrong.length}. Every column after the mismatch would be under the wrong name.`);
      }
    }
    return out;
  }

  return { ballots, rate, cloneUnit, apportionUnmatched, rowsOnUnit, score, participation, overOne,
           rank, cumulative, basketSummary, toCsv };
})();
