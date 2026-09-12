/* ---------------------------------------------------------------------------
   Results: read a poll-by-poll results table, work out which columns carry the
   join key, party and votes, then join it to a boundary layer and say plainly
   how well the join went.

   A silent bad join is the worst outcome here -- it produces a correlation
   that looks fine and means nothing -- so every join returns a match report
   that the interface shows whether or not it is asked to.
--------------------------------------------------------------------------- */
const Results = (() => {

  /* --- Key normalisation ------------------------------------------------- */

  const stripZeros = (s) => s.replace(/^0+(?=\d)/, '');

  function normalizePart(value, { ignoreLeadingZeros = true, ignoreCase = true } = {}) {
    let s = String(value == null ? '' : value).trim();
    if (ignoreCase) s = s.toUpperCase();
    s = s.replace(/\s+/g, ' ');
    if (ignoreLeadingZeros) s = stripZeros(s);
    return s;
  }

  const makeKey = (parts, opts) => parts.map((p) => normalizePart(p, opts)).join('~');

  /* Elections Canada writes a polling division as a number plus an optional
     letter suffix; the boundary file stores that suffix as a digit. */
  const SUFFIX_LETTERS = ['', 'A', 'B', 'C', 'D', 'E', 'F', 'G'];

  function federalPollVariants(pollField) {
    const [num, suffix] = String(pollField).split('-');
    const variants = new Set([String(pollField)]);
    variants.add(num);
    const n = parseInt(suffix, 10);
    if (isFinite(n)) {
      if (n === 0) variants.add(num);
      if (SUFFIX_LETTERS[n]) variants.add(num + SUFFIX_LETTERS[n]);
      variants.add(num + '-' + n);
    }
    return [...variants];
  }

  /* --- Column detection -------------------------------------------------- */

  const PATTERNS = {
    district: [/electoral district number/i,
               /\bed[_ ]?(number|num|code|id|name|abbr|abbrev)\b/i,
               /district.*(number|code|id|name)/i, /\bfed(num|_num|eral)?\b/i,
               /circonscription/i, /electoral district/i, /\bdistrict\b/i,
               /\briding\b/i, /^ed$/i],
    poll: [/polling station number/i, /polling division/i, /voting area.*(number|code|id)/i,
           /\bva[_ ]?(number|num|code|id)\b/i, /\bpd[_ ]?(number|num)\b/i,
           /bureau de scrutin/i, /\bpoll\b/i, /voting area/i, /\bballot box\b/i],
    party: [/political affiliation name_english/i, /political affiliation/i,
            /appartenance politique/i, /\bparty\b/i, /affiliation/i, /candidate.*party/i],
    votes: [/candidate poll votes count/i, /votes du candidat/i,
            /\bvotes?\b.*\bcount\b/i, /\btotal votes\b/i, /\bvotes\b/i, /\bballots cast\b/i],
    electors: [/electors for polling station/i, /\belectors\b/i, /électeurs/i, /registered voters/i],
    rejected: [/rejected ballots/i, /bulletins rejet/i, /\brejected\b/i],
    candidate: [/candidate.*family name/i, /nom de famille/i, /candidate/i],
  };

  function detectColumn(header, kind) {
    for (const re of PATTERNS[kind] || []) {
      const i = header.findIndex((h) => re.test(h));
      if (i >= 0) return i;
    }
    return -1;
  }

  /* Party columns in a wide table are the numeric ones that are not obviously
     a key, a count of electors, or a percentage. */
  function detectWideParties(header, rows) {
    const skip = /number|code|\bid\b|name|district|riding|poll|voting area|elector|voters?|registered|reject|spoil|total|turnout|percent|%|address|station|latitude|longitude/i;
    const out = [];
    header.forEach((h, i) => {
      if (!h || skip.test(h)) return;
      let numeric = 0, seen = 0;
      for (const row of rows.slice(0, 40)) {
        const v = (row[i] || '').trim();
        if (v === '') continue;
        seen++;
        if (/^-?[\d,]+(\.\d+)?$/.test(v)) numeric++;
      }
      if (seen >= 1 && numeric / seen > 0.9) out.push(i);
    });
    return out;
  }

  /* Long format has one row per candidate per poll: a party column and a votes
     column. Wide format has one row per poll and a column per party. */
  function detectLayout(header, rows) {
    const party = detectColumn(header, 'party');
    const votes = detectColumn(header, 'votes');
    if (party >= 0 && votes >= 0) {
      return {
        layout: 'long',
        district: detectColumn(header, 'district'),
        poll: detectColumn(header, 'poll'),
        party, votes,
        electors: detectColumn(header, 'electors'),
        rejected: detectColumn(header, 'rejected'),
      };
    }
    return {
      layout: 'wide',
      district: detectColumn(header, 'district'),
      poll: detectColumn(header, 'poll'),
      partyColumns: detectWideParties(header, rows),
      electors: detectColumn(header, 'electors'),
      rejected: detectColumn(header, 'rejected'),
    };
  }

  const toNumber = (v) => {
    const n = parseFloat(String(v == null ? '' : v).replace(/[,\s$]/g, ''));
    return isFinite(n) ? n : 0;
  };

  /* --- Aggregating a table into per-poll results ------------------------- */

  /* Returns Map key -> { total, parties, electors, rejected, rows } where key
     is built from the chosen district and poll columns. */
  function aggregate(table, mapping, keyOpts) {
    const { header, rows } = table;
    const out = new Map();
    let skipped = 0, totalVotes = 0;
    const get = (row, i) => (i >= 0 && i < row.length ? row[i] : '');

    for (const row of rows) {
      const parts = [];
      if (mapping.district >= 0) parts.push(get(row, mapping.district));
      parts.push(get(row, mapping.poll));
      if (parts.every((p) => String(p).trim() === '')) { skipped++; continue; }
      const key = makeKey(parts, keyOpts);
      let unit = out.get(key);
      if (!unit) {
        out.set(key, (unit = {
          total: 0, parties: new Map(), electors: 0, rejected: 0, rows: 0,
          district: mapping.district >= 0 ? String(get(row, mapping.district)).trim() : '',
          poll: String(get(row, mapping.poll)).trim(),
        }));
      }
      unit.rows++;
      if (mapping.layout === 'long') {
        const party = String(get(row, mapping.party)).trim();
        const votes = toNumber(get(row, mapping.votes));
        if (party) {
          unit.parties.set(party, (unit.parties.get(party) || 0) + votes);
          unit.total += votes;
          totalVotes += votes;
        }
      } else {
        for (const i of mapping.partyColumns) {
          const votes = toNumber(get(row, i));
          const party = header[i];
          unit.parties.set(party, (unit.parties.get(party) || 0) + votes);
          unit.total += votes;
          totalVotes += votes;
        }
      }
      /* Electors and rejected ballots repeat on every candidate row, so take
         the largest value seen rather than summing. */
      if (mapping.electors >= 0) unit.electors = Math.max(unit.electors, toNumber(get(row, mapping.electors)));
      if (mapping.rejected >= 0) unit.rejected = Math.max(unit.rejected, toNumber(get(row, mapping.rejected)));
    }
    return { units: out, skipped, totalVotes };
  }

  /* --- Joining results to a boundary layer ------------------------------- */

  /* Builds, for each feature, the list of key spellings that should match it.
     Federal polling divisions get their suffix variants as well. */
  function featureKeys(features, keyDef, keyOpts) {
    const list = [];
    for (const f of features) {
      const p = f.properties || {};
      const districtPart = keyDef.district ? p[keyDef.district] : null;
      const pollRaw = keyDef.poll ? p[keyDef.poll] : '';
      const variants = keyDef.federalSuffixes
        ? federalPollVariants(pollRaw)
        : [String(pollRaw == null ? '' : pollRaw)];
      list.push(variants.map((v) =>
        makeKey(keyDef.district ? [districtPart, v] : [v], keyOpts)));
    }
    return list;
  }

  /* Tries the plausible key spellings and keeps whichever matches most votes,
     so a leading-zero or case difference does not quietly halve the sample. */
  /* focus, when given, is the set of feature indices the user is actually
     studying. Results still join to every feature, but the match rate is
     reported against the focus -- loading one riding's results should not read
     as a 90% failure just because the boundary file spans a whole region. */
  function join(features, keyDef, table, mapping, focus) {
    const attempts = [];
    for (const ignoreLeadingZeros of [true, false]) {
      const keyOpts = { ignoreLeadingZeros, ignoreCase: true };
      const agg = aggregate(table, mapping, keyOpts);
      const keys = featureKeys(features, keyDef, keyOpts);
      const values = new Map();
      const usedKeys = new Set();
      let matchedFeatures = 0, matchedVotes = 0;
      keys.forEach((variants, i) => {
        for (const k of variants) {
          const unit = agg.units.get(k);
          if (unit) {
            values.set(i, unit);
            usedKeys.add(k);
            matchedFeatures++;
            matchedVotes += unit.total;
            return;
          }
        }
      });
      attempts.push({ keyOpts, agg, values, usedKeys, matchedFeatures, matchedVotes });
    }
    attempts.sort((a, b) => b.matchedVotes - a.matchedVotes || b.matchedFeatures - a.matchedFeatures);
    const best = attempts[0];

    const inFocus = (i) => !focus || focus.has(i);
    const unmatchedFeatures = [];
    let focusCount = 0, focusMatched = 0;
    features.forEach((f, i) => {
      if (!inFocus(i)) return;
      focusCount++;
      if (best.values.has(i)) focusMatched++; else unmatchedFeatures.push(i);
    });
    const unmatchedRows = [];
    for (const [k, unit] of best.agg.units) {
      if (!best.usedKeys.has(k)) unmatchedRows.push({ key: k, unit });
    }
    unmatchedRows.sort((a, b) => b.unit.total - a.unit.total);

    const parties = new Map();
    for (const unit of best.values.values()) {
      for (const [party, votes] of unit.parties) {
        parties.set(party, (parties.get(party) || 0) + votes);
      }
    }
    return {
      values: best.values,
      keyOpts: best.keyOpts,
      parties: [...parties.entries()].sort((a, b) => b[1] - a[1]),
      report: {
        features: focusCount,
        matchedFeatures: focusMatched,
        matchedOutsideFocus: best.matchedFeatures - focusMatched,
        totalFeatures: features.length,
        tableUnits: best.agg.units.size,
        matchedVotes: best.matchedVotes,
        tableVotes: best.agg.totalVotes,
        unmatchedFeatures,
        unmatchedRows: unmatchedRows.slice(0, 12),
        unmatchedRowCount: unmatchedRows.length,
        unmatchedVotes: best.agg.totalVotes - best.matchedVotes,
        ignoredLeadingZeros: best.keyOpts.ignoreLeadingZeros,
      },
    };
  }

  /* Which property of a loaded layer most likely holds the district or the
     voting-area identifier. */
  function suggestKeyProperties(features) {
    const sample = features.slice(0, 400);
    const names = new Set();
    for (const f of sample) for (const k of Object.keys(f.properties || {})) names.add(k);
    const score = (name, kind) => {
      const pats = PATTERNS[kind] || [];
      for (let i = 0; i < pats.length; i++) if (pats[i].test(name)) return pats.length - i;
      return 0;
    };
    const uniqueness = (name) => {
      const seen = new Set();
      for (const f of sample) seen.add(String((f.properties || {})[name]));
      return seen.size / Math.max(1, sample.length);
    };
    const all = [...names];
    const best = (kind, extra = () => 0) => {
      let pick = null, bestScore = 0;
      for (const n of all) {
        const s = score(n, kind) * 10 + extra(n);
        if (s > bestScore) { bestScore = s; pick = n; }
      }
      return pick;
    };
    return {
      district: best('district'),
      poll: best('poll', (n) => uniqueness(n) * 3),
      properties: all,
    };
  }

  return {
    normalizePart, makeKey, federalPollVariants, detectColumn, detectLayout,
    detectWideParties, aggregate, join, featureKeys, suggestKeyProperties, toNumber,
  };
})();
