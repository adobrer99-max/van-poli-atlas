#!/usr/bin/env python3
"""Cut Statistics Canada's 2021 census downloads down to a study area.

The national files are far too big to load into a browser tab, so this runs
on your own machine, once, and writes small files the atlas reads:

    python3 tools/filter_census.py \\
        --geo-attr 2021_92-151_X.zip \\
        --csd 5915022 \\
        --profile 98-401-X2021006_BC_eng_CSV.zip \\
        --clip-shp lda_000b21a_e.zip --clip-shp ldb_000b21a_e.zip \\
        --out-dir census/

Every input may be the .zip exactly as it downloaded; nothing needs extracting
first. That is not only tidiness: the British Columbia dissemination-area
profile is 3.5 GB unpacked against 300 MB packed, and this reads it out of the
archive at the same speed without ever writing it to disk.

Inputs (all from statcan.gc.ca, none redistributed here):
  --geo-attr   the 2021 Geographic Attribute File (one row per dissemination
               block: DBUID, DBPOP2021, DBTDWELL2021, DAUID, CSDUID, CSDNAME ...)
  --csd        a census subdivision id to keep (5915022 is the City of
               Vancouver); repeat for more. --csd-name matches CSDNAME instead.
  --profile    the comprehensive Census Profile for the province at the
               dissemination-area level (the long layout: one row per
               characteristic per geography), .csv or .zip. A profile at the
               wrong geographic level is rejected rather than silently writing
               empty files -- it is the easiest mistake here to make and the
               hardest to see.
  --clip-shp   a zipped boundary file (dissemination areas lda_000b21a_e.zip,
               dissemination blocks ldb_000b21a_e.zip); repeat for more

Outputs in --out-dir:
  db_population.csv    DBUID, DAUID, DBPOP2021, DBTDWELL2021, DBURDWELL2021
  da_population.csv    DAUID, population, dwellings (summed over blocks)
  census_da_wide.csv   one row per DA: DGUID, DAUID, then C<id> (count) and
                       R<id> (rate) for every characteristic
  variables.csv        id, depth, parent_id, name -- the characteristic list
  starter.csv          DAUID, DGUID and the starter variables the atlas
                       derives (the same spec as src/f3-census.js)
  <stem>_clip.zip      each clipped boundary file

--list PATTERN prints the characteristics whose name matches PATTERN (a
regular expression, case-insensitive) with their ids, then exits.

Standard library only. Column names are found by pattern and reported; when
a required column is missing the tool says which and stops.
"""
import argparse
import codecs
import csv
import io
import os
import re
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from tools import shp  # noqa: E402

csv.field_size_limit(1 << 30)

# The atlas's starter variables, spelled exactly as in src/f3-census.js:
# (key, label, name pattern, use, ancestor pattern). `use` is 'count' for a
# value taken as is, 'ratio' for 100 * count / count(ancestor).
STARTER = [
    ("pop_2021", "Population, 2021", r"^Population, 2021$", "count", None),
    ("pop_density", "Population density per km²", r"^Population density per square kilometre$", "count", None),
    ("median_age", "Median age", r"^Median age of the population$", "count", None),
    ("pct_65_plus", "Aged 65 and over (%)", r"^65 years and over$", "ratio", r"^Total - Age groups of the population"),
    ("avg_household_size", "Average household size", r"^Average household size$", "count", None),
    ("pct_one_person_hh", "One-person households (%)", r"^1 person$", "ratio", r"^Total - Private households by household size"),
    ("median_hh_income", "Median household income, 2020 ($)", r"^Median total income of household in 2020", "count", None),
    ("pct_lim_at", "Low income, LIM-AT (%)", r"^Prevalence of low income based on the Low-income measure, after tax", "count", None),
    ("unemployment_rate", "Unemployment rate (%)", r"^Unemployment rate$", "count", None),
    ("pct_renter", "Renter households (%)", r"^Renter$", "ratio", r"^Total - Private households by tenure"),
    ("pct_movers_5yr", "Moved in the last 5 years (%)", r"^Movers$", "ratio", r"^Total - Mobility status 5 years ago"),
    ("pct_immigrant", "Immigrants (%)", r"^Immigrants$", "ratio", r"^Total - Immigrant status and period of immigration"),
    ("pct_recent_immigrant", "Immigrated 2016 to 2021 (%)", r"^2016 to 2021$", "ratio", r"^Total - Immigrant status and period of immigration"),
    ("pct_bachelor_plus", "Bachelor's degree or higher, ages 25 to 64 (%)", r"^Bachelor.s degree or higher$", "ratio",
     r"^Total - Highest certificate, diploma or degree for the population aged 25 to 64"),
]

