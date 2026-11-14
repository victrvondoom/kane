// Runs the holdout game's script with no browser: a stub canvas, scripted key presses, one game step per frame.
// node sim.mjs <page.html> <plan.json>; plan: {"bugs": "1,2", "actions": [{"keys": ["ArrowRight"], "hold": 15, "settle": 4}]}
// Prints {"states": [state after each action], "bugHit": {...}, "won": bool}.
import { readFileSync } from 'node:fs';

const [page, planPath] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const html = readFileSync(page, 'utf8');
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));

const noop = () => {};
const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => { t[k] = v; return true; } });
const handlers = {};
let next = null;
const win = globalThis;
win.window = win;
win.location = { search: plan.bugs ? '?bugs=' + plan.bugs : '' };
win.document = { getElementById: () => ({ getContext: () => ctx }) };
win.addEventListener = (type, fn) => { (handlers[type] ||= []).push(fn); };
win.requestAnimationFrame = (fn) => { next = fn; };
new Function(script)();

const frame = () => { const f = next; next = null; f(); };
const fire = (type, code) => (handlers[type] || []).forEach((fn) => fn({ code, repeat: false, preventDefault: noop }));
frame();
const states = [];
for (const a of plan.actions) {
  if (a.reload) {
    fire('keydown', 'KeyR'); frame(); fire('keyup', 'KeyR');
  } else {
    a.keys.forEach((k) => fire('keydown', k));
    for (let i = 0; i < (a.hold ?? 15); i++) frame();
    a.keys.slice().reverse().forEach((k) => fire('keyup', k));
    for (let i = 0; i < (a.settle ?? 4); i++) frame();
  }
  states.push(win.__state());
}
console.log(JSON.stringify({ states, bugHit: win.__bugHit, won: win.__won === true }));
