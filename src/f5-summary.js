/* --- What the results files actually say -------------------------------------

   Every other tab models something: results are moved across a crosswalk,
   spread from voting places, correlated against a census. This one models
   nothing. It reads the loaded files back and says what is in them -- the
   party totals, the districts, how people voted -- so there is somewhere to
   check a headline figure before any of the modelling is trusted.

   Two shapes arrive. Results by voting area (or polling division) come as a
   table plus a column mapping, and are aggregated the same way the join does
   it, so the totals here and the totals there cannot drift. Results by voting
   place come already parsed by f4-places.js. Both reduce to one summary. */

const Summary = (() => {
  const share = (part, whole) => (whole > 0 ? part / whole : null);

  /* Party totals, ordered, with the winner and the margin over second. A
     margin is meaningless without at least two parties, and is expressed
     against valid votes so it reads as a percentage-point gap. */
  function rank(parties, valid) {
    const list = [...parties.entries()]
      .map(([name, votes]) => ({ name, votes, share: share(votes, valid) }))
      .sort((a, b) => b.votes - a.votes);
    const winner = list.length ? list[0] : null;
    const margin = list.length > 1 && valid > 0
      ? (list[0].votes - list[1].votes) / valid : null;
    return { list, winner, margin, runnerUp: list.length > 1 ? list[1] : null };
  }

  const blank = () => ({ ballots: 0, valid: 0, rejected: 0, electors: 0, parties: new Map(), units: 0 });

  /* --- Registered voters, when they arrive in their own file ---------------

     Elections BC reports turnout as the share of registered voters who voted,
     and publishes the denominator per electoral district in the Statement of
     Votes rather than in the results file. A two-column table is enough: a
     district and a count. Read by name, like everything else here. */
  const DISTRICT_COL = [/^ed[_ ]?abbrev/i, /district.*abbrev/i, /electoral.?district/i,
                        /^district$/i, /\bdistrict\b/i, /^ed$/i, /\briding\b/i];
  const ELECTOR_COL = [/registered.?voters?$/i, /^registered$/i, /registered.?voters/i,
                       /^electors$/i, /\belectors\b/i, /eligible/i];
  /* Anything naming the voters who actually voted is a numerator, not the
     denominator, and picking it would report a turnout of exactly 100%. */
  const NOT_ELECTORS = /who ?voted|voted|ballots|turnout|valid|rejected/i;

  function readElectors(table) {
    const header = (table.header || []).map((h) => String(h == null ? '' : h).trim());
    const find = (pats, reject) => {
      for (const re of pats) {
        const i = header.findIndex((h) => re.test(h) && !(reject && reject.test(h)));
        if (i >= 0) return i;
      }
      return -1;
    };
    const dCol = find(DISTRICT_COL);
    const eCol = find(ELECTOR_COL, NOT_ELECTORS);
    if (dCol < 0 || eCol < 0) {
      throw new Error('This table needs a district column and a registered-voters column. '
        + `It has: ${header.slice(0, 8).join(', ') || '(no header)'}.`);
    }
    const byDistrict = new Map();
    let total = 0;
    for (const row of table.rows || []) {
      const code = String(row[dCol] == null ? '' : row[dCol]).trim();
      const n = parseFloat(String(row[eCol] == null ? '' : row[eCol]).replace(/[,\s]/g, ''));
      if (!code || !isFinite(n) || n <= 0) continue;
      byDistrict.set(code.toUpperCase(), (byDistrict.get(code.toUpperCase()) || 0) + n);
      total += n;
    }
    if (!byDistrict.size) throw new Error('No district in this table carried a registered-voter count.');
    return { byDistrict, total, districtColumn: header[dCol], electorColumn: header[eCol] };
  }

  /* Districts keyed however the results file keys them: an abbreviation, a
     name, or a number. Matching is case-insensitive on either. */
  function electorsFor(code, name, supplied) {
    if (!supplied) return 0;
    const tryKey = (k) => (k ? supplied.byDistrict.get(String(k).trim().toUpperCase()) : undefined);
    return tryKey(code) ?? tryKey(name) ?? 0;
  }

  function addInto(acc, { valid = 0, rejected = 0, electors = 0, parties = null }) {
    acc.valid += valid;
    acc.rejected += rejected;
    acc.ballots += valid + rejected;
    acc.electors += electors;
    acc.units += 1;
    if (parties) for (const [name, v] of parties) acc.parties.set(name, (acc.parties.get(name) || 0) + v);
  }

  /* A turnout is only reported where the file carried an elector count. It is
     never inferred, and a file without one says null rather than zero. */
  const rateOf = (acc) => (acc.electors > 0 ? (acc.valid + acc.rejected) / acc.electors : null);

  function finishDistrict(code, name, acc, supplied) {
    const r = rank(acc.parties, acc.valid);
    /* A file that carries its own elector counts keeps them; one that does not
       borrows the district totals from the supplied table. Which of the two it
       was travels with the district, so the tab can say so. */
    const own = acc.electors > 0;
    if (!own) acc.electors = electorsFor(code, name, supplied);
    return {
      code, name: name || code,
      ballots: acc.ballots, valid: acc.valid, rejected: acc.rejected,
      electors: acc.electors || null, turnout: rateOf(acc), units: acc.units,
      electorsSupplied: !own && acc.electors > 0,
      parties: acc.parties, shares: r.list, winner: r.winner, runnerUp: r.runnerUp, margin: r.margin,
    };
  }

  function finish(total, districts, extra) {
    const r = rank(total.parties, total.valid);
    /* Every district's electors, however each one got them. A city total is
       only meaningful when every district has a count, so a partial set is
       reported as partial rather than quietly summed into a wrong rate. */
    const withElectors = districts.filter((d) => d.electors > 0);
    if (!total.electors && withElectors.length) {
      total.electors = withElectors.reduce((a, d) => a + d.electors, 0);
    }
    const electorsComplete = districts.length > 0 && withElectors.length === districts.length;
    return Object.assign({
      electorsComplete,
      electorsFrom: districts.some((d) => d.electorsSupplied) ? 'supplied' : 'file',
      districtsWithElectors: withElectors.length,
      ballots: total.ballots, valid: total.valid, rejected: total.rejected,
      rejectedShare: share(total.rejected, total.ballots),
      electors: total.electors || null, turnout: rateOf(total),
      parties: r.list, winner: r.winner, margin: r.margin,
      districts: districts.sort((a, b) => b.ballots - a.ballots),
      districtsWon: districts.reduce((m, d) => {
        if (d.winner) m.set(d.winner.name, (m.get(d.winner.name) || 0) + 1);
        return m;
      }, new Map()),
    }, extra);
  }

  /* --- Results by voting area or polling division ------------------------- */

  /* units: the Map that Results.aggregate returns. Void polls and polls where
     no vote was held are already zeroed there, and merged polls already carry
     their share, so this is a plain sum. */
  function fromUnits(units, options = {}) {
    const total = blank();
    const byDistrict = new Map();
    const largest = [];
    for (const [key, u] of units) {
      const row = { valid: u.total, rejected: u.rejected, electors: u.electors, parties: u.parties };
      addInto(total, row);
      const code = u.district || '';
      let acc = byDistrict.get(code);
      if (!acc) byDistrict.set(code, (acc = blank()));
      addInto(acc, row);
      largest.push({ key, label: u.district ? `${u.district} · ${u.poll}` : String(u.poll),
                     district: code, ballots: u.total + u.rejected, electors: u.electors || null,
                     turnout: u.electors > 0 ? (u.total + u.rejected) / u.electors : null });
    }
    largest.sort((a, b) => b.ballots - a.ballots);
    const districts = [...byDistrict].map(([code, acc]) =>
      finishDistrict(code, options.districtName?.(code), acc, options.electors));
    return finish(total, districts, {
      kind: 'areas',
      unitName: options.unitName || 'polls',
      channels: null,
      largest: largest.slice(0, options.top || 10),
      located: null,
    });
  }

  /* --- Results by voting place -------------------------------------------- */

  /* read: what Places.readPlaces returned. Every row counts towards the totals,
     located or not; the located share is reported separately because it is the
     part that can be put on a map at all. */
  function fromPlaces(read, options = {}) {
    const total = blank();
    const byDistrict = new Map();
    const byChannel = new Map();
    const located = [];
    let locatedBallots = 0;
    const all = read.places.concat(read.unlocated);
    for (const p of all) {
      const row = { valid: p.total, rejected: p.rejected, electors: p.electors, parties: p.byParty };
      addInto(total, row);
      let acc = byDistrict.get(p.ed);
      if (!acc) byDistrict.set(p.ed, (acc = blank()));
      addInto(acc, row);
      const channel = p.opportunity || 'Not stated';
      byChannel.set(channel, (byChannel.get(channel) || 0) + p.total + p.rejected);
    }
    for (const p of read.places) {
      locatedBallots += p.total + p.rejected;
      located.push({ name: p.name || 'Voting place', district: p.ed, opportunity: p.opportunity,
                     ballots: p.total + p.rejected, lon: p.lon, lat: p.lat });
    }
    located.sort((a, b) => b.ballots - a.ballots);
    const names = new Map(all.map((p) => [p.ed, p.districtName]));
    const districts = [...byDistrict].map(([code, acc]) =>
      finishDistrict(code, names.get(code), acc, options.electors));
    return finish(total, districts, {
      kind: 'places',
      unitName: 'voting places',
      channels: [...byChannel.entries()]
        .map(([name, ballots]) => ({ name, ballots, share: share(ballots, total.ballots) }))
        .sort((a, b) => b.ballots - a.ballots),
      largest: located.slice(0, options.top || 10),
      located: { places: read.places.length, unlocated: read.unlocated.length,
                 ballots: locatedBallots, share: share(locatedBallots, total.ballots) },
    });
  }

  /* --- One flat table, for the export ------------------------------------- */

  /* District first, then the channels and the largest units, each block
     labelled, so one file carries everything the tab shows without pretending
     three different shapes are one rectangle. */
  function toCsv(summary, label) {
    const partyNames = summary.parties.map((p) => p.name);
    const pct = (v) => (v == null || !isFinite(v) ? '' : (v * 100).toFixed(2));
    const rows = [['section', 'name', 'detail', 'ballots', 'valid', 'rejected', 'electors', 'turnout_pct',
                   'winner', 'margin_pts', ...partyNames.map((p) => `${p}_votes`),
                   ...partyNames.map((p) => `${p}_pct`)]];
    const partyCells = (parties, valid) => [
      ...partyNames.map((p) => (parties.get(p) ?? '')),
      ...partyNames.map((p) => pct(share(parties.get(p) || 0, valid))),
    ];
    rows.push(['total', label, '', summary.ballots, summary.valid, summary.rejected,
      summary.electors ?? '', pct(summary.turnout), summary.winner?.name ?? '', pct(summary.margin),
      ...partyCells(new Map(summary.parties.map((p) => [p.name, p.votes])), summary.valid)]);
    for (const d of summary.districts) {
      rows.push(['district', d.code, d.name === d.code ? '' : d.name, d.ballots, d.valid, d.rejected,
        d.electors ?? '', pct(d.turnout), d.winner?.name ?? '', pct(d.margin),
        ...partyCells(d.parties, d.valid)]);
    }
    for (const c of summary.channels || []) {
      rows.push(['channel', c.name, '', c.ballots, '', '', '', '', '', '',
        ...partyNames.map(() => ''), ...partyNames.map(() => '')]);
    }
    for (const u of summary.largest) {
      rows.push([summary.kind === 'places' ? 'place' : 'unit', u.name || u.label, u.opportunity || u.district || '',
        u.ballots, '', '', u.electors ?? '', pct(u.turnout), '', '',
        ...partyNames.map(() => ''), ...partyNames.map(() => '')]);
    }
    return rows;
  }

  return { fromUnits, fromPlaces, toCsv, rank, readElectors };
})();
