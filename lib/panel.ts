/**
 * The floating plan panel.
 *
 * A plain `Component` shown through a non-capturing overlay, so it floats over
 * the conversation and the editor keeps every keystroke. It renders nothing at
 * all when there is no plan, which is also how the extension knows to hide the
 * overlay.
 *
 * Width is treated as the truth: every line is built for the width it is
 * handed, measured in terminal columns rather than string length, and
 * truncated to fit so a long step or a narrow terminal can never smear the
 * frame.
 */

import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { fingerprint, planProgress, planSummary, type Plan } from "./plan.ts";
import type { PlanStore } from "./plan-store.ts";

export interface PlanPanelOptions {
	store: PlanStore;
	theme: Theme;
	/** Preferred frame width; clamped to what the terminal actually offers. */
	width?: number;
	/** Below this many columns the frame is dropped for a compact block. */
	compactBelow?: number;
	/** Draw the completion bar under the title. */
	showBar?: boolean;
	/** Draw the model's note line, when the plan carries one. */
	showNote?: boolean;
	/** Draw the active model in the title. */
	showModel?: boolean;
	/** Read lazily so a model switch redraws without a new panel. */
	model?: () => string | undefined;
}

const MIN_WIDTH = 16;
const DEFAULT_WIDTH = 38;
const DEFAULT_COMPACT_BELOW = 34;

export class PlanPanel implements Component {
	private readonly options: Required<Omit<PlanPanelOptions, "model">> & Pick<PlanPanelOptions, "model">;
	private cachedWidth?: number;
	private cachedFingerprint?: string;
	private cachedLines?: string[];

	constructor(options: PlanPanelOptions) {
		this.options = {
			store: options.store,
			theme: options.theme,
			width: options.width ?? DEFAULT_WIDTH,
			compactBelow: options.compactBelow ?? DEFAULT_COMPACT_BELOW,
			showBar: options.showBar ?? true,
			showNote: options.showNote ?? true,
			showModel: options.showModel ?? false,
			model: options.model,
		};
	}

	render(width: number): string[] {
		const plan = this.options.store.get();
		if (!plan || plan.steps.length === 0) return [];

		const planFingerprint = fingerprint(plan);
		if (this.cachedLines && this.cachedWidth === width && this.cachedFingerprint === planFingerprint) {
			return this.cachedLines;
		}

		const lines = width < this.options.compactBelow ? this.renderCompact(plan, width) : this.renderFramed(plan, width);
		this.cachedWidth = width;
		this.cachedFingerprint = planFingerprint;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedFingerprint = undefined;
		this.cachedLines = undefined;
	}

	/** The plan is read, never captured: the overlay is non-capturing. */
	handleInput(): boolean {
		return false;
	}

	private modelLabel(): string | undefined {
		const id = this.options.model?.();
		return typeof id === "string" && id.trim() !== "" ? id.trim() : undefined;
	}

	/**
	 * Framed panel for a normal terminal. `inner` is the space between the
	 * frame's vertical bars, so every line is padded to exactly that.
	 */
	private renderFramed(plan: Plan, width: number): string[] {
		const theme = this.options.theme;
		const frameWidth = Math.max(MIN_WIDTH, Math.min(this.options.width, width));
		const inner = frameWidth - 4;
		const progress = planProgress(plan);
		const lines: string[] = [this.topLine(this.title(), planSummary(plan), frameWidth)];

		if (this.options.showBar) {
			const filled = Math.round((progress.percent / 100) * inner);
			const bar = theme.fg("accent", "▓".repeat(filled)) + theme.fg("borderMuted", "░".repeat(Math.max(0, inner - filled)));
			lines.push(this.row(bar, frameWidth));
		}

		for (const step of plan.steps) {
			lines.push(this.row(this.stepLine(step.status, step.text, inner), frameWidth));
		}

		if (this.options.showNote && plan.note) {
			lines.push(this.row(theme.fg("dim", truncateToWidth(plan.note, inner)), frameWidth));
		}

		lines.push(this.bottomLine(`${progress.done} of ${progress.total} done`, frameWidth));
		return lines;
	}

