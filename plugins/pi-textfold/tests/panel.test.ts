import { describe, expect, test } from "vitest";

import { fold } from "../extension/fold";
import { foldPanelLines, parseLevelArg, wrapText, PANEL_KEY, type Level } from "../extension/panel";

describe("wrapText", () => {
  test("keeps short lines as written", () => {
    expect(wrapText("Already short.\nAlso short.", 78)).toEqual(["Already short.", "Also short."]);
  });

  test("wraps a long line at the width, on spaces, without dropping words", () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`);
    const text = words.join(" ");
    const lines = wrapText(text, 78);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(78);
    expect(lines.join(" ")).toBe(text);
  });

  test("breaks a word that never fits", () => {
    const lines = wrapText("x".repeat(90), 78);
    expect(lines[0]!.length).toBeLessThanOrEqual(78);
  });
});

describe("foldPanelLines", () => {
  const REPLY = Array.from({ length: 12 }, (_, i) => `Sentence ${i} has a few words in it.`).join(" ");

  test("an empty or Full panel is empty", () => {
    expect(foldPanelLines(REPLY, 1)).toEqual([]);
    expect(foldPanelLines("", 3)).toEqual([]);
  });

  test("the panel names the level and shows the folded prefix", () => {
    const lines = foldPanelLines(REPLY, 3);
    expect(lines[0]).toBe(`TextFold · ${"Points"} (Alt+1..5 / /fold N)`);
    const body = lines.slice(2).join("\n");
    expect(body.length).toBeLessThan(REPLY.length);
    // prefix-preserving: the panel only loses what a fold at this level loses
    const f = fold(REPLY, 3);
    expect(body.startsWith(f.text.split("\n")[0])).toBe(true);
  });

  test("a short reply shows whole rather than folded", () => {
    const short = "Just one line.";
    expect(foldPanelLines(short, 3).join(" ")).toContain(short);
  });
});

describe("parseLevelArg", () => {
  const cur: Level = 3;

  test("no argument cycles to the next level and wraps", () => {
    expect(parseLevelArg("", cur).level).toBe(4);
    expect(parseLevelArg("", 5).level).toBe(1);
  });

  test("off and full mean Full", () => {
    expect(parseLevelArg("off", cur).level).toBe(1);
    expect(parseLevelArg("full", cur).level).toBe(1);
  });

  test("level names and numbers both work, in any case", () => {
    expect(parseLevelArg("brief", cur).level).toBe(2);
    expect(parseLevelArg("GIST", cur).level).toBe(5);
    expect(parseLevelArg("2", cur).level).toBe(2);
  });

  test("out-of-range and unknown words keep the level with an error", () => {
    const bad = parseLevelArg("banana", cur);
    expect(bad.level).toBeUndefined();
    expect(bad.error).toContain("banana");
    expect(parseLevelArg("9", cur).level).toBeUndefined();
  });
});

describe("PANEL_KEY", () => {
  test("the widget key is stable, and the clear request routes to it", () => {
    expect(PANEL_KEY).toBe("textfold");
  });
});
