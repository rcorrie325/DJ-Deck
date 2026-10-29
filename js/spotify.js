// Spotify Web API client using Authorization Code + PKCE (no backend needed).
// Spotify is used for login, library browsing, search and a separate preview
// player. Spotify audio itself cannot be routed into the mixer (see README).

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const SCOPES = [
  'user-read-private',
  'user-read-email',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
  'streaming',
  'user-read-playback-state',
  'user-modify-playback-state',
].join(' ');

const LS = {
  clientId: 'spindeck.spotify.clientId',
  token: 'spindeck.spotify.token',
  verifier: 'spindeck.spotify.verifier',
  state: 'spindeck.spotify.state',
};

function lsGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function lsSet(key, v) { try { localStorage.setItem(key, v); } catch { /* private mode */ } }
function lsDel(key) { try { localStorage.removeItem(key); } catch { /* private mode */ } }

function randomString(len = 64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

async function sha256base64url(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function normalizeTrack(t) {
  if (!t || !t.id) return null;
  return {
    id: 'sp:' + t.id,
    spotifyId: t.id,
    uri: t.uri,
    title: t.name,
    artist: (t.artists || []).map((a) => a.name).join(', '),
    album: t.album?.name || '',
    art: t.album?.images?.at(-1)?.url || t.album?.images?.[0]?.url || '',
    duration: (t.duration_ms || 0) / 1000,
    source: 'spotify',
  };
}

export class Spotify {
  constructor() {
    this.token = JSON.parse(lsGet(LS.token) || 'null');
    this.user = null;
    this.player = null;
    this.deviceId = null;
  }

  get clientId() { return lsGet(LS.clientId) || window.SPINDECK_CONFIG?.spotifyClientId || ''; }
  set clientId(v) { lsSet(LS.clientId, v.trim()); }

  get redirectUri() {
    return window.SPINDECK_CONFIG?.redirectUri || location.origin + location.pathname;
  }

  get loggedIn() { return !!this.token?.access_token; }

  async login() {
    if (!this.clientId) throw new Error('Set your Spotify Client ID in Settings first.');
    const verifier = randomString(64);
    const state = randomString(16);
    lsSet(LS.verifier, verifier);
    lsSet(LS.state, state);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      scope: SCOPES,
      redirect_uri: this.redirectUri,
      code_challenge_method: 'S256',
      code_challenge: await sha256base64url(verifier),
      state,
    });
    location.assign(`${AUTH_URL}?${params}`);
  }

  // Call once on page load; completes the login if we are coming back from Spotify.
  async handleRedirect() {
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    const error = params.get('error');
    if (!code && !error) return false;
    history.replaceState(null, '', location.pathname);
    if (error) throw new Error(`Spotify login failed: ${error}`);
    if (params.get('state') !== lsGet(LS.state)) throw new Error('Spotify login state mismatch, try again.');
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      code_verifier: lsGet(LS.verifier) || '',
    });
    await this.#tokenRequest(body);
    lsDel(LS.verifier);
    lsDel(LS.state);
    return true;
  }

  async #tokenRequest(body) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error_description || json.error || 'Token request failed');
    this.token = {
      access_token: json.access_token,
      refresh_token: json.refresh_token || this.token?.refresh_token,
      expires_at: Date.now() + (json.expires_in - 60) * 1000,
    };
    lsSet(LS.token, JSON.stringify(this.token));
  }

  async refresh() {
    if (!this.token?.refresh_token) throw new Error('Not logged in');
    await this.#tokenRequest(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.token.refresh_token,
      client_id: this.clientId,
    }));
  }

  async accessToken() {
    if (!this.token) throw new Error('Not logged in');
    if (Date.now() > this.token.expires_at) await this.refresh();
    return this.token.access_token;
  }

  logout() {
    this.token = null;
    this.user = null;
    lsDel(LS.token);
    this.player?.disconnect();
    this.player = null;
    this.deviceId = null;
  }

  async api(path, opts = {}, retried = false) {
    const url = path.startsWith('http') ? path : API + path;
    const res = await fetch(url, {
      ...opts,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, ...(opts.headers || {}) },
    });
    if (res.status === 401 && !retried) {
      await this.refresh();
      return this.api(path, opts, true);
    }
    if (res.status === 429 && !retried) {
      const wait = Number(res.headers.get('Retry-After') || 1);
      await new Promise((r) => setTimeout(r, wait * 1000));
      return this.api(path, opts, true);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error(json?.error?.message || `Spotify API error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  async paginate(path, max = 2000) {
    const items = [];
    let next = path;
    while (next && items.length < max) {
      const page = await this.api(next);
      items.push(...(page.items || []));
      next = page.next;
    }
    return items;
  }

  async me() {
    this.user = await this.api('/me');
    return this.user;
  }

  playlists() { return this.paginate('/me/playlists?limit=50'); }

  async playlistTracks(id) {
    let items;
    try {
      items = await this.paginate(`/playlists/${id}/items?limit=50`);
    } catch (e) {
      // Older API shape.
      if (e.status !== 404 && e.status !== 403) throw e;
      items = await this.paginate(`/playlists/${id}/tracks?limit=50`);
    }
    return items.map((it) => normalizeTrack(it.item || it.track)).filter(Boolean);
  }

  async likedTracks() {
    const items = await this.paginate('/me/tracks?limit=50', 1000);
    return items.map((it) => normalizeTrack(it.track || it.item)).filter(Boolean);
  }

  async search(q) {
    const res = await this.api(`/search?type=track&limit=10&q=${encodeURIComponent(q)}`);
    return (res.tracks?.items || []).map(normalizeTrack).filter(Boolean);
  }

  // --- Web Playback SDK preview player (Spotify Premium only) ---

  async initPlayer(onState) {
    if (this.player) return this.player;
    await new Promise((resolve, reject) => {
      if (window.Spotify?.Player) return resolve();
      window.onSpotifyWebPlaybackSDKReady = resolve;
      const s = document.createElement('script');
      s.src = 'https://sdk.scdn.co/spotify-player.js';
      s.onerror = () => reject(new Error('Could not load Spotify player SDK'));
      document.head.appendChild(s);
    });
    const player = new window.Spotify.Player({
      name: 'SpinDeck Preview',
      getOAuthToken: (cb) => this.accessToken().then(cb),
      volume: 0.8,
    });
    const ready = new Promise((resolve, reject) => {
      player.addListener('ready', ({ device_id }) => { this.deviceId = device_id; resolve(); });
      player.addListener('initialization_error', ({ message }) => reject(new Error(message)));
      player.addListener('authentication_error', ({ message }) => reject(new Error(message)));
      player.addListener('account_error', () => reject(new Error('Spotify Premium is required for preview playback.')));
    });
    player.addListener('player_state_changed', (s) => onState?.(s));
    if (!(await player.connect())) throw new Error('Spotify player failed to connect');
    this.player = player;
    await ready;
    return player;
  }

  async previewTrack(uri, onState) {
    await this.initPlayer(onState);
    await this.player.activateElement?.();
    await this.api(`/me/player/play?device_id=${this.deviceId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: [uri] }),
    });
  }
}
