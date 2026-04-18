/* ════════════════════════════════════════════════════════════
   home.js — Home screen logic  ·  Material You redesign
   v2: Live scrobble auto-refresh every 45 s
   ════════════════════════════════════════════════════════════ */

'use strict';

// ── Module state ──────────────────────────────────────────────
let _homeSortMode   = 'recent';
let _homeAllTracks  = [];
let _sortMenuOpen   = false;

// ── Data-load state guards ─────────────────────────────────────
// Prevents partial renders, double fetches, and race conditions.
// _homeIsFetching: true while _fetchHomeData is in flight.
// _homeDataLoaded: true once a successful full fetch has completed.
// Both must be reset together whenever the user/data is invalidated.
let _homeIsFetching = false;
let _homeDataLoaded = false;

// ── Pagination ────────────────────────────────────────────────
let _homeCurrentPage   = 1;
let _homeIsLoadingMore = false;
let _homeHasMore       = true;

// ── Auto-refresh ──────────────────────────────────────────────
let _homeAutoRefreshTimer = null;
const _HOME_REFRESH_INTERVAL = 30000;   // 30 s — faster list updates

// ── Now Playing ───────────────────────────────────────────────
// Tracks the currently live track so we can show a "Now Playing" row
// at the top of the home list without creating fake scrobbles.
let _nowPlayingTrack = null;   // { name, artist, image } | null

// ── Screen init (called by nav.js on every visit) ─────────────
function screen_home() {
  if (state.username) {
    document.getElementById('homeUsernameSection').classList.add('hidden');
    document.getElementById('homeHeader').classList.remove('hidden');
    _updateHeaderUsername();

    if (_homeDataLoaded) {
      // Data already in memory — show cards immediately, then silently refresh
      _showHomeLoading(false);
      _showHomeCards(true);
      requestAnimationFrame(() => _triggerEntryAnimations());
      _homeAutoRefreshNow();
    } else if (!_homeIsFetching) {
      // First visit or data was invalidated — do a full fetch
      _destroyListenTimer();
      _homeCurrentPage   = 1;
      _homeIsLoadingMore = false;
      _homeHasMore       = true;
      _showHomeLoading(true);
      _showHomeCards(false);
      _fetchHomeData();
    }
    // If _homeIsFetching is true, a fetch is already in flight — do nothing;
    // it will call _showHomeCards(true) and set _homeDataLoaded when it lands.

    // Always (re)start the auto-refresh interval while home is visible
    _startHomeAutoRefresh();

  } else {
    _stopHomeAutoRefresh();
    _showHomeLoading(false);
    _showHomeCards(false);
    document.getElementById('homeHeader').classList.add('hidden');
    document.getElementById('homeUsernameSection').classList.remove('hidden');
  }
  _setupPullToRefresh();
}

// ══════════════════════════════════════════════════════════════
//  AUTO-REFRESH  — silently fetches latest scrobbles every 45 s
// ══════════════════════════════════════════════════════════════

function _startHomeAutoRefresh() {
  _stopHomeAutoRefresh();
  if (!state.username || !state.apiKey) return;
  _homeAutoRefreshTimer = setInterval(_homeAutoRefreshNow, _HOME_REFRESH_INTERVAL);
}

function _stopHomeAutoRefresh() {
  if (_homeAutoRefreshTimer) {
    clearInterval(_homeAutoRefreshTimer);
    _homeAutoRefreshTimer = null;
  }
}

/**
 * Silent background refresh.
 * Fetches the 20 most-recent tracks; prepends any genuinely new ones
 * to _homeAllTracks and re-renders the list with a subtle animation.
 * Also updates the scrobble counter.
 */
