"""Checks tools/clip_geojson.py on the Elections BC order fixture
(fixtures/e2e_ebc_order.zip, written by tests/make-e2e-fixtures.py)."""
import json, os, subprocess, sys, tempfile, unittest
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
ORDER = "fixtures/e2e_ebc_order.zip"
with open("fixtures/e2e_expected.json") as _fh:
    EXPECTED = json.load(_fh)["ebc"]


def run(*args):
    r = subprocess.run([sys.executable, "tools/clip_geojson.py", ORDER, *args], capture_output=True, text=True)
    return r.returncode, r.stdout, r.stderr


class Clip(unittest.TestCase):
    def test_list(self):
        code, out, err = run("--list", "--study-area")
        self.assertEqual(code, 0, err)
        self.assertIn("EBC_VOTING_AREAS_BS11_POLY_SVW.geojson", out, "the .geojson member is read, not the metadata .json")
        self.assertIn(f"{EXPECTED['total']:,} features", out)
        far = [l for l in out.splitlines() if l.startswith("FAR")][0].split()
        self.assertEqual((far[1], far[2]), (str(EXPECTED["far"]), "0"), "the far district has no area in the study box")
        sd = [l for l in out.splitlines() if l.startswith("SD01")][0].split()
        self.assertEqual(sd[1], sd[2], "every SD01 area touches the study box")

    def test_study_area(self):
        with tempfile.TemporaryDirectory() as tmp:
            out_path = os.path.join(tmp, "van.geojson")
            code, out, err = run("--study-area", "--out", out_path)
            self.assertEqual(code, 0, err)
            self.assertIn(f"kept {EXPECTED['in_study_area']} of {EXPECTED['total']:,}", out)
            with open(out_path) as fh:
                doc = json.load(fh)
            self.assertEqual(doc["name"], "EBC_VOTING_AREAS_BS11_POLY_SVW", "top-level members other than features are kept")
            self.assertEqual(len(doc["features"]), EXPECTED["in_study_area"])
            self.assertNotIn("FAR", {f["properties"]["ED_ABBREVIATION"] for f in doc["features"]})
            p = doc["features"][0]["properties"]
            self.assertEqual(set(p), {"VOTING_AREA_POLY_ID", "BOUNDARY_SET_ID", "ED_ABBREVIATION", "VA_CODE", "EDVA_CODE",
                                      "VA_TYPE", "DATA_ACCESS_LEVEL", "GAZETTE_DATE", "FEATURE_AREA_SQM", "FEATURE_LENGTH_M",
                                      "OBJECTID", "SE_ANNO_CAD_DATA", "SHAPE.AREA", "SHAPE.LEN"}, "properties pass through unchanged")

    def test_districts_and_precision(self):
        with tempfile.TemporaryDirectory() as tmp:
            out_path = os.path.join(tmp, "far.geojson")
            code, out, err = run("--ed", "FAR", "SD01", "NOPE", "--precision", "5", "--out", out_path)
            self.assertEqual(code, 0, err)
            self.assertIn("NOPE", err, "an unknown district code is reported")
            with open(out_path) as fh:
                doc = json.load(fh)
            codes = {f["properties"]["ED_ABBREVIATION"] for f in doc["features"]}
            self.assertEqual(codes, {"FAR", "SD01"})
            self.assertEqual(sum(1 for f in doc["features"] if f["properties"]["ED_ABBREVIATION"] == "FAR"), EXPECTED["far"])
            for f in doc["features"]:
                for x, y in f["geometry"]["coordinates"][0]:
                    self.assertEqual(x, round(x, 5)); self.assertEqual(y, round(y, 5))
            # a district filter and a box together both have to pass
            code, out, err = run("--ed", "FAR", "--study-area")
            self.assertNotEqual(code, 0)
            self.assertIn("nothing kept", err)

    def test_bbox_and_like(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, out, err = run("--bbox", "-123.4", "49.1", "-122.9", "49.4")
            self.assertEqual(code, 0, err)
            self.assertIn(f"kept {EXPECTED['in_study_area']} of", out)
            self.assertIn("nothing written", out)
            code, out, err = run("--like", "fixtures/e2e_va.geojson", "--pad-km", "0")
            self.assertEqual(code, 0, err)
            self.assertIn(f"kept {EXPECTED['in_study_area']} of", out)

    def test_plain_geojson_input(self):
        r = subprocess.run([sys.executable, "tools/clip_geojson.py", "fixtures/e2e_va.geojson", "--property", "ED_NAME", "--list"],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("Sample District 1", r.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=1)
