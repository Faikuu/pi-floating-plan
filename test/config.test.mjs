import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { ANCHORS, configPatch, DEFAULT_CONFIG, MAX_PADDING, parseConfig } from "../lib/config.ts";
import { overlayOptions } from "../lib/position.ts";
import { agentDir, globalSettingsPath, readSettings, writeSettings } from "../lib/settings.ts";

async function tmp() {
	return mkdtemp(join(tmpdir(), "pifp-test-"));
}

test("parseConfig returns the defaults for an empty settings file", () => {
	assert.deepEqual(parseConfig({}), DEFAULT_CONFIG);
	assert.deepEqual(parseConfig({ floatingPlan: undefined }), DEFAULT_CONFIG);
	assert.deepEqual(parseConfig({ floatingPlan: "nonsense" }), DEFAULT_CONFIG);
	assert.deepEqual(parseConfig({ floatingPlan: [1, 2] }), DEFAULT_CONFIG);
});

test("parseConfig reads each documented key", () => {
	const config = parseConfig({
		floatingPlan: {
			visible: false,
			anchor: "top-left",
			padding: 4,
			width: 44,
			maxSteps: 6,
			maxTextLength: 60,
			showBar: false,
			showNote: false,
			showModel: true,
			compactBelow: 40,
			toggleKey: "ctrl+j",
			mirrorTools: ["todo"],
		},
	});
	assert.equal(config.visible, false);
	assert.equal(config.anchor, "top-left");
	assert.equal(config.padding, 4);
	assert.equal(config.width, 44);
	assert.equal(config.maxSteps, 6);
	assert.equal(config.maxTextLength, 60);
	assert.equal(config.showBar, false);
	assert.equal(config.showNote, false);
	assert.equal(config.showModel, true);
	assert.equal(config.compactBelow, 40);
	assert.equal(config.toggleKey, "ctrl+j");
	assert.deepEqual(config.mirrorTools, ["todo"]);
});

test("parseConfig ignores values of the wrong type or range", () => {
	const config = parseConfig({
		floatingPlan: { visible: "yes", anchor: "middle", width: -4, maxSteps: 0, maxTextLength: 1.7, toggleKey: "  ", mirrorTools: [] },
	});
	assert.equal(config.visible, DEFAULT_CONFIG.visible);
	assert.equal(config.anchor, DEFAULT_CONFIG.anchor);
	assert.equal(config.width, DEFAULT_CONFIG.width);
	assert.equal(config.maxSteps, DEFAULT_CONFIG.maxSteps);
	assert.equal(config.maxTextLength, DEFAULT_CONFIG.maxTextLength);
	assert.equal(config.toggleKey, DEFAULT_CONFIG.toggleKey);
	assert.deepEqual(config.mirrorTools, DEFAULT_CONFIG.mirrorTools);
	assert.equal(parseConfig({ floatingPlan: { anchor: "bottom-right" } }).anchor, "bottom-right", "an explicit choice is still honoured");
});

test("parseConfig caps an absurd panel width", () => {
	assert.equal(parseConfig({ floatingPlan: { width: 10_000 } }).width, 120);
	assert.equal(parseConfig({ floatingPlan: { maxSteps: 10_000 } }).maxSteps, 100);
});

test("every anchor is one the overlay API understands", () => {
	for (const anchor of ANCHORS) {
		assert.equal(parseConfig({ floatingPlan: { anchor } }).anchor, anchor);
	}
	assert.equal(parseConfig({ floatingPlan: { anchor: "top-middle" } }).anchor, DEFAULT_CONFIG.anchor);
});

test("a single mirror tool may be given as a string", () => {
	assert.deepEqual(parseConfig({ floatingPlan: { mirrorTools: "todo" } }).mirrorTools, ["todo"]);
	assert.deepEqual(parseConfig({ floatingPlan: { mirrorTools: ["todo", "  ", 7, "todo_write"] } }).mirrorTools, ["todo", "todo_write"]);
});

