const args = process.argv.slice(2);
const resume = args.indexOf('--resume');
const id = resume >= 0 ? args[resume + 1] : 'fixture-claude-session';
let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) prompt += chunk;

const emit = event => console.log(JSON.stringify({ session_id: id, ...event }));
emit({ type: 'system', subtype: 'init' });
if (prompt.startsWith('多行输入')) {
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } });
}
if (prompt === 'fail') {
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial response' }] } });
  emit({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['fixture terminal error'] });
} else {
  emit({
    type: 'result', subtype: 'success', is_error: false,
    result: resume >= 0 ? 'resumed' : `第一行\n  ${prompt.length} characters\n`,
    usage: { input_tokens: 10, output_tokens: 4 }
  });
  if (prompt === 'nonzero') process.exitCode = 1;
}
