# van-poli-atlas

GeoJSON atlas for the City of Vancouver — a single self-contained HTML file for
comparing federal and provincial voting poll by poll.

`vancouver-boundary-atlas.html` opens straight from disk: no server, no build
step, no account. It carries the 2025 federal polling divisions (1,406 polygons,
Elections Canada) inline and draws provincial voting areas over them once you
load a boundary file. Boundaries, results and every analysis work offline; the
only thing the page fetches from the web is the street basemap, and that can be
switched off.

## Using it

Open the file in a browser, then work through the **Data** tab:

1. **Provincial voting-area boundaries** — the 2024 set is *Provincial
   Electoral District Voting Areas – Gazetted 09/19/2024* on the
   [BC Data Catalogue](https://catalogue.data.gov.bc.ca/dataset/2a73ba6d-0707-4335-9f4f-7f8a6d922654),
   ordered as GeoJSON; the order's `.zip` loads as delivered and is clipped to
   the study area while it is read (see [Provincial voting areas](#provincial-voting-areas)).
   A zipped shapefile (`.shp` + `.dbf` + `.prj`), `.kml`, `.kmz` or `.geojson`
   from anywhere else works too. BC Albers (EPSG:3005), UTM zone 10N and
   lon/lat are converted automatically.
2. **Federal results** — Elections Canada's
   `pollresults_resultatsbureau<riding>.csv`, one riding at a time or zipped.
3. **Provincial results** — Elections BC results by voting area, in either long
   (one row per candidate) or wide (one column per party) form; or, for 2024,
   results by *voting place* (see
   [Provincial results for 2024](#provincial-results-for-2024)). A file with
   longitude and latitude columns is read the second way automatically.

Files are read in the browser tab. Nothing is uploaded anywhere.

4. **Census geography and profile** (optional) — Statistics Canada's 2021
   dissemination areas, dissemination blocks and Census Profile, cut down to
   the study area first with `tools/filter_census.py` (see below).

The **Map** tab overlays the geographies on a street basemap and reads out
the federal polling division, the provincial voting area and the dissemination
area at whatever point you click. Each layer
is shaded by its own election's results — party share or turnout — and the
federal layer can also carry provincial results redistributed through the
crosswalk. The **Correlation** tab builds the crosswalk and plots one vote share
against the other. The **Turnout** tab ranks every area by turnout combined
across both elections, draws the "top X % of areas hold Y % of electors" curve,
pools any set of areas into a basket, and exports the ranking. The
**Socioeconomic** tab moves both elections' results onto dissemination areas
and correlates turnout, or any party's share, with census variables. The
**Method** tab states the assumptions; read it before quoting a coefficient.

## Provincial voting areas

Elections BC publishes the voting-area polygons through the BC Data
Catalogue as `WHSE_ADMIN_BOUNDARIES.EBC_VOTING_AREAS_BS11_POLY_SVW`
(boundary set 11, the 2024 general election). Ordering it as GeoJSON delivers
a `BCGW_….zip` holding one `.geojson` for the whole province — 5,778 areas,
about 100 MB — next to the order's metadata and licence files. Two ways to use
it:

- **Load the `.zip` as delivered.** With *Clip the file to the study area
  while loading* ticked (the default), only the areas touching the federal
  extent plus 2 km are kept; the status line reports how many of the
  province's areas that was. Everything else about the file is ignored.
- **Cut it down once** and keep a small file:

  ```
  python3 tools/clip_geojson.py BCGW_order.zip --list                 # district codes, counts, extents
  python3 tools/clip_geojson.py BCGW_order.zip --study-area --out va_vancouver.geojson
  python3 tools/clip_geojson.py BCGW_order.zip --ed VHA VKE VLA VLM VNP --out five_districts.geojson
  ```

  `--study-area` is the City of Vancouver federal ridings plus 2 km, the same
  box the atlas clips to; `--like other.geojson` takes another file's extent;
  `--bbox W S E N` is explicit. Properties and coordinates are written
  unchanged unless `--precision 7` is given (about 1 cm). Standard library only.

The file identifies districts by `ED_ABBREVIATION` (`VHA`, `VKE`, …) and
areas by the three-digit `VA_CODE`; `EDVA_CODE` joins the two. The atlas
picks those fields itself and says so in the status line; the results file
has to name districts the same way, or the district field can be set to
"none" when the results carry the combined code. **Site-based voting areas**
— codes ending in `S`, one care facility each, listed in a box on Elections
BC's district maps with the facility's address — are not polygons in this
file. Their results stay unmatched, are counted in the results report, and
are left out of the turnout and crosswalk figures; they are the natural
first use of the geocoding planned for the municipal electors file.

## Provincial results for 2024

2024 was the first British Columbia general election where a voter could use
any voting place, so Elections BC reports the count by **voting place** — a
point — rather than by voting area. Loading such a file (one with `longitude`
and `latitude` columns) switches the atlas onto a different road:

- every voting area is given to the **nearest final-voting place of its own
  electoral district**, and that place's ballots are split across the areas it
  serves in proportion to population, or to ground area when no census is
  loaded;
- ballots with no meaningful location — advance voting, the district electoral
  office, vote by mail, special and assisted telephone voting, and
  out-of-district ballots — are spread across the whole district instead. A
  switch offers the alternative of spreading them in proportion to what each
  catchment polled on the final day.

Nothing is dropped: every ballot in the file lands on some area, and the status
line says how much took which route. On the real 2024 Vancouver file that is
162 located places in 118 catchments over 706 voting areas, a median of five
areas per catchment and 379 m from an area to its place, with 40% of ballots
arriving through a catchment and 60% spread across a district.

**The catchments are modelled here, not published by Elections BC.** Three
consequences, all stated on the Method tab: within a catchment the variation
you see is the census, not the election; nearest-place is a guess at a boundary
Elections BC actually drew; and spreading one place's result over five areas
does not make five observations, so the Correlation and Socioeconomic tabs
report the number of independent sources beside the number of units and compute
the confidence interval on the sources. Quote a coefficient with that figure.

The file carries no registered-voter count, so **provincial turnout is left
blank** rather than guessed; the combined ranking falls back to the federal side
and says it is partial. Party shares and ballot counts are unaffected. A file
with registered voters by voting area turns turnout back on, and Elections BC's
own voting-area-to-place assignment would replace the model entirely.

## Census data

Statistics Canada publishes the pieces separately and nationally, and the
dissemination-block boundary file alone is over a gigabyte, so the atlas comes
with a standard-library Python script that cuts everything down to a study
area on your machine:

```sh
python3 tools/filter_census.py \
    --geo-attr 2021_92-151_X.csv \
    --csd 5915022 \
    --profile 98-401-X2021006_English_CSV_data_BritishColumbia.csv \
    --clip-shp lda_000b21a_e.zip --clip-shp ldb_000b21a_e.zip \
    --out-dir census/
```

It needs the 2021 Geographic Attribute File (one row per dissemination block
with its population and its parent geographies), the comprehensive Census
Profile download for the province at the dissemination-area level, and the
zipped dissemination-area and dissemination-block boundary files; 5915022 is
the City of Vancouver's census subdivision id. It writes `db_population.csv`
and `da_population.csv`, `census_da_wide.csv` (every characteristic, one row
per area), `variables.csv` (the characteristic list with its hierarchy),
`starter.csv` (the fourteen starter variables), and a clipped copy of each
boundary file. Every column it relies on is found by name and printed, and
`--list PATTERN` searches the characteristic names.

Load the clipped boundaries, `db_population.csv` and either the long profile
or `census_da_wide.csv` in section 4 of the Data tab. The national files load
too — the reader clips a zipped shapefile to the study area before parsing its
geometry, and streams files too big to hold whole — but slowly, and the
national profile must fit in memory. With blocks loaded, every crosswalk is
weighted by where people live rather than by area; the Correlation tab says
which weighting is in effect.

Fourteen starter variables are derived by characteristic name (population,
density, age, household size and tenure, income, low income, unemployment,
mobility, immigration, education); any of the ~2,600 characteristics can be
added by name on the Socioeconomic tab. The Census Profile's column names, the
DGUID prefix and the suppression symbols were written from documentation and
memory rather than from the real files, so both the reader and the tool detect
by pattern and report what they matched; if a name differs in your download,
the match report will say so.

Adapted from Statistics Canada, Census Profile, 2021 Census of Population, and
the 2021 Geographic Attribute File. This does not constitute an endorsement by
Statistics Canada.

## Basemap

The map is drawn with [Leaflet](https://leafletjs.com). Street tiles come from
CARTO's Positron (light) and Dark Matter basemaps, which follow the page's
light or dark theme, or from OpenStreetMap's standard style; all are built on
OpenStreetMap data. Tiles are requested from the provider while the page is
open and are never bundled. Each tile request is an ordinary web request to
the provider's servers: like any web request it carries your IP address,
browser identification and request headers, together with the coordinates of
the tile, which reveal the area and zoom level on screen. That data is handled
under the provider's privacy policy (CARTO, or the OpenStreetMap Foundation).
Nothing else is sent: your boundary and results files never leave the machine.
If the tiles do not load, the map says so and keeps working — choose **None**
under Basemap to make no requests at all and work fully offline. The
attribution in the map's corner is required by the providers' terms; leave it
in place.

## Turnout

Turnout is ballots cast (valid plus rejected) over electors, per poll or voting
area, computed on demand from counts that move through the crosswalk together —
so turnout on any common geography is the electors-weighted mean of the polls
that feed it. Three things Elections Canada's files do that the reader handles:

- **Merged polls** report both polls' ballots under the receiving poll. The
  merge group is pooled and spread back pro rata to each member's electors.
- **Void polls** and polls where no vote was held carry nothing and are
  excluded.
- **Advance polls and special ballots** have no boundary. By default they are
  left out (election-day turnout, which understates areas whose residents vote
  early). Optionally they are apportioned back onto each district's mapped polls,
  by ballots or by electors; both are labelled as estimates.

## Why there is a crosswalk

Federal polling divisions and provincial voting areas are drawn by different
agencies and share no boundaries, so results cannot be joined on a key. The
atlas samples a lattice of equal-area points to measure how much of each
federal division lies inside each voting area, then splits votes in those
proportions. That assumes votes are spread evenly within a poll — the standard
areal-interpolation assumption, and the main caveat on every figure it reports.

Three things the code handles that are easy to get wrong:

- **Mobile polls.** Elections Canada type M polls (numbered from 500) have
  token polygons a few metres across, not catchments. They are off the map by
  default. Any polygon too small for the lattice to sample reliably is assigned
  whole to the unit containing an interior point, so its votes are never
  silently dropped — without that, 48 downtown and care-home polls disappear.
- **Slivers.** Two agencies digitise the same street differently, producing
  hairline overlaps that hold no voters and that a lattice estimates worst.
  Overlaps below a threshold are dropped and the rest rescaled to carry exactly
  the vote mass the slivers held, so nothing leaks.
- **Advance polls.** They have no boundary in either geography. Whenever
  results load, the Data tab reports what fraction of the file's votes landed in
  a mapped poll. Quote that number alongside any correlation.

## Rebuilding

```sh
python3 build.py                     # writes vancouver-boundary-atlas.html
```

`boundaries/fed_polls.geojson` is the federal layer the build inlines. The
built file is committed, and CI fails when it is out of date, so rebuild before
committing a change under `src/` or `boundaries/`.

`src/` holds the parts: `a-geo.js` (projections, point-in-polygon, spatial
index), `b-text.js` (delimited text, XML, KML), `c-binary.js` (ZIP, DBF, SHP),
`d-ingest.js` (format dispatch, reprojection, clipping big files to the study
area), `e-analysis.js` (the lattice sample, crosswalks between any two layers,
population weights, statistics), `f-results.js` (results joining),
`f2-turnout.js` (turnout, apportionment, ranking), `f3-census.js` (Statistics
Canada's Census Profile and Geographic Attribute File), `g1`–`g5` and `g9` (the
application, one shared scope; `g5` is the Socioeconomic tab), plus the shared
stylesheet and two vendored libraries: d3 v7 for the charts and Leaflet 1.9.4
for the map. The page exposes `window.vanPoliAtlas.state` for the browser
console and the test suites.

`tools/` holds two standard-library Python scripts that run on your own
machine: `shp.py` (shapefile and DBF reading, writing and clipping, also used
by the fixture generators) and `filter_census.py`, which cuts Statistics
Canada's national census downloads down to a study area and writes the small
files the atlas reads (`python3 tools/filter_census.py --help`). The Leaflet files are the unmodified
`dist/leaflet.js` and `dist/leaflet.css` from `npm pack leaflet@1.9.4`; to
upgrade, repeat that and replace the two files.

## Tests

```sh
npm ci                               # Playwright, pinned in package-lock.json
npx playwright install chromium      # once per machine; only the browser suites need it
npm run fixtures                     # writes fixtures/: real SHP/DBF/PRJ/KMZ + e2e files
npm test                             # the node suites, then the two browser suites
```

`npm run test:node` runs the node suites and the Python tool suites (no
browser needed); `npm run test:browser` only the Playwright ones; any single
suite runs as `node tests/test-geo.js` or `python3 tests/test-shp-tools.py`
and so on. `tests/run.js` stops at the first failing suite. GitHub Actions (`.github/workflows/ci.yml`) runs exactly these steps on
every pull request, plus a check that the committed
`vancouver-boundary-atlas.html` matches a fresh build.

557 assertions — 396 in the node suites, 161 in the browser ones — plus 13
Python tests over the tools in `tools/`. The browser suites drive the real page
in Chromium through Playwright: loading each boundary format, loading a BC Data
Catalogue order as delivered and clipped, joining results, reading results
reported by voting place and checking every ballot survives the catchments,
building the crosswalk, ranking turnout, loading the census layers and
correlating a planted variable on the Socioeconomic tab, exporting CSV, dark
mode, phone-width layout, and the basemap with tile requests stubbed —
including a run where every tile fails, to check the atlas carries on without
them.

The projections are checked against control points produced by independent
forward implementations in `tests/make-fixtures.py` (BC Albers and Statistics
Canada Lambert), and separately by their defining properties: equal area for
Albers (planar against geodesic area, computed by unrelated code paths,
agreeing to better than 0.05%) and unit scale on a standard parallel for
Lambert. The sample-table crosswalk is checked cell for cell against a copy
of the original two-layer lattice runner.

## Licence

This repository is not under a single licence. See [NOTICE](NOTICE) for the
full statement.

- **Code** in `src/` (excluding the vendored `d3.js`, `leaflet.js` and
  `leaflet.css`), `build.py` and `tests/` — GPL v3, per [LICENSE](LICENSE).
- **`src/d3.js`** — D3 v7.9.0, © 2010–2023 Mike Bostock, ISC licence. Vendored
  unmodified; its copyright line is the first line of the file and is carried
  into the built HTML.
- **`src/leaflet.js`, `src/leaflet.css`** — Leaflet 1.9.4, © 2010–2023
  Volodymyr Agafonkin, © 2010–2011 CloudMade, BSD 2-Clause licence. Vendored
  unmodified; the copyright header is carried into the built HTML.
- **Street basemap tiles** — © OpenStreetMap contributors (ODbL), © CARTO.
  Fetched from the providers at runtime under their own terms; never
  redistributed here.
- **`boundaries/fed_polls.geojson`** — derived from Elections Canada, Polling
  Division Boundaries 2025, under the
  [Open Government Licence – Canada](https://open.canada.ca/en/open-government-licence-canada).
  Not a GPL work.
- **Provincial boundaries and election results** are never redistributed here.
  They are loaded at runtime from files you download yourself, under whatever
  terms Elections BC and Elections Canada attach to them.
