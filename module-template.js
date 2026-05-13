/**
 * LOSSLESS CORE — MODULE TEMPLATE
 * ─────────────────────────────────────────────────────────────
 * Copy this file and implement the two functions at the bottom:
 *   _fetchTracks()       → return your track list
 *   _resolveAudioUrl()   → return a streamable URL for a track
 *
 * BRIDGE API (quick reference)
 * ─────────────────────────────────────────────────────────────
 *   bridge.updateMeta(title, artist, album, artUrl)
 *   bridge.setAudioUrl(url, mimeType?)
 *   bridge.setQualityLabel('FLAC 16-bit / 44.1kHz')
 *   bridge.setQueue([{ title, artist, album, art, duration }])
 *   bridge.setQueueIndex(index)
 *   bridge.updateProgress(currentMs, totalMs)
 *   bridge.startLyricsSync(title, artist, album?, durationMs?, isrc?, musicId?)
 *   bridge.setCurrentTime(ms)
 *   bridge.stopLyrics()
 *   bridge.updateLyrics('plain text fallback')
 *   bridge.toast('message')
 *   bridge.getAudioContext()         → AudioContext (192kHz)
 *
 *   bridge.onPlay(cb)
 *   bridge.onPause(cb)
 *   bridge.onSeek(cb)                → cb(ms)
 *   bridge.onNext(cb)
 *   bridge.onPrev(cb)
 *   bridge.onShuffle(cb)             → cb(enabled)
 *   bridge.onRepeat(cb)              → cb('none'|'all'|'one')
 *   bridge.onVolumeChange(cb)        → cb(0–1)
 *   bridge.onPlayIndex(cb)           → cb(index)
 *
 * TRACK SHAPE
 * ─────────────────────────────────────────────────────────────
 * {
 *   title:    string,
 *   artist:   string,
 *   album?:   string,
 *   art?:     string | null,   // image URL
 *   duration?: number,          // ms
 * }
 */

export const name    = 'My Module';
export const version = '1.0.0';
export const author  = 'your-handle';

let _bridge = null;
let _tracks = [];
let _idx    = 0;

export async function init(bridge) {
  _bridge = bridge;

  bridge.onNext(      () => _go(_idx + 1)  );
  bridge.onPrev(      () => _go(_idx - 1)  );
  bridge.onPlayIndex( (i) => _go(i)        );
  bridge.onShuffle(   (on) => console.log('shuffle', on) );
  bridge.onRepeat(    (m)  => console.log('repeat',  m)  );

  _tracks = await _fetchTracks();
  bridge.setQueue(_tracks);
  bridge.toast(`${_tracks.length} tracks ready`);
  await _go(0);
}

export async function destroy() {
  _bridge = null;
  _tracks = [];
  _idx    = 0;
}

async function _go(i) {
  if (!_tracks.length) return;
  _idx = ((i % _tracks.length) + _tracks.length) % _tracks.length;
  const t = _tracks[_idx];

  _bridge.updateMeta(t.title, t.artist, t.album, t.art ?? null);
  _bridge.setQueueIndex(_idx);

  if (t.quality) _bridge.setQualityLabel(t.quality);

  /* Lyrics via am-lyrics (LyricsPlus / Apple Music) */
  _bridge.startLyricsSync(t.title, t.artist, t.album, t.duration, t.isrc);

  /* Resolve and play audio */
  const url = await _resolveAudioUrl(t);
  _bridge.setAudioUrl(url, t.mimeType);
}


/* ─────────────────────────────────────────────────────
   IMPLEMENT THESE
───────────────────────────────────────────────────── */

async function _fetchTracks() {
  /**
   * Return an array of track objects.
   * Examples:
   *   - Fetch from Jellyfin API: GET /Users/{userId}/Items?IncludeItemTypes=Audio
   *   - Fetch a YouTube playlist via a proxy/yt-dlp endpoint
   *   - Return a hardcoded list for testing
   */
  return [
    {
      title:    'Demo Track',
      artist:   'Demo Artist',
      album:    'Demo Album',
      art:      null,
      duration: 210000,
      quality:  'MP3 320kbps',
      mimeType: 'audio/mpeg',
      _url:     'https://example.com/demo.mp3',
    },
  ];
}

async function _resolveAudioUrl(track) {
  /**
   * Return a URL the browser can fetch as audio.
   * This is where you:
   *   - Exchange a track ID for a signed stream URL
   *   - Proxy through your own backend
   *   - Return a pre-signed S3 / CDN URL
   *   - Call yt-dlp or invidious for YouTube
   */
  if (track._url) return track._url;
  throw new Error(`No audio URL for: ${track.title}`);
}
