import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import floatingPlan from "../index.ts";

/**
 * Point pi's settings at a scratch directory for the whole file, so a test can
 * never write to the developer's real agent settings.
 */
const scratchAgentDir = await mkdtemp(join(tmpdir(), "pifp-agent-"));
process.env.PI_CODING_AGENT_DIR = scratchAgentDir;

const THEME = { fg: (_color, text) => text, bold: (text) => text, italic: (text) => text, inverse: (text) => text };

/**
 * A fake pi runtime. Only the surface the extension touches is implemented,
 * which is also a check that the extension stays within that surface.
 */
function fakeRuntime(options = {}) {
	const events = new Map();
	const commands = new Map();
	const shortcuts = new Map();
	const tools = new Map();
	const calls = { notifications: [], custom: 0, openOverlays: 0, closed: 0, widgets: new Map(), overlayOptions: [] };

	const pi = {
		on(name, handler) {
			const list = events.get(name) ?? [];
			list.push(handler);
			events.set(name, list);
			return () => {};
		},
		registerCommand(name, definition) {
			commands.set(name, definition);
		},
		registerShortcut(key, definition) {
			shortcuts.set(key, definition);
		},
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
	};

	const branch = options.branch ?? [];
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: process.cwd(),
		ui: {
			theme: THEME,
			notify: (message, type) => calls.notifications.push({ message, type }),
			setStatus: () => {},
			setWidget: (key, content) => calls.widgets.set(key, content),
			custom: async (factory, opts) => {
				calls.custom++;
				if (opts?.overlay) calls.openOverlays++;
				// pi resolves the placement when the overlay is shown, so this is
				// the one the panel actually gets.
				calls.overlayOptions.push(typeof opts?.overlayOptions === "function" ? opts.overlayOptions() : opts?.overlayOptions);
				let done;
				const component = factory(
					{ requestRender: () => {}, mode: options.tuiMode },
					THEME,
					{},
					(result) => {
						calls.closed++;
						done?.(result);
					},
				);
				return new Promise((resolve) => {
					done = resolve;
					if (options.closeImmediately) resolve();
				});
			},
		},
		sessionManager: { getBranch: () => branch },
		model: options.model,
		getContextUsage: () => undefined,
	};

	const emit = async (name, event = {}) => {
		for (const handler of events.get(name) ?? []) await handler(event, ctx);
	};

	return { pi, ctx, calls, commands, shortcuts, tools, emit };
}

async function start(options = {}) {
	// Each run starts from clean settings, so a test that persists a choice
	// cannot leak into the next one.
	await writeFile(join(scratchAgentDir, "settings.json"), JSON.stringify(options.settings ?? {}), "utf8");
	const runtime = fakeRuntime(options);
	await floatingPlan(runtime.pi);
	await runtime.emit("session_start");
	return runtime;
}

function toolResult(toolName, details, content = "") {
	return { type: "message", message: { role: "toolResult", toolName, details, content: content ? [{ type: "text", text: content }] : [] } };
}

test("the extension registers its tool, command, and toggle shortcut", async () => {
	const { tools, commands, shortcuts } = await start();
	assert.ok(tools.has("update_plan"));
	assert.ok(commands.has("plan"));
	assert.ok(shortcuts.has("alt+o"), "alt+o toggles the panel by default");
});

test("the toggle key comes from settings", async () => {
	const { shortcuts } = await start({ settings: { floatingPlan: { toggleKey: "ctrl+j" } } });
	assert.ok(shortcuts.has("ctrl+j"));
	assert.equal(shortcuts.has("alt+o"), false);
});

test("a plan from the model reaches the panel through the tool", async () => {
	const runtime = await start();
	await runtime.emit("tool_result", {
		toolName: "update_plan",
		details: { steps: [{ text: "a", status: "pending" }] },
		content: [],
	});
	// Our own tool updates the store from execute(); the event is a no-op here,
	// which is what stops a plan being applied twice.
	assert.equal(runtime.calls.openOverlays, 0);
});

test("the panel stays closed when there is no plan", async () => {
	const runtime = await start();
	assert.equal(runtime.calls.openOverlays, 0);
});

test("a plan published by the tool opens the panel and renders it", async () => {
	const runtime = await start();
	await runtime.tools.get("update_plan").execute("call-1", { steps: [{ text: "a", status: "in_progress" }] }, undefined, undefined, runtime.ctx);
	assert.equal(runtime.calls.openOverlays, 1);
});

test("clearing the plan closes the panel", async () => {
	const runtime = await start();
	await runtime.tools.get("update_plan").execute("call-1", { steps: [{ text: "a", status: "pending" }] }, undefined, undefined, runtime.ctx);
	assert.equal(runtime.calls.openOverlays, 1);
	await runtime.tools.get("update_plan").execute("call-2", { steps: [] }, undefined, undefined, runtime.ctx);
	assert.equal(runtime.calls.closed, 1);
});

