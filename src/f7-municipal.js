/* --- Vancouver's municipal election, which arrives in two files --------------

   The city publishes results by voting place and the voting places themselves
   separately, joined by a numeric id. That is a better starting position than
   either other election in this atlas: the provincial 2024 results had to be
   geocoded by place name, and the federal results reach a polygon only through
   the poll number. Here the coordinates are published and the key is an
   integer.

   What this module does is put the two together into exactly the shape
   f4-places.js already reads, so the map, the Results tab and everything else
   downstream work on municipal results without knowing they are municipal.

   Two things about the file are worth knowing before reading the code. The
   race sheets carry a title row above the header, and the header has blank
   columns between the candidates -- merged cells, from the spreadsheet these
   were exported from. And a candidate column is spelled

       51 STEWART, Kennedy (Forward with Kennedy Stewart)

   so the party is in the brackets. Parties are what the rest of the atlas
   groups by, and for a council race with ten seats and fifty-nine candidates
   the party total is the only figure that means anything, so the bracket is
   what is read. A candidate with no bracket is their own party, which is what
   running as an independent amounts to.
--------------------------------------------------------------------------- */
const Municipal = (() => {
  const norm = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  const num = (v) => {
    const n = parseFloat(norm(v).replace(/[,\s]/g, ''));
    return isFinite(n) ? n : 0;
  };

  /* --- The voting places --------------------------------------------------- */

  const PLACE_COLS = {
    id: [/^voting[_ ]?place[_ ]?id$/i, /voting.?place.?id/i, /^place[_ ]?id$/i],
    name: [/^facility[_ ]?name$/i, /facility.?name/i, /^name$/i],
    address: [/^facility[_ ]?address$/i, /facility.?address/i, /^address$/i],
    area: [/^local[_ ]?area$/i, /local.?area/i, /neighbourhood/i],
    advance: [/^advance[_ ]?only$/i, /advance.?only/i],
    supercentre: [/^supercentre$/i, /supercent/i],
  };

  /* The two places on the UBC Lands and the University Endowment Lands are not
     in the City of Vancouver. Their electors vote for School Trustee and
     nothing else, and the city's own Overview sheet counts them separately, so
     a City of Vancouver total that includes them is wrong. They are found by
     the local area the file gives them rather than by their ids, which are a
     property of one year's file. */
  const OUTSIDE_CITY = /ubc|endowment|\buel\b/i;
  const col = (header, key) => {
    const H = header.map(norm);
    for (const re of PLACE_COLS[key]) {
      const i = H.findIndex((h) => re.test(h));
      if (i >= 0) return i;
    }
    return -1;
  };

  /* Coordinates come through f6-points.js, which already knows the three
     shapes this portal exports and which way round a pair is written. */
  function readVotingPlaces(table) {
    const header = (table.header || []).map(norm);
    const idCol = col(header, 'id');
    if (idCol < 0) {
      throw new Error('This file needs a voting place id to join results to. '
        + `It has: ${header.slice(0, 8).join(', ') || '(no header)'}.`);
    }
    const layout = Points.detectPointLayout(header, table.rows || []);
    if (!layout || Points.NEEDS_REFERENCE.has(layout.kind)) {
      throw new Error('The voting places file carries no coordinates of its own. '
        + 'Download it from the City of Vancouver open data portal, which publishes '
        + 'both a Geom and a geo_point_2d column.');
    }
    const read = Points.readPoints(table, layout);
    const nameCol = col(header, 'name'), addrCol = col(header, 'address');
    const areaCol = col(header, 'area'), advCol = col(header, 'advance');
    const superCol = col(header, 'supercentre');
    const cell = (r, i) => (i >= 0 && i < r.length ? r[i] : '');

    /* readPoints drops a row it cannot locate, so the two are walked in step
       rather than indexed against each other. */
    const byId = new Map();
    let p = 0, unlocated = 0;
    for (const r of table.rows || []) {
      const id = norm(cell(r, idCol));
      if (!id) continue;
      const point = read.points[p];
      /* A row with no id was skipped above, so the next point belongs to this
         row only if this row was itself locatable. */
      const has = point && read.report.read > p;
      if (!has) { unlocated++; continue; }
      p++;
      byId.set(id, {
        id,
        name: norm(cell(r, nameCol)) || `Voting place ${id}`,
        address: norm(cell(r, addrCol)),
        area: norm(cell(r, areaCol)),
        advanceOnly: /^y(es)?$/i.test(norm(cell(r, advCol))),
        supercentre: /^y(es)?$/i.test(norm(cell(r, superCol))),
        outsideCity: OUTSIDE_CITY.test(norm(cell(r, areaCol))),
        lon: point.lon, lat: point.lat,
      });
    }
    /* Two places can share a facility name -- 21 of the 104 in 2022 do, because
       a building hosts both an advance place and a final-day one. Everything
       here keys on the id for that reason; a name is a label, not a key. */
    const names = new Map();
    for (const p of byId.values()) names.set(p.name, (names.get(p.name) || 0) + 1);
    const sharedNames = [...names.values()].filter((n) => n > 1).length;
    return { byId, order: layout.order, unlocated, count: byId.size, sharedNames };
  }

  /* --- A race sheet -------------------------------------------------------- */

  /* "51 STEWART, Kennedy (Forward with Kennedy Stewart)" -> the bracket, or
     the surname when there is no bracket. Two candidates of one party add
     together, which for a ten-seat council race is the only readable figure. */
  function candidateParty(raw) {
    const s = norm(raw);
    if (!s) return null;
    const bracket = /\(([^)]+)\)\s*$/.exec(s);
    if (bracket) return norm(bracket[1]);
    const body = s.replace(/^\d+\s*/, '');
    const surname = body.split(',')[0];
    return norm(surname) || null;
  }

  const ID_HEADER = /voting\s*place\s*id/i;
  const CAST = /times\s*cast|ballots\s*cast/i;
  /* "2022 Election COUNCILLOR Results by Location (Vote for  10)". The seat
     count matters: in a ten-seat race every ballot carries up to ten votes, so
     the candidate columns are votes and are not ballots, and adding them up
     gives a number about ten times the turnout. The file says which, so it is
     read rather than guessed at. */
  const SEATS = /\(\s*vote\s*for\s*(\d+)\s*\)/i;

  /* The header is not the first row: a title sits above it. Found by looking
     for the row that names the voting place id, rather than by assuming a
     fixed offset, because the sheets are not consistent about it. */
  function detectRace(table) {
    const rows = table.rows || [];
    const all = [table.header || []].concat(rows);
    let at = -1;
    for (let i = 0; i < Math.min(all.length, 8); i++) {
      if ((all[i] || []).some((c) => ID_HEADER.test(norm(c)))) { at = i; break; }
    }
    if (at < 0) return null;
    let seats = 0, title = '';
    for (let i = 0; i < at; i++) {
      const line = (all[i] || []).map(norm).join(' ');
      const m = SEATS.exec(line);
      if (m) { seats = parseInt(m[1], 10); title = line.replace(/,+\s*$/, '').trim(); }
    }
    const header = all[at].map(norm);
    const idCol = header.findIndex((c) => ID_HEADER.test(c));
    const castCol = header.findIndex((c) => CAST.test(c));
    const candidates = [];
    for (let i = 0; i < header.length; i++) {
      if (i === idCol || i === castCol) continue;
      const h = header[i];
      /* Blank columns sit between candidates; the bookkeeping columns are
         named and are not candidates either. */
      if (!h || /undervote|overvote|^total/i.test(h)) continue;
      const party = candidateParty(h);
      if (party) candidates.push({ index: i, label: h, party });
    }
    return { headerRow: at, header, idCol, castCol, candidates, seats, title,
             body: all.slice(at + 1) };
  }

  /* --- The two, put together ----------------------------------------------- */

  /* Produces a table f4-places.js reads without changes: one row per voting
     place, one column per party, longitude and latitude of its own. The
     opportunity column carries the channel the city records -- advance or
     election day -- so the Results tab can break the count down by it the way
     it does provincially. */
  function toPlacesTable(raceTable, places, options = {}) {
    const race = detectRace(raceTable);
    if (!race) {
      throw new Error('This does not look like a results sheet: no column names the '
        + 'voting place id. Load one of the race sheets from the results zip, such as Mayor.');
    }
    if (!race.candidates.length) throw new Error('No candidate columns were found in this sheet.');

    const parties = [];
    for (const c of race.candidates) if (!parties.includes(c.party)) parties.push(c.party);
    const seats = race.seats || 1;
    const header = ['district', 'voting_opportunity', 'voting_location', 'street_address',
                    'longitude', 'latitude', 'total_ballots', 'rejected_ballots']
      .concat(parties.map((p) => `${p}_votes`));

    const rows = [];
    const unplaced = [], summaries = [];
    let matched = 0, ballotsMatched = 0, ballotsUnplaced = 0, outsideCity = 0;
    for (const r of race.body) {
      const raw = norm(r[race.idCol]);
      if (!raw) continue;
      const m = /^(\d+)\s*-\s*(.*)$/.exec(raw);
      /* The last row of every race sheet is a Total, and adding it to the
         places would double the election. Anything whose id is not a number is
         a summary line, and it is counted and named rather than dropped
         quietly, because a file that grows a second summary row should show up
         here rather than in a total nobody rechecks. */
      if (!m && !/^\d+$/.test(raw)) {
        summaries.push({ label: raw, ballots: race.castCol >= 0 ? num(r[race.castCol]) : 0 });
        continue;
      }
      const id = m ? m[1] : raw;
      const name = m ? norm(m[2]) : raw;
      const cast = race.castCol >= 0 ? num(r[race.castCol]) : 0;
      const byParty = new Map();
      let votes = 0;
      for (const c of race.candidates) {
        const v = num(r[c.index]);
        votes += v;
        byParty.set(c.party, (byParty.get(c.party) || 0) + v);
      }
      /* Only meaningful where one ballot is one vote. In a ten-seat race a
         ballot marked for three candidates is not seven rejected ballots. */
      const rejected = seats === 1 ? Math.max(0, cast - votes) : 0;
      const place = places.byId.get(id);
      if (!place) {
        /* Special voting and mail have an id and a name but no place: the city
           reports them in the same column. They are kept and reported rather
           than dropped, and carry no coordinates, which is exactly how
           f4-places.js already treats a row it cannot put on a map. */
        unplaced.push({ id, name, ballots: cast });
        ballotsUnplaced += cast;
      } else {
        matched++; ballotsMatched += cast;
        if (place.outsideCity) outsideCity += cast;
      }
      rows.push([
        options.district || 'CoV',
        place ? (place.advanceOnly ? 'Advance voting' : 'Final voting') : (name || 'Not stated'),
        place ? place.name : name,
        place ? place.address : '',
        place ? String(place.lon) : '',
        place ? String(place.lat) : '',
        String(cast),
        String(rejected),
      ].concat(parties.map((p) => String(byParty.get(p) || 0))));
      if (place && place.outsideCity) rows[rows.length - 1][0] = 'UBC/UEL';
    }
    return {
      table: { header, rows },
      parties,
      report: {
        places: places.count,
        rows: rows.length,
        matched,
        unplaced,
        ballotsMatched,
        ballotsUnplaced,
        summaries,
        outsideCity,
        seats,
        title: race.title,
        sharedNames: places.sharedNames || 0,
        candidates: race.candidates.length,
        supercentres: [...places.byId.values()].filter((p) => p.supercentre).length,
        advanceOnly: [...places.byId.values()].filter((p) => p.advanceOnly).length,
        order: places.order,
      },
    };
  }

  /* --- The one turnout figure this election does carry ----------------------

     There is no municipal turnout column per area anywhere in this atlas, and
     that is deliberate: you may vote at any voting place in Vancouver, so
     where a ballot was cast says little about where its voter lives, and a
     per-area rate built from voting places is a picture of the voting place
     network. The city-wide rate has no such problem -- the city publishes it,
     with its own denominator -- so it is read from the Overview sheet and
     shown as the single figure it is. */
  function readOverview(table) {
    const all = [table.header || []].concat(table.rows || []);
    const find = (re) => {
      for (const row of all) {
        const label = norm(row[0]);
        if (!re.test(label)) continue;
        for (let i = 1; i < row.length; i++) {
          const v = norm(row[i]);
          if (/^[\d,]+$/.test(v)) return num(v);
          if (/^[\d.]+\s*%$/.test(v)) return parseFloat(v) / 100;
        }
      }
      return null;
    };
    const electors = find(/^registered voters \(cov\)/i);
    const ballots = find(/^ballots cast \(cov\)/i);
    const electorsAll = find(/^registered voters\b.*total/i);
    const ballotsAll = find(/^ballots cast total/i);
    if (electors == null && ballots == null) return null;
    return {
      electors, ballots,
      turnout: electors > 0 && ballots > 0 ? ballots / electors : null,
      electorsAll, ballotsAll,
      /* The city's own headline rate divides by the total including the UBC
         Lands and the UEL, whose electors vote for School Trustee only. Both
         are carried so the difference is visible rather than argued about. */
      turnoutAsPublished: electorsAll > 0 && ballotsAll > 0 ? ballotsAll / electorsAll : null,
    };
  }

  const isOverviewSheet = (name) => /overview/i.test(String(name));

  /* Which sheet in the results zip is a race rather than a summary. The zip
     carries Mayor, Councillor, Park Board, School Trustee, three referendum
     questions, an Overview and a Totals sheet. */
  const RACE_SHEET = /mayor|councillor|council|park.?board|school.?trustee|trustee|\bq\d/i;
  const isRaceSheet = (name) =>
    RACE_SHEET.test(String(name).replace(/^.*[-\/]/, '').trim());

  return { readVotingPlaces, detectRace, candidateParty, toPlacesTable, isRaceSheet,
           readOverview, isOverviewSheet };
})();
