// On-screen piano keyboard: shows target / held / correct / wrong keys and accepts touch input.

const BLACK = new Set([1, 3, 6, 8, 10]);
const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

export const isBlack = (midi) => BLACK.has(midi % 12);
export const noteName = (midi) => NAMES[midi % 12] + (Math.floor(midi / 12) - 1);

export class Keyboard {
  /**
   * @param {HTMLElement} el
   * @param {{onNoteOn:(n:number)=>void, onNoteOff:(n:number)=>void}} handlers
   */
  constructor(el, handlers) {
    this.el = el;
    this.handlers = handlers;
    this.keys = new Map();
    this.flashTimers = new Map();
    this.setRange(48, 84);

    // Touch / mouse playing, mainly for trying things out without a piano.
    const pointerNotes = new Map();
    el.addEventListener('pointerdown', (e) => {
      const midi = Number(e.target.closest('.key')?.dataset.midi);
      if (!midi) return;
      pointerNotes.set(e.pointerId, midi);
      handlers.onNoteOn(midi);
    });
    const release = (e) => {
      const midi = pointerNotes.get(e.pointerId);
      if (midi === undefined) return;
      pointerNotes.delete(e.pointerId);
      handlers.onNoteOff(midi);
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
  }

  /** Show keys from `lo` to `hi`, widened to whole octaves C..B. */
  setRange(lo, hi) {
    lo = Math.max(21, lo - (lo % 12));
    hi = Math.min(108, hi + (11 - (hi % 12)));
    this.el.replaceChildren();
    this.keys.clear();

    const whites = [];
    for (let m = lo; m <= hi; m++) if (!isBlack(m)) whites.push(m);
    const w = 100 / whites.length;

    let wi = 0;
    for (let m = lo; m <= hi; m++) {
      const key = document.createElement('div');
      key.dataset.midi = m;
      if (isBlack(m)) {
        key.className = 'key black';
        key.style.left = `${wi * w - w * 0.3}%`;
        key.style.width = `${w * 0.6}%`;
      } else {
        key.className = 'key white';
        key.style.left = `${wi * w}%`;
        key.style.width = `${w}%`;
        if (m % 12 === 0) {
          const label = document.createElement('span');
          label.className = 'label';
          label.textContent = noteName(m);
          key.append(label);
        }
        wi++;
      }
      this.el.append(key);
      this.keys.set(m, key);
    }
  }

  /** @param {{midi:number, hand:'L'|'R'}[]} notes */
  setTargets(notes) {
    for (const key of this.keys.values()) key.classList.remove('target-L', 'target-R', 'ok');
    for (const { midi, hand } of notes) this.keys.get(midi)?.classList.add(`target-${hand}`);
  }

  setHeld(midi, held) {
    this.keys.get(midi)?.classList.toggle('held', held);
  }

  markOk(midi, ok = true) {
    this.keys.get(midi)?.classList.toggle('ok', ok);
  }

  flashWrong(midi) {
    const key = this.keys.get(midi);
    if (!key) return;
    key.classList.add('wrong');
    clearTimeout(this.flashTimers.get(midi));
    this.flashTimers.set(midi, setTimeout(() => key.classList.remove('wrong'), 400));
  }
}
