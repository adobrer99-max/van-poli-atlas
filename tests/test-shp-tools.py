"""Checks tools/shp.py: the readers against the fixtures the writers produced,
and the zipped-shapefile clipper end to end."""
import io, os, sys, tempfile, unittest, zipfile
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(ROOT)
from tools import shp


class ReadersRoundTrip(unittest.TestCase):
    def test_shp(self):
        rings = shp.read_shp("fixtures/va.shp")
        self.assertEqual(len(rings), 3)
        self.assertEqual(len(rings[2]), 2, "third polygon carries its hole")
        self.assertEqual(rings[0][0][0], rings[0][0][-1], "rings are closed")

    def test_dbf(self):
        rows = shp.read_dbf("fixtures/va.dbf", "utf-8")
        self.assertEqual([i for i, _ in rows], [0, 1, 2])
        self.assertEqual(rows[0][1]["ED_NAME"], "Vancouver-Fairview")
        self.assertEqual(rows[0][1]["VA_CODE"], "015", "leading zero kept")
        self.assertEqual(rows[1][1]["ELECTORS"], 437)

    def test_header_and_records(self):
        with open("fixtures/e2e_va.shp", "rb") as fh:
            file_len, shape_type, bbox = shp.read_shp_header(fh)
        self.assertEqual(shape_type, 5)
        self.assertEqual(file_len, os.path.getsize("fixtures/e2e_va.shp"))
        with open("fixtures/e2e_va.shp", "rb") as fh:
            recs = list(shp.iter_shp_records(fh))
        self.assertEqual(len(recs), 700)
        self.assertTrue(all(b is not None and b[0] <= b[2] for _, _, b, _ in recs))


class Clipper(unittest.TestCase):
    def test_clip_keeps_matching_records_verbatim(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "clip.zip")
            kept, total = shp.clip_zipped_shapefile(
                "fixtures/e2e_voting_areas.zip", out, lambda row: row["VA_CODE"].startswith("01"))
            self.assertEqual(total, 700)
            self.assertEqual(kept, 25)
            with zipfile.ZipFile(out) as zf:
                names = sorted(zf.namelist())
                self.assertEqual(names, ["e2e_va_clip.dbf", "e2e_va_clip.prj", "e2e_va_clip.shp", "e2e_va_clip.shx"])
                rows = shp.read_dbf(io.BytesIO(zf.read("e2e_va_clip.dbf")))
                self.assertEqual([r["VA_CODE"] for _, r in rows], [f"01{j:02d}" for j in range(25)])
                clipped = shp.read_shp(io.BytesIO(zf.read("e2e_va_clip.shp")))
                self.assertEqual(len(clipped), 25)
                shx = zf.read("e2e_va_clip.shx")
                self.assertEqual(len(shx), 100 + 8 * 25)
                self.assertEqual(zf.read("e2e_va_clip.prj"), zipfile.ZipFile("fixtures/e2e_voting_areas.zip").read("e2e_va.prj"))
            original = shp.read_shp("fixtures/e2e_va.shp")
            orig_rows = shp.read_dbf("fixtures/e2e_va.dbf")
            by_code = {r["VA_CODE"]: original[i] for i, r in orig_rows}
            for (_, r), rings in zip(rows, clipped):
                self.assertEqual(rings, by_code[r["VA_CODE"]], "geometry copied byte for byte")

    def test_clip_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "none.zip")
            kept, total = shp.clip_zipped_shapefile("fixtures/e2e_voting_areas.zip", out, lambda row: False)
            self.assertEqual((kept, total), (0, 700))
            with zipfile.ZipFile(out) as zf:
                self.assertEqual(len(shp.read_shp(io.BytesIO(zf.read("e2e_va_clip.shp")))), 0)


if __name__ == "__main__":
    unittest.main(verbosity=1)
