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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { KeyId } from "@earendil-works/pi-tui";
import { fold, LEVELS, worthFolding } from "./fold";
import { foldPanelLines, parseLevelArg, PANEL_KEY, type Level, type PanelCtx } from "./panel";

// Identical to the Claude Code mod's prompt section, so replies fold the same way
// on every harness. It asks for the point first at every scale.
const STYLE = `# Replies that fold
The person reading this session can fold your replies with one key: to each paragraph's first sentence or two, to the headings, or to the reply's first sentence. Write so that every fold still reads:
- Open the reply with one sentence that answers, or that says what you did.
- Open every paragraph and every list item with a sentence that states its point and reads on its own; reasons, details and caveats come after it.
- Give a reply longer than four paragraphs a few short headings.
This changes the order of what you write, not its content or its length.`;

export default function textfoldFold(pi: ExtensionAPI) {
	// The level every loadout-rendered reply shows at, and the panel with. Full at start.
	let level: Level = 1;
	// The latest settled assistant reply: the panel always shows this fold.
	let lastAssistant = "";

	// The style section, appended as a structured prompt section so the session
	// records a delta instead of a replaced prompt.
	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.sections = {
			...event.systemPromptOptions.sections,
			textfold: STYLE,
		};
		return {};
	});

	// The latest assistant reply, for the panel.
	pi.on("message_end", (event, ctx) => {
		const m = event.message as { role?: string; content?: Array<{ type?: string; text?: string }> };
		if (m?.role !== "assistant" || !Array.isArray(m.content)) return;
		const text = m.content.filter((b) => b?.type === "text" && b.text).map((b) => b.text).join("\n\n");
		if (text) {
			lastAssistant = text;
			renderPanel(ctx as unknown as PanelCtx | undefined);
		}
	});

	// In-place fold, display only: applied before Pi renders each assistant block.
	// A fresh or re-invalidated message folds at the level in force when it renders;
	// older blocks keep theirs until Pi re-renders them (a width change at least).
	pi.registerMarkdownTransformer((markdown, context) => {
		if (context.messageType !== "assistant" || level === 1) return markdown;
		const f = fold(markdown, level);
		if (!worthFolding(markdown, f.text)) return markdown;
		return `${f.text || "…"}\n\n*(folded: ${f.shown} of ${f.total} words · Alt+1 unfolds)*`;
	});

	// The panel: setWidget re-renders unconditionally, so keys 1..5 reflect at once.
	const renderPanel = (ctx?: PanelCtx) => {
		ctx?.ui.setWidget(PANEL_KEY, foldPanelLines(lastAssistant, level));
	};

	const apply = (next: Level, ctx?: PanelCtx) => {
		if (next === level) return;
		level = next;
		ctx?.ui.notify(`Fold: ${levelName(next)}`, "info");
		renderPanel(ctx);
	};

	// Alt+1..Alt+5. Not plain digits: Pi dispatches extension shortcuts before the
	// editor sees any input, so registered 1..5 would swallow typed digits.
	for (const n of [1, 2, 3, 4, 5] as const) {
		const key = `alt+${n}` as KeyId;
		pi.registerShortcut(key, {
			description: `Fold replies to ${levelName(n)}`,
			handler: async (ctx) => apply(n, ctx as unknown as PanelCtx),
		});
	}

	pi.registerCommand("fold", {
		description: "Fold replies: 1..5, a level name, off, or nothing for the next level",
		handler: async (arg: string | undefined, ctx) => {
			const panel = ctx as unknown as PanelCtx | undefined;
			const got = parseLevelArg(arg ?? "", level);
			if (got.error) {
				panel?.ui.notify(got.error, "warning");
				return;
			}
			if (got.level) apply(got.level, panel);
		},
	});
}

const levelName = (n: number): string => LEVELS[n - 1] ?? "Full";
