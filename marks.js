// Dots on the score placed on the staff by pitch: red for wrong keys being held, blue for correct
// keys held while the step is still incomplete.

// Diatonic step (C=0 … B=6) and whether the key is a sharp, for each pitch class.
const STEP = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
const SHARP = [false, true, false, true, false, false, true, false, true, false, true, false];

/** Position on the staff counted in diatonic steps from C0 (C4 = 28), spelling black keys as sharps. */
export const diatonic = (midi) => (Math.floor(midi / 12) - 1) * 7 + STEP[midi % 12];

/** Diatonic position of a note as written in the score (OSMD: C4 is octave 1, FundamentalNote in semitones). */
export const pitchDiatonic = (pitch) => (pitch.Octave + 3) * 7 + STEP[pitch.FundamentalNote];

// Diatonic position of the line each clef sits on: G4, F3, C4 (OSMD ClefEnum G=0, F=1, C=2).
const CLEF_LINE_PITCH = { 0: 32, 1: 24, 2: 28 };

/** Diatonic position of the top staff line for a clef, or null for percussion/tab clefs. */
function topLine(clef) {
  const base = CLEF_LINE_PITCH[clef?.ClefType];
  if (base === undefined) return null;
  return base + (clef.OctaveOffset ?? 0) * 7 + (5 - clef.Line) * 2;
}

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

const ACCIDENTAL = { '-2': '𝄫', '-1': '♭', 1: '♯', 2: '𝄪' };

/**
 * Draw one played note just right of the cursor's notes, with its own ledger lines and accidental.
 * @returns {HTMLElement[]} the drawn elements, so the caller can remove them
 * @param {HTMLElement} layer
 * @param {object} osmd
 * @param {{x:number, measureIndex:number, staffId:number, midi:number, diatonic?:number, alter?:number, kind?:'wrong'|'correct'}} mark
 *   x is the note column in px; diatonic/alter give the written spelling (default: black keys as sharps)
 */
export function drawMark(layer, osmd, { x, measureIndex, staffId, midi, diatonic: written, alter, kind = 'wrong' }) {
  const measure = osmd.GraphicSheet.MeasureList[measureIndex]?.find((m) => m?.ParentStaff?.idInMusicSheet === staffId);
  const top = topLine(measure?.InitiallyActiveClef);
  if (!measure || top === null) return [];

  const unit = 10 * osmd.zoom; // px per staff space
  const staffTop = measure.ParentStaffLine.PositionAndShape.AbsolutePosition.y * unit;
  const yOf = (d) => staffTop + ((top - d) / 2) * unit;
  const cx = x + 1.4 * unit; // just right of the written notes so both stay readable
  const d = written ?? diatonic(midi);
  const accidental = ACCIDENTAL[alter ?? (SHARP[midi % 12] ? 1 : 0)];

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
  const ledger = (l) =>
    add('mark-ledger', { left: `${cx - unit}px`, top: `${yOf(l)}px`, width: `${2 * unit}px` });
  for (let l = top + 2; l <= d; l += 2) ledger(l);
  for (let l = top - 10; l >= d; l -= 2) ledger(l);

  const size = 1.1 * unit;
  add('mark-dot', { left: `${cx - size / 2}px`, top: `${yOf(d) - size / 2}px`, width: `${size}px`, height: `${size}px` });
  if (accidental) {
    add('mark-sharp', { left: `${cx - 1.9 * unit}px`, top: `${yOf(d) - 1.1 * unit}px`, fontSize: `${1.6 * unit}px` }, accidental);
  }
  return els;
}
