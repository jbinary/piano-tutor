// Wait-mode piano practice: the score cursor only advances once you play the notes under it.

import { Keyboard } from './keyboard.js';
import { connectMidi } from './midi.js';
import * as library from './library.js';
import { diatonic, drawMark, marksLayer, notePosition, spelledDiatonic, wrongAlter } from './marks.js';

const $ = (sel) => document.querySelector(sel);

const osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay('score', {
  backend: 'svg',
  autoResize: false, // handled below so the cursor position survives
  drawPartNames: false,
  drawPartAbbreviations: false,
  cursorsOptions: [{ type: 0, color: '#2563eb', alpha: 0.35, follow: false }],
});
osmd.TransposeCalculator = new opensheetmusicdisplay.TransposeCalculator();

const keyboard = new Keyboard($('#keyboard'), { onNoteOn: noteOn, onNoteOff: noteOff });

const state = {
  scoreId: null,
  /** @type {{bar:number, measureIndex:number, notes:{midi:number, hand:'L'|'R', source:object, fund:number, alter:number}[]}[]} one entry per cursor position */
  steps: [],
  step: 0,
  cursorStep: 0, // where the OSMD cursor actually is
  hand: 'both',
  zoom: 1,
  transpose: 0, // semitones
  loop: { on: false, from: 1, to: 4 },
  satisfied: new Set(), // notes of the current step pressed and still held
  held: new Set(),
  wrong: 0, // wrong keys pressed in this pass
  played: 0, // notes played right in this pass
  /** Seconds this pass took to play, and would take at the written tempo. */
  time: { played: 0, written: 0 },
  /** When the last step was completed by playing it, to time the next one. @type {{step:number, at:number}|null} */
  lastDone: null,
  /** Whether this pass started at the beginning (of the piece or loop), so it can be a best. */
  fullPass: false,
  /** Best pass per hand and loop range, e.g. `both bars 5-8`. @type {Record<string, object>} */
  best: {},
  /** Elements drawn on the score for each wrong key currently held. @type {Map<number, HTMLElement[]>} */
  marks: new Map(),
  /** Blue marks for the correct keys held while the step is not yet complete. @type {HTMLElement[]} */
  correctMarks: [],
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
  state.transpose = saved.transpose ?? 0;
  state.loop = saved.loop ?? { on: false, from: 1, to: 4 };
  state.best = saved.best ?? {};

  $('#empty').hidden = true;
  $('#title').textContent = osmd.Sheet.TitleString || score.name;
  $('#title').title = $('#title').textContent;
  try {
    localStorage.setItem('lastScore', String(id));
  } catch {}

  osmd.zoom = state.zoom;
  if (state.transpose) {
    osmd.Sheet.Transpose = state.transpose;
    osmd.updateGraphic();
  }
  renderScore();
  resetStats();

  syncControls();
  const start = Math.min(saved.step ?? 0, state.steps.length - 1);
  goTo(nextPlayable(Math.max(start, 0)) ?? firstPlayable());
}

/** Draw the score and (re)read the notes to play, which change with transposition. */
function renderScore() {
  osmd.render();
  osmd.cursor.show();
  state.steps = collectSteps();
  state.cursorStep = 0;
  clearMarks();
  const all = state.steps.flatMap((s) => s.notes.map((n) => n.midi));
  if (all.length) keyboard.setRange(Math.min(...all), Math.max(...all));
}

/**
 * MIDI key for an OSMD note, transposed. Computed from the sounding pitch (OSMD: C4 is octave 1)
 * rather than OSMD's halfTone, which loses 8va/8vb lines once the score is transposed.
 */
const noteMidi = (note) => {
  const p = note.Pitch;
  return (p.Octave + 4) * 12 + p.FundamentalNote + p.AccidentalHalfTones + state.transpose;
};

/**
 * Keys of a chord that are held over from the chord before it: when any note of the chord is a
 * tied continuation, its other notes that repeat a pitch of the chord it's tied from count as tied
 * too (scores often tie just one note of a chord).
 */
