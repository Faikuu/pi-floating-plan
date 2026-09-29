import { test } from "node:test";
import assert from "node:assert/strict";

import { PlanPanel } from "../lib/panel.ts";
import { createPlanStore } from "../lib/plan-store.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

/** A theme with the ANSI-free surface the panel actually uses. */
const theme = {
	fg: (_color, text) => text,
	bold: (text) => text,
	italic: (text) => text,
	inverse: (text) => text,
};

/** A theme that emits real ANSI, so width bugs cannot hide behind plain text. */
const ansiTheme = {
	fg: (color, text) => `\u001b[38;2;120;120;120m${text}\u001b[0m`,
	bold: (text) => `\u001b[1m${text}\u001b[0m`,
	italic: (text) => `\u001b[3m${text}\u001b[0m`,
	inverse: (text) => `\u001b[7m${text}\u001b[0m`,
};

function storeWith(steps) {
	const store = createPlanStore();
	store.set({ steps });
	return store;
}

const PLAN = [
	{ text: "read config", status: "completed" },
	{ text: "map call sites", status: "completed" },
	{ text: "implement the widget", status: "in_progress" },
	{ text: "tests and typecheck", status: "pending" },
];

test("the panel renders nothing without a plan", () => {
	assert.deepEqual(new PlanPanel({ store: createPlanStore(), theme }).render(40), []);
	const empty = createPlanStore({ steps: [] });
	assert.deepEqual(new PlanPanel({ store: empty, theme }).render(40), []);
});

test("the panel draws a frame, one line per step, and a footer", () => {
	const lines = new PlanPanel({ store: storeWith(PLAN), theme }).render(40);
	assert.equal(lines.length, PLAN.length + 3);
	assert.match(lines[0], /^╭─ PLAN ─ step 3 of 4 ─+╮$/);
	assert.match(lines[1], /^│ ▓+░+ │$/);
	assert.deepEqual(
		lines.slice(2, 2 + PLAN.length).map((line) => line.slice(2, -2).trim()),
		["✔ read config", "✔ map call sites", "▸ implement the widget", "○ tests and typecheck"],
	);
	assert.match(lines[lines.length - 1], /^╰─ 2 of 4 done ─+╯$/);
});

test("every rendered line fits the width it was given", () => {
	for (const width of [16, 20, 24, 30, 33, 34, 40, 60, 120]) {
		const lines = new PlanPanel({ store: storeWith(PLAN), theme, width: 200 }).render(width);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `line wider than ${width}: ${JSON.stringify(line)}`);
		}
	}
});

test("a long step is elided instead of spilling out of the frame", () => {
	const lines = new PlanPanel({ store: storeWith([{ text: "x".repeat(300), status: "in_progress" }]), theme, width: 30 }).render(40);
	assert.equal(lines.length, 4);
	for (const line of lines) assert.ok(visibleWidth(line) <= 40);
	assert.match(lines[2], /\.{3}/, "the step is elided");
});

test("the panel never exceeds the terminal, however wide it is configured", () => {
	const lines = new PlanPanel({ store: storeWith(PLAN), theme, width: 200 }).render(40);
	for (const line of lines) assert.equal(visibleWidth(line), 40);
});

test("a narrow terminal drops the frame for a compact block", () => {
	const lines = new PlanPanel({ store: storeWith(PLAN), theme }).render(28);
	assert.ok(lines.length <= 3, "the compact block stays short");
	for (const line of lines) assert.ok(visibleWidth(line) <= 28);
	assert.ok(!lines.some((line) => line.includes("│")), "no frame in compact mode");
	assert.ok(lines[0].includes("PLAN"));
});

test("the completion bar tracks the plan", () => {
	const done = storeWith(PLAN.map((step) => ({ ...step, status: "completed" })));
	const lines = new PlanPanel({ store: done, theme }).render(40);
	assert.match(lines[1], /^│ ▓+░* │$/);
	assert.equal(lines[1].replace(/[^▓░]/g, "").length, 34, "the bar spans the frame's inner width");
});

