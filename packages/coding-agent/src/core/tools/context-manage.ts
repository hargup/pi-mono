/**
 * context_manage — inspect and mutate effective context in a deterministic way.
 *
 * Keep tool thin: core logic lives in context-curation.ts.
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import {
	applyContextMutations,
	type ContextMutationResult,
	createContextSnapshot,
	formatContextSnapshot,
} from "../context-curation.js";
import type { SessionManager } from "../session-manager.js";

const contextManageSchema = Type.Object({
	mode: Type.Union([Type.Literal("inspect"), Type.Literal("apply")], {
		description:
			'Mode: "inspect" shows compressed context map. "apply" performs remove/restore/add_synthesis and returns updated map.',
	}),
	remove: Type.Optional(
		Type.Array(Type.String(), {
			description: "Entry IDs or aliases (e.g. N-003) to remove from effective context",
		}),
	),
	restore: Type.Optional(
		Type.Array(Type.String(), {
			description: "Entry IDs or aliases (e.g. N-003) to restore into effective context",
		}),
	),
	add_synthesis: Type.Optional(
		Type.Array(
			Type.Object({
				title: Type.String({ description: "Synthesis title" }),
				body: Type.String({ description: "Synthesis body (concise working memory)" }),
			}),
		),
	),
});

export type ContextManageInput = Static<typeof contextManageSchema>;

export interface ContextManageDetails extends ContextMutationResult {
	totalEntries: number;
	removedEntries: number;
	synthesisEntries: number;
}

export interface ContextManageToolOptions {
	/**
	 * Optional callback after successful mutations. Useful to rehydrate
	 * runtime context from session-manager state.
	 */
	onMutated?: () => void;
}

export function createContextManageTool(
	sessionManager: SessionManager,
	options: ContextManageToolOptions = {},
): AgentTool<typeof contextManageSchema> {
	return {
		name: "context_manage",
		label: "context manage",
		description:
			"Inspect and curate context. Use inspect mode to view map. Use apply mode with remove/restore/add_synthesis.",
		parameters: contextManageSchema,
		execute: async (
			_toolCallId: string,
			input: ContextManageInput,
			_signal?: AbortSignal,
		): Promise<AgentToolResult<ContextManageDetails>> => {
			if (input.mode === "inspect") {
				const snapshot = createContextSnapshot(sessionManager.getBranch());
				return {
					content: [{ type: "text", text: formatContextSnapshot(snapshot) }],
					details: {
						removedCount: 0,
						restoredCount: 0,
						synthesisAdded: 0,
						warnings: [],
						totalEntries: snapshot.totalEntries,
						removedEntries: snapshot.removedEntries,
						synthesisEntries: snapshot.synthesisEntries,
					},
				};
			}

			try {
				const mutation = applyContextMutations(sessionManager, {
					remove: input.remove,
					restore: input.restore,
					addSynthesis: input.add_synthesis,
					currentLeafId: sessionManager.getLeafId(),
				});

				options.onMutated?.();

				const snapshot = createContextSnapshot(sessionManager.getBranch());
				const prefix = `Applied: ${mutation.removedCount} removed, ${mutation.restoredCount} restored, ${mutation.synthesisAdded} synthesis`;
				const warningsText = mutation.warnings.length
					? `\nWarnings:\n${mutation.warnings.map((w) => `  ⚠ ${w}`).join("\n")}`
					: "";

				return {
					content: [{ type: "text", text: `${formatContextSnapshot(snapshot, prefix)}${warningsText}` }],
					details: {
						...mutation,
						totalEntries: snapshot.totalEntries,
						removedEntries: snapshot.removedEntries,
						synthesisEntries: snapshot.synthesisEntries,
					},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return errorResult(message);
			}
		},
	};
}

function errorResult(message: string): AgentToolResult<ContextManageDetails> {
	return {
		content: [{ type: "text", text: `Error: ${message}` }],
		details: {
			removedCount: 0,
			restoredCount: 0,
			synthesisAdded: 0,
			warnings: [message],
			totalEntries: 0,
			removedEntries: 0,
			synthesisEntries: 0,
		},
	};
}
