"""A PDF read by the PDF engine (engine.py), as a document: MinerU's structured output (structured_content.json: pages
of blocks, each with its type, its place on the page and its content) turned into the Markdown and HTML the other
sources go through. Running heads, page numbers and margin stamps are left out; the title and authors come from the
file's own metadata when it has them; headings get their depth from their numbering (MinerU gives every heading the
same level); a figure's panels and its caption become one figure; a formula is LaTeX (the accurate tier) or the
picture of it (the fast tier); the references become a list of works.

Its id: pdf-<the first 16 hex digits of the file's SHA-256>, so the same file is the same document."""
import hashlib
import json
import re
import shutil
import time
from pathlib import Path

from . import local, markdown, store

DROP = {"header", "footer", "page_number", "aside_text"}
CAPTION = re.compile(r"^\s*(?:fig(?:ure)?\.?|table|tab\.|scheme|chart|abb(?:ildung)?\.?|tabelle|图|表)\s*[A-Z]?\d+", re.I)
PANEL = re.compile(r"^\s*\(?[a-z]\)?\s*$|^\s*\(?[a-z]\)\s", re.I)   # "(a)", "f)": a panel's label, not a heading
DATE = re.compile(r"^(?:\w+ \d{1,2}, \d{4}|\d{1,2} \w+ \d{4}|\d{4}-\d{2}-\d{2})$")
REFS = re.compile(r"^\s*(?:\d+\.?\s*)?(?:references|bibliography|literature|works cited|literatur|参考文献)\s*$", re.I)
ABSTRACT = re.compile(r"^\s*(?:abstract|summary|zusammenfassung|摘要)\s*$", re.I)
# a numbered heading the fast tier took for a line of text: "1 Introduction", "2.3 Data", "IV. RESULTS"
NUMBERED = re.compile(r"^(?:[1-9]\d*(?:\.\d+){0,3}|[IVX]+)\.?\s+[A-Z][^.!?]{1,80}$")
# a publisher's labels on the page, not the paper's words
BOILER = re.compile(r"^\W*\d?\s*(?:check for updates|open access|research article|article|original article|review)\W*$", re.I)
# above the first heading: the paper's front matter (its authors, their places, its dates), unless it is a paragraph
FRONT = re.compile(r"^(?:<sup>|\d+\s*[A-Z][a-z]+ (?:of|for)\b|(?:received|accepted|published|revised|correspondence|e-?mail|keywords?)\b)|@", re.I)


def pid_of(data):
    return "pdf-" + hashlib.sha256(data).hexdigest()[:16]


def depth(title):
    """A heading's depth from its numbering: "3", "3." or "III." is 1, "3.2" or "A.1" 2, "3.2.1" 3; unnumbered, 1."""
    m = re.match(r"^\s*((?:\d+|[A-Z]|[IVX]+)(?:[.\-]\d+)*)[.)]?\s+\S", title)
    if not m:
        return 1
    return min(3, len(re.split(r"[.\-]", m.group(1).rstrip("."))))


def _text(s):
    return (s or "").strip()


def _md_escape_heading(s):
    return re.sub(r"\s+", " ", s).strip().lstrip("#").strip()


def _table_html(content):
    """A table as HTML: MinerU gives it as HTML or as a Markdown table."""
    c = _text(content)
    if c.lower().startswith("<table"):
        return c
    html, _ = markdown.to_html(c)
    m = re.search(r"<table.*?</table>", html, re.S)
    return m.group(0) if m else f"<p>{html}</p>"


def _caption_of(block):
    return " ".join(_text(c.get("content")) for c in block.get("captions") or [] if _text(c.get("content")))


def plausible(title):
    """Words, not a file's code name: most of its tokens are made of letters ("11-nelson65 mc-nwf1 nm" is not)."""
    toks = title.split()
    wordy = [t for t in toks if sum(c.isalpha() for c in t) >= 0.8 * len(t)]
    return 8 <= len(title) <= 300 and len(toks) >= 2 and len(wordy) >= 0.6 * len(toks)


