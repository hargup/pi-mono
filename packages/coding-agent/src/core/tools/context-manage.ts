/**
 * context_manage tool — the agent's single tool for inspecting and curating
 * its own context. Supports inspect (read-only), remove, restore, and
 * add_synthesis operations.
 *
 * @see PRD: Pi Context Self-Management v3.1
 */

import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import {
	buildCompressedMap,
	CONTEXT_ANNOTATION_TYPE,
	CONTEXT_SYNTHESIS_TYPE,
	type ContextAnnotationData,
	collectCurationState,
	formatCompressedMap,
} from "../context-curation.js";
import type { SessionManager } from "../session-manager.js";

// ============================================================================
// Schema
// ============================================================================

const contextManageSchema = Type.Object({
	mode: Type.Union([Type.Literal("inspect"), Type.Literal("apply")], {
		description:
			'Mode: "inspect" returns the context map (read-only). "apply" performs remove/restore/add_synthesis operations and returns the updated map.',
	}),
	remove: Type.Optional(
		Type.Array(Type.String(), {
			description: "Entry IDs to remove from context (use real entry IDs from the map, e.g. 'cc5636f8')",
		}),
	),
	restore: Type.Optional(
		Type.Array(Type.String(), {
			description: "Entry IDs to restore (re-add previously removed entries)",
		}),
	),
	add_synthesis: Type.Optional(
		Type.Array(
			Type.Object({
				title: Type.String({ description: "Short title for this synthesis note" }),
				body: Type.String({ description: "Working memory content (concise)" }),
			}),
			{
				description: "Synthesis nodes to add at the end of context as working memory",
			},
		),
	),
});

export type ContextManageInput = Static<typeof contextManageSchema>;

export interface ContextManageDetails {
	removedCount: number;
	restoredCount: number;
	synthesisAdded: number;
	totalEntries: number;
	removedEntries: number;
	warnings: string[];
}

// ============================================================================
// Tool Factory
// ============================================================================

/**
 * Create the context_manage tool. Captures sessionManager in closure
 * for read/write access to session entries and annotations.
 */
