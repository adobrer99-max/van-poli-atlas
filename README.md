# van-poli-atlas

**Vancouver Election Atlas** — a single self-contained HTML file laying federal,
provincial and municipal results over one map of the City of Vancouver, poll by
poll and voting area by voting area, with the 2021 census beside them.

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
   Take this file, not `pollbypoll_bureauparbureau<riding>.csv`: the poll-by-poll
   summary heads its columns with candidate names and carries no party at all,
   so nothing can be compared across ridings. Both the 2016-era `Merge With`
   column and the 2025 `Combined with No.` spelling are read. A division split
   on the day — reported as `10A` and `10B` while the boundary file still draws
   one polygon, `10-0` — is pooled back into that polygon, since the halves are
   one polling division between them.
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
crosswalk. The **Results** tab says what the loaded files themselves contain,
before anything is joined or moved: party totals and shares, a district table
with the leading party and its margin, how people voted by opportunity where
the file records it, the busiest places, and a summary CSV. The **Correlation**
tab builds the crosswalk and plots one vote share
against the other. The **Turnout** tab ranks every area by turnout combined
across both elections, draws the "top X % of areas hold Y % of electors" curve,
pools any set of areas into a basket, and exports the ranking. The
**Socioeconomic** tab correlates turnout, or any party's share, with census
variables, on either geography: dissemination areas, where the census lives and
the election results are carried in, or provincial voting areas, where the
provincial results live and the census is carried in instead — counts shared
out, rates averaged by population, and the picker says which happened to each
variable. Its export names the voting place behind every row and how much of
that row came from it, so a clustered standard error can be computed
elsewhere. The **Non-voters** tab does one subtraction — electors on a roll,
minus ballots cast, area by area — and records how each half reached the
geography it is compared on, so only counted minus counted is ever called a
count. A negative is never clamped: more ballots than roll electors says the
roll does not describe the people who voted there, which is the best
diagnostic the tab produces. It also ranks areas for where mail is worth
dropping, from the number who did not vote and a party share together — a
rank over areas, never a count of votes available. The **Method** tab states
the assumptions; read it before quoting a coefficient.

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
"none" when the results carry the combined code.

**The dataset is areal only.** All 5,778 records in the province are
`VA_TYPE: Areal`, none has a null geometry, and no `VA_CODE` ends in a letter,
so every voting area in it is a polygon. Whatever geography Elections BC uses
for voting at a care home, a hospital or a correctional centre, this product
does not carry it.

What that leaves unplaced is the **Special voting** channel in the results:
3,418 ballots city-wide, 1.35% of the 2024 vote, reported as **one row per
electoral district** with no location. Those ballots are counted in the results
report and spread across their district like the other channels that have no
geography. Geocoding the facilities would not change that, because the
numerator is published per district and not per facility — splitting it would
be a model dressed as a measurement, which is the same reason per-area
provincial turnout stays blank.

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
consequences, all stated on the “How to read this” tab: within a catchment the variation
you see is the census, not the election; nearest-place is a guess at a boundary
Elections BC actually drew; and spreading one place's result over five areas
does not make five observations, so the Compare and Neighbourhood profile tabs
report the number of independent sources beside the number of units and compute
the confidence interval on the sources. Quote a coefficient with that figure.

