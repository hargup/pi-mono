/**
 * Context curation: annotation collection, compressed map generation, and
 * deterministic context mutations (remove/restore/synthesis).
 *
 * Design goals:
 * - Keep implementation simple and auditable
 * - Reuse existing session primitives (CustomEntry + CustomMessageEntry)
 * - Avoid sub-node surgery in v1
 */

import type {
	CompactionEntry,
	CustomEntry,
	SessionEntry,
	SessionManager,
	SessionMessageEntry,
} from "./session-manager.js";

// ============================================================================
// Constants
// ============================================================================

export const CONTEXT_ANNOTATION_TYPE = "context_annotation";
export const CONTEXT_SUMMARY_TYPE = "context_summary";
export const CONTEXT_SYNTHESIS_TYPE = "context_synthesis";
export const CONTEXT_SUMMARY_CACHE_ENV = "PI_CONTEXT_SUMMARY_CACHE";

// ============================================================================
// Types
// ============================================================================

/** Data stored in a context_annotation CustomEntry */
export interface ContextAnnotationData {
	action: "remove" | "restore";
	targetEntryId: string;
	reason?: string;
	scorerTags?: string[];
}

/** Data stored in a context_summary CustomEntry */
export interface ContextSummaryData {
	targetEntryId: string;
	summary: string;
	model?: string;
	generatedAt?: string;
}

/** Result of collecting annotations from a path */
export interface CurationState {
	/** Entry IDs currently excluded from effective context */
	removedIds: Set<string>;
	/** Cached summaries by entry ID */
	summaryCache: Map<string, string>;
	/** Entry IDs already behind compaction boundary */
	compactedIds: Set<string>;
}

export interface CollectCurationStateOptions {
	/**
	 * Enable reading context_summary cache entries.
	 * Default: false unless PI_CONTEXT_SUMMARY_CACHE=1.
	 */
	enableSummaryCache?: boolean;
}

/** A single line in the compressed context map */
export interface MapLine {
	/** 1-based sequential display index */
	displayIndex: number;
	/** Stable session entry ID */
	entryId: string;
	/** Display kind label */
	kind: string;
	/** Human-readable compact description */
	description: string;
	/** Whether this entry is currently removed */
	isRemoved: boolean;
	/** Whether this entry is a synthesis node */
	isSynthesis: boolean;
}

export interface CompressedMapOptions {
	/** Max chars of bash/tool output to inline before collapsing to line-count */
	outputInlineThreshold?: number;
	/**
	 * Enable reading context_summary cache entries.
	 * Default: false unless PI_CONTEXT_SUMMARY_CACHE=1.
	 */
	enableSummaryCache?: boolean;
}

export interface ContextSnapshot {
	state: CurationState;
	lines: MapLine[];
	text: string;
	totalEntries: number;
	removedEntries: number;
	synthesisEntries: number;
}

export interface ContextMutationInput {
	remove?: string[];
	restore?: string[];
	addSynthesis?: Array<{ title: string; body: string }>;
	/** Entry ID currently in-flight (cannot be removed) */
	currentLeafId?: string | null;
}

export interface ContextMutationResult {
	removedCount: number;
	restoredCount: number;
	synthesisAdded: number;
	warnings: string[];
}

// ============================================================================
// Annotation Collection
// ============================================================================

/**
 * Summary-cache is phase-2 (scorer-driven) and disabled by default.
 * Enable globally with PI_CONTEXT_SUMMARY_CACHE=1.
 */
export function isContextSummaryCacheEnabled(): boolean {
	return process.env[CONTEXT_SUMMARY_CACHE_ENV] === "1";
}

/**
 * Walk branch path and collect effective curation state.
 * Last-write-wins for remove/restore annotations.
 */
export function collectCurationState(path: SessionEntry[], options: CollectCurationStateOptions = {}): CurationState {
	const removedIds = new Set<string>();
	const summaryCache = new Map<string, string>();
	const compactedIds = new Set<string>();
	const enableSummaryCache = options.enableSummaryCache ?? isContextSummaryCacheEnabled();

	let compactionEntry: CompactionEntry | null = null;
	for (const entry of path) {
		if (entry.type === "compaction") {
			compactionEntry = entry as CompactionEntry;
		}
	}

	// Entries before firstKeptEntryId are behind compaction boundary
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

	for (const entry of path) {
		if (entry.type !== "custom") continue;
		const custom = entry as CustomEntry;

		if (custom.customType === CONTEXT_ANNOTATION_TYPE && custom.data) {
			const data = custom.data as ContextAnnotationData;
			if (data.action === "remove") removedIds.add(data.targetEntryId);
			if (data.action === "restore") removedIds.delete(data.targetEntryId);
		}

		if (enableSummaryCache && custom.customType === CONTEXT_SUMMARY_TYPE && custom.data) {
			const data = custom.data as ContextSummaryData;
			summaryCache.set(data.targetEntryId, data.summary);
		}
	}

	return { removedIds, summaryCache, compactedIds };
}

