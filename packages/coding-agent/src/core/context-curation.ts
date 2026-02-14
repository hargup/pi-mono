/**
 * Context curation: annotation collection + compressed map generation.
 *
 * Annotations are CustomEntry records that tag session entries for removal/restore.
 * The compressed map is a text representation of all entries, designed to be small
 * enough (~20 tokens per line) for the agent to inspect and make curation decisions.
 *
 * @see PRD: Pi Context Self-Management v3.1
 */

import type { CompactionEntry, CustomEntry, SessionEntry, SessionMessageEntry } from "./session-manager.js";

// ============================================================================
// Types
// ============================================================================

/** Data stored in a context_annotation CustomEntry */
export interface ContextAnnotationData {
	action: "remove" | "restore";
	targetEntryId: string;
}

/** Data stored in a context_summary CustomEntry */
export interface ContextSummaryData {
	targetEntryId: string;
	summary: string;
	model: string;
	generatedAt: string;
}

export const CONTEXT_ANNOTATION_TYPE = "context_annotation";
export const CONTEXT_SUMMARY_TYPE = "context_summary";
export const CONTEXT_SYNTHESIS_TYPE = "context_synthesis";

/** Result of collecting annotations from a path */
export interface CurationState {
	/** Entry IDs that are currently removed */
	removedIds: Set<string>;
	/** Map of entry ID → cached summary text */
	summaryCache: Map<string, string>;
	/** Entry IDs that are behind the compaction boundary */
	compactedIds: Set<string>;
}

// ============================================================================
// Annotation Collection
// ============================================================================

/**
 * Walk the branch path and collect the effective curation state.
 * Last-write-wins: remove then restore = active.
 */
export function collectCurationState(path: SessionEntry[]): CurationState {
	const removedIds = new Set<string>();
	const summaryCache = new Map<string, string>();
	const compactedIds = new Set<string>();

	// Find compaction boundary
	let compactionEntry: CompactionEntry | null = null;
	for (const entry of path) {
		if (entry.type === "compaction") {
			compactionEntry = entry as CompactionEntry;
		}
	}

	// Mark entries before compaction boundary
	if (compactionEntry) {
		let foundFirstKept = false;
		for (const entry of path) {
			if (entry.id === compactionEntry.id) break;
			if (entry.id === compactionEntry.firstKeptEntryId) {
				foundFirstKept = true;
			}
			if (!foundFirstKept) {
				compactedIds.add(entry.id);
			}
		}
	}

	// Collect annotations (last-write-wins)
	for (const entry of path) {
		if (entry.type === "custom") {
			const custom = entry as CustomEntry;
			if (custom.customType === CONTEXT_ANNOTATION_TYPE && custom.data) {
				const data = custom.data as ContextAnnotationData;
				if (data.action === "remove") {
					removedIds.add(data.targetEntryId);
				} else if (data.action === "restore") {
					removedIds.delete(data.targetEntryId);
				}
			} else if (custom.customType === CONTEXT_SUMMARY_TYPE && custom.data) {
				const data = custom.data as ContextSummaryData;
				summaryCache.set(data.targetEntryId, data.summary);
			}
		}
	}

	return { removedIds, summaryCache, compactedIds };
}

// ============================================================================
// Compressed Map Generation
// ============================================================================

/** Options for generating the compressed map */
export interface CompressedMapOptions {
	/** Max chars of bash output to show inline. Default: 200 */
	bashOutputInlineThreshold?: number;
}

/** A single line in the compressed map */
export interface MapLine {
	/** Sequential display number */
	displayIndex: number;
	/** Real entry ID */
	entryId: string;
	/** Entry kind label */
	kind: string;
	/** The description/summary text */
	description: string;
	/** Whether this entry is currently removed */
	isRemoved: boolean;
	/** Whether this is a synthesis entry */
	isSynthesis: boolean;
}

/**
 * Build a compressed map of all context-participating entries on the path.
 *
 * Rules:
 * - read/write/edit tool results: tool name + file path (no content)
 * - bash tool results: command + short output or line count
 * - user/assistant messages: use cached summary, or placeholder if not cached
 * - skip non-context entries (thinking_level_change, model_change, label, custom, session_info)
 * - include removed entries with marker
 * - include synthesis entries
 */
export function buildCompressedMap(
	path: SessionEntry[],
	state: CurationState,
	options?: CompressedMapOptions,
): MapLine[] {
	const bashThreshold = options?.bashOutputInlineThreshold ?? 200;
	const lines: MapLine[] = [];
	let displayIndex = 1;

	// Build parent lookup for tool result → assistant matching
	const byId = new Map<string, SessionEntry>();
	for (const entry of path) {
		byId.set(entry.id, entry);
	}

	for (const entry of path) {
		const line = entryToMapLine(entry, displayIndex, state, byId, bashThreshold);
		if (line) {
			lines.push(line);
			displayIndex++;
		}
	}

	return lines;
}

/**
 * Format the compressed map as a text string for the agent.
 */
