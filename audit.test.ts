import test from 'node:test';
import assert from 'node:assert/strict';
import { auditFiles, auditSteps, auditText, claudeSteps, codexSteps, pipefailCommand, sessionTags } from './audit.js';
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