The results file carries no registered-voter count, so turnout is not computed
from it. Elections BC defines turnout as the share of **registered voters who
voted**, and publishes that denominator per electoral district in the
[Statement of Votes](https://elections.bc.ca/docs/rpt/statement-of-votes-2024-provincial-election.pdf),
not in the results file. Load a two-column table — district, registered voters —
in section 3 of the Data tab and the Results tab reports turnout per district
and city-wide. Either the abbreviation (`VFV`) or the full name
(`Vancouver-Fraserview`) matches, and a column naming the voters who *voted* is
ignored, since that is the numerator the atlas already has. Checked against the
Statement of Votes: Vancouver-Fraserview, 20,865 ballots over 39,801 registered,
reads 52.4%.

### Advance polls land on the divisions that fed them

Forty-three per cent of the 2025 federal ballots in Vancouver were cast at an
advance poll, which has no boundary of its own. Elections Canada's
polling-division file records which advance poll every ordinary division
reported to, so those ballots go to the three-to-fourteen divisions that fed
each advance poll — ten on average — instead of to the ~190 in its riding.
`tools/add-advance-polls.js` copies that column into the payload from
`PD_CA_2025_EN.dbf`; only the attribute table is needed, not the 175 MB `.shp`,
because the geometry is already there.

Within a served set the split is **proportional to electors**, not equal: the
divisions are roughly the same size but not exactly, typically 1.5× between
largest and smallest and once 6×, so an even split would be off by about 13%.

On the real six-riding file: 105 advance pools, 98 of them spread over a served
set averaging 10.4 divisions, and the share of ballots sitting on a division or
in a named set of about ten rises from **44.2% to 84.3%**. Ballots are conserved
exactly — what lands on units equals what was matched plus what was
apportioned, on either basis.

Unlike the provincial catchments this atlas invents, **this is published**. The
“How to read this” tab says so, and says which is which.

### Ridings that leave the city

Two of the six federal ridings cross the City of Vancouver line: Vancouver
Quadra reaches into UBC and the University Endowment Lands, and Vancouver
Fraserview—South Burnaby is **a third Burnaby by electors**. Polls outside the
city are tagged in the boundary file (`tools/tag-jurisdiction.js` derives the
tag by measuring each poll against a municipal boundary you supply), and the
**Area** control decides what to do with them: *City of Vancouver* excludes
both, *+ UBC / UEL* adds UBC alone, *Everything in the file* adds the rest of
Metro Vancouver.

Excluding a poll is only half of it. A straddling riding cast its advance and
special ballots across the whole riding, and those have no polygon at all, so
apportioning them onto the polls that remain would hand Burnaby's share to
Vancouver. Instead each district's pool is scaled by the share of its
electorate inside the study area — measured from the file, not assumed — and
only that share is spread, onto the polls inside. On the real 2025 files that
is 66% for Fraserview—South Burnaby and 87% for Quadra; every other riding is
100% and nothing about it changes. Ordinary polls with no boundary in the study
area are kept apart from advance polls, which look the same to a join and are
not the same thing at all.

The **Results** tab still reports the file exactly as loaded, because it is the
one unmodelled check in the atlas — but it names how many of those ballots were
cast outside the chosen area, so a city total is never quoted by accident.

Checked against Elections Canada's 2025 electoral district boundaries: the poll
payload tiles five of the six ridings exactly, and covers 78% of Vancouver
Fraserview—South Burnaby (26.1 of 33.5 km²). The missing 7.4 km² is the Burnaby
end, whose fifty polls have no polygon here — which is why they are reported as
ground outside the study area rather than spread across it. Quadra is fully
covered, UBC included, and its UBC polls are tagged.

That denominator is per district, so it is **not** spread onto voting areas:
one number per district split across its areas would be a model, not a
measurement. Until an elector count by voting area exists, per-area provincial
turnout stays blank and the combined ranking falls back to the federal side and
says it is partial. Party shares and ballot counts are unaffected throughout.
Elections BC's own voting-area-to-place assignment would replace the catchment
model entirely.

What the Turnout tab reports per area instead is the ballots over the two
counts that *are* available there, side by side and never called turnout:

| column | denominator | what it is not |
| --- | --- | --- |
| Per fed elector | 2025 federal electors, carried across the crosswalk | the 2024 provincial roll |
| Per resident 15+ | census residents aged 15 and over | registered voters |
| Spread | the difference, in percentage points | — |

Each appears only where its denominator resolves, and the tab counts the areas
that come out over 100% rather than hiding them, because that is what a
borrowed denominator looks like where it does not fit. Both can shade the map,
and the legend names the denominator every time.

## Census data

Statistics Canada publishes the pieces separately and nationally, and the
dissemination-block boundary file alone is over a gigabyte, so the atlas comes
with a standard-library Python script that cuts everything down to a study
area on your machine:

```sh
python3 tools/filter_census.py \
    --geo-attr 2021_92-151_X.zip \
    --csd 5915022 \
    --profile 98-401-X2021006_BC_eng_CSV.zip \
    --clip-shp lda_000b21a_e.zip --clip-shp ldb_000b21a_e.zip \
    --out-dir census/
```

Every input can be the `.zip` exactly as it downloaded — nothing needs
extracting first. The British Columbia dissemination-area profile is 3.5 GB
unpacked against 300 MB packed, so extracting it would cost several gigabytes
of disk to produce a file this reads once and streams straight out of the
archive instead. On Windows, `py` rather than `python3`; Git Bash handles the
`\` line continuations, `cmd.exe` and PowerShell do not.

It needs the 2021 Geographic Attribute File (one row per dissemination block
with its population and its parent geographies), the comprehensive Census
Profile download for the province at the dissemination-area level, and the
zipped dissemination-area and dissemination-block boundary files; 5915022 is
the City of Vancouver's census subdivision id.

### Baking the data into the build

Preparing this atlas's data means downloads from four agencies, a
multi-gigabyte census profile and a command line. Reading the finished map
should mean opening a file. Those are different jobs for different people, so a
build can carry its data inside it and a reader opens one HTML file with
everything already loaded:

```sh
node tools/make-payload.js --out payload \
    --census census/ \
    --fed-results pollresults/ \
    --prov-geo BCGW_voting_areas.zip \
    --prov-results provincial_2024_voting_places.csv \
    --muni-results 2022MunicipalElectionResults.zip \
    --muni-places voting-places-2022.csv
python3 build.py --payload payload
```

Every input is converted to the plainest text the atlas reads — a shapefile
becomes lon/lat GeoJSON, an archive becomes the CSVs inside it — and written
under a directory named for the loader that reads it. `build.py` inlines those,
and at startup the app hands each one to **the very same function the Data tab's
file input calls**, as a real `File` built from the inlined bytes. There is no
second parsing path to drift out of step with the one people actually exercise:
the payload is, literally, the file being chosen for you. Loading your own still
replaces it.

Two things the tool does that matter for size, both measured on the real files:

- **Boundaries are clipped properly, not just by bounding box.** A provincial
  order covers all of British Columbia — 5,778 voting areas, about 49 MB of
  GeoJSON. A bounding box round Vancouver still keeps 2,492 of them, because it
  also contains Burnaby, Richmond and the North Shore. An area is kept only when
  its own representative point lands inside a federal polling division, the same
  hit test the map readout uses: **861 areas, 958 KB.**
- **Only the properties the atlas reads are kept.** The provincial order also
  carries `OBJECTID`, `SHAPE.AREA`, a CAD annotation blob and a gazette date,
  which together came to 768 KB of nothing.

A full build — all three elections, the census layer and the boundaries — comes
to about **3.7 MB**. Still a file you can email, still works offline.

`--payload` and `--out` are independent, so you can build a copy for other
people without disturbing your own working tree:

```sh
python3 build.py --payload payload --out share/vancouver-atlas.html
```

Nothing baked in is committed: `payload/` and `boundaries/census_*` are in
`.gitignore`, because none of this data belongs to this repository — it is
Elections Canada's, Elections BC's, the City of Vancouver's and Statistics
Canada's. A fresh clone builds a working atlas with nothing baked in, which is
what the committed `vancouver-boundary-atlas.html` is, and every dataset loads
from the Data tab as before. `NOTICE` section 6 stays accurate either way.

**What must never be baked in.** There is deliberately no flag for section 5's
point file, and a test asserts there never will be. An elector roll is names and
home addresses; it is read in the browser tab on the campaign's own device,
never committed, never bundled, and what leaves that machine is aggregates with
the disclosure-threshold warning attached. Making the atlas easier to pass
around is exactly the pressure that erodes this, so: bake in public data, never
personal data.

**One more caveat, on distribution rather than use.** Census, Elections Canada
and City of Vancouver data are open-licensed and redistributable with
attribution. The Elections BC voting-area boundaries are under
[their own licence](https://www.elections.bc.ca/docs/EBC-Open-Data-Licence.pdf),
which is worth reading before handing a build containing them to anyone outside
the organisation that prepared it.

**Two ways to fetch the wrong profile**, both of which look right until you
open them. `98-401-X2021025` is *Census Subdivisions in British Columbia* —
751 municipalities, with Vancouver as a single row; the product that reaches
dissemination areas is `98-401-X2021006`. And a catalogue number ending `CI`
is the confidence-interval variant, which carries only the 25% sample
characteristics: population, population density, median age, the age groups,
household size, income and low income are all absent from it, so nine of the
fifteen starter variables cannot be derived and neither can the resident-15+
denominator. Take the plain number at the dissemination-area level. It writes `db_population.csv`
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
weighted by where people live rather than by area; the Compare tab says
which weighting is in effect.

Fifteen starter variables are derived by characteristic name (population,
density, age, household size and tenure, income, low income, unemployment,
mobility, immigration, education); any of the ~2,600 characteristics can be
added by name on the Neighbourhood profile tab. The Census Profile's column names, the
DGUID prefix and the suppression symbols were written from documentation and
memory rather than from the real files, so both the reader and the tool detect
by pattern and report what they matched; if a name differs in your download,
the match report will say so.

The long layout has since been checked against a real Statistics Canada
profile (`98-401-X2021025CI`, Vancouver's census subdivision): the columns are
found by name as intended, the six confidence-interval columns that sit between
the counts and the rates are skipped rather than mistaken for data, all 1,624
characteristics in that file parse, and the starter variables it does contain
come out right — 54.5% renters, 42.2% immigrants, 52.8% with a bachelor's
degree or higher, 9.0% unemployment.

Adapted from Statistics Canada, Census Profile, 2021 Census of Population, and
the 2021 Geographic Attribute File. This does not constitute an endorsement by
Statistics Canada.

## The municipal election (2022)

Vancouver's own election is the third that can be loaded, from two files the
city publishes: `2022MunicipalElectionResults.zip` and `voting-places-2022.csv`,
joined on the numeric voting place id. Pick a race (Mayor, Councillor, Park
Board, School Trustee, or a referendum question) and its ballots are spread onto
whichever polygon layers are loaded.

It is measured differently from the other two, and the difference is the reason
this section exists. Federally and provincially your voting place is assigned to
you, so a catchment — these ballots belong to the people living nearest this
building — is a defensible guess. **Municipally you may vote at any voting place
in the city**, and in 2022 almost everyone did: of the 104 places, 68 were
vote-anywhere centres carrying 54.8% of the ballots and 22 were advance places
carrying another 40.1%. Twelve ordinary neighbourhood places took the remaining
5.1%.

So the catchment is the wrong instrument here, and it fails loudly. Applied to
the 2022 results it puts more ballots into 32 federal polling divisions than
those divisions have electors — one advance place at Dunbar drops 4,166 ballots
onto four divisions of roughly 450 electors each. Instead each place's ballots
are spread over every area by distance, `exp(−distance / bandwidth)`, with a
bandwidth per channel: ~600 m for a final-day place, ~2 km for an advance one,
both adjustable on the Data tab. That removes all 32 impossible areas and
conserves every ballot exactly.

### There is no municipal turnout by area, deliberately

Two corrections that a reader would otherwise have to rediscover:

- **Constraining each area to its electors times the city-wide rate does not
  work.** It is the obvious fix for areas exceeding their own electorate, and it
  returns that rate in every area — standard deviation 0.0 points, zero
  correlation with anything. It asserts the answer instead of estimating it.
  What the atlas uses is a *ceiling* at an area's own electorate, which binds
  only where the model is impossible and is never a target. On the real file,
  with a sane bandwidth, it never binds at all.
- **A single bandwidth for every place is worse than doing nothing.**

And then the finding that decides the design. Measured against the federal 2025
turnout surface — ordinary ballots on their own division, advance ballots on the
divisions their advance poll actually served, which the municipal model never
sees — every version tried agrees at about **r 0.2**, and aggregating to 1 km and
2 km cells does not rescue it (0.23 and 0.21). That is roughly 4% of the
variation, where two real elections at one geography would normally agree far
more closely. A map of where municipal ballots were cast is largely a map of
where the voting places were, so **this atlas offers no municipal turnout by
area at all**.

Party share is a different matter, and it is why the layer exists. A share is a
ratio of two numbers measured at the same place, so it needs no denominator tied
to the area it is drawn on: travel blurs it without biasing it the way it biases
a rate. On the 2022 mayoral results a place's ABC-versus-Forward share agrees
with its neighbours within a kilometre at **r 0.76**. The surface that survives
is offered; the one that does not is absent.

The one turnout figure the election contributes is the city's own, read from the
Overview sheet: 170,274 ballots on 464,126 registered voters in the City of
Vancouver. It has no geographic modelling in it whatever.

Three details the files make you handle, each covered by a test:

- The race sheets carry a **title row above the header** and a **Total row at
  the bottom**; adding the Total as a place counts the election twice. Summary
  rows are named in the report rather than dropped silently.
- In a **ten-seat council race a ballot carries up to ten votes**, so the party
  columns are votes and the ballots column is ballots. They are kept apart; the
  share is a share of votes and the surface is ballots.
- **UBC and the University Endowment Lands** are a different jurisdiction whose
  electors vote for School Trustee and nothing else. Their two places are
  excluded from City of Vancouver figures, as the city's own Overview does.
  A facility name is not a key either: 21 of the 104 names are shared by two
  places, so everything joins on the id.

Contains information licensed under the Open Government Licence – Vancouver.

## Basemap

The map is drawn with [Leaflet](https://leafletjs.com). Whether it has a street
basemap under it depends on **how the file is opened**, and the atlas picks a
default that will actually work rather than one that looks broken.

Both free basemaps changed under this atlas within weeks of each other:

- **CARTO** began stamping keyless tiles with a diagonal "API KEY REQUIRED"
  watermark at the end of August 2026. Nothing is blocked; the key is free from
  [carto.com/basemaps/apikey](https://carto.com/basemaps/apikey/), takes about a
  minute, and covers 5 million tiles a month.
- **OpenStreetMap's standard tiles** return `403 Access blocked` to a page
  opened from a `file://` URL. Their
  [tile usage policy](https://operations.osmfoundation.org/policies/tiles/)
  requires a `Referer` or `User-Agent` identifying the application, and a local
  file sends no `Referer` at all. No code can fix this — a browser will not let
  a script set either header.

So:

| how it is opened | default | why |
|---|---|---|
| served over http(s) | OpenStreetMap | a `Referer` identifies the page, so OSM serves it |
| from disk, with a baked-in CARTO key | CARTO streets | the key is what CARTO asks for |
| from disk, no key | **None — boundaries only** | nothing else can legitimately be fetched |

A map with no basemap is complete and correct: every boundary, every figure and
every export is unaffected. Paste a key into the field beside the basemap picker
at any time and the street map comes on.

To hand out a copy that opens on streets with no setup at all, bake a key in:

```sh
python3 build.py --payload payload --carto-key YOUR_KEY
```

### Runbook: serving it as a site, for OSM-compliant tiles

Serving the file over http means OpenStreetMap works with no key at all. Any
static host does; GitHub Pages is the shortest route:

1. In the repository, **Settings → Pages**, set **Source** to the branch and
   folder holding `vancouver-boundary-atlas.html` (`main` / `root` is fine).
2. Wait for the Pages build, then open
   `https://<owner>.github.io/<repo>/vancouver-boundary-atlas.html`.
3. The basemap picker will already be on OpenStreetMap, and tiles will load.

Two things to be deliberate about before doing that:

- **A GitHub Pages site is public** unless the repository is on a plan with
  private Pages. A build with data baked in is then a public copy of that data.
  For anything not meant to be public, use a host with access control, or serve
  it on the campaign's own network — `python3 -m http.server` in the directory
  is enough for one machine, and `http://localhost:8000/...` satisfies OSM too.
- **OSM's tiles are volunteer-run.** The policy is fine with a tool used by a
  handful of people; it is not a CDN. Heavy or automated use wants CARTO with a
  key, or a self-hosted tile server.

Tiles are the only thing in the file that ever touches the network. Each tile
request is an ordinary web request to the provider's servers: like any web
request it carries your IP address, browser identification and request headers,
together with the coordinates of the tile, which reveal the area and zoom level
on screen. That data is handled under the provider's privacy policy (CARTO, or
the OpenStreetMap Foundation). Nothing else is sent: your boundary and results
files never leave the machine. Choose **None** to make no requests at all and
work fully offline. The attribution in the map's corner is required by the
providers' terms; leave it in place.

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

## Who did not vote

Electors on a roll, minus ballots cast, per area. The subtraction is one line;
everything around it is there because the two halves do not arrive the same
way.

- **A roll loaded as a file of places is counted onto every layer** by
  point-in-polygon — the only elector count here that is a genuine count on a
  geography its source never published for. Federal electors on a *provincial*
  area are areally interpolated instead, and municipal ballots on any area are
  a kernel's output rather than a count of anything that happened inside it. So
  each half records its route (`counted`, `interpolated`, `smoothed`), a
  subtraction inherits the weaker of the two, and only counted minus counted is
  called a count. The route travels with the figure on the table header, the
  badge, the map legend, the readout and every export.
- **A negative is a result and is never clamped.** More ballots than roll
  electors means the roll does not describe the people who voted there. For the
  same reason the municipal smoothing stays capped at each area's own *federal*
  electorate and must never be recapped at a municipal roll: that would floor
  every municipal gap at zero and destroy the diagnostic. Areas sitting at the
  ceiling are flagged, since a zero in one of them is arithmetic.
- **An area with no roll entry is not an area with nobody on the roll.** The
  divisions covering UBC and the University Endowment Lands are the expected
  case — those electors are on Vancouver's roll for the school trustee ballot,
  and the city's property file does not address land outside the city. They are
  counted separately and left out of every total.
- **Census residents are not a roll and cannot be chosen as one**, since
  subtracting ballots from residents aged 15 and over puts 15- to 17-year-olds
  into a count of people who did not vote.
- **The mail ranking is ordinal.** Areas are ranked from the number who did not
  vote and a party share together, with the weighting between them a visible
  control. It orders areas against one another; it is not a count of votes
  available, which would be a claim about how particular people would vote.

Nothing from a roll is written into the built file. It is read in the browser
tab; what is kept afterwards is a count per address and a count per area, never
a record per person. `tools/make-payload.js` has deliberately no flag for a roll
or for canvass data, and a test asserts that it never gains one.

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

That check is also why **the committed build carries no release stamp**. A
stamp carries the clock, so a file with one is never byte-identical to the next
build and the check could never pass. `--stamp` adds one, and `--payload`
implies it, because a build with data baked in is a copy handed to somebody and
that is the copy which has to answer "which version is this?". The stamp gives
the build date, the commit, whether data is baked in, and whether it was built
from a working tree with uncommitted changes — which matches no commit, and
says so rather than showing an id that does not describe it.

`src/` holds the parts: `a-geo.js` (projections, point-in-polygon, spatial
index), `b-text.js` (delimited text, XML, KML), `c-binary.js` (ZIP, DBF, SHP),
`d-ingest.js` (format dispatch, reprojection, clipping big files to the study
area), `e-analysis.js` (the lattice sample, crosswalks between any two layers,
population weights, statistics), `f-results.js` (results joining),
`f2-turnout.js` (turnout, apportionment, ranking), `f3-census.js` (Statistics
Canada's Census Profile and Geographic Attribute File), `g1`–`g5` and `g9` (the
application, one shared scope; `g5` is the Neighbourhood profile tab), plus the shared
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

804 assertions — 565 in the node suites, 239 in the browser ones — plus 13
Python tests over the tools in `tools/`. The browser suites drive the real page
in Chromium through Playwright: loading each boundary format, loading a BC Data
Catalogue order as delivered and clipped, joining results, reading results
reported by voting place and checking every ballot survives the catchments,
building the crosswalk, ranking turnout, spreading advance ballots onto the
divisions that fed each advance poll, reporting provincial ballots against
both denominators that can be had for a voting area, loading the census layers
and correlating a planted variable on the Neighbourhood profile tab, exporting CSV, dark
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
### A file of places

Section 5 of the Data tab takes any list of locations — addresses, facilities,
an elector roll — and counts it onto every layer that is loaded. Rows can carry
their own coordinates (longitude and latitude columns, a GeoJSON geometry
column, or one column holding both numbers) or a civic number and a street, in
which case a reference file such as the City of Vancouver
[property addresses](https://opendata.vancouver.ca/explore/dataset/property-addresses/)
supplies the coordinate.

Two things are easy to get wrong here and both are silent, so both are reported
rather than assumed. **A coordinate pair has no inherent order** — GeoJSON
writes longitude first, the city's `geo_point_2d` writes latitude first, and
reversing them puts every Vancouver address in the Indian Ocean with a
plausible row count and no error. The order is detected, and the status line
says which it read and what decided it. **And an address is a string two
agencies spell differently**: the city's own file is not internally consistent,
with 386 streets ending `ST` and none `STREET`, 77 ending `DRIVE` and none
`DR`. Normalisation folds both directions, keeps `ST. CATHERINES ST` (Saint at
the front, Street at the back) intact, and does not mistake the trailing
direction in `W KENT AV NORTH` for the street type.

Measured against the real 99,744-row property file: every coordinate read,
95,639 inside the federal study area across 1,013 of 1,017 polls, 99,740 inside
the provincial voting areas across 693 of 706, ~130 ms per layer. The 13 areas
with no address at all are the UBC and UEL end of Vancouver-Point Grey, which
the city does not address because it is outside the city. A sample of 2,986 of
its own addresses, respelled the way another agency would write them and given
unit prefixes, rejoined at **100%**.

An elector roll is personal data. The atlas reads it in the browser tab and
uploads nothing, writes counts per area and never records, and reports how many
areas hold so few that the count describes the people in it.

- **`boundaries/fed_polls.geojson`** — derived from Elections Canada, Polling
  Division Boundaries 2025, under the
  [Open Government Licence – Canada](https://open.canada.ca/en/open-government-licence-canada).
  Not a GPL work.
- **Provincial boundaries and election results** are not in this repository.
  They are loaded at runtime from files you download yourself, under whatever
  terms Elections BC and Elections Canada attach to them. A build made with
  `--payload` is the exception and the one to be careful about: it carries those
  datasets inside the HTML, so handing the file to somebody redistributes them.
  Every licence involved permits that with attribution — which the atlas carries
  on its Overview tab, naming each agency and linking its licence — but read the
  Elections BC one before a copy leaves the organisation that prepared it.