SUPPRESSED = re.compile(r"^(x|\.\.|\.\.\.|f|\.)$", re.I)


def norm(h):
    return re.sub(r"^_|_$", "", re.sub(r"[^A-Z0-9]+", "_", str(h or "").strip().upper()))


def parse_value(raw):
    s = str(raw if raw is not None else "").strip()
    if s == "" or SUPPRESSED.match(s):
        return None
    try:
        return float(s.replace(",", ""))
    except ValueError:
        return None


def geo_key(v):
    return re.sub(r"^\d{4}[A-Z]\d{4}(?=\d)", "", str(v or "").strip(), flags=re.I)


def find_col(header, *patterns):
    H = [norm(h) for h in header]
    for pat in patterns:
        rx = re.compile(pat)
        for i, h in enumerate(H):
            if rx.search(h):
                return i
    return -1


def csv_in_zip(path):
    """The one .csv of substance inside a StatCan archive. Their downloads ship
    the data beside a metadata file and a 'geo starting row' index, all .csv,
    so the largest is the data -- by a factor of thousands, never ambiguously."""
    with zipfile.ZipFile(path) as zf:
        members = [i for i in zf.infolist()
                   if i.filename.lower().endswith(".csv")
                   and not i.is_dir()
                   and "__MACOSX" not in i.filename
                   and not os.path.basename(i.filename).startswith(".")]
    if not members:
        raise SystemExit(f"{path} holds no .csv. It contains: "
                         + ", ".join(i.filename for i in zipfile.ZipFile(path).infolist()[:8]))
    members.sort(key=lambda i: i.file_size, reverse=True)
    return members[0].filename


def detect_encoding(chunk):
    """UTF-8 or cp1252, the two Statistics Canada ships.

    Decided with an incremental decoder rather than a plain decode, so a
    multi-byte character straddling the end of the chunk is not mistaken for
    the wrong encoding -- a whole file read as cp1252 because of where a
    buffer happened to end is a very quiet kind of wrong.

    Not hypothetical either: the Geographic Attribute File is bilingual, and
    the French place names in it carry accents. An e-acute is byte 0xE9, which
    is perfectly good cp1252 and is not valid UTF-8 at all."""
    try:
        codecs.getincrementaldecoder("utf-8-sig")().decode(chunk, False)
        return "utf-8-sig"
    except UnicodeDecodeError:
        return "cp1252"


def open_text(path, encoding=None):
    """Opens a StatCan CSV, sniffing UTF-8 then cp1252 unless told otherwise.

    A .zip is read without being extracted. This matters more than it sounds:
    the British Columbia dissemination-area profile is 3.5 GB uncompressed and
    300 MB packed, so extracting it first costs several gigabytes of disk to
    produce a file this script streams once and never needs again. Python reads
    it out of the archive at the same speed.

    Packed and loose go through one code path on purpose. They did not to begin
    with, and the zip half quietly lacked the cp1252 fallback -- so the file
    most likely to need it, the bilingual attribute file, was the one that
    could not be read."""
    if path.lower().endswith(".zip"):
        inner = csv_in_zip(path)

        def open_binary():
            return zipfile.ZipFile(path).open(inner, "r")
    else:
        def open_binary():
            return open(path, "rb")

    if not encoding:
        with open_binary() as fh:
            encoding = detect_encoding(fh.read(1 << 20))
    return io.TextIOWrapper(open_binary(), encoding=encoding, newline="")


