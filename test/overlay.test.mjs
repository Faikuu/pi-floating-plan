import { test } from "node:test";
import assert from "node:assert/strict";

import { TuiAltScreen, TuiMainScreen, Container, ScrollView, Text, VStack, stripTerminalSequences } from "@earendil-works/pi-tui";

import { DEFAULT_CONFIG, parseConfig } from "../lib/config.ts";
import { overlayOptions } from "../lib/position.ts";
import { PlanPanel } from "../lib/panel.ts";
import { createPlanStore } from "../lib/plan-store.ts";

/**
 * The overlay options the extension passes to `ctx.ui.custom()`, built by the
 * same function the extension calls, so a change to placement cannot quietly
 * stop being tested here.
 */
const OVERLAY_OPTIONS = overlayOptions(DEFAULT_CONFIG);

const THEME = { fg: (_color, text) => text, bold: (text) => text, italic: (text) => text, inverse: (text) => text };
class FakeTerminal {
	constructor(columns, rows) {
		this.termColumns = columns;
		this.termRows = rows;
		this.output = "";
	}
	get columns() {
		return this.termColumns;
	}
	get rows() {
		return this.termRows;
	}
	get kittyProtocolActive() {
		return false;
	}
	start() {}
	stop() {}
	drainInput() {
		return Promise.resolve();
	}
	write(data) {
		this.output += data;
	}
	moveBy() {}
	hideCursor() {}
	showCursor() {}
	clearLine() {}
	clearFromCursor() {}
	clearScreen() {}
	setTitle() {}
	setProgress() {}
}

function storeWithPlan() {
	const store = createPlanStore();
	store.set({
		steps: [
			{ text: "read the config", status: "completed" },
			{ text: "map every call site", status: "completed" },
			{ text: "implement the floating panel", status: "in_progress" },
			{ text: "tests and the README", status: "pending" },
		],
	});
	return store;
}

/** A main-screen TUI with the plan floating over an editor. */
function laidOut(options = OVERLAY_OPTIONS, columns = 80, rows = 20) {
	const terminal = new FakeTerminal(columns, rows);
	const tui = new TuiMainScreen(terminal);
	const editor = new Text("> ask the agent something", 0, 0);
	tui.addChild(editor);
	tui.setFocus(editor);
	const handle = tui.showOverlay(new PlanPanel({ store: storeWithPlan(), theme: THEME }), options);
	tui.renderNow(true);
	return { tui, terminal, editor, handle, screen: () => stripTerminalSequences(terminal.output) };
}

function scene(columns = 80, rows = 20) {
	return laidOut(OVERLAY_OPTIONS, columns, rows);
}

/**
 * A fullscreen TUI with a transcript long enough to scroll, which is how pi
 * is normally run: the panel has to stay on screen while the document moves.
 */
