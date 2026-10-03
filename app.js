// Wait-mode piano practice: the score cursor only advances once you play the notes under it.

import { Keyboard } from './keyboard.js';
import { connectMidi } from './midi.js';
import * as library from './library.js';
import { drawMark, marksLayer, pitchDiatonic } from './marks.js';

const $ = (sel) => document.querySelector(sel);

const osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay('score', {
  backend: 'svg',
  autoResize: false, // handled below so the cursor position survives
  drawPartNames: false,
  drawPartAbbreviations: false,
  cursorsOptions: [{ type: 0, color: '#2563eb', alpha: 0.35, follow: false }],
});

const keyboard = new Keyboard($('#keyboard'), { onNoteOn: noteOn, onNoteOff: noteOff });

const state = {
  scoreId: null,
  /** @type {{bar:number, measureIndex:number, notes:{midi:number, hand:'L'|'R', staffId:number, diatonic:number, alter:number}[]}[]} one entry per cursor position */
  steps: [],
  step: 0,
  cursorStep: 0, // where the OSMD cursor actually is
  hand: 'both',
  zoom: 1,
  loop: { on: false, from: 1, to: 4 },
  satisfied: new Set(), // notes of the current step pressed and still held
  held: new Set(),
  wrong: 0,
  /** Elements drawn on the score for each wrong key currently held. @type {Map<number, HTMLElement[]>} */
  marks: new Map(),
  /** Blue marks for the correct keys held while the step is not yet complete. @type {HTMLElement[]} */
  correctMarks: [],
  finished: false,
};

// ---------------------------------------------------------------- score loading

/** Convert file bytes to what OSMD.load() accepts: a binary string for .mxl (zip), text for XML. */
function bytesToOsmdInput(bytes) {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return s;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}

async function addFile(file) {
  const data = bytesToOsmdInput(new Uint8Array(await file.arrayBuffer()));
  const name = file.name.replace(/\.(musicxml|mxl|xml)$/i, '');
  const id = await library.addScore(name, data);
  await openScore(id);
}

async function openScore(id) {
  const score = await library.getScore(id);
  if (!score) return;

  try {
    await osmd.load(score.data);
  } catch (err) {
    alert(`Could not read this file as MusicXML:\n${err.message ?? err}`);
    return;
  }

  state.scoreId = id;
  const saved = (await library.getProgress(id)) ?? {};
  state.hand = saved.hand ?? 'both';
  state.zoom = saved.zoom ?? 1;
  state.loop = saved.loop ?? { on: false, from: 1, to: 4 };

  $('#empty').hidden = true;
  $('#title').textContent = osmd.Sheet.TitleString || score.name;
  $('#title').title = $('#title').textContent;
  try {
    localStorage.setItem('lastScore', String(id));
  } catch {}

  osmd.zoom = state.zoom;
  osmd.render();
  osmd.cursor.show();
  state.steps = collectSteps();
  state.cursorStep = 0;
  clearMarks();
  state.wrong = 0;

  const all = state.steps.flatMap((s) => s.notes.map((n) => n.midi));
  if (all.length) keyboard.setRange(Math.min(...all), Math.max(...all));

  syncControls();
  const start = Math.min(saved.step ?? 0, state.steps.length - 1);
  goTo(nextPlayable(Math.max(start, 0)) ?? firstPlayable());
}

/** MIDI note number of an OSMD note (OSMD's halfTone is 12 below MIDI). */
const noteMidi = (note) => note.halfTone + 12;

/** Walk the cursor through the whole piece once and record which keys start at each position. */
function collectSteps() {
  const cursor = osmd.cursor;
  const steps = [];
  cursor.reset();
  while (!cursor.iterator.EndReached) {
    const notes = new Map();
    for (const ve of cursor.iterator.CurrentVoiceEntries ?? []) {
      if (ve.IsGrace) continue;
      const staff = ve.ParentSourceStaffEntry.ParentStaff;
      const hand = staff.ParentInstrument.Staves.indexOf(staff) === 0 ? 'R' : 'L';
      for (const note of ve.Notes) {
        if (note.isRest() || !note.Pitch) continue;
        // A tied continuation is held, not struck again.
        if (note.NoteTie && note.NoteTie.StartNote !== note) continue;
        const midi = noteMidi(note);
        if (!notes.has(midi)) notes.set(midi, { midi, hand, staffId: staff.idInMusicSheet, diatonic: pitchDiatonic(note.Pitch), alter: note.Pitch.AccidentalHalfTones });
      }
    }
    const measureIndex = cursor.iterator.CurrentMeasureIndex;
    const bar = osmd.Sheet.SourceMeasures[measureIndex]?.MeasureNumber ?? measureIndex + 1;
    steps.push({ bar, measureIndex, notes: [...notes.values()] });
    cursor.next();
  }
  cursor.reset();
  return steps;
}

// ---------------------------------------------------------------- navigation

const required = (i) =>
  state.steps[i]?.notes.filter((n) => state.hand === 'both' || n.hand === state.hand) ?? [];

