// Development: game server with reload on :8080 and the Vite client on :5173 (proxying /ws).
import { spawn } from 'node:child_process';
const run = (cmd, args, name) => {
  const p = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  p.on('exit', code => { console.log(`${name} exited (${code})`); process.exit(code ?? 0); });
  return p;
};
const server = run('npx', ['tsx', 'watch', 'server/index.ts'], 'server');
const client = run('npx', ['vite'], 'client');
process.on('SIGINT', () => { server.kill(); client.kill(); process.exit(0); });