async function _homeAutoRefreshNow() {
  if (!state.username || !state.apiKey) return;
  if (state.currentPage !== 'home') return;  // only refresh while home is shown

  try {
    // Bypass cache so we always get the freshest data
    const url = new URL(LASTFM_BASE);
    const p   = {
      method:  'user.getrecenttracks',
      user:    state.username,
      limit:   20,
      api_key: state.apiKey,
      format:  'json',
    };
    Object.entries(p).forEach(([k, v]) => url.searchParams.set(k, v));
    const res  = await fetch(url.toString(), { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();

    const raw    = data?.recenttracks?.track;
    const rawArr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    const filtered = rawArr.filter(t => !(t['@attr']?.nowplaying === 'true'));

    const incoming = normaliseTracks(filtered).map((t, i) => ({
      ...t,
      _recentIndex: i,
      album:      filtered[i]?.album?.['#text'] || '',
      _timestamp: filtered[i]?.date?.uts ? parseInt(filtered[i].date.uts) * 1000 : null,
    }));

    // ── Remove live-session placeholders confirmed by the API ──
    // When a song finishes and we add it optimistically (_liveSession:true),
    // the next API poll returns the real scrobble — remove the placeholder
    // so we don't show the same track twice.
    incoming.forEach(t => {
      const key = `${t.name}|${t.artist}`.toLowerCase();
      const idx = _homeAllTracks.findIndex(
        x => x._liveSession && `${x.name}|${x.artist}`.toLowerCase() === key
      );
      if (idx !== -1) _homeAllTracks.splice(idx, 1);
    });

    // ── Deduplication: use per-scrobble timestamp as primary key ──
    // This correctly handles the same song being scrobbled multiple times
    // (each scrobble has a unique Unix timestamp). Name|artist is only used
    // as a fallback for tracks without a date (e.g. now-playing entries).
    const existingTimestamps = new Set(
      _homeAllTracks.filter(t => t._timestamp).map(t => t._timestamp)
    );
    const existingNameKeys = new Set(
      _homeAllTracks.map(t => `${t.name}|${t.artist}`.toLowerCase())
    );
    const freshTracks = incoming.filter(t => {
      if (t._timestamp) return !existingTimestamps.has(t._timestamp);
      return !existingNameKeys.has(`${t.name}|${t.artist}`.toLowerCase());
    });

    if (freshTracks.length === 0) return;   // nothing new — done

    // Re-index existing tracks to make room for new ones at the top
    const shiftedExisting = _homeAllTracks.map(t => ({
      ...t,
      _recentIndex: (t._recentIndex !== undefined)
        ? t._recentIndex + freshTracks.length
        : 9999
    }));

    _homeAllTracks = [...freshTracks, ...shiftedExisting];

    // Update scrobble count
    try {
      const profileData = await lfmCall({ method: 'user.getinfo', user: state.username });
      const scrobEl = document.getElementById('profileScrobbles');
      if (scrobEl && profileData?.user) {
        scrobEl.textContent = parseInt(profileData.user.playcount || 0).toLocaleString();
      }
    } catch { /* non-critical */ }

    // Re-render list (shows newest tracks at top)
    _renderList();

    // Quietly enrich any new tracks missing art
    _enrichHomeArt(freshTracks);

  } catch { /* silent — don't disrupt the user */ }
}

// ── Unicode small-caps ────────────────────────────────────────
const _SMALL_CAPS = {
  a:'ᴀ',b:'ʙ',c:'ᴄ',d:'ᴅ',e:'ᴇ',f:'ꜰ',g:'ɢ',h:'ʜ',i:'ɪ',
  j:'ᴊ',k:'ᴋ',l:'ʟ',m:'ᴍ',n:'ɴ',o:'ᴏ',p:'ᴘ',q:'ǫ',r:'ʀ',
  s:'ꜱ',t:'ᴛ',u:'ᴜ',v:'ᴠ',w:'ᴡ',x:'x',y:'ʏ',z:'ᴢ'
};
function _toSmallCaps(str) {
  if (!str) return str;
  return str.toLowerCase().split('').map(c => _SMALL_CAPS[c] || c).join('');
}

function _updateHeaderUsername() {
  const el = document.getElementById('homeHeaderUsername');
  if (el) el.textContent = _toSmallCaps(state.username) || '—';
}

// ── Full initial fetch ────────────────────────────────────────
async function _fetchHomeData() {
  // ── Race-condition guard ──────────────────────────────────
  // Prevents a second concurrent fetch if screen_home() is called
  // while a fetch is already in flight (e.g. rapid tab switches).
  if (_homeIsFetching) return;
  _homeIsFetching = true;
  _homeDataLoaded = false;

  // ── Failsafe timeout ──────────────────────────────────────
  // If data loading stalls for > 12 s, dismiss the skeleton and show
  // an error state.  An infinite spinner is worse than an error message.
  const _loadGuard = setTimeout(() => {
    _homeIsFetching = false;
    _showHomeLoading(false);
    _showHomeCards(true);
    if (!_homeAllTracks.length) {
      const list = document.getElementById('dailyMixList');
      if (list) {
        let wrap = list.querySelector('.home-tracks-wrap');
        if (!wrap) {
          wrap = document.createElement('div');
          wrap.className = 'home-tracks-wrap';
          list.appendChild(wrap);
        }
        wrap.innerHTML = `<div style="padding:32px 18px;text-align:center;color:var(--md-outline,#888);font-size:13px;">
          <span class="material-symbols-rounded" style="font-size:40px;display:block;margin-bottom:12px;opacity:0.5">wifi_off</span>
          Could not load data — check your connection.<br>
          <button onclick="_homeRetry()" style="margin-top:14px;padding:9px 20px;border-radius:100px;border:none;background:var(--accent,#E03030);color:#fff;font-size:13px;font-weight:700;cursor:pointer">Retry</button>
        </div>`;
      }
    }
  }, 12000);

  if (!state.apiKey) {
    _updateHeaderUsername();
    ['profileScrobbles','statTracks','statArtists','statAlbums'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = '—';
    });
    _homeAllTracks = [];
    _renderList();
    _showHomeLoading(false);
    _showHomeCards(true);
    clearTimeout(_loadGuard);
    _homeIsFetching = false;
    showToast('Add your API key in Settings to load data', 'error');
    return;
  }

  try {
    const [profileData, tracksData, artistsData, albumsData, recentData, topData] =
      await Promise.allSettled([
        lfmCall({ method: 'user.getinfo',         user: state.username }),
        lfmCall({ method: 'user.gettoptracks',    user: state.username, period: 'overall', limit: 1 }),
        lfmCall({ method: 'user.gettopartists',   user: state.username, period: 'overall', limit: 1 }),
        lfmCall({ method: 'user.gettopalbums',    user: state.username, period: 'overall', limit: 1 }),
        lfmCall({ method: 'user.getrecenttracks', user: state.username, limit: 50 }),
        lfmCall({ method: 'user.gettoptracks',    user: state.username, period: 'overall', limit: 50 }),
      ]);

    _updateHeaderUsername();

    let totalSeconds = 0;
    if (profileData.status === 'fulfilled') {
      const u = profileData.value.user;
      document.getElementById('profileScrobbles').textContent =
        parseInt(u.playcount || 0).toLocaleString();
      totalSeconds = parseInt(u.playcount || 0) * 210;
      const imgEntry = u.image && (
        u.image.find(i => i.size === 'large'  && _isRealHomeImg(i['#text'])) ||
        u.image.find(i => i.size === 'medium' && _isRealHomeImg(i['#text'])) ||
        u.image.find(i => _isRealHomeImg(i['#text']))
      );
      if (imgEntry?.['#text']) _applyTopbarAvatar(imgEntry['#text']);
    } else {
      document.getElementById('profileScrobbles').textContent = '—';
    }

    if (tracksData.status === 'fulfilled') {
      const total = tracksData.value?.toptracks?.['@attr']?.total;
      document.getElementById('statTracks').textContent =
        total ? parseInt(total).toLocaleString() : '—';
    }
    if (artistsData.status === 'fulfilled') {
      const total = artistsData.value?.topartists?.['@attr']?.total;
      document.getElementById('statArtists').textContent =
        total ? parseInt(total).toLocaleString() : '—';
    }
    if (albumsData.status === 'fulfilled') {
      const total = albumsData.value?.topalbums?.['@attr']?.total;
      document.getElementById('statAlbums').textContent =
        total ? parseInt(total).toLocaleString() : '—';
    }

    let recentTracks = [];
    if (recentData.status === 'fulfilled') {
      const raw      = recentData.value?.recenttracks?.track;
      const rawArr   = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      const filtered = rawArr.filter(t => !(t['@attr']?.nowplaying === 'true'));
      recentTracks   = normaliseTracks(filtered).map((t, i) => ({
        ...t,
        _recentIndex: i,
        album:        filtered[i]?.album?.['#text'] || '',
        _timestamp:   filtered[i]?.date?.uts ? parseInt(filtered[i].date.uts) * 1000 : null,
      }));
    }

    let topTracks = [];
    if (topData.status === 'fulfilled') {
      const rawArr = Array.isArray(topData.value?.toptracks?.track)
        ? topData.value.toptracks.track
        : (topData.value?.toptracks?.track ? [topData.value.toptracks.track] : []);
      topTracks = rawArr.filter(t => t && t.name).map(t => {
        const imgArr  = Array.isArray(t.image) ? t.image : [];
        const imgEntry =
          imgArr.find(i => i.size === 'extralarge' && _isRealHomeImg(i['#text'])) ||
          imgArr.find(i => i.size === 'large'      && _isRealHomeImg(i['#text'])) ||
          imgArr.find(i => i.size === 'medium'     && _isRealHomeImg(i['#text'])) ||
          imgArr.find(i => _isRealHomeImg(i['#text']));
        const artist = t.artist
          ? (typeof t.artist === 'string' ? t.artist : (t.artist.name || t.artist['#text'] || ''))
          : '';
        return {
          name:       t.name,
          artist,
          url:        t.url || '',
          image:      imgEntry?.['#text'] || '',
          _playCount: parseInt(t.playcount || 0),
        };
      });
    }

    const recentKeys = new Set(recentTracks.map(t => `${t.name}|${t.artist}`.toLowerCase()));
    const extra      = topTracks.filter(t => !recentKeys.has(`${t.name}|${t.artist}`.toLowerCase()));
    _homeAllTracks   = [...recentTracks, ...extra];

    // ── All data ready — render in one pass, THEN show UI ────
    // This is the fix for "incorrect partial data on open":
    // _renderList() populates the DOM fully before we reveal cards.
    _renderList();
    _showHomeLoading(false);
    _showHomeCards(true);
    _triggerEntryAnimations();

    // Mark load complete AFTER UI is ready
    _homeDataLoaded = true;
    _homeIsFetching = false;
    clearTimeout(_loadGuard);

    // Background work that doesn't block the UI
    _enrichHomeArt(_homeAllTracks);
    _initListenTimer(totalSeconds);
    _startHomeAutoRefresh();

  } catch (err) {
    clearTimeout(_loadGuard);
    _homeIsFetching = false;
    // Don't set _homeDataLoaded — next visit will retry the full fetch
    _showHomeLoading(false);
    _showHomeCards(true);
  }
}

// Retry helper called from the inline error button (avoids exposing the
// full _fetchHomeData signature to inline onclick attributes).
function _homeRetry() {
  _homeIsFetching = false;
  _homeDataLoaded = false;
  _homeAllTracks  = [];
  _homeCurrentPage   = 1;
  _homeIsLoadingMore = false;
  _homeHasMore       = true;
  _showHomeLoading(true);
  _showHomeCards(false);
  _fetchHomeData();
}

// ── Background art enrichment ─────────────────────────────────
// Uses the global _artUrlCache (defined in app.js) so artwork is never
// fetched twice — even across sort changes or auto-refresh cycles.
async function _enrichHomeArt(tracks) {
  if (!state.apiKey) return;
  // Only process tracks that genuinely have no image yet
  const missing = tracks.filter(t => !t.image || !t.image.trim()).slice(0, 50);
  if (!missing.length) return;

  const BATCH = 4;
  for (let i = 0; i < missing.length; i += BATCH) {
    await Promise.allSettled(
      missing.slice(i, i + BATCH).map(async t => {
        try {
          // _resolveTrackArt (app.js) handles cache + Last.fm + iTunes fallback
          const url = typeof _resolveTrackArt === 'function'
            ? await _resolveTrackArt(t.name, t.artist)
            : await _resolveTrackArtLocal(t.name, t.artist);
          if (url) {
            t.image = url;
            _patchTrackArt(t.name, t.artist, url);
          }
        } catch { /* silent */ }
      })
    );
  }
}

// Local fallback in case app.js hasn't loaded yet (defensive)
async function _resolveTrackArtLocal(name, artist) {
  let url = '';
  try {
    const data  = await lfmCall({ method: 'track.getInfo', track: name, artist, autocorrect: 1 });
    const album = data?.track?.album;
    if (album?.image) {
      const img =
        album.image.find(i => i.size === 'extralarge' && _isRealHomeImg(i['#text'])) ||
        album.image.find(i => i.size === 'large'      && _isRealHomeImg(i['#text'])) ||
        album.image.find(i => i.size === 'medium'     && _isRealHomeImg(i['#text'])) ||
        album.image.find(i => _isRealHomeImg(i['#text']));
      if (img) url = img['#text'];
    }
    if (!url && data?.track?.image) {
      const img = data.track.image.find(i => _isRealHomeImg(i['#text']));
      if (img) url = img['#text'];
    }
  } catch {}
  // iTunes ONLY as last resort when Last.fm has nothing
  if (!url && typeof _itunesFetchArtwork === 'function') {
    try { url = await _itunesFetchArtwork(name, artist, 'track'); } catch {}
  }
  return url;
}

function _patchTrackArt(name, artist, url) {
  const list = document.getElementById('dailyMixList');
  if (!list) return;
  list.querySelectorAll('.home-track-item').forEach(row => {
    const nameEl   = row.querySelector('.home-track-name');
    const artistEl = row.querySelector('.home-track-artist');
    if (!nameEl || !artistEl) return;
    if (nameEl.textContent.trim() !== name || artistEl.textContent.trim() !== artist) return;
    const wrap = row.querySelector('.home-track-art-wrap');
    if (!wrap) return;
    let img = wrap.querySelector('.home-track-art');
    const fallback = wrap.querySelector('.home-track-art-fallback');
    if (!img) {
      img = document.createElement('img');
      img.className = 'home-track-art';
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = function() { this.classList.add('errored'); };
      wrap.insertBefore(img, wrap.firstChild);
    }
    img.classList.remove('errored');
    img.src = url;
    if (fallback) fallback.style.display = 'none';
  });
}

// ══════════════════════════════════════════════════════════════
//  LIVE LISTENING TIME TRACKER
// ══════════════════════════════════════════════════════════════
let _listenTimerBase  = 0;
let _listenLiveSecs   = 0;
let _listenIsPlaying  = false;
let _listenTickTimer  = null;
let _listenPollTimer  = null;
let _listenPollBound  = false;

function _initListenTimer(totalSeconds) {
  _listenTimerBase = totalSeconds || 0;
  _listenLiveSecs  = 0;
  _listenIsPlaying = false;
  _stopListenTick();
  _updateTimerDisplay();
  if (_listenPollTimer) clearInterval(_listenPollTimer);
  _checkNowPlaying();
  _listenPollTimer = setInterval(_checkNowPlaying, 10_000);  // 10 s — near real-time
  if (!_listenPollBound) {
    _listenPollBound = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        _checkNowPlaying();
      } else {
        _stopListenTick(true);
        _listenIsPlaying = false;
      }
    });
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.setActionHandler('play',  () => { _listenIsPlaying = true;  _startListenTick(); });
        navigator.mediaSession.setActionHandler('pause', () => { _listenIsPlaying = false; _stopListenTick(true); });
        navigator.mediaSession.setActionHandler('stop',  () => { _listenIsPlaying = false; _stopListenTick(true); });
      } catch {}
    }
  }
}

