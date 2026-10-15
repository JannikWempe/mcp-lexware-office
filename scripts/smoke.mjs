// Starts the built server over stdio and prints what a client sees: initialize result and tools/list.
// Usage: pnpm -s run smoke [--writes]. 2025-era initialize handshake; no Lexware calls are made (dummy key).
import { spawn } from 'node:child_process';

const writes = process.argv.slice(2).includes('--writes');

const child = spawn(process.execPath, [new URL('../build/index.js', import.meta.url).pathname], {
	env: { ...process.env, LEXWARE_OFFICE_API_KEY: 'smoke-key', LEXWARE_OFFICE_ALLOW_WRITES: writes ? 'true' : 'false' },
	stdio: ['pipe', 'pipe', 'inherit'],
});

const pending = new Map();
let buffer = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
	buffer += chunk;
	let newline;
	while ((newline = buffer.indexOf('\n')) >= 0) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		if (line.length === 0) continue;
		const message = JSON.parse(line);
		pending.get(message.id)?.(message);
		pending.delete(message.id);
	}
});
const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
let nextId = 1;
const request = (method, params) => new Promise((resolve) => {
	const id = nextId++;
	pending.set(id, resolve);
	send({ id, method, params });
});

const timer = setTimeout(() => {
	console.error('smoke: no response within 10s');
	child.kill();
	process.exit(1);
}, 10_000);

const initialize = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
send({ method: 'notifications/initialized' });
const toolsList = await request('tools/list', {});
clearTimeout(timer);
child.kill();

console.log(JSON.stringify({ initialize, toolsList }, null, 2));
process.exit(initialize.error !== undefined || toolsList.error !== undefined ? 1 : 0);
