#!/usr/bin/env python3
"""Update this machine: pull the fork branch (fast-forward only), deploy, and watch it live.

Run through ./update.sh. The deploy is `scripts/fork.sh deploy`, which runs detached in its own
session, so closing this window or pressing Ctrl-C only stops the display, never the deploy.
`./update.sh --attach` shows the live view again. `--test[=ff|uptodate|conflict|dirty|fail]` runs the
whole flow against a throwaway git repository and a stub deploy.
"""
from __future__ import annotations

import argparse
import contextlib
import dataclasses
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from rich import box
from rich.console import Console, Group
from rich.live import Live
from rich.panel import Panel
from rich.progress import BarColumn, Progress, ProgressColumn, SpinnerColumn, TaskProgressColumn, TextColumn
from rich.rule import Rule
from rich.spinner import Spinner
from rich.table import Table
from rich.text import Text

REPO = Path(__file__).resolve().parent.parent
# Same names and first-run estimates (seconds) as STEPS in scripts/fork.sh.
DEFAULT_STEPS = [("Fetching upstream", 5), ("Installing dependencies", 15), ("Building the app", 130), ("Installing", 12)]
FALLBACK_ESTIMATE = 30
BUILD_STEP = "Building the app"
IGNORED_UNTRACKED = ("task-history-handoffs",)
CONFLICT_CODES = {"DD", "AU", "UD", "UA", "DU", "AA", "UU"}

# Lines fork.sh deploy prints (see cmd_deploy in scripts/fork.sh).
DEPLOYING_RE = re.compile(r"^==> Deploying (\S+) \(estimated (\d+):(\d\d); log: (.+)\)$")
STEP_RE = re.compile(r"^\[(\d+)/(\d+)\] (.+?) \(about (\d+):(\d\d)\)$")
DONE_RE = re.compile(r"^Done in (\d+):(\d\d)\. Installed (\S+?);")
FAIL_RE = re.compile(r"^error: '(.+)' failed\. Full log: (.+)$")
ERROR_RE = re.compile(r"^error: (.+)$")
ROLLBACK_RE = re.compile(r"^Rollback copy: (.+?)(?: \(quit.*)?$")
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def fmt_secs(seconds: float) -> str:
    seconds = max(0, int(seconds))
    return f"{seconds // 60}:{seconds % 60:02d}"


# ------------------------------------------------------------------ git: dirty tree and pull


def parse_status(raw: str) -> list[tuple[str, str]]:
    """Parses `git status --porcelain -z` into (XY, path) pairs."""
    entries: list[tuple[str, str]] = []
    parts = raw.split("\0")
    i = 0
    while i < len(parts):
        entry = parts[i]
        i += 1
        if len(entry) < 4:
            continue
        xy, path = entry[:2], entry[3:]
        if xy[0] in "RC":
            i += 1  # the original path follows a rename or copy
        entries.append((xy, path))
    return entries


def classify_status(raw: str, repo: Path, out_dir: Path) -> tuple[list[str], list[str]]:
    """Splits dirty paths into (ignorable, blocking). Anything under the build output directory and
    untracked task-history-handoffs/ and Python __pycache__ are ignorable; conflicted and other changed paths block."""
    try:
        out_rel = out_dir.resolve().relative_to(repo.resolve()).as_posix()
    except ValueError:
        out_rel = None
    ignorable: list[str] = []
    blocking: list[str] = []
    for xy, path in parse_status(raw):
        if xy in CONFLICT_CODES:
            blocking.append(f"{path} (conflicted)")
        elif out_rel and (path == out_rel or path.startswith(out_rel + "/")):
            ignorable.append(path)
        elif xy == "??" and (path.split("/")[0] in IGNORED_UNTRACKED or "__pycache__" in path.split("/")):
            ignorable.append(path)
        else:
            blocking.append(f"{path} ({xy.strip() or xy})")
    return ignorable, blocking


def git(repo: Path, *args: str) -> subprocess.CompletedProcess:
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0")
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, env=env)


