/* --- Who did not vote, and where --------------------------------------------

   Electors on a roll, minus ballots cast, per area. One subtraction, and
   almost everything here exists because that subtraction is easy to get
   plausibly wrong.

   THE TWO HALVES DO NOT ARRIVE THE SAME WAY. A roll of addresses is counted
   onto an area by point-in-polygon -- a genuine count on a geography the roll
   was never published for. Federal electors on a PROVINCIAL area are areally
   interpolated. Municipal ballots on any area are a kernel's output, not a
   count of anything that happened inside it. So each half records its route,
   a subtraction inherits the weaker of the two, and only counted minus counted
   is ever called a count in prose. A figure that mixes them is still useful;
   one that hides which it is, is not.

   NEGATIVE IS A RESULT, NOT AN ERROR. More ballots than roll electors means
   the roll does not describe the people who voted there -- a different
   vintage, a different franchise, a boundary that moved. It is the single
   best diagnostic this file produces and it is never clamped, because a
   clamped negative is a denominator error that has been hidden rather than
   found.

   AND IT WRITES TO ONE PLACE. Everything lands on row.g and nothing else:
   not t, not agg, not expected, not electors, not p. That is the discipline
   participation() in f2-turnout.js already keeps, for the same reason -- a
   modelled ratio must never reach something labelled turnout.  */