function _destroyListenTimer() {
  if (_listenPollTimer) { clearInterval(_listenPollTimer); _listenPollTimer = null; }
  _stopListenTick();
  _listenPollBound = false;
}

async function _checkNowPlaying() {
  if (!state.username || !state.apiKey) return;
  try {
    const url = new URL(LASTFM_BASE);
    const p   = { method: 'user.getrecenttracks', user: state.username, limit: 1, api_key: state.apiKey, format: 'json' };
    Object.entries(p).forEach(([k, v]) => url.searchParams.set(k, v));
    const res    = await fetch(url.toString(), { cache: 'no-store' });
    if (!res.ok) return;
    const data   = await res.json();
    const tracks = data?.recenttracks?.track;
    const latest = Array.isArray(tracks) ? tracks[0] : tracks;
    const playing = latest?.['@attr']?.nowplaying === 'true';

    if (playing) {
      const trackName  = latest.name || '';
      const artistName = typeof latest.artist === 'string'
        ? latest.artist : (latest.artist?.['#text'] || '');

      // Grab the best image the API gives us right now
      const imgArr   = Array.isArray(latest.image) ? latest.image : [];
      const imgEntry =
        imgArr.find(i => i.size === 'extralarge' && _isRealHomeImg(i['#text'])) ||
        imgArr.find(i => i.size === 'large'      && _isRealHomeImg(i['#text'])) ||
        imgArr.find(i => i.size === 'medium'     && _isRealHomeImg(i['#text'])) ||
        imgArr.find(i => _isRealHomeImg(i['#text']));
      const image = imgEntry?.['#text'] || '';

      const prevKey = _nowPlayingTrack
        ? `${_nowPlayingTrack.name}|${_nowPlayingTrack.artist}`.toLowerCase()
        : null;
      const curKey  = `${trackName}|${artistName}`.toLowerCase();

      // Song changed (or first detection) — update the Now Playing row
      if (prevKey !== curKey) {
        // ── Move previous track to the top of the list ──────────
        // Only if it isn't already present (e.g. from a previous API fetch).
        if (_nowPlayingTrack && prevKey) {
          const alreadyInList = _homeAllTracks.some(t =>
            `${t.name}|${t.artist}`.toLowerCase() === prevKey
          );
          if (!alreadyInList) {
            _homeAllTracks.unshift({
              name:          _nowPlayingTrack.name,
              artist:        _nowPlayingTrack.artist,
              image:         _nowPlayingTrack.image || '',
              _recentIndex:  -1,
              _timestamp:    Date.now(),
              _liveSession:  true,   // flag so API refresh can deduplicate it
            });
          }
        }
        _nowPlayingTrack = { name: trackName, artist: artistName, image };
        if (state.currentPage === 'home') {
          _renderList();              // re-render so the moved track shows first
          _renderNowPlayingRow();
          // Async enrich art if API didn't provide one
          if (!image) _resolveNowPlayingArt(trackName, artistName);
        }
      }

      if (!_listenIsPlaying) {
        _listenIsPlaying = true;
        _startListenTick();
      }
    } else {
      if (_listenIsPlaying) {
        _listenIsPlaying = false;
        _stopListenTick(true);
      }
      // Track finished / nothing playing — remove the pending row
      if (_nowPlayingTrack) {
        _nowPlayingTrack = null;
        _removeNowPlayingRow();
      }
    }
  } catch {}
}

