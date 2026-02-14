/**
 * Unit tests for context curation: annotation collection, compressed map,
 * and buildSessionContext integration.
 *
 * These tests use in-memory SessionManager — no LLM calls needed.
 */

import { describe, expect, it } from "vitest";
import {
	applyContextMutations,
	buildCompressedMap,
	CONTEXT_ANNOTATION_TYPE,
	CONTEXT_SUMMARY_TYPE,
	CONTEXT_SYNTHESIS_TYPE,
	type ContextAnnotationData,
	type ContextSummaryData,
	collectCurationState,
	createContextSnapshot,
	formatCompressedMap,
} from "../src/core/context-curation.js";
import { SessionManager } from "../src/core/session-manager.js";

// ============================================================================
// Helpers
// ============================================================================

function createSessionWithMessages(): SessionManager {
	const sm = SessionManager.inMemory();
	sm.newSession();
	return sm;
}

function addUserMessage(sm: SessionManager, text: string): string {
	return sm.appendMessage({
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	} as any);
}

function addAssistantMessage(sm: SessionManager, text: string): string {
	return sm.appendMessage({
		role: "assistant",
		content: [{ type: "text", text }],
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "endTurn",
		timestamp: Date.now(),
	} as any);
}

function addAssistantWithToolCall(sm: SessionManager, toolName: string, args: Record<string, any>): string {
	return sm.appendMessage({
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: `tc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
				name: toolName,
				arguments: args,
			},
		],
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	} as any);
}

function addToolResult(sm: SessionManager, toolCallId: string, toolName: string, text: string): string {
	return sm.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	} as any);
}

function getToolCallId(sm: SessionManager, assistantEntryId: string): string {
	const entry = sm.getEntry(assistantEntryId);
	if (!entry || entry.type !== "message") throw new Error("Not a message entry");
	const msg = (entry as any).message;
	const tc = msg.content?.find((b: any) => b.type === "toolCall");
	if (!tc) throw new Error("No tool call in entry");
	return tc.id;
}

// ============================================================================
// collectCurationState
// ============================================================================

describe("collectCurationState", () => {
	it("returns empty state for a fresh session", () => {
		const sm = createSessionWithMessages();
		addUserMessage(sm, "hello");
		addAssistantMessage(sm, "hi there");

		const state = collectCurationState(sm.getBranch());
		expect(state.removedIds.size).toBe(0);
		expect(state.summaryCache.size).toBe(0);
		expect(state.compactedIds.size).toBe(0);
	});

	it("collects remove annotations", () => {
		const sm = createSessionWithMessages();
		const uid = addUserMessage(sm, "hello");
		const aid = addAssistantMessage(sm, "hi there");

		// Remove the user message
		sm.appendCustomEntry(CONTEXT_ANNOTATION_TYPE, {
			action: "remove",
			targetEntryId: uid,
		} satisfies ContextAnnotationData);

		const state = collectCurationState(sm.getBranch());
		expect(state.removedIds.has(uid)).toBe(true);
		expect(state.removedIds.has(aid)).toBe(false);
	});

	it("last-write-wins: restore overrides remove", () => {
		const sm = createSessionWithMessages();
		const uid = addUserMessage(sm, "hello");
		addAssistantMessage(sm, "hi");

		sm.appendCustomEntry(CONTEXT_ANNOTATION_TYPE, {
			action: "remove",
			targetEntryId: uid,
		} satisfies ContextAnnotationData);

		sm.appendCustomEntry(CONTEXT_ANNOTATION_TYPE, {
			action: "restore",
			targetEntryId: uid,
		} satisfies ContextAnnotationData);

		const state = collectCurationState(sm.getBranch());
		expect(state.removedIds.has(uid)).toBe(false);
	});

	it("ignores cached summaries by default (phase-2 feature off)", () => {
		const sm = createSessionWithMessages();
		const uid = addUserMessage(sm, "hello");
		addAssistantMessage(sm, "hi");

		sm.appendCustomEntry(CONTEXT_SUMMARY_TYPE, {
			targetEntryId: uid,
			summary: "User greeting",
			model: "test-model",
			generatedAt: new Date().toISOString(),
		} satisfies ContextSummaryData);

		const state = collectCurationState(sm.getBranch());
		expect(state.summaryCache.size).toBe(0);
	});

	it("collects cached summaries when feature flag is enabled", () => {
		const sm = createSessionWithMessages();
		const uid = addUserMessage(sm, "hello");
		addAssistantMessage(sm, "hi");

		sm.appendCustomEntry(CONTEXT_SUMMARY_TYPE, {
			targetEntryId: uid,
			summary: "User greeting",
			model: "test-model",
			generatedAt: new Date().toISOString(),
		} satisfies ContextSummaryData);

		const state = collectCurationState(sm.getBranch(), { enableSummaryCache: true });
		expect(state.summaryCache.get(uid)).toBe("User greeting");
	});
});

// ============================================================================
// buildSessionContext respects annotations
// ============================================================================

describe("buildSessionContext with curation", () => {
	it("excludes removed entries from context", () => {
		const sm = createSessionWithMessages();
		const uid = addUserMessage(sm, "first message");
		addAssistantMessage(sm, "first response");
		addUserMessage(sm, "second message");
		addAssistantMessage(sm, "second response");

		// Verify all 4 messages present before removal
		const beforeCtx = sm.buildSessionContext();
		expect(beforeCtx.messages.length).toBe(4);

		// Remove the first user message
		sm.appendCustomEntry(CONTEXT_ANNOTATION_TYPE, {
			action: "remove",
			targetEntryId: uid,
		} satisfies ContextAnnotationData);

		const afterCtx = sm.buildSessionContext();
		expect(afterCtx.messages.length).toBe(3);

		// Check the remaining messages don't include the removed one
		const userTexts = afterCtx.messages.filter((m) => m.role === "user").map((m) => (m as any).content?.[0]?.text);
		expect(userTexts).not.toContain("first message");
		expect(userTexts).toContain("second message");
	});

	it("restoring a removed entry brings it back", () => {
		const sm = createSessionWithMessages();
		const uid = addUserMessage(sm, "hello");
		addAssistantMessage(sm, "world");

		sm.appendCustomEntry(CONTEXT_ANNOTATION_TYPE, {
			action: "remove",
			targetEntryId: uid,
		} satisfies ContextAnnotationData);

		expect(sm.buildSessionContext().messages.length).toBe(1); // only assistant

		sm.appendCustomEntry(CONTEXT_ANNOTATION_TYPE, {
			action: "restore",
			targetEntryId: uid,
		} satisfies ContextAnnotationData);

		expect(sm.buildSessionContext().messages.length).toBe(2); // both back
	});

	it("removing a tool result removes just that result", () => {
		const sm = createSessionWithMessages();
		addUserMessage(sm, "read the file");
		const assistId = addAssistantWithToolCall(sm, "read", { path: "foo.ts" });
		const tcId = getToolCallId(sm, assistId);
		const resultId = addToolResult(sm, tcId, "read", "file content here...");
		addAssistantMessage(sm, "I read the file");

		expect(sm.buildSessionContext().messages.length).toBe(4);

		sm.appendCustomEntry(CONTEXT_ANNOTATION_TYPE, {
			action: "remove",
			targetEntryId: resultId,
		} satisfies ContextAnnotationData);

		const ctx = sm.buildSessionContext();
		expect(ctx.messages.length).toBe(3); // user, assistant(toolCall), assistant(text)
	});

	it("synthesis entries appear in context", () => {
		const sm = createSessionWithMessages();
		addUserMessage(sm, "hello");
		addAssistantMessage(sm, "hi");

		sm.appendCustomMessageEntry(CONTEXT_SYNTHESIS_TYPE, "## Status\n\nEverything is fine", true);

		const ctx = sm.buildSessionContext();
		expect(ctx.messages.length).toBe(3); // user, assistant, synthesis
	});
});

// ============================================================================
// applyContextMutations
// ============================================================================

describe("applyContextMutations", () => {
	it("supports display aliases (N-xxx) for remove/restore", () => {
		const sm = createSessionWithMessages();
		addUserMessage(sm, "alpha");
		addAssistantMessage(sm, "beta");
		addUserMessage(sm, "gamma");

		const snapshot = createContextSnapshot(sm.getBranch());
		const alias = `N-${String(snapshot.lines[0].displayIndex).padStart(3, "0")}`;

		const removed = applyContextMutations(sm, {
			remove: [alias],
			currentLeafId: sm.getLeafId(),
		});
		expect(removed.removedCount).toBe(1);
		expect(sm.buildSessionContext().messages.length).toBe(2);

		const restored = applyContextMutations(sm, {
			restore: [alias],
			currentLeafId: sm.getLeafId(),
		});
		expect(restored.restoredCount).toBe(1);
		expect(sm.buildSessionContext().messages.length).toBe(3);
	});

	it("cascade-removes direct tool results when removing assistant tool-call entry", () => {
		const sm = createSessionWithMessages();
		addUserMessage(sm, "read this");
		const assistId = addAssistantWithToolCall(sm, "read", { path: "foo.ts" });
		const tcId = getToolCallId(sm, assistId);
		addToolResult(sm, tcId, "read", "contents");
		addAssistantMessage(sm, "done");

		const result = applyContextMutations(sm, {
			remove: [assistId],
			currentLeafId: sm.getLeafId(),
		});
		expect(result.removedCount).toBe(2); // assistant + direct tool result

		const ctx = sm.buildSessionContext();
		// keep: user + final assistant
		expect(ctx.messages.length).toBe(2);
	});

	it("warns and skips restore behind compaction boundary", () => {
		const sm = createSessionWithMessages();
		const oldId = addUserMessage(sm, "old");
		addAssistantMessage(sm, "old-r");
		const keepId = addUserMessage(sm, "new");
		addAssistantMessage(sm, "new-r");

		sm.appendCompaction("summary", keepId, 100, undefined, false);

		const result = applyContextMutations(sm, {
			restore: [oldId],
			currentLeafId: sm.getLeafId(),
		});

		expect(result.restoredCount).toBe(0);
		expect(result.warnings.some((w) => w.includes("compaction boundary"))).toBe(true);
	});
});

// ============================================================================
// buildCompressedMap
// ============================================================================

describe("buildCompressedMap", () => {
	it("generates map lines for user and assistant entries", () => {
		const sm = createSessionWithMessages();
		addUserMessage(sm, "tell me about cats");
		addAssistantMessage(sm, "cats are wonderful creatures");

		const path = sm.getBranch();
		const state = collectCurationState(path);
		const lines = buildCompressedMap(path, state);

		expect(lines.length).toBe(2);
		expect(lines[0].kind).toBe("user");
		expect(lines[0].description).toContain("cats");
		expect(lines[1].kind).toBe("assistant");
		expect(lines[1].description).toContain("wonderful");
	});

	it("shows read tool results with file path", () => {
		const sm = createSessionWithMessages();
		addUserMessage(sm, "read this");
		const assistId = addAssistantWithToolCall(sm, "read", { path: "src/core/session-manager.ts" });
		const tcId = getToolCallId(sm, assistId);
		addToolResult(sm, tcId, "read", "lots of code...");

		const path = sm.getBranch();
		const state = collectCurationState(path);
		const lines = buildCompressedMap(path, state);

		// user, assistant(toolCall), toolResult
		const readLine = lines.find((l) => l.kind === "read");
		expect(readLine).toBeDefined();
		expect(readLine!.description).toContain("session-manager.ts");
	});

	it("marks removed entries", () => {
		const sm = createSessionWithMessages();
		const uid = addUserMessage(sm, "stale message");
		addAssistantMessage(sm, "stale response");

		sm.appendCustomEntry(CONTEXT_ANNOTATION_TYPE, {
			action: "remove",
			targetEntryId: uid,
		} satisfies ContextAnnotationData);

		const path = sm.getBranch();
		const state = collectCurationState(path);
		const lines = buildCompressedMap(path, state);

		const removedLine = lines.find((l) => l.entryId === uid);
		expect(removedLine).toBeDefined();
		expect(removedLine!.isRemoved).toBe(true);
	});

	it("shows synthesis entries", () => {
		const sm = createSessionWithMessages();
		addUserMessage(sm, "hello");
		addAssistantMessage(sm, "hi");

		sm.appendCustomMessageEntry(CONTEXT_SYNTHESIS_TYPE, "## Working Memory\n\nProject status: good", true);

		const path = sm.getBranch();
		const state = collectCurationState(path);
		const lines = buildCompressedMap(path, state);

		const synthLine = lines.find((l) => l.kind === "synthesis");
		expect(synthLine).toBeDefined();
		expect(synthLine!.isSynthesis).toBe(true);
		expect(synthLine!.description).toContain("Working Memory");
	});

	it("uses cached summary when available", () => {
		const sm = createSessionWithMessages();
		const uid = addUserMessage(sm, "a very long message about many things that would normally be previewed");
		addAssistantMessage(sm, "ok");

		sm.appendCustomEntry(CONTEXT_SUMMARY_TYPE, {
			targetEntryId: uid,
			summary: "User asked about many things",
			model: "test-model",
			generatedAt: new Date().toISOString(),
		} satisfies ContextSummaryData);

		const path = sm.getBranch();
		const state = collectCurationState(path, { enableSummaryCache: true });
		const lines = buildCompressedMap(path, state);

		const userLine = lines.find((l) => l.entryId === uid);
		expect(userLine!.description).toContain("User asked about many things");
	});

	it("skips annotation CustomEntry entries from the map", () => {
		const sm = createSessionWithMessages();
		const uid = addUserMessage(sm, "hello");
		addAssistantMessage(sm, "hi");

		sm.appendCustomEntry(CONTEXT_ANNOTATION_TYPE, {
			action: "remove",
			targetEntryId: uid,
		} satisfies ContextAnnotationData);

		const path = sm.getBranch();
		const state = collectCurationState(path);
		const lines = buildCompressedMap(path, state);

		// Should only have user and assistant, not the annotation entry
		const kinds = lines.map((l) => l.kind);
		expect(kinds).not.toContain("custom");
		expect(lines.length).toBe(2);
	});
});

// ============================================================================
// formatCompressedMap
// ============================================================================

describe("formatCompressedMap", () => {
	it("formats empty map", () => {
		expect(formatCompressedMap([])).toBe("(no entries)");
	});

	it("includes entry IDs and display aliases", () => {
		const sm = createSessionWithMessages();
		addUserMessage(sm, "hello");
		addAssistantMessage(sm, "hi");

		const path = sm.getBranch();
		const state = collectCurationState(path);
		const lines = buildCompressedMap(path, state);
		const text = formatCompressedMap(lines);

		expect(text).toContain("N-001");
		expect(text).toContain("N-002");
		expect(text).toContain("[user]");
		expect(text).toContain("[assistant]");
		// Should contain real entry IDs in parens
		expect(text).toContain(`(${lines[0].entryId})`);
	});

	it("shows REMOVED marker for removed entries", () => {
		const sm = createSessionWithMessages();
		const uid = addUserMessage(sm, "gone");
		addAssistantMessage(sm, "ok");

		sm.appendCustomEntry(CONTEXT_ANNOTATION_TYPE, {
			action: "remove",
			targetEntryId: uid,
		} satisfies ContextAnnotationData);

		const path = sm.getBranch();
		const state = collectCurationState(path);
		const lines = buildCompressedMap(path, state);
		const text = formatCompressedMap(lines);

		expect(text).toContain("⊘ REMOVED");
	});
});
