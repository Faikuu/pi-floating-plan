/**
 * pi-floating-plan
 *
 * The plan the agent is working from, floating in a corner of the terminal.
 *
 * The extension owns the plan as data (`lib/plan.ts`), which three things
 * write to: the model, through the `update_plan` tool; the user, through
 * `/plan`; and any other extension's todo tool, if it is named in
 * `mirrorTools`. One panel reads it (`lib/panel.ts`) and redraws only when the
 * plan's fingerprint changes, so a model that rewrites the same plan every
 * turn costs nothing.
 *
 * Nothing in the pipeline is model-specific. A model that calls tools drives
 * the panel directly; a model that does not still gets one, because the same
 * normalization accepts checkbox markers, status synonyms and bare strings,
 * and the user can always drive it by hand.
 */

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ModelSelectEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { KeyId, TUI } from "@earendil-works/pi-tui";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { PlanPanel } from "./lib/panel.ts";
import { ANCHORS, configPatch, MAX_PADDING, parseConfig, type FloatingPlanConfig, type PlanAnchor } from "./lib/config.ts";
import { overlayOptions } from "./lib/position.ts";
import { normalizePlan, planFromText, planSummary, planToText, type Plan, type PlanStatus, type PlanStep } from "./lib/plan.ts";
import { createPlanStore, type PlanStore } from "./lib/plan-store.ts";
import { globalSettingsPath, readSettings, writeSettings } from "./lib/settings.ts";

const TOOL_NAME = "update_plan";

const StepSchema = Type.Object({
	text: Type.String({ description: "One short imperative step, e.g. \"Run the test suite\"" }),
	status: StringEnum(["pending", "in_progress", "completed"], {
		description: "pending = not started, in_progress = being worked on now, completed = finished",
	}),
});

const PlanParams = Type.Object({
	steps: Type.Array(StepSchema, {
		description: "The whole plan, in order. Send every step every time, not only the ones that changed.",
	}),
	note: Type.Optional(Type.String({ description: "One short line on why the plan changed, shown under the plan" })),
});

/**
 * Find the step a `/plan` argument names, by number (`3`, `#3`) or by the
 * start of its text, case-insensitively. A number out of range matches
 * nothing rather than falling through to a text search.
 */
function findStep(steps: PlanStep[], reference: string): PlanStep | undefined {
	const trimmed = reference.trim();
	if (trimmed === "") return undefined;
	const byNumber = /^#?(\d+)$/.exec(trimmed);
	if (byNumber) {
		const index = Number.parseInt(byNumber[1], 10);
		return index >= 1 && index <= steps.length ? steps[index - 1] : undefined;
	}
	const needle = trimmed.toLowerCase();
	return steps.find((step) => step.text.toLowerCase().startsWith(needle));
}

function describePlan(plan: Plan | undefined): string {
	if (!plan || plan.steps.length === 0) return "No plan yet.";
	const rows = plan.steps.map((step, index) => {
		const marker = step.status === "completed" ? "[x]" : step.status === "in_progress" ? "[>]" : "[ ]";
		return `  ${String(index + 1).padStart(2)}. ${marker} ${step.text}`;
	});
	return `${planSummary(plan)}\n${rows.join("\n")}`;
}