function chordHeldOver(ve) {
  const cont = ve.Notes.find((n) => n.NoteTie && n.NoteTie.StartNote !== n);
  if (!cont) return new Set();
  const tied = cont.NoteTie.Notes;
  const from = tied[tied.indexOf(cont) - 1]?.ParentVoiceEntry;
  const pitches = new Set((from?.Notes ?? []).filter((n) => n.Pitch).map(noteMidi));
  return new Set(ve.Notes.filter((n) => n.Pitch && pitches.has(noteMidi(n))).map(noteMidi));
}

/**
 * The parts to play: the piano ones (two staves) when the score has any, so a vocal line printed
 * above the piano isn't asked for; otherwise every part.
 */
function pianoParts() {
  const all = osmd.Sheet.Instruments;
  const piano = all.filter((i) => i.Staves.length >= 2);
  return new Set(piano.length ? piano : all);
}

/** Walk the cursor through the whole piece once and record which keys start at each position. */
function collectSteps() {
  const cursor = osmd.cursor;
  const steps = [];
  const parts = pianoParts();
  cursor.reset();
  while (!cursor.iterator.EndReached) {
    const notes = new Map();
    for (const ve of cursor.iterator.CurrentVoiceEntries ?? []) {
      if (ve.IsGrace) continue;
      const staff = ve.ParentSourceStaffEntry.ParentStaff;
      if (!parts.has(staff.ParentInstrument)) continue;
      const hand = staff.ParentInstrument.Staves.indexOf(staff) === 0 ? 'R' : 'L';
      const held = chordHeldOver(ve);
      for (const note of ve.Notes) {
        if (note.isRest() || !note.Pitch) continue;
        // A tied continuation is held, not struck again.
        if (note.NoteTie && note.NoteTie.StartNote !== note) continue;
        if (held.has(noteMidi(note))) continue;
        const midi = noteMidi(note);
        // Spelling as drawn (TransposedPitch can be left over from an earlier transposition).
        const written = (state.transpose && note.TransposedPitch) || note.Pitch;
        if (!notes.has(midi)) {
          notes.set(midi, { midi, hand, source: note, fund: written.FundamentalNote, alter: written.AccidentalHalfTones });
        }
      }
    }
    const measureIndex = cursor.iterator.CurrentMeasureIndex;
    const measure = osmd.Sheet.SourceMeasures[measureIndex];
    const bar = measure?.MeasureNumber ?? measureIndex + 1;
    const time = cursor.iterator.currentTimeStamp.RealValue; // in whole notes, without repeats
    const measureEnd = measure ? measure.AbsoluteTimestamp.RealValue + measure.Duration.RealValue : time;
    const bpm = measure?.TempoInBPM || osmd.Sheet.DefaultStartTempoInBpm || 100;
    steps.push({ bar, measureIndex, notes: [...notes.values()], time, measureEnd, bpm, seconds: 0 });
    cursor.next();
  }
  cursor.reset();
  // How long each step lasts at the written tempo (quarter-note beats): until the next step, or
  // the end of its bar when the next step is a jump back (repeat) or ahead (skipped ending).
  steps.forEach((st, i) => {
    const next = steps[i + 1]?.time ?? Infinity;
    const whole = Math.min(next > st.time ? next - st.time : Infinity, st.measureEnd - st.time);
    st.seconds = ((whole * 4) / st.bpm) * 60;
  });
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
  state.played += required(state.step).length;
  timeStep();
  let next = nextPlayable(state.step + 1);
  // The end of the loop, or of the piece, starts the next pass from the beginning.
  if (next === null || (state.loop.on && leavesLoop(state.step, next))) {
    next = firstPlayable();
    showPassStats();
    resetStats();
  }
  goTo(next);
}

/**
 * Whether going from step `from` to `to` leaves the loop: past its last bar, or out of its last
 * bar in any direction, so a repeat in the score that ends on that bar isn't played as well.
 */
