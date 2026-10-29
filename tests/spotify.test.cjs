// Spotify login, playlists, search and local matching against mocked Spotify endpoints.
const { generated, openApp, addFiles, assert } = require('./lib.cjs');

const track = (id, name, artist, ms) => ({
  id, uri: `spotify:track:${id}`, name, duration_ms: ms, artists: [{ name: artist }], album: { name: 'X', images: [] },
});

async function mockSpotify(page) {
  const seen = { auth: null, tokenBody: null };
  await page.route('https://accounts.spotify.com/authorize**', (r) => {
    seen.auth = new URL(r.request().url());
    r.fulfill({ status: 200, body: 'auth page' });
  });
  await page.route('https://accounts.spotify.com/api/token', (r) => {
    seen.tokenBody = new URLSearchParams(r.request().postData());
    r.fulfill({ json: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 } });
  });
  await page.route('https://api.spotify.com/v1/**', (r) => {
    const u = new URL(r.request().url());
    if (r.request().headers().authorization !== 'Bearer AT') return r.fulfill({ status: 401, json: {} });
    if (u.pathname === '/v1/me') return r.fulfill({ json: { id: 'u1', display_name: 'Test User', images: [] } });
    if (u.pathname === '/v1/me/playlists') return r.fulfill({ json: { items: [{ id: 'pl1', name: 'Friday Set' }], next: null } });
    if (u.pathname === '/v1/playlists/pl1/items') {
      return r.fulfill({ json: { next: null, items: [
        { item: track('t1', 'Groove 124', 'DJ Test', 60000) },
        { item: track('t2', 'Rolling 128 (feat. Someone)', 'Beat Maker', 60000) },
        { item: track('t3', 'Not On Disk', 'Nobody', 200000) },
      ] } });
    }
    if (u.pathname === '/v1/search') return r.fulfill({ json: { tracks: { items: [track('t9', 'Ninety', 'Slow Jam', 60000)] } } });
    return r.fulfill({ status: 404, json: { error: { message: 'not mocked' } } });
  });
  return seen;
}

const rows = (page) => page.$$eval('#trackBody tr', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));

module.exports = {
  async 'PKCE login, playlists, matching and search'({ browser, baseUrl }) {
    const page = await openApp(browser, baseUrl);
    const seen = await mockSpotify(page);

    await page.click('#spotifyBtn'); // no client ID yet: opens settings
    await page.fill('#clientIdInput', 'abc123');
    await page.click('#saveSettings');
    await page.click('#spotifyBtn');
    await page.waitForURL(/accounts\.spotify\.com/);
    const p = seen.auth.searchParams;
    assert(p.get('client_id') === 'abc123', 'client id sent');
    assert(p.get('code_challenge_method') === 'S256' && p.get('code_challenge'), 'PKCE challenge sent');
    assert(p.get('redirect_uri') === baseUrl, `redirect uri is the app url, got ${p.get('redirect_uri')}`);

    await page.goto(`${baseUrl}?code=CODE&state=${p.get('state')}`);
    await page.waitForSelector('[data-crate="pl:pl1"]');
    assert(seen.tokenBody.get('code_verifier')?.length >= 43, 'code verifier sent');
    assert(!page.url().includes('code='), 'auth code removed from the URL');
    assert((await page.textContent('#spotifyUser')).includes('Test User'), 'user shown');

    await addFiles(page, [generated.groove124(), generated.rolling128()]);
    await page.click('[data-crate="pl:pl1"]');
    await page.waitForFunction(() => document.querySelector('#crateTitle').textContent === 'Friday Set');
    const list = await rows(page);
    assert(list[0].includes('✓') && list[1].includes('✓'), `local files should match: ${list}`);
    assert(list[2].includes('—'), 'missing track marked as not local');

    await page.click('#trackBody tr:nth-child(2) button[data-act="A"]');
    await page.waitForFunction(() => window.spindeck.decks.A.loaded);
    assert(await page.evaluate(() => window.spindeck.decks.A.track.title) === 'Rolling 128', 'matched file loaded');

    await page.click('#trackBody tr:nth-child(3) button[data-act="B"]');
    assert((await page.textContent('#toast')).includes('No local file'), 'unmatched track explains itself');

    await page.fill('#searchInput', 'ninety');
    await page.press('#searchInput', 'Enter');
    await page.waitForFunction(() => document.querySelector('#crateTitle').textContent.includes('ninety'));
    assert((await rows(page))[0].includes('Ninety'), 'search results shown');
    assert(page.errors.length === 0, `page errors: ${page.errors}`);
    await page.close();
  },
};
