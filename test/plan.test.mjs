import { test } from "node:test";
import assert from "node:assert/strict";

import {
	DEFAULT_LIMITS,
	fingerprint,
	normalizePlan,
	normalizeStatus,
	planFromText,
	planProgress,
	planSummary,
	planToText,
	stripMarker,
	trimSteps,
	withCurrentStep,
} from "../lib/plan.ts";
import { createPlanStore } from "../lib/plan-store.ts";

const step = (text, status) => ({ text, status });

test("normalizeStatus folds every spelling of a status into three states", () => {
	for (const value of ["done", "Done", "COMPLETED", "finished", "ok", "x", "[x]", "✓", true, 2]) {
		assert.equal(normalizeStatus(value), "completed", `expected completed for ${String(value)}`);
	}
	for (const value of ["in_progress", "in-progress", "InProgress", "doing", "active", "working", "current", "[>]", "▸", "▶"]) {
		assert.equal(normalizeStatus(value), "in_progress", `expected in_progress for ${String(value)}`);
	}
	for (const value of ["pending", "todo", "To-Do", "next", "open", "queued", "not_started", "[ ]", false, 0]) {
		assert.equal(normalizeStatus(value), "pending", `expected pending for ${String(value)}`);
	}
	assert.equal(normalizeStatus("banana"), undefined);
	assert.equal(normalizeStatus(undefined), undefined);
	assert.equal(normalizeStatus(null), undefined);
});

test("stripMarker peels checkbox, bullet and numbering prefixes", () => {
	assert.deepEqual(stripMarker("[x] run the tests"), { text: "run the tests", status: "completed" });
	assert.deepEqual(stripMarker("[>] write the panel"), { text: "write the panel", status: "in_progress" });
	assert.deepEqual(stripMarker("[ ] ship it"), { text: "ship it", status: "pending" });
	assert.deepEqual(stripMarker("2. read config"), { text: "read config", status: undefined });
	assert.deepEqual(stripMarker("- (1) map call sites"), { text: "map call sites", status: "pending" });
	assert.deepEqual(stripMarker("▶ run the tests"), { text: "run the tests", status: "in_progress" });
	assert.deepEqual(stripMarker("  plain step  "), { text: "plain step", status: undefined });
});

test("normalizePlan accepts a bare array of strings", () => {
	const { plan } = normalizePlan(["read config", "[x] map call sites", "write the panel"]);
	// No step was marked active, so the first one still to do becomes current.
	assert.deepEqual(plan.steps, [
		step("read config", "in_progress"),
		step("map call sites", "completed"),
		step("write the panel", "pending"),
	]);
});

test("normalizePlan accepts the shapes models actually send", () => {
	const shapes = [
		{ input: { steps: [{ text: "a", status: "completed" }, { text: "b", status: "pending" }] }, statuses: ["completed", "in_progress"] },
		{ input: { plan: [{ step: "a", state: "done" }, { step: "b", state: "todo" }] }, statuses: ["completed", "in_progress"] },
		{ input: { todos: [{ title: "a", done: true }, { title: "b", active: true }] }, statuses: ["completed", "in_progress"] },
		{ input: { items: ["[x] a", "[ ] b"] }, statuses: ["completed", "in_progress"] },
		{ input: { checklist: [{ description: "a", completed: true }, { description: "b", checked: false }] }, statuses: ["completed", "in_progress"] },
		{ input: { tasks: ["a", "b"] }, statuses: ["in_progress", "pending"] },
		{ input: ["a", "b"], statuses: ["in_progress", "pending"] },
		{ input: "a\nb", statuses: ["in_progress", "pending"] },
	];
	for (const shape of shapes) {
		const { plan } = normalizePlan(shape.input);
		assert.deepEqual(
			plan.steps.map((entry) => entry.status),
			shape.statuses,
			`unexpected statuses from ${JSON.stringify(shape.input)}`,
		);
	}
});

