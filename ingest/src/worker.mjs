import { spawn } from 'node:child_process';
const hours = Number(process.env.SYNC_INTERVAL_HOURS || 24);
if (!Number.isFinite(hours) || hours < 1) throw new Error('SYNC_INTERVAL_HOURS must be >= 1');
async function run() {
  await new Promise(resolve => {
    const child = spawn(process.execPath, ['src/sync.mjs'], { stdio: 'inherit' });
    child.on('error', error => { console.error(error); resolve(); });
    child.on('exit', code => { if (code) console.error('Sync failed with code', code); resolve(); });
  });
}
while (true) {
  await run();
  await new Promise(resolve => setTimeout(resolve, hours * 3600_000));
}