// ── Now Playing row helpers ───────────────────────────────────

/**
 * Injects the "Now Playing" pending-scrobble row at the top of the
 * home track list.  Pure visual layer — no scrobbles are created.
 */
function _renderNowPlayingRow() {
  if (!_nowPlayingTrack) return;
  const wrap = document.querySelector('.home-tracks-wrap');
  if (!wrap) return;

  // Remove stale row first (song change)
  wrap.querySelector('.home-track-nowplaying')?.remove();

  const { name, artist, image } = _nowPlayingTrack;
  const hasImg = image && image.trim();

  const div = document.createElement('div');
  div.className = 'home-track-item home-track-nowplaying';
  div.setAttribute('data-lp-name',   name);
  div.setAttribute('data-lp-artist', artist);
  div.setAttribute('onclick', `openTrackOnYouTube('${escAttr(name)}','${escAttr(artist)}')`);

  div.innerHTML = `
    <div class="home-track-art-wrap home-np-art-wrap">
      ${hasImg ? `<img src="${esc(image)}" alt="" class="home-track-art home-np-art"
                       loading="eager" onerror="this.classList.add('errored')">` : ''}
      <span class="material-symbols-rounded home-track-art-fallback"${hasImg ? '' : ' style="display:block"'}>graphic_eq</span>
      <div class="home-np-wave" aria-hidden="true">
        <span></span><span></span><span></span><span></span>
      </div>
    </div>
    <div class="home-track-info">
      <div class="home-track-name">${esc(name)}</div>
      <div class="home-track-artist">${esc(artist)}</div>
    </div>
    <div class="home-np-badge">
      <span class="home-np-dot" aria-hidden="true"></span>
      <span>Now Playing</span>
    </div>
    <button
      class="home-track-menu"
      onclick="event.stopPropagation();_openTrackDropdown(this,'${escAttr(name)}','${escAttr(artist)}')"
      aria-label="More options"
    >
      <span class="material-symbols-rounded">more_vert</span>
    </button>`;

  wrap.insertBefore(div, wrap.firstChild);

  // ── Bind long-press copy to the Now Playing row ───────────────
  // _renderList() calls _bindLongPressCopy BEFORE this row is injected,
  // so the NP row never gets long-press registered. Re-binding the whole
  // wrap is safe — the _lpBound guard on existing items prevents doubles.
  if (typeof bindLongPressCopy === 'function') {
    bindLongPressCopy(wrap, '[data-lp-name]');
  }
}

/**
 * Removes the Now Playing row with a quick fade-out.
 */
function _removeNowPlayingRow() {
  const row = document.querySelector('.home-track-nowplaying');
  if (!row) return;
  row.style.transition = 'opacity 0.28s ease';
  row.style.opacity    = '0';
  setTimeout(() => row.remove(), 300);
}

/**
 * Async art resolver for the Now Playing row.
 * Called only when the API response didn't include album art.
 */
async function _resolveNowPlayingArt(name, artist) {
  try {
    const url = typeof _resolveTrackArt === 'function'
      ? await _resolveTrackArt(name, artist)
      : '';
    if (!url) return;

    // Confirm the track is still playing (song may have changed)
    if (!_nowPlayingTrack ||
        _nowPlayingTrack.name !== name ||
        _nowPlayingTrack.artist !== artist) return;

    _nowPlayingTrack.image = url;

    const row = document.querySelector('.home-track-nowplaying');
    if (!row) return;
    const wrap    = row.querySelector('.home-np-art-wrap');
    const fallback = row.querySelector('.home-track-art-fallback');
    if (!wrap) return;

    let img = wrap.querySelector('.home-np-art');
    if (!img) {
      img = document.createElement('img');
      img.className = 'home-track-art home-np-art';
      img.alt       = '';
      img.loading   = 'eager';
      img.onerror   = () => img.classList.add('errored');
      wrap.insertBefore(img, wrap.firstChild);
    }
    img.style.opacity  = '0';
    img.style.transition = 'opacity 0.3s ease';
    img.onload = () => {
      img.style.opacity = '1';
      if (fallback) fallback.style.display = 'none';
    };
    img.src = url;
  } catch {}
}

function _startListenTick() {
  if (_listenTickTimer) return;
  _listenTickTimer = setInterval(() => { _listenLiveSecs++; _updateTimerDisplay(); }, 1000);
}

function _stopListenTick(keepLiveSecs = false) {
  if (_listenTickTimer) { clearInterval(_listenTickTimer); _listenTickTimer = null; }
  if (!keepLiveSecs) _listenLiveSecs = 0;
  _updateTimerDisplay();
}

function _updateTimerDisplay() {
  const el = document.getElementById('homeTimerValue');
  if (!el) return;
  const t = _listenTimerBase + _listenLiveSecs;
  if (!t) { el.textContent = '--:--:--:--'; return; }
  const d = Math.floor(t / 86400);
  const h = Math.floor((t % 86400) / 3600);
  const m = Math.floor((t % 3600)  / 60);
  const s = t % 60;
  el.textContent =
    String(d).padStart(2,'0') + ':' +
    String(h).padStart(2,'0') + ':' +
    String(m).padStart(2,'0') + ':' +
    String(s).padStart(2,'0');
  document.getElementById('homeListenTimer')?.classList.toggle('timer-live', _listenIsPlaying);
}

// ── Sort system ───────────────────────────────────────────────
function toggleSortMenu() {
  _sortMenuOpen = !_sortMenuOpen;
  const menu    = document.getElementById('homeSortMenu');
  const chevron = document.getElementById('homeSortChevron');
  menu?.classList.toggle('hidden', !_sortMenuOpen);
  chevron?.classList.toggle('open', _sortMenuOpen);
  if (_sortMenuOpen) {
    setTimeout(() => {
      document.addEventListener('click', _closeSortMenuOutside, { once: true });
    }, 0);
  }
}