export function createContextManageTool(sessionManager: SessionManager): AgentTool<typeof contextManageSchema> {
	return {
		name: "context_manage",
		label: "context manage",
		description: `Inspect and curate the conversation context. Use mode "inspect" to see a compressed map of all entries (including removed ones). Use mode "apply" to remove stale entries, restore previously removed entries, or add synthesis notes as working memory.

The map shows each entry with a display alias (N-001) and real ID (e.g. cc5636f8). Use real IDs for remove/restore operations.

Entry types in the map:
- [read/write/edit] — file operations, showing the file path
- [bash] — shell commands with output preview
- [user] — user messages with text preview
- [assistant] — assistant responses with text preview or tool call summary
- [synthesis] — previously added working memory notes
- Entries marked ⊘ REMOVED are excluded from LLM context but can be restored.

Best used when context is getting large (>50%) or contains stale file reads, old debugging output, or superseded planning.`,
		parameters: contextManageSchema,
		execute: async (
			_toolCallId: string,
			input: ContextManageInput,
			_signal?: AbortSignal,
		): Promise<AgentToolResult<ContextManageDetails>> => {
			const path = sessionManager.getBranch();
			const warnings: string[] = [];

			// --- Apply phase (if mode is "apply") ---
			if (input.mode === "apply") {
				const hasOps =
					(input.remove && input.remove.length > 0) ||
					(input.restore && input.restore.length > 0) ||
					(input.add_synthesis && input.add_synthesis.length > 0);

				if (!hasOps) {
					return errorResult('mode "apply" requires at least one of: remove, restore, add_synthesis');
				}

				// Validate all entry IDs exist
				const entryIds = new Set(path.map((e) => e.id));
				const badIds: string[] = [];
				for (const id of input.remove ?? []) {
					if (!entryIds.has(id)) badIds.push(id);
				}
				for (const id of input.restore ?? []) {
					if (!entryIds.has(id)) badIds.push(id);
				}
				if (badIds.length > 0) {
					return errorResult(`Unknown entry IDs: ${badIds.join(", ")}`);
				}

				// Check invariant: cannot remove the current leaf (in-flight prompt)
				const leafId = sessionManager.getLeafId();
				if (leafId && input.remove?.includes(leafId)) {
					return errorResult("Cannot remove the current in-flight entry");
				}

				// Collect current state to check for compaction boundary
				const currentState = collectCurationState(path);

				// Check for restore-behind-compaction
				for (const id of input.restore ?? []) {
					if (currentState.compactedIds.has(id)) {
						warnings.push(
							`Entry ${id} is behind compaction boundary — content no longer available. Restore skipped.`,
						);
					}
				}

				// Apply removals
				let removedCount = 0;
				for (const targetId of input.remove ?? []) {
					sessionManager.appendCustomEntry(CONTEXT_ANNOTATION_TYPE, {
						action: "remove",
						targetEntryId: targetId,
					} satisfies ContextAnnotationData);
					removedCount++;

					// Cascade: if this is an assistant entry with tool calls,
					// also remove child tool results to prevent orphans
					const targetEntry = path.find((e) => e.id === targetId);
					if (targetEntry?.type === "message") {
						const msg = (targetEntry as any).message;
						if (msg.role === "assistant" && Array.isArray(msg.content)) {
							const toolCallIds = new Set(
								msg.content.filter((b: any) => b.type === "toolCall").map((b: any) => b.id),
							);
							if (toolCallIds.size > 0) {
								// Find child tool results
								for (const child of path) {
									if (
										child.parentId === targetId &&
										child.type === "message" &&
										(child as any).message?.role === "toolResult"
									) {
										sessionManager.appendCustomEntry(CONTEXT_ANNOTATION_TYPE, {
											action: "remove",
											targetEntryId: child.id,
										} satisfies ContextAnnotationData);
										removedCount++;
									}
								}
							}
						}
					}
				}

				// Apply restores (skip compacted)
				let restoredCount = 0;
				for (const targetId of input.restore ?? []) {
					if (currentState.compactedIds.has(targetId)) continue;
					sessionManager.appendCustomEntry(CONTEXT_ANNOTATION_TYPE, {
						action: "restore",
						targetEntryId: targetId,
					} satisfies ContextAnnotationData);
					restoredCount++;
				}

				// Add synthesis nodes
				let synthesisAdded = 0;
				for (const synth of input.add_synthesis ?? []) {
					const content = `## ${synth.title}\n\n${synth.body}`;
					sessionManager.appendCustomMessageEntry(
						CONTEXT_SYNTHESIS_TYPE,
						content,
						true, // display in TUI
					);
					synthesisAdded++;
				}

				// Re-read path after mutations
				const updatedPath = sessionManager.getBranch();
				const updatedState = collectCurationState(updatedPath);
				const mapLines = buildCompressedMap(updatedPath, updatedState);
				const mapText = formatCompressedMap(mapLines);

				const totalEntries = mapLines.length;
				const removedEntries = mapLines.filter((l) => l.isRemoved).length;
				const synthesisEntries = mapLines.filter((l) => l.isSynthesis).length;

				let header = `Context entries: ${totalEntries} total, ${removedEntries} removed, ${synthesisEntries} synthesis\n`;
				header += `Applied: ${removedCount} removed, ${restoredCount} restored, ${synthesisAdded} synthesis added\n`;
				if (warnings.length > 0) {
					header += `\nWarnings:\n${warnings.map((w) => `  ⚠ ${w}`).join("\n")}\n`;
				}
				header += "\n";

				return {
					content: [{ type: "text", text: header + mapText }],
					details: {
						removedCount,
						restoredCount,
						synthesisAdded,
						totalEntries,
						removedEntries,
						warnings,
					},
				};
			}

			// --- Inspect phase ---
			const state = collectCurationState(path);
			const mapLines = buildCompressedMap(path, state);
			const mapText = formatCompressedMap(mapLines);

			const totalEntries = mapLines.length;
			const removedEntries = mapLines.filter((l) => l.isRemoved).length;
			const synthesisEntries = mapLines.filter((l) => l.isSynthesis).length;

			const header = `Context entries: ${totalEntries} total, ${removedEntries} removed, ${synthesisEntries} synthesis\n\n`;

			return {
				content: [{ type: "text", text: header + mapText }],
				details: {
					removedCount: 0,
					restoredCount: 0,
					synthesisAdded: 0,
					totalEntries,
					removedEntries,
					warnings: [],
				},
			};
		},
	};
}

// ============================================================================
// Helpers
// ============================================================================

function errorResult(message: string): AgentToolResult<ContextManageDetails> {
	return {
		content: [{ type: "text", text: `Error: ${message}` }],
		details: {
			removedCount: 0,
			restoredCount: 0,
			synthesisAdded: 0,
			totalEntries: 0,
			removedEntries: 0,
			warnings: [message],
		},
	};
}
