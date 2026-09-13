"""Checks tools/filter_census.py end to end on a small StatCan-shaped profile
and attribute file built here, with the same numbers tests/test-census.js
checks in the browser-side reader, so the two agree."""
import csv, io, os, subprocess, sys, tempfile, unittest, zipfile
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(ROOT)
from tools import filter_census as fc, shp

HEADER = ["CENSUS_YEAR", "DGUID", "ALT_GEO_CODE", "GEO_LEVEL", "GEO_NAME", "TNR_SF", "TNR_LF", "DATA_QUALITY_FLAG",
          "CHARACTERISTIC_ID", "CHARACTERISTIC_NAME", "CHARACTERISTIC_NOTE", "C1_COUNT_TOTAL", "SYMBOL",
          "C2_COUNT_MEN+", "SYMBOL", "C3_COUNT_WOMEN+", "SYMBOL", "C10_RATE_TOTAL", "SYMBOL", "C11_RATE_MEN+", "SYMBOL",
          "C12_RATE_WOMEN+", "SYMBOL"]
CHARS = [(1, "Population, 2021"), (8, "Total - Age groups of the population - 100% data"), (9, "  0 to 14 years"),
         (11, "  65 years and over"), (39, "Median age of the population"),
         (1416, "Total - Private households by tenure - 25% sample data"), (1417, "  Owner"), (1418, "  Renter"),
         (1900, "Total - Mobility status 1 year ago - 25% sample data"), (1902, "  Movers"),
         (1910, "Total - Mobility status 5 years ago - 25% sample data"), (1912, "  Movers"),
         (2224, "Unemployment rate")]
DAS = {
    "59150101": {1: 500, 8: 500, 9: 80, 11: 80, 39: 41.2, 1416: 200, 1417: 120, 1418: 80, 1900: 480, 1902: 80, 1910: 480, 1912: 230, 2224: 6.1},
    "59150102": {1: 1000, 8: 1000, 9: 100, 11: 200, 39: 45.0, 1416: 450, 1417: 90, 1418: 360, 1900: 980, 1902: 80, 1910: 980, 1912: 490, 2224: 9.3},
    "59150103": {1: 300, 8: 300, 9: 60, 11: 40, 39: 38.9, 1416: 100, 1417: 75, 1418: "x", 1900: 290, 1902: 10, 1910: 290, 1912: 90, 2224: ".."},
    "59159999": {1: 50, 8: 50, 9: 5, 11: 5, 39: 50.0, 1416: 20, 1417: 20, 1418: 0, 1900: 50, 1902: 0, 1910: 50, 1912: 0, 2224: 0.0},
}