/** Index of the first step at or after `from` (or before, with dir=-1) that has notes to play. */
function nextPlayable(from, dir = 1) {
  for (let i = from; i >= 0 && i < state.steps.length; i += dir) {
    if (required(i).length) return i;
  }
  return null;
}

function firstPlayable() {
  if (state.loop.on) {
    const i = state.steps.findIndex((s, idx) => s.bar >= state.loop.from && required(idx).length);
    if (i !== -1) return i;
  }
  return nextPlayable(0) ?? 0;
}

function moveCursor(i) {
  const cursor = osmd.cursor;
  if (i === state.cursorStep) return;
  if (i === state.cursorStep + 1) {
    cursor.next();
  } else {
    cursor.reset();
    for (let k = 0; k < i; k++) cursor.next();
  }
  state.cursorStep = i;
}

function goTo(i) {
  if (!state.steps.length) return;
  state.finished = false;
  $('#done').hidden = true;
  state.step = i;
  moveCursor(i);
  state.satisfied.clear();
  syncCorrectMarks();
  keyboard.setTargets(required(i));
  for (const midi of state.held) keyboard.setHeld(midi, true);
  scrollToCursor();
  updateProgress();
  saveProgressSoon();
}

function advance() {
  let next = nextPlayable(state.step + 1);
  if (state.loop.on && (next === null || state.steps[next].bar > state.loop.to)) next = firstPlayable();
  if (next === null) finish();
  else goTo(next);
}

function back() {
  const prev = nextPlayable(state.step - 1, -1);
  if (prev !== null) goTo(prev);
}

function finish() {
  state.finished = true;
  keyboard.setTargets([]);
  $('#done').hidden = false;
  updateProgress();
}

function scrollToCursor() {
  const el = osmd.cursor.cursorElement;
  const wrap = $('#score-wrap');
  if (!el) return;
  const r = el.getBoundingClientRect();
  const w = wrap.getBoundingClientRect();
  if (r.top < w.top + 20 || r.bottom > w.bottom - 20) {
    wrap.scrollTo({ top: wrap.scrollTop + r.top - w.top - wrap.clientHeight / 4, behavior: 'smooth' });
  }
}

function updateProgress() {
  const s = state.steps[state.step];
  $('#progress').textContent = !s
    ? ''
    : `Bar ${s.bar} · ${Math.round((100 * state.step) / Math.max(1, state.steps.length - 1))}%` +
      (state.wrong ? ` · ${state.wrong} ✗` : '');
}

let saveTimer;
function saveProgressSoon() {
  clearTimeout(saveTimer);
  const id = state.scoreId;
  saveTimer = setTimeout(() => {
    if (id === null) return;
    library.saveProgress(id, { step: state.step, hand: state.hand, zoom: state.zoom, loop: state.loop });
  }, 500);
}

// ---------------------------------------------------------------- playing

function noteOn(midi) {
  state.held.add(midi);
  keyboard.setHeld(midi, true);
  keepAwake();
  if (!state.steps.length || state.finished) return;

  const targets = required(state.step);
  if (targets.some((n) => n.midi === midi)) {
    state.satisfied.add(midi);
    keyboard.markOk(midi);
    if (targets.every((n) => state.satisfied.has(n.midi))) advance();
  } else {
    state.wrong++;
    keyboard.flashWrong(midi);
    addMark(midi, targets);
    updateProgress();
  }
  syncCorrectMarks();
}

// ---------------------------------------------------------------- wrong-note marks

/** Mark a held wrong key on the staff of the nearest note you were meant to play. */
function addMark(midi, targets) {
  const layer = marksLayer(osmd);
  if (state.marks.has(midi) || !targets.length || !layer) return;
  const nearest = targets.reduce((a, b) => (Math.abs(b.midi - midi) < Math.abs(a.midi - midi) ? b : a));
  const { measureIndex } = state.steps[state.step];
  state.marks.set(midi, drawMark(layer, osmd, { x: cursorX(), measureIndex, staffId: nearest.staffId, midi }));
}

/** Horizontal centre of the cursor in page px, which is where its notes are drawn. */
function cursorX() {
  const el = osmd.cursor.cursorElement;
  return parseFloat(el.style.left) + el.width / 2;
}

function removeMark(midi) {
  for (const el of state.marks.get(midi) ?? []) el.remove();
  state.marks.delete(midi);
}

/** Show the correct keys held so far in blue, so an incomplete chord shows what is still missing. */
function syncCorrectMarks() {
  for (const el of state.correctMarks) el.remove();
  state.correctMarks = [];
  const layer = marksLayer(osmd);
  if (!state.satisfied.size || !layer) return;
  const { measureIndex } = state.steps[state.step];
  const x = cursorX();
  for (const n of required(state.step)) {
    if (state.satisfied.has(n.midi)) state.correctMarks.push(...drawMark(layer, osmd, { ...n, x, measureIndex, kind: 'correct' }));
  }
}

function clearMarks() {
  state.marks.clear();
  state.correctMarks = [];
  marksLayer(osmd)?.replaceChildren();
}

function noteOff(midi) {
  state.held.delete(midi);
  keyboard.setHeld(midi, false);
  removeMark(midi);
  // Chord notes must be held together: letting one go before the rest are down undoes it.
  if (state.satisfied.delete(midi)) keyboard.markOk(midi, false);
  syncCorrectMarks();
}

