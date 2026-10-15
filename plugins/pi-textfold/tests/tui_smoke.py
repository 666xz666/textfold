"""
Manual end-to-end smoke test for the TextFold-for-Pi extension: drives the real
Pi TUI over a pty, asks two questions, waits for each reply, presses Alt+3 / Alt+5 /
Alt+1 and checks that both replies fold in place, the earlier one too, and unfold. Needs a working pi setup (1.2.0+ on
Node 22.15+) with a default model, or the optional provider variables below.

Optional environment:
  TEXTFOLD_PI_CLI      path to pi's bundle/cli.js (default: newest npx cache entry)
  TEXTFOLD_PI_NODE     PATH prefix exporting Node 22.15+, when the system Node is older
  TEXTFOLD_PI_PROVIDER a pi extension file that registers a provider (e.g. a local router);
                       it is never needed when pi already has a login
  TEXTFOLD_PI_MODEL    the model to use, as `provider/model`

Run:  python3 tui_smoke.py        (exit 0 = every check passed)
"""
import os, pty, select, time, subprocess, re, signal, fcntl, struct, termios, sys

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.join(HERE, "..", "extension", "index.ts")
PROVIDER = os.environ.get("TEXTFOLD_PI_PROVIDER", "")
MODEL = os.environ.get("TEXTFOLD_PI_MODEL", "")

def find_cli():
    want = os.environ.get("TEXTFOLD_PI_CLI")
    if want:
        return want
    for base in glob_npx():
        if os.path.isdir(base):
            return os.path.join(base, "dist", "bundle", "cli.js")
    raise SystemExit("pi not found; set TEXTFOLD_PI_CLI")

def glob_npx():
    home = os.path.expanduser("~/.npm/_npx")
    try:
        return glob_sorted(home)
    except FileNotFoundError:
        return []

def glob_sorted(home):
    import glob
    return sorted(glob.glob(os.path.join(home, "*", "node_modules", "@earendil-works", "pi-coding-agent")), reverse=True)

NODE_PREFIX = os.environ.get("TEXTFOLD_PI_NODE", "")

cli = find_cli()
args = ["--no-session", "--extension", EXT]   # a test run leaves no session behind
if PROVIDER:
    args += ["--extension", PROVIDER]
if MODEL:
    args += ["--model", MODEL]

Ya_env = dict(os.environ)
env = Ya_env
env["TERM"] = "xterm-256color"

pid, fd = pty.fork()
if pid == 0:
    os.execvpe("bash", ["bash", "-c",
        f'{NODE_PREFIX}exec node {repr(cli)} ' +
        " ".join(repr(a) for a in args)], env)
# Tall enough that both replies stay on screen: Pi runs full screen and draws only what is in view
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 80, 100, 0, 0))

buf = b""
def read_for(sec):
    global buf
    end = time.time() + sec
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.5)
        if r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk: break
            buf += chunk
            end = time.time() + 2
    return buf

def send(data, wait=1.0):
    os.write(fd, data)
    read_for(wait)

stages = {}
def mark(name):
    stages[name] = len(buf)

read_for(10); time.sleep(2); read_for(1)
mark("startup")

def ask(prompt):
    send(prompt, 3)
    quiet = 0
    for i in range(150):
        n = len(buf)
        read_for(1.5)
        if len(buf) == n:
            quiet += 1
            if quiet >= 6: break
        else:
            quiet = 0

# two replies, so the level also reaches one that is no longer the newest
ask(b"Write three short paragraphs about why reading less but keeping structure is good.\r")
ask(b"Now write three short paragraphs about why headings help a reader find their way back.\r")
mark("reply")

# Alt+3 (Points), Alt+5 (Gist): every reply on the screen is drawn again, folded in place
send(b"\x1b3", 3); mark("points")
send(b"\x1b5", 3); mark("gist")
# Alt+1 (unfold): every reply as written again
send(b"\x1b1", 3); mark("full")

try:
    os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0)
except ChildProcessError:
    pass
open("/tmp/pi_tui_buf.txt", "wb").write(buf)

def clean(x):
    return re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07").sub("", x.decode("utf-8", "replace"))

segs = {}
keys = list(stages)
for i, k in enumerate(keys):
    a = stages[keys[i - 1]] if i else 0
    segs[k] = clean(buf[a:stages[k]])

startup = clean(buf)[:2000]
report = {
    "startup_ok": "Warning:" not in startup and "extension error" not in startup.lower(),
    # the level row above the prompt: the five levels and their keys
    "level_row": all(f"{n} {name}" in segs["startup"] for n, name in enumerate(["Full", "Brief", "Points", "Outline", "Gist"], 1)),
    # each reply drawn again with its fold line, the earlier one as well as the newest
    "points_in_place": len(re.findall(r"Points · \d+ of \d+ words", segs["points"])) >= 2,
    "gist_in_place": len(re.findall(r"Gist · \d+ of \d+ words", segs["gist"])) >= 2,
    "unfolded": "unfolds" not in segs["full"],
}
for k, v in report.items(): print(f"{k}: {v}")
folds = re.findall(r"(Brief|Points|Outline|Gist) · \d+ of \d+ words", segs["points"] + segs["gist"])
print("in-place fold lines:", folds if folds else "NONE")
sys.exit(0 if all(report.values()) else 1)
