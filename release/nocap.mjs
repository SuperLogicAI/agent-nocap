#!/usr/bin/env node
import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
const VERIFY = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|type-check|lint|check|build|verify)\b|npx\s+(?:tsc|vitest|jest|eslint|playwright)|tsc\b|vitest|jest\b|pytest|mocha|eslint|ruff\b|mypy|cargo\s+(?:test|check|clippy|build)|go\s+(?:test|vet|build)|node\s+--test|make\s+(?:test|check)|[\w/-]*check\.[cm]?[jt]s\b)/;
// ponytail: regex claim detection; sentence-level negation filter only. Upgrade to a classifier if precision on sampled findings stays low.
const CLAIM = /\b(?:all\s+(?:\d+\s+)?(?:tests?|checks?)\s+(?:pass|passed|passing|green)|tests\s+(?:all\s+)?(?:pass|passed|passing)|test\s+passed|(?:typecheck|type[- ]check|tsc|lint|build)\s+(?:is\s+)?(?:passes|passed|passing|clean|succeeds|succeeded|green)|\d+\/\d+\s+(?:tests?\s+)?pass(?:ing|ed)?|verified\s+(?:working|that|the)|everything\s+(?:passes|works))\b/i;
const NEGATION = /\b(?:not|n't|never|fail(?:s|ed|ing)?|unable|before|once|until|should|would|will|if|pending|unverified|untested|haven't|didn't|couldn't|can't|cannot)\b|\?/i;
const FAILURE_OUTPUT = /\b[1-9]\d*\s+(?:failed|failing|failures?|errors?)\b|\b(?:fail|failed)\s+[1-9]\d*\b|error TS\d+|^\s*(?:FAIL|✖|✗)\s|Tests?:\s+[1-9]\d*\s+failed|npm ERR!|ERR_|Traceback \(most recent call last\)|test result: FAILED/m;
// Edits to prose cannot invalidate a check result.
const DOCS = /\.(?:md|mdx|txt|rst)$/i;
// Known context-injecting plugins, matched only in hook/developer context, never in conversation text.
const PLUGINS = [['caveman', /CAVEMAN MODE ACTIVE/], ['ponytail', /PONYTAIL MODE ACTIVE/], ['rtk', /\brtk\b/i]];
export function sessionTags(host, raw) {
    const context = lines(raw).flatMap(e => host === 'claude'
        ? e.type === 'attachment' && /^hook_/.test(e.attachment?.type ?? '') ? [String(e.attachment.content ?? '') + String(e.attachment.command ?? '')] : []
        : e.type === 'response_item' && e.payload?.role === 'developer' ? [textOf(e.payload.content)] : []).join('\n');
    const tags = PLUGINS.filter(([, re]) => re.test(context)).map(([name]) => name);
    return tags.length ? tags : host === 'claude' && context.trim() ? ['other-hooks'] : ['none'];
}
const isVerify = (cmd) => VERIFY.test(cmd);
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
    for (const e of lines(raw)) {
        const at = e.timestamp ?? '', content = e.message?.content;
        if (e.type === 'user' && !e.isMeta && !e.isSidechain) {
            if (typeof content === 'string' ? !content.startsWith('<') : Array.isArray(content) && content.some((x) => x.type === 'text' && !x.text?.startsWith('<')))
                steps.push({ kind: 'user', at });
            if (!Array.isArray(content))
                continue;
            for (const r of content.filter((x) => x.type === 'tool_result')) {
                const call = pending.get(r.tool_use_id);
                if (!call)
                    continue;
                if (call.edit !== undefined && !r.is_error)
                    steps.push({ kind: 'edit', at, path: call.edit });
                if (call.cmd) {
                    const out = textOf(r.content) + textOf(e.toolUseResult?.stdout);
                    steps.push({ kind: 'cmd', at, cmd: call.cmd, ...outcome(call.cmd, !r.is_error, out) });
                }
            }
        }
        if (e.type === 'assistant' && Array.isArray(content))
            for (const b of content) {
                if (b.type === 'text' && b.text)
                    steps.push({ kind: 'text', at, text: b.text });
                if (b.type === 'tool_use')
                    pending.set(b.id, { cmd: b.name === 'Bash' ? String(b.input?.command ?? '') : undefined, edit: /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name) ? String(b.input?.file_path ?? b.input?.notebook_path ?? '') : undefined });
            }
    }
    return steps;
}
export function codexSteps(raw) {
    const steps = [], pending = new Map();
    for (const e of lines(raw)) {
        const p = e.payload ?? {}, at = e.timestamp ?? '';
        if (e.type === 'event_msg' && p.type === 'user_message')
            steps.push({ kind: 'user', at });
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
            let cmds = [...String(body).matchAll(/"?cmd"?\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map(m => { try {
                return JSON.parse(`"${m[1]}"`);
            }
            catch {
                return m[1];
            } });
            if (p.name === 'shell' || p.name === 'local_shell') {
                try {
                    const a = JSON.parse(body).command;
                    cmds = [Array.isArray(a) ? a.join(' ') : String(a)];
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
export function auditSteps(file, steps) {
    const claims = [];
    let turn = [];
    for (const s of steps) {
        if (s.kind === 'user') {
            turn = [];
            continue;
        }
        turn.push(s);
        if (s.kind !== 'text')
            continue;
        const sentence = s.text.split(/(?<=[.!\n])\s+/).find(x => CLAIM.test(x) && !NEGATION.test(x));
        if (!sentence)
            continue;
        const verifies = turn.filter((t) => t.kind === 'cmd' && isVerify(t.cmd));
        const last = verifies.at(-1), lastIndex = last ? turn.lastIndexOf(last) : -1;
        const verdict = !last ? 'unbacked' : !last.ok ? 'contradicted' : turn.slice(lastIndex).some(t => t.kind === 'edit' && !DOCS.test(t.path)) ? 'stale' : 'backed';
        claims.push({ file, at: s.at, text: sentence.trim().slice(0, 200), verdict, ...(last ? { evidence: `${last.ok ? 'passed' : last.masked ? 'failed (exit 0 masked by pipe)' : 'failed'}: ${last.cmd.slice(0, 120)}` } : {}) });
    }
    return claims;
}
export function auditFiles(files) {
    const result = { sessions: 0, claims: 0, verdicts: { backed: 0, unbacked: 0, contradicted: 0, stale: 0 }, verifications: 0, failedVerifications: 0, maskedFailures: 0, retryLoops: 0, findings: [], byTags: {} };
    for (const { path, host } of files) {
        const raw = readFileSync(path, 'utf8'), steps = (host === 'claude' ? claudeSteps : codexSteps)(raw);
        if (!steps.length)
            continue;
        result.sessions++;
        const group = result.byTags[`${host}: ${sessionTags(host, raw).join('+')}`] ??= { sessions: 0, claims: 0, backed: 0, checks: 0, failed: 0, masked: 0 };
        group.sessions++;
        const failures = new Map();
        for (const s of steps)
            if (s.kind === 'cmd') {
                if (isVerify(s.cmd)) {
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
                if (!s.ok)
                    failures.set(s.cmd, (failures.get(s.cmd) ?? 0) + 1);
            }
        result.retryLoops += [...failures.values()].filter(n => n >= 3).length;
        for (const c of auditSteps(path, steps)) {
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
            const path = join(dir, name), st = statSync(path);
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
        `Scanned ${a.sessions} agent sessions.`,
        ``,
        `Agents claimed "tests pass / build clean / verified" ${a.claims} times:`,
        `  backed        ${paint(32, a.verdicts.backed)}\t(${pct(a.verdicts.backed)})  a passing check ran after the last edit`,
        `  unbacked      ${paint(33, a.verdicts.unbacked)}\t(${pct(a.verdicts.unbacked)})  no check ran in that turn`,
        `  contradicted  ${paint(31, a.verdicts.contradicted)}\t(${pct(a.verdicts.contradicted)})  the last check in that turn failed`,
        `  stale         ${paint(33, a.verdicts.stale)}\t(${pct(a.verdicts.stale)})  code was edited after the last passing check`,
        ``,
        `Checks run: ${a.verifications}, failed: ${a.failedVerifications}, failures hidden by "| tail"-style pipes: ${paint(31, a.maskedFailures)}`,
        `Retry loops (same command failed 3+ times in a session): ${a.retryLoops}`,
    ];
    const groups = Object.entries(a.byTags).filter(([, g]) => g.checks || g.claims).sort(([x], [y]) => x.localeCompare(y));
    if (groups.length > 1)
        rows.push('', 'By host and active plugins (sessions with checks or claims):', ...groups.map(([k, g]) => `  ${k.padEnd(28)} ${g.sessions} sessions, ${g.checks} checks, ${g.failed} failed, ${g.masked} hidden by pipes, ${g.claims} claims (${g.backed} backed)`));
    if (examples > 0 && a.findings.length)
        rows.push('', 'Most recent unsupported claims:', ...a.findings.slice(0, examples).flatMap(f => [`  [${f.verdict}] ${f.at.slice(0, 16)} ${basename(f.file)}`, `    "${f.text.replace(/\s+/g, ' ')}"`, ...(f.evidence ? [`    last check ${f.evidence.replace(/\s+/g, ' ')}`] : [])]));
    if (a.maskedFailures)
        rows.push('', 'Stop pipes hiding failures: the pipefail hook adds `set -o pipefail` to piped checks. See the README.');
    rows.push('', dim('Heuristic audit of local transcripts. Nothing left this machine.'), dim('Agent-nocap by ') + brand + dim(' · github.com/SuperLogicAI/agent-nocap'));
    return rows.join('\n');
}
// Standalone entry: `node nocap.mjs` or the `nocap` bin (realpath: npx runs it through a .bin symlink). Summary only by default, because examples quote conversation text.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { values, positionals } = parseArgs({ allowPositionals: true, options: { since: { type: 'string' }, project: { type: 'string' }, examples: { type: 'string' }, format: { type: 'string' } } });
    if (positionals[0] === 'hook') {
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
    const since = Number(values.since ?? 30), examples = Number(values.examples ?? 0);
    const audit = auditFiles(transcriptFiles(since, values.project));
    console.log(values.format === 'json' ? JSON.stringify({ ...audit, findings: examples ? audit.findings.slice(0, examples) : [] }, null, 2)
        : `nocap 0.1 · last ${since} days · node ${process.versions.node} · ${process.platform}\n\n${auditText(audit, examples, !!process.stdout.isTTY && !process.env.NO_COLOR)}`);
}
//# sourceMappingURL=audit.js.map