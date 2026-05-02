# COLONY-PATCHES.md

This document tracks all Colony-specific patches applied on top of the
upstream OpenClaw gateway releases. The `colony` branch is rebased onto
upstream `main` and contains the following patches:

---

## Patch 1: Clicky Voice Companion Tool Disabling — UPSTREAMED

**Original commit:** `ca0aad307e`
**Upstreamed as:** `6512e554d` ("strip tools for Clicky voice companion sessions")
**Status:** ✅ Merged into upstream. No colony-specific changes needed on rebase.
**Files changed (original):**
- `src/agents/clicky-voice-tools.ts` (new)
- `src/agents/clicky-voice-tools.test.ts` (new)
- `src/agents/pi-embedded-runner/compact.ts` (modified)
- `src/agents/pi-embedded-runner/run/attempt.ts` (modified)

---

## Patch 2: (Upstreamed)

Already included in `v2026.4.15`. No colony-specific changes needed.

---

## Patch 3: execCommand Direct-Exec Sandbox Mode

**Status:** Active (re-applied on rebase)
**Files changed:**
- `src/agents/subagent-spawn.types.ts` (modified — added `"direct-exec"` to `SUBAGENT_SPAWN_SANDBOX_MODES`)
- `src/agents/subagent-spawn.ts` (modified)
- `src/agents/tools/sessions-spawn-tool.ts` (modified)

**Purpose:**
Allows spawning a subagent that directly executes a command in the
sandbox container *without* running a full agent conversation loop. This
is used by Clicky's voice companion to run quick commands (e.g., file
reads, shell commands) with minimal latency and token cost.

**Implementation:**
- `SpawnSubagentParams` gets an optional `execCommand: string[]` field
- `SpawnSubagentResult.status` gains `"ok"` variant with `directExec`,
  `stdout`, `stderr`, `exitCode` fields
- `runDirectExecInSandbox()` resolves sandbox context via
  `resolveSandboxContext`, builds docker exec args via
  `buildDockerExecArgs`, runs the command with `execDocker`
- Early-return in `spawnSubagentDirect()`: if `execCommand` is present,
  routes to `runDirectExecInSandbox` instead of spawning a sub-agent
- Tool layer validates `execCommand` as a non-empty string array
  (`minItems: 1, maxItems: 32`) and requires `sandbox=direct-exec`
- `SUBAGENT_SPAWN_SANDBOX_MODES` and `SESSIONS_SPAWN_SANDBOX_MODES`
  both include `"direct-exec"`
- `sessions-spawn-tool.ts` validates mutual requirement:
  `execCommand` requires `sandbox=direct-exec` and vice versa

**Imports added to subagent-spawn.ts:**
- `buildDockerExecArgs` from `./bash-tools.shared.js`
- `resolveSandboxContext` from `./sandbox.js`
- `execDocker` from `./sandbox/docker.js`
- `DEFAULT_PATH` from `./bash-tools.exec-runtime.js`

---

## Rebase/Merge History

- **v2026.4.15 → v2026.4.29** (May 2026): Merge via `git merge v2026.4.29`.
  - Conflicts in `subagent-spawn.ts` (our `runDirectExecInSandbox` vs upstream's
    `buildThreadBindingUnavailableError` — kept both, they are independent)
  - Conflicts in `sessions-spawn-tool.ts` (schema + validation — combined colony
    execCommand with upstream contextMode/lightContext/attachments additions)
  - `subagent-spawn.types.ts` auto-merged: `"direct-exec"` in sandbox modes,
    upstream added `SUBAGENT_SPAWN_CONTEXT_MODES` (`"isolated" | "fork"`)
  - All colony imports verified: `buildDockerExecArgs`, `resolveSandboxContext`,
    `execDocker`, `DEFAULT_PATH` all still export from same paths in v4.29
  - Note: upstream added `contextMode` ("forked") as a separate dimension from
    `sandboxMode`. Our `"direct-exec"` addition to sandboxMode coexists cleanly.

## Rebase Notes

When merging onto a new upstream release:

1. `COLONY-PATCHES.md` — Always keep (re-apply after merge)
2. Patch 1 (Clicky voice tools) — **Already upstreamed.** Do not re-apply.
3. Patch 3 (execCommand) — May conflict if `subagent-spawn.ts`,
   `subagent-spawn.types.ts`, or `sessions-spawn-tool.ts` change
   upstream. Key things to watch:
   - `buildDockerExecArgs` import path (`./bash-tools.shared.js`)
   - `DEFAULT_PATH` import path (`./bash-tools.exec-runtime.js`)
   - `resolveSandboxContext` import path (`./sandbox.js`)
   - `execDocker` import path (`./sandbox/docker.js`)
   - The `SpawnSubagentParams` and `SpawnSubagentResult` type definitions
   - The `SessionsSpawnToolSchema` TypeBox object
4. Prefer **merge** over rebase to preserve history traceability.
   Re-apply patches surgically when conflict resolution is needed.

## Branch Strategy

- `main` branch on `jacksoel/openclaw-gateway`: mirrors upstream `main`
  (fast-forward only via `git reset --hard upstream/main`)
- `colony` branch: based on `main`, contains all active colony patches
- Force-push `colony` is acceptable (rewrite-based workflow)
- Always merge (never rebase) colony onto upstream tags