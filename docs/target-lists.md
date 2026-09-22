# Building the three target lists

How to produce each list in the atlas, what the columns mean, and what the
ranking does and does not claim. Written to be read next to the screen, and to
be quotable to a client without anything in it needing to be walked back.

Everything below happens in the browser, on the machine holding the roll. The
roll is never uploaded, never bundled into the build, and never leaves the tab.
What comes out is a list of doors and quantities.

---

## First: get a build that has this in it

The ranking, the composite and the apportionment warnings below are new. A build
made before them ranks by building size and says nothing about which ballots are
in the turnout figure, so check the file you are about to use rather than
assuming.

```bash
cd ~/van-poli-atlas
git checkout -- vancouver-boundary-atlas.html   # payload builds dirty this
git pull origin main
git log --oneline -1                            # read this before going on
```

If the pull errors, stop and fix it. A pull that aborted while the build ran
anyway is how the last two stale builds happened. Then rebuild per the recipe in
the README — `tools/make-payload.js`, then `python build.py --payload payload
--out share/vancouver-atlas.html`. Pair `--payload` with `--out` or the build
overwrites the tracked file and the next pull aborts.

Open the result and check the Data tab offers **Call this list** beside the
download button. If it does not, the build predates this and the export will not
be ranked.

---

## Before any of them: load the roll

**Data tab → A file of places.**

1. *Places to count* — the elector roll.
2. *Address lookup* — the City of Vancouver `property-addresses.csv`.
3. *Count by* — **Count the rows**, unless the roll has a genuine quantity
   column. Never an `ElectorID`: it is unique per person, so summing it
   produces a number in the billions that looks like a count and is not one.
4. *Call them* — `electors`. The labels and the CSV headings follow this word.

Check the match report before going further. The last full run placed **96.4%**
of rows: 81.0% by direct lookup, 15.4% snapped to the nearest number on the same
street. The unplaced remainder is mostly UBC/UEL and River District, which sit
outside the city's address file, plus a normaliser gap on `NE`/`SE KENT AVE`.

Anything much below 90% means the join went wrong, not that the city has
changed. Stop and look rather than exporting.

---

## List 1 — Existing voters to target

Areas where the party already polls well *and* turnout is high: the places its
existing vote lives. The campaign filters this against the canvass database and
targets whoever is not already identified.

**Map tab → Colour the areas by:**

| selector | set to | party |
|---|---|---|
| provincial | Provincial party share | Conservative |
| federal | Provincial turnout (redistributed onto polls) | — |

Both halves are then the same election, 2024 provincial, which is what makes
"share *and* turnout" one statement about one electorate rather than two
statements about two. The share sits on its native voting areas; the turnout is
crosswalked onto federal polls. That is the only way to get two measures from
one election today, because the export takes one measure per layer.

If you would rather pair the 2024 share with **2025 federal** turnout, set the
federal selector to *Federal turnout* instead. It is a defensible list — turnout
is fairly stable across elections at the area level — but say which you did, and
build list 2 the same way so the two files compare row for row.

**Before exporting, turn apportionment on** for whichever election the turnout
half comes from. Turnout tab → *Provincial advance & absentee ballots* (or
*Federal advance & special ballots*) → **Apportion by electors**.

This matters more than it sounds. With apportionment off, turnout counts
election-day ballots only. In the federal file from the last full run that left
out 169,007 of 306,344 ballots — 55% of them; the provincial file has its own
advance and absentee pool, and the Non-voters tab now prints the actual count
for whichever side you are using. It is not a uniform haircut: advance polls
each serve a specific group of divisions, so leaving them out understates some
areas far more than others, and the ranking then partly reflects advance-poll
geography rather than turnout. On that federal data the did-not-vote figure read
68.9% with apportionment off against 31.1% with it on.

The cost of turning it on is stated on the tab, and the atlas now says so on the
Non-voters tab too: the total is right, but where it sits is modelled. For a rank
across areas that is the better trade — a modelled allocation of real ballots
beats a clean count of the wrong subset.

**Data tab → Call this list** `Existing voters to target` → **Download**.

---

## List 2 — Federal Liberal crossover

Areas that went Conservative provincially in 2024 and Liberal federally in 2025.
The largest pool of persuadable voters.

**Map tab → Colour the areas by:**

| selector | set to | party |
|---|---|---|
| provincial | Provincial party share | Conservative |
| federal | Federal party share | Liberal |

Both are shares, so apportionment moves them much less than it moves turnout —
it redistributes per-party votes along with the totals. Setting it the same way
for both lists is still worth doing, so the two files are built on the same
basis and can be compared row for row.