// ============================================================================
// Compressed Map
// ============================================================================

export function buildCompressedMap(
	path: SessionEntry[],
	state: CurationState,
	options?: CompressedMapOptions,
): MapLine[] {
	const threshold = options?.outputInlineThreshold ?? 200;
	const lines: MapLine[] = [];
	let displayIndex = 1;

	const byId = new Map<string, SessionEntry>();
	for (const entry of path) byId.set(entry.id, entry);

	for (const entry of path) {
		const line = entryToMapLine(entry, displayIndex, state, byId, threshold);
		if (!line) continue;
		lines.push(line);
		displayIndex++;
	}

	return lines;
}

export function formatCompressedMap(lines: MapLine[]): string {
	if (lines.length === 0) return "(no entries)";

	const rows: string[] = [];
	for (const line of lines) {
		const alias = `N-${String(line.displayIndex).padStart(3, "0")}`;
		const id = `(${line.entryId})`;
		const kind = `[${line.kind}]`;
		const removed = line.isRemoved ? "  ⊘ REMOVED" : "";
		rows.push(`${alias} ${id} ${kind.padEnd(18)} ${line.description}${removed}`);
	}
	return rows.join("\n");
}

export function buildDisplayIdLookup(lines: MapLine[]): Map<string, string> {
	const lookup = new Map<string, string>();
	for (const line of lines) {
		lookup.set(`N-${String(line.displayIndex).padStart(3, "0")}`, line.entryId);
	}
	return lookup;
}

export function createContextSnapshot(path: SessionEntry[], options?: CompressedMapOptions): ContextSnapshot {
	const state = collectCurationState(path, { enableSummaryCache: options?.enableSummaryCache });
	const lines = buildCompressedMap(path, state, options);
	const text = formatCompressedMap(lines);
	const totalEntries = lines.length;
	const removedEntries = lines.filter((l) => l.isRemoved).length;
	const synthesisEntries = lines.filter((l) => l.isSynthesis).length;

	return {
		state,
		lines,
		text,
		totalEntries,
		removedEntries,
		synthesisEntries,
	};
}

export function formatContextSnapshot(snapshot: ContextSnapshot, prefix?: string): string {
	let header = `Context entries: ${snapshot.totalEntries} total, ${snapshot.removedEntries} removed, ${snapshot.synthesisEntries} synthesis`;
	if (prefix?.trim()) header = `${prefix}\n${header}`;
	return `${header}\n\n${snapshot.text}`;
}

/**
 * Resolve user-provided IDs (real IDs or display aliases like N-003) to real entry IDs.
 */
export function resolveEntryIdentifiers(
	requestedIds: string[],
	lines: MapLine[],
): {
	resolved: string[];
	unknown: string[];
} {
	const aliasToId = buildDisplayIdLookup(lines);
	const validIds = new Set(lines.map((l) => l.entryId));

	const resolved: string[] = [];
	const unknown: string[] = [];

	for (const rawId of requestedIds) {
		const id = rawId.trim();
		if (!id) continue;

		if (validIds.has(id)) {
			resolved.push(id);
			continue;
		}

		const aliasResolved = aliasToId.get(id);
		if (aliasResolved) {
			resolved.push(aliasResolved);
			continue;
		}

		unknown.push(id);
	}

	return { resolved: Array.from(new Set(resolved)), unknown };
}

// ============================================================================
// Deterministic mutation engine
// ============================================================================

/**
 * Apply remove/restore/synthesis mutations to session state.
 * Throws Error for invalid input; returns warnings for non-fatal edge cases.
 */