test("the model appears in the title only when asked for", () => {
	const store = storeWith(PLAN);
	const hidden = new PlanPanel({ store, theme, model: () => "claude-sonnet-4.6" }).render(40);
	assert.match(hidden[0], /^╭─ PLAN ─ step 3 of 4 ─+╮$/);
	const shown = new PlanPanel({ store, theme, showModel: true, model: () => "gpt-5.2-codex" }).render(40);
	assert.match(shown[0], /PLAN · gpt-5\.2-codex/);
});

test("a note is shown only when the plan has one", () => {
	const store = createPlanStore();
	store.set({ steps: PLAN, note: "rewrote after the review" });
	const lines = new PlanPanel({ store, theme }).render(40);
	assert.ok(lines.some((line) => line.includes("rewrote after the review")));
	const withoutNote = new PlanPanel({ store, theme, showNote: false }).render(40);
	assert.ok(!withoutNote.some((line) => line.includes("rewrote after the review")));
});

test("the bar and the note can each be turned off", () => {
	const store = createPlanStore();
	store.set({ steps: PLAN, note: "why" });
	const lines = new PlanPanel({ store, theme, showBar: false, showNote: false }).render(40);
	assert.equal(lines.length, PLAN.length + 2);
});

test("the panel caches by width and plan, and invalidate clears it", () => {
	const store = storeWith(PLAN);
	const panel = new PlanPanel({ store, theme });
	const first = panel.render(40);
	assert.equal(panel.render(40), first, "the same width and plan reuse the cached lines");
	assert.notEqual(panel.render(30), first, "a new width is laid out again");

	// A new plan is picked up on the next render: the fingerprint guard means
	// the caller never has to remember to invalidate after a change.
	store.set({ steps: [...PLAN, { text: "publish", status: "pending" }] });
	const grown = panel.render(40);
	assert.notEqual(grown, first);
	assert.equal(grown.length, PLAN.length + 4);

	panel.invalidate();
	assert.notEqual(panel.render(40), grown, "invalidate drops the cache");
	assert.deepEqual(panel.render(40), grown, "a theme change re-renders the same content");
});

test("a plan with no active step still renders", () => {
	const store = storeWith([
		{ text: "a", status: "completed" },
		{ text: "b", status: "completed" },
	]);
	const lines = new PlanPanel({ store, theme }).render(40);
	assert.match(lines[0], /2 of 2 done/);
	assert.match(lines[lines.length - 1], /2 of 2 done/);
});

test("a styled panel still fits the width it was given", () => {
	const store = storeWith(PLAN);
	for (const model of [undefined, "claude-sonnet-4.6", "a-very-long-model-name-for-testing-overflow"]) {
		for (const width of [80, 60, 40, 38, 36, 34, 30, 24, 20, 16]) {
			const panel = new PlanPanel({ store, theme: ansiTheme, showModel: model !== undefined, model: () => model });
			for (const line of panel.render(width)) {
				assert.ok(visibleWidth(line) <= width, `overflow at ${width} with ${model}: ${JSON.stringify(line)}`);
			}
		}
	}
});

test("a long model name costs the summary, not the frame", () => {
	const store = storeWith(PLAN);
	const long = new PlanPanel({ store, theme: ansiTheme, showModel: true, model: () => "a-very-long-model-name-for-testing" }).render(40);
	assert.equal(visibleWidth(long[0]), 38, "the default 38-column frame is kept");
	assert.ok(!long[0].includes("step 3 of 4"), "the summary yields to a long title");
	assert.ok(long[long.length - 1].includes("2 of 4 done"), "the footer still reports progress");

	const short = new PlanPanel({ store, theme: ansiTheme, showModel: true, model: () => "sonnet" }).render(40);
	assert.ok(short[0].includes("step 3 of 4"));
});

test("the panel is a spectator: it claims no input", () => {
	const panel = new PlanPanel({ store: storeWith(PLAN), theme });
	assert.equal(panel.handleInput("\r"), false);
});
