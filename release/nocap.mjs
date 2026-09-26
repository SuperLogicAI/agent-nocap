#!/usr/bin/env node
import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
export const VERSION = '0.3.0';
const RUN = String.raw `(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?`, BIN = String.raw `(?:\S*/)?`;
const CHECKS = [
    ['test', new RegExp(String.raw `^(?:${RUN}test|${BIN}(?:vitest|jest|pytest|mocha)|playwright\s+test|cargo\s+test|go\s+test|node\s+--test|make\s+test)\b`)],
    ['typecheck', new RegExp(String.raw `^(?:${RUN}type-?check|${BIN}(?:tsc|mypy)|cargo\s+check)\b`)],
    ['lint', new RegExp(String.raw `^(?:${RUN}lint|${BIN}(?:eslint|ruff)|cargo\s+clippy|go\s+vet)\b`)],
    ['build', new RegExp(String.raw `^(?:${RUN}build|cargo\s+build|go\s+build)\b`)],
    ['any', new RegExp(String.raw `^(?:${RUN}(?:(?!format|fmt|prettier)[\w:-]+[:-])?(?:check|verify)|make\s+check|(?:node|tsx|bun)\s+(?:--?[\w-]+(?:[= ](?!\S*check\.)\S+)?\s+)*\S*check\.[cm]?[jt]s)\b`)],
];
const PREFIX = /^(?:\w+=\S*\s+|(?:time|env|exec|npx(?:\s+-y)?|bunx|(?:pnpm|yarn)\s+exec|uv\s+run|poetry\s+run|python3?\s+-m)\s+)*/;
// ponytail: quotes and heredocs are blanked, not parsed, so `sh -c "npm test"` is not a check. Conservative on purpose: unrecognized never backs a claim.
export function checkKinds(cmd) {
    const bare = cmd.replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s*\2\b/g, '').replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
    const kinds = new Set(bare.split(/[;&|\n()`]/).flatMap(seg => { const s = seg.trim().replace(PREFIX, ''); return CHECKS.filter(([, re]) => re.test(s)).map(([k]) => k); }));
    return [...kinds];
}
// ponytail: regex claim detection; sentence-level negation filter only. Upgrade to a classifier if precision on sampled findings stays low.
// "N/N pass" is a claim only when every test passed; "4/5 passed" reports a failure.
const CLAIM = /\b(?:all\s+(?:\d+\s+)?(?:tests?|checks?)\s+(?:pass|passed|passing|green)|tests\s+(?:all\s+)?(?:pass|passed|passing)|test\s+passed|(?:typecheck|type[- ]check|tsc|lint|build)\s+(?:is\s+)?(?:passes|passed|passing|clean|succeeds|succeeded|green)|(\d+)\/\1\s+(?:tests?\s+)?pass(?:ing|ed)?|verified\s+working|everything\s+(?:passes|works))\b/i;
const NEGATION = /\b(?:not|never|fail(?:s|ed|ing)?|unable|before|once|until|should|would|will|if|pending|unverified|untested|cannot)\b|\w+n['’]t\b|\b(\d+)\/(?!\1\b)\d+\s+(?:tests?\s+)?pass|\?/i;
// Quoted, inline-code and fenced text is someone else's words (a report, a doc, tool output), not the agent's claim.
const unquote = (text) => text.replace(/```[\s\S]*?```|`[^`\n]*`|"[^"\n]*"|“[^”\n]*”/g, '…');
// Not failures: ESLint's warnings-only summary (exit 0), and "N failed:" used as a label ("passed: 151 failed: 0").
const FAILURE_OUTPUT = /\b[1-9]\d*\s+(?:failed|failing|failures?|errors?)\b(?!:)|\bfail(?:ed|ures?)?:\s*[1-9]|^[ℹ#]\s*fail\s+[1-9]|error TS\d+|^\s*(?:FAIL|✖(?! \d+ problems? \(0 errors)|✗)\s|Tests?:\s+[1-9]\d*\s+failed|npm ERR!|ERR_|Traceback \(most recent call last\)|test result: FAILED/m;
// Edits to prose cannot invalidate a check result.
const DOCS = /\.(?:md|mdx|txt|rst)$/i;
// Known context-injecting plugins, matched only in hook/developer context, never in conversation text.
const PLUGINS = [['caveman', /CAVEMAN MODE ACTIVE/], ['ponytail', /PONYTAIL MODE ACTIVE/], ['rtk', /\brtk\b/i]];
export function sessionTags(host, raw) {
    const context = (typeof raw === 'string' ? lines(raw) : raw).flatMap(e => host === 'claude'
        ? e.type === 'attachment' && /^hook_/.test(e.attachment?.type ?? '') ? [String(e.attachment.content ?? '') + String(e.attachment.command ?? '')] : []
        : e.type === 'response_item' && e.payload?.role === 'developer' ? [textOf(e.payload.content)] : []).join('\n');
    const tags = PLUGINS.filter(([, re]) => re.test(context)).map(([name]) => name);
    return tags.length ? tags : host === 'claude' && context.trim() ? ['other-hooks'] : ['none'];
}
const isVerify = (cmd) => checkKinds(cmd).length > 0;
// What a claim sentence names; a claim naming none ("verified", "everything works") takes any check.
const CLAIM_KINDS = [['test', /\btests?\b|\d+\/\d+/i], ['typecheck', /type[- ]?check|\btsc\b/i], ['lint', /\blint\b/i], ['build', /\bbuild\b/i]];
const SEVERITY = ['backed', 'stale', 'unbacked', 'contradicted'];
const outcome = (cmd, exitOk, output) => {
    const masked = exitOk && /\|/.test(cmd) && FAILURE_OUTPUT.test(output);
    return { ok: exitOk && !masked, masked };
};
const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => typeof x === 'string' ? x : x?.text ?? '').join('\n') : '';
const lines = (raw) => raw.split('\n').flatMap(l => { try {
    const e = JSON.parse(l);
    return e && typeof e === 'object' ? [e] : [];
}
catch {
    return [];
} });
export function claudeSteps(raw) {
    const steps = [], pending = new Map();
    for (const e of typeof raw === 'string' ? lines(raw) : raw) {
        const at = e.timestamp ?? '', content = e.message?.content;
        if (e.type === 'user' && !e.isMeta) {
            // Subagent transcripts mark every entry as sidechain: the prompt is not the user's, but the tool results are real.
            if (!e.isSidechain && (typeof content === 'string' ? !content.startsWith('<') : Array.isArray(content) && content.some((x) => x.type === 'text' && !x.text?.startsWith('<'))))
                steps.push({ kind: 'user', at });
            if (!Array.isArray(content))
                continue;
            for (const r of content.filter((x) => x.type === 'tool_result')) {
                const call = pending.get(r.tool_use_id);
                if (!call)
                    continue;
                const out = textOf(r.content);
                if (call.edit !== undefined && !r.is_error)
                    steps.push({ kind: 'edit', at, path: call.edit });
                // An error without an exit code never ran: denied by the user or auto mode, or blocked by a hook.
                if (call.cmd && (!r.is_error || /^Exit code \d+/.test(out)))
                    steps.push({ kind: 'cmd', at, cmd: call.cmd, ...outcome(call.cmd, !r.is_error, out + textOf(e.toolUseResult?.stdout)) });
            }
        }
        if (e.type === 'assistant' && Array.isArray(content))
            for (const b of content) {
                if (b.type === 'text' && b.text)
                    steps.push({ kind: 'text', at, text: b.text });
                // A background launch returns before the command finishes, so its result is not an outcome.
                if (b.type === 'tool_use')
                    pending.set(b.id, { cmd: b.name === 'Bash' && !b.input?.run_in_background ? String(b.input?.command ?? '') : undefined, edit: /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name) ? String(b.input?.file_path ?? b.input?.notebook_path ?? '') : undefined });
            }
    }
    return steps;
}
// `zsh -lc "npm test"` runs `npm test`.
const argv = (a) => Array.isArray(a) ? (a.length > 2 && /^-\w*c$/.test(a[1]) ? String(a[2]) : a.join(' ')) : String(a ?? '');
export function codexSteps(raw) {
    const events = typeof raw === 'string' ? lines(raw) : raw;
    // Newer Codex logs every command with its exit code, including commands run inside code-mode scripts. Older sessions only have the call and whatever output it printed.
    const logged = events.some(e => e.payload?.item?.type === 'CommandExecution');
    const steps = [], pending = new Map();
    for (const e of events) {
        const p = e.payload ?? {}, at = e.timestamp ?? '';
        if (e.type === 'event_msg' && p.type === 'user_message')
            steps.push({ kind: 'user', at });
        if (e.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'CommandExecution' && typeof p.item.exit_code === 'number') {
            const cmd = argv(p.item.command);
            steps.push({ kind: 'cmd', at, cmd, ...outcome(cmd, p.item.exit_code === 0, String(p.item.aggregated_output ?? '')) });
        }
        if (e.type !== 'response_item')
            continue;
        if (p.type === 'message' && p.role === 'assistant')
            steps.push({ kind: 'text', at, text: textOf(p.content) });
        if (p.type === 'function_call' || p.type === 'custom_tool_call') {
            const body = p.input ?? p.arguments ?? '';
            if (p.name === 'apply_patch' || /apply_patch/.test(body)) {
                for (const m of String(body).matchAll(/\*\*\* (?:Update|Add|Delete) File: ([^\n\\]+)/g))
                    steps.push({ kind: 'edit', at, path: m[1] });
                continue;
            }
            if (logged)
                continue;
            let cmds = [...String(body).matchAll(/"?cmd"?\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map(m => { try {
                return JSON.parse(`"${m[1]}"`);
            }
            catch {
                return m[1];
            } });
            if (p.name === 'shell' || p.name === 'local_shell') {
                try {
                    cmds = [argv(JSON.parse(body).command)];
                }
                catch { /* not shell json */ }
            }
            if (cmds.length)
                pending.set(p.call_id, cmds);
        }
        if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
            const cmds = pending.get(p.call_id);
            if (!cmds)
                continue;
            const out = typeof p.output === 'string' ? p.output : textOf(p.output);
            const codes = [...out.matchAll(/(?:exit_code"?\s*[:=]\s*|Exit code:?\s*|Process exited with code\s*)(-?\d+)/g)].map(m => Number(m[1]));
            // No exit code: still running, or a code-mode script that printed only r.output. Failure text is still evidence; silence is not a pass.
            // ponytail: failure text marks every command in the call failed; split output per command if multi-command calls skew counts.
            if (!codes.length) {
                if (FAILURE_OUTPUT.test(out))
                    cmds.forEach(cmd => steps.push({ kind: 'cmd', at, cmd, ok: false, masked: false }));
                continue;
            }
            // ponytail: one call may run several commands; pair exit codes positionally, else fall back to the worst code.
            cmds.forEach((cmd, i) => steps.push({ kind: 'cmd', at, cmd, ...outcome(cmd, (codes.length === cmds.length ? codes[i] : Math.max(0, ...codes.map(Math.abs))) === 0, out) }));
        }
    }
    return steps;
}
// PreToolUse hook: make a piped check report its own exit code instead of the last stage's (usually tail/head/grep).
// ponytail: pipefail can turn a passing check piped into `head` into exit 141 (SIGPIPE) when output is long; visible, not hidden. Upgrade: rewrite `| head` to `| tail` or capture PIPESTATUS.
export function pipefailCommand(cmd) {
    if (!/(?:^|[^|])\|(?![|&])/.test(cmd) || /pipefail/.test(cmd) || !isVerify(cmd))
        return undefined;
    return `set -o pipefail; ${cmd}`;
}
// Evidence is everything before the claim in the session. A user message changes no code, so a restated result holds until the next edit.
export function auditSteps(file, steps) {
    const claims = [], seen = [];
    for (const s of steps) {
        seen.push(s);
        if (s.kind !== 'text')
            continue;
        const sentence = unquote(s.text).split(/(?<=[.!\n])\s+/).find(x => CLAIM.test(x) && !NEGATION.test(x));
        if (!sentence)
            continue;
        // Each kind the claim names needs its own matching check; the worst verdict wins.
        // Kinds come from the claim phrases only, so "the phase build is done and tests pass" is a test claim.
        const named = new Set([...sentence.matchAll(new RegExp(CLAIM.source, 'gi'))].map(([phrase]) => CLAIM_KINDS.find(([, re]) => re.test(phrase))?.[0] ?? 'any'));
        const { verdict, last } = [...named].map(kind => {
            const verifies = seen.filter((t) => t.kind === 'cmd' && checkKinds(t.cmd).some(k => kind === 'any' || k === kind || k === 'any'));
            const last = verifies.at(-1), lastIndex = last ? seen.lastIndexOf(last) : -1;
            const verdict = !last ? 'unbacked' : !last.ok ? 'contradicted' : seen.slice(lastIndex).some(t => t.kind === 'edit' && !DOCS.test(t.path)) ? 'stale' : 'backed';
            return { verdict, last };
        }).reduce((a, b) => SEVERITY.indexOf(b.verdict) > SEVERITY.indexOf(a.verdict) ? b : a);
        claims.push({ file, at: s.at, text: sentence.trim().slice(0, 200), verdict, ...(last ? { evidence: `${last.ok ? 'passed' : last.masked ? 'failed (exit 0 masked by pipe)' : 'failed'}: ${last.cmd.slice(0, 120)}` } : {}) });
    }
    return claims;
}
// `cutoff` (epoch ms) counts only events at or after it; earlier events still give in-window claims their context.
// ponytail: events without a parseable timestamp fall outside any cutoff; real transcripts always carry ISO timestamps.
export function auditFiles(files, cutoff) {
    const result = { sessions: 0, activeSessions: 0, claims: 0, verdicts: { backed: 0, unbacked: 0, contradicted: 0, stale: 0 }, verifications: 0, failedVerifications: 0, maskedFailures: 0, retryLoops: 0, findings: [], byTags: {} };
    const inWindow = (at) => cutoff === undefined || Date.parse(at) >= cutoff;
    for (const { path, host } of files) {
        const events = lines(readFileSync(path, 'utf8')), steps = (host === 'claude' ? claudeSteps : codexSteps)(events);
        if (!steps.some(s => inWindow(s.at)))
            continue;
        result.sessions++;
        const cmds = steps.filter((s) => s.kind === 'cmd' && inWindow(s.at)), checks = cmds.filter(s => isVerify(s.cmd));
        const failures = new Map();
        for (const s of cmds)
            if (!s.ok)
                failures.set(s.cmd, (failures.get(s.cmd) ?? 0) + 1);
        result.retryLoops += [...failures.values()].filter(n => n >= 3).length;
        const claims = auditSteps(path, steps).filter(c => inWindow(c.at));
        // Sessions that neither ran a check nor made a claim (one-shot SDK calls, chats) are scanned but not reported.
        if (!checks.length && !claims.length)
            continue;
        result.activeSessions++;
        const group = result.byTags[`${host}: ${sessionTags(host, events).join('+')}`] ??= { sessions: 0, claims: 0, backed: 0, checks: 0, failed: 0, masked: 0 };
        group.sessions++;
        for (const s of checks) {
            result.verifications++;
            group.checks++;
            if (!s.ok) {
                result.failedVerifications++;
                group.failed++;
            }
            if (s.masked) {
                result.maskedFailures++;
                group.masked++;
            }
        }
        for (const c of claims) {
            result.claims++;
            group.claims++;
            result.verdicts[c.verdict]++;
            if (c.verdict === 'backed')
                group.backed++;
            if (c.verdict !== 'backed')
                result.findings.push(c);
        }
    }
    result.findings.sort((a, b) => b.at.localeCompare(a.at));
    return result;
}
export function transcriptFiles(sinceDays, filter, home = homedir()) {
    const cutoff = Date.now() - sinceDays * 864e5, out = [];
    const walk = (dir, host) => {
        let entries;
        try {
            entries = readdirSync(dir);
        }
        catch {
            return;
        }
        for (const name of entries) {
            const path = join(dir, name);
            let st;
            try {
                st = statSync(path);
            }
            catch {
                continue;
            } // dangling symlink, permissions
            if (st.isDirectory())
                walk(path, host);
            else if (name.endsWith('.jsonl') && st.mtimeMs >= cutoff && (!filter || path.includes(filter)))
                out.push({ path, host });
        }
    };
    walk(join(process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), 'projects'), 'claude');
    walk(join(process.env.CODEX_HOME ?? join(home, '.codex'), 'sessions'), 'codex');
    return out;
}
export function auditText(a, examples, color = false) {
    // ANSI only for non-zero numbers worth a glance: green good, yellow doubtful, red bad.
    const paint = (code, n) => color && n ? `\x1b[${code}m${n}\x1b[0m` : String(n), dim = (s) => color ? `\x1b[2m${s}\x1b[0m` : s;
    // Bold brand mark; slash colors 24-bit where the terminal says it supports it, nearest 256-color otherwise.
    const rgb = (hex, fallback, s) => !color ? s
        : /truecolor|24bit/.test(process.env.COLORTERM ?? '') ? `\x1b[1;38;2;${hex.match(/../g).map(h => parseInt(h, 16)).join(';')}m${s}\x1b[0m` : `\x1b[1;38;5;${fallback}m${s}\x1b[0m`;
    const brand = rgb('00D09B', 43, '/') + rgb('FF7E1B', 208, '/') + (color ? '\x1b[1mSuper Logic AI\x1b[0m' : 'Super Logic AI');
    const pct = (n) => a.claims ? `${Math.round(100 * n / a.claims)}%` : '0%';
    const rows = [
        `Scanned ${a.sessions} agent sessions; ${a.activeSessions} ran checks or made claims.`,
        ``,
        `Agents claimed "tests pass / build clean / verified" ${a.claims} times:`,
        `  backed        ${paint(32, a.verdicts.backed)}\t(${pct(a.verdicts.backed)})  a matching check passed after the last edit`,
        `  unbacked      ${paint(33, a.verdicts.unbacked)}\t(${pct(a.verdicts.unbacked)})  no matching check with a known result before it`,
        `  contradicted  ${paint(31, a.verdicts.contradicted)}\t(${pct(a.verdicts.contradicted)})  the last matching check before it failed`,
        `  stale         ${paint(33, a.verdicts.stale)}\t(${pct(a.verdicts.stale)})  code was edited after the last passing check`,
        ``,
        `Checks run: ${a.verifications}, failed: ${a.failedVerifications}, failures hidden by "| tail"-style pipes: ${paint(31, a.maskedFailures)}`,
        `Retry loops (same command failed 3+ times in a session): ${a.retryLoops}`,
    ];
    const groups = Object.entries(a.byTags).sort(([x], [y]) => x.localeCompare(y));
    if (groups.length > 1)
        rows.push('', 'By host and active plugins (sessions that ran checks or made claims):', ...groups.map(([k, g]) => `  ${k.padEnd(28)} ${g.sessions} sessions, ${g.checks} checks, ${g.failed} failed, ${g.masked} hidden by pipes, ${g.claims} claims (${g.backed} backed)`));
    // Transcript text is untrusted: flatten whitespace and drop control characters so it cannot drive the terminal.
    const inert = (s) => s.replace(/[\s\x00-\x1f\x7f-\x9f]+/g, ' ');
    if (examples > 0 && a.findings.length)
        rows.push('', 'Most recent unsupported claims:', ...a.findings.slice(0, examples).flatMap(f => [`  [${f.verdict}] ${f.at.slice(0, 16)} ${basename(f.file)}`, `    "${inert(f.text)}"`, ...(f.evidence ? [`    last check ${inert(f.evidence)}`] : [])]));
    if (a.maskedFailures)
        rows.push('', 'Stop pipes hiding failures: the pipefail hook adds `set -o pipefail` to piped checks. See the README.');
    rows.push('', dim('Heuristic audit of local transcripts. Nothing left this machine.'), dim('Agent-nocap by ') + brand + dim(' · github.com/SuperLogicAI/agent-nocap'));
    return rows.join('\n');
}
// Standalone entry: `node nocap.mjs` or the `nocap` bin (realpath: npx runs it through a .bin symlink). Summary only by default, because examples quote conversation text.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    // Before parseArgs: a parse error exits 2, and exit 2 from a PreToolUse hook blocks the command.
    if (process.argv[2] === 'hook') {
        // Fail open: any problem leaves the command untouched and Claude Code's normal flow in charge.
        try {
            const input = JSON.parse(readFileSync(0, 'utf8')), command = input.tool_input?.command;
            const rewritten = input.tool_name === 'Bash' && typeof command === 'string' ? pipefailCommand(command) : undefined;
            if (rewritten)
                console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input.tool_input, command: rewritten } } }));
        }
        catch { /* no output = no change */ }
        process.exit(0);
    }
    const usage = `nocap ${VERSION}: audit agent "tests pass" claims against the checks that actually ran.

Usage: nocap [--since <days>] [--project <text>] [--examples <n>] [--format json]
       nocap hook    (Claude Code PreToolUse pipefail hook, reads stdin)

  --since <days>     how far back to look (default 30)
  --project <text>   only transcripts whose path contains this text
  --examples <n>     show the n most recent flagged claims, quoted from your sessions
  --format json      machine-readable output
  -h, --help         show this help
  -v, --version      show the version`;
    const fail = (msg) => { console.error(`nocap: ${msg}\n\n${usage}`); process.exit(2); };
    let parsed;
    try {
        parsed = parseArgs({ allowPositionals: true, options: { since: { type: 'string' }, project: { type: 'string' }, examples: { type: 'string' }, format: { type: 'string' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' } } });
    }
    catch (e) {
        fail(e.message);
    }
    const { values, positionals } = parsed;
    if (values.help) {
        console.log(usage);
        process.exit(0);
    }
    if (values.version) {
        console.log(VERSION);
        process.exit(0);
    }
    if (positionals.length)
        fail(`unknown command: ${positionals[0]}`);
    const since = Number(values.since ?? 30), examples = Number(values.examples ?? 0);
    if (!(since > 0))
        fail(`--since must be a positive number of days, got "${values.since}"`);
    if (!Number.isInteger(examples) || examples < 0)
        fail(`--examples must be a whole number, got "${values.examples}"`);
    if (values.format !== undefined && values.format !== 'json')
        fail(`--format supports only "json", got "${values.format}"`);
    const audit = auditFiles(transcriptFiles(since, values.project), Date.now() - since * 864e5);
    console.log(values.format === 'json' ? JSON.stringify({ version: VERSION, ...audit, findings: examples ? audit.findings.slice(0, examples) : [] }, null, 2)
        : `nocap ${VERSION} · last ${since} days · node ${process.versions.node} · ${process.platform}\n\n${auditText(audit, examples, !!process.stdout.isTTY && !process.env.NO_COLOR)}`);
}
//# sourceMappingURL=audit.js.map