test("normalizePlan keeps exactly one step in progress", () => {
	const { plan } = normalizePlan([
		{ text: "a", status: "in_progress" },
		{ text: "b", status: "in_progress" },
		{ text: "c", status: "pending" },
	]);
	assert.deepEqual(plan.steps.map((entry) => entry.status), ["in_progress", "pending", "pending"]);
});

test("normalizePlan promotes a pending step when the model marks none active", () => {
	const { plan } = normalizePlan([
		{ text: "a", status: "completed" },
		{ text: "b", status: "completed" },
		{ text: "c", status: "pending" },
	]);
	assert.equal(plan.steps[2].status, "in_progress");
});

test("normalizePlan leaves a finished plan finished", () => {
	const { plan } = normalizePlan([
		{ text: "a", status: "completed" },
		{ text: "b", status: "completed" },
	]);
	assert.deepEqual(plan.steps.map((entry) => entry.status), ["completed", "completed"]);
	assert.equal(planSummary(plan), "2 of 2 done");
});

test("normalizePlan collapses repeated steps, keeping the furthest status", () => {
	const { plan } = normalizePlan([
		{ text: "Run the tests", status: "pending" },
		"run the tests",
		{ text: "run the tests!", status: "completed" },
	]);
	assert.equal(plan.steps.length, 1);
	assert.equal(plan.steps[0].status, "completed");
});

test("normalizePlan counts unusable items as dropped", () => {
	const { plan, dropped, merged } = normalizePlan([{ text: "a" }, 42, null, "", { status: "done" }]);
	assert.deepEqual(plan.steps, [step("a", "in_progress")]);
	assert.equal(dropped, 4);
	assert.equal(merged, 0);
});

test("a repeated step is merged, not reported as unusable", () => {
	const { plan, dropped, merged } = normalizePlan([
		{ text: "Run the tests", status: "pending" },
		{ text: "run the tests!", status: "completed" },
		{ text: "ship it", status: "pending" },
	]);
	assert.deepEqual(plan.steps, [step("Run the tests", "completed"), step("ship it", "in_progress")]);
	assert.equal(dropped, 0, "a duplicate is not an unusable item");
	assert.equal(merged, 1);
});

test("steps lost to the window are not counted as dropped", () => {
	const many = Array.from({ length: 30 }, (_, index) => `step ${index}`);
	const { plan, dropped, merged } = normalizePlan(many, { maxSteps: 8, maxTextLength: 100 });
	assert.equal(plan.steps.length, 8);
	assert.equal(dropped, 0);
	assert.equal(merged, 0);
});

test("normalizePlan reads a note under any of its usual keys", () => {
	assert.equal(normalizePlan({ steps: ["a"], note: "  first  pass " }).plan.note, "first pass");
	assert.equal(normalizePlan({ steps: ["a"], explanation: "why" }).plan.note, "why");
	assert.equal(normalizePlan(["a"]).plan.note, undefined);
});

test("normalizePlan ignores junk instead of throwing", () => {
	for (const junk of [undefined, null, 0, "", {}, [], { steps: null }, { steps: {} }, { steps: "   " }]) {
		const { plan } = normalizePlan(junk);
		assert.deepEqual(plan.steps, [], `expected no steps from ${JSON.stringify(junk)}`);
	}
});

test("normalizePlan elides long text and caps the step count", () => {
	const long = normalizePlan([{ text: "x".repeat(500), status: "pending" }], { maxSteps: 5, maxTextLength: 20 });
	assert.equal(long.plan.steps[0].text.length, 20);
	assert.ok(long.plan.steps[0].text.endsWith("…"));

	const many = normalizePlan(Array.from({ length: 50 }, (_, index) => `step ${index}`), { maxSteps: 8, maxTextLength: 100 });
	assert.equal(many.plan.steps.length, 8);
});

test("trimSteps keeps the step in progress inside the window", () => {
	const steps = [
		step("0", "completed"),
		step("1", "completed"),
		step("2", "completed"),
		step("3", "in_progress"),
		step("4", "pending"),
		step("5", "pending"),
		step("6", "pending"),
		step("7", "pending"),
	];
	const window = trimSteps(steps, 3);
	assert.deepEqual(window.map((entry) => entry.text), ["2", "3", "4"]);
	assert.equal(trimSteps(steps, 0).length, steps.length);
});

