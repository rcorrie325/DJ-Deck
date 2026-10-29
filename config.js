// Optional: hard-code your Spotify app's Client ID here so users don't have to
// enter it in Settings. The Client ID is public (PKCE flow, no secret needed).
window.SPINDECK_CONFIG = {
  spotifyClientId: '',
  // Defaults to the current page URL. Must exactly match a Redirect URI in your Spotify app.
  redirectUri: '',
};
