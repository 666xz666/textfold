/**
 * The fold panel and the /fold parser for Pi's textfold extension.
 *
 * Pure helpers, so the tests can cover them without running Pi. The panel exists
 * because pi-tui's Markdown component caches rendered lines by (text, width) and
 * the transcript never invalidates when extension state changes; `ctx.ui.setWidget`
 * re-renders unconditionally, so the panel always shows the reply at the level in
 * force. See README "How the fold shows" for the full picture.
 */
import { fold, LEVELS, worthFolding } from "./fold";

export type Level = 1 | 2 | 3 | 4 | 5;
export type PanelCtx = { ui: { setWidget(key: string, content?: string[]): void; notify(msg: string, type?: "info" | "warning" | "error"): void } };

export const PANEL_KEY = "textfold";

/** The lines of a widget panel showing `markdown` folded to `level`: header, blank, folded text. */
export function foldPanelLines(markdown: string, level: number, width = 78): string[] {
	if (level < 2 || level > 5 || !markdown) return [];
	const f = fold(markdown, level);
	const shown = worthFolding(markdown, f.text) ? f.text : markdown;
	return [`TextFold · ${LEVELS[level - 1]} (Alt+1..5 / /fold N)`, "", ...wrapText(shown || "…", width)];
}

/** Word-wrap plain text (the fold writes no ANSI) to at most `width` columns,
 *  hard-breaking any single token wider than `width`. */
export function wrapText(text: string, width = 78): string[] {
	return text.split("\n").flatMap((line) => {
		if (line.length <= width) return [line];
		const out: string[] = [];
		let buf: string = "";
		for (const word of line.split(" ")) {
			for (let rest = word.length > width ? word : ""; rest; ) {	// a token wider than the line: hard-break it
				if (buf) { out.push(buf); buf = ""; }
				if (rest.length > width) {
					out.push(rest.slice(0, width));
					rest = rest.slice(width);
				} else {
					buf = rest;	// the tail joins the normal flow
					rest = "";
				}
			}
			const next = buf ? `${buf} ${word}` : word;
			if (next.length > width && buf) {
				out.push(buf);
				buf = word;
			} else buf = next;
		}
		if (buf) out.push(buf);
		return out;
	});
}

/**
 * `/fold <args>`: "", "off" and a name from LEVELS cycle or pick a level; an
 * integer 1..5 picks it; anything else is reported and the level is kept.
 */
export function parseLevelArg(arg: string, current: Level): { level?: Level; error?: string } {
	const text = arg.trim();
	if (!text) return { level: ((current % 5) + 1) as Level };
	if (text === "off" || text.toLowerCase() === "full") return { level: 1 };
	const byName = LEVELS.findIndex((name) => name.toLowerCase() === text.toLowerCase());
	if (byName >= 0) return { level: (byName + 1) as Level };
	const num = Number(text);
	if (Number.isInteger(num) && num >= 1 && num <= 5) return { level: num as Level };
	return { error: `Unknown fold level: ${text}` };
}
