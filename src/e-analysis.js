/* ---------------------------------------------------------------------------
   Analysis: areal crosswalk between two incompatible poll geographies, vote
   redistribution onto a common unit, and the correlation statistics.

   Federal polling divisions and provincial voting areas are drawn by different
   agencies and share no boundaries, so results cannot be joined by key. The
   crosswalk measures how much of each federal division lies inside each
   provincial voting area by sampling a lattice of equal-area points, then
   splits votes in those proportions. That assumes votes are spread evenly
   within a poll, which is the standard areal-interpolation assumption and the
   main caveat on everything computed here.
--------------------------------------------------------------------------- */
const Analysis = (() => {

  /* --- Lattice sample ------------------------------------------------------

     One equal-area lattice is laid over the study area and every point is
     hit-tested against every loaded layer once. The per-point hits are kept,
     so any pair of layers can be crossed afterwards in one pass over the
     sample, and the same sample can be re-weighted -- by block population,
     say -- without sampling again.

     Runs as a generator so the caller can keep the page responsive; each
     next() processes one band of lattice rows and reports progress in (0, 1].

     layers:  [{ features, index? }]   (indexes are built when absent)
     options: { spacingM, extent }     extent defaults to the first layer's,
              which is the anchor of the study (the active federal polls).
     Returns  { spacingM, extent, rows, points, n, hits, nFeatures, layers,
                indexes } where hits[k] is an Int32Array of length n holding
              the feature index in layer k for each stored point (-1 = miss);
              only points that hit at least one layer are stored. */
  function* sampleLattice(layers, options = {}) {
    const spacingM = options.spacingM || 40;
    const indexes = layers.map((l) => l.index || Geo.buildIndex(l.features));
    const nFeatures = layers.map((l) => l.features.length);
    const features = layers.map((l) => l.features);
    const ext = options.extent || indexes[0].extent;
    if (!ext || !(ext[2] > ext[0] && ext[3] > ext[1])) {
      return { spacingM, extent: null, rows: 0, points: 0, n: 0,
               hits: layers.map(() => new Int32Array(0)), nFeatures, layers: features, indexes };
    }
    const [minX, minY, maxX, maxY] = ext;
    const dLat = spacingM / 110574;
    const rows = Math.max(1, Math.ceil((maxY - minY) / dLat));
    const rowsPerStep = Math.max(1, Math.ceil(rows / 60));
    /* Widen the longitude step with latitude so every sample point stands
       for the same ground area. */
    const dLonOf = (r) => spacingM / (111320 * Math.cos((minY + (r + 0.5) * dLat) * Math.PI / 180));
    /* Column counts are known up front, so the hit arrays are allocated once
       at (a little over) the size they can need. */
    let capacity = 0;
    for (let r = 0; r < rows; r++) {
      const dLon = dLonOf(r);
      capacity += Math.max(0, Math.floor((maxX - (minX + dLon / 2)) / dLon) + 2);
    }
    const hits = layers.map(() => new Int32Array(capacity));
    const tmp = new Int32Array(layers.length);
    let points = 0, n = 0;

    for (let r0 = 0; r0 < rows; r0 += rowsPerStep) {
      for (let r = r0; r < Math.min(rows, r0 + rowsPerStep); r++) {
        const lat = minY + (r + 0.5) * dLat;
        const dLon = dLonOf(r);
        for (let x = minX + dLon / 2; x <= maxX; x += dLon) {
          points++;
          let any = false;
          for (let k = 0; k < layers.length; k++) {
            const h = indexes[k].hit(x, lat);
            tmp[k] = h;
            if (h >= 0) any = true;
          }
          if (!any) continue;
          for (let k = 0; k < layers.length; k++) hits[k][n] = tmp[k];
          n++;
        }
      }
      yield Math.min(1, (r0 + rowsPerStep) / rows);
    }
    return { spacingM, extent: [minX, minY, maxX, maxY], rows, points, n,
             hits: hits.map((h) => h.subarray(0, n)), nFeatures, layers: features, indexes };
  }

  /* Per-point weights from a population layer: each feature's population is
     spread evenly over the lattice points inside it, so a point stands for
     people rather than ground. A point outside every populated feature takes
     the fallback weight -- another layer's weights, or 1 (plain area). */
  function pointWeights(sample, layerIdx, popByFeature, fallback = null) {
    const h = sample.hits[layerIdx];
    const count = new Float64Array(sample.nFeatures[layerIdx]);
    for (let p = 0; p < sample.n; p++) if (h[p] >= 0) count[h[p]]++;
    const pop = (i) => {
      const v = popByFeature instanceof Map ? popByFeature.get(i) : popByFeature[i];
      return v != null && isFinite(v) && v >= 0 ? v : null;
    };
    const w = new Float64Array(sample.n);
    for (let p = 0; p < sample.n; p++) {
      const i = h[p];
      const v = i >= 0 ? pop(i) : null;
      w[p] = v != null ? v / count[i] : (fallback ? fallback[p] : 1);
    }
    return w;
  }

  /* --- Crosswalk between two sampled layers ------------------------------

     Unweighted, every point counts one and the shares are shares of area;
     with weights they are shares of whatever the weights carry. A feature the
     lattice saw but whose weight sums to zero -- a park under population
     weights -- would have its votes zeroed by any share computed from it, so
     its points take the mean point weight instead and the feature is listed
     in areaFallback for the status line. */
  function crosswalkBetween(sample, ai, bi, options = {}) {
    const weights = options.weights || null;
    const ha = sample.hits[ai], hb = sample.hits[bi];
    const nA = sample.nFeatures[ai], nB = sample.nFeatures[bi];
    const cw = {
      spacingM: sample.spacingM, extent: sample.extent, points: sample.points,
      nA, nB,
      aPoints: new Float64Array(nA), bPoints: new Float64Array(nB),   // raw point counts
      aCount: new Float64Array(nA), bCount: new Float64Array(nB),     // weighted mass
      aBoth: new Float64Array(nA), bBoth: new Float64Array(nB),       // mass also inside the other layer
      cells: new Map(),                                               // ai * nB + bi -> mass
      weighted: Boolean(weights), areaFallback: { a: [], b: [] },
      hits: 0, bothHits: 0, overlap: Boolean(sample.extent),
    };
    if (!sample.n) return cw;

    /* Pass 1: raw counts and mass, to find zero-mass features. */
    let wSum = 0, wN = 0;
    for (let p = 0; p < sample.n; p++) {
      const fa = ha[p], fb = hb[p];
      if (fa < 0 && fb < 0) continue;
      const w = weights ? weights[p] : 1;
      if (fa >= 0) { cw.aPoints[fa]++; cw.aCount[fa] += w; }
      if (fb >= 0) { cw.bPoints[fb]++; cw.bCount[fb] += w; }
      wSum += w; wN++;
    }
    let fixA = null, fixB = null;
    if (weights) {
      const meanW = wN ? wSum / wN : 1;
      for (let i = 0; i < nA; i++) if (cw.aPoints[i] > 0 && !(cw.aCount[i] > 0)) { (fixA ||= new Set()).add(i); cw.areaFallback.a.push(i); }
      for (let i = 0; i < nB; i++) if (cw.bPoints[i] > 0 && !(cw.bCount[i] > 0)) { (fixB ||= new Set()).add(i); cw.areaFallback.b.push(i); }
      if (fixA || fixB) { cw.aCount.fill(0); cw.bCount.fill(0); cw.fallbackWeight = meanW; }
      else { weightsApplied(cw, sample, ha, hb, weights, null, null, 0); return cw; }
      weightsApplied(cw, sample, ha, hb, weights, fixA, fixB, meanW);
      return cw;
    }
    weightsApplied(cw, sample, ha, hb, null, null, null, 0);
    return cw;
  }

  /* Pass 2 of crosswalkBetween: accumulate cells and "both" masses, with the
     zero-mass fallback applied. Counts are re-accumulated only when a fallback
     changed some weights; otherwise pass 1's counts stand. */
  function weightsApplied(cw, sample, ha, hb, weights, fixA, fixB, meanW) {
    const recount = Boolean(fixA || fixB);
    let hits = 0, bothHits = 0;
    for (let p = 0; p < sample.n; p++) {
      const fa = ha[p], fb = hb[p];
      if (fa < 0 && fb < 0) continue;
      let w = weights ? weights[p] : 1;
      if ((fixA && fa >= 0 && fixA.has(fa)) || (fixB && fb >= 0 && fixB.has(fb))) w = meanW;
      hits++;
      if (recount) {
        if (fa >= 0) cw.aCount[fa] += w;
        if (fb >= 0) cw.bCount[fb] += w;
      }
      if (fa >= 0 && fb >= 0) {
        bothHits++;
        cw.aBoth[fa] += w;
        cw.bBoth[fb] += w;
        const key = fa * cw.nB + fb;
        cw.cells.set(key, (cw.cells.get(key) || 0) + w);
      }
    }
    cw.hits = hits;
    cw.bothHits = bothHits;
  }

  /* The two-layer runner every existing caller uses: samples the overlap of
     the federal and provincial extents (exactly the lattice it always laid)
     and crosses the pair. The result carries both the a/b names and the
     older fed/prov aliases, which point at the same arrays. */
  function* crosswalkRunner(fedFeatures, provFeatures, options = {}) {
    const spacingM = options.spacingM || 40;
    const fedIndex = options.fedIndex || Geo.buildIndex(fedFeatures);
    const provIndex = options.provIndex || Geo.buildIndex(provFeatures);
    let extent = null;
    if (fedIndex.extent && provIndex.extent) {
      /* Only the overlap of the two layers can contribute. */
      const minX = Math.max(fedIndex.extent[0], provIndex.extent[0]);
      const minY = Math.max(fedIndex.extent[1], provIndex.extent[1]);
      const maxX = Math.min(fedIndex.extent[2], provIndex.extent[2]);
      const maxY = Math.min(fedIndex.extent[3], provIndex.extent[3]);
      if (maxX > minX && maxY > minY) extent = [minX, minY, maxX, maxY];
    }
    const sample = yield* sampleLattice(
      [{ features: fedFeatures, index: fedIndex }, { features: provFeatures, index: provIndex }],
      { spacingM, extent });
    if (!extent) sample.extent = null;
    return legacyNames(crosswalkBetween(sample, 0, 1));
  }

  const legacyNames = (cw) => Object.assign(cw, {
    fedCount: cw.aCount, provCount: cw.bCount, fedBoth: cw.aBoth, provBoth: cw.bBoth,
    fedPoints: cw.aPoints, provPoints: cw.bPoints, nProv: cw.nB,
  });

  /* Lattice sampling breaks down for very small polygons. Elections Canada
     mobile polls (type M) and single-building polls (type S) are only metres
     across, so a 25 m lattice may miss them entirely and their votes would
     vanish from the analysis -- exactly the dense downtown and care-home polls
     that matter most. Any feature the lattice barely saw is instead assigned
     whole to the unit containing its representative interior point, with its
     true area as the weight (times the local point weight, when the sample is
     weighted) so the other layer's shares stay proportional.

     indexes: { a, b } or the older { fed, prov }. */
  function repairSmallFeatures(cw, aFeatures, bFeatures, indexes, minSamples = 6) {
    const repaired = { a: [], b: [] };
    repaired.fed = repaired.a; repaired.prov = repaired.b;
    if (!cw.overlap) return repaired;
    const idxA = indexes.a || indexes.fed, idxB = indexes.b || indexes.prov;
    const unit = cw.spacingM * cw.spacingM;
    const nB = cw.nB;
    const localWeight = (count, points, i) => (points[i] > 0 && count[i] > 0 ? count[i] / points[i] : 1);

    const cellsFor = (matches) => {
      const out = [];
      for (const key of cw.cells.keys()) if (matches(key)) out.push(key);
      return out;
    };

    aFeatures.forEach((feature, ai) => {
      if (cw.aPoints[ai] >= minSamples) return;
      const pt = Geo.representativePoint(feature.geometry);
      if (!pt) return;
      const bi = idxB.hit(pt[0], pt[1]);
      const mass = Math.max(Geo.areaM2(feature.geometry) / unit, 1e-6)
        * (bi >= 0 ? localWeight(cw.bCount, cw.bPoints, bi) : 1);
      for (const key of cellsFor((k) => Math.floor(k / nB) === ai)) cw.cells.delete(key);
      cw.aCount[ai] = mass;
      cw.aBoth[ai] = bi >= 0 ? mass : 0;
      if (bi >= 0) {
        cw.cells.set(ai * nB + bi, mass);
        if (cw.bPoints[bi] < minSamples) cw.bCount[bi] = Math.max(cw.bCount[bi], mass);
      }
      repaired.a.push(ai);
    });

    bFeatures.forEach((feature, bi) => {
      if (cw.bPoints[bi] >= minSamples) return;
      const pt = Geo.representativePoint(feature.geometry);
      if (!pt) return;
      const ai = idxA.hit(pt[0], pt[1]);
      /* Leave alone anything the first pass already pinned here. */
      if (ai >= 0 && repaired.a.includes(ai)) return;
      const mass = Math.max(Geo.areaM2(feature.geometry) / unit, 1e-6)
        * (ai >= 0 ? localWeight(cw.aCount, cw.aPoints, ai) : 1);
      for (const key of cellsFor((k) => k % nB === bi)) cw.cells.delete(key);
      cw.bCount[bi] = mass;
      cw.bBoth[bi] = ai >= 0 ? mass : 0;
      if (ai >= 0) cw.cells.set(ai * nB + bi, mass);
      repaired.b.push(bi);
    });

    return repaired;
  }

  /* Expand the packed cell map into explicit overlap records.

     minShare drops slivers. Two agencies digitise the same street differently,
     so almost every pair of boundaries produces hairline overlaps that carry no
     real voters; a lattice estimates those least reliably, and they are the
     main source of instability between lattice resolutions. A sliver is only
     dropped when it is negligible to BOTH sides, so a thin overlap that still
     makes up most of a small voting area survives.

     The shares that remain are rescaled to recover exactly the mass that the
     dropped slivers were carrying -- not to 1. A poll lying partly outside the
     other layer keeps its true coverage instead of having its votes pushed
     inside.

     Every pair carries both namings: ai/bi/shareOfA/shareOfB and the older
     fi/pi/shareOfFed/shareOfProv, which are the same numbers. */
  function crosswalkPairs(cw, options = {}) {
    const minShare = options.minShare || 0;
    const nB = cw.nB;
    const raw = [];
    for (const [key, count] of cw.cells) {
      const ai = Math.floor(key / nB), bi = key % nB;
      const shareOfA = cw.aCount[ai] ? count / cw.aCount[ai] : 0;
      const shareOfB = cw.bCount[bi] ? count / cw.bCount[bi] : 0;
      raw.push({ ai, bi, fi: ai, pi: bi, count, shareOfA, shareOfB,
                 shareOfFed: shareOfA, shareOfProv: shareOfB });
    }
    if (!minShare) return raw;

    const sum = (list, key, idx) => {
      const totals = new Map();
      for (const p of list) totals.set(p[idx], (totals.get(p[idx]) || 0) + p[key]);
      return totals;
    };
    const aBefore = sum(raw, 'shareOfA', 'ai');
    const bBefore = sum(raw, 'shareOfB', 'bi');
    const kept = raw.filter((p) => p.shareOfA >= minShare || p.shareOfB >= minShare);
    const aAfter = sum(kept, 'shareOfA', 'ai');
    const bAfter = sum(kept, 'shareOfB', 'bi');
    for (const p of kept) {
      const aScale = aAfter.get(p.ai) > 0 ? aBefore.get(p.ai) / aAfter.get(p.ai) : 1;
      const bScale = bAfter.get(p.bi) > 0 ? bBefore.get(p.bi) / bAfter.get(p.bi) : 1;
      p.shareOfA *= aScale;
      p.shareOfB *= bScale;
      p.shareOfFed = p.shareOfA;
      p.shareOfProv = p.shareOfB;
    }
    return kept;
  }

  /* Fraction of each feature that lies inside the other layer at all. */
  const coverage = (cw) => {
    const a = Array.from(cw.aCount, (n, i) => (n ? cw.aBoth[i] / n : 0));
    const b = Array.from(cw.bCount, (n, i) => (n ? cw.bBoth[i] / n : 0));
    return { a, b, fed: a, prov: b };
  };

  /* --- Vote redistribution ----------------------------------------------- */

  /* Everything that moves through the crosswalk is a count -- votes, electors,
     rejected ballots -- so all of it scales by the same share. Keeping electors
     alongside votes is what makes turnout on a target unit come out as the
     electors-weighted mean of its sources, with no separate bookkeeping. */
  const COUNT_FIELDS = ['total', 'electors', 'rejected', 'apportioned'];
  const emptyUnit = () => ({ total: 0, parties: new Map(), electors: 0, rejected: 0, apportioned: 0 });
  function addScaled(acc, src, w) {
    for (const f of COUNT_FIELDS) acc[f] += (src[f] || 0) * w;
    for (const [party, votes] of src.parties) {
      acc.parties.set(party, (acc.parties.get(party) || 0) + votes * w);
    }
    return acc;
  }
  const scaledUnit = (src, w) => addScaled(emptyUnit(), src, w);

  /* values: index -> unit on the source side. Splits each source unit's counts
     across the target units in proportion to shared area (or shared
     population, once the sample carries weights).
     from: 'a' | 'b', or the older 'fed' (= a) | 'prov' (= b). */
  const fromA = (from) => from === 'a' || from === 'fed';
  const pairShare = (p, side) => (side === 'a' ? (p.shareOfA ?? p.shareOfFed) : (p.shareOfB ?? p.shareOfProv));
  const pairIndex = (p, side) => (side === 'a' ? (p.ai ?? p.fi) : (p.bi ?? p.pi));
  function redistribute(pairs, values, { from }) {
    const src = fromA(from) ? 'a' : 'b', dst = fromA(from) ? 'b' : 'a';
    const out = new Map();
    for (const pair of pairs) {
      const unit = values.get(pairIndex(pair, src));
      if (!unit) continue;
      const w = pairShare(pair, src);
      if (!(w > 0)) continue;
      const target = pairIndex(pair, dst);
      let acc = out.get(target);
      if (!acc) out.set(target, (acc = emptyUnit()));
      addScaled(acc, unit, w);
    }
    return out;
  }

  /* --- Statistics -------------------------------------------------------- */

  function pearson(xs, ys, weights) {
    const n = xs.length;
    if (n < 3) return null;
    const w = weights || xs.map(() => 1);
    let sw = 0, mx = 0, my = 0;
    for (let i = 0; i < n; i++) { sw += w[i]; mx += w[i] * xs[i]; my += w[i] * ys[i]; }
    if (!(sw > 0)) return null;
    mx /= sw; my /= sw;
    let sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - mx, dy = ys[i] - my;
      sxx += w[i] * dx * dx; syy += w[i] * dy * dy; sxy += w[i] * dx * dy;
    }
    if (sxx <= 0 || syy <= 0) return null;
    return sxy / Math.sqrt(sxx * syy);
  }

  /* Average ranks so ties do not bias the coefficient. */
  function rankOf(values) {
    const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const ranks = new Array(values.length);
    let i = 0;
    while (i < order.length) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
      const rank = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) ranks[order[k][1]] = rank;
      i = j + 1;
    }
    return ranks;
  }

  const spearman = (xs, ys) =>
    xs.length < 3 ? null : pearson(rankOf(xs), rankOf(ys));

  function linearFit(xs, ys, weights) {
    const n = xs.length;
    if (n < 2) return null;
    const w = weights || xs.map(() => 1);
    let sw = 0, mx = 0, my = 0;
    for (let i = 0; i < n; i++) { sw += w[i]; mx += w[i] * xs[i]; my += w[i] * ys[i]; }
    if (!(sw > 0)) return null;
    mx /= sw; my /= sw;
    let sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - mx;
      sxx += w[i] * dx * dx; sxy += w[i] * dx * (ys[i] - my);
    }
    if (sxx <= 0) return null;
    const slope = sxy / sxx;
    return { slope, intercept: my - slope * mx };
  }

  /* Fisher z confidence interval for Pearson r. */
  function pearsonCI(r, n, z = 1.959963985) {
    if (r == null || n < 4 || Math.abs(r) >= 1) return null;
    const zr = 0.5 * Math.log((1 + r) / (1 - r));
    const se = 1 / Math.sqrt(n - 3);
    const lo = Math.tanh(zr - z * se), hi = Math.tanh(zr + z * se);
    return [lo, hi];
  }

  /* --- Assembling comparison rows ---------------------------------------- */

  const shareOf = (unit, party) =>
    unit && unit.total > 0 ? (unit.parties.get(party) || 0) / unit.total : null;

  /* unit: 'prov' | 'fed' | 'atom'. Returns one row per common-geography unit
     carrying both vote shares, ready for plotting. */
  function comparisonRows(cw, pairs, fedValues, provValues, unit, labels, minVotes = 0) {
    const rows = [];
    if (unit === 'atom') {
      for (const pair of pairs) {
        const fedSrc = fedValues.get(pair.fi), provSrc = provValues.get(pair.pi);
        if (!fedSrc || !provSrc) continue;
        const fedPart = scaledUnit(fedSrc, pair.shareOfFed);
        const provPart = scaledUnit(provSrc, pair.shareOfProv);
        if (fedPart.total < minVotes || provPart.total < minVotes) continue;
        rows.push({
          key: `${pair.fi}|${pair.pi}`,
          label: `${labels.fed(pair.fi)} x ${labels.prov(pair.pi)}`,
          fed: fedPart, prov: provPart,
          fedIndex: pair.fi, provIndex: pair.pi,
          weight: Math.min(fedPart.total, provPart.total),
        });
      }
      return rows;
    }
    const toProv = unit === 'prov';
    const moved = redistribute(pairs, toProv ? fedValues : provValues,
      { from: toProv ? 'fed' : 'prov' });
    const native = toProv ? provValues : fedValues;
    for (const [idx, nativeUnit] of native) {
      const movedUnit = moved.get(idx);
      if (!movedUnit) continue;
      const fedUnit = toProv ? movedUnit : nativeUnit;
      const provUnit = toProv ? nativeUnit : movedUnit;
      if (fedUnit.total < minVotes || provUnit.total < minVotes) continue;
      rows.push({
        key: String(idx),
        label: toProv ? labels.prov(idx) : labels.fed(idx),
        fed: fedUnit, prov: provUnit,
        fedIndex: toProv ? null : idx, provIndex: toProv ? idx : null,
        weight: Math.min(fedUnit.total, provUnit.total),
      });
    }
    return rows;
  }

  /* Move a per-feature variable from one side of a crosswalk to the other.

     `redistribute` above moves election counts, and it is right to sum those:
     half a poll's votes go with half the poll. A census variable cannot always
     be treated that way. A population may be summed, but a percentage, a rate
     or a median may not -- adding two medians is meaningless -- so those come
     back as a mean over the source areas, weighted by the mass the crosswalk
     assigns to each overlap (population where the lattice was weighted by it,
     ground area otherwise).

     kind: 'count' sums, anything else takes the weighted mean.
     Targets with no source value at all are absent from the result rather than
     zero, so a missing value stays missing. */
  function moveVariable(pairs, values, options = {}) {
    const from = options.from === 'b' || options.from === 'prov' ? 'b' : 'a';
    const to = from === 'a' ? 'b' : 'a';
    const out = new Map();
    if (options.kind === 'count') {
      for (const p of pairs) {
        const v = values.get(pairIndex(p, from));
        if (v == null || !isFinite(v)) continue;
        const dst = pairIndex(p, to);
        out.set(dst, (out.get(dst) || 0) + v * pairShare(p, from));
      }
      return out;
    }
    const num = new Map(), den = new Map();
    const plainSum = new Map(), plainN = new Map();
    for (const p of pairs) {
      const v = values.get(pairIndex(p, from));
      if (v == null || !isFinite(v)) continue;
      const dst = pairIndex(p, to);
      const w = p.count;
      if (w > 0) {
        num.set(dst, (num.get(dst) || 0) + v * w);
        den.set(dst, (den.get(dst) || 0) + w);
      }
      /* Kept for the case below: every overlap of this target weighs nothing,
         which happens to a target made only of unpopulated areas under
         population weighting. A plain mean of the values that are there beats
         reporting nothing at all. */
      plainSum.set(dst, (plainSum.get(dst) || 0) + v);
      plainN.set(dst, (plainN.get(dst) || 0) + 1);
    }
    for (const [dst, n] of plainN) {
      const d = den.get(dst) || 0;
      out.set(dst, d > 0 ? num.get(dst) / d : plainSum.get(dst) / n);
    }
    return out;
  }

  /* Statistics for any set of (x, y, weight) points. */
  /* points may carry `group`: the independent source each one came from. When
     a provincial result is spread from one voting place across the five areas
     of its catchment, those five points are one measurement, not five, and an
     interval computed on the nominal n would be far too narrow. The effective
     n is the number of distinct groups, and it is what `ci` uses. Without
     groups the two are the same and nothing changes. */
  function correlateXY(pts, options = {}) {
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y), ws = pts.map((p) => p.weight);
    const r = pearson(xs, ys);
    const keys = options.groups || pts.map((p) => p.group);
    const distinct = new Set();
    let grouped = false;
    for (const k of keys) if (k != null) { grouped = true; distinct.add(k); }
    const nEffective = grouped ? distinct.size : pts.length;
    return {
      points: pts,
      n: pts.length,
      nEffective,
      grouped,
      r,
      rWeighted: pearson(xs, ys, ws),
      rho: spearman(xs, ys),
      fit: linearFit(xs, ys),
      fitWeighted: linearFit(xs, ys, ws),
      ci: pearsonCI(r, nEffective),
      ciNominal: pearsonCI(r, pts.length),
      totalWeight: ws.reduce((a, b) => a + b, 0),
    };
  }

  /* Turn comparison rows into plot points plus the statistics for one pairing. */
  function correlate(rows, fedParty, provParty, options = {}) {
    const groupOf = options.groupOf || (() => null);
    const pts = [];
    for (const row of rows) {
      const x = shareOf(row.fed, fedParty), y = shareOf(row.prov, provParty);
      if (x == null || y == null) continue;
      pts.push({ x, y, weight: row.weight, label: row.label, key: row.key, group: groupOf(row) });
    }
    return correlateXY(pts);
  }


  /* --- Putting a correlation into words ------------------------------------

     An r and a CI are precise and, to most of the people this atlas is for,
     mute. This turns a correlateXY result into the pieces of a plain sentence,
     and it lives here, next to the maths, so the words cannot drift from the
     numbers they describe and so the bands can be tested.

     What it deliberately does NOT produce is a verb of cause. "Went with" and
     "tended to be" are the strongest forms available; an area-level
     correlation cannot support "drove", "led to" or "because", and a summary
     that a reader can quote is exactly where that would get lost.

     The strength bands are conventional, and stated rather than implied:
     under 0.1 essentially none, to 0.3 weak, to 0.5 moderate, to 0.7 strong,
     above that very strong. */
  const STRENGTH = [[0.1, 'essentially no'], [0.3, 'a weak'], [0.5, 'a moderate'],
                    [0.7, 'a strong'], [Infinity, 'a very strong']];

  function describeCorrelation(result) {
    if (!result || result.r == null || !isFinite(result.r)) return null;
    const r = result.r;
    const strength = STRENGTH.find(([lim]) => Math.abs(r) < lim)[1];
    const ci = result.ci && isFinite(result.ci[0]) && isFinite(result.ci[1]) ? result.ci : null;
    /* A confidence interval that straddles zero does not rule out "no
       relationship at all", and saying so is the whole point of showing one. */
    const spansZero = ci ? ci[0] <= 0 && ci[1] >= 0 : null;
    const slope = result.fit && isFinite(result.fit.slope) ? result.fit.slope : null;
    return {
      r,
      strength,
      /* Which way y goes as x rises. Flat when there is essentially nothing. */
      direction: strength === 'essentially no' ? 'flat' : (r < 0 ? 'lower' : 'higher'),
      /* The raw fitted slope. Turning it into "N points of y per 10 points of x"
         is the CALLER's job, because it is only that when both axes are shares
         in the same units: the census variables are percentages 0-100 while
         turnout is a share 0-1, and a sentence that got that wrong would be
         worse than no sentence. */
      slope,
      ci,
      spansZero,
      sources: result.nEffective ?? result.n ?? null,
      units: result.n ?? null,
      /* True when one measurement was shared over several map units, which is
         the difference between the two counts and the reason the interval is
         as wide as it is. */
      shared: Boolean(result.grouped) && (result.nEffective ?? 0) < (result.n ?? 0),
    };
  }
  return {
    sampleLattice, pointWeights, crosswalkBetween, pairShare, pairIndex,
    crosswalkRunner, crosswalkPairs, coverage, redistribute, repairSmallFeatures,
    emptyUnit, addScaled, scaledUnit,
    pearson, spearman, rankOf, linearFit, pearsonCI,
    comparisonRows, correlate, correlateXY, shareOf, moveVariable,
    describeCorrelation,
  };
})();
