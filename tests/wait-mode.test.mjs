// Runs the real app (OSMD + app.js) in jsdom and plays notes into it.
// Usage: npm install && npm test
import { JSDOM } from 'jsdom';
import 'fake-indexeddb/auto';
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const html = fs.readFileSync(`${ROOT}/index.html`, 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' });
const w = dom.window;
w.setImmediate = setImmediate; w.indexedDB = indexedDB; w.IDBKeyRange = IDBKeyRange;
w.TextDecoder = TextDecoder; w.alert = (m) => { throw new Error('alert: ' + m); };
w.HTMLDialogElement.prototype.showModal ??= function () { this.open = true; };
w.HTMLDialogElement.prototype.close ??= function () { this.open = false; };
w.Element.prototype.scrollTo = () => {};
// layout stubs OSMD needs in jsdom
Object.defineProperty(w.HTMLElement.prototype, 'offsetWidth', { get: () => 1200 });
const anything = new Proxy(function () {}, { get: (o, k) => (k === Symbol.toPrimitive ? () => 0 : anything), apply: () => anything });
w.HTMLCanvasElement.prototype.getContext = () => new Proxy({ measureText: (t) => ({ width: String(t).length * 7, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 }) }, { get: (o, k) => (k in o ? o[k] : () => anything), set: () => true });
w.SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 10, height: 10 });
w.eval(fs.readFileSync(`${ROOT}/vendor/opensheetmusicdisplay.min.js`, 'utf8'));
const bundle = await esbuild.build({ entryPoints: [`${ROOT}/app.js`], bundle: true, format: 'iife', write: false });
w.eval(bundle.outputFiles[0].text);

const t = w.__tutor;
const file = new w.File([fs.readFileSync(`${ROOT}/samples/test-two-hands.musicxml`)], 'test-two-hands.musicxml');
file.arrayBuffer ??= async () => fs.readFileSync(`${ROOT}/samples/test-two-hands.musicxml`).buffer;
await t.addFile(file);

const S = t.state;
const fmt = (st) => st.notes.map((n) => n.hand + n.midi).join(' ') || '-';
console.log('steps:', S.steps.map((s) => `b${s.bar}[${fmt(s)}]`).join('  '));
assert.deepEqual([...S.steps.map(fmt)], ['R60 L48', 'R62', 'R64 L43', 'R60 R64 R67', 'R66 L48', '-', '-']);
assert.equal(S.step, 0);

const play = (...ns) => { for (const n of ns) t.noteOn(n); for (const n of ns) t.noteOff(n); };
const cursorBar = () => t.osmd.cursor.iterator.CurrentMeasureIndex;

play(60); assert.equal(S.step, 0, 'needs both hands');
play(61); assert.equal(S.wrong, 1);
play(48); assert.equal(S.step, 1);
play(62); assert.equal(S.step, 2);
play(64, 43); assert.equal(S.step, 3);
play(60, 64); assert.equal(S.step, 3, 'chord incomplete');
play(67); assert.equal(S.step, 4); assert.equal(cursorBar(), 1);
play(66, 48); assert.equal(S.finished, true);
console.log('both hands: ok');

// right hand only
w.document.querySelector('[data-hand=R]').click();
w.document.querySelector('#btn-restart').click();
assert.equal(S.step, 0); assert.equal(S.wrong, 0);
play(60); play(62); play(64); play(60, 64, 67);
assert.equal(S.step, 4); play(66); assert.equal(S.finished, true);
console.log('right hand: ok');

// left hand only: steps 0, 2, 4
w.document.querySelector('[data-hand=L]').click();
w.document.querySelector('#btn-restart').click();
play(48); assert.equal(S.step, 2); play(43); assert.equal(S.step, 4); play(48); assert.equal(S.finished, true);
console.log('left hand: ok');

// loop bar 1 with both hands
w.document.querySelector('[data-hand=both]').click();
w.document.querySelector('#loop-to').value = '1';
w.document.querySelector('#loop-to').dispatchEvent(new w.Event('change'));
const lo = w.document.querySelector('#loop-on'); lo.checked = true; lo.dispatchEvent(new w.Event('change'));
assert.equal(S.step, 0);
play(60, 48); play(62); play(64, 43); play(60, 64, 67);
assert.equal(S.step, 0, 'looped back'); assert.equal(cursorBar(), 0);
console.log('loop: ok');

// prev/next buttons and cursor sync
w.document.querySelector('#btn-next').click(); w.document.querySelector('#btn-next').click();
assert.equal(S.step, 2);
w.document.querySelector('#btn-prev').click(); assert.equal(S.step, 1);
const iter = t.osmd.cursor.iterator;
assert.equal(iter.CurrentVoiceEntries[0].Notes[0].halfTone + 12, 62, 'cursor sits on D4');
console.log('prev/next + cursor: ok');

// target highlighting on the on-screen keyboard
const kb = w.document.querySelector('#keyboard');
assert.ok(kb.querySelector('[data-midi="62"]').classList.contains('target-R'));
console.log('keyboard keys:', kb.children.length);

// progress persisted, reopening restores position
await new Promise((r) => setTimeout(r, 700));
await t.openScore(S.scoreId);
assert.equal(S.step, 1); assert.equal(S.loop.on, true);
console.log('persistence: ok');
const mxl = fs.readFileSync(`${ROOT}/samples/test-two-hands.mxl`);
const f2 = new w.File([mxl], 'test.mxl'); f2.arrayBuffer = async () => mxl.buffer.slice(mxl.byteOffset, mxl.byteOffset + mxl.length);
await t.addFile(f2);
assert.equal(S.steps.length, 7); assert.equal(w.document.querySelector('#title').textContent, 'Wait Mode Test');
console.log('mxl: ok');
console.log('ALL OK');
process.exit(0);
