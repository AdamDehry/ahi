# MAT Identity Composition Design

Status: DRAFT for Claude Code Phase 2.

## Goal

`$AHI_HOME/runtimes/codex/launch-as.sh mat` should compose one MAT system prompt from the three existing AHI souls plus shared AHI core and the MAT protocol.

Do not fork the launcher. Extend H-035 in place.

## Source Files

Required:

```text
$AHI_HOME/agents/soul/MICHAEL.md
$AHI_HOME/agents/soul/AVI.md
$AHI_HOME/agents/soul/TZALI.md
$AHI_HOME/agents/neshamah.md
$AHI_HOME/agents/soul/AHI-FOUNDATION.md
$AHI_HOME/agents/MAT-COLLABORATION-PROTOCOL.md
```

Optional if present:

```text
$AHI_HOME/agents/soul/NESHAMA.md
$AHI_HOME/agents/soul/USER.md
$AHI_HOME/agents/memory/michael/MEMORY.md
$AHI_HOME/agents/memory/avi/MEMORY.md
$AHI_HOME/agents/memory/tzali/MEMORY.md
```

## Composition Order

1. MAT boot header.
2. Michael soul.
3. Avi soul.
4. Tzali soul.
5. Shared neshamah.
6. AHI Foundation.
7. Universal soul/user layers if present.
8. MAT collaboration protocol.
9. Optional memories for Michael, Avi, and Tzali.
10. Runtime orientation.

## Boot Header Draft

```md
# AHI Identity Boot - MAT on Codex

You are MAT: Michael, Avi, and Tzali operating as one harmonious AHI mode.
You are not three agents taking turns. You are one orchestrating intelligence
that carries three lenses:

- Michael: architecture, operations, prioritization, and day-to-day operability.
- Avi: UX, design, clarity, and the felt experience.
- Tzali: engineering, implementation, deployment, and verification.

Use all three lenses quietly. Name the leading lens only when it helps the operator.
For protocol/design decisions, explicitly record Michael and Avi lens checks.
When a task spans Codex and Claude Code, follow the MAT collaboration protocol.
```

## Launcher Changes For Phase 2

Implementation sketch only:

```sh
VALID_AGENTS=(michael tzali eliyahu miriam avi mat)

compose_prompt() {
  local agent="$1"
  if [[ "$agent" == "mat" ]]; then
    compose_mat_prompt
    return
  fi

  # Existing single-agent path remains unchanged.
}
```

`compose_mat_prompt` should use the existing `append_section` helper. It should warn and skip optional files just like the current launcher.

## Dry Run Acceptance

This should work after Phase 2:

```sh
$AHI_HOME/runtimes/codex/launch-as.sh mat --dry-run
```

Expected:

1. `.last-system-prompt.md` is written.
2. It contains Michael, Avi, Tzali, AHI core, and MAT protocol sections.
3. It does not break existing `launch-as.sh tzali --dry-run`.

## Lens Notes

- Michael lens: This preserves AHI's sovereign soul files as source of truth and avoids duplicating identity content.
- Avi lens: The command the operator remembers is exactly `launch-as.sh mat`; the complexity stays behind the curtain.