function _closeSortMenuOutside(e) {
  if (!document.getElementById('homeSortWrap')?.contains(e.target)) {
    _sortMenuOpen = false;
    document.getElementById('homeSortMenu')?.classList.add('hidden');
    document.getElementById('homeSortChevron')?.classList.remove('open');
  }
}

function setSortMode(mode) {
  _sortMenuOpen = false;
  document.getElementById('homeSortMenu')?.classList.add('hidden');
  document.getElementById('homeSortChevron')?.classList.remove('open');
  _homeSortMode = mode;
  _homeCurrentPage   = 1;
  _homeIsLoadingMore = false;
  _homeHasMore       = true;
  const labels = { recent: 'Recent', mostPlayed: 'Most Played' };
  const labelEl = document.getElementById('homeSortLabel');
  if (labelEl) labelEl.textContent = labels[mode] || mode;
  document.getElementById('sortOptRecent')?.classList.toggle('active', mode === 'recent');
  document.getElementById('sortOptMostPlayed')?.classList.toggle('active', mode === 'mostPlayed');
  document.getElementById('checkRecent')?.classList.toggle('hidden', mode !== 'recent');
  document.getElementById('checkMostPlayed')?.classList.toggle('hidden', mode !== 'mostPlayed');
  _renderList();
  _setupInfiniteScroll();
  // After a sort switch to Popular, enrich any tracks that are missing artwork
  if (mode === 'mostPlayed') {
    _enrichHomeArt(_homeAllTracks);
  }
}

function _renderList() {
  const list = document.getElementById('dailyMixList');
  if (!list) return;
  let tracksWrap = list.querySelector('.home-tracks-wrap');
  if (!tracksWrap) {
    tracksWrap = document.createElement('div');
    tracksWrap.className = 'home-tracks-wrap';
    list.appendChild(tracksWrap);
  }
  if (!_homeAllTracks.length) {
    tracksWrap.innerHTML = `
      <div style="padding:24px 18px;text-align:center;color:var(--md-outline);font-size:13px;">
        No tracks yet — start listening on Last.fm!
      </div>`;
    return;
  }
  let sorted = [..._homeAllTracks];
  if (_homeSortMode === 'mostPlayed') {
    sorted.sort((a, b) => (b._playCount || 0) - (a._playCount || 0));
  } else {
    sorted.sort((a, b) => {
      const ai = a._recentIndex !== undefined ? a._recentIndex : 9999;
      const bi = b._recentIndex !== undefined ? b._recentIndex : 9999;
      return ai - bi;
    });
  }
  let displayTracks = sorted;
  if (_homeSortMode === 'recent') {
    displayTracks = _dedupeRecentTracks(sorted);
  }
  const displaySlice = displayTracks.slice(0, 20);
  tracksWrap.innerHTML = displaySlice.map((t, rowIdx) => {
    const hasImg = t.image && t.image.trim();
    const imgTag = hasImg
      ? `<img src="${esc(t.image)}" alt="" class="home-track-art" loading="${rowIdx < 3 ? 'eager' : 'lazy'}"
             onerror="this.classList.add('errored')">`
      : '';
    const fallbackVis = hasImg ? '' : 'style="display:block"';
    let rightBadge = '';
    if (_homeSortMode === 'mostPlayed' && t._playCount) {
      const countLabel = t._playCount >= 1000
        ? (t._playCount / 1000).toFixed(1) + 'k'
        : String(t._playCount);
      rightBadge = `<span class="home-track-count">${countLabel}</span>`;
    } else if (_homeSortMode === 'recent' && t._dupCount && t._dupCount > 1) {
      rightBadge = `<span class="home-track-count home-track-dup-count">×${t._dupCount}</span>`;
    }
    const lpAttr = `data-lp-name="${escAttr(t.name)}" data-lp-artist="${escAttr(t.artist)}"`;
    // Newest tracks animate in
    const animStyle = rowIdx < 3 ? ` style="animation:hw-fade-slide 0.3s ease ${rowIdx * 0.06}s both"` : '';
    return `
      <div class="home-track-item" ${lpAttr}${animStyle}
           onclick="openTrackOnYouTube('${escAttr(t.name)}','${escAttr(t.artist)}')">
        <div class="home-track-art-wrap">
          ${imgTag}
          <span class="material-symbols-rounded home-track-art-fallback" ${fallbackVis}>music_note</span>
        </div>
        <div class="home-track-info">
          <div class="home-track-name">${esc(t.name)}</div>
          <div class="home-track-artist">${esc(t.artist)}</div>
        </div>
        ${rightBadge}
        <button
          class="home-track-menu"
          onclick="event.stopPropagation();_openTrackDropdown(this,'${escAttr(t.name)}','${escAttr(t.artist)}')"
          aria-label="More options"
        >
          <span class="material-symbols-rounded">more_vert</span>
        </button>
      </div>`;
  }).join('');
  _bindLongPressCopy(tracksWrap);
  _setupInfiniteScroll();

  // Re-inject Now Playing row at top if a track is still live
  if (_nowPlayingTrack) {
    requestAnimationFrame(() => _renderNowPlayingRow());
  }
}

function _dedupeRecentTracks(tracks) {
  if (!tracks.length) return tracks;
  const countMap = new Map();
  for (const t of tracks) {
    const key = `${t.name}|${t.artist}`.toLowerCase();
    countMap.set(key, (countMap.get(key) || 0) + 1);
  }
  const seen = new Set();
  const result = [];
  for (const t of tracks) {
    const key = `${t.name}|${t.artist}`.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ ...t, _dupCount: countMap.get(key) });
    }
  }
  return result;
}

function _bindLongPressCopy(container) {
  bindLongPressCopy(container, '[data-lp-name]');
}
function _fallbackCopy(text) { _lpFallbackCopy(text); }

// ── Infinite scroll ───────────────────────────────────────────
function _setupInfiniteScroll() {
  const scrollEl = document.querySelector('.home-mix-scroll');
  if (!scrollEl) return;
  scrollEl._infiniteBound = false;
  if (scrollEl._infiniteHandler) {
    scrollEl.removeEventListener('scroll', scrollEl._infiniteHandler);
  }
  let _rafPending = false;
  const handler = () => {
    if (_rafPending) return;
    _rafPending = true;
    requestAnimationFrame(() => {
      _rafPending = false;
      if (_homeIsLoadingMore || !_homeHasMore) return;
      const { scrollTop, scrollHeight, clientHeight } = scrollEl;
      if (scrollTop + clientHeight >= scrollHeight - 200) _loadMoreTracks();
    });
  };
  scrollEl._infiniteHandler = handler;
  scrollEl._infiniteBound   = true;
  scrollEl.addEventListener('scroll', handler, { passive: true });
}

