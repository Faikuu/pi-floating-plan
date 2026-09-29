/**
 * The plan model.
 *
 * Models disagree about how a plan is written, so nothing here trusts the
 * shape it is handed: a bare array, `{ steps: [...] }`, `{ todos: [...] }`,
 * strings, checkbox markers, `done: true`, or a status spelled four different
 * ways all fold into one list of steps in three states. That tolerance is the
 * whole point — the panel has to show the same thing whichever model is
 * driving, and whichever plan convention that model was trained on.
 *
 * A plan's `fingerprint` is what the overlay watches, so the panel redraws
 * only when the plan really changed and never on a stream of identical
 * updates from a chatty model.
 */

export type PlanStatus = "pending" | "in_progress" | "completed";

export interface PlanStep {
	/** One imperative line, already trimmed of markers and numbering. */
	text: string;
	status: PlanStatus;
}

export interface Plan {
	steps: PlanStep[];
	/** Optional one-line explanation of the latest change, shown under the plan. */
	note?: string;
}

export interface PlanLimits {
	/** Steps kept in the panel; the window slides to keep the active step. */
	maxSteps: number;
	/** Characters kept per step before it is elided. */
	maxTextLength: number;
}

export const DEFAULT_LIMITS: PlanLimits = { maxSteps: 24, maxTextLength: 140 };

/** How many steps a plan may carry before the panel starts trimming. */
export const MAX_PLAN_STEPS = 200;

const STATUS_RANK: Record<PlanStatus, number> = { pending: 0, in_progress: 1, completed: 2 };

const COMPLETED_WORDS = new Set([
	"done", "complete", "completed", "finished", "finish", "ok", "okay", "success", "succeeded", "passed", "resolved", "shipped", "x",
]);
const IN_PROGRESS_WORDS = new Set([
	"in_progress", "inprogress", "in-progress", "in flight", "inflight", "doing", "active", "working", "workingon", "current", "now",
	"started", "starting", "running", "progress", "wip", "next up", ">",
]);
const PENDING_WORDS = new Set([
	"pending", "todo", "to_do", "to-do", "open", "next", "planned", "plan", "queued", "not_started", "notstarted", "not-started", "new",
	"wait", "waiting", "waiting_for", "skipped", "blocked", "failed", "later", "o",
]);

/** Marker glyphs that carry the status inside the text itself. */
const MARKER_STATUS: Record<string, PlanStatus> = {
	"[x]": "completed",
	"[✓]": "completed",
	"[✔]": "completed",
	"(x)": "completed",
	"✅": "completed",
	"✔": "completed",
	"✓": "completed",
	"x": "completed",
	"[~]": "in_progress",
	"[>]": "in_progress",
	"(~)": "in_progress",
	"▶": "in_progress",
	"▸": "in_progress",
	"⏳": "in_progress",
	"»": "in_progress",
	"[ ]": "pending",
	"[.]": "pending",
	"○": "pending",
	"🔲": "pending",
	"◻": "pending",
	"□": "pending",
};

/** Leading decoration that carries no meaning: bullets, numbering, quotes. */
const DECORATION = /^\s*(?:[-*•·–—>]+|\d+[.)]|[a-z][.)]|#{1,6})\s+/i;

/** Keys a model might use for the list of steps. */
const LIST_KEYS = ["steps", "plan", "todos", "todo", "items", "entries", "tasks", "checklist", "outline"];
/** Keys a model might use for a single step's text. */
const TEXT_KEYS = ["text", "step", "title", "task", "content", "description", "name", "label", "summary", "detail"];
/** Keys a model might use for a step's status. */
const STATUS_KEYS = ["status", "state", "progress", "stage", "done", "completed", "complete", "finished", "in_progress", "inprogress", "active", "checked", "isDone"];

