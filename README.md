# nocap 🧢

**Your coding agent said "all tests pass." Was that cap?**

<sub>For everyone over 30: "no cap" is slang for "no lie." So: is your coding agent lying when it says the tests pass?</sub>

nocap reads your local Claude Code and Codex history and checks every "tests pass", "build clean" and "verified" claim against the commands the agent actually ran. It also finds failed checks that looked green because the output went through a pipe (`npm test | tail`), which throws away the exit code.

- **Zero tokens.** No model calls, no prompt, no skill loaded into your agent's context. It's a plain Node script that reads files.
- **Deterministic.** Pattern matching, not an LLM judge. Same transcripts in, same numbers out, every run.
- **Local.** No network, no dependencies, one file you can read in five minutes.

The author's own last 30 days, default output (version line trimmed):

```
Scanned 1546 agent sessions.

Agents claimed "tests pass / build clean / verified" 206 times:
  backed        175	(85%)  a passing check ran after the last edit
  unbacked      17	(8%)  no check ran in that turn
  contradicted  9	(4%)  the last check in that turn failed
  stale         5	(2%)  code was edited after the last passing check

Checks run: 1274, failed: 98, failures hidden by "| tail"-style pipes: 38
Retry loops (same command failed 3+ times in a session): 6

By host and active plugins (sessions with checks or claims):
  claude: caveman+ponytail     514 sessions, 686 checks, 56 failed, 36 hidden by pipes, 170 claims (145 backed)
  claude: other-hooks          842 sessions, 0 checks, 0 failed, 0 hidden by pipes, 1 claims (0 backed)
  codex: none                  161 sessions, 588 checks, 42 failed, 2 hidden by pipes, 35 claims (30 backed)

Heuristic audit of local transcripts. Nothing left this machine.
```

31 claims not backed by a passing check. 38 of 98 failed checks exited 0 because of a pipe.

**About these numbers:** one developer's machine, so read them as an anecdote, not a benchmark. Claude Code ran with the [caveman](https://github.com/JuliusBrussee/caveman) and [ponytail](https://github.com/DietrichGebert/ponytail) plugins, which inject instructions through hooks. Codex ran with none. The two hosts got different work, so the split isn't a Claude vs Codex comparison. `other-hooks` means Claude sessions with other hooks active and no checks at all. Plugins are detected from hook context only, never from what you type. The table above is the only thing that left the machine to make this README: counts, no transcript text.

## Run it

```sh
npx @superlogicai/nocap              # last 30 days, counts only
npx @superlogicai/nocap --since 90   # longer window
```

Requires Node 20+.

| Option | What it does |
|---|---|
| `--since <days>` | How far back to look (default 30) |
| `--project <text>` | Only transcripts whose path contains this text |
| `--examples <n>` | Show the n most recent flagged claims, quoted from your sessions |
| `--format json` | Machine-readable output |

## Or let your agent do it

Paste into Claude Code:

> Run `npx -y @superlogicai/nocap` and show me the summary exactly as printed. Don't use `--examples`. Then install the nocap pipefail hook: run `npm i -g @superlogicai/nocap` and add a `PreToolUse` hook to `~/.claude/settings.json` with matcher `Bash` and command `nocap hook`. Merge it with any hooks already there, and show me the diff before saving.

For Codex, use the first sentence only. The hook is Claude Code only for now.

## Private by design

One ~14 KB file, Node built-ins only, no dependencies, no network. It reads `~/.claude/projects` and `~/.codex/sessions` (or `CLAUDE_CONFIG_DIR` / `CODEX_HOME`) and prints counts. Skim `dist/audit.js` before you run it.

The default output contains counts only, no code or conversation text. `--examples` quotes your sessions: check what's in it before sharing.

## Stop hidden failures: the pipefail hook

The fix for piped checks is `set -o pipefail`. nocap ships a Claude Code `PreToolUse` hook that adds it to test, lint, typecheck and build commands that pipe their output. Everything else passes through untouched, and any error leaves the command as it was. Like the audit, it makes no model calls and adds nothing to your prompt. The only visible change is a failing exit code where a pipe used to hide one.

```sh
npm i -g @superlogicai/nocap
```

Then in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "nocap hook" }] }
    ]
  }
}
```

## How it decides

Claim detection is heuristic: regex over the agent's messages, with a negation filter ("should pass", "once tests pass" don't count). A claim is **backed** only if the last recognized check in that turn (`npm test`, `tsc`, `pytest`, `cargo test`, `go test`, `eslint`, …) passed and no code was edited after it. A piped check counts as failed when it exits 0 but its output shows failures. Edits to Markdown and text files don't count as code edits.

Expect some false positives. If nocap flags something wrong, open an issue with the `--examples` line (redacted as needed).

## License

MIT