def to_markdown(sc, name=""):
    """(title, authors, Markdown with HTML for figures and tables) from MinerU's structured content."""
    doc = sc.get("metadata", {}).get("document", {}) or {}
    blocks = [b for p in sc.get("pages", []) for b in p.get("blocks", []) if b.get("type") not in DROP]
    # the title the page shows, when the engine found a whole one; else the file's own when it is words (it is often a
    # code: "11-nelson65 mc-nwf1"); else the file's name
    first = next((b for b in blocks if b.get("type") == "doc_title"), None)
    shown = re.sub(r"\s+", " ", _text(first.get("content"))) if first is not None else ""
    meta_title = re.sub(r"\s+", " ", _text(doc.get("title")))
    title = (shown if plausible(shown) and len(shown.split()) >= 3 else meta_title if plausible(meta_title)
             else shown if plausible(shown) else re.sub(r"[_-]+", " ", Path(name).stem).strip())
    authors = [a.strip() for x in doc.get("authors") or [] for a in re.split(r"\s*[;\n]\s*", x) if a.strip()]
    # what comes between the title and the first heading (the authors, their places, a date) is the paper's front matter
    has_heading = any(b.get("type") == "paragraph_title" for b in blocks)
    out, notes, figure, deferred, in_refs, front = [], [], [], [], False, True
    seen_title, refs_at = False, None

    def place(x):
        """Figures and tables placed after the references (a journal's last pages) go before them."""
        (deferred if in_refs else out).append(x)

    def flush_figure(caption=""):
        if not figure:
            return
        imgs = "".join(f'<img src="{src}" alt="">' for src in figure)
        cap = f"<figcaption>{caption}</figcaption>" if caption else ""
        place(f"<figure>{imgs}{cap}</figure>")
        figure.clear()

    def figure_caption(b):
        """A figure's own caption ("Figure 2: ..."), not a panel's ("(a)", "t=1, substep 1")."""
        caps = [_text(c.get("content")) for c in b.get("captions") or [] if _text(c.get("content"))]
        i = next((n for n, c in enumerate(caps) if CAPTION.match(c)), None)
        return " ".join(caps[i:]) if i is not None else ""

    for b in blocks:
        kind, content = b.get("type"), _text(b.get("content"))
        if kind in ("text", "paragraph_title") and BOILER.match(content):
            continue
        if kind != "image" and figure:   # panels with no caption of their own: a caption after them, or none
            cap = content if kind == "text" and CAPTION.match(content) else ""
            flush_figure(cap)
            if cap:
                continue
        if kind == "text" and not in_refs and NUMBERED.match(content) and len(content.split()) <= 10:
            kind = "paragraph_title"
        if kind == "doc_title":
            if not seen_title and re.sub(r"\s+", " ", content) == title:
                seen_title = True
                continue
            kind = "paragraph_title"
        if kind == "paragraph_title":
            if not content or PANEL.match(content) or len(content) > 160:
                if content and len(content) > 160:
                    out.append(content)
                continue
            if DATE.match(content) or not re.search(r"[^\W\d_]", content):   # a date, a dotted rule
                continue
            front = False
            in_refs = bool(REFS.match(content))
            if in_refs and refs_at is None:
                refs_at = len(out)
            out.append("#" * (1 + depth(content)) + " " + _md_escape_heading(content))
            continue
        if front and has_heading and kind in ("text", "list") and (len(content.split()) < 25 or FRONT.search(content)):
            continue   # authors, affiliations, dates above the first heading (an abstract, an introduction stay)
        if kind == "image":
            if b.get("image_source"):
                figure.append(b["image_source"])
            cap = figure_caption(b)
            if cap:
                flush_figure(cap)
            continue
        if kind == "table":
            cap = figure_caption(b) or _caption_of(b)
            foot = " ".join(_text(c.get("content")) for c in b.get("footnotes") or [])
            place("<figure>" + (f"<figcaption>{cap}</figcaption>" if cap else "") + _table_html(content) + "</figure>")
            if foot:
                place(foot)
            continue
        if kind == "equation":
            if content:
                latex = content.strip().strip("$").strip()
                out.append(f"$$\n{latex}\n$$")
            elif b.get("image_source"):   # the fast tier: the formula as a picture of it
                box = b.get("bbox") or [0, 0, 0.3, 0]
                width = max(40, round((box[2] - box[0]) * 760))   # as wide as on the page (a column is about 760 px)
                out.append(f'<p><img src="{b["image_source"]}" alt="formula" width="{width}"></p>')
            continue
        if kind == "ref_text" or (in_refs and kind in ("text", "list")):
            for line in content.splitlines():
                if line.strip():
                    out.append("- " + line.strip().lstrip("-• ").strip())
            continue
        if kind == "page_footnote":
            notes.append(content)
            continue
        if kind == "code":
            out.append("```\n" + content + "\n```")
            continue
        if content:
            out.append(content)
    flush_figure()
    if deferred:
        at = refs_at if refs_at is not None else len(out)
        out[at:at] = deferred
    if notes:
        out.append("## Notes")
        out.extend(notes)
    # a list's items stay together; everything else is a block of its own
    text, prev = [], None
    for x in out:
        if prev is not None and not (x.startswith("- ") and prev.startswith("- ")):
            text.append("")
        text.append(x)
        prev = x
    return title or "Untitled PDF", authors, "\n".join(text) + "\n"