async function _loadMoreTracks() {
  if (_homeIsLoadingMore || !_homeHasMore || !state.username || !state.apiKey) return;
  _homeIsLoadingMore = true;
  _homeCurrentPage++;
  const wrap = document.querySelector('.home-tracks-wrap');
  const spinner = document.createElement('div');
  spinner.id = 'homeLoadMoreSpinner';
  spinner.style.cssText = 'display:flex;justify-content:center;padding:16px 0;';
  spinner.innerHTML = '<span class="material-symbols-rounded" style="animation:spin 1s linear infinite;color:var(--md-outline);font-size:22px">refresh</span>';
  wrap?.appendChild(spinner);
  try {
    const isTop  = _homeSortMode === 'mostPlayed';
    const params = isTop
      ? { method: 'user.gettoptracks',   user: state.username, period: 'overall', limit: 50, page: _homeCurrentPage }
      : { method: 'user.getrecenttracks', user: state.username, limit: 50, page: _homeCurrentPage };
    const data = await lfmCall(params);
    let newTracks  = [];
    let totalPages = 1;
    if (isTop) {
      const raw  = data?.toptracks?.track;
      totalPages = parseInt(data?.toptracks?.['@attr']?.totalPages || 1);
      const arr  = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      newTracks = arr.filter(t => t && t.name).map(t => {
        const imgArr   = Array.isArray(t.image) ? t.image : [];
        const imgEntry =
          imgArr.find(i => i.size === 'extralarge' && _isRealHomeImg(i['#text'])) ||
          imgArr.find(i => i.size === 'large'      && _isRealHomeImg(i['#text'])) ||
          imgArr.find(i => _isRealHomeImg(i['#text']));
        const artist = t.artist
          ? (typeof t.artist === 'string' ? t.artist : (t.artist.name || t.artist['#text'] || ''))
          : '';
        return { name: t.name, artist, url: t.url || '', image: imgEntry?.['#text'] || '', _playCount: parseInt(t.playcount || 0) };
      });
    } else {
      const raw  = data?.recenttracks?.track;
      totalPages = parseInt(data?.recenttracks?.['@attr']?.totalPages || 1);
      const arr  = Array.isArray(raw) ? raw : (raw ? [raw] : []);
      newTracks  = normaliseTracks(arr.filter(t => !(t['@attr']?.nowplaying === 'true')));
    }
    _homeHasMore = _homeCurrentPage < totalPages;
    const existingKeys = new Set(_homeAllTracks.map(t => `${t.name}|${t.artist}`.toLowerCase()));
    const fresh = newTracks.filter(t => !existingKeys.has(`${t.name}|${t.artist}`.toLowerCase()));
    if (fresh.length) {
      _homeAllTracks = [..._homeAllTracks, ...fresh];
      _appendTracksToDOM(fresh);
      // Enrich artwork for newly loaded tracks (Popular sort images fix)
      _enrichHomeArt(fresh);
    }
  } catch {
    _homeHasMore = false;
    _homeCurrentPage--;
  } finally {
    _homeIsLoadingMore = false;
    document.getElementById('homeLoadMoreSpinner')?.remove();
  }
}

function _appendTracksToDOM(tracks) {
  const wrap = document.querySelector('.home-tracks-wrap');
  if (!wrap || !tracks.length) return;
  const frag = document.createDocumentFragment();
  tracks.forEach((t, idx) => {
    const hasImg = t.image && t.image.trim();

    let rightBadge = '';
    if (_homeSortMode === 'mostPlayed' && t._playCount) {
      const countLabel = t._playCount >= 1000
        ? (t._playCount / 1000).toFixed(1) + 'k'
        : String(t._playCount);
      rightBadge = `<span class="home-track-count">${countLabel}</span>`;
    } else if (_homeSortMode === 'recent') {
      // Count how many times this track now appears in the full list
      const key = `${t.name}|${t.artist}`.toLowerCase();
      const total = _homeAllTracks.filter(x => `${x.name}|${x.artist}`.toLowerCase() === key).length;
      if (total > 1) {
        rightBadge = `<span class="home-track-count home-track-dup-count">×${total}</span>`;
        // Also update any existing DOM row for this track
        wrap.querySelectorAll('.home-track-item').forEach(row => {
          if (row.dataset.lpName === t.name && row.dataset.lpArtist === t.artist) {
            const existing = row.querySelector('.home-track-count');
            if (existing) existing.textContent = `×${total}`;
          }
        });
      }
    }

    const div = document.createElement('div');
    div.className = 'home-track-item';
    div.dataset.lpName   = t.name;
    div.dataset.lpArtist = t.artist;
    div.setAttribute('onclick', `openTrackOnYouTube('${escAttr(t.name)}','${escAttr(t.artist)}')`);
    const loadingAttr = idx < 6 ? 'eager' : 'lazy';
    div.innerHTML = `
      <div class="home-track-art-wrap">
        ${hasImg ? `<img src="${esc(t.image)}" alt="" class="home-track-art" loading="${loadingAttr}" onerror="this.classList.add('errored')">` : ''}
        <span class="material-symbols-rounded home-track-art-fallback"${hasImg ? '' : ' style="display:block"'}>music_note</span>
      </div>
      <div class="home-track-info">
        <div class="home-track-name">${esc(t.name)}</div>
        <div class="home-track-artist">${esc(t.artist)}</div>
      </div>
      ${rightBadge}
      <button class="home-track-menu" onclick="event.stopPropagation();_openTrackDropdown(this,'${escAttr(t.name)}','${escAttr(t.artist)}')" aria-label="More options">
        <span class="material-symbols-rounded">more_vert</span>
      </button>`;
    frag.appendChild(div);
  });
  wrap.appendChild(frag);
  _bindLongPressCopy(wrap);
}

// ── Entry animations ──────────────────────────────────────────
function _triggerEntryAnimations() {
  const targets = [
    { id: 'homeHeader',       cls: 'hw-anim-header' },
    { id: 'userProfileCard',  cls: 'hw-anim-stats'  },
    { id: 'dailyMixCard',     cls: 'hw-anim-list'   },
  ];
  targets.forEach(({ id, cls }) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add(cls);
    el.style.animationName = 'none';
  });
  requestAnimationFrame(() => {
    targets.forEach(({ id }) => {
      const el = document.getElementById(id);
      if (el) el.style.animationName = '';
    });
  });
  _setupStatsSqueezeAnim();
  const scrollEl = document.querySelector('.home-screen');
  const listCard  = document.getElementById('dailyMixCard');
  const statsCard = document.getElementById('userProfileCard');
  if (scrollEl && !scrollEl._scrollAnimBound) {
    scrollEl._scrollAnimBound = true;
    let _rafPending = false;
    scrollEl.addEventListener('scroll', () => {
      if (_rafPending) return;
      _rafPending = true;
      requestAnimationFrame(() => {
        const scrolled = scrollEl.scrollTop > 20;
        statsCard?.classList.toggle('scroll-shrunk', scrolled);
        const innerScroll = scrollEl.querySelector('.home-mix-scroll');
        if (listCard && innerScroll) listCard.classList.toggle('scrolled', innerScroll.scrollTop > 4);
        _rafPending = false;
      });
    }, { passive: true });
  }
  const innerScrollEl = document.querySelector('.home-mix-scroll');
  if (innerScrollEl && listCard && !innerScrollEl._elevBound) {
    innerScrollEl._elevBound = true;
    let _rafPending2 = false;
    innerScrollEl.addEventListener('scroll', () => {
      if (_rafPending2) return;
      _rafPending2 = true;
      requestAnimationFrame(() => {
        listCard.classList.toggle('scrolled', innerScrollEl.scrollTop > 4);
        _rafPending2 = false;
      });
    }, { passive: true });
  }
}

