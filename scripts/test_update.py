"""Quick tests for scripts/update.py. Run: python3 -m unittest discover -s scripts -p 'test_update.py'"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import update  # noqa: E402


class ClassifyStatus(unittest.TestCase):
    repo = Path("/repo")

    def classify(self, *entries):
        return update.classify_status("\0".join(entries) + "\0", self.repo, self.repo / ".fork-out")

    def test_ignorable_paths(self):
        ignorable, blocking = self.classify("?? .fork-out/deploy.log", "?? task-history-handoffs/a.md")
        self.assertEqual(len(ignorable), 2)
        self.assertEqual(blocking, [])

    def test_blocking_paths(self):
        ignorable, blocking = self.classify(" M app.txt", "?? stray.txt", "A  new.txt", "UU both.txt", " M task-history-handoffs/tracked.md")
        self.assertEqual(ignorable, [])
        self.assertEqual(len(blocking), 5)
        self.assertIn("both.txt (conflicted)", blocking)

    def test_out_dir_outside_repo_ignores_nothing_extra(self):
        raw = "?? .fork-out/x\0"
        _, blocking = update.classify_status(raw, self.repo, Path("/elsewhere/out"))
        self.assertEqual(blocking, [".fork-out/x (??)"])

    def test_rename_skips_original_path(self):
        self.assertEqual(update.parse_status("R  new.txt\0old.txt\0 M other.txt\0"), [("R ", "new.txt"), (" M", "other.txt")])


class StepMarkers(unittest.TestCase):
    LOG = (
        "\n==> Deploying 1.2.3-nightly.4 (estimated 2:42; log: /o/deploy.log)\n"
        "[1/4] Fetching upstream (about 0:05)\n[2/4] Installing dependencies (about 0:15)\n"
    )

    def test_running(self):
        view = update.parse_deploy_output(self.LOG)
        self.assertEqual(view.current, 2)
        self.assertEqual(view.seen[1], ("Installing dependencies", 15))
        self.assertEqual((view.version, view.detail_log, view.finished), ("1.2.3-nightly.4", "/o/deploy.log", False))

    def test_done_and_rollback(self):
        view = update.parse_deploy_output(self.LOG + "Done in 2:31. Installed 1.2.3-nightly.4; T3 apps in /Applications: 1.\nRollback copy: /o/T3-old-nightly.app (quit)\n")
        self.assertTrue(view.ok and view.finished)
        self.assertEqual((view.total_secs, view.installed, view.rollback), (151, "1.2.3-nightly.4", "/o/T3-old-nightly.app"))

    def test_failure(self):
        view = update.parse_deploy_output(self.LOG + "error: 'Installing dependencies' failed. Full log: /o/deploy.log\n")
        self.assertTrue(view.finished and not view.ok)
        self.assertEqual(view.failed_step, "Installing dependencies")

    def test_step_times(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "step-times"
            path.write_text("Building the app\t140\nbad line\nInstalling\tx\n")
            self.assertEqual(update.read_step_times(path), {"Building the app": 140})
            self.assertEqual(update.read_step_times(Path(d) / "missing"), {})


class Eta(unittest.TestCase):
    def test_before_start(self):
        self.assertEqual(update.compute_eta([5, 15, 130, 12], None, 0).remaining, 162)

    def test_mid_step(self):
        eta = update.compute_eta([5, 15, 130, 12], 2, 30)
        self.assertEqual((eta.remaining, eta.over), (112, 0))
        self.assertEqual(eta.percent, (20 + 30) * 100 // 162)

    def test_over_estimate_clamps(self):
        eta = update.compute_eta([5, 15, 130, 12], 2, 200)
        self.assertEqual((eta.remaining, eta.over), (12, 70))
        self.assertLessEqual(eta.percent, 99)
        self.assertEqual(update.compute_eta([5], 0, 50).remaining, 0)

    def test_plan_prefers_step_times_then_defaults(self):
        view = update.parse_deploy_output("[1/4] Fetching upstream (about 0:09)\n")
        plan = update.build_plan(view, {"Building the app": 99})
        self.assertEqual(plan[0], ("Fetching upstream", 9))
        self.assertEqual([n for n, _ in plan], [n for n, _ in update.DEFAULT_STEPS])
        self.assertEqual(dict(plan)["Building the app"], 99)


class PullStops(unittest.TestCase):
    def test_diverged_history_stops_without_changing_the_checkout(self):
        with tempfile.TemporaryDirectory() as d:
            work = update.make_test_repo(Path(d), "conflict")
            before = update.git(work, "rev-parse", "HEAD").stdout
            result = update.pull_ff_only(work, "mine")
            self.assertEqual(result.status, "diverged")
            self.assertEqual(update.git(work, "rev-parse", "HEAD").stdout, before)

    def test_fast_forward_and_up_to_date(self):
        with tempfile.TemporaryDirectory() as d:
            work = update.make_test_repo(Path(d), "ff")
            result = update.pull_ff_only(work, "mine")
            self.assertEqual((result.status, len(result.commits)), ("ff", 3))
            self.assertEqual(update.pull_ff_only(work, "mine").status, "uptodate")

    def test_dirty_variant_blocks(self):
        with tempfile.TemporaryDirectory() as d:
            work = update.make_test_repo(Path(d), "dirty")
            status = update.git(work, "status", "--porcelain", "-z", "-uall").stdout
            _, blocking = update.classify_status(status, work, work / ".fork-out")
            self.assertEqual(sorted(blocking), ["app.txt (M)", "stray.txt (??)"])


if __name__ == "__main__":
    unittest.main()