function leavesLoop(from, to) {
  for (let k = from + 1; k <= to; k++) {
    const bar = state.steps[k].bar;
    if (bar > state.loop.to || (state.steps[k - 1].bar === state.loop.to && bar !== state.loop.to)) return true;
  }
  return false;
}

function back() {
  const prev = nextPlayable(state.step - 1, -1);
  if (prev !== null) goTo(prev);
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

/**
 * Add the time since the previous completed step to the pass, next to how long the same notes
 * last at the written tempo. A long pause (walking away) counts as at most 3× the written time, or
 * 10 s; jumping around with the buttons starts timing afresh.
 */
function timeStep() {
  const now = performance.now();
  const last = state.lastDone;
  if (last && state.step > last.step) {
    let written = 0;
    for (let k = last.step; k < state.step; k++) written += state.steps[k].seconds;
    state.time.written += written;
    state.time.played += Math.min((now - last.at) / 1000, Math.max(10, 3 * written));
  }
  if (!last) state.fullPass = state.step === firstPlayable();
  state.lastDone = { step: state.step, at: now };
}

function resetStats() {
  state.wrong = 0;
  state.played = 0;
  state.time = { played: 0, written: 0 };
  state.lastDone = null;
  state.fullPass = false;
  updateProgress();
}

/**
 * The pass's score out of 100: accuracy (right keys out of all keys pressed) squared, so mistakes
 * weigh more than slowness, times speed (share of the written tempo, at most 1).
 */
function passScore({ played, wrong, time }) {
  const accuracy = played / Math.max(1, played + wrong);
  const tempo = time.played > 0 ? Math.min(1, time.written / time.played) : 1;
  return Math.round(100 * accuracy * accuracy * tempo);
}

const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

/** What a best is kept for: the hand(s) played and the loop's bars, or the whole piece. */
const bestKey = () => `${state.hand} ${state.loop.on ? `bars ${state.loop.from}-${state.loop.to}` : 'whole'}`;

/** Briefly show the pass's score, with the wrong keys, time and tempo it's made from. */
let statsTimer;
function showPassStats() {
  const total = state.played + state.wrong;
  const pct = Math.round((100 * state.wrong) / Math.max(1, total));
  const { played, written } = state.time;
  const el = $('#pass-stats');
  const details = [
    state.wrong ? `${state.wrong} wrong · ${pct}% of ${total} notes played` : `No wrong notes · ${total} played 🎉`,
  ];
  const tempo = played > 0 ? Math.round((100 * written) / played) : null;
  if (tempo !== null) details.push(`${clock(played)} · ${tempo}% of tempo`);
  const score = passScore(state);
  el.innerHTML = '';
  const line = (cls, text) => {
    const div = document.createElement('div');
    div.className = cls;
    div.textContent = text;
    el.append(div);
  };
  line('score', `🔁 Score ${score}`);
  line('details', details.join(' · '));
  if (state.fullPass) {
    const key = bestKey();
    const prev = state.best[key];
    if (!prev || score > prev.score) {
      state.best[key] = { score, wrong: state.wrong, notes: total, seconds: Math.round(played), tempo, date: Date.now() };
      saveProgressSoon();
      line('best new', prev ? `🏆 New best! (was ${prev.score})` : '🏆 New best!');
    } else {
      line('best', `Best ${prev.score} · ${new Date(prev.date).toLocaleDateString()}`);
    }
  }
  el.hidden = false;
  clearTimeout(statsTimer);
  statsTimer = setTimeout(() => { el.hidden = true; }, 5000);
}

/**
 * Bar, percent and wrong count each get a fixed width, so the toolbar doesn't shift as numbers
 * grow by a digit (which looks like something just went wrong).
 */
function updateProgress() {
  const s = state.steps[state.step];
  const el = $('#progress');
  if (!s) {
    el.textContent = '';
    return;
  }
  const lastBar = Math.max(...state.steps.map((st) => st.bar));
  const pct = Math.round((100 * state.step) / Math.max(1, state.steps.length - 1));
  el.innerHTML =
    `Bar <span class="num" style="width:${String(lastBar).length}ch">${s.bar}</span> · ` +
    `<span class="num" style="width:3ch">${pct}</span>% ` +
    `<span class="wrong-count">${state.wrong ? `· ${state.wrong} ✗` : ''}</span>`;
}

let saveTimer;
function saveProgressSoon() {
  clearTimeout(saveTimer);
  const id = state.scoreId;
  saveTimer = setTimeout(() => {
    if (id === null) return;
    library.saveProgress(id, { step: state.step, hand: state.hand, zoom: state.zoom, transpose: state.transpose, loop: state.loop, best: state.best });
  }, 500);
}

// ---------------------------------------------------------------- playing

function noteOn(midi) {
  state.held.add(midi);
  keyboard.setHeld(midi, true);
  keepAwake();
  if (!state.steps.length) return;

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
  const at = drawnPosition(nearest);
  if (!at) return;
  // Same staff as that note, moved by the number of staff steps between the two pitches.
  const steps = spelledDiatonic(nearest.midi, nearest.fund, nearest.alter) - diatonic(midi);
  const y = at.y + steps / 2;
  state.marks.set(midi, drawMark(layer, osmd, { x: cursorX(), y, staffTop: at.staffTop, alter: wrongAlter(midi), kind: 'wrong' }));
}

/** Where a note at the cursor is drawn (see notePosition), or null if OSMD didn't draw it. */
function drawnPosition(note) {
  const g = osmd.cursor.GNotesUnderCursor().find((gn) => gn.sourceNote === note.source);
  return g ? notePosition(g) : null;
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
  const x = cursorX();
  for (const n of required(state.step)) {
    const at = state.satisfied.has(n.midi) && drawnPosition(n);
    if (at) state.correctMarks.push(...drawMark(layer, osmd, { x, ...at, alter: n.alter, kind: 'correct' }));
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
  $('#transpose').value = String(state.transpose);
}

for (const b of document.querySelectorAll('[data-hand]')) {
  b.addEventListener('click', () => {
    state.hand = b.dataset.hand;
    resetStats(); // a pass played partly with the other hand(s) doesn't count
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
  if (state.loop.on) {
    resetStats();
    goTo(firstPlayable());
  }
});
$('#loop-from').addEventListener('change', () => {
  readLoop();
  if (state.loop.on) {
    resetStats();
    goTo(firstPlayable());
  }
});
$('#loop-to').addEventListener('change', readLoop);

$('#btn-restart').addEventListener('click', () => {
  resetStats();
  clearMarks();
  goTo(firstPlayable());
});
$('#btn-prev').addEventListener('click', back);
$('#btn-next').addEventListener('click', () => {
  if (!state.steps.length) return;
  state.fullPass = false; // skipping notes doesn't count towards a best
  advance();
});

function setZoom(z) {
  if (!state.steps.length) return;
  state.zoom = Math.min(2.5, Math.max(0.4, Math.round(z * 10) / 10));
  osmd.zoom = state.zoom;
  rerender();
  saveProgressSoon();
}
$('#btn-zoom-in').addEventListener('click', () => setZoom(state.zoom + 0.1));
$('#btn-zoom-out').addEventListener('click', () => setZoom(state.zoom - 0.1));

// Transposition keeps the piece's structure, so the cursor stays on the same step.
function setTranspose(semitones) {
  if (!state.steps.length) return;
  state.transpose = semitones;
  osmd.Sheet.Transpose = semitones;
  osmd.updateGraphic();
  renderScore();
  syncControls();
  goTo(Math.min(state.step, state.steps.length - 1));
  saveProgressSoon();
}
for (let n = 12; n >= -12; n--) {
  const label = n === 0 ? '±0' : `${n > 0 ? '+' : '−'}${Math.abs(n)}`;
  $('#transpose').append(new Option(`Tr ${label}`, String(n), n === 0, n === 0));
}
$('#transpose').addEventListener('change', (e) => setTranspose(Number(e.target.value)));

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