function _setupStatsSqueezeAnim() {
  const card = document.getElementById('userProfileCard');
  if (!card || card._squeezeBound) return;
  card._squeezeBound = true;
  let startY = 0, isDragging = false;
  const FACTOR = 0.0022, MAX_SQ = 0.065;
  const SPRING_CB = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
  card.addEventListener('touchstart', (e) => {
    if (e.target.closest('#dailyMixCard') || e.target.closest('.home-mix-scroll')) return;
    startY = e.touches[0].clientY; isDragging = true;
    card.style.transition = 'none'; card.style.willChange = 'transform';
  }, { passive: true });
  card.addEventListener('touchmove', (e) => {
    if (!isDragging) return;
    const dy = e.touches[0].clientY - startY;
    const squeeze = Math.min(Math.abs(dy) * FACTOR, MAX_SQ);
    if (dy < 0) {
      card.style.transform = `scaleY(${(1 - squeeze).toFixed(4)}) scaleX(${(1 + squeeze * 0.28).toFixed(4)})`;
    } else {
      card.style.transform = `scaleY(${(1 + squeeze * 0.38).toFixed(4)}) scaleX(${(1 - squeeze * 0.18).toFixed(4)})`;
    }
  }, { passive: true });
  const release = () => {
    if (!isDragging) return;
    isDragging = false; card.style.willChange = '';
    card.style.transition = `transform 0.48s ${SPRING_CB}`;
    card.style.transform  = '';
    setTimeout(() => { if (card) card.style.transition = ''; }, 520);
  };
  card.addEventListener('touchend',    release, { passive: true });
  card.addEventListener('touchcancel', release, { passive: true });
}

// ── Topbar avatar ─────────────────────────────────────────────
function _applyTopbarAvatar(url) {
  const topbarAvatar = document.getElementById('topbarAvatar');
  const topbarIcon   = document.getElementById('topbarAvatarIcon');
  if (!topbarAvatar || !url) return;
  topbarAvatar.src = url;
  topbarAvatar.onload  = () => { topbarAvatar.classList.remove('hidden'); topbarIcon?.classList.add('hidden'); };
  topbarAvatar.onerror = () => { topbarAvatar.classList.add('hidden');    topbarIcon?.classList.remove('hidden'); };
}

function _isRealHomeImg(url) {
  if (typeof _isRealImg === 'function') return _isRealImg(url);
  return url && url.trim() !== '' && !url.includes('2a96cbd8b46e442fc41c2b86b821562f');
}

function _showHomeLoading(show) {
  document.getElementById('homeSkeleton')?.classList.toggle('hidden', !show);
}
function _showHomeCards(show) {
  document.getElementById('userProfileCard')?.classList.toggle('hidden', !show);
  document.getElementById('dailyMixCard')?.classList.toggle('hidden', !show);
  // Only show the header if we have a username — never hide it once visible
  // (hiding + re-showing triggers a layout jump and flicker on Android WebView).
  if (show && state.username) {
    document.getElementById('homeHeader')?.classList.remove('hidden');
  } else if (!show) {
    // Only hide during an explicit loading state, not on a data-ready reveal
    // We skip hiding if data is already loaded to prevent the flash.
    if (!_homeDataLoaded) {
      document.getElementById('homeHeader')?.classList.toggle('hidden', !state.username);
    }
  }
}

// ── Pull-to-refresh ───────────────────────────────────────────
let _homePtr = { startY: 0, active: false, indicator: null };

function _setupPullToRefresh() {
  const scrollEl = document.querySelector('.home-screen');
  if (!scrollEl || scrollEl._ptrBound) return;
  scrollEl._ptrBound = true;
  if (!_homePtr.indicator) {
    const ind = document.createElement('div');
    ind.id = 'homePtrIndicator';
    ind.style.cssText = [
      'position:absolute;top:0;left:50%;transform:translateX(-50%) translateY(-48px)',
      'width:36px;height:36px;border-radius:50%',
      'background:var(--md-surface-container-high);border:none',
      'display:flex;align-items:center;justify-content:center',
      'transition:transform 0.2s ease;z-index:10;pointer-events:none'
    ].join(';');
    ind.innerHTML = '<span class="material-symbols-rounded" style="font-size:20px;color:var(--md-primary);animation:spin 0.8s linear infinite">refresh</span>';
    scrollEl.parentElement.style.position = 'relative';
    scrollEl.parentElement.insertBefore(ind, scrollEl);
    _homePtr.indicator = ind;
  }
  scrollEl.addEventListener('touchstart', (e) => {
    if (e.target.closest('.home-mix-scroll')) return;
    if (scrollEl.scrollTop === 0) { _homePtr.startY = e.touches[0].clientY; _homePtr.active = true; }
  }, { passive: true });
  scrollEl.addEventListener('touchmove', (e) => {
    if (!_homePtr.active) return;
    if (e.target.closest('.home-mix-scroll')) { _homePtr.active = false; return; }
    const delta = e.touches[0].clientY - _homePtr.startY;
    if (delta > 0 && _homePtr.indicator) {
      const pull = Math.min(delta * 0.4, 56);
      _homePtr.indicator.style.transform = `translateX(-50%) translateY(${pull - 48}px)`;
    }
  }, { passive: true });
  scrollEl.addEventListener('touchend', (e) => {
    if (!_homePtr.active) return;
    const delta = e.changedTouches[0].clientY - _homePtr.startY;
    _homePtr.active = false;
    if (_homePtr.indicator) _homePtr.indicator.style.transform = 'translateX(-50%) translateY(-48px)';
    if (delta >= 70 && state.username) {
      document.getElementById('profileScrobbles').textContent = '—';
      _homeAllTracks  = [];
      _homeIsFetching = false;
      _homeDataLoaded = false;
      _stopHomeAutoRefresh();
      _showHomeLoading(true);
      _showHomeCards(false);
      _fetchHomeData();
    }
  }, { passive: true });
}

// ── Save username ─────────────────────────────────────────────
function saveUsername() {
  const val = document.getElementById('homeUsernameInput').value.trim();
  if (!val) { showToast('Please enter a username', 'error'); return; }
  state.username  = val;
  localStorage.setItem('lw_username', val);
  document.getElementById('homeUsernameSection').classList.add('hidden');
  document.getElementById('profileScrobbles').textContent = '—';
  _homeAllTracks  = [];
  _homeIsFetching = false;
  _homeDataLoaded = false;
  screen_home();
}

function clearUser() {
  state.username = '';
  localStorage.removeItem('lw_username');
  _homeAllTracks  = [];
  _homeIsFetching = false;
  _homeDataLoaded = false;
  _destroyListenTimer();
  _stopHomeAutoRefresh();
  _homeCurrentPage   = 1;
  _homeIsLoadingMore = false;
  _homeHasMore       = true;
  _showHomeCards(false);
  document.getElementById('homeHeader').classList.add('hidden');
  document.getElementById('homeUsernameSection').classList.remove('hidden');
  document.getElementById('homeUsernameInput').value = '';
  const topbarAvatar = document.getElementById('topbarAvatar');
  const topbarIcon   = document.getElementById('topbarAvatarIcon');
  if (topbarAvatar) topbarAvatar.classList.add('hidden');
  if (topbarIcon)   topbarIcon.classList.remove('hidden');
}

