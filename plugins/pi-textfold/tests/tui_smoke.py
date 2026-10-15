"""
Manual end-to-end smoke test for the TextFold-for-Pi extension: drives the real
Pi TUI over a pty, sends a prompt, waits for the reply, presses Alt+2 / Alt+5 /
Alt+1 and checks what the screen shows. Needs a working pi setup (1.2.0+ on
Node 22.15+) with a default model, or the optional provider variables below.

Optional environment:
  TEXTFOLD_PI_CLI      path to pi's bundle/cli.js (default: newest npx cache entry)
  TEXTFOLD_PI_NODE     PATH prefix exporting Node 22.15+, when the system Node is older
  TEXTFOLD_PI_PROVIDER a pi extension file that registers a provider (e.g. a local router);
                       it is never needed when pi already has a login
  TEXTFOLD_PI_MODEL    the model to use, as `provider/model`

Run:  python3 tui_smoke.py        (exit 0 = all four screens correct)
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

def resize(fd, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, 100, 0, 0))

def send(data, wait=1.0):
    os.write(fd, data)
    read_for(wait)

stages = {}
def mark(name):
    stages[name] = len(buf)

read_for(10); time.sleep(2); read_for(1)
mark("startup")

send(b"Write three short paragraphs about why reading less but keeping structure is good.\r", 3)
quiet = 0
for i in range(150):
    n = len(buf)
    read_for(1.5)
    if len(buf) == n:
        quiet += 1
        if quiet >= 6: break
    else:
        quiet = 0
mark("reply")

# Alt+2 (Brief): the fold panel appears at once; a resize repaints in place
send(b"\x1b2", 3); mark("brief")
resize(fd, 42); read_for(2); resize(fd, 40); read_for(2)
# Alt+5 (Gist)
send(b"\x1b5", 3); mark("gist")
resize(fd, 42); read_for(2); resize(fd, 40); read_for(2)
# Alt+1 (unfold): the panel goes away
send(b"\x1b1", 3); mark("full")
resize(fd, 42); read_for(2); resize(fd, 40); read_for(2)
mark("end")

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
    "brief_widget": "TextFold · Brief" in segs["brief"],
    "gist_widget": "TextFold · Gist" in segs["gist"],
    "fold_cleared": "TextFold ·" not in segs["end"],
}
for k, v in report.items(): print(f"{k}: {v}")
folds = re.findall(r"(Brief|Points|Outline|Gist) · \d+ of \d+ words", segs["brief"] + segs["gist"])
print("in-place fold lines:", folds[-2:] if folds else "NONE")
sys.exit(0 if all(report.values()) else 1)