**Call this list** `Federal Liberal crossover` → **Download**.

Read the two percentile columns together. An address with `provincial_percentile`
94 and `federal_percentile` 91 is in the top tenth on both — that is the
crossover claim, and it is visible in the file rather than buried in the score.

---

## List 3 — Demographic indicators

Immigrants, homeowners, above-average median income.

**Socioeconomic tab** → pick the variable. **Map tab → Colour the areas by**
(census selector) → that variable, alongside whichever election measure you
want it to sit with.

All three indicators go on one list. Use **Rank this list on** beside the
download button on the Data tab: pick a measure, press **Add measure**, repeat.
The chosen measures are listed in order underneath, each with a **Remove**
button, and the rank runs down the average standing across all of them.

This is the control to use whenever a list needs more than one measure from the
same place — three census indicators, or a party share and a turnout figure on
the same layer. The map can only hold one measure per layer, so it cannot say
"immigrants *and* homeowners *and* median income" at all.

Leave the list empty and the export falls back to whatever the map is showing,
which is still the shortest path for a single measure. The line beside the
button says which of the two is in force, in as many words.

One measure is deliberately absent from the picker: *Federal minus provincial
party share*. It needs two parties, and offering every pairing would be
thirty-six entries of which one is wanted. Nothing is lost for targeting —
"high provincially and high federally" is two measures, which the list holds
natively and reports in separate columns, and separate is how you want to read
it anyway.

---

## What is in the file

One row per address. No names, no elector identifiers, nothing about any
individual.

| column | what it is |
|---|---|
| `rank` | 1 is the highest priority. Blank where a measure had no value for that address — not ranked, rather than ranked last. |
| `address` | The door. |
| `electors` | How many are there: the drop quantity. |
| `located_by` | `address lookup` where the city's file held this exact address; `nearest on street` where it was placed beside the closest number on the same street. |
| `longitude`, `latitude` | For routing and for maps. |
| `federal_poll`, `provincial_area`, `dissemination_area` | The areas the address falls in. |
| `measure_1_name` | The first measure's full name — the measure, its party, and the areas it was ranked against. Numbered rather than named for its layer, because several measures can come from one layer. |
| `measure_1_value` | That area's value on it. |
| `measure_1_percentile` | Where the area stands among all areas that measure was ranked against. This is what makes "high" defensible — 41% means nothing on its own, 41% at the 94th percentile is a sentence somebody can stand behind. |
| `measure_2_*`, `measure_3_*`… | The same three columns for each further measure, in the order they were added. |
| `target_score` | The average standing across the selected measures, 0–100. Only present when more than one measure is selected; the rank runs down it. |
| `cumulative_electors` | The running total down the ranked list. This is the column a print run is planned against: "mail the top 20,000" is a budget, not a row count, and one address can be three hundred pieces. |

The line beside the download button names the measures it is about to rank on.
Read it before every export. The measures are set on the Map tab and the button
is on the Data tab, and building the second list on the first list's settings is
the easiest mistake available here.

---

## Why the ranking is what it is

**The score is the average of percentiles, not of values.** A vote share runs 0
to 1 and a median income runs to six figures; adding them ranks every address by
income alone. Converting each measure to where its area stands among all areas
puts them on one scale, which is what "rank on X and Y together" has to mean
once somebody writes it down.

**An address is ranked only where every selected measure has a value.** Averaging
over whichever measures happened to resolve lets an address reach the top for the
reason that it is missing data — one measure at the 90th percentile outscores
90th-and-50th. Those addresses keep their rows and their values; they lose only
the rank.

**Within an equal score, the larger building ranks first.** Doors of equal
quality, and one stop beats forty.

## What it claims, and what it does not

These are **area measures attached to addresses**. The file says: this door sits
in an area where the 2024 Conservative share was 47%, which is the 94th
percentile across the city. It does not say the household voted Conservative,
and no column in it should be read or presented as though it did.

That is the right basis for a mail drop — you are buying a postal route, not a
conversation — and it is the wrong basis for any claim about a named person. The
`_measure` and `_percentile` columns are there so the distinction survives
contact with a spreadsheet.

Two limits worth stating before a client asks:

- **The 3.6% that did not place.** Mostly UBC/UEL and River District. They are
  absent from the file, not ranked low in it.
- **`nearest on street` rows.** Placed beside the closest number the city's file
  does hold, typically a few numbers away and almost always the same polling
  division — but an estimate of where a door is. Filter on `located_by` for a
  list restricted to exact lookups.

## Handling

The output carries no names, but it is derived from the roll and it says which
buildings hold electors and how many. Treat it as roll-derived: same device,
same handling, same retention as the roll it came from.
