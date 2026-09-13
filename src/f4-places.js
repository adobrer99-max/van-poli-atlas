/* --- Results reported by voting place, not by voting area -------------------

   British Columbia's 2024 general election was the first where a voter could
   use any voting place, so Elections BC reports results per PLACE. The voting
   areas are still the assignment geography -- every address belongs to one --
   but the count that comes back is attached to a point, not to a polygon.

   This module turns those points into numbers on the polygons, the only shape
   the rest of the atlas can carry through a crosswalk:

     - every voting area goes to the nearest final-voting place of its own
       electoral district, which models the assignment Elections BC itself
       made and published on its district maps;
     - a place's ballots are split across the areas of its catchment in
       proportion to population (or to area, when no census is loaded);
     - ballots with no place at all -- advance voting, the district office,
       vote by mail, special and assisted telephone voting, and out-of-district
       ballots -- are spread across their whole district the same way, because
       the voters who cast them are not near anything in particular.

   Nothing here is an official boundary. Every number the module produces is a
   modelled split, and the report it returns says how much of the total took
   which route so the page can print it. */

const Places = (() => {
  const norm = (v) => String(v == null ? '' : v).trim();
  const upper = (v) => norm(v).toUpperCase();
  const num = (v) => {
    const n = parseFloat(String(v == null ? '' : v).replace(/[,\s$]/g, ''));
    return isFinite(n) ? n : 0;
  };
  const maybeNum = (v) => {
    if (norm(v) === '') return null;
    const n = parseFloat(String(v).replace(/[,\s$]/g, ''));
    return isFinite(n) ? n : null;
  };

  /* --- Column detection ---------------------------------------------------

     Named patterns, most specific first, exactly as Results.detectLayout and
     Census.detectProfileLayout do it: the file is read by what its headers
     say, never by column position. */
  const PATTERNS = {
    district: [/^electoral_district_abbreviation$/i, /district.*abbrev/i, /\bed[_ ]?abbrev/i,
               /^electoral_district$/i, /electoral district/i, /\bdistrict\b/i],
    districtName: [/^electoral_district_name$/i, /district.*name/i],
    opportunity: [/^voting_opportunity$/i, /voting.?opportunity/i, /\bopportunity\b/i, /voting type/i],
    lon: [/^longitude$/i, /^lon$/i, /^lng$/i, /longitude/i, /^x$/i],
    lat: [/^latitude$/i, /^lat$/i, /latitude/i, /^y$/i],
    total: [/^total_ballots$/i, /total.?ballots/i, /ballots.?cast/i, /^ballots$/i],
    valid: [/^valid_votes$/i, /valid.?votes/i],
    rejected: [/^rejected_ballots$/i, /rejected/i, /spoil/i],
    electors: [/registered.?voters/i, /^electors$/i, /\belectors\b/i, /registered/i],
    place: [/^building_name$/i, /^voting_location$/i, /voting.?place/i, /building/i, /location/i, /place.?name/i],
    address: [/^street_address$/i, /address/i],
    ready: [/^geocode_ready$/i, /geocode.?ready/i],
  };

  function detectColumn(header, kind) {
    const pats = PATTERNS[kind] || [];
    for (const re of pats) {
      const i = header.findIndex((h) => re.test(norm(h)));
      if (i >= 0) return i;
    }
    return -1;
  }

  /* A party column is one named "<party>_votes" that is not one of the
     bookkeeping totals. Its readable name is the header without the suffix. */
  const NOT_A_PARTY = /^(valid|total|rejected|spoiled|cast|advance|final)$/i;
  const ACRONYMS = new Set(['bc', 'ndp', 'cpc', 'ppc', 'lpc', 'cpbc', 'usa', 'uk']);

  function partyLabel(stem) {
    return stem.split(/[_\s]+/).filter(Boolean).map((word, i) => {
      const low = word.toLowerCase();
      if (ACRONYMS.has(low)) return low.toUpperCase();
      if (i > 0 && (low === 'of' || low === 'the' || low === 'and')) return low;
      return low.charAt(0).toUpperCase() + low.slice(1);
    }).join(' ');
  }

  function partyColumns(header) {
    const out = [];
    header.forEach((h, i) => {
      const m = /^(.*)_votes$/i.exec(norm(h));
      if (!m) return;
      const stem = m[1];
      if (!stem || NOT_A_PARTY.test(stem)) return;
      out.push({ index: i, column: norm(h), name: partyLabel(stem) });
    });
    return out;
  }

  /* Returns null when the table is not a voting-place file -- no coordinate
     columns, or no party columns -- so the caller can fall back to the
     voting-area reader without having to guess first. */
  function detectPlaceLayout(header) {
    const lon = detectColumn(header, 'lon');
    const lat = detectColumn(header, 'lat');
    const parties = partyColumns(header);
    if (lon < 0 || lat < 0 || !parties.length) return null;
    return {
      district: detectColumn(header, 'district'),
      districtName: detectColumn(header, 'districtName'),
      opportunity: detectColumn(header, 'opportunity'),
      lon, lat, parties,
      total: detectColumn(header, 'total'),
      valid: detectColumn(header, 'valid'),
      rejected: detectColumn(header, 'rejected'),
      electors: detectColumn(header, 'electors'),
      place: detectColumn(header, 'place'),
      address: detectColumn(header, 'address'),
      ready: detectColumn(header, 'ready'),
    };
  }

  /* --- Reading the rows ---------------------------------------------------- */

  /* Voting on the final day is the only opportunity where being near home is
     what decides where a ballot is cast, so it is the only one that earns a
     catchment. Out-of-district rows are cast by voters of this district
     somewhere else entirely, whatever the row's own wording. */
  const isFinalVoting = (opportunity) =>
    /final/i.test(opportunity) && !/out.?of.?district/i.test(opportunity);

  function readPlaces(table, layout) {
    const { header, rows } = table;
    const get = (row, i) => (i >= 0 && i < row.length ? row[i] : '');
    const located = [], unlocated = [];
    const parties = new Map();
    const districts = new Set();
    const warnings = [];
    let rowsRead = 0, ballots = 0;

    for (const row of rows) {
      if (!row.length || row.every((c) => norm(c) === '')) continue;
      const ed = upper(get(row, layout.district));
      const opportunity = norm(get(row, layout.opportunity));
      const byParty = new Map();
      let voteTotal = 0;
      for (const p of layout.parties) {
        const v = num(get(row, p.index));
        byParty.set(p.name, (byParty.get(p.name) || 0) + v);
        voteTotal += v;
      }
      const rejected = layout.rejected >= 0 ? num(get(row, layout.rejected)) : 0;
      const declared = layout.total >= 0 ? maybeNum(get(row, layout.total)) : null;
      const valid = layout.valid >= 0 ? maybeNum(get(row, layout.valid)) : null;
      /* Party columns are the source of truth for the split; the file's own
         total is kept only to notice a file whose columns disagree. */
      const total = voteTotal || valid || (declared == null ? 0 : declared - rejected);
      const electors = layout.electors >= 0 ? num(get(row, layout.electors)) : 0;
      const lon = maybeNum(get(row, layout.lon));
      const lat = maybeNum(get(row, layout.lat));
      const readySaysNo = layout.ready >= 0 && /^(n|no|false|0)$/i.test(norm(get(row, layout.ready)));
      const place = {
        ed,
        district: ed,
        districtName: layout.districtName >= 0 ? norm(get(row, layout.districtName)) : '',
        opportunity,
        name: layout.place >= 0 ? norm(get(row, layout.place)) : '',
        address: layout.address >= 0 ? norm(get(row, layout.address)) : '',
        lon, lat, total, rejected, electors, byParty,
        declaredTotal: declared,
        final: isFinalVoting(opportunity),
      };
      rowsRead++;
      ballots += total + rejected;
      if (ed) districts.add(ed);
      for (const [name, v] of byParty) parties.set(name, (parties.get(name) || 0) + v);
      const hasPoint = lon != null && lat != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
      if (hasPoint && !readySaysNo) located.push(place); else unlocated.push(place);
    }

    if (!located.length) {
      warnings.push('No row in this file carries usable coordinates, so every ballot '
        + 'will be spread across its whole electoral district.');
    }
    const mismatched = located.concat(unlocated).filter((p) =>
      p.declaredTotal != null && Math.abs(p.declaredTotal - (p.total + p.rejected)) > 0.5);
    if (mismatched.length) {
      warnings.push(`${mismatched.length} rows have a total that does not equal their `
        + 'votes plus rejected ballots; the party columns were used.');
    }
    return {
      places: located, unlocated,
      parties: [...parties.entries()].sort((a, b) => b[1] - a[1]),
      districts: [...districts].sort(),
      rowsRead, ballots, warnings,
    };
  }

  /* --- Catchments ---------------------------------------------------------- */

  /* Plane distance in metres, good to a fraction of a percent over a city and
     far cheaper than a great-circle formula on every area-place pair. */
  function metresBetween(a, b) {
    const midLat = ((a[1] + b[1]) / 2) * Math.PI / 180;
    const dx = (a[0] - b[0]) * 111320 * Math.cos(midLat);
    const dy = (a[1] - b[1]) * 110574;
    return Math.hypot(dx, dy);
  }

  /* Each feature goes to the nearest catchment place OF ITS OWN DISTRICT.
     Staying inside the district matters: a district electoral office can sit
     across a boundary, and nothing in another district ever serves this one. */
  function assignAreas(features, places, options = {}) {
    const districtOf = options.districtOf || ((f) => upper((f.properties || {}).ED_ABBREVIATION));
    const pointOf = options.pointOf
      || ((f) => (typeof Geo !== 'undefined' ? Geo.representativePoint(f.geometry) : null));
    const isCatchment = options.isCatchment || ((p) => p.final);

    const byDistrict = new Map();
    places.forEach((p, i) => {
      if (!isCatchment(p)) return;
      let list = byDistrict.get(p.ed);
      if (!list) byDistrict.set(p.ed, (list = []));
      list.push(i);
    });

    const assignment = new Int32Array(features.length).fill(-1);
    const distanceM = new Float64Array(features.length).fill(NaN);
    const featureDistrict = new Array(features.length);
    const byPlace = new Map();
    const districtFeatures = new Map();
    const districtsWithoutPlace = new Set();
    let placed = 0;

    features.forEach((f, i) => {
      const d = districtOf(f);
      featureDistrict[i] = d;
      let list = districtFeatures.get(d);
      if (!list) districtFeatures.set(d, (list = []));
      list.push(i);
      const candidates = byDistrict.get(d);
      if (!candidates || !candidates.length) {
        if (d) districtsWithoutPlace.add(d);
        return;
      }
      const pt = pointOf(f);
      if (!pt) return;
      let best = -1, bestD = Infinity;
      for (const pi of candidates) {
        const dist = metresBetween(pt, [places[pi].lon, places[pi].lat]);
        if (dist < bestD) { bestD = dist; best = pi; }
      }
      if (best < 0) return;
      assignment[i] = best;
      distanceM[i] = bestD;
      placed++;
      let members = byPlace.get(best);
      if (!members) byPlace.set(best, (members = []));
      members.push(i);
    });

    return {
      assignment, distanceM, featureDistrict, byPlace, districtFeatures,
      districtsWithoutPlace: [...districtsWithoutPlace].sort(),
      catchments: byPlace.size,
      placedFeatures: placed,
    };
  }

  /* --- Spreading ballots onto the areas ------------------------------------ */

  const emptyUnit = (district, poll) => ({
    total: 0, parties: new Map(), electors: 0, rejected: 0, rows: 0,
    district, poll, mergeWith: '', flags: { void: false, noPoll: false },
    mergedGroup: null, fromPlaces: 0, fromDistrict: 0, place: null, placeDistanceM: null,
  });

  function addShare(unit, place, share) {
    if (!(share > 0)) return;
    unit.total += place.total * share;
    unit.rejected += place.rejected * share;
    unit.electors += place.electors * share;
    for (const [name, v] of place.byParty) {
      unit.parties.set(name, (unit.parties.get(name) || 0) + v * share);
    }
  }

  /* Shares of a list of feature indices, in proportion to weightOf. A group
     whose members all weigh nothing is split evenly rather than dropped -- a
     voting area of parkland still holds the ballots cast from it. */
  function sharesFor(indices, weightOf) {
    const weights = indices.map((i) => {
      const w = weightOf(i);
      return isFinite(w) && w > 0 ? w : 0;
    });
    const sum = weights.reduce((a, b) => a + b, 0);
    if (sum > 0) return weights.map((w) => w / sum);
    return indices.map(() => 1 / indices.length);
  }

  /* features + places + an assignment -> one results unit per feature, in the
     shape Results.join produces, so everything downstream is unchanged.

     options.weightOf(featureIdx)  relative population (or area) of a feature
     options.pollOf(feature)       the area's own code, for labels
     options.catchmentBasis        'district' (default) spreads place-less
                                   ballots over the whole district by weight;
                                   'catchment' spreads them in proportion to
                                   each catchment's final-day ballots, which
                                   assumes advance voters resemble the
                                   neighbours who voted on the final day. */
  function spreadToAreas(features, read, assigned, options = {}) {
    const weightOf = options.weightOf || (() => 1);
    const pollOf = options.pollOf || ((f) => norm((f.properties || {}).VA_CODE));
    const basis = options.catchmentBasis === 'catchment' ? 'catchment' : 'district';
    const values = new Map();
    const unitFor = (i) => {
      let u = values.get(i);
      if (!u) values.set(i, (u = emptyUnit(assigned.featureDistrict[i] || '', pollOf(features[i]))));
      return u;
    };

    /* 1. Every place with a catchment, split across the areas it serves. */
    let placedBallots = 0;
    for (const [placeIdx, members] of assigned.byPlace) {
      const place = read.places[placeIdx];
      const shares = sharesFor(members, weightOf);
      members.forEach((fi, k) => {
        const u = unitFor(fi);
        addShare(u, place, shares[k]);
        u.fromPlaces += (place.total + place.rejected) * shares[k];
        u.place = place;
        u.placeDistanceM = assigned.distanceM[fi];
      });
      placedBallots += place.total + place.rejected;
    }

    /* 2. Everything with no catchment: the located places that do not earn one
          (advance voting, the district office) and every unlocated row, spread
          across their district. */
    const spread = read.places.filter((p, i) => !assigned.byPlace.has(i)).concat(read.unlocated);
    const byDistrict = new Map();
    for (const p of spread) {
      let list = byDistrict.get(p.ed);
      if (!list) byDistrict.set(p.ed, (list = []));
      list.push(p);
    }
    let spreadBallots = 0, homeless = 0;
    const districtsMissing = [];
    /* A district with areas but no results of its own is not a problem to
       report: a Vancouver-only results file leaves every neighbouring
       district's polygons empty, which is exactly right. Only a district that
       has ballots and no place to hang them on is worth a warning. */
    const spreadWithoutPlace = [];
    for (const [ed, list] of byDistrict) {
      const members = assigned.districtFeatures.get(ed);
      const ballots = list.reduce((a, p) => a + p.total + p.rejected, 0);
      if (!members || !members.length) {
        homeless += ballots;
        districtsMissing.push({ district: ed, ballots });
        continue;
      }
      const hasPlace = [...assigned.byPlace.keys()].some((pi) => read.places[pi].ed === ed);
      if (!hasPlace && ballots > 0) spreadWithoutPlace.push({ district: ed, ballots });
      let shares;
      if (basis === 'catchment') {
        /* Weight each area by what its own catchment polled on the final day,
           falling back to plain weight where a catchment polled nothing. */
        const perPlace = new Map();
        for (const [placeIdx, mem] of assigned.byPlace) {
          const place = read.places[placeIdx];
          if (place.ed !== ed) continue;
          perPlace.set(placeIdx, place.total + place.rejected);
        }
        const any = [...perPlace.values()].some((v) => v > 0);
        shares = sharesFor(members, (i) => {
          const pi = assigned.assignment[i];
          const scale = any && pi >= 0 && perPlace.has(pi) ? perPlace.get(pi) : 0;
          return any ? scale * weightOf(i) : weightOf(i);
        });
      } else {
        shares = sharesFor(members, weightOf);
      }
      for (const p of list) {
        members.forEach((fi, k) => {
          const u = unitFor(fi);
          addShare(u, p, shares[k]);
          u.fromDistrict += (p.total + p.rejected) * shares[k];
        });
      }
      spreadBallots += ballots;
    }

    /* Districts whose areas were loaded but whose results never arrived keep
       no unit at all, so the map shows them empty rather than zeroed. */
    const sizes = [...assigned.byPlace.values()].map((m) => m.length).sort((a, b) => a - b);
    const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0;
    const distances = [...assigned.distanceM].filter((d) => isFinite(d)).sort((a, b) => a - b);

    return {
      values,
      report: {
        rowsRead: read.rowsRead,
        places: read.places.length,
        unlocatedRows: read.unlocated.length,
        catchments: assigned.catchments,
        areasAssigned: assigned.placedFeatures,
        areasTotal: features.length,
        areasPerCatchment: { min: sizes[0] || 0, median, max: sizes[sizes.length - 1] || 0 },
        medianDistanceM: distances.length ? distances[Math.floor(distances.length / 2)] : null,
        maxDistanceM: distances.length ? distances[distances.length - 1] : null,
        ballotsTotal: read.ballots,
        ballotsFromPlaces: placedBallots,
        ballotsSpread: spreadBallots,
        ballotsUnplaced: homeless,
        districtsMissing,
        districtsWithoutPlace: spreadWithoutPlace.map((d) => d.district),
        districtsWithoutPlaceBallots: spreadWithoutPlace,
        districtsWithAreasButNoResults: assigned.districtsWithoutPlace
          .filter((d) => !byDistrict.has(d)),
        basis,
        electorsColumn: read.places.concat(read.unlocated).some((p) => p.electors > 0),
        warnings: read.warnings,
      },
    };
  }

  /* How many independent observations a set of areas really carries: spreading
     one place over five areas does not make five measurements. Areas that only
     ever received a district-wide spread count once per district. */
  function sourceUnits(indices, assigned) {
    const seen = new Set();
    for (const i of indices) {
      const pi = assigned.assignment[i];
      seen.add(pi >= 0 ? `p${pi}` : `d${assigned.featureDistrict[i] || ''}`);
    }
    return seen.size;
  }

  return {
    detectPlaceLayout, detectColumn, partyColumns, partyLabel, readPlaces,
    assignAreas, spreadToAreas, sourceUnits, metresBetween, isFinalVoting,
  };
})();