function textOf(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function elide(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** Fold any spelling of a status into one of the three states, or undefined. */
export function normalizeStatus(value: unknown): PlanStatus | undefined {
	if (typeof value === "boolean") return value ? "completed" : "pending";
	if (typeof value === "number") {
		if (value === 0) return "pending";
		if (value === 1) return "in_progress";
		if (value >= 2) return "completed";
		return undefined;
	}
	if (typeof value !== "string") return undefined;
	const cleaned = textOf(value)
		.toLowerCase()
		.replace(/[.!]+$/, "");
	if (cleaned === "") return undefined;
	if (MARKER_STATUS[cleaned]) return MARKER_STATUS[cleaned];
	if (COMPLETED_WORDS.has(cleaned)) return "completed";
	if (IN_PROGRESS_WORDS.has(cleaned)) return "in_progress";
	if (PENDING_WORDS.has(cleaned)) return "pending";
	return undefined;
}

/**
 * Split a raw line into its marker and its text.
 *
 * "[x] run the tests" and "2. run the tests" are the same step, so the marker
 * is peeled off here rather than shown to the user.
 */
export function stripMarker(raw: string): { text: string; status?: PlanStatus } {
	let rest = textOf(raw);
	let status: PlanStatus | undefined;

	// Two passes, because markers stack: "- [x] run the tests" is a bullet
	// wrapped around a checkbox. The first marker found sets the status; a
	// later one cannot contradict it.
	for (let pass = 0; pass < 2; pass++) {
		const bracket = /^[[(]([^\])])[\])]\s*/.exec(rest);
		if (bracket) {
			// "[ ]" is the canonical pending box, and its inner character is blank.
			status = status ?? (normalizeStatus(bracket[1]) ?? "pending");
			rest = rest.slice(bracket[0].length);
			continue;
		}
		// A bare glyph at the front ("✓ do it", "▸ do it") is a status too.
		const glyph = /^([✓✔✅▶▸⏳○◻□])\s*/.exec(rest);
		if (glyph) {
			status = status ?? normalizeStatus(glyph[1]);
			rest = rest.slice(glyph[0].length);
			continue;
		}
		const decoration = DECORATION.exec(rest);
		if (!decoration) break;
		rest = rest.slice(decoration[0].length);
	}

	return { text: rest.trim(), status };
}

