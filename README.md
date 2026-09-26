<p align="center">
<img src="look-what-i-can-do.svg" width="800" alt="agent-nocap 🧢: Your coding agent said &quot;all tests pass.&quot; Was that cap?">
</p>

# agent-nocap 🧢

**Your coding agent said "all tests pass." Was that cap?**

<sub>For everyone over 30: "no cap" is slang for "no lie." So: is your coding agent lying when it says the tests pass?</sub>

agent-nocap reads your local Claude Code and Codex history and checks every "tests pass", "build clean" and "verified" claim against the commands the agent actually ran. It also finds failed checks that looked green because the output went through a pipe (`npm test | tail`), which throws away the exit code.

- **Zero tokens.** No model calls, no prompt, no skill loaded into your agent's context. It's a plain Node script that reads files.
- **Deterministic.** Pattern matching, not an LLM judge. Same transcripts in, same numbers out, every run.
- **Local.** No network, no dependencies, one file you can read in five minutes.

The author's own last 30 days, default output (version line trimmed):

```
Scanned 1525 agent sessions; 148 ran checks or made claims.

Agents claimed "tests pass / build clean / verified" 226 times:
  backed        207	(92%)  a matching check passed after the last edit
  unbacked      9	(4%)  no matching check with a known result before it
  contradicted  8	(4%)  the last matching check before it failed
  stale         2	(1%)  code was edited after the last passing check

Checks run: 1201, failed: 149, failures hidden by "| tail"-style pipes: 26
Retry loops (same command failed 3+ times in a session): 9

By host and active plugins (sessions that ran checks or made claims):
  claude: caveman+ponytail     93 sessions, 629 checks, 38 failed, 25 hidden by pipes, 193 claims (183 backed)
  claude: none                 3 sessions, 10 checks, 1 failed, 1 hidden by pipes, 0 claims (0 backed)
  claude: other-hooks          1 sessions, 0 checks, 0 failed, 0 hidden by pipes, 1 claims (0 backed)
  codex: none                  51 sessions, 562 checks, 110 failed, 0 hidden by pipes, 32 claims (24 backed)

Stop pipes hiding failures: the pipefail hook adds `set -o pipefail` to piped checks. See the README.

Heuristic audit of local transcripts. Nothing left this machine.
Agent-nocap by //Super Logic AI · github.com/SuperLogicAI/agent-nocap
```

19 claims not backed by a passing check. 26 of 149 failed checks exited 0 because of a pipe.

Version 0.1 put the same history at 85% backed. It let a passing lint back "all tests pass", counted `grep jest` as a test run, and scored Codex scripts that dropped their exit code as passes, including ones whose output said `1 failed`. 0.2 fixed all three and swung too strict, at 78%: it counted ESLint warnings as failures, read quoted claims as the agent's own, and couldn't see the exit code of most Codex checks. 0.3 fixes those. It reads the exit codes Codex logs for every command, and a passing check now backs a claim until the next code edit, even across turns.

**About these numbers:** one developer's machine, so read them as an anecdote, not a benchmark. Claude Code ran with the [caveman](https://github.com/JuliusBrussee/caveman) and [ponytail](https://github.com/DietrichGebert/ponytail) plugins, which inject instructions through hooks. Codex ran with none. The two hosts got different work, so the split isn't a Claude vs Codex comparison. `other-hooks` means Claude sessions with other hooks active, and `none` means no hook context at all, which includes subagents. Most scanned sessions were one-shot SDK calls with no commands, so they're scanned but left out of the counts. Plugins are detected from hook context only, never from what you type. The table above is the only thing that left the machine to make this README: counts, no transcript text.

## Run it

```sh
npx agent-nocap              # last 30 days, counts only
npx agent-nocap --since 90   # longer window
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

> Run `npx -y agent-nocap` and show me the summary exactly as printed. Don't use `--examples`. Then install the nocap pipefail hook: run `npm i -g agent-nocap` and add a `PreToolUse` hook to `~/.claude/settings.json` with matcher `Bash` and command `nocap hook`. Merge it with any hooks already there, and show me the diff before saving.

For Codex, use the first sentence only. The hook is Claude Code only for now.

## Private by design

One ~22 KB file, Node built-ins only, no dependencies, no network. It reads `~/.claude/projects` and `~/.codex/sessions` (or `CLAUDE_CONFIG_DIR` / `CODEX_HOME`) and prints counts. Skim `dist/audit.js` before you run it.

The default output contains counts only, no code or conversation text. `--examples` quotes your sessions: check what's in it before sharing.

## Stop hidden failures: the pipefail hook

The fix for piped checks is `set -o pipefail`. nocap ships a Claude Code `PreToolUse` hook that adds it to test, lint, typecheck and build commands that pipe their output. Everything else passes through untouched, and any error leaves the command as it was. Like the audit, it makes no model calls and adds nothing to your prompt. The only visible change is a failing exit code where a pipe used to hide one.

```sh
npm i -g agent-nocap
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

Claim detection is heuristic: regex over the agent's messages, with a negation filter ("should pass", "once tests pass", "4/5 tests passed" don't count). Quoted text, inline code and code blocks are skipped, because they're usually someone else's words. Each claim needs a check of the kind it names: "tests pass" needs a test run (`npm test`, `pytest`, `cargo test`, `go test`, …), "tsc clean" a typecheck, "lint clean" a linter, "build passes" a build. "Verified working" or "everything works" accepts any check, and check scripts like `npm run check` or `npm run e2e:check` back any claim. A claim is **backed** only if the last matching check before it in the session passed and no code was edited after it. A user message doesn't reset that: "all tests pass, committing" right after a passing run is backed.

A command counts as a check only where it starts, so `echo "npm test"` and `grep jest` don't. A check without a known result is never a pass: background runs, commands that you or a hook blocked, and scripts in older Codex sessions that print the output but drop the exit code (failure text in that output still counts as a failure). Newer Codex logs every command's exit code, and nocap reads it. A piped check counts as failed when it exits 0 but its output shows failures; ESLint's warnings-only summary doesn't count. Edits to Markdown and text files don't count as code edits. Subagent transcripts count as their own sessions. `--since` counts claims and checks by when they happened, not by file date.

Expect some false positives. If nocap flags something wrong, open an issue with the `--examples` line (redacted as needed).

## License

MIT. Built by [Super Logic AI](https://superlogicai.com).
