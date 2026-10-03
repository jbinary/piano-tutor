// Web MIDI input: forwards note on/off from every connected input device.

/**
 * @param {{onNoteOn:(n:number)=>void, onNoteOff:(n:number)=>void, onStatus:(text:string, connected:boolean)=>void}} handlers
 */
export async function connectMidi({ onNoteOn, onNoteOff, onStatus }) {
  if (!navigator.requestMIDIAccess) {
    onStatus(window.isSecureContext ? 'MIDI: not supported' : 'MIDI: needs HTTPS', false);
    return;
  }

  let access;
  onStatus('MIDI: waiting for permission…', false);
  try {
    access = await navigator.requestMIDIAccess();
  } catch (err) {
    onStatus(err?.name === 'SecurityError' || err?.name === 'NotAllowedError'
      ? 'MIDI: permission denied'
      : `MIDI: ${err?.name ?? 'error'} ${err?.message ?? ''}`.trim(), false);
    console.warn(err);
    return;
  }

  const onMessage = (e) => {
    const [status, note, velocity] = e.data;
    const cmd = status & 0xf0;
    if (cmd === 0x90 && velocity > 0) onNoteOn(note);
    else if (cmd === 0x80 || (cmd === 0x90 && velocity === 0)) onNoteOff(note);
  };

  const attach = () => {
    const names = [];
    for (const input of access.inputs.values()) {
      input.onmidimessage = onMessage;
      if (input.state === 'connected') names.push(input.name);
    }
    if (names.length) onStatus(`MIDI: ${names.join(', ')}`, true);
    else onStatus('MIDI: no device', false);
  };

  access.onstatechange = attach;
  attach();
}
