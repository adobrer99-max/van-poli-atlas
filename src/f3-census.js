/* ---------------------------------------------------------------------------
   Census: Statistics Canada's 2021 Census Profile and Geographic Attribute
   File, read into per-area variables that can be joined to dissemination
   areas and blocks.

   Two layouts are read. The comprehensive Census Profile download is LONG:
   one row per characteristic per geography, ~2,600 characteristics each, with
   the hierarchy encoded as leading spaces in CHARACTERISTIC_NAME, a count
   column and a rate column each followed by a SYMBOL column, and suppression
   spelled as x, .., ... or F. Anything else with a geography column and
   numeric columns is WIDE: one row per geography, one column per variable --
   the shape tools/filter_census.py writes and StatCan's web tables export.

   Column names, the DGUID prefix and the suppression symbols are matched by
   pattern and reported, never assumed by position, because this file was
   written without access to the real downloads.
--------------------------------------------------------------------------- */
const Census = (() => {

  const norm = (h) => String(h == null ? '' : h).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');

  /* Suppressed or unavailable cells become null. */
  function parseValue(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (s === '' || /^(x|\.\.|\.\.\.|f|\.)$/i.test(s)) return null;
    const n = Number(s.replace(/,/g, ''));
    return isFinite(n) ? n : null;
  }

  /* A DGUID is vintage + schema + type + code (2021S05120001234): the code is
     what the boundary files carry as DAUID / DBUID, so keys are compared on
     the trailing code alone and either spelling joins. */
  const geoKey = (v) => String(v == null ? '' : v).trim().replace(/^\d{4}[A-Z]\d{4}(?=\d)/i, '');

  /* --- Long layout -------------------------------------------------------- */

  function detectProfileLayout(header) {
    const H = header.map(norm);
    const col = (...res) => {
      for (const re of res) { const i = H.findIndex((h) => re.test(h)); if (i >= 0) return i; }
      return -1;
    };
    const name = col(/^CHARACTERISTIC_NAME$/, /CHARACTERISTIC.*NAME/);
    if (name < 0) return null;
    const count = col(/^C1_COUNT_TOTAL$/, /^C1_COUNT/, /COUNT_TOTAL/, /^TOTAL$/);
    const rate = col(/^C10_RATE_TOTAL$/, /^C10_RATE/, /RATE_TOTAL/);
    const symbolAfter = (i) => (i >= 0 && H[i + 1] === 'SYMBOL' ? i + 1 : -1);
    return {
      dguid: col(/^DGUID$/, /DGUID/),
      altCode: col(/^ALT_GEO_CODE$/, /ALT_GEO_CODE/, /^GEO_CODE/),
      geoLevel: col(/^GEO_LEVEL$/),
      geoName: col(/^GEO_NAME$/),
      charId: col(/^CHARACTERISTIC_ID$/, /CHARACTERISTIC.*ID/),
      name, count, rate,
      countSymbol: symbolAfter(count), rateSymbol: symbolAfter(rate),
    };
  }

  /* Pivots the long file. keep(geoKey, row) filters geographies. The result
     holds one Float64Array of counts and one of rates per geography (NaN
     where suppressed or absent), indexed by the characteristic list. */
  function parseLongProfile(table, layout, options = {}) {
    const keep = options.keep || null;
    const characteristics = [];
    const byId = new Map();
    const byGeo = new Map();
    const stack = [];   // open ancestors by depth
    let geoLevel = null, rows = 0;
    for (const row of table.rows) {
      const rawName = row[layout.name];
      if (rawName == null) continue;
      const geo = geoKey(layout.altCode >= 0 && row[layout.altCode] !== '' && row[layout.altCode] != null
        ? row[layout.altCode] : row[layout.dguid]);
      if (!geo) continue;
      if (geoLevel == null && layout.geoLevel >= 0) geoLevel = String(row[layout.geoLevel] || '').trim();
      const id = layout.charId >= 0 ? Number(String(row[layout.charId]).trim()) : NaN;
      let entry = byId.get(isFinite(id) ? id : rawName);
      if (!entry) {
        const leading = /^ */.exec(rawName)[0].length;
        const depth = Math.floor(leading / 2);
        while (stack.length > depth) stack.pop();
        const parent = stack.length ? stack[stack.length - 1] : null;
        entry = { id: isFinite(id) ? id : characteristics.length + 1, name: rawName.trim(), depth,
                  parentId: parent ? parent.id : null, index: characteristics.length };
        characteristics.push(entry);
        byId.set(isFinite(id) ? id : rawName, entry);
        stack.push(entry);
      }
      if (keep && !keep(geo, row)) continue;
      let g = byGeo.get(geo);
      if (!g) byGeo.set(geo, (g = { count: [], rate: [], dguid: layout.dguid >= 0 ? String(row[layout.dguid]).trim() : null,
                                     name: layout.geoName >= 0 ? String(row[layout.geoName] || '').trim() : '' }));
      g.count[entry.index] = layout.count >= 0 ? parseValue(row[layout.count]) : null;
      g.rate[entry.index] = layout.rate >= 0 ? parseValue(row[layout.rate]) : null;
      rows++;
    }
    const n = characteristics.length;
    const toTyped = (arr) => { const t = new Float64Array(n).fill(NaN); for (let i = 0; i < n; i++) if (arr[i] != null) t[i] = arr[i]; return t; };
    for (const g of byGeo.values()) { g.count = toTyped(g.count); g.rate = toTyped(g.rate); }
    const byCharId = new Map(characteristics.map((c) => [c.id, c]));
    return { layout: 'long', geoLevel, characteristics, byCharId, byGeo, rows, geographies: byGeo.size };
  }

  /* --- Starter variables ----------------------------------------------------
     Matched on the trimmed characteristic name; `over` names an ancestor that
     disambiguates repeated names ("Movers" appears under both the 1-year and
     5-year mobility totals) and supplies the denominator for a share. Every
     match is reported so the user can see which row fired. */
  const STARTER = [
    { key: 'pop_2021', label: 'Population, 2021', name: /^Population, 2021$/i, use: 'count' },
    { key: 'pop_density', label: 'Population density per km²', name: /^Population density per square kilometre$/i, use: 'count' },
    { key: 'median_age', label: 'Median age', name: /^Median age of the population$/i, use: 'count' },
    { key: 'pct_65_plus', label: 'Aged 65 and over (%)', name: /^65 years and over$/i, use: 'ratio',
      over: /^Total - Age groups of the population/i },
    { key: 'pop_15_plus', label: 'Population aged 15 and over', name: /^0 to 14 years$/i,
      use: 'complement', over: /^Total - Age groups of the population/i },
    { key: 'avg_household_size', label: 'Average household size', name: /^Average household size$/i, use: 'count' },
    { key: 'pct_one_person_hh', label: 'One-person households (%)', name: /^1 person$/i, use: 'ratio',
      over: /^Total - Private households by household size/i },
    { key: 'median_hh_income', label: 'Median household income, 2020 ($)', name: /^Median total income of household in 2020/i, use: 'count' },
    { key: 'pct_lim_at', label: 'Low income, LIM-AT (%)', name: /^Prevalence of low income based on the Low-income measure, after tax/i, use: 'count' },
    { key: 'unemployment_rate', label: 'Unemployment rate (%)', name: /^Unemployment rate$/i, use: 'count' },
    { key: 'pct_renter', label: 'Renter households (%)', name: /^Renter$/i, use: 'ratio',
      over: /^Total - Private households by tenure/i },
    { key: 'pct_movers_5yr', label: 'Moved in the last 5 years (%)', name: /^Movers$/i, use: 'ratio',
      over: /^Total - Mobility status 5 years ago/i },
    { key: 'pct_immigrant', label: 'Immigrants (%)', name: /^Immigrants$/i, use: 'ratio',
      over: /^Total - Immigrant status and period of immigration/i },
    { key: 'pct_recent_immigrant', label: 'Immigrated 2016 to 2021 (%)', name: /^2016 to 2021$/i, use: 'ratio',
      over: /^Total - Immigrant status and period of immigration/i },
    { key: 'pct_bachelor_plus', label: "Bachelor's degree or higher, ages 25 to 64 (%)", name: /^Bachelor.s degree or higher$/i, use: 'ratio',
      over: /^Total - Highest certificate, diploma or degree for the population aged 25 to 64/i },
  ];

  function ancestors(profile, c) {
    const out = [];
    let cur = c;
    while (cur && cur.parentId != null) {
      cur = profile.byCharId.get(cur.parentId);
      if (cur) out.push(cur);
    }
    return out;
  }

  /* The characteristic a starter spec points at, or null. */
  function resolveSpec(profile, spec) {
    for (const c of profile.characteristics) {
      if (!spec.name.test(c.name)) continue;
      if (!spec.over) return { pick: c, over: null };
      const over = ancestors(profile, c).find((a) => spec.over.test(a.name));
      if (over) return { pick: c, over };
    }
    return null;
  }

  function valuesOf(profile, index, use, overIndex) {
    const values = new Map();
    for (const [geo, g] of profile.byGeo) {
      let v = null;
      if (use === 'rate') v = g.rate[index];
      else if (use === 'ratio') {
        const num = g.count[index], den = overIndex != null ? g.count[overIndex] : NaN;
        v = den > 0 && isFinite(num) ? (100 * num) / den : NaN;
      } else if (use === 'complement') {
        /* Everyone in the table except the named band. The profile carries
           "0 to 14 years" but no "15 and over" line, and a denominator of
           adult residents needs the second, so it is the total less the
           first -- a count, and treated as one wherever it is carried. */
        const part = g.count[index], whole = overIndex != null ? g.count[overIndex] : NaN;
        v = isFinite(part) && isFinite(whole) ? whole - part : NaN;
      } else v = g.count[index];
      if (v != null && isFinite(v)) values.set(geo, v);
    }
    return values;
  }

  function deriveVariables(profile, spec = STARTER) {
    const variables = [], matched = [], unmatched = [];
    for (const s of spec) {
      const r = resolveSpec(profile, s);
      if (!r) { unmatched.push(s.key); continue; }
      const values = valuesOf(profile, r.pick.index, s.use, r.over ? r.over.index : null);
      variables.push({ key: s.key, label: s.label, id: r.pick.id, name: r.pick.name, use: s.use,
                       over: r.over ? r.over.name : null, values });
      matched.push({ key: s.key, id: r.pick.id, name: r.pick.name, over: r.over ? r.over.name : null });
    }
    return { variables, matched, unmatched };
  }

  /* Any characteristic by id, as a count or as StatCan's own rate. */
  function characteristicVariable(profile, id, use = 'count') {
    const c = profile.byCharId.get(Number(id));
    if (!c) return null;
    const key = (use === 'rate' ? 'r' : 'c') + c.id;
    return { key, label: `${c.name}${use === 'rate' ? ' (%)' : ''}`, id: c.id, name: c.name, use,
             values: valuesOf(profile, c.index, use, null) };
  }

  /* --- Wide layout ---------------------------------------------------------- */

  /* The bare codes come first: they label the map more readably than a DGUID,
     and either joins, since keys are compared on the trailing code. */
  const GEO_COLUMNS = [/^DAUID$/, /^DBUID$/, /^DGUID$/, /^GEO_CODE$/, /^ALT_GEO_CODE$/, /^GEOUID$/, /^GEO_UID$/, /UID$/];

  function findGeoColumn(header) {
    const H = header.map(norm);
    for (const re of GEO_COLUMNS) { const i = H.findIndex((h) => re.test(h)); if (i >= 0) return i; }
    return -1;
  }

  function readWide(table) {
    const geoCol = findGeoColumn(table.header);
    if (geoCol < 0) throw new Error('No geography column (DGUID, DAUID or DBUID) was found in this table.');
    const variables = [];
    table.header.forEach((h, i) => {
      /* Every identifier column is skipped, not just the one used as the key:
         a DAUID beside a DGUID is numeric but is not a variable. */
      if (i === geoCol || !h || GEO_COLUMNS.some((re) => re.test(norm(h)))) return;
      const values = new Map();
      let seen = 0, numeric = 0;
      for (const row of table.rows) {
        const raw = row[i];
        if (raw == null || String(raw).trim() === '') continue;
        seen++;
        const v = parseValue(raw);
        if (v != null) { numeric++; values.set(geoKey(row[geoCol]), v); }
        else if (/^(x|\.\.|\.\.\.|f)$/i.test(String(raw).trim())) numeric++;   // suppressed, still a numeric column
      }
      if (seen && numeric / seen >= 0.9) variables.push({ key: h.trim(), label: h.trim(), values });
    });
    return { layout: 'wide', geoColumn: table.header[geoCol], variables,
             geographies: new Set(table.rows.map((r) => geoKey(r[geoCol]))).size };
  }

  /* --- Geographic Attribute File / block population ------------------------- */

  function readGeoAttributes(table) {
    const H = table.header.map(norm);
    const col = (...res) => { for (const re of res) { const i = H.findIndex((h) => re.test(h)); if (i >= 0) return i; } return -1; };
    const db = col(/^DBUID$/, /DBUID/);
    const pop = col(/^DBPOP2021$/, /^DBPOP/, /^POPULATION/, /POP_?2021/, /^POP$/);
    if (db < 0 || pop < 0) {
      throw new Error('A block population table needs a DBUID column and a population column (DBPOP2021).');
    }
    const da = col(/^DAUID$/, /DAUID/);
    const dwell = col(/^DBTDWELL2021$/, /^DBTDWELL/, /DWELL/);
    const dbPop = new Map(), daPop = new Map(), dwellings = new Map(), dbToDa = new Map();
    for (const row of table.rows) {
      const key = geoKey(row[db]);
      if (!key) continue;
      const p = parseValue(row[pop]);
      if (p != null) dbPop.set(key, p);
      if (dwell >= 0) { const d = parseValue(row[dwell]); if (d != null) dwellings.set(key, d); }
      if (da >= 0) {
        const daKey = geoKey(row[da]);
        if (daKey) { dbToDa.set(key, daKey); if (p != null) daPop.set(daKey, (daPop.get(daKey) || 0) + p); }
      }
    }
    return { dbPop, daPop, dwellings, dbToDa, columns: { db: table.header[db], pop: table.header[pop],
             da: da >= 0 ? table.header[da] : null } };
  }

  /* --- Joining to features --------------------------------------------------- */

  /* The id field of a boundary layer: the most unique of the identifier-like
     properties (a block file carries its DAUID too, shared by several blocks),
     bare codes before DGUIDs, else the most unique property of all. */
  function suggestGeoKey(features) {
    const sample = features.slice(0, 200);
    const names = new Set();
    for (const f of sample) for (const k of Object.keys(f.properties || {})) names.add(k);
    const all = [...names];
    const uniqueness = (n) => new Set(sample.map((f) => String((f.properties || {})[n]))).size / Math.max(1, sample.length);
    let best = null, bestScore = -1;
    for (const n of all) {
      const rank = GEO_COLUMNS.findIndex((re) => re.test(norm(n)));
      const score = uniqueness(n) * 100 + (rank >= 0 ? 10 + (GEO_COLUMNS.length - rank) : 0);
      if (score > bestScore) { bestScore = score; best = n; }
    }
    return best;
  }

  /* values: Map<geoKey, number> -> Map<featureIdx, number>. */
  function joinToFeatures(features, keyProp, values) {
    const out = new Map();
    if (!keyProp) return out;
    features.forEach((f, i) => {
      const v = values.get(geoKey((f.properties || {})[keyProp]));
      if (v != null && isFinite(v)) out.set(i, v);
    });
    return out;
  }

  return {
    norm, parseValue, geoKey, detectProfileLayout, parseLongProfile, STARTER, resolveSpec,
    deriveVariables, characteristicVariable, readWide, findGeoColumn, readGeoAttributes,
    suggestGeoKey, joinToFeatures,
  };
})();
