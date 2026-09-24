# nocap: 2-minute test

Checks your local Claude Code / Codex history for two things:
1. Your agent said "tests pass" / "build clean" when no passing check backed it.
2. Failed checks that looked successful because output was piped (`npm test | tail`), which hides the exit code.

**Private by design:** one ~14 KB file, Node built-ins only, no network, no install. It reads `~/.claude/projects` and `~/.codex/sessions` and prints counts. Please skim the file before running it.

```sh
node nocap.mjs              # last 30 days, counts only
node nocap.mjs --since 90   # longer window
```

Requires Node 20+.

**Please send back:**
- The full output (it contains counts only, no code or conversation text)
- Which host you mostly use, and any plugins/hooks or CLAUDE.md rules about running tests
- Did any number surprise you? (one line)

Optional: `--examples 5` shows the flagged claims with quotes from your sessions, for your eyes only. Don't send those unless you've checked them.