// Keep the tablet screen on while practising.
let wakeLock = null;
async function keepAwake() {
  if (wakeLock || !navigator.wakeLock || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => (wakeLock = null));
  } catch {
    /* not allowed right now; try again on the next note */
  }
}

// ---------------------------------------------------------------- controls

function syncControls() {
  for (const b of document.querySelectorAll('[data-hand]')) b.classList.toggle('on', b.dataset.hand === state.hand);
  $('#loop-on').checked = state.loop.on;
  $('#loop-from').value = state.loop.from;
  $('#loop-to').value = state.loop.to;
}

for (const b of document.querySelectorAll('[data-hand]')) {
  b.addEventListener('click', () => {
    state.hand = b.dataset.hand;
    syncControls();
    goTo(nextPlayable(state.step) ?? firstPlayable());
  });
}

function readLoop() {
  const from = Math.max(1, Number($('#loop-from').value) || 1);
  const to = Math.max(from, Number($('#loop-to').value) || from);
  state.loop = { on: $('#loop-on').checked, from, to };
  syncControls();
  saveProgressSoon();
}
$('#loop-on').addEventListener('change', () => {
  readLoop();
  if (state.loop.on) goTo(firstPlayable());
});
$('#loop-from').addEventListener('change', () => {
  readLoop();
  if (state.loop.on) goTo(firstPlayable());
});
$('#loop-to').addEventListener('change', readLoop);

$('#btn-restart').addEventListener('click', () => {
  state.wrong = 0;
  clearMarks();
  goTo(firstPlayable());
});
$('#btn-again').addEventListener('click', () => {
  state.wrong = 0;
  clearMarks();
  goTo(firstPlayable());
});
$('#btn-prev').addEventListener('click', back);
$('#btn-next').addEventListener('click', () => state.steps.length && !state.finished && advance());

function setZoom(z) {
  if (!state.steps.length) return;
  state.zoom = Math.min(2.5, Math.max(0.4, Math.round(z * 10) / 10));
  osmd.zoom = state.zoom;
  rerender();
  saveProgressSoon();
}
$('#btn-zoom-in').addEventListener('click', () => setZoom(state.zoom + 0.1));
$('#btn-zoom-out').addEventListener('click', () => setZoom(state.zoom - 0.1));

/** Re-render the score and put the cursor back where it was. */
function rerender() {
  osmd.render();
  osmd.cursor.show();
  state.cursorStep = 0;
  osmd.cursor.reset();
  clearMarks();
  moveCursor(state.step);
  scrollToCursor();
}

// OSMD re-renders on resize (e.g. rotating the tablet); keep the cursor on the same note.
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => state.steps.length && rerender(), 300);
});

// Hide the on-screen keyboard to give the score more room; remembered on this device.
function showKeyboard(show) {
  $('#keyboard').hidden = !show;
  $('#btn-keys').classList.toggle('on', show);
  try {
    localStorage.setItem('showKeyboard', String(show));
  } catch {}
}
$('#btn-keys').addEventListener('click', () => showKeyboard($('#keyboard').hidden));
try {
  showKeyboard(localStorage.getItem('showKeyboard') !== 'false');
} catch {}

// ---------------------------------------------------------------- library dialog

async function showLibrary() {
  const list = $('#lib-list');
  list.replaceChildren();
  for (const s of await library.listScores()) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = s.name;
    name.addEventListener('click', () => {
      $('#library').close();
      openScore(s.id);
    });
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      if (!confirm(`Delete "${s.name}"?`)) return;
      await library.deleteScore(s.id);
      showLibrary();
    });
    li.append(name, del);
    list.append(li);
  }
  if (!$('#library').open) $('#library').showModal();
}
$('#btn-library').addEventListener('click', showLibrary);

for (const input of document.querySelectorAll('.file-input')) {
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if ($('#library').open) $('#library').close();
    await addFile(file);
  });
}

// ---------------------------------------------------------------- startup

// The pill shows the full status (device name or what is wrong) for a few seconds after it
// changes, then shrinks to a short label so the toolbar stays on one row.
let midiStatusTimer;
function showMidiStatus(text, connected) {
  const pill = $('#midi-status');
  pill.textContent = text;
  pill.title = `${text}\nTap to reconnect`;
  pill.classList.toggle('connected', connected);
  clearTimeout(midiStatusTimer);
  midiStatusTimer = setTimeout(() => (pill.textContent = connected ? 'MIDI ✓' : 'MIDI ✗'), 5000);
}

function startMidi() {
  connectMidi({ onNoteOn: noteOn, onNoteOff: noteOff, onStatus: showMidiStatus });
}
$('#midi-status').addEventListener('click', startMidi);
startMidi();

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.steps.length) keepAwake();
});

let last = 0;
try {
  last = Number(localStorage.getItem('lastScore'));
} catch {}
if (last) openScore(last);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js');
}

// Hooks for automated tests.
window.__tutor = { state, noteOn, noteOff, openScore, addFile, osmd };