test("withCurrentStep does not demote a plan with nothing pending", () => {
	const steps = withCurrentStep([step("a", "completed"), step("b", "completed")]);
	assert.deepEqual(steps.map((entry) => entry.status), ["completed", "completed"]);
});

test("fingerprint ignores formatting and tracks content", () => {
	assert.equal(fingerprint({ steps: [step("a", "pending")] }), fingerprint({ steps: [step("a", "pending")] }));
	assert.notEqual(fingerprint({ steps: [step("a", "pending")] }), fingerprint({ steps: [step("a", "completed")] }));
	assert.notEqual(fingerprint({ steps: [step("a", "pending")] }), fingerprint({ steps: [step("a", "pending")], note: "n" }));
	assert.equal(fingerprint(undefined), "");
});

test("planProgress and planSummary describe the plan", () => {
	assert.deepEqual(planProgress(undefined), { done: 0, total: 0, current: -1, percent: 0 });
	assert.equal(planSummary(undefined), "no steps");
	assert.equal(planSummary({ steps: [] }), "no steps");

	const plan = { steps: [step("a", "completed"), step("b", "in_progress"), step("c", "pending"), step("d", "pending")] };
	assert.deepEqual(planProgress(plan), { done: 1, total: 4, current: 1, percent: 25 });
	assert.equal(planSummary(plan), "step 2 of 4");
});

test("planToText mirrors the panel and reports dropped items", () => {
	const text = planToText({ steps: [step("a", "completed"), step("b", "in_progress")] }, { dropped: 2, merged: 1 });
	assert.match(text, /Plan updated \(step 2 of 2\):/);
	assert.match(text, /1\. \[x\] a/);
	assert.match(text, /2\. \[>\] b/);
	assert.match(text, /Ignored 2 item/);
	assert.match(text, /Merged 1 repeated step/);
	assert.equal(planToText(undefined), "Plan cleared: no steps.");
});

test("planFromText reads another tool's plain-text plan", () => {
	const plan = planFromText(["Here is the plan:", "- [x] read config", "- [>] write the panel", "- [ ] ship it"].join("\n"));
	assert.deepEqual(plan?.steps, [step("read config", "completed"), step("write the panel", "in_progress"), step("ship it", "pending")]);
});

test("planFromText returns undefined when there is nothing plan-shaped", () => {
	assert.equal(planFromText("all good"), undefined);
	assert.equal(planFromText(""), undefined);
	assert.equal(planFromText("1. ok"), undefined);
});

test("the store notifies only when the plan really changes", () => {
	const store = createPlanStore();
	const seen = [];
	store.subscribe((plan) => seen.push(plan?.steps.length));

	assert.equal(store.set(undefined), false);
	assert.equal(store.set({ steps: [] }), false);
	assert.equal(store.set({ steps: [step("a", "in_progress")] }), true);
	assert.equal(store.set({ steps: [step("a", "in_progress")] }), false);
	assert.equal(store.set({ steps: [step("a", "completed")] }), true);
	assert.deepEqual(seen, [1, 1]);
});

test("the store drops an emptied plan so the panel can hide", () => {
	const store = createPlanStore({ steps: [step("a", "pending")] });
	assert.ok(store.get());
	store.set({ steps: [] });
	assert.equal(store.get(), undefined);
	assert.equal(store.fingerprint(), "");
});

test("unsubscribing stops notifications", () => {
	const store = createPlanStore();
	let count = 0;
	const off = store.subscribe(() => count++);
	store.set({ steps: [step("a", "pending")] });
	off();
	store.set({ steps: [step("a", "completed")] });
	assert.equal(count, 1);
});

test("the default limits are sane", () => {
	assert.ok(DEFAULT_LIMITS.maxSteps > 0);
	assert.ok(DEFAULT_LIMITS.maxTextLength > 10);
});