# --- Geographic Attribute File ------------------------------------------------

def read_geo_attributes(path, csd_ids, csd_names, encoding=None):
    """Returns (rows, columns) for the blocks in the chosen subdivisions; rows
    are dicts with DBUID, DAUID, DBPOP2021, DBTDWELL2021, DBURDWELL2021, CSDUID, CSDNAME."""
    with open_text(path, encoding) as fh:
        reader = csv.reader(fh)
        header = next(reader)
        cols = {
            "DBUID": find_col(header, r"^DBUID$", r"DBUID"),
            "DAUID": find_col(header, r"^DAUID$", r"DAUID"),
            "CSDUID": find_col(header, r"^CSDUID$", r"CSDUID"),
            "CSDNAME": find_col(header, r"^CSDNAME$", r"CSDNAME"),
            "DBPOP2021": find_col(header, r"^DBPOP2021$", r"^DBPOP", r"^POPULATION"),
            "DBTDWELL2021": find_col(header, r"^DBTDWELL2021$", r"^DBTDWELL"),
            "DBURDWELL2021": find_col(header, r"^DBURDWELL2021$", r"^DBURDWELL"),
        }
        missing = [k for k in ("DBUID", "DAUID", "CSDUID", "DBPOP2021") if cols[k] < 0]
        if missing:
            raise SystemExit(f"{path}: cannot find column(s) {', '.join(missing)} in header: {header[:12]} ...")
        if not csd_ids and cols["CSDNAME"] < 0:
            raise SystemExit(f"{path}: --csd-name needs a CSDNAME column; use --csd with the subdivision id instead")
        wanted_names = [n.lower() for n in csd_names]
        rows = []
        for rec in reader:
            if len(rec) <= cols["DBUID"]:
                continue
            csd = rec[cols["CSDUID"]].strip()
            name = rec[cols["CSDNAME"]].strip() if cols["CSDNAME"] >= 0 else ""
            if csd_ids and csd not in csd_ids and not (wanted_names and name.lower() in wanted_names):
                continue
            if not csd_ids and wanted_names and name.lower() not in wanted_names:
                continue
            rows.append({k: (rec[i].strip() if i >= 0 and i < len(rec) else "") for k, i in cols.items()})
    return rows, {k: (header[i] if i >= 0 else None) for k, i in cols.items()}


