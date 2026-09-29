/**
 * The plan store: one value, changed only when it really changes.
 *
 * The overlay subscribes here instead of polling the session, so a model that
 * rewrites the same plan on every turn costs one comparison and no redraw.
 */

import { fingerprint, type Plan } from "./plan.ts";

export type PlanListener = (plan: Plan | undefined) => void;

export interface PlanStore {
	get(): Plan | undefined;
	/** Store `next`; returns true (and notifies) only when the plan changed. */
	set(next: Plan | undefined): boolean;
	subscribe(listener: PlanListener): () => void;
	fingerprint(): string;
}

/** A plan with no steps is no plan: the panel has nothing to show either way. */
function meaningful(plan: Plan | undefined): Plan | undefined {
	if (!plan || plan.steps.length === 0) return undefined;
	return plan;
}

export function createPlanStore(initial?: Plan): PlanStore {
	let plan = meaningful(initial);
	let current = fingerprint(plan);
	const listeners = new Set<PlanListener>();

	return {
		get: () => plan,
		fingerprint: () => current,
		set(next) {
			const value = meaningful(next);
			const nextFingerprint = fingerprint(value);
			if (nextFingerprint === current) {
				plan = value;
				return false;
			}
			plan = value;
			current = nextFingerprint;
			for (const listener of [...listeners]) listener(plan);
			return true;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
