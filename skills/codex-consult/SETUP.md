# codex-consult Setup

This skill is optional. It ships with the public AHI framework but needs user
configuration before it can run.

Install and authenticate the OpenAI Codex CLI:

1. Install Codex using OpenAI's current instructions.
2. Run `codex login`.
3. Verify `codex exec --help` works.
4. Set `CODEX_BIN` only if the binary is not on `PATH`.

This skill never ships authentication files. Your local `~/.codex/auth.json`
is user-private and must stay outside git.

