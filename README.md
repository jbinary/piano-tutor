# Piano Tutor

Wait-mode piano practice in the browser. Open a MusicXML score, connect a digital piano over USB,
and the cursor waits on each note/chord until you play it.

- Sheet music rendered with [OpenSheetMusicDisplay](https://opensheetmusicdisplay.org/) (vendored in `vendor/`)
- Input via Web MIDI (Chrome on Android + USB-OTG cable, or desktop Chrome/Edge)
- Practise left hand, right hand or both; loop a range of bars; skip/step back
- Wrong notes flash red on the on-screen keyboard; target keys are blue (right hand) / orange (left hand)
- Pieces and your position in each are kept on the device (IndexedDB); works offline once installed
- Keeps the screen awake while you play

## Files it reads

`.musicxml`, `.xml` and compressed `.mxl`, e.g.

- **Songscription**: export as MusicXML
- **MuseScore Studio**: File → Export → MusicXML, or `mscore -o piece.mxl piece.mscz`
- **musescore.com**: download as MusicXML

## Running it

Web MIDI only works on HTTPS (or `localhost`), so host it on any static HTTPS host, e.g. GitHub Pages:
push this repo, then *Settings → Pages → Deploy from branch*. Open the URL in Chrome on the tablet
and use *⋮ → Add to Home screen / Install app*.

Local development: `npm run serve` and open <http://localhost:8000>. To test on the tablet against
your PC, connect it with USB debugging and run `adb reverse tcp:8000 tcp:8000`, then open
`http://localhost:8000` on the tablet.

## Tests

```sh
npm install
npm test
```

The test loads the real app in jsdom, plays notes into it and checks chords, ties, rests,
hand selection, looping, navigation, persistence and `.mxl` loading.
