# SpinDeck — browser DJ app

A two-deck DJ app in the spirit of Serato DJ, running entirely in the browser
(plain HTML/CSS/JS, no build step, no backend, no accounts). You mix your own
music files; nothing is uploaded anywhere.

## Features

**Decks (×2)**
- Scrolling, color-coded waveforms (red = lows, green = mids, blue = highs) with beat grid, plus a full-track overview
- Automatic BPM and beat-grid detection
- Play / CDJ-style cue (hold to preview), 8 hot cues (two rows of pads; keys 1–4 / 7–0 for the first four)
- Beat-snapped auto loops (½–16 beats) plus manual loops: IN / OUT, RELOOP (exit / re-enable), ½× and 2×
- **Key lock** (KEY): change tempo without changing pitch (WSOLA time-stretch in an AudioWorklet)
- Tempo fader with ±8 / ±16 / ±50% ranges, a **0%** button to reset to the original BPM, pitch-bend nudge, spinning platter (nudge while playing, scrub while paused)
- **Sync** matches tempo *and* beat phase to the other deck (handles half/double time)

**Mixer**
- Gain, 3-band EQ with full kill, combined low-pass/high-pass filter knob
- Channel faders with level meters, crossfader (smooth or sharp curve), master volume with a safety limiter
- **Effects** per channel: echo (synced to the deck's BPM), reverb and flanger, with DEPTH and BEATS knobs; tails ring out when you switch them off
- **Headphone cue:** CUE buttons per channel plus CUE MIX and PHONES knobs. Needs a 4-channel audio output (most DJ controllers): master plays on outputs 1–2, headphones on 3–4
- **Audio output picker** in ⚙ Settings (Chrome/Edge), e.g. to play through a controller's sound card
- **Record your mix** to a file (REC button)

**Library**
- Import files or whole folders (MP3, WAV, FLAC, AAC/M4A, OGG…), with ID3 tag reading
- **Musical key detection** shown in Camelot notation (8A, 12B…) on the decks and in a Key column; tracks that mix in key with what's playing are highlighted. Without key lock, the deck's key readout follows tempo changes
- **Saved library:** tags, BPM, key, waveforms and cue points are kept in the browser between visits. In Chrome/Edge, folders added with "Add folder" reconnect after a reload with one click; in other browsers re-add the files and everything comes back
- **Crates:** make your own lists and drag tracks into them

Keyboard shortcuts are listed under the **?** button. DJ controllers can be
mapped with MIDI Learn under **🎛** (see below).

## Pioneer DDJ-FLX4: plug and play

The **DDJ-FLX4** has a built-in mapping: no MIDI Learn needed.

1. Use **Chrome or Edge**. Close rekordbox, Serato or any other DJ software
   first: on Windows only one app at a time can use the board.
2. Plug the FLX4 in over USB.
3. Click **🎛** in the top bar, then **Connect controller**, and allow MIDI
   access when the browser asks. If it also asks to "control and reprogram MIDI
   devices", allow that too: it lets SpinDeck send the FLX4 the same
   keep-alive message rekordbox does. Everything else works without it.
   The dialog shows **✓ built-in Pioneer DDJ-FLX4 mapping** once it's detected.
   The browser remembers this, so next time the board connects by itself.
4. For sound through the FLX4, open **⚙ Settings → Audio output** and pick the
   DDJ-FLX4. If your system exposes all four channels, the master plays on the
   MASTER OUT and the headphone cue on the PHONES jack.

| On the FLX4 | In SpinDeck |
| --- | --- |
| PLAY/PAUSE, CUE | play/pause; cue (hold to preview) |
| SHIFT + CUE | back to the start of the track |
| BEAT SYNC / SHIFT + BEAT SYNC | sync to the other deck / change the tempo range |
| TEMPO fader | tempo, with soft takeover (top = slower, like a CDJ) |
| Jog wheel (top or side) | nudge while playing, scrub while paused |
| SHIFT + jog | fast search |
| LOOP IN / OUT, RELOOP/EXIT | manual loop in / out, reloop or exit |
| CUE/LOOP CALL ◀ / ▶ | halve / double the loop |
| Pads in HOT CUE mode | hot cues 1–8 (SHIFT + pad deletes) |
| Pads in BEAT LOOP mode | ¼ to 32-beat loops |
| Pads in BEAT JUMP mode | jump −1/+1, −2/+2, −4/+4, −8/+8 beats |
| TRIM, EQ HI/MID/LOW, CFX (filter) | gain, EQ and filter |
| Channel faders, crossfader | channel faders, crossfader |
| Headphone CUE buttons, HEADPHONES MIX | headphone cue, cue/master mix |
| BEAT FX ON/OFF, SELECT, ◀ ▶, LEVEL/DEPTH, CH SELECT | FX on/off, FX type, FX beats, FX depth, which channel the FX goes on |
| BROWSE knob, LOAD 1 / LOAD 2 | move through the track list, load onto deck A / B |

Lights on the board follow the app: play, cue, sync, headphone cue, hot cue
pads, loop pads, reloop, FX on, and the channel level meters.

Not supported yet: scratching (the jog nudges and scrubs instead), the sampler,
pad FX and keyboard pad modes, and the MASTER LEVEL / HEADPHONES LEVEL knobs, which
are handled inside the board's own hardware anyway.

The mapping follows Mixxx's community DDJ-FLX4 mapping. **It has been tested
with simulated FLX4 MIDI messages, not on a physical board yet.** If the tempo
fader runs the wrong way, tick **Reverse the DDJ's tempo fader** in the 🎛
dialog. Anything you map with MIDI Learn overrides the built-in mapping for
that control, and the built-in mapping can be switched off in the 🎛 dialog.

## Using a DJ controller

SpinDeck can be played from any MIDI DJ controller through Web MIDI. This
works in **Chrome and Edge** only (Firefox and Safari don't support Web MIDI).
Controllers without a built-in mapping (everything except the DDJ-FLX4 for now)
are mapped once with MIDI Learn:

1. Plug the controller in over USB.
2. Click **🎛** in the top bar, then **Connect controller** and allow MIDI
   access. Your controller is listed in the dialog (unplugging and replugging is
   picked up automatically).
3. Click **MIDI Learn**. Every control you can map gets an outline. Click one on
   screen (for example Deck A ▶, the tempo fader, an EQ knob or a platter), then
   press, turn or move the matching control on your controller. Repeat for
   every control you want. <kbd>Esc</kbd> cancels the current pick;
   right-click (or Shift-click) a mapped control to clear it. Click **Done** in
   the bar at the top when you're finished.
4. Click **Export** to save the mapping as a JSON file. Others with the same
   controller model can load it with **Import**. Mappings are also kept in the
   browser and saved per device name.

What you can map: play, cue (hold to preview), sync, key lock, hot cues, loop
pads, loop in/out/reloop/½/×2, nudge, tempo fader, jog wheels (bend while
playing, scrub while paused), every mixer knob, channel faders, crossfader,
headphone cue and FX buttons, plus a library browse encoder and "load selected
track" (click the track title area of a deck). Some of these only appear when
the matching on-screen control exists.

Details:
- Knobs and faders use **soft takeover**: they start moving once the hardware
  passes the on-screen value, so nothing jumps.
- Jog wheels and endless encoders are detected as relative controls; both the
  64-centred and two's-complement styles are recognised automatically.
- **LED feedback** lights play, cue, sync, key lock, hot cue, loop and headphone
  cue buttons on controllers that support it. It can be turned off in the dialog
  or per mapping.
- **Audio:** controllers with a built-in sound card can be picked as the output
  device in Settings. Headphone cue needs a 4-channel (2 stereo outputs)
  controller.
- This has been tested with a simulated controller only, not on physical
  hardware yet. Reports and shared mapping files are welcome.

## How to run it

You need two things: a web browser and a tiny local web server. Nothing gets
installed into the app itself; there's no `npm install` and no build step.

> **Don't just double-click `index.html`.** Browsers block the app's code when
> it's opened as a file (`file://...`), and you'll get a blank page. It has to be
> served by a web server, as in step 3.

### 1. Get the code

Either clone it:

```sh
git clone https://github.com/rcorrie325/DJ-Deck.git
cd DJ-Deck
```

or on GitHub choose the `main` branch, click **Code → Download ZIP**,
unzip it, and open a terminal in the unzipped folder.

### 2. Make sure you have Python (or Node.js)

Python is already installed on macOS and most Linux systems. Check with:

```sh
python3 --version
```

On Windows, install Python from <https://www.python.org/downloads/> and tick
**"Add python.exe to PATH"** during setup. Then use `py` instead of `python3` below.

### 3. Start the server

From inside the project folder, run **one** of these:

| You have | Command |
| --- | --- |
| Python (macOS / Linux) | `python3 -m http.server 8080 --bind 127.0.0.1` |
| Python (Windows) | `py -m http.server 8080 --bind 127.0.0.1` |
| Node.js | `npx serve -l tcp://127.0.0.1:8080` |

Leave that terminal window open while you DJ. Press **Ctrl+C** in it to stop the server.

### 4. Open the app

Go to **<http://127.0.0.1:8080/>** in **Chrome or Edge**. Those are the browsers
it has been tested in. Firefox and Safari should work but haven't been tested.

### 5. Add music and play

1. Click **＋ Add files** or **＋ Add folder** in the bottom-left, or drag audio files onto the track list.
2. Click **A** or **B** next to a track to load it onto a deck. It takes a moment to analyze the BPM.
3. Press play (▶), bring up the channel faders, and use the crossfader to blend.

Press **?** in the top bar to see the keyboard shortcuts.

**No music files yet?** These sites have free, legal tracks you can download to try it out:
- Free Music Archive: <https://freemusicarchive.org>
- Kevin MacLeod / Incompetech: <https://incompetech.com/music/royalty-free/> (CC-BY)
- ccMixter: <https://ccmixter.org>
- Pixabay Music: <https://pixabay.com/music/>

Check each track's license before you use it in a public mix.

### Troubleshooting

| Problem | Fix |
| --- | --- |
| Blank page | You opened `index.html` directly. Start the server (step 3) and use the `http://127.0.0.1:8080/` address. |
| "Address already in use" | Port 8080 is taken. Use another port, e.g. `8081`, and open `http://127.0.0.1:8081/`. |
| No sound | Click anywhere on the page once (browsers block audio until you interact), check the channel fader is up, and check the crossfader isn't all the way to the other side. |
| A file won't load | The browser can't decode that format. MP3, WAV, AAC/M4A and OGG work everywhere; FLAC works in Chrome, Edge and Firefox. |

### Deploying

The app is static files, so any static host works (GitHub Pages, Netlify,
Vercel, Cloudflare Pages). For GitHub Pages: repo **Settings → Pages**, deploy
from the `main` branch, `/ (root)` folder; the app then lives at
`https://<user>.github.io/<repo>/`.

## Project layout

```
index.html        UI shell
styles.css        styling
js/app.js         wires everything together (UI, keyboard, library, render loop)
js/deck.js        deck transport: tempo, key lock, cues, loops, sync
js/deck-worklet.js AudioWorklet playback: variable-rate reading, loops, WSOLA key lock
js/mixer.js       Web Audio mixer graph
js/analysis.js    waveform peaks, BPM/beat-grid and musical key detection
js/waveform.js    canvas waveform rendering
js/library.js     local file import, ID3 tags, saved-library restore
js/store.js       IndexedDB storage for the saved library, cues and crates
tests/            end-to-end tests (see tests/README.md)
js/knob.js        rotary knob control
js/midi.js        Web MIDI: devices, MIDI Learn, soft takeover, LED feedback
js/midi-targets.js  list of controls a controller can be mapped to
js/controllers/ddj-flx4.js  built-in Pioneer DDJ-FLX4 mapping
```

## Limitations / ideas for next steps

- **Not tested on real DJ hardware.** The DDJ-FLX4 mapping, MIDI Learn, controller lights and 4-channel headphone cue were tested with simulated MIDI messages and a simulated 4-channel output only.
- BPM and key are filled in the first time a track is loaded onto a deck; there's no background analysis of the whole library yet.
- The beat grid can't be edited by hand yet; loose live recordings can get an off grid.
- With key lock on, a loop can overshoot its end by up to ~40 ms before jumping back.
- Key lock and manual loops have no keyboard shortcuts yet.
- Headphone cue needs a 4-channel output device; on ordinary 2-channel speakers or headphones the CUE buttons are disabled.
- Still missing compared with Serato: sampler, slip / reverse / censor, stems, 4-deck mode, DVS (timecode vinyl).
