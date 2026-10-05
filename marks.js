// Dots on the score placed on the staff by pitch: red for wrong keys being held, blue for correct
// keys held while the step is still incomplete.
//
// Positions are taken from where OSMD actually drew the notes at the cursor, so clefs, 8va/8vb
// lines and transposition are all accounted for; a wrong note is placed relative to the nearest
// note you were meant to play.

// Diatonic step (C=0 … B=6) and whether the key is a sharp, for each pitch class.
const STEP = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
const SHARP = [false, true, false, true, false, false, true, false, true, false, true, false];
const ACCIDENTAL = { '-2': '𝄫', '-1': '♭', 1: '♯', 2: '𝄪' };

/** Diatonic position counted from C0 (C4 = 28), spelling black keys as sharps. */
export const diatonic = (midi) => (Math.floor(midi / 12) - 1) * 7 + STEP[midi % 12];

/** Diatonic position of a sounding note spelled with letter `fund` (semitones, C=0 … B=11) and `alter`. */
export function spelledDiatonic(midi, fund, alter) {
  const octave = Math.round((midi - fund - alter) / 12) - 1;
  return octave * 7 + STEP[fund];
}

/** Accidental to show for a wrong key, which has no written spelling: black keys as sharps. */
export const wrongAlter = (midi) => (SHARP[midi % 12] ? 1 : 0);

/** A transparent layer over the rendered page that the dots are drawn into. */
export function marksLayer(osmd) {
  const page = osmd.cursor.cursorElement?.parentElement;
  if (!page) return null;
  let layer = page.querySelector(':scope > .marks');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'marks';
    page.append(layer);
  }
  return layer;
}

/** Where a graphical note's head and its staff's top line are drawn, in OSMD units. */
export function notePosition(gnote) {
  const staffLine = gnote.parentVoiceEntry.parentStaffEntry.parentMeasure.ParentStaffLine;
  return { y: gnote.PositionAndShape.AbsolutePosition.y, staffTop: staffLine.PositionAndShape.AbsolutePosition.y };
}

/**
 * Draw one played note just right of the cursor's notes, with its own ledger lines and accidental.
 * @returns {HTMLElement[]} the drawn elements, so the caller can remove them
 * @param {HTMLElement} layer
 * @param {object} osmd
 * @param {{x:number, y:number, staffTop:number, alter:number, kind:'wrong'|'correct'}} mark
 *   x is the note column in px; y (note head) and staffTop (top staff line) are in OSMD units
 */
export function drawMark(layer, osmd, { x, y, staffTop, alter, kind }) {
  const unit = 10 * osmd.zoom; // px per staff space
  const cx = x + 1.4 * unit; // just right of the written notes so both stay readable
  const pos = Math.round((y - staffTop) * 2); // half staff spaces below the top line (bottom line = 8)
  const px = (p) => (staffTop + p / 2) * unit;

  const els = [];
  const add = (cls, style, text) => {
    const el = document.createElement('div');
    el.className = `${cls} ${kind}`;
    Object.assign(el.style, style);
    if (text) el.textContent = text;
    layer.append(el);
    els.push(el);
  };

  // Ledger lines so notes above/below the staff can be read.
  const ledger = (p) => add('mark-ledger', { left: `${cx - unit}px`, top: `${px(p)}px`, width: `${2 * unit}px` });
  for (let p = -2; p >= pos; p -= 2) ledger(p);
  for (let p = 10; p <= pos; p += 2) ledger(p);

  const size = 1.1 * unit;
  add('mark-dot', { left: `${cx - size / 2}px`, top: `${px(pos) - size / 2}px`, width: `${size}px`, height: `${size}px` });
  const accidental = ACCIDENTAL[alter];
  if (accidental) {
    add('mark-sharp', { left: `${cx - 1.9 * unit}px`, top: `${px(pos) - 1.1 * unit}px`, fontSize: `${1.6 * unit}px` }, accidental);
  }
  return els;
}
