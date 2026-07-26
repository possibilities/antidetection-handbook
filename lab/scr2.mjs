import { startOrigin, ab, withSession, AB_BIN } from './lib.mjs';
const origin = await startOrigin();
console.log('binary under test:', AB_BIN);
await withSession('scrn', async (s) => {
  await ab(['--session', s, 'open', `${origin.base}/screen.html`], { timeoutMs: 120000 });
  for (let i=0;i<40 && origin.collected.length===0;i++) await new Promise(r=>setTimeout(r,250));
});
await origin.close();
console.log(JSON.stringify(origin.collected[0]));
