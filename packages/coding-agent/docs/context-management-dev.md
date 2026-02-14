# Context Management Internals (Developer Guide)

This document explains the implementation of the `/context` feature and the `context_manage` tool, including data flow, invariants, and extension points.

For user-facing usage, see [context-management.md](./context-management.md).

## Source Files

Primary implementation files:

- `src/core/context-curation.ts` — core inspect/apply engine
- `src/core/tools/context-manage.ts` — thin agent tool wrapper
- `src/modes/interactive/interactive-mode.ts` — `/context` command parsing + display
- `src/core/agent-session.ts` — tool registration + runtime rehydrate hook
- `src/core/session-manager.ts` — effective context resolution (`buildSessionContext`)
- `test/context-curation.test.ts` — mutation + map unit coverage

## Design Goals

1. **Single mutation engine**: one deterministic apply path for all interfaces
2. **Thin adapters**: tool/TUI parse inputs, delegate to core, render output
3. **Non-destructive curation**: annotate remove/restore, never rewrite history
4. **Immediate runtime consistency**: after mutation, refresh the live agent context
5. **Phase-1 scope control**: remove/restore/synthesis first; summary-cache is gated

## Session Data Model

Context curation is encoded in session entries using existing primitives:

- `custom` entry (`customType: "context_annotation"`)
  - `{ action: "remove" | "restore", targetEntryId: string, ... }`
- `custom_message` entry (`customType: "context_synthesis"`)
  - synthesis note that *does* participate in LLM context
- `custom` entry (`customType: "context_summary"`)
  - optional summary cache; currently gated behind feature flag

### Why this model

- Keeps auditability (append-only session log)
- Reuses existing persistence and branching behavior
- Avoids special-case storage/migration for phase 1

## Runtime Flow

### 1) Interactive `/context` path

`interactive-mode.ts`:

1. Parse `/context ...` args (`remove`, `restore`, `note`, `json`, `reset`)
2. Call `applyContextMutations(sessionManager, input)`
3. Call `session.refreshContextFromSession()`
4. Render updated snapshot (`createContextSnapshot` + `formatContextSnapshot`)

`/context-manage` remains a deprecated alias that forwards to `/context`.

### 2) Agent tool path (`context_manage`)

`context-manage.ts`:

- `mode: "inspect"` → snapshot only
- `mode: "apply"` → `applyContextMutations(...)`
- On success invokes `onMutated` callback (wired by `AgentSession`)

`agent-session.ts` registers:

- `context_manage` in base tool registry
- `onMutated: () => refreshContextFromSession()`

### 3) Effective-context resolution

`session-manager.ts::buildSessionContext()`:

- Walks branch path leaf→root
- Reads `context_annotation` entries with last-write-wins semantics
- Filters out removed IDs when appending messages to runtime context

This is the final source of truth for what the LLM sees.

## Core APIs (`context-curation.ts`)

### Inspection

- `collectCurationState(path, options?)`
- `buildCompressedMap(path, state, options?)`
- `createContextSnapshot(path, options?)`
- `formatContextSnapshot(snapshot, prefix?)`

### Mutation

- `applyContextMutations(sessionManager, input)`

Input shape:

- `remove?: string[]`
- `restore?: string[]`
- `addSynthesis?: Array<{ title: string; body: string }>`
- `currentLeafId?: string | null`

Result shape:

- `removedCount`, `restoredCount`, `synthesisAdded`, `warnings[]`

## Invariants & Guardrails

`applyContextMutations` enforces:

1. Reject empty apply requests (no operations)
2. Reject unknown entry IDs/aliases
3. Reject removing the current in-flight leaf
4. Cascade remove assistant tool-call entry → direct child tool-result entries
5. Restore behind compaction boundary is skipped with warning
6. Synthesis nodes with empty title/body are skipped with warning

## Alias Resolution

Context map exposes `N-xxx` display aliases. Resolver behavior:

- Accept real IDs and aliases in remove/restore
- Resolve aliases against current snapshot map
- De-duplicate resolved IDs
- Return unknown IDs for hard failure

## Summary Cache Flag (Phase 2)

Summary cache consumption is intentionally off by default.

- Env var: `PI_CONTEXT_SUMMARY_CACHE=1`
- Constant: `CONTEXT_SUMMARY_CACHE_ENV`
- Helper: `isContextSummaryCacheEnabled()`

Per-call override is available for testing/internal calls via:

- `collectCurationState(path, { enableSummaryCache: true })`
- `createContextSnapshot(path, { enableSummaryCache: true })`

## Testing Strategy

Key tests live in `test/context-curation.test.ts`:

- annotation collection (remove/restore last-write-wins)
- alias resolution (`N-xxx`)
- cascade removal of tool results
- compaction-boundary restore warning
- map formatting and synthesis visibility
- summary-cache disabled-by-default + enabled path

Recommended command:

```bash
npm test -- context-curation.test.ts interactive-mode-status.test.ts session-manager/build-context.test.ts compaction.test.ts
```

## How to Extend Safely

If you add new mutation operations:

1. Extend `ContextMutationInput` and schema in `context-manage.ts`
2. Implement behavior in `applyContextMutations` (single source)
3. Keep interactive parser as adapter only (no mutation logic)
4. Preserve deterministic results + explicit warnings/errors
5. Add tests for both success and guardrail paths

If you add auto-curation triggers (e.g. context usage thresholds):

- Trigger should call the same mutation engine
- Avoid parallel mutation paths
- Ensure runtime refresh remains centralized

## Known Intentional Constraints

- No sub-node/block-level edits inside a message in phase 1
- Restore cannot reconstruct entries compacted away behind boundary
- `/context-manage` is compatibility-only and not discoverable in slash command list
