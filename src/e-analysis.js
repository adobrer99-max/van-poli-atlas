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

  /* --- Crosswalk --------------------------------------------------------- */

  /* Runs as a generator so the caller can keep the page responsive; each
     next() processes one band of lattice rows and reports progress. */
  function* crosswalkRunner(fedFeatures, provFeatures, options = {}) {
    const spacingM = options.spacingM || 40;
    const fedIndex = options.fedIndex || Geo.buildIndex(fedFeatures);
    const provIndex = options.provIndex || Geo.buildIndex(provFeatures);
    if (!fedIndex.extent || !provIndex.extent) {
      return { cells: new Map(), fedCount: [], provCount: [], spacingM, points: 0, hits: 0 };
    }
    /* Only the overlap of the two layers can contribute. */
    const minX = Math.max(fedIndex.extent[0], provIndex.extent[0]);
    const minY = Math.max(fedIndex.extent[1], provIndex.extent[1]);
    const maxX = Math.min(fedIndex.extent[2], provIndex.extent[2]);
    const maxY = Math.min(fedIndex.extent[3], provIndex.extent[3]);
    const cells = new Map();
    const fedCount = new Float64Array(fedFeatures.length);
    const provCount = new Float64Array(provFeatures.length);
    /* Points that landed in both layers, so a poll only partly covered by the
       other geography can be flagged rather than silently extrapolated. */
    const fedBoth = new Float64Array(fedFeatures.length);
    const provBoth = new Float64Array(provFeatures.length);
    let points = 0, hits = 0, bothHits = 0;

    if (!(maxX > minX && maxY > minY)) {
      return { cells, fedCount, provCount, fedBoth, provBoth, spacingM,
               points, hits, bothHits, overlap: false, extent: null,
               nProv: provFeatures.length };
    }
    const dLat = spacingM / 110574;
    const rows = Math.max(1, Math.ceil((maxY - minY) / dLat));
    const rowsPerStep = Math.max(1, Math.ceil(rows / 60));

    for (let r0 = 0; r0 < rows; r0 += rowsPerStep) {
      for (let r = r0; r < Math.min(rows, r0 + rowsPerStep); r++) {
        const lat = minY + (r + 0.5) * dLat;
        /* Widen the longitude step with latitude so every sample point stands
           for the same ground area. */
        const dLon = spacingM / (111320 * Math.cos(lat * Math.PI / 180));
        for (let x = minX + dLon / 2; x <= maxX; x += dLon) {
          points++;
          const fi = fedIndex.hit(x, lat);
          const pi = provIndex.hit(x, lat);
          if (fi < 0 && pi < 0) continue;
          hits++;
          if (fi >= 0) fedCount[fi]++;
          if (pi >= 0) provCount[pi]++;
          if (fi >= 0 && pi >= 0) {
            bothHits++;
            fedBoth[fi]++;
            provBoth[pi]++;
            const key = fi * provFeatures.length + pi;
            cells.set(key, (cells.get(key) || 0) + 1);
          }
        }
      }
      yield Math.min(1, (r0 + rowsPerStep) / rows);
    }
    return { cells, fedCount, provCount, fedBoth, provBoth, spacingM,
             points, hits, bothHits, overlap: true,
             extent: [minX, minY, maxX, maxY], nProv: provFeatures.length };
  }

  /* Lattice sampling breaks down for very small polygons. Elections Canada
     mobile polls (type M) and single-building polls (type S) are only metres
     across, so a 25 m lattice may miss them entirely and their votes would
     vanish from the analysis -- exactly the dense downtown and care-home polls
     that matter most. Any feature the lattice barely saw is instead assigned
     whole to the unit containing its representative interior point, with its
     true area as the weight so the other layer's shares stay proportional. */
  function repairSmallFeatures(cw, fedFeatures, provFeatures, indexes, minSamples = 6) {
    if (!cw.overlap) return { fed: [], prov: [] };
    const unit = cw.spacingM * cw.spacingM;
    const repaired = { fed: [], prov: [] };

    const cellsFor = (matches) => {
      const out = [];
      for (const key of cw.cells.keys()) if (matches(key)) out.push(key);
      return out;
    };

    fedFeatures.forEach((feature, fi) => {
      if (cw.fedCount[fi] >= minSamples) return;
      const pt = Geo.representativePoint(feature.geometry);
      if (!pt) return;
      const mass = Math.max(Geo.areaM2(feature.geometry) / unit, 1e-6);
      for (const key of cellsFor((k) => Math.floor(k / cw.nProv) === fi)) cw.cells.delete(key);
      const pi = indexes.prov.hit(pt[0], pt[1]);
      cw.fedCount[fi] = mass;
      cw.fedBoth[fi] = pi >= 0 ? mass : 0;
      if (pi >= 0) {
        cw.cells.set(fi * cw.nProv + pi, mass);
        if (cw.provCount[pi] < minSamples) cw.provCount[pi] = Math.max(cw.provCount[pi], mass);
      }
      repaired.fed.push(fi);
    });

    provFeatures.forEach((feature, pi) => {
      if (cw.provCount[pi] >= minSamples) return;
      const pt = Geo.representativePoint(feature.geometry);
      if (!pt) return;
      const mass = Math.max(Geo.areaM2(feature.geometry) / unit, 1e-6);
      const fi = indexes.fed.hit(pt[0], pt[1]);
      /* Leave alone anything the federal pass already pinned here. */
      if (fi >= 0 && repaired.fed.includes(fi)) return;
      for (const key of cellsFor((k) => k % cw.nProv === pi)) cw.cells.delete(key);
      cw.provCount[pi] = mass;
      cw.provBoth[pi] = fi >= 0 ? mass : 0;
      if (fi >= 0) cw.cells.set(fi * cw.nProv + pi, mass);
      repaired.prov.push(pi);
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
     inside. */
  function crosswalkPairs(cw, options = {}) {
    const minShare = options.minShare || 0;
    const raw = [];
    for (const [key, count] of cw.cells) {
      const fi = Math.floor(key / cw.nProv), pi = key % cw.nProv;
      raw.push({
        fi, pi, count,
        shareOfFed: cw.fedCount[fi] ? count / cw.fedCount[fi] : 0,
        shareOfProv: cw.provCount[pi] ? count / cw.provCount[pi] : 0,
      });
    }
    if (!minShare) return raw;

    const sum = (list, key, idx) => {
      const totals = new Map();
      for (const p of list) totals.set(p[idx], (totals.get(p[idx]) || 0) + p[key]);
      return totals;
    };
    const fedBefore = sum(raw, 'shareOfFed', 'fi');
    const provBefore = sum(raw, 'shareOfProv', 'pi');
    const kept = raw.filter((p) => p.shareOfFed >= minShare || p.shareOfProv >= minShare);
    const fedAfter = sum(kept, 'shareOfFed', 'fi');
    const provAfter = sum(kept, 'shareOfProv', 'pi');
    for (const p of kept) {
      const fScale = fedAfter.get(p.fi) > 0 ? fedBefore.get(p.fi) / fedAfter.get(p.fi) : 1;
      const pScale = provAfter.get(p.pi) > 0 ? provBefore.get(p.pi) / provAfter.get(p.pi) : 1;
      p.shareOfFed *= fScale;
      p.shareOfProv *= pScale;
    }
    return kept;
  }

  /* Fraction of each feature that lies inside the other layer at all. */
  const coverage = (cw) => ({
    fed: Array.from(cw.fedCount, (n, i) => (n ? cw.fedBoth[i] / n : 0)),
    prov: Array.from(cw.provCount, (n, i) => (n ? cw.provBoth[i] / n : 0)),
  });

  /* --- Vote redistribution ----------------------------------------------- */

  /* values: index -> { total, parties: Map }. Splits each source unit's votes
     across the target units in proportion to shared area. */
  function redistribute(pairs, values, { from }) {
    const shareKey = from === 'fed' ? 'shareOfFed' : 'shareOfProv';
    const sourceKey = from === 'fed' ? 'fi' : 'pi';
    const targetKey = from === 'fed' ? 'pi' : 'fi';
    const out = new Map();
    for (const pair of pairs) {
      const src = values.get(pair[sourceKey]);
      if (!src) continue;
      const w = pair[shareKey];
      if (!(w > 0)) continue;
      let acc = out.get(pair[targetKey]);
      if (!acc) out.set(pair[targetKey], (acc = { total: 0, parties: new Map() }));
      acc.total += src.total * w;
      for (const [party, votes] of src.parties) {
        acc.parties.set(party, (acc.parties.get(party) || 0) + votes * w);
      }
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
        const fedPart = { total: fedSrc.total * pair.shareOfFed, parties: new Map() };
        for (const [p, v] of fedSrc.parties) fedPart.parties.set(p, v * pair.shareOfFed);
        const provPart = { total: provSrc.total * pair.shareOfProv, parties: new Map() };
        for (const [p, v] of provSrc.parties) provPart.parties.set(p, v * pair.shareOfProv);
        if (fedPart.total < minVotes || provPart.total < minVotes) continue;
        rows.push({
          key: `${pair.fi}|${pair.pi}`,
          label: `${labels.fed(pair.fi)} x ${labels.prov(pair.pi)}`,
          fed: fedPart, prov: provPart,
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
        weight: Math.min(fedUnit.total, provUnit.total),
      });
    }
    return rows;
  }

  /* Turn comparison rows into plot points plus the statistics for one pairing. */
  function correlate(rows, fedParty, provParty) {
    const pts = [];
    for (const row of rows) {
      const x = shareOf(row.fed, fedParty), y = shareOf(row.prov, provParty);
      if (x == null || y == null) continue;
      pts.push({ x, y, weight: row.weight, label: row.label, key: row.key });
    }
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y), ws = pts.map((p) => p.weight);
    const r = pearson(xs, ys);
    return {
      points: pts,
      n: pts.length,
      r,
      rWeighted: pearson(xs, ys, ws),
      rho: spearman(xs, ys),
      fit: linearFit(xs, ys),
      fitWeighted: linearFit(xs, ys, ws),
      ci: pearsonCI(r, pts.length),
      totalWeight: ws.reduce((a, b) => a + b, 0),
    };
  }

  return {
    crosswalkRunner, crosswalkPairs, coverage, redistribute, repairSmallFeatures,
    pearson, spearman, rankOf, linearFit, pearsonCI,
    comparisonRows, correlate, shareOf,
  };
})();
