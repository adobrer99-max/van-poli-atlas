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

Open the result and check two things: the Data tab offers **Call this list** and
**Rank this list on** beside the download button, and the Map tab opens with
just **Area**, **Show** and **Measure**. If either is missing, the build
predates this and the export will not be ranked.

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
street. The unplaced remainder was mostly UBC/UEL and River District, which sit
outside the city's address file, plus a normaliser gap on the Kent Avenues.

That gap is fixed: a street whose name ends in a direction (`KENT AVE NORTH`)
meeting a roll that trails its own direction in a column (`SE`) now folds to the
City's spelling instead of missing on the name, the street type and the
direction at once. Expect the Fraser-lands addresses to place on this build and
the direct-lookup share to rise. The report also now says how many rows carry a
civic-number suffix and what happened to them — read that line before reading
the matched percentage, because a suffix the address file does not carry moves
rows out of "matched" and into "placed beside the nearest number" without
putting a single one in the wrong place.

Anything much below 90% means the join went wrong, not that the city has
changed. Stop and look rather than exporting.

---

## List 1 — Existing voters to target

Areas where the party already polls well *and* turnout is high: the places its
existing vote lives. The campaign filters this against the canvass database and
targets whoever is not already identified.

**Data tab → Rank this list on**, adding two measures:

| add | which |
|---|---|
| 1 | *Provincial party share — Conservative* · provincial areas |
| 2 | *Provincial turnout* · provincial areas |

Both halves are then the same election, 2024 provincial, which is what makes
"share *and* turnout" one statement about one electorate rather than two
statements about two.

Add them in the picker rather than setting the map. The map deliberately shows
one measure at a time now — picking a Measure blanks the other layers, so a
second one cannot be set there without going into *Map options* — and a list
built from two map selectors was always the fragile path anyway: nothing on
screen recorded which two.

If you would rather pair the 2024 share with **2025 federal** turnout, add
*Federal turnout* as the second measure instead. It is a defensible list —
turnout is fairly stable across elections at the area level — but say which you
did, and build list 2 the same way so the two files compare row for row.

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

**Data tab → Rank this list on**, adding two measures:

| add | which |
|---|---|
| 1 | *Provincial party share — Conservative* · provincial areas |
| 2 | *Federal party share — Liberal* · federal polls |

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

All three indicators go on one list, the same way as lists 1 and 2: **Rank this
list on** → pick → **Add measure**, three times. They appear under *On census
areas* in the picker, one entry per variable in the loaded profile.

This is the control to use for every list. The map shows one measure at a time
by design, so it cannot say "immigrants *and* homeowners *and* median income"
at all — and even for two measures it leaves no record of which two.

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

## How finely the list actually orders doors

This is the first thing a sharp client will push on, so know the answer.

Every measure except one is reported for an **area** — a polling division, a
voting area, a census area. Two doors in the same division carry identical
values on all of them, because the agency published one number for the
division. On a real export that means **254 distinct scores across 97,018
ranked doors**: the median score is shared by 237 addresses and the largest
block by 2,666. That is not a rounding artefact, it is the resolution of the
sources.

The one exception is **how many electors are at the address**, which the roll
gives per door. Add it under *Rank this list on* and the granularity changes
sharply — on the same file, 254 distinct scores becomes **4,787**, and the
median block of 237 doors becomes 2.

It is worth being exact about what that buys. The extra ordering is *by
building size*, because that is the only door-level fact in the data. It is
real information, not smoothing.

**Which end is the good end is yours to set, and for this campaign it is the
small end.** Large buildings skew renter and renters skew against the party, so
ranking big buildings up puts the weakest doors first. Each measure on the list
carries a **More is better / Fewer is better** button; set the elector-count
measure to *Fewer is better*. Set the tie-break below it to **Smallest building
first** for the same reason.

If your reason for the measure is delivery cost rather than persuasion — one
stop, many pieces — then largest-first is right and you want the opposite of
both. Decide which reason you are using; the file records whichever you chose,
so it can be defended either way.

Where the list still cannot separate doors — same area, same elector count —
it genuinely cannot. Nothing in these sources distinguishes them, and the file
says so by giving them the same score rather than inventing a difference.

**Doors that score the same** are ordered by the control beside the picker.
It defaults to largest building first, which is the delivery-cost argument;
*Address, alphabetically* is there for when you would rather the file admit it
has no preference.

To order doors on anything better than their size, you need door-level data. A
roll carrying vote history would do it; yours carries names and addresses only.
**Canvass results do it, and the atlas reads them now** — see below.

## Canvass results

*Data tab → Canvass results.* Drop in whatever your canvassing database
exports. It joins against the same address lookup the roll uses, so load that
first (or afterwards — a canvass dropped in early waits for it).

**The support column is yours to price.** Campaign databases agree on nothing,
so nothing is assumed: the atlas lists the distinct answers actually in your
file, with a row count each, and you give each one a number from 0 to 1. Words
it recognises — *Strong Support*, *Lean Against*, *Undecided* and their
variants — are filled in for you.

**Numbers are deliberately left blank.** Some databases count 1 as strongest
support, others count 1 as strongest opposition. Guessing wrong inverts your
entire canvass — every supporter becomes an opponent and the list ranks the
doors that told you no — and nothing downstream could detect it, because an
inverted scale is a perfectly well-formed scale. Ten seconds of typing removes
a failure mode that would otherwise be invisible.

**Leave a value blank to keep it out of the score.** That is what a refusal or
an unanswered door should usually be. A refusal is not weak support: scoring it
zero would rank a door that said nothing *below* a door that said no. Doors
with contacts but no score keep their rows and their contact count, and sit
unranked rather than last.

A door canvassed more than once averages what it said.

Then add **Canvass support at the address** under *Rank this list on*, like any
other measure. It is address-scoped, so it does what no area measure can: order
two doors in the same polling division by what they actually told you.

### What comes out

Two extra columns whenever a canvass is loaded:

| column | what it is |
|---|---|
| `canvass_contacts` | How many times this door appears in the file, scored or not. A door knocked twice and still unscored is a different problem from one never visited. |
| `canvass_support` | The mean of the scores you assigned, or blank where nothing there was scorable. |

That is the whole of it. **No name, no note, no phone number, no date reaches
the export** — they are read and dropped in the same pass, and a test asserts
it against a fixture carrying all of them. There is also no flag in
`tools/make-payload.js` that would bake canvass data into a shared build, by
any name such a flag might plausibly take, and a test asserts that too.

### Using it for the campaign's own filtering

The stated workflow is: export the list, check it against the canvassing
database, drop the already-identified, target the rest. Two of those three
steps are a join this now does for you. Sort or filter on `canvass_contacts`
in the exported file rather than across two files — `= 0` is never knocked,
`> 0` with a blank `canvass_support` is knocked and unresolved.

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
