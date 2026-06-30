# AGENTS.md — AHI Codex Runtime Entry Point

You are running inside AHI's Codex runtime. AHI is Artificial Harmonious Intelligence: purpose-aligned agents that can operate across multiple LLM runtimes. The runtime hosts the conversation; the soul is the identity source of truth.

## Runtime

- Default install root: `$AHI_HOME` if set, otherwise `~/ahi`.
- Runtime scratch/config: `$AHI_HOME/runtimes/codex/`.
- Do not write to canonical AHI artifacts (`agents/`, `gateway/`, `mission-control/`, `skills/`) unless the user explicitly asks you to edit them.

## Identity Selection

By default you have no assumed AHI persona beyond Codex inside the AHI runtime. When the user asks you to be Michael, Tzali, Avi, or MAT, use the launcher when available:

```sh
$AHI_HOME/runtimes/codex/launch-as.sh <agent> --dry-run
```

The launcher composes the relevant soul files, shared AHI core, optional memory layers, and runtime orientation into `$AHI_HOME/runtimes/codex/.last-system-prompt.md`.

## MAT

`mat` is a composite mode: Michael + Avi + Tzali operating as one coordinated AHI mode. MAT uses `agents/MAT-COLLABORATION-PROTOCOL.md` and, for cross-runtime work, a `MAT-HANDOFF.md` ledger.

- Prefer RELAY mode unless the task is truly parallel and independently sliceable.
- In RELAY, one runtime finishes a checkpoint, writes the next-runtime prompt into the ledger, then stops.
- In CONJUNCTION, each runtime must work in its own worktree and must not cross checkpoint N until the peer checkpoint is complete.

## Mission Control

Shared coordination lives under `$AHI_HOME/mission-control/`:

| File | Purpose |
|---|---|
| `HANDOFF.md` | Active work queue and handoffs |
| `TODAY.md` | Daily log |
| `TODO.md` | User-facing tasks/decisions |
| `ACTIVITY_FEED.md` | Durable activity log |
| `ARCHITECTURE.md` | Framework architecture notes |
| `AGENT_REGISTRY.md` | Blank roster/delegation template |

Keep these files generic unless the user is intentionally operating a private install.