export function applyContextMutations(
	sessionManager: SessionManager,
	input: ContextMutationInput,
): ContextMutationResult {
	const removeRaw = input.remove ?? [];
	const restoreRaw = input.restore ?? [];
	const synthesisRaw = input.addSynthesis ?? [];

	if (removeRaw.length === 0 && restoreRaw.length === 0 && synthesisRaw.length === 0) {
		throw new Error("No operations specified. Provide remove, restore, or add_synthesis.");
	}

	const path = sessionManager.getBranch();
	const snapshot = createContextSnapshot(path);

	const removeResolved = resolveEntryIdentifiers(removeRaw, snapshot.lines);
	const restoreResolved = resolveEntryIdentifiers(restoreRaw, snapshot.lines);
	const unknown = [...removeResolved.unknown, ...restoreResolved.unknown];
	if (unknown.length > 0) {
		throw new Error(`Unknown entry IDs: ${unknown.join(", ")}`);
	}

	if (input.currentLeafId && removeResolved.resolved.includes(input.currentLeafId)) {
		throw new Error("Cannot remove current in-flight entry.");
	}

	const state = collectCurationState(path);
	const warnings: string[] = [];

	// Remove set with cascade for assistant parent -> direct child tool results
	const removeSet = new Set<string>(removeResolved.resolved);
	for (const targetId of removeResolved.resolved) {
		const target = path.find((e) => e.id === targetId);
		if (!target || target.type !== "message") continue;
		const msg = (target as SessionMessageEntry).message as any;
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const hasToolCall = msg.content.some((b: any) => b.type === "toolCall");
		if (!hasToolCall) continue;

		for (const child of path) {
			if (
				child.parentId === targetId &&
				child.type === "message" &&
				(child as SessionMessageEntry).message.role === "toolResult"
			) {
				removeSet.add(child.id);
			}
		}
	}

	for (const targetId of removeSet) {
		sessionManager.appendCustomEntry(CONTEXT_ANNOTATION_TYPE, {
			action: "remove",
			targetEntryId: targetId,
		} satisfies ContextAnnotationData);
	}

	let restoredCount = 0;
	for (const targetId of restoreResolved.resolved) {
		if (state.compactedIds.has(targetId)) {
			warnings.push(`Entry ${targetId} is behind compaction boundary; restore skipped.`);
			continue;
		}
		sessionManager.appendCustomEntry(CONTEXT_ANNOTATION_TYPE, {
			action: "restore",
			targetEntryId: targetId,
		} satisfies ContextAnnotationData);
		restoredCount++;
	}

	let synthesisAdded = 0;
	for (const synthesis of synthesisRaw) {
		const title = synthesis.title?.trim();
		const body = synthesis.body?.trim();
		if (!title || !body) {
			warnings.push("Skipped synthesis node with empty title/body.");
			continue;
		}
		const content = `## ${title}\n\n${body}`;
		sessionManager.appendCustomMessageEntry(CONTEXT_SYNTHESIS_TYPE, content, true);
		synthesisAdded++;
	}

	return {
		removedCount: removeSet.size,
		restoredCount,
		synthesisAdded,
		warnings,
	};
}

// ============================================================================
// Entry-to-line conversion helpers
// ============================================================================