export function formatCompressedMap(lines: MapLine[]): string {
	if (lines.length === 0) return "(no entries)";

	const rows: string[] = [];
	for (const line of lines) {
		const idx = `N-${String(line.displayIndex).padStart(3, "0")}`;
		const id = `(${line.entryId})`;
		const kind = `[${line.kind}]`;
		const removedMark = line.isRemoved ? "  ⊘ REMOVED" : "";
		rows.push(`${idx} ${id} ${kind.padEnd(14)} ${line.description}${removedMark}`);
	}
	return rows.join("\n");
}

/**
 * Build a display-index → entry-id lookup from map lines.
 */
export function buildDisplayIdLookup(lines: MapLine[]): Map<string, string> {
	const lookup = new Map<string, string>();
	for (const line of lines) {
		lookup.set(`N-${String(line.displayIndex).padStart(3, "0")}`, line.entryId);
	}
	return lookup;
}

// ============================================================================
// Entry Classification (private helpers)
// ============================================================================

function entryToMapLine(
	entry: SessionEntry,
	displayIndex: number,
	state: CurationState,
	byId: Map<string, SessionEntry>,
	bashThreshold: number,
): MapLine | null {
	// Skip non-context entry types
	if (
		entry.type === "thinking_level_change" ||
		entry.type === "model_change" ||
		entry.type === "label" ||
		entry.type === "session_info" ||
		entry.type === "compaction" ||
		entry.type === "branch_summary"
	) {
		return null;
	}

	// Skip annotation/summary CustomEntries (they're metadata, not content)
	if (entry.type === "custom") {
		const custom = entry as CustomEntry;
		if (custom.customType === CONTEXT_ANNOTATION_TYPE || custom.customType === CONTEXT_SUMMARY_TYPE) {
			return null;
		}
		// Other custom entries are invisible to context
		return null;
	}

	const isRemoved = state.removedIds.has(entry.id);

	// Synthesis entries (CustomMessageEntry)
	if (entry.type === "custom_message") {
		const cme = entry as any; // CustomMessageEntry
		if (cme.customType === CONTEXT_SYNTHESIS_TYPE) {
			const content = typeof cme.content === "string" ? cme.content : "";
			const preview = content.slice(0, 80).replace(/\n/g, " ");
			return {
				displayIndex,
				entryId: entry.id,
				kind: "synthesis",
				description: preview || "(synthesis node)",
				isRemoved,
				isSynthesis: true,
			};
		}
		// Other custom messages
		const content = typeof cme.content === "string" ? cme.content : "";
		const preview = content.slice(0, 80).replace(/\n/g, " ");
		return {
			displayIndex,
			entryId: entry.id,
			kind: "custom_msg",
			description: preview || "(custom message)",
			isRemoved,
			isSynthesis: false,
		};
	}

	// Message entries
	if (entry.type === "message") {
		const msg = (entry as SessionMessageEntry).message;

		// Tool results
		if (msg.role === "toolResult") {
			return toolResultToMapLine(entry, msg, displayIndex, isRemoved, byId, bashThreshold);
		}

		// Assistant messages
		if (msg.role === "assistant") {
			return assistantToMapLine(entry, msg, displayIndex, isRemoved, state);
		}

		// User messages
		if (msg.role === "user") {
			return userToMapLine(entry, msg, displayIndex, isRemoved, state);
		}
	}

	return null;
}

function toolResultToMapLine(
	entry: SessionEntry,
	msg: any,
	displayIndex: number,
	isRemoved: boolean,
	byId: Map<string, SessionEntry>,
	bashThreshold: number,
): MapLine {
	const toolName: string = msg.toolName || "unknown";
	const toolCallId: string = msg.toolCallId || "";

	// Try to get file path from the parent assistant's tool call
	const parentEntry = entry.parentId ? byId.get(entry.parentId) : undefined;
	let filePath: string | undefined;
	let bashCommand: string | undefined;

	if (parentEntry?.type === "message") {
		const parentMsg = (parentEntry as SessionMessageEntry).message;
		if (parentMsg.role === "assistant" && Array.isArray(parentMsg.content)) {
			for (const block of parentMsg.content) {
				if (block.type === "toolCall" && (block as any).id === toolCallId) {
					const args = (block as any).arguments || {};
					if (toolName === "read" || toolName === "write" || toolName === "edit") {
						filePath = args.path;
					} else if (toolName === "bash") {
						bashCommand = args.command;
					}
					break;
				}
			}
		}
	}

	// read/write/edit → tool name + file path
	if (toolName === "read" || toolName === "write" || toolName === "edit") {
		const path = filePath || "(unknown path)";
		// Shorten long paths: keep last 2-3 segments
		const shortPath = shortenPath(path);
		return {
			displayIndex,
			entryId: entry.id,
			kind: toolName,
			description: shortPath,
			isRemoved,
			isSynthesis: false,
		};
	}

	// bash → command + output summary
	if (toolName === "bash") {
		const cmd = bashCommand || "(unknown command)";
		const shortCmd = cmd.length > 80 ? `${cmd.slice(0, 77)}...` : cmd;
		const outputText = getToolResultText(msg);
		const outputLines = outputText.split("\n").filter((l) => l.trim()).length;

		let desc: string;
		if (outputText.length <= bashThreshold) {
			// Short output: show inline
			const inlineOutput = outputText.replace(/\n/g, " ").trim();
			desc = inlineOutput ? `\`${shortCmd}\` → ${inlineOutput}` : `\`${shortCmd}\` → (no output)`;
		} else {
			desc = `\`${shortCmd}\` → ${outputLines} lines`;
		}

		return {
			displayIndex,
			entryId: entry.id,
			kind: "bash",
			description: desc,
			isRemoved,
			isSynthesis: false,
		};
	}

	// Other tool results (grep, find, ls, extension tools)
	const outputText = getToolResultText(msg);
	const outputLines = outputText.split("\n").filter((l) => l.trim()).length;
	let desc: string;
	if (outputText.length <= bashThreshold) {
		const inlineOutput = outputText.replace(/\n/g, " ").trim();
		desc = inlineOutput || "(no output)";
	} else {
		desc = `${outputLines} lines of output`;
	}

	return {
		displayIndex,
		entryId: entry.id,
		kind: toolName,
		description: desc,
		isRemoved,
		isSynthesis: false,
	};
}

