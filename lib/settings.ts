/**
 * Reading and writing `<agent-dir>/settings.json`.
 *
 * Settings are merged, never rewritten, and writes go through pi's file
 * mutation queue so they cannot interleave with another writer.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Resolve the pi agent directory (`PI_CODING_AGENT_DIR` or `~/.pi/agent`). */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.PI_CODING_AGENT_DIR;
	if (configured && configured.trim() !== "") return expandHome(configured.trim(), env);
	return join(homedir(), ".pi", "agent");
}

export function expandHome(path: string, env: NodeJS.ProcessEnv = process.env): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	const home = env.HOME ?? env.USERPROFILE;
	if (path.startsWith("~") && home) return join(home, path.slice(1));
	return path;
}

export function globalSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(agentDir(env), "settings.json");
}

/** Read a settings file, returning `{}` when it is missing or malformed. */
export async function readSettings(file: string): Promise<Record<string, unknown>> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
		return {};
	} catch {
		return {};
	}
}

/** Merge `patch` into a settings file, preserving unrelated keys. */
export async function writeSettings(file: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
	const next = { ...(await readSettings(file)), ...patch };
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	return next;
}