test("parseConfig reads the padding, and zero is a real choice", () => {
	assert.equal(parseConfig({ floatingPlan: { padding: 0 } }).padding, 0, "flush against the edge is allowed");
	assert.equal(parseConfig({ floatingPlan: { padding: 3 } }).padding, 3);
	assert.equal(parseConfig({ floatingPlan: { padding: 3.9 } }).padding, 3, "a fraction is floored, not rejected");
	assert.equal(parseConfig({ floatingPlan: { padding: -2 } }).padding, DEFAULT_CONFIG.padding);
	assert.equal(parseConfig({ floatingPlan: { padding: "2" } }).padding, DEFAULT_CONFIG.padding, "a string is not a padding");
	assert.equal(parseConfig({ floatingPlan: { padding: 10_000 } }).padding, MAX_PADDING, "and an absurd one is capped");
});

test("the padding becomes the margin on all four edges", () => {
	const { margin, anchor } = overlayOptions(parseConfig({ floatingPlan: { anchor: "bottom-right", padding: 3 } }));
	assert.equal(anchor, "bottom-right");
	assert.deepEqual(margin, { top: 3, right: 3, bottom: 3, left: 3 });
});

test("one padding covers every anchor, because only the two edges it touches move it", () => {
	// pi clamps the panel inside the margin box, so the far edges of the
	// margin never change the result: the same number works everywhere.
	for (const anchor of ANCHORS) {
		assert.deepEqual(overlayOptions(parseConfig({ floatingPlan: { anchor, padding: 2 } })).margin, {
			top: 2,
			right: 2,
			bottom: 2,
			left: 2,
		});
	}
});

test("configPatch only writes the user-facing toggles", () => {
	assert.deepEqual(configPatch(DEFAULT_CONFIG, { visible: false }), {
		floatingPlan: { visible: false, anchor: "top-center", padding: 2, toggleKey: "alt+o" },
	});
	assert.deepEqual(configPatch(DEFAULT_CONFIG, { padding: 5 }).floatingPlan.padding, 5, "a padding change is persisted too");
});

test("the default anchor keeps the panel off the editor", () => {
	// pi draws the editor along the bottom of the screen; a bottom-anchored
	// panel would sit on the input box.
	assert.equal(DEFAULT_CONFIG.anchor, "top-center");
	assert.ok(!DEFAULT_CONFIG.anchor.startsWith("bottom"), "the default never overlaps the input box");
});

test("agentDir honors PI_CODING_AGENT_DIR and expands ~", () => {
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "/tmp/agent" }), "/tmp/agent");
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "  /tmp/agent  " }), "/tmp/agent");
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "~/elsewhere" }), join(homedir(), "elsewhere"));
	assert.equal(agentDir({}), join(homedir(), ".pi", "agent"));
});

test("globalSettingsPath points inside the agent directory", () => {
	assert.equal(globalSettingsPath({ PI_CODING_AGENT_DIR: "/tmp/agent" }), "/tmp/agent/settings.json");
});

test("readSettings returns an empty object for a missing or broken file", async () => {
	const dir = await tmp();
	assert.deepEqual(await readSettings(join(dir, "nope.json")), {});
	const broken = join(dir, "broken.json");
	await writeFile(broken, "{not json", "utf8");
	assert.deepEqual(await readSettings(broken), {});
	await writeFile(broken, "[1, 2]", "utf8");
	assert.deepEqual(await readSettings(broken), {});
});

test("writeSettings merges, leaving unrelated keys alone", async () => {
	const dir = await tmp();
	const file = join(dir, "settings.json");
	await writeFile(file, JSON.stringify({ theme: "dark", floatingPlan: { width: 30 } }), "utf8");
	await writeSettings(file, { floatingPlan: { visible: false } });
	const settings = await readSettings(file);
	assert.equal(settings.theme, "dark");
	assert.deepEqual(settings.floatingPlan, { visible: false });
});
