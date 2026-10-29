# Tests

End-to-end tests drive the real app in headless Chromium with Playwright.

```sh
npm install           # installs Playwright (skip if it's already available)
npx playwright install chromium
npm run fetch-music   # optional: downloads the real-music test tracks
npm test              # run everything; `npm test -- music` runs one file
```

| File | Covers |
| --- | --- |
| `core.test.cjs` | BPM/first-beat detection on generated tracks with known answers, play, sync (tempo + phase), loops, hot cues, phone layout |
| `spotify.test.cjs` | PKCE login, playlists, local matching and search against mocked Spotify endpoints |
| `library.test.cjs` | Key detection on synthesized chords (and detected keys of the real tracks, informational), saved library restore of tags/analysis/cues after reload, crates, stored folder handles, Save as crate, library layout |
| `music.test.cjs` | BPM and beat grid on real music (skipped until `fetch-music` has run) |

Generated test tracks are written to `tests/.cache/`, and downloaded music to
`tests/.music/`. Neither is committed.

## Real-music references

The expected values in `music.test.cjs` don't come from SpinDeck itself:
- **Tempo:** a straight-line fit through librosa's `beat_track` beat times. librosa's single tempo number snaps to coarse steps, so it's not precise enough.
- **First beat:** a grid search over a full-band spectral-flux onset envelope (64-sample hop) at the detected tempo.

"Let's Go Fishin'" is a loose acoustic recording. librosa's own beats on it
vary by about ±150 ms, so only its tempo is checked.

## Music credits

Downloaded from librosa's example data (<https://github.com/librosa/data>):

- "Vibe Ace" by Kevin MacLeod, CC BY 3.0, via the Free Music Archive
- "Choice" (drum + bass excerpt) by Admiral Bob, CC BY-NC 3.0, via ccMixter (excerpt edited by Brian McFee)
- "Let's Go Fishin'" by Karissa Hobbs, CC BY 3.0, via the Free Music Archive
- "Pistachio Ice Cream Ragtime" by The Piano Lady (Lena Orsa), CC BY-NC 3.0, via Freesound