export default async function floatingPlan(pi: ExtensionAPI) {
	// The factory may await: the toggle shortcut has to be registered with the
	// key from settings, and a shortcut cannot be registered later.
	let config: FloatingPlanConfig = parseConfig(await readSettings(globalSettingsPath()));
	const store: PlanStore = createPlanStore();

	let ctx: ExtensionContext | undefined;
	let panel: PlanPanel | undefined;
	let tui: TUI | undefined;
	let closing: (() => void) | undefined;
	let overlayOpen = false;
	let openPromise: Promise<void> | undefined;
	let warnedAboutScrollback = false;
	let unsubscribe: (() => void) | undefined;

	function limits() {
		return { maxSteps: config.maxSteps, maxTextLength: config.maxTextLength };
	}

	/** The panel's current placement, in the terms the commands speak. */
	function describePosition(): string {
		const unit = config.padding === 1 ? "row/column" : "rows/columns";
		return `Panel anchored ${config.anchor}, ${config.padding} ${unit} from the edges it touches.`;
	}

	/** Store a plan and redraw only if it actually changed. */
	function apply(plan: Plan | undefined, notifyOnChange = false): boolean {
		const changed = store.set(plan);
		if (changed && notifyOnChange && ctx) {
			const current = store.get();
			ctx.ui.notify(current ? `Plan: ${planSummary(current)}` : "Plan cleared.", "info");
		}
		return changed;
	}

	function closeOverlay(): void {
		if (!overlayOpen) return;
		overlayOpen = false;
		// custom() owns the overlay lifetime: it removes it when done() is called.
		closing?.();
		closing = undefined;
		panel = undefined;
	}

	/**
	 * Persist a settings change, keeping it only if the file could be written.
	 *
	 * The in-memory config is updated first so the patch is written from the
	 * new value, and rolled back on failure so what is on screen always
	 * matches what is on disk.
	 */
	async function persistChanges(changes: Partial<FloatingPlanConfig>, context: ExtensionCommandContext): Promise<boolean> {
		const file = globalSettingsPath();
		const previous = config;
		const next = { ...config, ...changes };
		config = next;
		try {
			await withFileMutationQueue(file, async () => {
				await writeSettings(file, configPatch(next, changes));
			});
			return true;
		} catch (error) {
			config = previous;
			context.ui.notify(`Could not save to ${file}: ${error instanceof Error ? error.message : String(error)}`, "error");
			return false;
		}
	}

	/**
	 * Rebuild the overlay.
	 *
	 * pi reads an overlay's placement once, when it is shown, so an anchor or
	 * padding change cannot be applied to the overlay already on screen.
	 */
	async function reopenOverlay(): Promise<void> {
		const pending = openPromise;
		closeOverlay();
		// Wait for the teardown: opening again before custom() has settled is
		// refused as an overlay that is already open.
		await pending;
		syncOverlay();
	}

	/**
	 * In regular mode the terminal owns the scrollback, so scrolling carries
	 * the panel away with the transcript: nothing drawn into the output can
	 * stay put. Said once per session, because it is a setting, not a bug.
	 */
	function warnAboutScrollback(context: ExtensionContext): void {
		if (warnedAboutScrollback || tui?.mode !== "regular") return;
		warnedAboutScrollback = true;
		context.ui.notify(
			'Regular TUI mode: scrolling the terminal takes the panel with it. Set tuiMode to "fullscreen" in settings.json for a panel that stays put.',
			"info",
		);
	}

	async function openOverlay(context: ExtensionContext): Promise<void> {
		if (context.mode !== "tui" || overlayOpen || !store.get()) return;
		overlayOpen = true;
		openPromise = context.ui
			.custom<void>(
				(activeTui, theme, _keybindings, done) => {
					tui = activeTui;
					closing = () => {
						closing = undefined;
						done();
					};
					panel = new PlanPanel({
						store,
						theme,
						width: config.width,
						compactBelow: config.compactBelow,
						showBar: config.showBar,
						showNote: config.showNote,
						showModel: config.showModel,
						model: () => ctx?.model?.id,
					});
					return panel;
				},
				{
					overlay: true,
					// A function, because pi resolves these when the overlay is
					// shown: rebuilding the overlay is what re-reads them.
					overlayOptions: () => overlayOptions(config),
				},
			)
			.catch(() => {
				overlayOpen = false;
				panel = undefined;
			})
			.then(() => {
				// Reached when the overlay is closed for any reason, including a
				// mode switch that tears the TUI down underneath us.
				overlayOpen = false;
				panel = undefined;
				closing = undefined;
			});
		warnAboutScrollback(context);
		await openPromise;
	}

	/** Show or hide the panel to match the plan and the user's preference. */
	function syncOverlay(): void {
		if (!ctx || ctx.mode !== "tui") return;
		const has = store.get() !== undefined;
		if (has && config.visible) void openOverlay(ctx);
		else closeOverlay();
	}

	async function setVisible(visible: boolean, context: ExtensionCommandContext): Promise<void> {
		if (!(await persistChanges({ visible }, context))) return;
		syncOverlay();
		context.ui.notify(visible ? "Plan panel shown." : "Plan panel hidden.", "info");
	}

	/** The text parts of a tool result, for tools that answer in prose. */
	function contentText(content: readonly { type: string }[]): string {
		return content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}

	/**
	 * Rebuild the plan from the transcript.
	 *
	 * The last plan-shaped tool result on the current branch wins, so branching
	 * and reloading land on the plan that was actually in force there.
	 */
	function reconstruct(context: ExtensionContext): void {
		let plan: Plan | undefined;
		for (const entry of context.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role !== "toolResult") continue;
			const name = message.toolName;
			const mirrored = name !== TOOL_NAME && config.mirrorTools.includes(name);
			if (name !== TOOL_NAME && !mirrored) continue;

			// Details first: another tool's structured todos are the better
			// source. Its prose answer is the fallback.
			let candidate = normalizePlan(message.details, limits()).plan;
			if (candidate.steps.length === 0 && mirrored) {
				candidate = planFromText(contentText(message.content), limits()) ?? candidate;
			}
			if (candidate.steps.length > 0) plan = candidate;
		}
		store.set(plan);
	}

	// The one redraw path: a plan change, and nothing else.
	unsubscribe = store.subscribe(() => {
		panel?.invalidate();
		tui?.requestRender();
		syncOverlay();
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Plan",
		description:
			"Publish the plan you are working from so the user can see it. Send the complete plan every time, in order, each step with a status of pending, in_progress, or completed. Keep exactly one step in_progress while work remains.",
		promptSnippet: "update_plan: publish the current plan (steps + status) so the user can see progress",
		parameters: PlanParams,

		/**
		 * Compatibility shim for whatever the model actually emitted.
		 *
		 * Models routinely send `{ todos: [...] }`, plain strings, or a status
		 * spelled "done". Folding that into the schema's own shape here means
		 * one tolerant path instead of a schema failure per odd model.
		 */
		prepareArguments(args: unknown): Static<typeof PlanParams> {
			const { plan, dropped } = normalizePlan(args, limits());
			// The note is the one thing normalization cannot recover, so a dropped
			// item is reported back to the model instead of vanishing.
			const note = plan.note ?? (dropped > 0 ? `Ignored ${dropped} unusable item(s); send steps as { text, status }.` : undefined);
			return {
				steps: plan.steps.map((step) => ({ text: step.text, status: step.status })),
				...(note ? { note } : {}),
			};
		},

		async execute(_toolCallId, params) {
			const { plan, dropped, merged } = normalizePlan(params, limits());
			apply(plan);
			return {
				content: [{ type: "text", text: planToText(store.get(), { dropped, merged }) }],
				details: { steps: plan.steps, note: plan.note },
			};
		},
	});

	pi.registerCommand("plan", {
		description: "Toggle the floating plan panel, or edit the plan by hand",
		handler: async (args, commandCtx) => {
			ctx = commandCtx;
			const [verb = "", ...rest] = args.trim().split(/\s+/);
			const argument = rest.join(" ").replace(/^["']|["']$/g, "").trim();
			const command = verb.toLowerCase();

			switch (command) {
				case "":
				case "toggle":
					await setVisible(!config.visible, commandCtx);
					return;

				case "show":
					await setVisible(true, commandCtx);
					return;

				case "hide":
					await setVisible(false, commandCtx);
					return;

				case "list":
					commandCtx.ui.notify(describePlan(store.get()), "info");
					return;

				case "clear":
					if (!store.get()) {
						commandCtx.ui.notify("No plan to clear.", "info");
						return;
					}
					apply(undefined);
					commandCtx.ui.notify("Plan cleared.", "info");
					return;

				case "add": {
					if (argument === "") {
						commandCtx.ui.notify("Usage: /plan add <step>", "warning");
						return;
					}
					const current = store.get();
					const steps = [...(current?.steps ?? []), { text: argument, status: "pending" as PlanStatus }];
					apply(normalizePlan({ steps }, limits()).plan, true);
					return;
				}

				case "note": {
					const current = store.get();
					if (!current) {
						commandCtx.ui.notify("No plan to annotate. Run /plan add <step> first.", "warning");
						return;
					}
					apply({ ...current, note: argument === "" ? undefined : argument }, true);
					return;
				}

				case "start":
				case "done":
				case "block": {
					const current = store.get();
					if (!current) {
						commandCtx.ui.notify("No plan to change. Run /plan add <step> first.", "warning");
						return;
					}
					const step = argument === "" ? current.steps[current.steps.length - 1] : findStep(current.steps, argument);
					if (!step) {
						commandCtx.ui.notify(`No step matches "${argument}". Try /plan list.`, "warning");
						return;
					}
					const status: PlanStatus = command === "done" ? "completed" : command === "block" ? "pending" : "in_progress";
					const steps = current.steps.map((entry) => (entry === step ? { ...entry, status } : entry));
					apply(normalizePlan({ steps, note: current.note }, limits()).plan, true);
					return;
				}

				case "anchor": {
					// Checked here rather than at render time: the overlay would
					// silently fall back to a default position instead of failing.
					if (!(ANCHORS as readonly string[]).includes(argument.toLowerCase())) {
						commandCtx.ui.notify(`Unknown corner "${argument}". Try one of: ${ANCHORS.join(", ")}.`, "warning");
						return;
					}
					const anchor = argument.toLowerCase() as PlanAnchor;
					if (!(await persistChanges({ anchor }, commandCtx))) return;
					await reopenOverlay();
					commandCtx.ui.notify(`Panel anchored ${anchor}.`, "info");
					return;
				}

				case "padding": {
					if (argument === "") {
						commandCtx.ui.notify(describePosition(), "info");
						return;
					}
					// Whole rows and columns only: anything else would be silently
					// rounded by the terminal layout.
					if (!/^\d{1,3}$/.test(argument) || Number.parseInt(argument, 10) > MAX_PADDING) {
						commandCtx.ui.notify(`"${argument}" is not a padding. Use a whole number of rows and columns, 0 to ${MAX_PADDING}.`, "warning");
						return;
					}
					const padding = Number.parseInt(argument, 10);
					if (padding === config.padding) {
						commandCtx.ui.notify(describePosition(), "info");
						return;
					}
					if (!(await persistChanges({ padding }, commandCtx))) return;
					await reopenOverlay();
					commandCtx.ui.notify(`Panel padding ${padding}.`, "info");
					return;
				}

				case "help":
				default:
					commandCtx.ui.notify(
						[
							"/plan                 toggle the panel",
							"/plan show|hide       show or hide the panel (persisted)",
							"/plan list            print the plan",
							"/plan add <step>      append a step",
							"/plan start [step]    mark a step in progress",
							"/plan done [step]     mark a step completed",
							"/plan block [step]    send a step back to pending",
							"/plan note <text>     annotate the plan",
							"/plan clear           drop the plan",
							`/plan anchor <corner> float in top-center (default), bottom-right, …`,
							"/plan padding <n>    keep n rows/columns from the nearest edges",
						].join("\n"),
						"info",
					);
					return;
			}
		},
	});

	pi.registerShortcut(config.toggleKey as unknown as KeyId, {
		description: "Toggle the floating plan panel",
		handler: (shortcutCtx) => {
			ctx = shortcutCtx;
			// There is no panel outside the TUI; syncOverlay is a no-op there.
			if (shortcutCtx.mode !== "tui") return;
			// The shortcut is a view toggle, not a setting change: it lasts for
			// this session, so a stray keypress cannot rewrite settings.json.
			config = { ...config, visible: !config.visible };
			syncOverlay();
		},
	});

	pi.on("session_start", async (_event, sessionCtx) => {
		ctx = sessionCtx;
		config = parseConfig(await readSettings(globalSettingsPath()));
		overlayOpen = false;
		reconstruct(sessionCtx);
		syncOverlay();
	});

	pi.on("session_tree", async (_event, sessionCtx) => {
		ctx = sessionCtx;
		reconstruct(sessionCtx);
	});

	pi.on("model_select", (event: ModelSelectEvent) => {
		// Only the title changes, and only when the model is on screen.
		if (!config.showModel || event.model?.id === event.previousModel?.id) return;
		panel?.invalidate();
		tui?.requestRender();
	});

	pi.on("tool_result", (event: ToolResultEvent) => {
		if (event.toolName === TOOL_NAME || !config.mirrorTools.includes(event.toolName)) return;
		// Only custom tools carry `details`; the built-in ones are not plans.
		if (!("details" in event)) return;
		// Another extension's todo tool is plan-shaped; adopt it when it parses.
		const fromDetails = event.details !== undefined ? normalizePlan(event.details, limits()).plan : undefined;
		const plan =
			fromDetails && fromDetails.steps.length > 0
				? fromDetails
				: planFromText(
						event.content
							.filter((part): part is { type: "text"; text: string } => part.type === "text")
							.map((part) => part.text)
							.join("\n"),
						limits(),
					);
		if (plan) apply(plan);
	});

	pi.on("session_shutdown", () => {
		unsubscribe?.();
		unsubscribe = undefined;
		closeOverlay();
		store.set(undefined);
		ctx = undefined;
		tui = undefined;
	});
}
