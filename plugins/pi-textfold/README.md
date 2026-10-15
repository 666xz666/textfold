# TextFold for Pi

Your Pi agent writes more than you have time to read. TextFold folds every reply to the level you need, from every word to the answer in one sentence, with one key — no second model, no summary, nothing rewritten. It is the same fold as [TextFold for Claude Code](../textfold), ported to [Pi](https://pi.dev)'s extension API.

| Key | Level | What you get |
|:-:|---|---|
| **Alt+1** | **Full** | every word Pi wrote |
| **Alt+2** | **Brief** | each point, with the reason behind it |
| **Alt+3** | **Points** | just the points, at a glance |
| **Alt+4** | **Outline** | the map of a long reply: its sections, and what each one says |
| **Alt+5** | **Gist** | the answer, in one sentence |

`/fold` takes `1..5`, a level name (`brief`), `off`, or nothing to move to the next level. Press Alt+N mid-conversation — the fold panel under the editor follows at once.

## Install

Pi 1.2.0 or later, running on Node 22.15 or newer:

```bash
# try it for one session, from a checkout of this repo:
pi -e ./plugins/pi-textfold

# or install it:
pi install ./plugins/pi-textfold
```

The unit tests run with Node and npm already shown: `npm install && npm test` inside `plugins/pi-textfold/`.

## How the fold shows

Two surfaces, by design:

- **The fold panel** (a widget under the editor) always shows the latest settled reply at the level in force. `setWidget` re-renders on every press, so the keys never lag.
- **In place in the transcript**, replies newer than a level change render folded. Older blocks keep their fold until Pi re-renders them (a window resize does it); pi-tui caches rendered Markdown by content and width, and there is no invalidation hook an extension can use, so a fold that had already been drawn is not redrawn when only the level changes. The panel carries the switch meanwhile. An upstream `invalidate` hook would close this.

## Why you can trust a fold

Nothing is paraphrased. The extension appends a short style section to the system prompt that asks Pi to lead with the point: the answer first in every reply, the key sentence first in every paragraph and list item. A fold keeps what Pi put first: the first sentence or two of each paragraph, the first sentence of each item, the headings, and at the last level the reply's first sentence. Short replies (under ~80 words, or ones a fold would barely shorten) stay whole. There is no second model and no summary — a fold costs nothing and takes no time. The session transcript the model sees is never edited.

## Keys note
Alt, not plain digits: Pi dispatches extension shortcuts before the editor receives any input, so registered `1`..`5` would swallow digits typed into the prompt. `/fold` is always available.

## The engine

`extension/fold.ts` is the fold engine of the Claude Code mod, byte for byte, so both harnesses fold identically; its behavior is covered by the tests ported with it (`tests/fold.test.ts`). `tests/tui_smoke.py` is a manual end-to-end harness (python, a pty and a working model) that drives the real TUI and checks the keys; see its header for how to run it.
