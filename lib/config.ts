/**
 * Extension configuration, read from the global `settings.json` under the
 * `floatingPlan` key. Every field is optional; the defaults suit normal use.
 */

import type { PlanLimits } from "./plan.ts";

/**
 * Corners the panel may float in.
 *
 * `top-center` is the default because the editor owns the bottom of the
 * screen: a panel anchored there would sit on top of the input box.
 */
export const ANCHORS = [
	"top-center",
	"bottom-center",
	"top-left",
	"top-right",
	"bottom-left",
	"bottom-right",
	"left-center",
	"right-center",
] as const;

export type PlanAnchor = (typeof ANCHORS)[number];

/**
 * Largest padding worth accepting. Past a screen or two the panel has nowhere
 * left to float, and pi clamps the rest away anyway.
 */
export const MAX_PADDING = 20;

export interface FloatingPlanConfig extends PlanLimits {
	/** Show the panel as soon as a session has a plan. */
	visible: boolean;
	/**
	 * Where the panel floats. The default keeps it clear of the editor, which
	 * pi draws along the bottom of the screen.
	 */
	anchor: PlanAnchor;
	/**
	 * Rows and columns the panel keeps between itself and the terminal edges
	 * its anchor touches: top and left for `top-left`, and so on.
	 */
	padding: number;
	/** Preferred frame width in columns. */
	width: number;
	/** Draw the completion bar. */
	showBar: boolean;
	/** Draw the note a model attaches to a plan change. */
	showNote: boolean;
	/** Put the active model in the panel title. */
	showModel: boolean;
	/** Columns below which the frame is dropped for a compact block. */
	compactBelow: number;
	/** Key that toggles the panel, registered with pi as a shortcut. */
	toggleKey: string;
	/**
	 * Other tools whose plan-shaped output is mirrored into the panel.
	 *
	 * The panel is useful even when the model plans through somebody else's
	 * todo tool, and naming those tools is the only thing model-dependent here.
	 */
	mirrorTools: string[];
}

export const DEFAULT_CONFIG: FloatingPlanConfig = {
	visible: true,
	anchor: "top-center",
	padding: 2,
	width: 38,
	maxSteps: 24,
	maxTextLength: 140,
	showBar: true,
	showNote: true,
	showModel: false,
	compactBelow: 34,
	toggleKey: "alt+o",
	mirrorTools: ["todo", "todos", "todo_write", "update_todo_list", "update_plan", "plan", "set_plan"],
};

function positiveInt(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER, min = 1): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < min) return fallback;
	return Math.min(Math.floor(value), max);
}

function boolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function anchor(value: unknown, fallback: PlanAnchor): PlanAnchor {
	return typeof value === "string" && (ANCHORS as readonly string[]).includes(value) ? (value as PlanAnchor) : fallback;
}

function keys(value: unknown, fallback: string[]): string[] {
	if (typeof value === "string") return value.trim() === "" ? fallback : [value.trim()];
	if (!Array.isArray(value)) return fallback;
	const cleaned = value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
	return cleaned.length > 0 ? cleaned : fallback;
}

/** Parse the `floatingPlan` block, ignoring anything of the wrong type. */
export function parseConfig(settings: Record<string, unknown>): FloatingPlanConfig {
	const raw = settings.floatingPlan;
	const block = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	return {
		visible: boolean(block.visible, DEFAULT_CONFIG.visible),
		anchor: anchor(block.anchor, DEFAULT_CONFIG.anchor),
		padding: positiveInt(block.padding, DEFAULT_CONFIG.padding, MAX_PADDING, 0),
		width: positiveInt(block.width, DEFAULT_CONFIG.width, 120, 16),
		maxSteps: positiveInt(block.maxSteps, DEFAULT_CONFIG.maxSteps, 100),
		maxTextLength: positiveInt(block.maxTextLength, DEFAULT_CONFIG.maxTextLength, 500, 20),
		showBar: boolean(block.showBar, DEFAULT_CONFIG.showBar),
		showNote: boolean(block.showNote, DEFAULT_CONFIG.showNote),
		showModel: boolean(block.showModel, DEFAULT_CONFIG.showModel),
		compactBelow: positiveInt(block.compactBelow, DEFAULT_CONFIG.compactBelow, 200, 16),
		toggleKey: typeof block.toggleKey === "string" && block.toggleKey.trim() !== "" ? block.toggleKey.trim() : DEFAULT_CONFIG.toggleKey,
		mirrorTools: keys(block.mirrorTools, DEFAULT_CONFIG.mirrorTools),
	};
}

/** Serialize the user-facing subset back into a settings patch. */
export function configPatch(config: FloatingPlanConfig, changes: Partial<FloatingPlanConfig>): Record<string, unknown> {
	const next = { ...config, ...changes };
	return { floatingPlan: { visible: next.visible, anchor: next.anchor, padding: next.padding, toggleKey: next.toggleKey } };
}
