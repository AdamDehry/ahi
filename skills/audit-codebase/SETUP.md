# audit-codebase Setup

This skill is optional. It ships with the public AHI framework but needs user
configuration before it can run.

Optional tools:

- `gh` CLI for GitHub PR/comment inspection
- Codex CLI if using the `codex-consult` second-opinion layer
- Stack-specific CLIs such as Supabase only when auditing a repo that uses them

The skill works without GitHub Apps; unavailable bot layers are reported as
inactive instead of failing the audit.