function quickGenerate(mode) {
  state.selectedMode = mode;
  state.chipSelections.limit = '25';
  generatePlaylist(true);
}

// ══════════════════════════════════════════════════════════════
//  TRACK DROPDOWN MENU
// ══════════════════════════════════════════════════════════════

function _openTrackDropdown(btn, trackName, artistName) {
  _closeTrackDropdown();
  const trackEl   = btn.closest('.home-track-item');
  const lpName    = trackEl?.dataset?.lpName;
  const matched   = _homeAllTracks.find(t => t.name === lpName && t.artist === artistName);
  const tsMs      = matched?._timestamp || null;
  const playedAgo = tsMs ? _formatRelativeTime(tsMs) : null;

  const items = [
    { icon: 'shuffle',       label: 'Start Mix from this', action: () => startMixFromTrack(trackName, artistName) },
    { icon: 'open_in_new',   label: 'Open in Last.fm',     action: () => openTrackOnLastFm(trackName, artistName) },
    { icon: 'smart_display', label: 'Play on YouTube',     action: () => openTrackOnYouTube(trackName, artistName) },
    { icon: 'image_search',  label: 'Refresh Cover Art',   action: async () => {
      showToast('Refreshing cover art\u2026');
      const url = typeof _refreshTrackArtwork === 'function'
        ? await _refreshTrackArtwork(trackName, artistName)
        : '';
      if (url) {
        _patchTrackArt(trackName, artistName, url);
        _preloadImages([{ image: url }]);
        showToast('Cover art updated \u2713', 'success');
      } else {
        showToast('Cover art not available', 'error');
      }
    }},
    { icon: 'delete', label: 'Delete Scrobble', action: () => {
      if (!state.sessionKey) { showToast('Sign in to delete scrobbles', 'error'); return; }
      showModal(
        'Delete Scrobble?',
        `Remove \u201c${trackName}\u201d by ${artistName} from your Last.fm history?`,
        async () => {
          const ok = await _lfmDeleteScrobble(trackName, artistName, tsMs);
          if (ok) {
            const idx = _homeAllTracks.findIndex(
              t => t.name === trackName && t.artist === artistName &&
                   (!tsMs || t._timestamp === tsMs)
            );
            if (idx !== -1) { _homeAllTracks.splice(idx, 1); _renderList(); }
          }
        }
      );
    }},
  ];

  const menu = document.createElement('div');
  menu.id = 'trackDropdownMenu';
  menu.className = 'track-dropdown-menu';
  menu.setAttribute('role', 'menu');

  // ── Genre row (async fill-in) ────────────────────────────────
  const genreRow = document.createElement('div');
  genreRow.className = 'track-dropdown-genre';
  genreRow.innerHTML = `<span class="material-symbols-rounded">sell</span><span><span class="track-dropdown-genre-label">Genre:</span><span class="td-genre-val"> \u2026</span></span>`;
  menu.appendChild(genreRow);

  // ── "Explore this genre" — revealed once genre resolves ──────
  const exploreBtn = document.createElement('button');
  exploreBtn.className = 'track-dropdown-item track-dropdown-explore';
  exploreBtn.setAttribute('role', 'menuitem');
  exploreBtn.style.display = 'none';
  exploreBtn.innerHTML =
    `<span class="material-symbols-rounded track-dropdown-icon" style="color:var(--md-primary)">bolt</span>` +
    `<span style="color:var(--md-primary);font-weight:500">Explore this genre</span>`;
  menu.appendChild(exploreBtn);

  // ── Played-ago header ────────────────────────────────────────
  if (playedAgo) {
    const divider0 = document.createElement('div');
    divider0.className = 'track-dropdown-divider';
    menu.appendChild(divider0);
    const header = document.createElement('div');
    header.className = 'track-dropdown-header';
    header.innerHTML = `<span class="material-symbols-rounded">history</span>Played: ${playedAgo}`;
    menu.appendChild(header);
  }

  const divider = document.createElement('div');
  divider.className = 'track-dropdown-divider';
  menu.appendChild(divider);

  items.forEach(({ icon, label, action }) => {
    const el = document.createElement('button');
    el.className = 'track-dropdown-item ripple-item';
    el.setAttribute('role', 'menuitem');
    el.innerHTML = `<span class="material-symbols-rounded track-dropdown-icon">${icon}</span><span>${label}</span>`;
    el.addEventListener('click', e => { e.stopPropagation(); _closeTrackDropdown(); action(); });
    menu.appendChild(el);
  });

  document.body.appendChild(menu);

  const rect  = btn.getBoundingClientRect();
  const mh    = items.length * 52 + (playedAgo ? 52 : 0) + 38 + 8; // genre row + possible header
  const mw    = 224;
  let top  = rect.bottom + 6;
  let left = rect.right  - mw;
  if (top + mh > window.innerHeight - 16) top  = rect.top - mh - 6;
  if (left < 8)                            left = 8;
  if (left + mw > window.innerWidth - 8)  left = window.innerWidth - mw - 8;
  menu.style.top  = `${Math.max(top, 8)}px`;
  menu.style.left = `${left}px`;

  // Async genre fetch — patches placeholder text and reveals Explore button
  if (typeof _resolveTrackGenre === 'function') {
    _resolveTrackGenre(trackName, artistName)
      .then(genre => {
        const el = menu.querySelector('.td-genre-val');
        if (el) el.textContent = genre ? ` ${genre}` : ' Unknown';
        // Reveal Explore button only when a real genre is known
        if (genre && genre.toLowerCase() !== 'unknown' && genre !== '—') {
          exploreBtn.style.display = '';
          exploreBtn.addEventListener('click', e => {
            e.stopPropagation();
            _closeTrackDropdown();
            _homeExploreGenre(genre);
          });
        }
      })
      .catch(() => {
        const el = menu.querySelector('.td-genre-val');
        if (el) el.textContent = ' Unknown';
      });
  }

  setTimeout(() => {
    document.addEventListener('click', _closeTrackDropdown, { once: true });
    document.addEventListener('touchstart', _closeTrackDropdown, { once: true, passive: true });
  }, 0);
}

// ── Home-context genre explorer ───────────────────────────────
/**
 * Calls _doExploreGenrePlaylist with a 'home_recent' context hint so
 * the genre playlist is biased toward the user's recent listening style.
 */
function _homeExploreGenre(genre) {
  if (typeof _doExploreGenrePlaylist === 'function') {
    _doExploreGenrePlaylist(genre, { source: 'home_recent' });
  } else {
    navigateTo('genres');
  }
}

function _closeTrackDropdown() {
  const el = document.getElementById('trackDropdownMenu');
  if (!el) return;
  el.classList.add('track-dropdown-leaving');
  setTimeout(() => el.remove(), 180);
}

// ── Relative time ─────────────────────────────────────────────
function _formatRelativeTime(tsMs) {
  if (!tsMs) return '';
  const diff = Date.now() - tsMs;
  const s = Math.floor(diff / 1000);
  if (s < 60)  return 'Just now';
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7)   return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5)   return `${w}w ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}