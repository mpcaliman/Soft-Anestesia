import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const suites = ['csp-browser-security', 'session-crash-browser', 'smoke'];
// As sessões e servidores são independentes. Uma falha não deve esconder
// regressões nas outras duas suítes; o resultado combinado continua obrigatório.
const results = await Promise.all(suites.map(suite => new Promise(resolve => {
  const child = spawn(process.execPath, [`tests/${suite}.mjs`, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const output = [];
  child.stdout.on('data', value => output.push(value));
  child.stderr.on('data', value => output.push(value));
  child.once('error', error => resolve({ suite, code: 1, output: String(error) }));
  child.once('close', code => resolve({ suite, code: code ?? 1, output: Buffer.concat(output).toString('utf8') }));
})));
for (const result of results) {
  console.log(`\n--- ${result.suite}: ${result.code === 0 ? 'PASS' : 'FAIL'} ---`);
  process.stdout.write(result.output);
}
if (results.some(result => result.code !== 0)) process.exitCode = 1;