def write_population_files(rows, out_dir):
    da = {}
    with open(os.path.join(out_dir, "db_population.csv"), "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["DBUID", "DAUID", "DBPOP2021", "DBTDWELL2021", "DBURDWELL2021"])
        for r in rows:
            w.writerow([r["DBUID"], r["DAUID"], r["DBPOP2021"], r["DBTDWELL2021"], r["DBURDWELL2021"]])
            pop, dw = parse_value(r["DBPOP2021"]), parse_value(r["DBTDWELL2021"])
            acc = da.setdefault(r["DAUID"], [0.0, 0.0])
            acc[0] += pop or 0.0
            acc[1] += dw or 0.0
    with open(os.path.join(out_dir, "da_population.csv"), "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["DAUID", "population", "dwellings"])
        for dauid in sorted(da):
            w.writerow([dauid, int(da[dauid][0]), int(da[dauid][1])])
    return da


# --- Census Profile (long) ----------------------------------------------------

def detect_layout(header):
    name = find_col(header, r"^CHARACTERISTIC_NAME$", r"CHARACTERISTIC.*NAME")
    if name < 0:
        return None
    return {
        "dguid": find_col(header, r"^DGUID$", r"DGUID"),
        "alt": find_col(header, r"^ALT_GEO_CODE$", r"ALT_GEO_CODE", r"^GEO_CODE"),
        "level": find_col(header, r"^GEO_LEVEL$"),
        "geoname": find_col(header, r"^GEO_NAME$"),
        "id": find_col(header, r"^CHARACTERISTIC_ID$", r"CHARACTERISTIC.*ID"),
        "name": name,
        "count": find_col(header, r"^C1_COUNT_TOTAL$", r"^C1_COUNT", r"COUNT_TOTAL", r"^TOTAL$"),
        "rate": find_col(header, r"^C10_RATE_TOTAL$", r"^C10_RATE", r"RATE_TOTAL"),
    }


class Profile:
    """Characteristics in file order with depth/parent, and per-geography
    count and rate lists indexed like the characteristic list."""

    def __init__(self):
        self.characteristics = []      # dicts: id, name, depth, parent_id, index
        self.by_id = {}
        self.by_geo = {}               # geo key -> {"dguid", "name", "count": [], "rate": []}
        self._stack = []
        # The level of the geographies actually KEPT, which is the one worth
        # reporting, and the levels seen anywhere, which is what diagnoses a
        # file that kept nothing.
        self.geo_level = ""
        self.levels_seen = []

    def characteristic(self, raw_id, raw_name):
        key = raw_id if raw_id is not None else raw_name
        c = self.by_id.get(key)
        if c is None:
            leading = len(raw_name) - len(raw_name.lstrip(" "))
            depth = leading // 2
            del self._stack[depth:]
            parent = self._stack[-1] if self._stack else None
            c = {"id": raw_id if raw_id is not None else len(self.characteristics) + 1,
                 "name": raw_name.strip(), "depth": depth,
                 "parent_id": parent["id"] if parent else None, "index": len(self.characteristics)}
            self.characteristics.append(c)
            self.by_id[key] = c
            self._stack.append(c)
        return c

    def ancestors(self, c):
        out = []
        cur = c
        by_real_id = {x["id"]: x for x in self.characteristics}
        while cur and cur["parent_id"] is not None:
            cur = by_real_id.get(cur["parent_id"])
            if cur:
                out.append(cur)
        return out


def pivot(reader, layout, keep_codes=None, stop_after_first_geo=False):
    """Streams the long profile into a Profile. keep_codes: set of DAUIDs (or
    None for all). stop_after_first_geo only collects the characteristic list."""
    profile = Profile()
    first_geo = None
    level_of = ((lambda rec: rec[layout["level"]].strip())
                if layout["level"] >= 0 else (lambda rec: ""))
    for rec in reader:
        if len(rec) <= layout["name"]:
            continue
        raw_name = rec[layout["name"]]
        alt = rec[layout["alt"]].strip() if layout["alt"] >= 0 else ""
        geo = geo_key(alt if alt else (rec[layout["dguid"]] if layout["dguid"] >= 0 else ""))
        if not geo:
            continue
        if len(profile.levels_seen) < 12:
            lvl = level_of(rec)
            if lvl and lvl not in profile.levels_seen:
                profile.levels_seen.append(lvl)
        if first_geo is None:
            first_geo = geo
        elif stop_after_first_geo and geo != first_geo:
            break
        raw_id = None
        if layout["id"] >= 0:
            try:
                raw_id = int(rec[layout["id"]].strip())
            except ValueError:
                raw_id = None
        c = profile.characteristic(raw_id, raw_name)
        if keep_codes is not None and geo not in keep_codes:
            continue
        g = profile.by_geo.get(geo)
        if g is None:
            if not profile.geo_level:
                profile.geo_level = level_of(rec)
            g = profile.by_geo[geo] = {
                "dguid": rec[layout["dguid"]].strip() if layout["dguid"] >= 0 else "",
                "name": rec[layout["geoname"]].strip() if layout["geoname"] >= 0 else "",
                "count": [], "rate": []}
        idx = c["index"]
        for key, col in (("count", layout["count"]), ("rate", layout["rate"])):
            arr = g[key]
            while len(arr) <= idx:
                arr.append(None)
            arr[idx] = parse_value(rec[col]) if col >= 0 and col < len(rec) else None
    return profile


def resolve_spec(profile, name_pat, over_pat):
    name_rx = re.compile(name_pat, re.I)
    over_rx = re.compile(over_pat, re.I) if over_pat else None
    for c in profile.characteristics:
        if not name_rx.search(c["name"]):
            continue
        if over_rx is None:
            return c, None
        for a in profile.ancestors(c):
            if over_rx.search(a["name"]):
                return c, a
    return None, None


def derive_starters(profile, spec=STARTER):
    """Returns (columns, rows_by_geo, matched, unmatched). rows_by_geo maps a
    geo key to a list of values aligned with columns (None when unavailable)."""
    columns, picks, matched, unmatched = [], [], [], []
    for key, label, name_pat, use, over_pat in spec:
        c, over = resolve_spec(profile, name_pat, over_pat)
        if c is None:
            unmatched.append(key)
            continue
        columns.append(key)
        picks.append((c, over, use))
        matched.append((key, c["id"], c["name"], over["name"] if over else None))
    rows = {}
    for geo, g in profile.by_geo.items():
        vals = []
        for c, over, use in picks:
            def at(arr, i):
                return arr[i] if i < len(arr) else None
            if use == "ratio":
                num = at(g["count"], c["index"])
                den = at(g["count"], over["index"]) if over else None
                vals.append(100.0 * num / den if num is not None and den else None)
            elif use == "rate":
                vals.append(at(g["rate"], c["index"]))
            else:
                vals.append(at(g["count"], c["index"]))
        rows[geo] = vals
    return columns, rows, matched, unmatched


def fmt(v):
    if v is None:
        return ""
    return ("%.10g" % v) if isinstance(v, float) else str(v)


def write_profile_outputs(profile, out_dir):
    n = len(profile.characteristics)
    with open(os.path.join(out_dir, "census_da_wide.csv"), "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["DGUID", "DAUID"] + ["C%d" % c["id"] for c in profile.characteristics]
                   + ["R%d" % c["id"] for c in profile.characteristics])
        for geo in sorted(profile.by_geo):
            g = profile.by_geo[geo]
            cnt = g["count"] + [None] * (n - len(g["count"]))
            rat = g["rate"] + [None] * (n - len(g["rate"]))
            w.writerow([g["dguid"], geo] + [fmt(v) for v in cnt] + [fmt(v) for v in rat])
    with open(os.path.join(out_dir, "variables.csv"), "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["id", "depth", "parent_id", "name"])
        for c in profile.characteristics:
            w.writerow([c["id"], c["depth"], "" if c["parent_id"] is None else c["parent_id"], c["name"]])
    columns, rows, matched, unmatched = derive_starters(profile)
    with open(os.path.join(out_dir, "starter.csv"), "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["DAUID", "DGUID"] + columns)
        for geo in sorted(rows):
            w.writerow([geo, profile.by_geo[geo]["dguid"]] + [fmt(v) for v in rows[geo]])
    return matched, unmatched


# --- Command line -----------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--geo-attr", help="2021 Geographic Attribute File (CSV)")
    ap.add_argument("--csd", action="append", default=[], help="census subdivision id to keep (repeatable)")
    ap.add_argument("--csd-name", action="append", default=[], help="census subdivision name to keep (repeatable)")
    ap.add_argument("--profile", help="Census Profile CSV, long layout, dissemination-area level")
    ap.add_argument("--clip-shp", action="append", default=[], help="zipped boundary file to clip (repeatable)")
    ap.add_argument("--out-dir", default="census")
    ap.add_argument("--list", metavar="PATTERN", help="print characteristics matching PATTERN and exit")
    ap.add_argument("--encoding", help="force an input encoding (default: UTF-8, then cp1252)")
    args = ap.parse_args(argv)

    if args.list:
        if not args.profile:
            ap.error("--list needs --profile")
        with open_text(args.profile, args.encoding) as fh:
            reader = csv.reader(fh)
            layout = detect_layout(next(reader))
            if layout is None:
                raise SystemExit("the profile has no CHARACTERISTIC_NAME column; is this the long layout?")
            profile = pivot(reader, layout, keep_codes=set(), stop_after_first_geo=True)
        rx = re.compile(args.list, re.I)
        for c in profile.characteristics:
            if rx.search(c["name"]):
                print("%6s  %s%s" % (c["id"], "  " * c["depth"], c["name"]))
        return 0

    if not args.geo_attr:
        ap.error("--geo-attr is required (the block set defines the study area)")
    if not args.csd and not args.csd_name:
        ap.error("give at least one --csd or --csd-name")
    os.makedirs(args.out_dir, exist_ok=True)

    rows, cols = read_geo_attributes(args.geo_attr, set(args.csd), args.csd_name, args.encoding)
    if not rows:
        raise SystemExit("no blocks matched the chosen subdivision(s); check --csd / --csd-name")
    da_pop = write_population_files(rows, args.out_dir)
    dbuids = {r["DBUID"] for r in rows}
    dauids = set(da_pop)
    print(f"blocks: {len(dbuids):,} in {len(dauids):,} dissemination areas; "
          f"population {int(sum(v[0] for v in da_pop.values())):,} "
          f"(columns {cols['DBUID']}, {cols['DAUID']}, {cols['DBPOP2021']})")
    print(f"  wrote {args.out_dir}/db_population.csv and da_population.csv")

    if args.profile:
        with open_text(args.profile, args.encoding) as fh:
            reader = csv.reader(fh)
            header = next(reader)
            layout = detect_layout(header)
            if layout is None:
                raise SystemExit("the profile has no CHARACTERISTIC_NAME column; is this the long layout?")
            for k in ("count", "name"):
                if layout[k] < 0:
                    raise SystemExit(f"the profile lacks a {k} column (header: {header[:12]} ...)")
            profile = pivot(reader, layout, keep_codes=dauids)
        missing = dauids - set(profile.by_geo)
        level = profile.geo_level or "(not stated)"
        if not profile.by_geo:
            seen = ", ".join(profile.levels_seen) or "(none stated)"
            raise SystemExit(
                f"NONE of the {len(dauids):,} dissemination areas appear in this profile, so it "
                "would have written empty files.\n"
                f"The geographic levels in this file are: {seen}.\n"
                "The product that reaches dissemination areas is 98-401-X2021006. Two look-alikes:\n"
                "  98-401-X2021025  Census Subdivisions in British Columbia -- Vancouver as ONE row\n"
                "  ...any number ending CI   the confidence-interval variant, which omits\n"
                "                           population, age, household size and income entirely\n"
                "Run again with --list population to see what this file actually contains.")
        print(f"profile: {len(profile.by_geo):,} of {len(dauids):,} dissemination areas found "
              f"(geographic level: {level}), {len(profile.characteristics):,} characteristics"
              + (f"; {len(missing)} DA(s) absent from the profile" if missing else ""))
        matched, unmatched = write_profile_outputs(profile, args.out_dir)
        print("  starter variables:")
        for key, cid, name, over in matched:
            print(f"    {key:22s} <- {cid:>6}: {name}" + (f"  (of {over})" if over else ""))
        for key in unmatched:
            print(f"    {key:22s} <- NOT FOUND (pick a characteristic by id in the atlas instead)")
        print(f"  wrote {args.out_dir}/census_da_wide.csv, variables.csv, starter.csv")

    for zip_path in args.clip_shp:
        with zipfile.ZipFile(zip_path) as zf:
            members = shp.shapefile_members(zf)
            with zf.open(members["dbf"]) as fh:
                fields, _, _, _ = shp.read_dbf_header(io.BufferedReader(fh))
        names = [f[0].upper() for f in fields]
        if "DBUID" in names:
            key, wanted = "DBUID", dbuids
        elif "DAUID" in names:
            key, wanted = "DAUID", dauids
        else:
            raise SystemExit(f"{zip_path}: the .dbf has neither DAUID nor DBUID (fields: {names[:10]})")
        field = fields[names.index(key)][0]
        out = os.path.join(args.out_dir, members["stem"] + "_clip.zip")
        kept, total = shp.clip_zipped_shapefile(
            zip_path, out, lambda row, f=field, w=wanted: str(row.get(f, "")).strip() in w,
            progress=lambda n: print(f"    ... {n:,} records scanned", file=sys.stderr))
        print(f"clipped {zip_path}: kept {kept:,} of {total:,} records by {key} -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