function scrolledScene(columns = 80, rows = 20, lines = 200) {
	const terminal = new FakeTerminal(columns, rows);
	const tui = new TuiAltScreen(terminal);
	const document = new Container();
	for (let i = 0; i < lines; i++) document.addChild(new Text(`line ${i}`, 0, 0));
	const transcript = new ScrollView(document, { follow: "end", primary: true });
	const editor = new Text("> ask the agent something", 0, 0);
	tui.setLayoutRoot(
		new VStack([
			{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: editor, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]),
	);
	tui.setFocus(editor);
	const handle = tui.showOverlay(new PlanPanel({ store: storeWithPlan(), theme: THEME }), OVERLAY_OPTIONS);
	tui.start();
	tui.renderNow(true);
	// The rows of the last frame pi painted, which is what the user sees.
	const painted = () => (tui.previousScreen ?? []).map((line) => stripTerminalSequences(line));
	return { tui, terminal, transcript, editor, handle, painted };
}

test("the panel floats without taking focus from the editor", () => {
	const { tui, editor, handle } = scene();
	assert.equal(handle.isFocused(), false, "the overlay never captures input");
	assert.equal(tui.focusedComponent, editor, "the editor keeps focus");
});

test("the panel is composited at the top center, clear of the editor", () => {
	const { handle, screen } = scene(80, 20);
	const bounds = handle.getBounds();
	assert.ok(bounds, "the overlay was laid out");
	assert.equal(bounds.width, 38);
	// One padding row below the top of the screen.
	assert.equal(bounds.row, DEFAULT_CONFIG.padding);
	// Centered in the space the padding leaves, and nowhere near the bottom.
	assert.equal(bounds.col, DEFAULT_CONFIG.padding + Math.floor((80 - 2 * DEFAULT_CONFIG.padding - 38) / 2));
	assert.ok(bounds.row + bounds.height <= 12, "the panel stays in the upper half of a 20-row terminal");
	assert.match(screen(), /PLAN/);
});

test("the anchor and padding decide where the panel lands", () => {
	const corners = [
		["top-left", 2, { row: 2, col: 2 }],
		["top-right", 2, { row: 2, col: 80 - 2 - 38 }],
		["bottom-left", 0, { row: 20 - 7, col: 0 }],
		["right-center", 1, { row: 1 + Math.floor((20 - 2 - 7) / 2), col: 80 - 1 - 38 }],
	];
	for (const [anchor, padding, expected] of corners) {
		const options = overlayOptions(parseConfig({ floatingPlan: { anchor, padding } }));
		const { handle } = laidOut(options);
		const bounds = handle.getBounds();
		assert.deepEqual({ row: bounds.row, col: bounds.col }, expected, `${anchor} with padding ${padding}`);
	}
});

test("the panel stays pinned while the transcript scrolls under it", () => {
	const { tui, transcript, handle, painted } = scrolledScene();
	const planRows = () => painted().flatMap((line, row) => (line.includes("PLAN") || line.includes("implement the floating panel") ? [row] : []));
	const topLine = () => painted()[0];

	const bounds = handle.getBounds();
	assert.equal(bounds.row, DEFAULT_CONFIG.padding, "laid out against the viewport, not the document");
	const anchored = planRows();
	assert.deepEqual(anchored, [bounds.row, bounds.row + 4], "the frame is painted where it was laid out");

	for (const lines of [10, 50, 180]) {
		const before = topLine();
		transcript.scrollBy(-lines);
		tui.renderNow(true);
		assert.notEqual(topLine(), before, `the transcript really moved ${lines} lines`);
		assert.equal(handle.getBounds().row, bounds.row, `still on the same screen row after scrolling ${lines} lines`);
		assert.deepEqual(planRows(), anchored, `the panel did not scroll away (${lines} lines)`);
	}
});

test("a terminal too narrow to hold the panel is left alone", () => {
	const { handle, screen } = scene(20, 20);
	assert.equal(handle.getBounds(), undefined, "the overlay is not laid out at all");
	assert.ok(!screen().includes("PLAN"), "and nothing is drawn");
});

test("a long plan is capped rather than filling a short terminal", () => {
	const store = createPlanStore();
	store.set({ steps: Array.from({ length: 24 }, (_, index) => ({ text: `step ${index + 1}`, status: "pending" })) });
	const terminal = new FakeTerminal(80, 20);
	const tui = new TuiMainScreen(terminal);
	tui.addChild(new Text("> ask the agent something", 0, 0));
	const handle = tui.showOverlay(new PlanPanel({ store, theme: THEME }), OVERLAY_OPTIONS);
	tui.renderNow(true);
	// 60% of 20 rows is 12: the plan is cut from the bottom, not spilled.
	assert.equal(handle.getBounds().height, 12);
	const drawn = stripTerminalSequences(terminal.output).split("\n").filter((line) => line.includes("step "));
	assert.ok(drawn.length > 0, "some of the plan is still shown");
});

test("a plan change repaints through the real TUI", () => {
	const store = createPlanStore();
	store.set({ steps: [{ text: "first step", status: "pending" }] });
	const terminal = new FakeTerminal(80, 20);
	const tui = new TuiMainScreen(terminal);
	const editor = new Text("> ask the agent something", 0, 0);
	tui.addChild(editor);
	tui.setFocus(editor);
	const panel = new PlanPanel({ store, theme: THEME });
	tui.showOverlay(panel, OVERLAY_OPTIONS);
	tui.renderNow(true);
	assert.match(stripTerminalSequences(terminal.output), /first step/);

	// Exactly what the extension's store subscription does on a plan change.
	const unsubscribe = store.subscribe(() => {
		panel.invalidate();
		tui.requestRender();
	});
	store.set({ steps: [{ text: "first step", status: "completed" }, { text: "second step", status: "in_progress" }] });
	unsubscribe();
	tui.renderNow(true);
	assert.match(stripTerminalSequences(terminal.output), /second step/);
	assert.equal(tui.focusedComponent, editor, "a redraw never moves focus");
});