function entryToMapLine(
	entry: SessionEntry,
	displayIndex: number,
	state: CurationState,
	byId: Map<string, SessionEntry>,
	outputThreshold: number,
): MapLine | null {
	// Non-context metadata entries
	if (
		entry.type === "thinking_level_change" ||
		entry.type === "model_change" ||
		entry.type === "label" ||
		entry.type === "session_info"
	) {
		return null;
	}

	const isRemoved = state.removedIds.has(entry.id);

	if (entry.type === "custom") {
		const custom = entry as CustomEntry;
		// Skip internal curation metadata entries in the visible map
		if (custom.customType === CONTEXT_ANNOTATION_TYPE || custom.customType === CONTEXT_SUMMARY_TYPE) {
			return null;
		}
		return null;
	}

	if (entry.type === "compaction") {
		const summary = (entry.summary || "").replace(/\s+/g, " ").slice(0, 90);
		return {
			displayIndex,
			entryId: entry.id,
			kind: "compaction",
			description: summary ? `"${summary}${entry.summary.length > 90 ? "..." : ""}"` : "(compaction summary)",
			isRemoved,
			isSynthesis: false,
		};
	}

	if (entry.type === "branch_summary") {
		const summary = (entry.summary || "").replace(/\s+/g, " ").slice(0, 90);
		return {
			displayIndex,
			entryId: entry.id,
			kind: "branch_summary",
			description: summary ? `"${summary}${entry.summary.length > 90 ? "..." : ""}"` : "(branch summary)",
			isRemoved,
			isSynthesis: false,
		};
	}

	if (entry.type === "custom_message") {
		const customMsg = entry as any;
		const content = typeof customMsg.content === "string" ? customMsg.content : "";
		const preview = content.replace(/\s+/g, " ").trim().slice(0, 90);
		const isSynthesis = customMsg.customType === CONTEXT_SYNTHESIS_TYPE;
		return {
			displayIndex,
			entryId: entry.id,
			kind: isSynthesis ? "synthesis" : "custom_msg",
			description: preview ? `"${preview}${content.length > 90 ? "..." : ""}"` : "(custom message)",
			isRemoved,
			isSynthesis,
		};
	}

	if (entry.type === "message") {
		const msg = (entry as SessionMessageEntry).message as any;
		if (msg.role === "toolResult") {
			return toolResultToMapLine(entry, msg, displayIndex, isRemoved, byId, outputThreshold);
		}
		if (msg.role === "assistant") {
			return assistantToMapLine(entry, msg, displayIndex, isRemoved, state);
		}
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
	outputThreshold: number,
): MapLine {
	const toolName: string = msg.toolName || "unknown";
	const toolCallId: string = msg.toolCallId || "";

	const parentEntry = entry.parentId ? byId.get(entry.parentId) : undefined;
	let filePath: string | undefined;
	let bashCommand: string | undefined;

	if (parentEntry?.type === "message") {
		const parentMsg = (parentEntry as SessionMessageEntry).message as any;
		if (parentMsg.role === "assistant" && Array.isArray(parentMsg.content)) {
			for (const block of parentMsg.content) {
				if (block.type === "toolCall" && (block as any).id === toolCallId) {
					const args = (block as any).arguments || {};
					if (toolName === "read" || toolName === "write" || toolName === "edit") filePath = args.path;
					if (toolName === "bash") bashCommand = args.command;
					break;
				}
			}
		}
	}

	if (toolName === "read" || toolName === "write" || toolName === "edit") {
		const shortPath = shortenPath(filePath || "(unknown path)");
		return { displayIndex, entryId: entry.id, kind: toolName, description: shortPath, isRemoved, isSynthesis: false };
	}

	if (toolName === "bash") {
		const cmd = (bashCommand || "(unknown command)").trim();
		const shortCmd = cmd.length > 80 ? `${cmd.slice(0, 77)}...` : cmd;
		const outputText = getToolResultText(msg);
		const outputLines = outputText.split("\n").filter((l) => l.trim()).length;
		let description: string;
		if (outputText.length <= outputThreshold) {
			const inline = outputText.replace(/\s+/g, " ").trim();
			description = inline ? `\`${shortCmd}\` -> ${inline}` : `\`${shortCmd}\` -> (no output)`;
		} else {
			description = `\`${shortCmd}\` -> ${outputLines} lines`;
		}
		return { displayIndex, entryId: entry.id, kind: "bash", description, isRemoved, isSynthesis: false };
	}

	const outputText = getToolResultText(msg);
	const outputLines = outputText.split("\n").filter((l) => l.trim()).length;
	const description =
		outputText.length <= outputThreshold
			? outputText.replace(/\s+/g, " ").trim() || "(no output)"
			: `${outputLines} lines`;
	return { displayIndex, entryId: entry.id, kind: toolName, description, isRemoved, isSynthesis: false };
}

function assistantToMapLine(
	entry: SessionEntry,
	msg: any,
	displayIndex: number,
	isRemoved: boolean,
	state: CurationState,
): MapLine {
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

	const content = Array.isArray(msg.content) ? msg.content : [];
	const textBlocks = content.filter((b: any) => b.type === "text");
	const toolCalls = content.filter((b: any) => b.type === "toolCall");

	if (textBlocks.length === 0 && toolCalls.length > 0) {
		const names = toolCalls.map((tc: any) => tc.name).join(", ");
		return {
			displayIndex,
			entryId: entry.id,
			kind: "assistant",
			description: `[called: ${names}]`,
			isRemoved,
			isSynthesis: false,
		};
	}

	const text = textBlocks
		.map((b: any) => b.text || "")
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	const preview = text.slice(0, 100);
	return {
		displayIndex,
		entryId: entry.id,
		kind: "assistant",
		description: preview ? `"${preview}${text.length > 100 ? "..." : ""}"` : "(assistant message)",
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

	const text = Array.isArray(msg.content)
		? msg.content
				.filter((b: any) => b.type === "text")
				.map((b: any) => b.text || "")
				.join(" ")
		: typeof msg.content === "string"
			? msg.content
			: "";
	const normalized = text.replace(/\s+/g, " ").trim();
	const preview = normalized.slice(0, 100);
	return {
		displayIndex,
		entryId: entry.id,
		kind: "user",
		description: preview ? `"${preview}${normalized.length > 100 ? "..." : ""}"` : "(user message)",
		isRemoved,
		isSynthesis: false,
	};
}

function getToolResultText(msg: any): string {
	const content = msg.content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b: any) => b.type === "text")
		.map((b: any) => b.text || "")
		.join("\n");
}

function shortenPath(filePath: string): string {
	if (filePath.length <= 60) return filePath;
	const parts = filePath.split("/").filter(Boolean);
	if (parts.length <= 3) return filePath;
	return `.../${parts.slice(-3).join("/")}`;
}
