/**
 * Review loop: poll a PR for reviewer comments, feed them to a reviewer
 * session, commit + push, then hand back to CI. Bounded review rounds.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { ghPrReviewComments, isClean, pushBranch, stagePaths, stageTracked, type ReviewComment } from "./git.ts";
import { commit, stageAll } from "./git.ts";
import { runReviewer } from "./phases/reviewer.ts";
import { log, saveState, type State } from "./state.ts";
import { modelLabel } from "./models.ts";
import { status } from "./progress.ts";

export interface ReviewLoopOptions {
	cwd: string;
	state: State;
	reviewerModel: Model<Api> | undefined;
	maxRounds: number;
	/** Rigor skills exposed to the reviewer. Empty unless enabled in config. */
	skills?: Skill[];
	/** Comments seen on prior rounds, to skip re-addressing. */
	knownCommentBodies?: Set<string>;
}

export type ReviewOutcome = "clean" | "addressed" | "needs_human";

export async function runReviewLoop(opts: ReviewLoopOptions): Promise<ReviewOutcome> {
	const { cwd, state } = opts;
	if (!state.pr) throw new Error("Review loop requires an open PR.");
	const known = opts.knownCommentBodies ?? new Set<string>();
	const maxRounds = opts.maxRounds;

	for (let round = 1; round <= maxRounds; round++) {
		state.phase = "review";
		saveState(state, cwd);

		let comments: ReviewComment[];
		try {
			comments = await ghPrReviewComments(state.pr.number, cwd);
		} catch (e) {
			return needsHuman(state, cwd, `Could not fetch PR reviews: ${(e as Error).message}`);
		}
		const newComments = comments.filter((c) => c.body && !known.has(c.body));
		if (newComments.length === 0) {
			log(state, "review", `No new review comments (round ${round}). Review loop clean.`);
			status(`review round ${round}: no new comments — clean`);
			saveState(state, cwd);
			return "clean";
		}

		if (!opts.reviewerModel) {
			return needsHuman(state, cwd, "No reviewer model resolved but review comments are pending.");
		}
		log(state, "review", `Round ${round}: ${newComments.length} new comment(s) with ${modelLabel(opts.reviewerModel)}`, modelLabel(opts.reviewerModel));
		status(`review round ${round}: ${newComments.length} new comment(s)`);
		saveState(state, cwd);

		let result;
		try {
			result = await runReviewer({
				cwd,
				goal: state.goal,
				comments: newComments,
				verifyCommand: state.verifyCommand,
				model: opts.reviewerModel,
				skills: opts.skills,
			});
		} catch (e) {
			return needsHuman(state, cwd, `Reviewer session errored: ${(e as Error).message}`);
		}
		state.budget.spentTokens += result.totalTokens;
		for (const c of newComments) if (c.body) known.add(c.body);
		log(state, "review", `Reviewer done (${result.totalTokens} tokens).`, result.model);

		// Commit + push only the files the reviewer touched. If nothing changed, skip.
		try {
			if (result.touchedPaths.length > 0) await stagePaths(result.touchedPaths, cwd);
			else await stageTracked(cwd);
			const clean = await isClean(cwd);
			if (!clean) {
				await commit(`fix(review): address round ${round} comments\n\n${state.goal}`, cwd);
				await pushBranch(cwd);
				log(state, "review", `Pushed review round ${round} changes.`);
			} else {
				log(state, "review", `Round ${round}: no code changes produced.`);
			}
			saveState(state, cwd);
		} catch (e) {
			return needsHuman(state, cwd, `Could not commit/push review changes: ${(e as Error).message}`);
		}
	}
	return needsHuman(state, cwd, `Review loop exhausted after ${maxRounds} round(s) with new comments each time.`);
}

function needsHuman(state: State, cwd: string, message: string): ReviewOutcome {
	state.phase = "needs_human";
	state.humanNote = message;
	log(state, state.phase, message);
	saveState(state, cwd);
	return "needs_human";
}
