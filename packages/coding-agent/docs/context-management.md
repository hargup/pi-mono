# Context Management (`/context`)

Use `/context` to inspect and curate what parts of the current branch are sent to the model.

This is **non-destructive**: entries are not deleted from the session file. Pi stores remove/restore annotations and computes the effective context from them.

## Quick Start

```text
/context
/context remove N-003,N-004
/context restore N-003
/context note Plan :: Keep focus on failing tests first
/context reset
```

## What `/context` Shows

`/context` prints a compact map of context-participating entries:

- display alias: `N-001`, `N-002`, ...
- real entry ID: `(ab12cd34)`
- kind: `[user]`, `[assistant]`, `[read]`, `[bash]`, `[synthesis]`, etc.
- removed marker: `⊘ REMOVED`

You can use either **real IDs** or **aliases** (`N-xxx`) in remove/restore operations.

## Commands

- `/context`  
  Inspect current context map.

- `/context remove <id,...>`  
  Exclude entries from effective context.

- `/context restore <id,...>`  
  Re-include previously removed entries.

- `/context note <title> :: <body>`  
  Append a synthesis node (`context_synthesis`) as working memory.

- `/context json {remove:[...],restore:[...],add_synthesis:[...]}`  
  Batch operations in one command.

- `/context reset`  
  Restore all currently removed entries visible in the current map.

## Behavior & Guardrails

- Remove/restore is **last-write-wins**.
- Removing the current in-flight leaf entry is blocked.
- Removing an assistant tool-call message cascades to direct child tool-result entries.
- Restoring an entry behind a compaction boundary is skipped with a warning.
- Runtime context is refreshed immediately after apply operations.

## Deprecated Alias

`/context-manage` still forwards to `/context`, but it is deprecated and hidden from slash-command discovery.

## Tool Interface (`context_manage`)

For model/tool usage, pi exposes `context_manage` with two modes:

- `mode: "inspect"` → returns the current formatted context snapshot
- `mode: "apply"` → applies `remove`, `restore`, `add_synthesis`

Example payload:

```json
{
  "mode": "apply",
  "remove": ["N-003"],
  "restore": ["a1b2c3d4"],
  "add_synthesis": [
    { "title": "Status", "body": "Read files done; now patch tests." }
  ]
}
```

## Summary Cache Feature Flag (Phase 2)

`context_summary` cache reading is currently off by default.

For implementation details, invariants, and extension guidance, see [context-management-dev.md](./context-management-dev.md).

Enable it with:

```bash
export PI_CONTEXT_SUMMARY_CACHE=1
```

When enabled, map lines can prefer cached summaries for user/assistant entries.

## How to Test

### Automated

From `packages/coding-agent`:

```bash
npm test -- context-curation.test.ts interactive-mode-status.test.ts session-manager/build-context.test.ts compaction.test.ts
```

### Manual (Interactive)

1. Start pi in any repo.
2. Create a short history with at least one tool call.
3. Run `/context` and note one alias (e.g. `N-003`).
4. Run `/context remove N-003` and confirm `⊘ REMOVED` appears.
5. Ask a follow-up question and verify behavior reflects the pruned context.
6. Run `/context restore N-003` and confirm it returns.
7. Add working memory via `/context note Focus :: Finish regression tests`.
8. Run `/context reset` to clear all removals.

## Common Errors

- `Unknown entry IDs: ...`  
  Use IDs shown in `/context` output.

- `Cannot remove current in-flight entry.`  
  Wait until current turn finishes, then retry.

- `...behind compaction boundary; restore skipped.`  
  Entry content has been compacted and is no longer restorable as raw message content.
