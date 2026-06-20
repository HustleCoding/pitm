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