def store_pdf(pid, folder, sc, name, tier, replace=False):
    """A converted PDF stored as a document (papers/<pid>/), its pictures read from the engine's output folder. The
    file itself is kept as source.pdf, so the reader can show it beside the text. Converted again (replace), the
    reader's notes and the file stay; the levels go, since they belong to the text they were made from."""
    title, authors, text = to_markdown(sc, name)
    html, _ = markdown.to_html(text)
    doc = sc.get("metadata", {}).get("document", {}) or {}
    doi = next((re.sub(r"^doi:\s*", "", i, flags=re.I) for i in doc.get("identifiers") or [] if re.match(r"^(doi:)?10\.\d{4,9}/", i, re.I)), "")
    url = next((i for i in doc.get("identifiers") or [] if re.match(r"https?://", i)), "")
    meta = {"id": pid, "version": "", "title": title, "authors": authors, "date": (doc.get("created_at") or "")[:10],
            "snapshot": time.strftime("%Y-%m-%d"), "abs_url": url or (f"https://doi.org/{doi}" if doi else ""), "html_url": "",
            "doi": doi, "license": "", "source": {"kind": "pdf", "name": name, "tier": tier, "engine": "mineru"},
            "label": f"PDF · {name}"}
    d = store.pdir(pid)
    keep = d.with_name(d.name + ".keep")   # the reader's notes and the file, on disk while the document is rewritten
    if replace and d.exists():
        shutil.rmtree(keep, ignore_errors=True)
        keep.mkdir(parents=True)
        for f in ("source.pdf", "notes.json"):
            if (d / f).exists():
                shutil.copy2(d / f, keep / f)
        if (d / "source.html").exists():
            (d / "source.html").unlink()   # so that store_doc writes the document again
    try:
        local.store_doc(pid, html, meta, "source.md", text, lambda f: local.Images(f, Path(folder)).resolve, sizes=True)
    finally:
        if keep.exists():
            for f in keep.iterdir():
                shutil.copy2(f, d / f.name)
            shutil.rmtree(keep)
    return pid


def read_output(folder):
    """MinerU's structured content from an output folder (its zip unpacked)."""
    return json.loads((Path(folder) / "structured_content.json").read_text())
