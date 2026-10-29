# SpinDeck — browser DJ app with Spotify login

A two-deck DJ app in the spirit of Serato DJ, running entirely in the browser
(plain HTML/CSS/JS, no build step, no backend). Users log in with their Spotify
account to browse their playlists, liked songs and the Spotify catalog, and mix
the matching tracks from their own music files.

## Features

**Decks (×2)**
- Scrolling, color-coded waveforms (red = lows, green = mids, blue = highs) with beat grid, plus a full-track overview
- Automatic BPM and beat-grid detection
- Play / CDJ-style cue (hold to preview), 4 hot cues, beat-snapped loops (½–16 beats)
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

Keyboard shortcuts are listed under the **?** button.

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
js/deck.js        playback engine: tempo, cues, loops, sync
js/mixer.js       Web Audio mixer graph
js/analysis.js    waveform peaks + BPM/beat-grid detection
js/waveform.js    canvas waveform rendering
js/library.js     local file import, ID3 tags, Spotify↔local matching
js/spotify.js     Spotify PKCE auth, Web API client, Web Playback SDK preview
js/knob.js        rotary knob control
```

## Limitations / ideas for next steps

- The local library resets on reload. Persisting it with the File System Access API would fix that.
- No key lock: changing tempo also changes pitch, as on a turntable.
- No separate headphone cue output (needs `AudioContext.setSinkId` and a second audio device).
- MIDI controller support could be added with the Web MIDI API.