/** Pull `{ text, status }` out of one array element, however it is spelled. */
function readStep(raw: unknown): { text: string; status?: PlanStatus } | undefined {
	if (typeof raw === "string") {
		const { text, status } = stripMarker(raw);
		return text === "" ? undefined : { text, status };
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const record = raw as Record<string, unknown>;

	for (const key of TEXT_KEYS) {
		const value = record[key];
		if (typeof value === "string" && value.trim() !== "") {
			const { text, status: fromText } = stripMarker(value);
			if (text === "") continue;
			return { text, status: readStatus(record) ?? fromText };
		}
	}

	// `{ done: true, description: "…" }` puts the text somewhere unexpected;
	// fall back to the longest string value that is not a status.
	let best: string | undefined;
	for (const [key, value] of Object.entries(record)) {
		if (typeof value !== "string" || STATUS_KEYS.includes(key)) continue;
		if (normalizeStatus(value) !== undefined) continue;
		if (best === undefined || value.length > best.length) best = value;
	}
	if (best === undefined) return undefined;
	const { text, status: fromText } = stripMarker(best);
	return text === "" ? undefined : { text, status: readStatus(record) ?? fromText };
}

/** Status keys whose `true` means "in progress" rather than "completed". */
const ACTIVE_KEYS = new Set(["active", "in_progress", "inprogress", "working", "current"]);

/** The first status any of the known status keys carries. */
function readStatus(record: Record<string, unknown>): PlanStatus | undefined {
	for (const key of STATUS_KEYS) {
		if (!(key in record)) continue;
		const value = record[key];
		// `active: true` and `done: true` are both booleans and mean opposite
		// things, so the key decides.
		if (typeof value === "boolean" && ACTIVE_KEYS.has(key)) return value ? "in_progress" : "pending";
		const status = normalizeStatus(value);
		if (status !== undefined) return status;
	}
	return undefined;
}

/** Collect candidate step elements from any container a model might send. */
function collect(raw: unknown, depth = 0): unknown[] {
	if (raw === undefined || depth > 4) return [];
	if (Array.isArray(raw)) {
		// Elements are returned as they came, unusable ones included, so the
		// caller can count what it had to throw away.
		const items: unknown[] = [];
		for (const item of raw) {
			if (Array.isArray(item)) items.push(...collect(item, depth + 1));
			else items.push(item);
		}
		return items;
	}
	// A multi-line string is a list of steps, not one very long step.
	if (typeof raw === "string") return raw.split("\n").map((line) => line.trim()).filter((line) => line !== "");
	if (raw === null || typeof raw !== "object") return [raw];
	const record = raw as Record<string, unknown>;
	for (const key of LIST_KEYS) {
		if (key in record) {
			const found = collect(record[key], depth + 1);
			if (found.length > 0) return found;
		}
	}
	// A bare `{ text, status }` object is a one-step plan.
	return readStep(record) ? [record] : [];
}

/** Collapse repeated steps, letting the furthest-progressed status win. */
function dedupe(steps: PlanStep[]): { steps: PlanStep[]; merged: number } {
	const byText = new Map<string, PlanStep>();
	const order: string[] = [];
	let merged = 0;
	for (const step of steps) {
		const key = step.text.toLowerCase().replace(/[^\p{L}\p{N}]+$/u, "");
		const existing = byText.get(key);
		if (!existing) {
			byText.set(key, { ...step });
			order.push(key);
			continue;
		}
		merged++;
		if (STATUS_RANK[step.status] > STATUS_RANK[existing.status]) existing.status = step.status;
	}
	return { steps: order.map((key) => byText.get(key)!), merged };
}

/**
 * Slide the visible window over the plan so the step in progress stays on
 * screen even when the model keeps a long tail of later steps.
 */
export function trimSteps(steps: PlanStep[], maxSteps: number): PlanStep[] {
	if (maxSteps <= 0 || steps.length <= maxSteps) return steps;
	const active = steps.findIndex((step) => step.status === "in_progress");
	const anchor = active === -1 ? 0 : active;
	const start = Math.min(Math.max(0, anchor - Math.floor(maxSteps / 2)), steps.length - maxSteps);
	return steps.slice(start, start + maxSteps);
}

/**
 * Exactly one step is in progress, and there is one whenever work remains.
 *
 * Models routinely mark two steps active, or none at all; the panel shows a
 * single "current" step, so the ambiguity is resolved here instead of in the
 * renderer.
 */
export function withCurrentStep(steps: PlanStep[]): PlanStep[] {
	const result = steps.map((step) => ({ ...step }));
	const activeIndexes = result.map((step, index) => (step.status === "in_progress" ? index : -1)).filter((index) => index !== -1);
	for (const index of activeIndexes.slice(1)) result[index].status = "pending";
	if (activeIndexes.length === 0) {
		const next = result.findIndex((step) => step.status === "pending");
		if (next !== -1) result[next].status = "in_progress";
	}
	return result;
}

export interface NormalizeResult {
	plan: Plan;
	/** Items that were present but not usable as steps, for a quiet warning. */
	dropped: number;
	/** Steps folded into an identical earlier one. */
	merged: number;
}

/**
 * Turn whatever the model sent into a plan.
 *
 * `limits.maxSteps` also caps the input, so a runaway model cannot make the
 * extension walk a million-element array.
 */
export function normalizePlan(raw: unknown, limits: PlanLimits = DEFAULT_LIMITS): NormalizeResult {
	const collected = collect(raw).slice(0, Math.max(1, Math.min(MAX_PLAN_STEPS, limits.maxSteps * 4)));
	const parsed: PlanStep[] = [];
	let dropped = 0;
	for (const item of collected) {
		const step = readStep(item);
		if (!step) {
			dropped++;
			continue;
		}
		parsed.push({ text: elide(step.text, limits.maxTextLength), status: step.status ?? "pending" });
	}
	const deduped = dedupe(parsed);
	const steps = trimSteps(withCurrentStep(deduped.steps), limits.maxSteps);
	// Steps lost to the window are not dropped: the plan is longer than the
	// panel, which is a normal thing for a plan to be.
	return { plan: { steps, note: readNote(raw) }, dropped, merged: deduped.merged };
}

function readNote(raw: unknown): string | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const record = raw as Record<string, unknown>;
	for (const key of ["note", "comment", "explanation", "reason", "summary"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim() !== "") return elide(textOf(value), 120);
	}
	return undefined;
}