function assistantToMapLine(
	entry: SessionEntry,
	msg: any,
	displayIndex: number,
	isRemoved: boolean,
	state: CurationState,
): MapLine {
	// Check for cached summary
	const cached = state.summaryCache.get(entry.id);
	if (cached) {
		return {
			displayIndex,
			entryId: entry.id,
			kind: "assistant",
			description: `"${cached}"`,
			isRemoved,
			isSynthesis: false,
		};
	}

	// Check if this is a tool-call-only message (no text content)
	const content = Array.isArray(msg.content) ? msg.content : [];
	const textBlocks = content.filter((b: any) => b.type === "text");
	const toolCalls = content.filter((b: any) => b.type === "toolCall");

	if (textBlocks.length === 0 && toolCalls.length > 0) {
		// Tool-call-only assistant message: show what tools were called
		const toolNames = toolCalls.map((tc: any) => tc.name).join(", ");
		return {
			displayIndex,
			entryId: entry.id,
			kind: "assistant",
			description: `[called: ${toolNames}]`,
			isRemoved,
			isSynthesis: false,
		};
	}

	// Has text content: show first ~80 chars as preview
	const allText = textBlocks.map((b: any) => b.text || "").join(" ");
	const preview = allText.slice(0, 100).replace(/\n/g, " ").trim();
	if (preview) {
		return {
			displayIndex,
			entryId: entry.id,
			kind: "assistant",
			description: `"${preview}${allText.length > 100 ? "..." : ""}"`,
			isRemoved,
			isSynthesis: false,
		};
	}

	return {
		displayIndex,
		entryId: entry.id,
		kind: "assistant",
		description: "(no summary available)",
		isRemoved,
		isSynthesis: false,
	};
}

function userToMapLine(
	entry: SessionEntry,
	msg: any,
	displayIndex: number,
	isRemoved: boolean,
	state: CurationState,
): MapLine {
	// Check for cached summary
	const cached = state.summaryCache.get(entry.id);
	if (cached) {
		return {
			displayIndex,
			entryId: entry.id,
			kind: "user",
			description: `"${cached}"`,
			isRemoved,
			isSynthesis: false,
		};
	}

	// Bash execution messages
	if ((msg as any).role === "user" && (msg as any).command) {
		// It's a BashExecutionMessage wrapped as user
		return {
			displayIndex,
			entryId: entry.id,
			kind: "user_bash",
			description: `\`${(msg as any).command}\``,
			isRemoved,
			isSynthesis: false,
		};
	}

	// Regular user message: show first ~80 chars
	const content = Array.isArray(msg.content)
		? msg.content.map((b: any) => b.text || "").join(" ")
		: typeof msg.content === "string"
			? msg.content
			: "";
	const preview = content.slice(0, 100).replace(/\n/g, " ").trim();
	return {
		displayIndex,
		entryId: entry.id,
		kind: "user",
		description: preview ? `"${preview}${content.length > 100 ? "..." : ""}"` : "(empty message)",
		isRemoved,
		isSynthesis: false,
	};
}

// ============================================================================
// Utility helpers
// ============================================================================

function getToolResultText(msg: any): string {
	const content = msg.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b.type === "text")
		.map((b: any) => b.text || "")
		.join("\n");
}

function shortenPath(filePath: string): string {
	// Keep the full path but trim very long absolute paths
	if (filePath.length <= 60) return filePath;
	const parts = filePath.split("/").filter(Boolean);
	if (parts.length <= 3) return filePath;
	return `.../${parts.slice(-3).join("/")}`;
}
