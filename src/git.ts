/**
 * Thin git/gh shell helpers. All commands run in `cwd`. Failures throw
 * `GitError` with the captured stderr so the orchestrator can surface them.
 */
import { spawn } from "node:child_process";
import { GitError } from "./errors.ts";

export interface GitResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function run(cmd: string, args: string[], cwd: string): Promise<GitResult> {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d.toString()));
		child.stderr.on("data", (d) => (stderr += d.toString()));
		child.on("close", (exitCode) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: exitCode ?? -1 }));
	});
}

async function gitOk(args: string[], cwd: string): Promise<string> {
	const r = await run("git", args, cwd);
	if (r.exitCode !== 0) {
		throw new GitError(`git ${args.join(" ")} failed (exit ${r.exitCode}): ${r.stderr || r.stdout}`);
	}
	return r.stdout;
}

export async function currentBranch(cwd: string): Promise<string> {
	return gitOk(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
}

export async function isClean(cwd: string): Promise<boolean> {
	const status = await gitOk(["status", "--porcelain"], cwd);
	return status.length === 0;
}

export async function hasRemote(cwd: string): Promise<boolean> {
	const r = await run("git", ["remote"], cwd);
	return r.exitCode === 0 && r.stdout.length > 0;
}

export async function createBranch(branch: string, cwd: string): Promise<void> {
	await gitOk(["checkout", "-b", branch], cwd);
}

export async function stageAll(cwd: string): Promise<void> {
	await gitOk(["add", "-A"], cwd);
}

export async function commit(message: string, cwd: string): Promise<string> {
	await gitOk(["commit", "-m", message, "--no-verify"], cwd);
	return await gitOk(["rev-parse", "HEAD"], cwd);
}

export async function pushUpstream(branch: string, cwd: string): Promise<void> {
	await gitOk(["push", "-u", "origin", branch], cwd);
}

export async function ghAuthStatus(cwd: string): Promise<GitResult> {
	return run("gh", ["auth", "status"], cwd);
}

export async function ghPrCreate(
	title: string,
	body: string,
	baseBranch: string,
	cwd: string,
): Promise<{ number: number; url: string }> {
	const r = await run(
		"gh",
		["pr", "create", "--title", title, "--body", body, "--base", baseBranch],
		cwd,
	);
	if (r.exitCode !== 0) {
		throw new GitError(`gh pr create failed (exit ${r.exitCode}): ${r.stderr || r.stdout}`);
	}
	const url = r.stdout.split("\n").find((l) => l.includes("pull/")) ?? r.stdout;
	const match = r.stderr.match(/pull\/(\d+)/) ?? r.stdout.match(/pull\/(\d+)/);
	const number = match ? Number(match[1]) : 0;
	return { number, url: url.trim() };
}

/** Push the current branch (already tracked) to origin. */
export async function pushBranch(cwd: string): Promise<void> {
	await gitOk(["push"], cwd);
}

/** Merge a PR. `method` is "merge" | "squash" | "rebase". */
export async function ghPrMerge(
	prNumber: number,
	method: "merge" | "squash" | "rebase",
	cwd: string,
): Promise<void> {
	const r = await run("gh", ["pr", "merge", String(prNumber), `--${method}`], cwd);
	if (r.exitCode !== 0) {
		throw new GitError(`gh pr merge failed (exit ${r.exitCode}): ${r.stderr || r.stdout}`);
	}
}

export type CheckState = "pending" | "success" | "failure" | "neutral" | "skipped" | "unknown";

export interface PrCheck {
	name: string;
	state: CheckState;
	link?: string;
}

/** Snapshot of a PR's CI checks. `pending` means at least one is still running. */
export async function ghPrChecks(prNumber: number, cwd: string): Promise<PrCheck[]> {
	const r = await run("gh", ["pr", "checks", String(prNumber), "--json", "name,state,link"], cwd);
	if (r.exitCode !== 0) {
		// No checks configured counts as neutral/empty, not an error.
		if (/no checks|no required/i.test(r.stderr)) return [];
		throw new GitError(`gh pr checks failed (exit ${r.exitCode}): ${r.stderr || r.stdout}`);
	}
	try {
		const rows = JSON.parse(r.stdout || "[]") as Array<{
			name: string;
			state: string;
			link?: string;
		}>;
		return rows.map((row) => ({
			name: row.name,
			state: normalizeCheckState(row.state),
			link: row.link,
		}));
	} catch (e) {
		throw new GitError(`Could not parse gh pr checks output: ${(e as Error).message}`);
	}
}

function normalizeCheckState(s: string): CheckState {
	const v = s.toLowerCase();
	if (v === "success" || v === "pass") return "success";
	if (v === "failure" || v === "fail" || v === "error") return "failure";
	if (v === "pending" || v === "in_progress" || v === "queued") return "pending";
	if (v === "neutral") return "neutral";
	if (v === "skipped") return "skipped";
	return "unknown";
}

export type CheckSummary = { overall: "pending" | "success" | "failure"; checks: PrCheck[] };

export function summarizeChecks(checks: PrCheck[]): CheckSummary {
	if (checks.length === 0) return { overall: "success", checks };
	if (checks.some((c) => c.state === "pending")) return { overall: "pending", checks };
	if (checks.some((c) => c.state === "failure")) return { overall: "failure", checks };
	return { overall: "success", checks };
}

export interface ReviewComment {
	author: string;
	body: string;
	path?: string;
	line?: number;
	side?: string;
	state?: string;
}

/** Fetch review comments + inline review comments for a PR. */
export async function ghPrReviewComments(
	prNumber: number,
	cwd: string,
): Promise<ReviewComment[]> {
	const out: ReviewComment[] = [];
	// Review-level comments (summary reviews)
	const r1 = await run(
		"gh",
		["api", `repos/:owner/:repo/pulls/${prNumber}/reviews`, "--paginate", "-q", ".[] | {author: .user.login, body: .body, state: .state}"],
		cwd,
	);
	if (r1.exitCode === 0) {
		try {
			const rows = JSON.parse(`[${(r1.stdout || "").trim().replace(/\}\s*\{/g, "},{")}]`);
			for (const row of rows as ReviewComment[]) {
				if (row.body && row.body.trim()) out.push(row);
			}
		} catch {
			/* ignore parse errors; treat as no review comments */
		}
	}
	// Inline review comments
	const r2 = await run(
		"gh",
		["api", `repos/:owner/:repo/pulls/${prNumber}/comments`, "--paginate", "-q", ".[] | {author: .user.login, body: .body, path: .path, line: .line, side: .side}"],
		cwd,
	);
	if (r2.exitCode === 0) {
		try {
			const rows = JSON.parse(`[${(r2.stdout || "").trim().replace(/\}\s*\{/g, "},{")}]`);
			for (const row of rows as ReviewComment[]) {
				if (row.body && row.body.trim()) out.push(row);
			}
		} catch {
			/* ignore */
		}
	}
	return out;
}

/** Is the PR approved? (via `gh pr view --json reviewDecision`). */
export async function ghPrApproval(prNumber: number, cwd: string): Promise<boolean> {
	const r = await run(
		"gh",
		["pr", "view", String(prNumber), "--json", "reviewDecision"],
		cwd,
	);
	if (r.exitCode !== 0) return false;
	try {
		const v = JSON.parse(r.stdout) as { reviewDecision?: string };
		return (v.reviewDecision ?? "").toLowerCase() === "approved";
	} catch {
		return false;
	}
}

/** Fetch the latest CI log for a failing check (best-effort). */
export async function ghCheckLog(check: PrCheck, cwd: string): Promise<string> {
	if (!check.link) return "(no log link available)";
	const r = await run("gh", ["api", check.link, "-q", ".output.text // .output // empty"], cwd);
	if (r.exitCode !== 0) return `(could not fetch log from ${check.link})`;
	return (r.stdout || "(empty log)").slice(0, 12000);
}

/** Slugify a goal into a git branch name: "Add X" -> "pitm/add-x". */
export function branchFromGoal(goal: string): string {
	const slug = goal
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
	const stamp = new Date().toISOString().slice(0, 10);
	return `pitm/${stamp}-${slug || "task"}`;
}