/**
 * A stable description of the plan's content.
 *
 * Two plans with the same fingerprint render identically, which is what lets
 * the overlay skip a redraw when a model repeats itself.
 */
export function fingerprint(plan: Plan | undefined): string {
	if (!plan) return "";
	return `${plan.steps.map((step) => `${step.status}:${step.text}`).join("\u0001")}|${plan.note ?? ""}`;
}

export interface PlanProgress {
	done: number;
	total: number;
	/** Zero-based index of the step in progress, or -1 when none is. */
	current: number;
	/** Zero-based index one past the last step. */
	percent: number;
}

/** Read progress off a plan without assuming a current step exists. */
export function planProgress(plan: Plan | undefined): PlanProgress {
	const steps = plan?.steps ?? [];
	const done = steps.filter((step) => step.status === "completed").length;
	const current = steps.findIndex((step) => step.status === "in_progress");
	return {
		done,
		total: steps.length,
		current,
		percent: steps.length === 0 ? 0 : Math.round((done / steps.length) * 100),
	};
}

/** A short status phrase: "step 2 of 4", "4 of 4 done", "no steps". */
export function planSummary(plan: Plan | undefined): string {
	const { done, total, current } = planProgress(plan);
	if (total === 0) return "no steps";
	if (current === -1) return done === total ? `${total} of ${total} done` : `${done} of ${total} done`;
	return `step ${current + 1} of ${total}`;
}

/** The text the model sees back from the tool, mirroring the panel. */
export function planToText(plan: Plan | undefined, options: { dropped?: number; merged?: number } = {}): string {
	const steps = plan?.steps ?? [];
	if (steps.length === 0) return "Plan cleared: no steps.";
	const lines = [`Plan updated (${planSummary(plan)}):`];
	steps.forEach((step, index) => {
		const marker = step.status === "completed" ? "[x]" : step.status === "in_progress" ? "[>]" : "[ ]";
		lines.push(`${index + 1}. ${marker} ${step.text}`);
	});
	if (plan?.note) lines.push(`Note: ${plan.note}`);
	if (options.dropped && options.dropped > 0) {
		lines.push(`Ignored ${options.dropped} item(s) that were not usable steps; send every step as { text, status }.`);
	}
	if (options.merged && options.merged > 0) {
		lines.push(`Merged ${options.merged} repeated step(s) into one.`);
	}
	return lines.join("\n");
}

/**
 * Parse a plan out of plain text, for mirroring another tool's output.
 *
 * Another extension's todo tool answers with lines like "- [x] read config";
 * those are plan-shaped even though no schema said so.
 */
export function planFromText(text: string, limits: PlanLimits = DEFAULT_LIMITS): Plan | undefined {
	const steps: PlanStep[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		// Prose is not a step. A line counts only when it carries a status box,
		// a status glyph, or a bullet, so a tool's "Here is the plan:" preamble
		// and an ordinary numbered sentence are both left alone.
		if (!/^(?:[[(][^\])][\])]|[✓✔✅▶▸⏳○◻□]|[-*•])\s*/.test(trimmed)) continue;
		const step = readStep(trimmed);
		if (!step) continue;
		steps.push({ text: elide(step.text, limits.maxTextLength), status: step.status ?? "pending" });
	}
	if (steps.length === 0) return undefined;
	const deduped = dedupe(steps);
	return { steps: trimSteps(withCurrentStep(deduped.steps), limits.maxSteps) };
}
