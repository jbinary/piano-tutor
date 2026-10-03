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
play(48); assert.equal(S.step, 0, 'hands played one after another do not count');
play(60, 48); assert.equal(S.step, 1);
play(62); assert.equal(S.step, 2);
play(64, 43); assert.equal(S.step, 3);
play(60, 64); assert.equal(S.step, 3, 'chord incomplete');
play(67); assert.equal(S.step, 3, 'chord notes played one after another do not count');
t.noteOn(60); t.noteOn(64); t.noteOff(60); t.noteOn(67);
assert.equal(S.step, 3, 'a chord note released early does not count');
assert.ok(!w.document.querySelector('[data-midi="60"]').classList.contains('ok'), 'released chord note loses its green');
t.noteOn(60); assert.equal(S.step, 4, 'all held together'); assert.equal(cursorBar(), 1);
t.noteOff(60); t.noteOff(64); t.noteOff(67);
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
// repeats, 1st/2nd endings and D.C. al Fine are followed in playing order
const loadSample = async (name) => {
  const buf = fs.readFileSync(`${ROOT}/samples/${name}`);
  const f = new w.File([buf], name);
  f.arrayBuffer = async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  await t.addFile(f);
};
for (const [name, order] of [
  ['test-repeat.musicxml', [1, 2, 3, 2, 3, 4]],
  ['test-volta.musicxml', [1, 2, 3, 2, 4, 5]],
  ['test-repeat-from-start.musicxml', [1, 2, 1, 2, 3]],
  ['test-dc.musicxml', [1, 2, 3, 1, 2]],
]) {
  await loadSample(name);
  assert.deepEqual([...S.steps.map((s) => s.bar)], order, name);
  for (const st of [...S.steps]) for (const n of st.notes) play(n.midi);
  assert.equal(S.finished, true, `${name} reaches the end`);
  w.document.querySelector('#btn-restart').click();
  assert.equal(S.step, 0);
  assert.equal(t.osmd.cursor.iterator.CurrentMeasureIndex, 0, `${name} restart goes to bar 1`);
}
console.log('repeats: ok');

// held wrong notes are marked on the score at the right pitch and staff, and vanish on release
await loadSample('test-two-hands.musicxml');
const layer = () => w.document.querySelector('.marks');
const dots = () => [...layer().querySelectorAll('.mark-dot')];
const centreY = (el) => parseFloat(el.style.top) + parseFloat(el.style.height) / 2;
const staffTop = (i) => t.osmd.GraphicSheet.MeasureList[0][i].ParentStaffLine.PositionAndShape.AbsolutePosition.y * 10;
// step 0 wants C4 (treble) + C3 (bass)
t.noteOn(62); // D4: one staff step above C4 on the treble staff (top line F5)
assert.equal(dots().length, 1);
assert.equal(centreY(dots()[0]), staffTop(0) + (38 - 29) * 5);
t.noteOn(50); // D3: nearest target is C3, so it goes on the bass staff (top line A3)
assert.equal(centreY(dots()[1]), staffTop(1) + (26 - 22) * 5);
t.noteOff(62);
assert.equal(dots().length, 1, 'released key loses its dot');
assert.equal(centreY(dots()[0]), staffTop(1) + (26 - 22) * 5, 'held key keeps its dot');
t.noteOff(50);
assert.equal(layer().children.length, 0);
t.noteOn(61); // C#4 is drawn on the C line with a sharp and a ledger line
assert.equal(centreY(dots()[0]), staffTop(0) + (38 - 28) * 5);
assert.equal(layer().querySelectorAll('.mark-sharp').length, 1);
assert.equal(layer().querySelectorAll('.mark-ledger').length, 1);
t.noteOff(61);
assert.equal(layer().children.length, 0, 'sharp and ledger line go too');
t.noteOn(84); // C6 needs two ledger lines above the treble staff
assert.equal(layer().querySelectorAll('.mark-ledger').length, 2);
t.noteOff(84);
assert.equal(S.wrong, 4);
t.noteOn(62);
w.document.querySelector('#btn-restart').click();
assert.equal(layer().children.length, 0, 'restart clears marks');
t.noteOff(62);
// correct keys held while the step is incomplete are marked in blue, the same way as wrong ones
const blues = () => [...layer().querySelectorAll('.mark-dot.correct')];
assert.equal(S.step, 0); // wants C4 + C3
t.noteOn(60);
assert.equal(blues().length, 1, 'blue while C3 is still missing, even with no wrong key');
assert.equal(centreY(blues()[0]), staffTop(0) + (38 - 28) * 5, 'C4 in blue');
t.noteOn(62); // plus D4 wrong
assert.equal(blues().length, 1);
assert.equal(parseFloat(blues()[0].style.left), parseFloat(dots().find((d) => !d.classList.contains('correct')).style.left), 'same column as the red dot');
assert.equal(layer().querySelectorAll('.mark-ledger.correct').length, 1, "C4's ledger line in blue");
t.noteOff(60);
assert.equal(blues().length, 0, 'released correct key loses its blue dot');
t.noteOn(60);
assert.equal(blues().length, 1);
t.noteOff(62);
assert.equal(blues().length, 1, 'blue stays after the wrong key is released');
t.noteOn(62); t.noteOn(48); // completing the step moves on and clears the blue
assert.equal(S.step, 1); assert.equal(blues().length, 0);
assert.equal(layer().querySelectorAll('.correct').length, 0);
t.noteOff(62); t.noteOff(60); t.noteOff(48);
// written spelling: F#4 in bar 2 is drawn on the F line with a sharp
while (S.step < 4) w.document.querySelector('#btn-next').click();
t.noteOn(66); t.noteOn(70);
const top1 = t.osmd.GraphicSheet.MeasureList[1][0].ParentStaffLine.PositionAndShape.AbsolutePosition.y * 10;
assert.equal(centreY(blues()[0]), top1 + (38 - 31) * 5);
assert.equal(layer().querySelector('.mark-sharp.correct')?.textContent, '♯');
t.noteOff(66); t.noteOff(70);
const { pitchDiatonic } = await import(`${ROOT}/marks.js`);
assert.equal(pitchDiatonic({ Octave: 1, FundamentalNote: 11 }), 34, 'Bb4 is written on the B line');
console.log('wrong-note marks: ok');
// the on-screen keyboard can be hidden, and that is remembered
const keysBtn = w.document.querySelector('#btn-keys');
assert.equal(w.document.querySelector('#keyboard').hidden, false);
keysBtn.click();
assert.equal(w.document.querySelector('#keyboard').hidden, true);
assert.ok(!keysBtn.classList.contains('on'));
assert.equal(w.localStorage.getItem('showKeyboard'), 'false');
t.noteOn(60); t.noteOff(60); // playing still works while hidden
keysBtn.click();
assert.equal(w.document.querySelector('#keyboard').hidden, false);
assert.ok(keysBtn.classList.contains('on'));
console.log('hide keyboard: ok');
console.log('ALL OK');
process.exit(0);
