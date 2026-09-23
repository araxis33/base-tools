// Pre-publish check for check.html: its inline script must parse. A quote lost
// in an edit once broke the whole page (the Check button reloaded it instead).
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html = readFileSync(new URL('./check.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
for (const [i, s] of scripts.entries()) new vm.Script(s, { filename: `check.html#script${i}` });
new vm.Script(readFileSync(new URL('./check.js', import.meta.url), 'utf8'), { filename: 'check.js' });
console.log(`ok: ${scripts.length} inline script(s) and check.js parse`);