	/** Borderless fallback: the active step and a count, nothing else. */
	private renderCompact(plan: Plan, width: number): string[] {
		const theme = this.options.theme;
		const progress = planProgress(plan);
		const current = progress.current === -1 ? undefined : plan.steps[progress.current];
		const lines: string[] = [
			truncateToWidth(
				`${theme.fg("accent", theme.bold("PLAN"))} ${theme.fg("muted", planSummary(plan))}`,
				width,
			),
		];
		if (current) {
			lines.push(truncateToWidth(`${theme.fg("accent", "▸")} ${theme.fg("text", current.text)}`, width));
		}
		const remaining = progress.total - progress.done - (progress.current === -1 ? 0 : 1);
		if (remaining > 0) lines.push(truncateToWidth(theme.fg("dim", `  +${remaining} more`), width));
		return lines;	}

	private title(): string {
		const model = this.options.showModel ? this.modelLabel() : undefined;
		return model ? `PLAN · ${model}` : "PLAN";
	}

	private stepLine(status: Plan["steps"][number]["status"], text: string, inner: number): string {
		const theme = this.options.theme;
		const label = truncateToWidth(text, Math.max(1, inner - 2));
		if (status === "completed") return `${theme.fg("success", "✔")} ${theme.fg("dim", label)}`;
		if (status === "in_progress") return `${theme.fg("accent", theme.bold("▸"))} ${theme.fg("text", theme.bold(label))}`;
		return `${theme.fg("borderMuted", "○")} ${theme.fg("muted", label)}`;
	}

	/**
	 * The title bar: title on the left, progress on the right, fill between.
	 *
	 * A long model name in the title can eat the whole frame, so the summary
	 * goes first and the title is clipped only as a last resort.
	 */
	private topLine(title: string, summary: string, frameWidth: number): string {
		const theme = this.options.theme;
		const head = ` ${title} `;
		const tail = summary === "" ? "" : `─ ${summary} `;
		// The frame's own characters: "╭─", the fill, and "╮".
		const available = Math.max(0, frameWidth - 3);
		const headWidth = visibleWidth(head);
		const tailWidth = visibleWidth(tail);

		if (headWidth + tailWidth <= available) {
			const line = theme.fg("borderMuted", "╭─") + theme.fg("accent", head) + theme.fg("muted", tail) + theme.fg("borderMuted", "─".repeat(available - headWidth - tailWidth)) + "╮";
			return this.fit(line, frameWidth);
		}
		if (headWidth <= available) {
			const line = theme.fg("borderMuted", "╭─") + theme.fg("accent", head) + theme.fg("borderMuted", "─".repeat(available - headWidth)) + "╮";
			return this.fit(line, frameWidth);
		}
		const line = theme.fg("borderMuted", "╭─") + truncateToWidth(theme.fg("accent", head), Math.max(0, available - 1)) + theme.fg("borderMuted", "─") + "╮";
		return this.fit(line, frameWidth);
	}

	/** The bottom bar, carrying the completion count. */
	private bottomLine(text: string, frameWidth: number): string {
		const label = ` ${text} `;
		const fill = "─".repeat(Math.max(0, frameWidth - 3 - visibleWidth(label)));
		return this.fit(this.options.theme.fg("borderMuted", `╰─${label}${fill}╯`), frameWidth);
	}

	/** `│ content │`, padded to the frame width. */
	private row(content: string, frameWidth: number): string {
		const theme = this.options.theme;
		const bar = theme.fg("borderMuted", "│");
		const inner = Math.max(0, frameWidth - 4);
		return this.fit(`${bar} ${truncateToWidth(content, inner)}${" ".repeat(Math.max(0, inner - visibleWidth(content)))} ${bar}`, frameWidth);
	}

	/** Last line of defence: no line may exceed the width it was given. */
	private fit(line: string, frameWidth: number): string {
		return visibleWidth(line) <= frameWidth ? line : truncateToWidth(line, frameWidth);
	}
}