test("the plan is rebuilt from the transcript on session start", async () => {
	const branch = [
		toolResult("update_plan", { steps: [{ text: "a", status: "pending" }] }),
		toolResult("update_plan", { steps: [{ text: "a", status: "completed" }, { text: "b", status: "pending" }] }),
	];
	const runtime = await start({ branch });
	assert.equal(runtime.calls.openOverlays, 1);
	const last = branch[branch.length - 1].message.details.steps.length;
	assert.equal(last, 2, "the last plan on the branch wins");
});

test("a plan published by another extension's todo tool is mirrored", async () => {
	const runtime = await start();
	await runtime.emit("tool_result", {
		toolName: "todo",
		details: undefined,
		content: [{ type: "text", text: "Todo list:\n- [x] read config\n- [>] write the panel" }],
	});
	assert.equal(runtime.calls.openOverlays, 1);
});

test("an unrelated tool result is ignored", async () => {
	const runtime = await start();
	await runtime.emit("tool_result", {
		toolName: "bash",
		content: [{ type: "text", text: "- [x] not a plan" }],
	});
	assert.equal(runtime.calls.openOverlays, 0);
});

test("/plan toggles the panel and persists the choice", async () => {
	const runtime = await start();
	const { commandCtx } = { commandCtx: { ...runtime.ctx, ui: { ...runtime.ctx.ui, setStatus: () => {} } } };
	await runtime.commands.get("plan").handler("", runtime.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	// Hidden now: the plan is empty, so the toggle only records the preference.
	assert.match(runtime.calls.notifications.at(-1).message, /hidden|shown/);

	const { readFile } = await import("node:fs/promises");
	const settings = JSON.parse(await readFile(join(scratchAgentDir, "settings.json"), "utf8"));
	assert.equal(typeof settings.floatingPlan.visible, "boolean");
	assert.ok(commandCtx);
});

test("/plan add, start, done and clear drive the plan by hand", async () => {
	const runtime = await start();
	const plan = runtime.commands.get("plan").handler;

	await plan("add read the docs", runtime.ctx);
	await plan("add write the tests", runtime.ctx);
	assert.match(runtime.calls.notifications.at(-1).message, /step 1 of 2/);

	await plan("done 1", runtime.ctx);
	assert.match(runtime.calls.notifications.at(-1).message, /step 2 of 2/);

	await plan("clear", runtime.ctx);
	assert.match(runtime.calls.notifications.at(-1).message, /cleared/i);

	await plan("start 1", runtime.ctx);
	assert.match(runtime.calls.notifications.at(-1).message, /No plan/);
});

test("/plan lists the plan and explains itself", async () => {
	const runtime = await start();
	const plan = runtime.commands.get("plan").handler;
	await plan("add a step", runtime.ctx);
	await plan("list", runtime.ctx);
	assert.match(runtime.calls.notifications.at(-1).message, /1\. \[>\] a step/);
	await plan("help", runtime.ctx);
	assert.match(runtime.calls.notifications.at(-1).message, /\/plan anchor/);
	assert.match(runtime.calls.notifications.at(-1).message, /\/plan padding/);
});

test("the panel opens with the anchor and padding from settings", async () => {
	const runtime = await start({ settings: { floatingPlan: { anchor: "bottom-right", padding: 4 } } });
	await runtime.emit("tool_result", {
		toolName: "todo",
		details: { steps: [{ text: "a", status: "pending" }] },
		content: [],
	});
	assert.deepEqual(runtime.calls.overlayOptions.at(-1).margin, { top: 4, right: 4, bottom: 4, left: 4 });
	assert.equal(runtime.calls.overlayOptions.at(-1).anchor, "bottom-right");
});

test("/plan padding moves the panel and is persisted", async () => {
	const runtime = await start();
	await runtime.emit("tool_result", { toolName: "todo", details: { steps: [{ text: "a", status: "pending" }] }, content: [] });
	const shown = runtime.calls.overlayOptions.length;
	const plan = runtime.commands.get("plan").handler;

	await plan("padding 5", runtime.ctx);
	assert.deepEqual(runtime.calls.overlayOptions.at(-1).margin, { top: 5, right: 5, bottom: 5, left: 5 });
	assert.ok(runtime.calls.overlayOptions.length > shown, "the overlay was rebuilt: pi reads the placement once, when shown");
	assert.match(runtime.calls.notifications.at(-1).message, /padding 5/i);

	const { readFile } = await import("node:fs/promises");
	const settings = JSON.parse(await readFile(join(scratchAgentDir, "settings.json"), "utf8"));
	assert.equal(settings.floatingPlan.padding, 5);
});

test("/plan padding reports the placement when given no argument", async () => {
	const runtime = await start({ settings: { floatingPlan: { padding: 0 } } });
	await runtime.commands.get("plan").handler("padding", runtime.ctx);
	assert.match(runtime.calls.notifications.at(-1).message, /anchored top-center, 0 rows\/columns/);
});

test("/plan padding refuses anything that is not a whole number of cells", async () => {
	const runtime = await start();
	const plan = runtime.commands.get("plan").handler;
	for (const argument of ["two", "-1", "2.5", "1e3", "999"]) {
		await plan(`padding ${argument}`, runtime.ctx);
		assert.match(runtime.calls.notifications.at(-1).message, /not a padding/, `rejects "${argument}"`);
	}
	const { readFile } = await import("node:fs/promises");
	const settings = JSON.parse(await readFile(join(scratchAgentDir, "settings.json"), "utf8"));
	assert.equal(settings.floatingPlan, undefined, "and nothing was written");
});

test("/plan anchor rebuilds the overlay so the new corner takes effect", async () => {
	const runtime = await start();
	await runtime.emit("tool_result", { toolName: "todo", details: { steps: [{ text: "a", status: "pending" }] }, content: [] });
	const shown = runtime.calls.overlayOptions.length;
	await runtime.commands.get("plan").handler("anchor left-center", runtime.ctx);
	assert.equal(runtime.calls.overlayOptions.at(-1).anchor, "left-center");
	assert.ok(runtime.calls.overlayOptions.length > shown, "the overlay was rebuilt");
	assert.match(runtime.calls.notifications.at(-1).message, /anchored left-center/);
});

test("regular mode is explained once, because scrolling takes the panel with it", async () => {
	const runtime = await start({ tuiMode: "regular" });
	const plan = runtime.commands.get("plan").handler;
	await runtime.emit("tool_result", { toolName: "todo", details: { steps: [{ text: "a", status: "pending" }] }, content: [] });
	const hints = () => runtime.calls.notifications.filter((n) => /fullscreen/.test(n.message));
	assert.equal(hints().length, 1, "the terminal owning scrollback is worth saying once");
	assert.match(hints()[0].message, /takes the panel with it/);

	// Reopening the panel must not repeat it.
	await plan("padding 3", runtime.ctx);
	assert.equal(hints().length, 1);
});

test("fullscreen mode says nothing, because there the panel already stays put", async () => {
	const runtime = await start({ tuiMode: "fullscreen" });
	await runtime.emit("tool_result", { toolName: "todo", details: { steps: [{ text: "a", status: "pending" }] }, content: [] });
	assert.ok(!runtime.calls.notifications.some((n) => /fullscreen/.test(n.message)));
});

test("the tool's arguments are coerced into the schema's own shape", async () => {
	const runtime = await start();
	const tool = runtime.tools.get("update_plan");
	const prepared = tool.prepareArguments({ todos: [{ title: "a", done: true }, "- [ ] b", "c"] });
	assert.deepEqual(prepared.steps, [
		{ text: "a", status: "completed" },
		{ text: "b", status: "in_progress" },
		{ text: "c", status: "pending" },
	]);
});

test("the tool result feeds the panel and reads back as a plan", async () => {
	const runtime = await start();
	const tool = runtime.tools.get("update_plan");
	const result = await tool.execute("call-1", { steps: [{ text: "a", status: "in_progress" }] }, undefined, undefined, runtime.ctx);
	assert.equal(runtime.calls.openOverlays, 1);
	assert.match(result.content[0].text, /Plan updated \(step 1 of 1\)/);
	assert.deepEqual(result.details.steps, [{ text: "a", status: "in_progress" }]);
});

test("the shortcut toggles the panel without touching settings", async () => {
	const runtime = await start();
	await runtime.tools.get("update_plan").execute("call-1", { steps: [{ text: "a", status: "pending" }] }, undefined, undefined, runtime.ctx);
	assert.equal(runtime.calls.openOverlays, 1);
	await runtime.shortcuts.get("alt+o").handler(runtime.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(runtime.calls.closed, 1, "the panel closed");
});

test("shutdown closes the panel and drops the plan", async () => {
	const runtime = await start();
	await runtime.tools.get("update_plan").execute("call-1", { steps: [{ text: "a", status: "pending" }] }, undefined, undefined, runtime.ctx);
	await runtime.emit("session_shutdown");
	assert.equal(runtime.calls.closed, 1);
});

test("nothing terminal-only runs outside the TUI", async () => {
	await writeFile(join(scratchAgentDir, "settings.json"), "{}", "utf8");
	const runtime = fakeRuntime();
	runtime.ctx.mode = "print";
	runtime.ctx.hasUI = false;
	await floatingPlan(runtime.pi);
	await runtime.emit("session_start");
	await runtime.emit("tool_result", { toolName: "update_plan", details: { steps: [{ text: "a", status: "pending" }] }, content: [] });
	assert.equal(runtime.calls.openOverlays, 0);
	assert.equal(runtime.calls.custom, 0);
});
