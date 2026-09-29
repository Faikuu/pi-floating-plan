import { test } from "node:test";
import assert from "node:assert/strict";

import { TuiMainScreen, Text, stripTerminalSequences } from "@earendil-works/pi-tui";

import { PlanPanel } from "../lib/panel.ts";
import { createPlanStore } from "../lib/plan-store.ts";

/**
 * The overlay options the extension passes to `ctx.ui.custom()`, exercised
 * against a real TUI over a fake terminal. The point of the test is the
 * promise the README makes: the panel floats, and the editor keeps focus.
 */
const OVERLAY_OPTIONS = {
	anchor: "top-center",
	width: 38,
	minWidth: 20,
	maxHeight: "60%",
	margin: { left: 1, right: 1, top: 0, bottom: 1 },
	visible: (termWidth) => termWidth >= 24,
	nonCapturing: true,
};

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

function scene(columns = 80, rows = 20) {
	const store = createPlanStore();
	store.set({
		steps: [
			{ text: "read the config", status: "completed" },
			{ text: "map every call site", status: "completed" },
			{ text: "implement the floating panel", status: "in_progress" },
			{ text: "tests and the README", status: "pending" },
		],
	});
	const terminal = new FakeTerminal(columns, rows);
	const tui = new TuiMainScreen(terminal);
	const editor = new Text("> ask the agent something", 0, 0);
	tui.addChild(editor);
	tui.setFocus(editor);
	const handle = tui.showOverlay(new PlanPanel({ store, theme: THEME }), OVERLAY_OPTIONS);
	tui.renderNow(true);
	return { tui, terminal, editor, handle, screen: () => stripTerminalSequences(terminal.output) };
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
	assert.equal(bounds.row, 0, "flush with the top of the screen");
	// Centered in the space the margins leave, and nowhere near the bottom.
	assert.equal(bounds.col, Math.floor((80 - 2 - 38) / 2) + 1);
	assert.ok(bounds.row + bounds.height <= 12, "the panel stays in the upper half of a 20-row terminal");
	assert.match(screen(), /PLAN/);
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
