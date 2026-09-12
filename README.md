# van-poli-atlas

GeoJSON atlas for the City of Vancouver — a single self-contained HTML file for
comparing federal and provincial voting poll by poll.

`vancouver-boundary-atlas.html` opens straight from disk: no server, no build
step, no network access at all. It carries the 2025 federal polling divisions
(1,406 polygons, Elections Canada) inline and draws provincial voting areas over
them once you load a boundary file.

## Using it

Open the file in a browser, then work through the **Data** tab:

1. **Provincial voting-area boundaries** — from
   [Elections BC GIS spatial data](https://elections.bc.ca/resources/maps/gis-spatial-data/)
   or the [BC Data Catalogue](https://catalogue.data.gov.bc.ca/). A zipped
   shapefile (`.shp` + `.dbf` + `.prj`), `.kml`, `.kmz` or `.geojson` all work.
   BC Albers (EPSG:3005), UTM zone 10N and lon/lat are converted automatically.
2. **Federal results** — Elections Canada's
   `pollresults_resultatsbureau<riding>.csv`, one riding at a time or zipped.
3. **Provincial results** — Elections BC results by voting area, in either long
   (one row per candidate) or wide (one column per party) form.

Files are read in the browser tab. Nothing is uploaded anywhere.

The **Map** tab overlays the two geographies and reads out the federal polling
division and the provincial voting area at whatever point you click. The
**Correlation** tab builds the crosswalk and plots one vote share against the
other. The **Method** tab states the assumptions; read it before quoting a
coefficient.

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

`boundaries/fed_polls.geojson` is the federal layer the build inlines.

`src/` holds the parts: `a-geo.js` (projections, point-in-polygon, spatial
index), `b-text.js` (delimited text, XML, KML), `c-binary.js` (ZIP, DBF, SHP),
`d-ingest.js` (format dispatch and reprojection), `e-analysis.js` (crosswalk and
statistics), `f-results.js` (results joining), `g1`–`g3` (the application),
plus the vendored d3 v7 bundle and the shared stylesheet.

## Tests

```sh
python3 tests/make-fixtures.py       # builds real SHP/DBF/PRJ/KMZ fixtures
python3 tests/make-e2e-fixtures.py
node tests/test-geo.js               # and text, binary, ingest, analysis,
                                     # slivers, repair, results
node tests/test-browser.js           # needs playwright + chromium
node tests/test-variants.js
```

232 assertions. The browser suites drive the real page in Chromium through
Playwright: loading each boundary format, joining results, building the
crosswalk, exporting CSV, dark mode, and phone-width layout.

The projection is checked against control points produced by an independent
forward implementation in `tests/make-fixtures.py`, and separately by the
equal-area property — planar area against geodesic area, computed by unrelated
code paths, agreeing to better than 0.05%.

## Licence

This repository is not under a single licence. See [NOTICE](NOTICE) for the
full statement.

- **Code** in `src/` (excluding `src/d3.js`), `build.py` and `tests/` —
  GPL v3, per [LICENSE](LICENSE).
- **`src/d3.js`** — D3 v7.9.0, © 2010–2023 Mike Bostock, ISC licence. Vendored
  unmodified; its copyright line is the first line of the file and is carried
  into the built HTML.
- **`boundaries/fed_polls.geojson`** — derived from Elections Canada, Polling
  Division Boundaries 2025, under the
  [Open Government Licence – Canada](https://open.canada.ca/en/open-government-licence-canada).
  Not a GPL work.
- **Provincial boundaries and election results** are never redistributed here.
  They are loaded at runtime from files you download yourself, under whatever
  terms Elections BC and Elections Canada attach to them.