@dataclasses.dataclass
class PullResult:
    status: str  # uptodate, ff, diverged, error
    message: str = ""
    ahead: int = 0
    commits: list[tuple[str, str, str]] = dataclasses.field(default_factory=list)


def pull_ff_only(repo: Path, branch: str) -> PullResult:
    fetched = git(repo, "fetch")
    if fetched.returncode != 0:
        return PullResult("error", f"git fetch failed:\n{fetched.stderr.strip()}")
    tracked = git(repo, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
    upstream = tracked.stdout.strip() if tracked.returncode == 0 else f"origin/{branch}"
    if git(repo, "rev-parse", "--verify", "--quiet", upstream).returncode != 0:
        return PullResult("error", f"Remote branch {upstream} does not exist.")
    counts = git(repo, "rev-list", "--left-right", "--count", f"HEAD...{upstream}").stdout.split()
    ahead, behind = int(counts[0]), int(counts[1])
    if behind == 0:
        return PullResult("uptodate", ahead=ahead)
    if ahead > 0:
        return PullResult(
            "diverged",
            f"{branch} has {ahead} local commit(s) that {upstream} does not, and {behind} commit(s) it lacks, "
            "so it cannot fast-forward. Rebase or merge by hand, then run this again.",
            ahead=ahead,
        )
    old = git(repo, "rev-parse", "HEAD").stdout.strip()
    pull_args = ["pull", "--ff-only"] + ([] if tracked.returncode == 0 else ["origin", branch])
    pulled = git(repo, *pull_args)
    if pulled.returncode != 0:
        return PullResult("error", f"git pull --ff-only failed:\n{(pulled.stderr or pulled.stdout).strip()}")
    log = git(repo, "log", "--format=%h%x09%an%x09%s", f"{old}..HEAD").stdout.strip().splitlines()
    return PullResult("ff", commits=[tuple(line.split("\t", 2)) for line in log])  # type: ignore[misc]


# ------------------------------------------------------------------ deploy log parsing and ETA


@dataclasses.dataclass
class DeployView:
    """Everything the monitor learns from fork.sh's detached log."""

    version: str | None = None
    detail_log: str | None = None
    count: int = 0
    seen: list[tuple[str, int]] = dataclasses.field(default_factory=list)  # (name, estimate) per marker
    finished: bool = False
    ok: bool = False
    installed: str | None = None
    total_secs: int | None = None
    failed_step: str | None = None
    error: str | None = None
    rollback: str | None = None

    @property
    def current(self) -> int:
        """1-based index of the running step, or 0 before the first marker."""
        return len(self.seen)


def parse_deploy_output(text: str) -> DeployView:
    view = DeployView()
    for line in ANSI_RE.sub("", text).replace("\r", "\n").splitlines():
        line = line.rstrip()
        if m := DEPLOYING_RE.match(line):
            view.version, view.detail_log = m.group(1), m.group(4)
        elif m := STEP_RE.match(line):
            view.count = int(m.group(2))
            view.seen.append((m.group(3), int(m.group(4)) * 60 + int(m.group(5))))
        elif m := DONE_RE.match(line):
            view.finished, view.ok = True, True
            view.total_secs = int(m.group(1)) * 60 + int(m.group(2))
            view.installed = m.group(3)
        elif m := FAIL_RE.match(line):
            view.finished, view.ok = True, False
            view.failed_step, view.error = m.group(1), line
        elif m := ERROR_RE.match(line):
            view.finished, view.ok = True, False
            view.error = view.error or line
        elif m := ROLLBACK_RE.match(line):
            view.rollback = m.group(1)
    if view.finished and not view.ok and view.failed_step is None and view.seen:
        view.failed_step = view.seen[-1][0]
    return view


def read_step_times(path: Path) -> dict[str, int]:
    """fork.sh's step-times: one `name<TAB>seconds` line per step, from the last run of each."""
    times: dict[str, int] = {}
    try:
        for line in path.read_text().splitlines():
            name, _, secs = line.partition("\t")
            if name and secs.strip().isdigit():
                times[name] = int(secs)
    except OSError:
        pass
    return times


def build_plan(view: DeployView, times: dict[str, int]) -> list[tuple[str, int]]:
    """Step names with estimates. Steps fork.sh has printed win; the rest come from the defaults."""
    names = [name for name, _ in view.seen]
    defaults = dict(DEFAULT_STEPS)
    for name, _ in DEFAULT_STEPS:
        if len(names) >= max(view.count, len(DEFAULT_STEPS)):
            break
        if name not in names:
            names.append(name)
    marker_est = dict(view.seen)
    return [(n, times.get(n) or marker_est.get(n) or defaults.get(n) or FALLBACK_ESTIMATE) for n in names]


@dataclasses.dataclass
class Eta:
    percent: int
    remaining: int
    over: int  # seconds the running step is past its estimate, else 0


def compute_eta(estimates: list[int], running: int | None, elapsed: float) -> Eta:
    """`running` is the 0-based index of the running step (None before the first or after the last).
    The bar holds below 100% until the deploy finishes, like fork.sh's own bar."""
    total = max(sum(estimates), 1)
    if running is None:
        return Eta(0, sum(estimates), 0)
    run_est = estimates[running]
    spent = sum(estimates[:running]) + min(elapsed, run_est)
    over = max(0, int(elapsed - run_est))
    remaining = int(max(run_est - elapsed, 0)) + sum(estimates[running + 1 :])
    return Eta(min(99, int(spent * 100 / total)), remaining, over)


def tail_lines(path: Path | str | None, count: int, width: int) -> list[str]:
    if not path:
        return []
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            fh.seek(max(0, fh.tell() - 8000))
            raw = fh.read().decode("utf-8", "replace")
    except OSError:
        return []
    lines = [ln for ln in ANSI_RE.sub("", raw).replace("\r", "\n").splitlines() if ln.strip()]
    return [ln[: max(width, 20)] for ln in lines[-count:]]


# ------------------------------------------------------------------ monitor


class StepClock:
    """Remembers when each step started. Live, that is the moment its marker first appears. On a
    re-attach it is estimated from when the deploy started plus the finished steps' durations."""

    def __init__(self, deploy_start: float):
        self.deploy_start = deploy_start
        self.starts: dict[int, float] = {}
        self.first = True

    def update(self, view: DeployView, times: dict[str, int], now: float) -> None:
        cur = view.current
        if cur and cur not in self.starts:
            if self.first:
                done = sum(times.get(n, e) for n, e in view.seen[:-1])
                self.starts[cur] = min(now, self.deploy_start + done)
            else:
                self.starts[cur] = now
        self.first = False

    def elapsed(self, view: DeployView, now: float) -> float:
        start = self.starts.get(view.current)
        return max(0.0, now - start) if start else 0.0

    def duration(self, idx: int, name: str, times: dict[str, int], plan_est: int) -> int:
        if name in times and idx in self.starts and idx + 1 in self.starts:
            return times[name]
        if idx in self.starts and idx + 1 in self.starts:
            return int(self.starts[idx + 1] - self.starts[idx])
        return times.get(name, plan_est)


class FieldColumn(ProgressColumn):
    def __init__(self, field: str, style: str = "cyan"):
        super().__init__()
        self.field, self.style = field, style

    def render(self, task) -> Text:
        return Text(str(task.fields.get(self.field, "")), style=self.style)


def make_progress(console: Console) -> tuple[Progress, int, int]:
    progress = Progress(
        SpinnerColumn(finished_text="✓"),
        TextColumn("{task.description}", justify="left"),
        BarColumn(bar_width=None),
        TaskProgressColumn(),
        FieldColumn("elapsed"),
        FieldColumn("left", "bold cyan"),
        console=console,
        expand=True,
    )
    overall = progress.add_task("Overall", total=100, elapsed="", left="")
    step = progress.add_task("Step", total=100, elapsed="", left="")
    return progress, overall, step


def pid_alive(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def read_pid(out_dir: Path) -> int | None:
    try:
        return int((out_dir / "deploy.pid").read_text().strip())
    except (OSError, ValueError):
        return None


def panel(body, title: str, style: str, console: Console) -> Panel:
    return Panel(body, title=title, border_style=style, box=box.ROUNDED if console.is_terminal else box.ASCII)


def summary_panel(view: DeployView, detail: Path, total: float, console: Console, ended: bool = False) -> Panel:
    if view.ok:
        body = Text()
        body.append(f"Installed {view.installed}\n", style="bold green")
        body.append(f"Total time {fmt_secs(view.total_secs if view.total_secs is not None else total)}\n")
        body.append(f"Log {view.detail_log or detail}")
        if view.rollback:
            body.append(f"\nRollback copy {view.rollback}")
        return panel(body, "Deploy finished", "green", console)
    body = Text()
    what = view.error or ("The deploy process ended without a result." if ended else "The deploy failed.")
    body.append(f"{what}\n", style="bold red")
    body.append(f"Log {view.detail_log or detail}\n\n")
    body.append("\n".join(tail_lines(detail, 15, console.width - 6)), style="dim")
    if view.rollback:
        body.append(f"\n\nRollback copy {view.rollback}: quit T3 Code and move it back into /Applications.")
    return panel(body, "Deploy failed", "red", console)


def render(view, plan, clock, times, now, console, detail, out_dir, running: bool):
    progress, overall, step = make_progress(console)
    est = [e for _, e in plan]
    cur = view.current
    run_idx = cur - 1 if cur and not view.finished else None
    elapsed = clock.elapsed(view, now)
    eta = compute_eta(est, run_idx, elapsed)
    overall_elapsed = now - clock.deploy_start
    if view.finished:
        progress.update(overall, completed=100 if view.ok else eta.percent, elapsed=fmt_secs(overall_elapsed), left="done" if view.ok else "failed")
        progress.update(step, completed=100 if view.ok else 0, description="Finished" if view.ok else "Stopped", elapsed="", left="")
    else:
        left = f"~{fmt_secs(eta.remaining)} left"
        if eta.over:
            left = f"taking longer than usual (+{fmt_secs(eta.over)})" if eta.remaining == 0 else f"~{fmt_secs(eta.remaining)} left (step is +{fmt_secs(eta.over)} over)"
        progress.update(overall, completed=eta.percent, elapsed=fmt_secs(overall_elapsed), left=left)
        name = plan[run_idx][0] if run_idx is not None else "Starting"
        pct = min(99, int(elapsed * 100 / max(est[run_idx], 1))) if run_idx is not None else 0
        progress.update(step, completed=pct, description=f"Step {cur}/{len(plan)}: {name}", elapsed=fmt_secs(elapsed), left=f"of ~{fmt_secs(est[run_idx])}" if run_idx is not None else "")

    table = Table(box=box.SIMPLE_HEAD if console.is_terminal else box.ASCII, expand=True, pad_edge=False)
    table.add_column("#", justify="right", width=3)
    table.add_column("Step")
    table.add_column("Status")
    table.add_column("Time", justify="right")
    for i, (name, e) in enumerate(plan, start=1):
        if i < cur or (view.finished and view.ok):
            table.add_row(str(i), name, Text("done", style="green"), fmt_secs(clock.duration(i, name, times, e)), style="green")
        elif i == cur and not view.finished:
            table.add_row(str(i), name, Group(Spinner("dots", text=Text("running", style="yellow"))), f"{fmt_secs(elapsed)} / ~{fmt_secs(e)}")
        elif i == cur and view.finished:
            table.add_row(str(i), name, Text("failed", style="bold red"), fmt_secs(elapsed))
        else:
            table.add_row(str(i), name, Text("pending", style="dim"), Text(f"~{fmt_secs(e)}", style="dim"))

    active = out_dir / ("build.log" if cur and plan[cur - 1][0] == BUILD_STEP else "deploy.log")
    lines = tail_lines(active, 8, console.width - 6) or ["(no output yet)"]
    log_panel = Panel(Text("\n".join(lines).ljust(1), style="dim", no_wrap=True, overflow="ellipsis"), title=f"{active.name} (last lines)", border_style="dim", height=10, box=box.ROUNDED if console.is_terminal else box.ASCII)

    head = Text()
    head.append(f"Deploying {view.version or '…'}", style="bold")
    head.append(f"   log {detail}", style="dim")
    note = "Ctrl-C or closing this window does not stop the deploy. Re-attach with ./update.sh --attach." if running else ""
    parts = [Rule(head, style="cyan"), progress, table, log_panel]
    if note and not view.finished:
        parts.append(Text(note, style="dim italic"))
    if view.finished:
        parts.append(summary_panel(view, detail, overall_elapsed, console, ended=not running and not view.error))
    return Group(*parts)


def monitor(console: Console, out_dir: Path, poll: float = 0.25) -> int:
    """Shows the detached deploy until it finishes. Returns 0 on success, 1 on failure, 130 if interrupted."""
    detail = out_dir / "deploy-detached.log"
    if not detail.exists():
        console.print(panel(f"No deploy log found at {detail}. Nothing to attach to.", "No deploy", "red", console))
        return 1
    pid_file = out_dir / "deploy.pid"
    start = pid_file.stat().st_mtime if pid_file.exists() else time.time()
    clock = StepClock(start)

    def on_hangup(*_):
        raise KeyboardInterrupt

    with contextlib.suppress(ValueError, AttributeError):
        signal.signal(signal.SIGHUP, on_hangup)
    live_ctx = Live(console=console, auto_refresh=False, transient=False) if console.is_terminal else contextlib.nullcontext()
    printed = 0
    dead_polls = 0
    view = DeployView()
    try:
        with live_ctx as live:
            while True:
                now = time.time()
                view = parse_deploy_output(detail.read_text(errors="replace"))
                times = read_step_times(out_dir / "step-times")
                clock.update(view, times, now)
                plan = build_plan(view, times)
                alive = pid_alive(read_pid(out_dir))
                dead_polls = 0 if alive or view.finished else dead_polls + 1
                if dead_polls >= 8 and not view.finished:
                    view.finished = True  # the process is gone without printing a result
                if view.finished and view.error is None and view.ok:
                    time.sleep(0.5)  # a Rollback line may land just after Done
                    view = parse_deploy_output(detail.read_text(errors="replace"))
                    times = read_step_times(out_dir / "step-times")
                if live is not None:
                    live.update(render(view, plan, clock, times, now, console, detail, out_dir, alive), refresh=True)
                elif view.current > printed:
                    printed = view.current
                    name, est = plan[view.current - 1]
                    console.print(f"[{view.current}/{len(plan)}] {name} (about {fmt_secs(est)})")
                if view.finished:
                    break
                time.sleep(poll)
    except KeyboardInterrupt:
        with contextlib.suppress(OSError, ValueError):
            console.print("\nStopped watching. The deploy keeps running in the background. Re-attach with ./update.sh --attach")
        return 130
    if live_ctx is not None and not console.is_terminal:
        console.print(summary_panel(view, detail, time.time() - start, console, ended=not view.error and not view.ok))
    return 0 if view.ok else 1


# ------------------------------------------------------------------ test fixtures


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", "-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.com", *args], cwd=cwd, check=True, capture_output=True)


def _commit(repo: Path, name: str, text: str, message: str) -> None:
    (repo / name).write_text(text)
    _git(repo, "add", name)
    _git(repo, "commit", "-m", message)


def make_test_repo(root: Path, variant: str) -> Path:
    """A throwaway work clone of a fake remote, shaped for one of the --test variants."""
    remote, seed, work = root / "remote.git", root / "seed", root / "work"
    _git(root, "init", "--bare", "-b", "mine", str(remote))
    seed.mkdir()
    _git(seed, "init", "-b", "mine")
    _commit(seed, ".gitignore", ".fork-out/\n", "chore: ignore build output")
    _commit(seed, "app.txt", "one\n", "feat: first")
    _git(seed, "remote", "add", "origin", str(remote))
    _git(seed, "push", "-u", "origin", "mine")
    _git(root, "clone", str(remote), str(work))
    if variant != "uptodate":
        for i in range(1, 4):
            _commit(seed, f"change{i}.txt", f"{i}\n", f"feat: remote change {i}")
        _git(seed, "push", "origin", "mine")
    if variant == "conflict":
        _commit(work, "app.txt", "local edit\n", "fix: local commit that diverges")
        _commit(seed, "app.txt", "remote edit\n", "fix: remote edit of the same file")
        _git(seed, "push", "origin", "mine")
    elif variant == "dirty":
        (work / "app.txt").write_text("uncommitted edit\n")
        (work / "stray.txt").write_text("untracked\n")
    if variant in ("ff", "uptodate", "fail"):
        (work / "task-history-handoffs").mkdir()
        (work / "task-history-handoffs" / "note.md").write_text("ignorable\n")
    return work


def seed_step_times(out_dir: Path, scale: float) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    base = {"Fetching upstream": 2, "Installing dependencies": 3, "Building the app": 7, "Installing": 2}
    (out_dir / "step-times").write_text("".join(f"{n}\t{max(1, round(s * scale))}\n" for n, s in base.items()))


# ------------------------------------------------------------------ main flow


def stop_panel(console: Console, title: str, body) -> int:
    console.print(panel(body, title, "red", console))
    return 1


def start_deploy(fork: Path, flags: list[str], repo: Path, env: dict[str, str]) -> subprocess.CompletedProcess:
    env = {k: v for k, v in env.items() if k != "T3_FORK_DETACHED"}  # an inherited 1 would make fork.sh block in the foreground
    return subprocess.run([str(fork), "deploy", *flags], cwd=repo, env=env, capture_output=True, text=True, stdin=subprocess.DEVNULL)


def update(args: argparse.Namespace, console: Console) -> int:
    tmp: Path | None = None
    env = dict(os.environ)
    if args.test:
        tmp = Path(tempfile.mkdtemp(prefix="update-test-"))
        branch = "mine"
        repo = make_test_repo(tmp, args.test)
        out_dir = repo / ".fork-out"
        scale = 1 / args.test_speed
        seed_step_times(out_dir, scale)
        fork = REPO / "scripts" / "update_fake_fork.sh"
        env.update(T3_FORK_OUT=str(out_dir), T3_FORK_BRANCH=branch, FAKE_SCALE=str(scale), FAKE_FAIL_STEP=BUILD_STEP if args.test == "fail" else "")
    else:
        branch = os.environ.get("T3_FORK_BRANCH", "mine")
        repo = REPO
        out_dir = Path(os.environ.get("T3_FORK_OUT") or repo / ".fork-out").resolve()
        fork = repo / "scripts" / "fork.sh"
    try:
        return run_flow(args, console, repo, branch, out_dir, fork, env)
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)


def run_flow(args, console, repo: Path, branch: str, out_dir: Path, fork: Path, env: dict[str, str]) -> int:
    console.print(Rule("Update this machine" + (" (TEST)" if args.test else ""), style="cyan"))
    if args.test:
        console.print(Text("Test mode: throwaway git repo and stub deploy; nothing real is touched.", style="dim"))

    # 1. Preflight
    if shutil.which("git") is None:
        return stop_panel(console, "Preflight failed", "git was not found on PATH.")
    top = git(repo, "rev-parse", "--show-toplevel")
    if top.returncode != 0 or Path(top.stdout.strip()).resolve() != repo.resolve():
        return stop_panel(console, "Preflight failed", f"Not at the root of the repository ({repo}).")
    if not fork.exists():
        return stop_panel(console, "Preflight failed", f"{fork} is missing.")
    current = git(repo, "branch", "--show-current").stdout.strip()
    head = git(repo, "log", "-1", "--format=%h %s").stdout.strip()
    info = Table.grid(padding=(0, 2))
    info.add_row("Branch", Text(current or "(detached)", style="bold"))
    info.add_row("Commit", head)
    info.add_row("Repo", str(repo))
    if current != branch:
        info.add_row("Problem", Text(f"On '{current}', expected '{branch}'. Switch branches or set T3_FORK_BRANCH.", style="red"))
        return stop_panel(console, "Preflight failed", info)
    console.print(panel(info, "Preflight", "cyan", console))

    # 2. Pull
    status = git(repo, "status", "--porcelain", "-z", "-uall")
    ignorable, blocking = classify_status(status.stdout, repo, out_dir)
    if blocking:
        body = Text("Local changes would be in the way. Commit or stash them, then run this again. Nothing was changed.\n\n")
        body.append("\n".join(f"  {p}" for p in blocking), style="bold")
        return stop_panel(console, "Working tree is not clean", body)
    result = pull_ff_only(repo, branch)
    if result.status in ("diverged", "error"):
        return stop_panel(console, "Cannot fast-forward" if result.status == "diverged" else "Pull failed", Text(result.message))
    if result.status == "uptodate":
        extra = f" ({result.ahead} local commit(s) not pushed)" if result.ahead else ""
        console.print(panel(Text(f"Already up to date{extra}."), "Pull", "green", console))
    else:
        log = Table(box=box.SIMPLE_HEAD if console.is_terminal else box.ASCII, expand=True)
        for col in ("Commit", "Author", "Subject"):
            log.add_column(col)
        for sha, author, subject in result.commits:
            log.add_row(sha, author, subject)
        console.print(panel(Group(Text(f"Fast-forwarded {branch} by {len(result.commits)} commit(s):"), log), "Pull", "green", console))

    # 3. Deploy
    flags = ["--allow-dirty"] if ignorable else []
    if ignorable:
        console.print(Text(f"Ignoring {len(ignorable)} untracked path(s) (build output, task history); deploying with --allow-dirty.", style="dim"))
    console.print(panel(Text("The deploy restarts T3 Code and ends any agent session running inside it. The deploy itself keeps going.", style="bold yellow"), "Heads up", "yellow", console))
    if args.ask and sys.stdin.isatty():
        reply = input("Start the deploy now? [y/N] ").strip().lower()
        if reply not in ("y", "yes"):
            console.print("Cancelled before the deploy started.")
            return 1
    started = start_deploy(fork, flags, repo, env)
    if started.returncode != 0:
        return stop_panel(console, "Deploy did not start", Text((started.stderr or started.stdout).strip() or "fork.sh exited with an error."))
    console.print(Text(started.stdout.strip().splitlines()[0] if started.stdout.strip() else "Deploy started.", style="dim"))
    return monitor(console, out_dir)


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="update.sh", description="Pull the fork branch (fast-forward only), deploy this machine, and watch the deploy live.")
    p.add_argument("--attach", action="store_true", help="show the live view of the newest running or last deploy and exit with its result")
    p.add_argument("--ask", "-i", action="store_true", help="ask before starting the deploy (only when stdin is a terminal)")
    p.add_argument("--test", nargs="?", const="ff", choices=["ff", "uptodate", "conflict", "dirty", "fail"], metavar="VARIANT", help="simulate everything in a temp repo with a stub deploy: ff (default), uptodate, conflict, dirty, fail")
    p.add_argument("--test-speed", type=float, default=1.0, metavar="N", help="make the stub deploy N times faster (default 1, about 13 seconds)")
    args = p.parse_args(argv)
    if args.test_speed <= 0:
        p.error("--test-speed must be positive")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    console = Console()
    if args.attach:
        out_dir = Path(os.environ.get("T3_FORK_OUT") or REPO / ".fork-out").resolve()
        return monitor(console, out_dir)
    try:
        return update(args, console)
    except KeyboardInterrupt:
        console.print("\nInterrupted. Nothing was running that this window needs.")
        return 130


if __name__ == "__main__":
    sys.exit(main())
