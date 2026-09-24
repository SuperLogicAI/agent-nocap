import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION, auditFiles, auditSteps, auditText, checkKinds, claudeSteps, codexSteps, pipefailCommand, sessionTags, transcriptFiles } from './audit.js';
const jsonl = (...events: unknown[]) => events.map(e => JSON.stringify(e)).join('\n');
const user = (text: string) => ({ type: 'user', timestamp: 't', message: { content: text } });
const bash = (id: string, command: string) => ({ type: 'assistant', timestamp: 't', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const edit = (id: string, file_path: string) => ({ type: 'assistant', timestamp: 't', message: { content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path } }] } });
const result = (id: string, content: string, is_error = false) => ({ type: 'user', timestamp: 't', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } });
const say = (text: string) => ({ type: 'assistant', timestamp: 't', message: { content: [{ type: 'text', text }] } });
const verdicts = (raw: string) => auditSteps('f', claudeSteps(raw)).map(c => c.verdict);
test('claims are classified against the checks in the same turn', () => {
    assert.deepEqual(verdicts(jsonl(user('fix it'), edit('1', 'src/a.ts'), result('1', 'ok'), bash('2', 'npm test'), result('2', 'pass 3'), say('Done. All tests pass.'))), ['backed']);
    assert.deepEqual(verdicts(jsonl(user('fix it'), edit('1', 'src/a.ts'), result('1', 'ok'), say('Fixed, tests pass.'))), ['unbacked']);
    assert.deepEqual(verdicts(jsonl(user('fix it'), bash('2', 'npm test'), result('2', 'Exit code 1', true), say('All tests pass.'))), ['contradicted']);
    assert.deepEqual(verdicts(jsonl(user('fix it'), bash('2', 'npm test'), result('2', 'ok'), edit('3', 'src/a.ts'), result('3', 'ok'), say('All tests pass.'))), ['stale']);
    // Prose edits after a passing check do not make it stale.
    assert.deepEqual(verdicts(jsonl(user('fix it'), bash('2', 'npm test'), result('2', 'ok'), edit('3', 'README.md'), result('3', 'ok'), say('All tests pass.'))), ['backed']);
    // A previous turn's check does not back a new claim.
    assert.deepEqual(verdicts(jsonl(user('a'), bash('2', 'npm test'), result('2', 'ok'), user('b'), say('Tests pass.'))), ['unbacked']);
});
test('negated, conditional and noun uses are not claims', () => {
    for (const text of ['Tests pass? Not yet.', 'Once tests pass I will merge.', 'The tests failed; not all tests pass.', 'Recorded a live test pass for Phase 3.'])
        assert.deepEqual(verdicts(jsonl(user('x'), say(text))), [], text);
});
test('exit code zero from a pipe cannot hide failing output', () => {
    const steps = claudeSteps(jsonl(user('x'), bash('1', 'cargo test 2>&1 | tail -5'), result('1', 'test result: FAILED. 14 passed; 3 failed'), say('All tests pass.')));
    assert.deepEqual(steps.filter(s => s.kind === 'cmd').map(s => [s.ok, s.masked]), [[false, true]]);
    assert.equal(auditSteps('f', steps)[0]!.verdict, 'contradicted');
    const clean = claudeSteps(jsonl(bash('1', 'npm test | tail -5'), result('1', 'tests 4\npass 4\nfail 0')));
    assert.deepEqual(clean.filter(s => s.kind === 'cmd').map(s => [s.ok, s.masked]), [[true, false]]);
});
test('codex exec wrappers pair commands with exit codes and patch paths', () => {
    const raw = jsonl(
        { type: 'event_msg', timestamp: 't', payload: { type: 'user_message' } },
        { type: 'response_item', timestamp: 't', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'p', input: '*** Begin Patch\n*** Update File: src/a.ts\n' } },
        { type: 'response_item', timestamp: 't', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c', input: 'await tools.exec_command({cmd:"npm test"})' } },
        { type: 'response_item', timestamp: 't', payload: { type: 'custom_tool_call_output', call_id: 'c', output: [{ type: 'input_text', text: '{"exit_code":1}' }] } },
        { type: 'response_item', timestamp: 't', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The tests passed.' }] } });
    const steps = codexSteps(raw);
    assert.deepEqual(steps.map(s => s.kind), ['user', 'edit', 'cmd', 'text']);
    assert.equal(auditSteps('f', steps)[0]!.verdict, 'contradicted');
});
test('plugin tags come from hook context, not conversation', () => {
    const hook = (content: string) => ({ type: 'attachment', attachment: { type: 'hook_success', content } });
    assert.deepEqual(sessionTags('claude', jsonl(hook('CAVEMAN MODE ACTIVE'), hook('PONYTAIL MODE ACTIVE'))), ['caveman', 'ponytail']);
    assert.deepEqual(sessionTags('claude', jsonl(user('is CAVEMAN MODE ACTIVE affecting results?'))), ['none']);
    assert.deepEqual(sessionTags('claude', jsonl(hook('project reminder'))), ['other-hooks']);
});
test('pipefail hook rewrites only piped checks', () => {
    assert.equal(pipefailCommand('npm test 2>&1 | tail -20'), 'set -o pipefail; npm test 2>&1 | tail -20');
    assert.equal(pipefailCommand('cd app && cargo test | grep FAILED'), 'set -o pipefail; cd app && cargo test | grep FAILED');
    for (const cmd of ['npm test', 'npm test || true', 'npm test |& tail', 'ls | head', 'set -o pipefail; npm test | tail'])
        assert.equal(pipefailCommand(cmd), undefined, cmd);
});

test('auditText colors only non-zero numbers, and only when asked', () => {
    const a = auditFiles([]);
    a.verdicts.contradicted = 2; a.maskedFailures = 3;
    assert.doesNotMatch(auditText(a, 0), /\x1b/);
    assert.match(auditText(a, 0), /Agent-nocap by \/\/Super Logic AI · github\.com\/SuperLogicAI\/agent-nocap/);
    const colored = auditText(a, 0, true);
    assert.match(colored, /contradicted  \x1b\[31m2\x1b\[0m/);
    assert.match(colored, /  backed        0\t/);
    assert.match(colored, /pipefail hook/);
});

test('a claim is backed only by a check of the kind it names', () => {
    const lint = (ok: boolean) => [bash('3', 'npm run lint'), result('3', 'ok', !ok)];
    assert.deepEqual(verdicts(jsonl(user('x'), bash('2', 'npm test'), result('2', 'Exit code 1', true), ...lint(true), say('All tests pass.'))), ['contradicted']);
    assert.deepEqual(verdicts(jsonl(user('x'), ...lint(true), say('All tests pass.'))), ['unbacked']);
    assert.deepEqual(verdicts(jsonl(user('x'), ...lint(true), say('Lint is clean.'))), ['backed']);
    // Two kinds named, one checked: the missing one decides.
    assert.deepEqual(verdicts(jsonl(user('x'), bash('2', 'npm test'), result('2', 'ok'), say('Tests pass and the build is clean.'))), ['unbacked']);
    // Only the claim phrase names a kind; other words in the sentence do not.
    assert.deepEqual(verdicts(jsonl(user('x'), bash('2', 'npm test'), result('2', 'ok'), say('The phase 0 build is done and all 8 tests pass.'))), ['backed']);
    // Aggregate scripts and generic claims match anything.
    assert.deepEqual(verdicts(jsonl(user('x'), bash('2', 'npm run check'), result('2', 'ok'), say('All tests pass.'))), ['backed']);
    assert.deepEqual(verdicts(jsonl(user('x'), ...lint(true), say('Verified working.'))), ['backed']);
});
test('checks are recognized only where a command starts', () => {
    for (const cmd of ['echo "npm test"', 'grep -r jest .', 'rg vitest src', 'cat package.json | grep eslint', `git commit -m "$(cat <<'EOF'\nFix\n\nnpm test passes\nEOF\n)"`, "git commit -m 'x; npm test'"])
        assert.deepEqual(checkKinds(cmd), [], cmd);
    assert.deepEqual(checkKinds('cd app && npm test 2>&1 | tail -5'), ['test']);
    assert.deepEqual(checkKinds('CI=1 npx vitest run'), ['test']);
    assert.deepEqual(checkKinds('uv run pytest -q'), ['test']);
    assert.deepEqual(checkKinds('./node_modules/.bin/tsc --noEmit'), ['typecheck']);
    assert.deepEqual(checkKinds('npm test && npm run lint'), ['test', 'lint']);
    assert.deepEqual(checkKinds('node --import tsx scripts/bind-check.ts'), ['any']);
    assert.deepEqual(checkKinds('node scripts/check.mjs'), ['any']);
    assert.equal(pipefailCommand('grep -r jest . | head'), undefined);
});
test('a command without a completed result is not a check', () => {
    const bg = { type: 'assistant', timestamp: 't', message: { content: [{ type: 'tool_use', id: '1', name: 'Bash', input: { command: 'npm test', run_in_background: true } }] } };
    assert.deepEqual(verdicts(jsonl(user('x'), bg, result('1', 'Command running in background with ID: b1'), say('All tests pass.'))), ['unbacked']);
    const running = codexSteps(jsonl(
        { type: 'response_item', timestamp: 't', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c', input: 'await tools.exec_command({cmd:"npm test"})' } },
        { type: 'response_item', timestamp: 't', payload: { type: 'custom_tool_call_output', call_id: 'c', output: 'Process running with session ID 7' } }));
    assert.deepEqual(running.filter(s => s.kind === 'cmd'), []);
    // Code-mode scripts that print only the output: failure text is a failure, silence is unknown.
    const script = (id: string, text: string) => [
        { type: 'response_item', timestamp: 't', payload: { type: 'custom_tool_call', name: 'exec', call_id: id, input: 'const r = await tools.exec_command({cmd:"npm test"}); text(r.output);' } },
        { type: 'response_item', timestamp: 't', payload: { type: 'custom_tool_call_output', call_id: id, output: [{ type: 'input_text', text: 'Script completed\nWall time 1.0 seconds\nOutput:\n' }, { type: 'input_text', text }] } }];
    assert.deepEqual(codexSteps(jsonl(...script('a', 'tests 4\npass 4'))).filter(s => s.kind === 'cmd'), []);
    assert.deepEqual(codexSteps(jsonl(...script('b', 'Tests: 2 failed, 5 passed'))).filter(s => s.kind === 'cmd').map(s => s.ok), [false]);
});
test('the window counts events by time, with earlier events as context', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nocap-')), at = (t: string, e: object) => ({ ...e, timestamp: t });
    process.env.CLAUDE_CONFIG_DIR = join(dir, '.claude'); process.env.CODEX_HOME = join(dir, '.codex');
    mkdirSync(join(dir, '.claude', 'projects'), { recursive: true });
    const path = join(dir, '.claude', 'projects', 's.jsonl');
    writeFileSync(path, jsonl(
        at('2026-01-01T00:00:00Z', user('old')), at('2026-01-01T00:00:01Z', say('All tests pass.')),
        at('2026-05-31T00:00:00Z', user('new')), at('2026-05-31T00:00:01Z', bash('1', 'npm test')), at('2026-05-31T00:00:02Z', result('1', 'ok')),
        at('2026-06-02T00:00:00Z', say('All tests pass.'))));
    symlinkSync(join(dir, 'missing'), join(dir, '.claude', 'projects', 'dangling.jsonl'));
    const files = transcriptFiles(30);
    assert.deepEqual(files.map(f => f.path), [path]);
    const a = auditFiles(files, Date.parse('2026-06-01T00:00:00Z'));
    assert.deepEqual([a.sessions, a.claims, a.verdicts.backed, a.verifications], [1, 1, 1, 0]);
});
test('examples cannot write control sequences to the terminal', () => {
    const a = auditFiles([]);
    a.findings.push({ file: 'f', at: 't', text: 'All tests pass.\x1b[2J\x1b]0;pwned\x07', verdict: 'unbacked' });
    assert.doesNotMatch(auditText(a, 1), /[\x07\x1b]/);
});
test('VERSION matches package.json', () => {
    assert.equal(VERSION, JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
});
