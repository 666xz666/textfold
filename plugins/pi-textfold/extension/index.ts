/**
 * TextFold for Pi.
 *
 * A Pi coding-agent extension from TextFold (see `plugins/textfold` for the Claude
 * Code mod this mirrors): every Pi reply folds to the level you need, from every
 * word to the answer in one sentence, with one key. No second model and no
 * summary; the fold keeps prefixes of what the agent wrote.
 *
 * It works because the style section asked for below makes the agent open every
 * paragraph and list item with the sentence that states its point. Folding then
 * keeps a prefix of what Pi wrote; the fold changes the order of what the agent
 * says, not what it says or how much.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { KeyId, TUI } from "@earendil-works/pi-tui";
import { fold, LEVELS, worthFolding } from "./fold";
import { KEY, levelRow, parseLevelArg, type Level } from "./level";

// Identical to the Claude Code mod's prompt section, so replies fold the same way
// on every harness. It asks for the point first at every scale.
const STYLE = `# Replies that fold
The person reading this session can fold your replies with one key: to each paragraph's first sentence or two, to the headings, or to the reply's first sentence. Write so that every fold still reads:
- Open the reply with one sentence that answers, or that says what you did.
- Open every paragraph and every list item with a sentence that states its point and reads on its own; reasons, details and caveats come after it.
- Give a reply longer than four paragraphs a few short headings.
This changes the order of what you write, not its content or its length.`;

export default function textfoldFold(pi: ExtensionAPI) {
	// The level every reply is read at: 1 Full (as written) to 5 Gist. Full at start.
	let level: Level = 1;

	// The style section, appended as a structured prompt section so the session
	// records a delta instead of a replaced prompt.
	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.sections = {
			...event.systemPromptOptions.sections,
			textfold: STYLE,
		};
		return {};
	});

	// Each reply folded as Pi draws it, on the screen only: what the model sees is never changed.
	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType !== "assistant" || level === 1) return markdown;
		const f = fold(markdown, level);
		if (!worthFolding(markdown, f.text)) return markdown;
		return `${f.text || "…"}\n\n*${levelName(level)} · ${f.shown} of ${f.total} words · Alt+1 unfolds*`;
	});

	// The row above the prompt names the five levels and marks the one read at. Pi hands its screen to the
	// row's factory, which the extension keeps: a new level has to be drawn on all of it.
	let screen: TUI | undefined;
	const install = (ctx: ExtensionContext) =>
		ctx.ui.setWidget(
			KEY,
			(tui, theme) => {
				screen = tui;
				const paint = { label: (s: string) => theme.fg("muted", s), current: (s: string) => theme.bold(theme.fg("accent", s)), other: (s: string) => theme.fg("dim", s) };
				return { render: (width: number) => [` ${levelRow(level, width - 1, paint)}`], invalidate: () => {} };
			},
			{ placement: "aboveEditor" },
		);
	pi.on("session_start", (_event, ctx) => install(ctx));

	// A new level folds every reply in place at once, the earlier ones too. Pi keeps each reply as it drew it
	// until its text or the screen's width changes, so what it kept is dropped and the whole screen drawn again.
	const apply = (next: Level, ctx: ExtensionContext) => {
		if (next === level) return;
		level = next;
		if (!screen) install(ctx);
		screen?.invalidate();
		screen?.requestRender(true);
	};

	// Alt+1..Alt+5. Not plain digits: Pi dispatches extension shortcuts before the
	// editor sees any input, so registered 1..5 would swallow typed digits.
	for (const n of [1, 2, 3, 4, 5] as const) {
		const key = `alt+${n}` as KeyId;
		pi.registerShortcut(key, {
			description: `Fold replies to ${levelName(n)}`,
			handler: async (ctx) => apply(n, ctx),
		});
	}

	pi.registerCommand("fold", {
		description: "Fold replies: 1..5, a level name, off, or nothing for the next level",
		handler: async (arg: string | undefined, ctx) => {
			const got = parseLevelArg(arg ?? "", level);
			if (got.error) {
				ctx.ui.notify(got.error, "warning");
				return;
			}
			if (got.level) apply(got.level, ctx);
		},
	});
}

const levelName = (n: number): string => LEVELS[n - 1] ?? "Full";
