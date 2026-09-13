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

  /* Elections Canada splits a busy polling division on the day: poll 10 is
     reported as 10A and 10B. The boundary file still draws one polygon for it,
     numbered 10-0, and neither half matches that. Left alone both halves read
     as polls with no boundary, and the polygon reads as a poll with no result.

     They share one polygon because they are one polling division, so they are
     pooled back into it -- but only when the file carries no row for the
     parent itself, so a file that already reports both is never double
     counted. Electors add: the halves split the division's list between them.

     Returns the number of parents synthesised. */
  function poolSplitPolls(units, keyOpts) {
    const groups = new Map();
    for (const unit of units.values()) {
      const m = /^(\d+)\s*[A-Za-z]$/.exec(String(unit.poll == null ? '' : unit.poll).trim());
      if (!m) continue;
      const key = makeKey([unit.district, m[1]], keyOpts);
      if (units.has(key)) continue;
      if (!groups.has(key)) groups.set(key, { poll: m[1], list: [] });
      groups.get(key).list.push(unit);
    }
    let pooled = 0;
    for (const [key, { poll, list }] of groups) {
      /* A lone half is still the whole division: its sibling may be a mobile
         referral with no votes of its own, and the polygon is still this one. */
      const acc = {
        total: 0, parties: new Map(), electors: 0, rejected: 0, rows: 0,
        district: list[0].district, poll, mergeWith: '',
        flags: { void: list.every((u) => u.flags.void), noPoll: list.every((u) => u.flags.noPoll) },
        mergedGroup: null, splitFrom: list.map((u) => u.poll),
      };
      for (const u of list) {
        acc.total += u.total;
        acc.electors += u.electors;
        acc.rejected += u.rejected;
        acc.rows += u.rows;
        for (const [party, v] of u.parties) acc.parties.set(party, (acc.parties.get(party) || 0) + v);
      }
      units.set(key, acc);
      /* The halves are not units of their own any more -- their votes, their
         electors and their rows now live in the parent. Leaving them behind
         would count every split poll twice: once on its polygon and once as a
         poll that has none. */
      for (const u of list) {
        for (const [k2, v] of units) if (v === u) { units.delete(k2); break; }
      }
      pooled++;
    }
    return pooled;
  }

  /* --- Column detection -------------------------------------------------- */

  const PATTERNS = {
    district: [/electoral district number/i,
               /\bed[_ ]?(number|num|code|id|name|abbr|abbrev|abbreviation)\b/i,
               /electoral district (abbreviation|abbrev|code)/i,
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
    electors: [/electors for polling station/i, /\belectors\b/i, /électeurs/i,
               /registered voters/i, /\bregistered\b/i],
    rejected: [/rejected ballots/i, /bulletins rejet/i, /\brejected\b/i, /spoil/i],
    candidate: [/candidate.*family name/i, /nom de famille/i, /candidate/i],
    /* Elections Canada bookkeeping columns. A merged poll reports its votes
       under another poll; a void poll or a poll where no vote was held has
       none at all. Turnout is wrong for all three unless they are recognised. */
    /* Elections Canada wrote "Merge With/Fusionne avec" for years and
       "Combined with No./Resultats combines a ceux du n" in 2025. Both name
       the poll whose count absorbed this one. */
    mergeWith: [/merge with/i, /merged with/i, /combined with/i,
                /fusionn/i, /r[ée]sultats combin/i],
    voidPoll: [/void poll/i, /bureau supprim/i],
    noPoll: [/no poll held/i, /sans scrutin/i],
  };

  const isYes = (v) => /^(y|yes|1|true|o|oui|x)$/i.test(String(v == null ? '' : v).trim());

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
        mergeWith: detectColumn(header, 'mergeWith'),
        voidPoll: detectColumn(header, 'voidPoll'),
        noPoll: detectColumn(header, 'noPoll'),
      };
    }
    return {
      layout: 'wide',
      district: detectColumn(header, 'district'),
      poll: detectColumn(header, 'poll'),
      partyColumns: detectWideParties(header, rows),
      electors: detectColumn(header, 'electors'),
      rejected: detectColumn(header, 'rejected'),
      mergeWith: detectColumn(header, 'mergeWith'),
      voidPoll: detectColumn(header, 'voidPoll'),
      noPoll: detectColumn(header, 'noPoll'),
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
          mergeWith: '', flags: { void: false, noPoll: false }, mergedGroup: null,
        }));
      }
      unit.rows++;
      if (mapping.mergeWith >= 0) {
        const m = String(get(row, mapping.mergeWith)).trim();
        if (m && !/^(n|no|0|-)$/i.test(m)) unit.mergeWith = m;
      }
      if (mapping.voidPoll >= 0 && isYes(get(row, mapping.voidPoll))) unit.flags.void = true;
      if (mapping.noPoll >= 0 && isYes(get(row, mapping.noPoll))) unit.flags.noPoll = true;
      if (unit.flags.void || unit.flags.noPoll) continue;
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

  /* Elections Canada reports a merged poll's ballots under the poll it was
     merged into, so the receiving poll's votes cover two polls' electors and
     its turnout comes out inflated while the absorbed poll shows none. Pool
     each merge group and spread the pooled ballots back over the members in
     proportion to their own electors: every member then carries the same
     turnout, which is the only defensible figure for a poll counted as one.
     A member whose elector count was itself rolled into the receiver (0 on its
     own row) simply takes no votes, which handles both bookkeeping styles. */
  function resolveMerges(units, keyOpts) {
    const byKey = units;
    const rootOf = (key, seen = new Set()) => {
      const u = byKey.get(key);
      if (!u || !u.mergeWith || seen.has(key)) return key;
      seen.add(key);
      for (const v of federalPollVariants(u.mergeWith)) {
        const k = makeKey(u.district ? [u.district, v] : [v], keyOpts);
        if (byKey.has(k) && k !== key) return rootOf(k, seen);
      }
      return null; // names a poll that is not in the table
    };
    const groups = new Map();
    const unresolved = [];
    for (const [key, u] of byKey) {
      if (!u.mergeWith) continue;
      const root = rootOf(key);
      if (root === null) { unresolved.push({ key, mergeWith: u.mergeWith }); continue; }
      if (!groups.has(root)) groups.set(root, new Set([root]));
      groups.get(root).add(key);
    }
    for (const [root, members] of groups) {
      const list = [...members].map((k) => byKey.get(k));
      const electors = list.reduce((a, u) => a + u.electors, 0);
      if (!(electors > 0)) continue;
      const total = list.reduce((a, u) => a + u.total, 0);
      const rejected = list.reduce((a, u) => a + u.rejected, 0);
      const parties = new Map();
      for (const u of list) for (const [p, v] of u.parties) parties.set(p, (parties.get(p) || 0) + v);
      for (const u of list) {
        const share = u.electors / electors;
        u.total = total * share;
        u.rejected = rejected * share;
        u.parties = new Map([...parties].map(([p, v]) => [p, v * share]));
        u.mergedGroup = root;
      }
    }
    return { groups: groups.size, unresolved };
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
  /* inArea, when given, is the set of features inside the study area as a
     matter of geography. It is not the same thing as focus: focus is what the
     reader is looking at, and it narrows when mobile polls are hidden, which
     is a display choice. Apportionment must not move when a checkbox does, so
     the in-area share below is computed from inArea and defaults to focus only
     when no separate study area was given. */
  function join(features, keyDef, table, mapping, focus, inArea) {
    const attempts = [];
    for (const ignoreLeadingZeros of [true, false]) {
      const keyOpts = { ignoreLeadingZeros, ignoreCase: true };
      const agg = aggregate(table, mapping, keyOpts);
      /* Merges first, pooling second. A row can name a half as its merge target
         -- "combined with No. 1A" -- and pooling 1A into 1 before that is read
         would leave the reference dangling. Resolved in this order the votes
         land on 1A and are then carried into 1 with it. */
      agg.merges = mapping.mergeWith >= 0
        ? resolveMerges(agg.units, keyOpts) : { groups: 0, unresolved: [] };
      agg.splitPolls = keyDef && keyDef.federalSuffixes ? poolSplitPolls(agg.units, keyOpts) : 0;
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
    const inStudyArea = (i) => (inArea ? inArea.has(i) : inFocus(i));
    const unmatchedFeatures = [];
    let focusCount = 0, focusMatched = 0;
    features.forEach((f, i) => {
      if (!inFocus(i)) return;
      focusCount++;
      if (best.values.has(i)) focusMatched++; else unmatchedFeatures.push(i);
    });
    /* Elections Canada numbers ordinary polls below 500, mobile polls from 500
       and advance polls from 600. So an unmatched row carrying an ordinary
       number is a poll that ought to have a polygon and has none: a gap in the
       boundary file, which for a riding clipped to a study area means the poll
       sits outside it. An unmatched row numbered 500 or above, or not numbered
       at all, has no geography by nature and is the district's to spread.

       Only the Elections Canada numbering is read this way. Any other key
       spelling parses as NaN and falls through to riding-wide, which is what
       every other file did before this existed. */
    const ORDINARY_BELOW = 500;
    const isOrdinaryPoll = (unit) => {
      if (!keyDef || !keyDef.federalSuffixes) return false;
      const n = parseInt(String(unit.poll == null ? '' : unit.poll).replace(/[^0-9].*$/, ''), 10);
      return isFinite(n) && n > 0 && n < ORDINARY_BELOW;
    };

    const unmatchedRows = [];
    /* Riding-wide rows, by district, so the votes that have no polygon -- in
       practice advance polls and special ballots -- can be apportioned back
       onto the district's mapped polls. Void and no-poll rows carry nothing. */
    const unmatchedByDistrict = new Map();
    /* Ordinary polls with no boundary at all, kept apart: they are not the
       district's to spread, because they were cast somewhere the study area
       does not cover. */
    const noPolygonByDistrict = new Map();
    let voidPolls = 0, noPollUnits = 0, noPolygonUnits = 0, noPolygonVotes = 0;
    const into = (m, d, unit) => {
      let acc = m.get(d);
      if (!acc) m.set(d, (acc = { total: 0, rejected: 0, electors: 0, parties: new Map(), units: 0 }));
      acc.total += unit.total;
      acc.rejected += unit.rejected;
      acc.electors += unit.electors || 0;
      acc.units++;
      for (const [p, v] of unit.parties) acc.parties.set(p, (acc.parties.get(p) || 0) + v);
    };
    for (const [k, unit] of best.agg.units) {
      if (unit.flags.void) voidPolls++;
      if (unit.flags.noPoll) noPollUnits++;
      if (best.usedKeys.has(k)) continue;
      unmatchedRows.push({ key: k, unit });
      if (unit.flags.void || unit.flags.noPoll) continue;
      const d = normalizePart(unit.district, best.keyOpts);
      if (isOrdinaryPoll(unit)) {
        noPolygonUnits++;
        noPolygonVotes += unit.total + unit.rejected;
        into(noPolygonByDistrict, d, unit);
      } else {
        into(unmatchedByDistrict, d, unit);
      }
    }

    /* How much of each district's electorate sits inside the study area. A
       district wholly inside has a share of 1 and nothing downstream changes
       for it; one that straddles the edge has its advance ballots scaled to
       the part that is actually on screen.

       Merged polls share one unit between two features, so a unit is counted
       once, on the side of whichever feature is seen first. Merged polls are
       adjacent, so that only matters for a pair split by the study boundary. */
    const electorsInArea = new Map(), electorsOutside = new Map();
    const counted = new Set();
    /* Ballots cast outside the study area: on a polygon that is outside it, or
       at an ordinary poll the boundary file does not cover. The Results tab
       reports the file as loaded, so it needs this number to say how much of
       what it is showing the rest of the atlas leaves out. */
    let outOfAreaVotes = 0;
    best.values.forEach((unit, i) => {
      if (counted.has(unit)) return;
      counted.add(unit);
      const d = normalizePart(unit.district, best.keyOpts);
      const inside = inStudyArea(i);
      const m = inside ? electorsInArea : electorsOutside;
      m.set(d, (m.get(d) || 0) + (unit.electors || 0));
      if (!inside) outOfAreaVotes += unit.total + unit.rejected;
    });
    outOfAreaVotes += noPolygonVotes;
    for (const [d, acc] of noPolygonByDistrict) {
      electorsOutside.set(d, (electorsOutside.get(d) || 0) + acc.electors);
    }
    const inAreaShare = new Map();
    const straddling = [];
    for (const d of new Set([...electorsInArea.keys(), ...electorsOutside.keys()])) {
      const inside = electorsInArea.get(d) || 0, outside = electorsOutside.get(d) || 0;
      const share = inside + outside > 0 ? inside / (inside + outside) : 1;
      inAreaShare.set(d, share);
      if (share < 0.999 && share > 0) straddling.push({ district: d, share, inside, outside });
    }
    straddling.sort((a, b) => a.share - b.share);
    unmatchedRows.sort((a, b) => b.unit.total - a.unit.total);
    let electorsMatched = 0;
    for (const unit of new Set(best.values.values())) electorsMatched += unit.electors;

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
        splitPolls: best.agg.splitPolls || 0,
        matchedVotes: best.matchedVotes,
        tableVotes: best.agg.totalVotes,
        unmatchedFeatures,
        unmatchedRows: unmatchedRows.slice(0, 12),
        unmatchedRowCount: unmatchedRows.length,
        unmatchedVotes: best.agg.totalVotes - best.matchedVotes,
        unmatchedByDistrict,
        noPolygonByDistrict,
        noPolygonUnits,
        noPolygonVotes,
        outOfAreaVotes,
        inAreaShare,
        straddling,
        electorsMatched,
        electorsColumn: mapping.electors >= 0,
        mergedGroups: best.agg.merges.groups,
        mergeUnresolved: best.agg.merges.unresolved,
        voidPolls,
        noPollUnits,
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
    detectWideParties, aggregate, resolveMerges, join, featureKeys,
    suggestKeyProperties, toNumber, isYes,
  };
})();