const Roll = (() => {

  /* Where an elector count can come from, and what it costs to move it.

     `adults` is deliberately absent. Census residents 15+ is not a roll:
     subtracting ballots from it puts 15-, 16- and 17-year-olds into a count of
     people who did not vote. It stays where it already is and is already
     labelled honestly, as participation()'s perAdult. */
  const ROLL_SOURCES = {
    fed:  { label: 'federal electors', vintage: '2025', native: 'fed' },
    prov: { label: 'provincial electors', vintage: '2024', native: 'prov' },
    muni: { label: 'municipal roll', vintage: '2026', native: null },
  };

  const BALLOT_SOURCES = {
    fed:  { label: 'federal ballots', vintage: '2025', native: 'fed' },
    prov: { label: 'provincial ballots', vintage: '2024', native: 'prov' },
    muni: { label: 'municipal ballots', vintage: '2022', native: null },
  };

  /* counted < interpolated < smoothed, weakest wins a subtraction. */
  const ROUTE_RANK = { counted: 0, interpolated: 1, smoothed: 2 };
  const weaker = (a, b) => (ROUTE_RANK[a] >= ROUTE_RANK[b] ? a : b);

  /* A roll that arrives as ADDRESSES is counted onto every layer directly,
     with no interpolation anywhere -- the one elector count in this atlas that
     is a genuine count on a geography it was not published for. A roll that
     arrives already attached to a geography is counted on that geography and
     interpolated everywhere else. */
  function routeOf(source, target, viaAddresses) {
    if (viaAddresses) return 'counted';
    const native = (ROLL_SOURCES[source] || BALLOT_SOURCES[source] || {}).native;
    if (native == null) return 'smoothed';
    return native === target ? 'counted' : 'interpolated';
  }

  /* --- The subtraction ---------------------------------------------------- */

  /* rows are Turnout.rowsOnUnit's, untouched. Everything written lands on
     row.g.

     rollOf and ballotsOf are the caller's: this module does not know how a
     layer indexes its features, and guessing has been a bug here before. Each
     returns a number or null, and null means absent rather than zero --
     an area the roll never mentions is not an area with no electors. */
  function gap(rows, options = {}) {
    const {
      roll, ballots, rollOf, ballotsOf,
      rollViaAddresses = false, target = 'fed', cappedIds = null, idOf = null,
      rollLabel = null, rollVintage = null, ballotRoute: ballotRouteGiven = null,
    } = options;
    if (!roll || !ballots || typeof rollOf !== 'function' || typeof ballotsOf !== 'function') {
      for (const row of rows) delete row.g;
      return rows;
    }
    const base = ROLL_SOURCES[roll] || { label: roll, vintage: '', native: null };
    /* The caller may name the roll instead, and must where the roll arrived as
       a file the atlas was handed rather than one it knows. ROLL_SOURCES.muni
       reads "2026 municipal roll", which is right for the file this was built
       for and a lie about any other file dropped in the same slot -- and a
       wrong vintage propagates straight into `coherent`. So a source with no
       native geography carries whatever the reader called it, with no vintage
       claimed unless one was given. */
    const rollMeta = { ...base,
      label: rollLabel || base.label,
      vintage: rollVintage != null ? rollVintage : base.vintage };
    const ballotMeta = BALLOT_SOURCES[ballots] || { label: ballots, vintage: '', native: null };
    const rollRoute = routeOf(roll, target, rollViaAddresses);
    /* The ballots side can be modelled even when its source is native to the
       target geography, and only the caller knows.

       routeOf answers one question: did these numbers have to be moved between
       geographies to get here. For a federal count on federal divisions the
       answer looks like a flat no -- the agency reported them there. But advance
       and special ballots are reported with no boundary at all, and apportioning
       them spreads them across divisions that never reported them. In the 2025
       federal file that is a majority of the ballots, so the subtraction stops
       being a count while its source column still says it is one.

       Apportionment is a setting on the Turnout tab, not a property of the
       source, so this module cannot see it. The caller says, or routeOf answers
       for the untouched case as before. */
    const ballotRoute = ballotRouteGiven || routeOf(ballots, target, false);
    const named = (m) => `${m.vintage} ${m.label}`.trim();
    const label = `${named(rollMeta)} minus ${named(ballotMeta)}`;

    for (const row of rows) {
      const rollCount = rollOf(row);
      const ballotCount = ballotsOf(row);
      if (rollCount == null || ballotCount == null) { delete row.g; continue; }
      const notVoted = rollCount - ballotCount;
      row.g = {
        roll: { count: rollCount, source: roll, vintage: rollMeta.vintage,
                route: rollRoute, label: named(rollMeta) },
        ballots: { count: ballotCount, source: ballots, vintage: ballotMeta.vintage,
                   route: ballotRoute, label: named(ballotMeta) },
        notVoted,
        notVotedShare: rollCount > 0 ? notVoted / rollCount : null,
        route: weaker(rollRoute, ballotRoute),
        /* Same source AND same vintage. A roll taken for one election and
           ballots cast in another count different people in the same place,
           and the reader has to be told rather than left to notice. */
        coherent: roll === ballots && rollMeta.vintage === ballotMeta.vintage,
        /* The municipal smoothing is capped at federal electors per division,
           so a municipal-paired gap is non-negative BY CONSTRUCTION rather
           than by the world -- floored by arithmetic, not by the electorate.
           Flagged so nobody reads a zero as a finding. */
        capped: Boolean(ballotRoute === 'smoothed' && cappedIds && idOf && cappedIds.has(idOf(row))),
        label,
      };
    }
    return rows;
  }

  const negativeGap = (rows) => rows.filter((r) => r.g && r.g.notVoted < 0).length;
  const incoherent = (rows) => rows.filter((r) => r.g && !r.g.coherent).length;
  const capped = (rows) => rows.filter((r) => r.g && r.g.capped).length;

  /* --- Where mail is worth dropping --------------------------------------- */

  /* An ORDINAL rank over areas, and never a count of votes.

     The unit of action is an area -- mail goes to a geography, not to a person
     picked out by an inferred belief -- so an area-level score is the matched
     instrument here rather than a tolerated one. What it must not become is
     "N votes available": a ranking is ordinal and does its job, while a vote
     count is a forecast about how particular people would behave, and nothing
     here measures that.

     The weighting is the caller's, with its default printed, because
     persuading and mobilising trade non-voters against party share differently
     and there is no principled split between them. Pretending otherwise by
     burying a constant would be worse than choosing one out loud. */
  function mailScore(rows, options = {}) {
    const { shareOf, weight = 1, basis = '' } = options;
    if (typeof shareOf !== 'function') {
      for (const row of rows) delete row.m;
      return rows;
    }
    const scored = [];
    for (const row of rows) {
      const share = shareOf(row);
      if (!row.g || share == null || !isFinite(share) || row.g.notVoted <= 0) {
        delete row.m;
        continue;
      }
      /* weight 1 is the plain product; above 1 leans on the share, below on
         the raw number who did not vote. */
      const score = row.g.notVoted * Math.pow(share, weight);
      row.m = { score, share, basis, rank: 0, percentile: 0 };
      scored.push(row);
    }
    scored.sort((a, b) => b.m.score - a.m.score);
    scored.forEach((row, i) => {
      row.m.rank = i + 1;
      row.m.percentile = scored.length > 1
        ? Math.round(((scored.length - 1 - i) / (scored.length - 1)) * 100) : 100;
    });
    return rows;
  }

  /* --- What to say about all of it ---------------------------------------- */

  function summary(rows) {
    let areas = 0, notVoted = 0, rollTotal = 0, ballotTotal = 0;
    let counted = 0, interpolated = 0, smoothed = 0;
    for (const row of rows) {
      if (!row.g) continue;
      areas++;
      notVoted += row.g.notVoted;
      rollTotal += row.g.roll.count;
      ballotTotal += row.g.ballots.count;
      if (row.g.route === 'counted') counted++;
      else if (row.g.route === 'interpolated') interpolated++;
      else smoothed++;
    }
    return {
      areas, notVoted, rollTotal, ballotTotal,
      negative: negativeGap(rows), incoherent: incoherent(rows), capped: capped(rows),
      counted, interpolated, smoothed,
      /* Over the areas that HAVE a gap, not over every row: an area the roll
         never reached would otherwise drag a rate towards zero while looking
         like an area where nobody voted. */
      share: rollTotal > 0 ? notVoted / rollTotal : null,
    };
  }

  return { ROLL_SOURCES, BALLOT_SOURCES, routeOf, weaker,
           gap, negativeGap, incoherent, capped, mailScore, summary };
})();
