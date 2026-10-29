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

## Setup

1. **Create a Spotify app** at <https://developer.spotify.com/dashboard>.
   - Check **Web API** and **Web Playback SDK**.
   - Add a **Redirect URI** that matches exactly where you host the app, e.g.
     `http://127.0.0.1:8080/` for local use. Spotify doesn't accept `localhost`; use `127.0.0.1`.
   - Copy the **Client ID**. No client secret is needed (the app uses the PKCE flow).
2. **Run it locally:**
   ```sh
   python3 -m http.server 8080 --bind 127.0.0.1
   ```
   Open <http://127.0.0.1:8080/>.
3. Click **⚙ Settings**, paste your Client ID, then **Connect Spotify**.
   To skip that step for everyone, put the Client ID in `config.js`.

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
