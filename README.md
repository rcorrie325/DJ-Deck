# SpinDeck — browser DJ app with Spotify login

A two-deck DJ app in the spirit of Serato DJ, running entirely in the browser
(plain HTML/CSS/JS, no build step, no backend). Users log in with their Spotify
account to browse their playlists, liked songs and the Spotify catalog, and mix
the matching tracks from their own music files.

## Features

**Decks (×2)**
- Scrolling, color-coded waveforms (red = lows, green = mids, blue = highs) with beat grid, plus a full-track overview
- Automatic BPM and beat-grid detection
- Play / CDJ-style cue (hold to preview), 8 hot cues (two rows of pads; keys 1–4 / 7–0 for the first four)
- Beat-snapped auto loops (½–16 beats) plus manual loops: IN / OUT, RELOOP (exit / re-enable), ½× and 2×
- **Key lock** (KEY): change tempo without changing pitch (WSOLA time-stretch in an AudioWorklet)
- Tempo fader with ±8 / ±16 / ±50% ranges, pitch-bend nudge, spinning platter (nudge while playing, scrub while paused)
- **Sync** matches tempo *and* beat phase to the other deck (handles half/double time)

**Mixer**
- Gain, 3-band EQ with full kill, combined low-pass/high-pass filter knob
- Channel faders with level meters, crossfader (smooth or sharp curve), master volume with a safety limiter
- **Record your mix** to a file (REC button)

**Library**
- Import files or whole folders (MP3, WAV, FLAC, AAC/M4A, OGG…), with ID3 tag reading
- Spotify: Liked Songs, all your playlists, and catalog search (press Enter in the search box)
- Each Spotify track is matched to your local files (✓ = match found) and loads onto a deck like any other track
- ▶ preview any Spotify track in a separate Spotify player (Premium)

Keyboard shortcuts are listed under the **?** button. DJ controllers can be
mapped with MIDI Learn under **🎛** (see below).

## Using a DJ controller

SpinDeck can be played from any MIDI DJ controller through Web MIDI. This
works in **Chrome and Edge** only (Firefox and Safari don't support Web MIDI).

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

## Why Spotify tracks don't play through the decks

Spotify doesn't let third-party apps get at a track's audio. Its Web Playback
SDK plays DRM-protected audio straight to the speakers, so the app can't
time-stretch it, EQ it, filter it, draw its waveform, or blend it with another
track. Spotify's Developer Policy also explicitly forbids mixing, overlapping or
segueing Spotify content. Spotify itself pulled its integration from Serato,
rekordbox and djay in 2020 for this reason.

So SpinDeck uses Spotify for what it legally and technically allows:
**identity, library, playlists, search, and previews**. The actual mixing runs
on audio files you own. Build your set in Spotify, open the playlist in SpinDeck,
and every track you have locally lights up ✓ and is ready to mix.

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
git checkout claude/spotify-dj-app
```

or on GitHub choose the `claude/spotify-dj-app` branch, click **Code → Download ZIP**,
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

Use `127.0.0.1`, not `localhost`. Spotify login only accepts `127.0.0.1`.

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

### 6. (Optional) Connect Spotify

Spotify only lets you browse your playlists, Liked Songs and search, and preview
songs. It doesn't make Spotify songs mixable (see the section above).

1. Go to <https://developer.spotify.com/dashboard> and click **Create app**.
   - Under APIs, tick **Web API** and **Web Playback SDK**.
   - Add the Redirect URI **`http://127.0.0.1:8080/`**, typed exactly like that, including the trailing `/`.
   - Save, then copy the app's **Client ID**. You don't need the client secret.
2. In SpinDeck, click **⚙** (top right), paste the Client ID, click **Save**.
3. Click **Connect Spotify** and log in. Your playlists appear in the left sidebar.

To skip step 2 for everyone who uses your copy, put the Client ID in `config.js`.

### Troubleshooting

| Problem | Fix |
| --- | --- |
| Blank page | You opened `index.html` directly. Start the server (step 3) and use the `http://127.0.0.1:8080/` address. |
| "Address already in use" | Port 8080 is taken. Use another port, e.g. `8081`, and open `http://127.0.0.1:8081/`. If you use Spotify, add that address as a Redirect URI too. |
| No sound | Click anywhere on the page once (browsers block audio until you interact), check the channel fader is up, and check the crossfader isn't all the way to the other side. |
| Spotify says "INVALID_CLIENT: Invalid redirect URI" | The Redirect URI in your Spotify dashboard must match the address in your browser exactly, including `http://`, the port and the trailing `/`. |
| Spotify login works for you but not friends | See "Letting other people log in" below. |
| A file won't load | The browser can't decode that format. MP3, WAV, AAC/M4A and OGG work everywhere; FLAC works in Chrome, Edge and Firefox. |

### Letting other people log in

New Spotify apps start in **Development Mode**: only accounts you add under
*User Management* in the dashboard can log in, and the app owner needs Spotify
Premium. To open it to anyone you must apply for an extended quota with Spotify.

### Deploying

The app is static files, so any static host works (GitHub Pages, Netlify,
Vercel, Cloudflare Pages). Add the deployed URL (HTTPS) as a Redirect URI in
your Spotify app.

## Project layout

```
index.html        UI shell
styles.css        styling
config.js         optional baked-in Spotify Client ID / redirect URI
js/app.js         wires everything together (UI, keyboard, library, render loop)
js/deck.js        deck transport: tempo, key lock, cues, loops, sync
js/deck-worklet.js AudioWorklet playback: variable-rate reading, loops, WSOLA key lock
js/mixer.js       Web Audio mixer graph
js/analysis.js    waveform peaks + BPM/beat-grid detection
js/waveform.js    canvas waveform rendering
js/library.js     local file import, ID3 tags, Spotify↔local matching
js/spotify.js     Spotify PKCE auth, Web API client, Web Playback SDK preview
js/knob.js        rotary knob control
js/midi.js        Web MIDI: devices, MIDI Learn, soft takeover, LED feedback
js/midi-targets.js  list of controls a controller can be mapped to
```

## Limitations / ideas for next steps

- The local library resets on reload. Persisting it with the File System Access API would fix that.
- No separate headphone cue output (needs `AudioContext.setSinkId` and a second audio device).