def write_inputs(tmp):
    prof = os.path.join(tmp, "profile.csv")
    with open(prof, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(HEADER)
        for code, values in DAS.items():
            for cid, name in CHARS:
                v = values[cid]
                w.writerow(["2021", "2021S0512" + code, code, "Dissemination area", code, "3", "7", "0", cid, name, "",
                            "" if v is None else v, v if v in ("x", "..") else "", "", "", "", "", "", "", "", "", "", ""])
    gaf = os.path.join(tmp, "gaf.csv")
    with open(gaf, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["DBUID", "DBPOP2021", "DBTDWELL2021", "DBURDWELL2021", "DAUID", "CSDUID", "CSDNAME", "PRUID"])
        w.writerow(["5915010101", "120", "50", "48", "59150101", "5915022", "Vancouver", "59"])
        w.writerow(["5915010102", "380", "150", "140", "59150101", "5915022", "Vancouver", "59"])
        w.writerow(["5915010201", "1000", "400", "390", "59150102", "5915022", "Vancouver", "59"])
        w.writerow(["5915010301", "300", "100", "99", "59150103", "5915022", "Vancouver", "59"])
        w.writerow(["5915999901", "50", "20", "20", "59159999", "5915055", "Burnaby", "59"])
    return prof, gaf


class Tool(unittest.TestCase):
    def test_end_to_end(self):
        with tempfile.TemporaryDirectory() as tmp:
            prof, gaf = write_inputs(tmp)
            out = os.path.join(tmp, "out")
            # A boundary file to clip: three DA cells keyed by DAUID, one of them outside the CSD.
            polys, rows = [], []
            for i, code in enumerate(["59150101", "59150102", "59159999"]):
                x, y = 4_000_000 + i * 1000, 2_000_000
                polys.append([[(x, y), (x, y + 500), (x + 500, y + 500), (x + 500, y), (x, y)]])
                rows.append({"DAUID": code, "DGUID": "2021S0512" + code})
            shp.write_shp(os.path.join(tmp, "lda.shp"), polys)
            shp.write_dbf(os.path.join(tmp, "lda.dbf"), [("DAUID", "C", 8, 0), ("DGUID", "C", 21, 0)], rows)
            with open(os.path.join(tmp, "lda.prj"), "w") as fh:
                fh.write('PROJCS["PCS_Lambert_Conformal_Conic"]')
            zpath = os.path.join(tmp, "lda_000b21a_e.zip")
            with zipfile.ZipFile(zpath, "w") as z:
                for ext in ("shp", "shx", "dbf", "prj"):
                    z.write(os.path.join(tmp, "lda." + ext), "lda_000b21a_e." + ext)

            r = subprocess.run([sys.executable, "tools/filter_census.py", "--geo-attr", gaf, "--csd", "5915022",
                                "--profile", prof, "--clip-shp", zpath, "--out-dir", out],
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertIn("blocks: 4 in 3 dissemination areas; population 1,800", r.stdout)
            self.assertIn("pct_movers_5yr", r.stdout)
            self.assertIn("1912: Movers", r.stdout)
            self.assertIn("NOT FOUND", r.stdout, "starters absent from this small profile are reported")

            with open(os.path.join(out, "db_population.csv"), newline="") as fh:
                db = list(csv.DictReader(fh))
            self.assertEqual([d["DBUID"] for d in db], ["5915010101", "5915010102", "5915010201", "5915010301"])
            with open(os.path.join(out, "da_population.csv"), newline="") as fh:
                da = {d["DAUID"]: d for d in csv.DictReader(fh)}
            self.assertEqual(da["59150101"]["population"], "500")
            self.assertNotIn("59159999", da, "Burnaby's block is filtered out")

            with open(os.path.join(out, "starter.csv"), newline="") as fh:
                starter = {d["DAUID"]: d for d in csv.DictReader(fh)}
            self.assertEqual(sorted(starter), ["59150101", "59150102", "59150103"])
            self.assertAlmostEqual(float(starter["59150102"]["pct_renter"]), 100 * 360 / 450, places=9)
            self.assertAlmostEqual(float(starter["59150101"]["pct_65_plus"]), 16.0, places=9)
            self.assertAlmostEqual(float(starter["59150102"]["pct_movers_5yr"]), 50.0, places=9,
                                   msg="Movers taken from the 5-year total, not the 1-year one")
            self.assertEqual(starter["59150103"]["pct_renter"], "", "suppressed cell stays empty")
            self.assertEqual(starter["59150103"]["unemployment_rate"], "")
            self.assertEqual(starter["59150101"]["median_age"], "41.2")

            with open(os.path.join(out, "census_da_wide.csv"), newline="") as fh:
                wide = list(csv.DictReader(fh))
            self.assertEqual(len(wide), 3)
            self.assertEqual(wide[0]["C1418"], "80")
            self.assertEqual(wide[0]["DGUID"], "2021S051259150101")
            with open(os.path.join(out, "variables.csv"), newline="") as fh:
                variables = {v["id"]: v for v in csv.DictReader(fh)}
            self.assertEqual((variables["1418"]["depth"], variables["1418"]["parent_id"]), ("1", "1416"))

            clip = os.path.join(out, "lda_000b21a_e_clip.zip")
            with zipfile.ZipFile(clip) as z:
                kept = shp.read_dbf(io.BytesIO(z.read("lda_000b21a_e_clip.dbf")))
                self.assertEqual([r["DAUID"] for _, r in kept], ["59150101", "59150102"])
                self.assertEqual(len(shp.read_shp(io.BytesIO(z.read("lda_000b21a_e_clip.shp")))), 2)

    def test_list(self):
        with tempfile.TemporaryDirectory() as tmp:
            prof, _ = write_inputs(tmp)
            r = subprocess.run([sys.executable, "tools/filter_census.py", "--profile", prof, "--list", "movers"],
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual(r.stdout.count("Movers"), 2)
            self.assertIn("1912", r.stdout)

    def test_missing_column_is_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = os.path.join(tmp, "bad.csv")
            with open(bad, "w", newline="") as fh:
                csv.writer(fh).writerows([["A", "B"], ["1", "2"]])
            r = subprocess.run([sys.executable, "tools/filter_census.py", "--geo-attr", bad, "--csd", "1", "--out-dir", tmp],
                               capture_output=True, text=True)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("cannot find column", r.stderr)

    def test_reads_a_csv_straight_out_of_a_zip(self):
        """Statistics Canada ships the profile packed, and the British Columbia
        dissemination-area file is 3.5 GB unpacked against 300 MB packed. Making
        someone extract it first costs several gigabytes of disk to produce a
        file this script streams once, so a .zip is read in place."""
        with tempfile.TemporaryDirectory() as tmp:
            prof, gaf = write_inputs(tmp)
            packed = os.path.join(tmp, "98-401-X2021006_BC_eng_CSV.zip")
            with zipfile.ZipFile(packed, "w", zipfile.ZIP_DEFLATED) as zf:
                zf.write(prof, "98-401-X2021006_English_CSV_data.csv")
                # The archive also carries a geo index and a metadata file, both
                # .csv, so "the data file" cannot just mean "the only csv".
                zf.writestr("98-401-X2021006_Geo_starting_row_CSV.csv", "GEO,ROW\nx,1\n")
                zf.writestr("README_meta.txt", "not a csv")
            self.assertEqual(fc.csv_in_zip(packed), "98-401-X2021006_English_CSV_data.csv")
            out = os.path.join(tmp, "out")
            r = subprocess.run([sys.executable, "tools/filter_census.py", "--geo-attr", gaf,
                                "--csd", "5915022", "--profile", packed, "--out-dir", out],
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("3 of 3 dissemination areas found", r.stdout)
            # And the result is the same as from the unpacked file.
            loose = os.path.join(tmp, "loose")
            subprocess.run([sys.executable, "tools/filter_census.py", "--geo-attr", gaf,
                            "--csd", "5915022", "--profile", prof, "--out-dir", loose],
                           capture_output=True, text=True, check=True)
            for name in ("starter.csv", "census_da_wide.csv", "variables.csv"):
                with open(os.path.join(out, name)) as a, open(os.path.join(loose, name)) as b:
                    self.assertEqual(a.read(), b.read(), name)

    def test_the_geographic_level_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            prof, gaf = write_inputs(tmp)
            r = subprocess.run([sys.executable, "tools/filter_census.py", "--geo-attr", gaf,
                                "--csd", "5915022", "--profile", prof, "--out-dir", os.path.join(tmp, "o")],
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("geographic level: Dissemination area", r.stdout)

    def test_a_profile_at_the_wrong_level_is_an_error(self):
        """The 98-401-X2021025 / ...006 mix-up is the easiest mistake to make
        here and the hardest to see: a profile of census subdivisions parses
        perfectly and matches no dissemination area, so without this it writes
        empty files and says nothing useful."""
        with tempfile.TemporaryDirectory() as tmp:
            prof, gaf = write_inputs(tmp)
            wrong = os.path.join(tmp, "subdivisions.csv")
            with open(prof) as src, open(wrong, "w", newline="") as dst:
                r = csv.reader(src); w = csv.writer(dst)
                w.writerow(next(r))
                for row in r:
                    row[1], row[2] = "2021A00055915022", "5915022"   # Vancouver, as one row
                    row[3] = "Census subdivision"
                    w.writerow(row)
            out = subprocess.run([sys.executable, "tools/filter_census.py", "--geo-attr", gaf,
                                  "--csd", "5915022", "--profile", wrong, "--out-dir", os.path.join(tmp, "o")],
                                 capture_output=True, text=True)
            self.assertNotEqual(out.returncode, 0, out.stdout)
            self.assertIn("NONE of the 3 dissemination areas", out.stderr)
            self.assertIn("Census subdivision", out.stderr)
            self.assertIn("98-401-X2021006", out.stderr)

    def test_a_bilingual_cp1252_file_is_read_packed_or_loose(self):
        """The Geographic Attribute File is bilingual and its French place
        names carry accents: an e-acute is byte 0xE9, good cp1252 and not valid
        UTF-8. Reading a .zip used to skip the cp1252 fallback that the loose
        path had, so the one file most likely to need it was the one that could
        not be read. Both paths go through one sniff now, and this holds them
        to it."""
        with tempfile.TemporaryDirectory() as tmp:
            loose = os.path.join(tmp, "2021_92-151_X.csv")
            rows = [["DBUID", "DBPOP2021", "DBTDWELL2021", "DBURDWELL2021", "DAUID", "CSDUID", "CSDNAME", "PRUID"],
                    ["5915010101", "120", "50", "48", "59150101", "5915022", "Vancouver", "59"],
                    ["2423027001", "90", "40", "38", "24230270", "2423027", "Montr\u00e9al", "24"]]
            with open(loose, "w", newline="", encoding="cp1252") as fh:
                csv.writer(fh).writerows(rows)
            self.assertIn(b"\xe9", open(loose, "rb").read(), "the fixture must carry the byte in question")
            packed = os.path.join(tmp, "2021_92-151_X.zip")
            with zipfile.ZipFile(packed, "w", zipfile.ZIP_DEFLATED) as zf:
                zf.write(loose, "2021_92-151_X.csv")
            for path in (loose, packed):
                with fc.open_text(path) as fh:
                    reader = csv.reader(fh)
                    next(reader)
                    self.assertEqual([r[6] for r in reader], ["Vancouver", "Montr\u00e9al"], path)
            # A UTF-8 file must still be read as UTF-8, not guessed into cp1252.
            utf8 = os.path.join(tmp, "utf8.csv")
            with open(utf8, "w", newline="", encoding="utf-8-sig") as fh:
                csv.writer(fh).writerows(rows)
            with fc.open_text(utf8) as fh:
                reader = csv.reader(fh)
                next(reader)
                self.assertEqual([r[6] for r in reader], ["Vancouver", "Montr\u00e9al"])

    def test_a_character_split_by_the_chunk_boundary_does_not_flip_the_guess(self):
        """The sniff reads a megabyte. A multi-byte character straddling the
        end of it must not be read as a broken byte, or a whole UTF-8 file is
        decoded as cp1252 because of where a buffer happened to end."""
        blob = ("\u00e9" * 600_000).encode("utf-8")
        self.assertGreater(len(blob), 1 << 20)
        self.assertEqual(fc.detect_encoding(blob[:1 << 20]), "utf-8-sig")
        self.assertEqual(fc.detect_encoding("Montr\u00e9al".encode("cp1252")), "cp1252")


if __name__ == "__main__":
    unittest.main(verbosity=1)
