/* --- A file of places, put on the geographies the atlas already carries -------

   Every other reader here takes numbers already attached to a geography. This
   one takes a list of locations -- addresses, facilities, an elector roll --
   and works out which area each one falls in. The point-in-polygon itself is
   Geo.buildIndex().hit(), the same call the map readout uses; what lives here
   is everything around it, which is where the mistakes are.

   Two of those mistakes are worth naming, because both are silent.

   A coordinate pair has no inherent order. GeoJSON writes [longitude,
   latitude]; the City of Vancouver's geo_point_2d writes "latitude,
   longitude". Reverse them and every Vancouver address lands in the Indian
   Ocean, with a perfectly plausible row count and no error anywhere. So the
   order is detected rather than assumed, and reported rather than detected
   quietly.

   And an address is a string that two agencies will spell differently. The
   city's own file is not even internally consistent: 386 of its streets end
   "ST" and none end "STREET", while 77 end "DRIVE" and none end "DR". A roll
   written the other way round would match nothing, and a join that drops a
   third of its rows looks exactly like a third of the electorate not voting.
--------------------------------------------------------------------------- */
const Points = (() => {

  /* --- Finding the columns ------------------------------------------------- */

  const PATTERNS = {
    lon: [/^longitude$/i, /^lon$/i, /^lng$/i, /^x$/i, /longitude/i],
    lat: [/^latitude$/i, /^lat$/i, /^y$/i, /latitude/i],
    /* One column holding both numbers, comma separated. */
    pair: [/^geo_point_2d$/i, /^coordinates$/i, /^point$/i, /^lat[_ ]?lon[g]?$/i, /^lon[g]?[_ ]?lat$/i],
    /* One column holding GeoJSON. */
    geometry: [/^geom$/i, /^geometry$/i, /^geo_shape$/i, /^shape$/i],
    number: [/^civic_number$/i, /civic.?number/i, /^house.?number$/i, /^street.?number$/i, /^number$/i],
    street: [/^std_street$/i, /^street_name$/i, /^street$/i, /street.?name/i],
    /* A single column carrying the whole address. */
    address: [/^full[_ ]?address$/i, /^address$/i, /civic.?address/i, /street.?address/i],
    postal: [/^postal[_ ]?code$/i, /^postcode$/i, /^pc$/i, /postal/i],
    label: [/^name$/i, /^label$/i, /building/i, /^description$/i],
  };

  const find = (header, key) => {
    const H = header.map((h) => String(h == null ? '' : h).trim());
    for (const re of PATTERNS[key]) {
      const i = H.findIndex((h) => re.test(h));
      if (i >= 0) return i;
    }
    return -1;
  };

  /* --- Normalising an address ---------------------------------------------

     Grounded in the real City of Vancouver street list, not in what a street
     name ought to look like. Three things that list actually does:

       ST. CATHERINES ST   the first token is Saint and the last is Street,
                           so a blanket ST -> STREET breaks it
       W KENT AV NORTH     the last token is a direction, so the street type
                           is not always last
       AV but DRIVE        the file mixes short and long forms between types,
                           so both directions have to fold to one spelling  */

  const DIRECTIONS = new Map([
    ['N', 'N'], ['NORTH', 'N'], ['S', 'S'], ['SOUTH', 'S'],
    ['E', 'E'], ['EAST', 'E'], ['W', 'W'], ['WEST', 'W'],
    ['NE', 'NE'], ['NW', 'NW'], ['SE', 'SE'], ['SW', 'SW'],
  ]);

  /* Many spellings in, one out. The canonical token is arbitrary; what matters
     is that every spelling of a type reaches the same one. */
  const TYPES = new Map([
    ['AV', 'AVE'], ['AVE', 'AVE'], ['AVEN', 'AVE'], ['AVENUE', 'AVE'],
    ['ST', 'ST'], ['STR', 'ST'], ['STREET', 'ST'],
    ['DR', 'DR'], ['DRIVE', 'DR'],
    ['RD', 'RD'], ['ROAD', 'RD'],
    ['BLVD', 'BLVD'], ['BOUL', 'BLVD'], ['BOULEVARD', 'BLVD'],
    ['CR', 'CRES'], ['CRES', 'CRES'], ['CRESCENT', 'CRES'],
    ['PL', 'PL'], ['PLACE', 'PL'],
    ['CT', 'CT'], ['CRT', 'CT'], ['COURT', 'CT'],
    ['LN', 'LN'], ['LANE', 'LN'],
    ['HWY', 'HWY'], ['HIGHWAY', 'HWY'],
    ['PKY', 'PKWY'], ['PKWY', 'PKWY'], ['PARKWAY', 'PKWY'],
    ['SQ', 'SQ'], ['SQUARE', 'SQ'],
    ['TER', 'TERR'], ['TERR', 'TERR'], ['TERRACE', 'TERR'],
    ['CIR', 'CIR'], ['CIRCLE', 'CIR'],
    ['DIV', 'DIV'], ['DIVERSION', 'DIV'],
    ['GR', 'GROVE'], ['GRV', 'GROVE'], ['GROVE', 'GROVE'],
    ['XING', 'CROSSING'], ['CROSSING', 'CROSSING'],
    ['MEWS', 'MEWS'], ['WALK', 'WALK'], ['CLOSE', 'CLOSE'], ['GATE', 'GATE'],
    ['WAY', 'WAY'], ['CONNECTOR', 'CONNECTOR'], ['LINK', 'LINK'],
  ]);

  /* A unit written in front of the civic number, in any of the shapes a person
     or a system might write it. Dropped: an elector lives at a property, and
     the property is what carries a coordinate. */
  const UNIT_WORD = /^\s*(?:#|APT\.?|APARTMENT|UNIT|SUITE|STE\.?|PH|RM\.?|ROOM)\s*/i;
  /* What is left of a unit once any word for it is gone: "101-3449", "101 3449",
     "101, 3449". Only ever stripped when a civic number follows. */
  const UNIT_NUMBER = /^\s*[0-9A-Z]+\s*[-,]\s*(?=\d)|^\s*[0-9A-Z]+\s+(?=\d)/i;
  const stripUnit = (raw) => {
    let s = String(raw == null ? '' : raw);
    const hadWord = UNIT_WORD.test(s);
    s = s.replace(UNIT_WORD, '');
    const next = s.replace(UNIT_NUMBER, '');
    /* Without a word saying "unit", only the hyphen form is safe: "101 3449"
       could be a number and a street that begins with a digit. */
    return hadWord || /^\s*[0-9A-Z]+\s*[-,]\s*\d/i.test(s) ? next : s;
  };

  function normalizeStreet(raw) {
    let s = String(raw == null ? '' : raw).toUpperCase();
    s = s.replace(/[.,]/g, ' ').replace(/['’`]/g, '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    let parts = s.split(' ');
    /* Saint, so that a file writing it out still meets one that does not. */
    if (parts[0] === 'SAINT') parts[0] = 'ST';
    /* A direction at the end comes off first: in "W KENT AV NORTH" the type is
       the token before it, not the last one. */
    let suffix = '';
    if (parts.length > 2 && DIRECTIONS.has(parts[parts.length - 1])) {
      suffix = DIRECTIONS.get(parts.pop());
    }
    /* Now the last token may be a street type -- or may be the whole name, as
       in BROADWAY and KINGSWAY, which are streets with no type at all. */
    let type = '';
    if (parts.length > 1 && TYPES.has(parts[parts.length - 1])) {
      type = TYPES.get(parts.pop());
    }
    let prefix = '';
    if (parts.length > 1 && DIRECTIONS.has(parts[0])) {
      prefix = DIRECTIONS.get(parts.shift());
    }
    return [prefix, parts.join(' '), type, suffix].filter(Boolean).join(' ');
  }

  /* The key a civic number and a street join on. Kept readable rather than
     hashed, because when a join misses, the first question is always what the
     two sides actually looked like. */
  function addressKey(number, street) {
    const n = stripUnit(String(number == null ? '' : number).toUpperCase())
      .replace(/[^0-9A-Z]/g, '').trim();
    const s = normalizeStreet(street);
    return n && s ? `${n} ${s}` : '';
  }

  /* One column holding the lot: "101-3449 ANZIO DRIVE" or "3449 Anzio Dr". */
  function splitAddress(full) {
    const s = stripUnit(String(full == null ? '' : full)).trim();
    const m = /^(\d+[A-Za-z]?)\s+(.*)$/.exec(s);
    return m ? { number: m[1], street: m[2] } : { number: '', street: s };
  }

  const postalKey = (raw) =>
    String(raw == null ? '' : raw).toUpperCase().replace(/[^0-9A-Z]/g, '');

  /* --- Coordinates --------------------------------------------------------- */

  const num = (v) => {
    const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9eE.+-]/g, ''));
    return isFinite(n) ? n : null;
  };

  /* A pair with no stated order. Anything outside +/-90 can only be a
     longitude, which settles nearly every real file in one row; when both
     values are in range the caller's extent decides, and when even that cannot
     the pair is reported as ambiguous rather than guessed. */
  function detectPairOrder(samples, extent) {
    let latFirst = 0, lonFirst = 0;
    for (const [a, b] of samples) {
      if (Math.abs(a) > 90 && Math.abs(b) <= 90) lonFirst++;
      else if (Math.abs(b) > 90 && Math.abs(a) <= 90) latFirst++;
    }
    if (latFirst || lonFirst) {
      return { order: latFirst >= lonFirst ? 'lat,lon' : 'lon,lat', by: 'range' };
    }
    if (extent && samples.length) {
      const inside = ([x, y]) =>
        x >= extent[0] && x <= extent[2] && y >= extent[1] && y <= extent[3];
      const asLatLon = samples.filter(([a, b]) => inside([b, a])).length;
      const asLonLat = samples.filter(([a, b]) => inside([a, b])).length;
      if (asLatLon !== asLonLat) {
        return { order: asLatLon > asLonLat ? 'lat,lon' : 'lon,lat', by: 'study area' };
      }
    }
    return { order: 'lon,lat', by: 'assumed' };
  }

  /* --- Layout -------------------------------------------------------------- */

  /* How a row can be located, in the order the reader should prefer: its own
     coordinates beat a lookup, because a lookup is a second chance to be
     wrong. */
  function detectPointLayout(header, rows = [], options = {}) {
    const h = (header || []).map((x) => String(x == null ? '' : x).trim());
    const lon = find(h, 'lon'), lat = find(h, 'lat');
    const pair = find(h, 'pair'), geometry = find(h, 'geometry');
    const number = find(h, 'number'), street = find(h, 'street');
    const address = find(h, 'address'), postal = find(h, 'postal');
    /* The address columns are kept whatever wins below. A reference file locates
       its own rows by coordinates AND is keyed by address, so dropping them
       when coordinates are present leaves it with nothing to join on. */
    const base = { header: h, label: find(h, 'label'),
                   number, street, address, postal, weight: -1 };
    if (options.weightColumn) {
      const i = h.findIndex((c) => c === options.weightColumn);
      base.weight = i;
    }
    /* A column is chosen by its NAME, so the pick has to be checked against the
       rows before it is returned. The city's property extract carries both a
       Geom and a geo_point_2d; an export that empties one of them still has
       the header, and the file then reads as geometry and locates nothing. A
       column that cannot parse a single row out of the sample is not the
       coordinate column, whatever it is called. */
    const parses = (kind, idx) => rows.slice(0, 200).some((r) => {
      const v = String(r[idx] == null ? '' : r[idx]);
      if (!v.trim()) return false;
      if (kind === 'geometry') {
        try {
          const g = JSON.parse(v);
          return Boolean(g && g.coordinates && g.coordinates.length);
        } catch (err) { return false; }
      }
      return /(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)/.test(v);
    });
    const usable = (kind, idx) => idx >= 0 && (!rows.length || parses(kind, idx));

    if (lon >= 0 && lat >= 0) return { ...base, kind: 'lonlat', lon, lat, order: { order: 'lon,lat', by: 'named columns' } };
    if (usable('geometry', geometry)) return { ...base, kind: 'geometry', geometry, order: { order: 'lon,lat', by: 'GeoJSON' } };
    if (usable('pair', pair)) {
      const samples = [];
      for (const r of rows.slice(0, 200)) {
        const m = /(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)/.exec(String(r[pair] || ''));
        if (m) samples.push([parseFloat(m[1]), parseFloat(m[2])]);
      }
      return { ...base, kind: 'pair', pair, order: detectPairOrder(samples, options.extent) };
    }
    /* Both coordinate columns present and neither readable: fall through to the
       address key rather than returning a layout that locates nothing. */
    if (number >= 0 && street >= 0) return { ...base, kind: 'address', number, street };
    if (address >= 0) return { ...base, kind: 'address1', address };
    if (postal >= 0) return { ...base, kind: 'postal' };
    return null;
  }

  const NEEDS_REFERENCE = new Set(['address', 'address1', 'postal']);

  /* --- Reading ------------------------------------------------------------- */

  /* reference, when the rows carry no coordinates of their own, is what
     buildReference returned: a Map from an address or postal key to a point. */
  function readPoints(table, layout, options = {}) {
    const rows = table.rows || [];
    const reference = options.reference || null;
    const points = [];
    const misses = [];
    /* A miss on a street the reference knows is a number the reference does not
       -- new construction, in a city that keeps building. A miss on a street it
       does not know is something else entirely. Kept apart, with their own
       samples, because they call for different action. */
    const knownStreets = options.referenceStreets || null;
    const newOnKnownStreet = [], unknownStreet = [];
    let unreadable = 0, matched = 0;
    const cell = (r, i) => (i >= 0 && i < r.length ? r[i] : '');

    for (const r of rows) {
      let lon = null, lat = null, key = '';
      if (layout.kind === 'lonlat') {
        lon = num(cell(r, layout.lon)); lat = num(cell(r, layout.lat));
      } else if (layout.kind === 'geometry') {
        try {
          const g = JSON.parse(String(cell(r, layout.geometry)));
          const c = g && (g.coordinates || (g.geometry && g.geometry.coordinates));
          if (Array.isArray(c) && c.length >= 2) { lon = num(c[0]); lat = num(c[1]); }
        } catch (e) { /* a row that is not JSON is simply unreadable */ }
      } else if (layout.kind === 'pair') {
        const m = /(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)/.exec(String(cell(r, layout.pair)));
        if (m) {
          const a = parseFloat(m[1]), b = parseFloat(m[2]);
          if (layout.order.order === 'lat,lon') { lat = a; lon = b; } else { lon = a; lat = b; }
        }
      } else if (NEEDS_REFERENCE.has(layout.kind)) {
        if (layout.kind === 'address') key = addressKey(cell(r, layout.number), cell(r, layout.street));
        else if (layout.kind === 'address1') {
          const { number, street } = splitAddress(cell(r, layout.address));
          key = addressKey(number, street);
        } else key = postalKey(cell(r, layout.postal));
        const hit = key && reference ? reference.get(key) : null;
        if (hit) { lon = hit.lon; lat = hit.lat; matched++; }
        else if (key) {
          if (misses.length < 25) misses.push(key);
          const street = /^[0-9A-Z]+ (.+)$/.exec(key);
          const bucket = knownStreets && street && knownStreets.has(street[1])
            ? newOnKnownStreet : unknownStreet;
          if (bucket.length < 25) bucket.push(key);
          bucket.total = (bucket.total || 0) + 1;
        }
      }
      if (lon == null || lat == null || !isFinite(lon) || !isFinite(lat)) { unreadable++; continue; }
      const w = layout.weight >= 0 ? num(cell(r, layout.weight)) : null;
      points.push({
        lon, lat,
        weight: w == null ? 1 : w,
        label: layout.label >= 0 ? String(cell(r, layout.label)).trim() : '',
      });
    }
    return {
      points,
      unreadable,
      report: {
        rows: rows.length,
        read: points.length,
        unreadable,
        kind: layout.kind,
        order: layout.order || null,
        weighted: layout.weight >= 0,
        joined: NEEDS_REFERENCE.has(layout.kind),
        matched: NEEDS_REFERENCE.has(layout.kind) ? matched : null,
        missRate: NEEDS_REFERENCE.has(layout.kind) && rows.length
          ? (rows.length - matched) / rows.length : null,
        misses,
        /* Counted whether or not the caller supplied the street set: with no
           set every miss falls to unknownStreet, which is the honest answer
           when there is nothing to tell them apart with. */
        newOnKnownStreet: { count: newOnKnownStreet.total || 0, sample: newOnKnownStreet },
        unknownStreet: { count: unknownStreet.total || 0, sample: unknownStreet },
        classified: Boolean(knownStreets),
      },
    };
  }

  /* --- The reference table ------------------------------------------------- */

  /* A file that has both a location key and coordinates -- the city's property
     addresses, or a postal table if one is ever published -- read into the Map
     readPoints joins against. Duplicate keys keep the first, and the count of
     them is reported: a key that names two different places is a key that
     cannot place anything precisely. */
  function buildReference(table, layout) {
    const map = new Map();
    /* Which streets the reference knows at all, so a miss can be told apart
       from a miss. A number that is absent from a street the file DOES know is
       almost always a building that went up after the file was published; a
       street the file has never heard of is almost always a spelling or a
       column picked wrong. Those want opposite responses -- a newer property
       extract, or a look at the join -- so they are counted apart. */
    const streets = new Set();
    let duplicates = 0, unusable = 0;
    const read = readPoints(table, { ...layout, weight: -1, label: -1 });
    const rows = table.rows || [];
    const cell = (r, i) => (i >= 0 && i < r.length ? r[i] : '');
    /* readPoints drops unreadable rows, so the keys are rebuilt here against
       the original rows and paired by walking both in step. */
    let p = 0;
    for (const r of rows) {
      const point = read.points[p];
      let lon = null, lat = null;
      if (layout.kind === 'lonlat') { lon = num(cell(r, layout.lon)); lat = num(cell(r, layout.lat)); }
      else if (layout.kind === 'pair' || layout.kind === 'geometry') {
        lon = point ? point.lon : null; lat = point ? point.lat : null;
      }
      if (lon == null || lat == null) { unusable++; continue; }
      p++;
      const keys = [];
      if (layout.number >= 0 && layout.street >= 0) {
        keys.push(addressKey(cell(r, layout.number), cell(r, layout.street)));
      }
      if (layout.address >= 0) {
        const { number, street } = splitAddress(cell(r, layout.address));
        keys.push(addressKey(number, street));
      }
      if (layout.postal >= 0) keys.push(postalKey(cell(r, layout.postal)));
      for (const k of keys) {
        if (!k) continue;
        /* The street half of an address key: everything after the number. */
        const street = /^[0-9A-Z]+ (.+)$/.exec(k);
        if (street) streets.add(street[1]);
        if (map.has(k)) { duplicates++; continue; }
        map.set(k, { lon, lat });
      }
    }
    return { map, streets, duplicates, unusable, keys: map.size, streetCount: streets.size };
  }

  /* --- Putting them on a layer --------------------------------------------- */

  /* index is a Geo.buildIndex over the features; idOf turns the index it
     returns into whatever the caller keys features by. Counts and weights are
     kept apart: a count of addresses and a sum of electors are different
     questions and the tab asks both. */
  function assignToLayer(points, index, idOf) {
    const per = new Map();
    let inside = 0, outside = 0, insideWeight = 0;
    for (const p of points) {
      const i = index.hit(p.lon, p.lat);
      if (i < 0) { outside++; continue; }
      inside++; insideWeight += p.weight;
      const id = idOf ? idOf(i) : i;
      let acc = per.get(id);
      if (!acc) per.set(id, (acc = { count: 0, weight: 0 }));
      acc.count++;
      acc.weight += p.weight;
    }
    return { per, inside, outside, insideWeight };
  }

  /* Areas that got nothing, which is the question a coverage check is really
     asking, and the count of areas small enough that naming them would say
     something about the people in them. */
  function coverage(per, featureIds, { disclosureBelow = 5 } = {}) {
    let empty = 0, sparse = 0;
    for (const id of featureIds) {
      const a = per.get(id);
      if (!a || !a.count) { empty++; continue; }
      if (a.count < disclosureBelow) sparse++;
    }
    return { areas: featureIds.length, empty, sparse, disclosureBelow };
  }

  /* The noun a reader typed, made singular for "carries at least one ___".
     A bare .replace(/s$/) turned "addresses" into "addresse" in the line a
     reader sees first. English plurals in -ses, -shes and -ies need more than
     one character off, and -us and -is are not plurals at all, so this covers
     the shapes that occur and leaves anything else alone -- being confidently
     wrong about somebody's noun is worse than not inflecting it. */
  function singular(noun) {
  const w = String(noun || '').trim();
  if (/(ss|sh|ch|x|z)es$/i.test(w)) return w.slice(0, -2);   // addresses -> address
  if (/[^aeiou]ies$/i.test(w)) return `${w.slice(0, -3)}y`;  // properties -> property
  /* -us and -is are not plural endings: census, status, analysis. */
  if (/[^sui]s$/i.test(w)) return w.slice(0, -1);            // electors  -> elector
  return w;                                                   // anything else, left alone
  }

  return { PATTERNS, detectPointLayout, readPoints, buildReference, assignToLayer, singular,
           coverage, normalizeStreet, addressKey, splitAddress, postalKey,
           detectPairOrder, NEEDS_REFERENCE };
})();
