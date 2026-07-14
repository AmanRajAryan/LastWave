/* ════════════════════════════════════════════════════════════
   discover.js — Discover screen
   A dedicated "new music discovery" feed, separate from the
   existing playlist-generation recommendation engine in app.js.

   Reuses (does not duplicate) shared globals from app.js:
     lfmCall, normaliseTracks, shuffleArray, deduplicateTracks,
     _filterFresh, _markAsSeen, _buildUserTasteProfile,
     _hydrateProfile, _scoreTrack, _itunesFetchArtwork, _isRealImg,
     _preloadImages, showToast, showModal, esc, escAttr,
     openTrackOnYouTube, openTrackOnLastFm, startMixFromTrack,
     _resolveTrackGenre, _refreshTrackArtwork
   and from genres.js:
     _doExploreGenrePlaylist

   ENGINE — signals blended per batch (never a single endpoint):
     weight 4 — similar to recent listening (current mood)
     weight 4 — similar to Loved Tracks (strongest explicit signal)
     weight 3 — similar to all-time top tracks (long-term taste)
     weight 2 — top tracks from similar artists (trusted discovery)
     weight 1 — genre / tag discovery
     weight 1 — global Last.fm popularity (chart.gettoptracks)

   Only TRACKS are ever recommended (no artists/albums/tags).
   Every candidate is tagged with a short "why" reason and is
   excluded if the user already knows it (top/recent tracks) or
   has already been shown this session / within the last 21 days
   (via app.js's existing _filterFresh / _markAsSeen cache).
   ════════════════════════════════════════════════════════════ */

'use strict';

// ── Module state ────────────────────────────────────────────────
let _discInitialized  = false;   // true once the first load has completed
let _discRefilling    = false;   // guards re-entrant pool refills
let _discLoadingMore  = false;   // guards re-entrant scroll-triggered loads
let _discProfile      = null;    // hydrated UserTasteProfile (Sets)
let _discProfileRaw   = null;    // raw profile (proper-case seed arrays)
let _discSeedPools    = null;    // { topArtists:[name], lovedTracks:[{name,artist}] }
let _discCursors      = {};      // rotating cursor per seed list — keeps refills fresh
let _discQueue        = [];      // { track, weight, reason } waiting to be rendered
let _discQueueKeys    = new Set();   // keys already sitting in the queue (avoid re-adding)
let _discShownKeys    = new Set();   // keys already rendered this session (never repeat)
let _discArtistCounts = {};          // session-wide artist counts (diversity cap)
let _discActiveDropdown = null;
const _discEnrichCache  = new Map(); // "name|artist" -> { image, album }

const _DISC_BATCH_SIZE     = 12;
const _DISC_LOW_WATER      = 10;   // background-refill trigger point
const _DISC_MAX_PER_ARTIST = 2;    // session-wide diversity cap

// ══════════════════════════════════════════════════════════════
//  SCREEN INIT — called by nav.js on every visit to 'discover'
// ══════════════════════════════════════════════════════════════
async function screen_discover() {
  window._lwScreenBackHandlers['discover'] = function () {
    if (_discActiveDropdown) { _closeDiscDropdown(); return true; }
    return false; // nothing to intercept — let nav.js pop the history stack
  };

  _setupDiscScroll();
  _setupDiscPullToRefresh();

  if (_discInitialized) {
    // Already loaded once this app session — leave the feed as the user left
    // it (this is a continuous, resumable discovery session, not a reset-
    // on-every-visit list). Just make sure ripples are bound.
    if (typeof _initRipples === 'function') {
      _initRipples(document.querySelector('[data-screen="discover"]'));
    }
    return;
  }

  if (!state.username || !state.apiKey) {
    _discShowState('error', 'Enter your username and API key in Settings first.', 'No credentials found');
    return;
  }

  _discInitialized = true;
  await _discLoadFirstBatch();
}

async function _discLoadFirstBatch() {
  _discShowState('loading');
  try {
    await _discEnsureProfile();
    await _discRefillQueue();
    _discRenderNextBatch(true);
  } catch (e) {
    _discInitialized = false; // allow retry to actually reload
    _discShowState('error', e?.message || 'Could not load recommendations — try again.', 'Something went wrong');
  }
}

function _discRetry() {
  _discInitialized = false;
  screen_discover();
}

// ══════════════════════════════════════════════════════════════
//  STATE HELPERS
// ══════════════════════════════════════════════════════════════
function _discShowState(s, msg, title) {
  const map = { loading: 'discoverSkeleton', error: 'discoverError', empty: 'discoverEmpty', feed: 'discoverList' };
  Object.entries(map).forEach(([key, id]) => {
    document.getElementById(id)?.classList.toggle('hidden', key !== s);
  });
  if (s === 'error') {
    const t = document.getElementById('discoverErrorTitle');
    const m = document.getElementById('discoverErrorMsg');
    if (t) t.textContent = title || 'Something went wrong';
    if (m) m.textContent = msg || 'Please try again.';
  }
}

// ══════════════════════════════════════════════════════════════
//  TASTE PROFILE + SEED POOLS
// ══════════════════════════════════════════════════════════════
async function _discEnsureProfile() {
  _discProfileRaw = await _buildUserTasteProfile();
  _discProfile    = _hydrateProfile(_discProfileRaw);
}

/**
 * Builds the two seed pools not covered by the shared UserTasteProfile:
 *   - proper-cased top artists (profile only stores lowercased names)
 *   - Loved Tracks (explicit "I love this" signal — strongest of all)
 * Cached for the lifetime of the screen session.
 */
async function _discBuildSeedPools() {
  if (_discSeedPools) return _discSeedPools;
  const [artRes, lovedRes] = await Promise.allSettled([
    lfmCall({ method: 'user.gettopartists',  user: state.username, period: 'overall', limit: 30 }),
    lfmCall({ method: 'user.getlovedtracks', user: state.username, limit: 50 }),
  ]);
  const topArtists = artRes.status === 'fulfilled'
    ? (artRes.value.topartists?.artist || []).map(a => a.name)
    : [];
  const lovedTracks = lovedRes.status === 'fulfilled'
    ? normaliseTracks(lovedRes.value.lovedtracks?.track)
    : [];
  _discSeedPools = {
    topArtists:  shuffleArray(topArtists),
    lovedTracks: shuffleArray(lovedTracks),
  };
  return _discSeedPools;
}

/** Take N items from a list, rotating through it so repeated refills
 *  use different seeds before anything repeats — keeps the feed fresh. */
function _discTakeRotating(list, n, cursorKey) {
  if (!list || !list.length) return [];
  let cur = _discCursors[cursorKey] || 0;
  const out = [];
  for (let i = 0; i < Math.min(n, list.length); i++) out.push(list[cur++ % list.length]);
  _discCursors[cursorKey] = cur;
  return out;
}

// ══════════════════════════════════════════════════════════════
//  RECOMMENDATION ENGINE
//  Blends 6 weighted signal buckets in parallel, dedupes, excludes
//  already-known/already-shown tracks, then interleaves ~60/40
//  familiar-style vs. pure discovery for a naturally mixed feed.
// ══════════════════════════════════════════════════════════════
async function _discRefillQueue() {
  if (_discRefilling) return;
  _discRefilling = true;
  try {
    const profile = _discProfile;
    const raw     = _discProfileRaw;
    const pools   = await _discBuildSeedPools();

    const weighted = []; // { track, weight, reason }
    const push = (tracks, weight, reason) => {
      (tracks || []).forEach(t => { if (t?.name && t?.artist) weighted.push({ track: t, weight, reason }); });
    };

    const jobs = [];

    // Bucket — weight 4: similar to recent listening (current mood)
    _discTakeRotating(raw.recentTrackSeeds, 4, 'recent').forEach(seed => {
      jobs.push((async () => {
        try {
          const d = await lfmCall({ method: 'track.getsimilar', track: seed.name, artist: seed.artist, limit: 20 });
          push(normaliseTracks(d.similartracks?.track), 4, 'Similar to your recent listening');
        } catch {}
      })());
    });

    // Bucket — weight 4: similar to Loved Tracks (explicit signal)
    _discTakeRotating(pools.lovedTracks, 3, 'loved').forEach(seed => {
      jobs.push((async () => {
        try {
          const d = await lfmCall({ method: 'track.getsimilar', track: seed.name, artist: seed.artist, limit: 20 });
          push(normaliseTracks(d.similartracks?.track), 4, `Because you loved "${seed.name}"`);
        } catch {}
      })());
    });

    // Bucket — weight 3: similar to all-time top tracks
    _discTakeRotating(raw.topTrackSeeds, 4, 'top').forEach(seed => {
      jobs.push((async () => {
        try {
          const d = await lfmCall({ method: 'track.getsimilar', track: seed.name, artist: seed.artist, limit: 20 });
          push(normaliseTracks(d.similartracks?.track), 3, `Because you like ${seed.artist}`);
        } catch {}
      })());
    });

    // Bucket — weight 2: similar artists → their top tracks
    _discTakeRotating(pools.topArtists, 3, 'artist').forEach(rootArtist => {
      jobs.push((async () => {
        try {
          const simD       = await lfmCall({ method: 'artist.getsimilar', artist: rootArtist, limit: 12 });
          const simArtists = shuffleArray(simD.similarartists?.artist || []).slice(0, 3);
          await Promise.allSettled(simArtists.map(async sa => {
            const page = Math.ceil(Math.random() * 3);
            const d    = await lfmCall({ method: 'artist.gettoptracks', artist: sa.name, limit: 8, page });
            push(normaliseTracks(d.toptracks?.track), 2, 'Similar to your favorite artists');
          }));
        } catch {}
      })());
    });

    // Bucket — weight 1: genre / tag discovery
    _discTakeRotating(raw.topTags, 3, 'tag').forEach(tag => {
      jobs.push((async () => {
        try {
          const page  = Math.floor(Math.random() * 8) + 1;
          const d     = await lfmCall({ method: 'tag.gettoptracks', tag, limit: 20, page });
          const label = tag.replace(/\b\w/g, c => c.toUpperCase());
          const reason = Math.random() < 0.5 ? `Based on your ${label} taste` : `Recommended from ${label}`;
          push(normaliseTracks(d.tracks?.track), 1, reason);
        } catch {}
      })());
    });

    // Bucket — weight 1: global Last.fm popularity (different page each refill)
    jobs.push((async () => {
      try {
        const page = Math.floor(Math.random() * 15) + 1;
        const d    = await lfmCall({ method: 'chart.gettoptracks', limit: 20, page });
        push(normaliseTracks(d.tracks?.track), 1, 'Popular on Last.fm right now');
      } catch {}
    })());

    await Promise.allSettled(jobs);
    if (!weighted.length) return;

    // ── Dedup this round — keep the highest-weight copy + its reason ──
    const bestOf = new Map();
    for (const { track, weight, reason } of weighted) {
      const k  = `${track.name}|${track.artist}`.toLowerCase();
      const ex = bestOf.get(k);
      if (!ex || weight > ex.weight) bestOf.set(k, { track, weight, reason });
    }
    let candidates = [...bestOf.values()];

    // ── This is a DISCOVERY feed — exclude tracks the user already knows ──
    candidates = candidates.filter(({ track }) => {
      const k = `${track.name}|${track.artist}`.toLowerCase();
      return !profile.topTrackKeys.has(k) && !profile.recentTrackKeys.has(k);
    });

    // ── Exclude anything already queued or shown this session ──
    candidates = candidates.filter(({ track }) => {
      const k = `${track.name}|${track.artist}`.toLowerCase();
      return !_discShownKeys.has(k) && !_discQueueKeys.has(k);
    });

    // ── Cross-session freshness (app.js's 21-day seen-track cache) ──
    const freshKeys = new Set(
      _filterFresh(candidates.map(c => c.track)).map(t => `${t.name}|${t.artist}`.toLowerCase())
    );
    candidates = candidates.filter(({ track }) => freshKeys.has(`${track.name}|${track.artist}`.toLowerCase()));

    // ── Score (reuses app.js's artist-familiarity + bucket-confidence model) ──
    let scored = candidates
      .map(({ track, weight, reason }) => ({ track, weight, reason, score: _scoreTrack(track, profile, weight) }))
      .filter(({ score }) => score !== -1);
    scored.sort((a, b) => b.score - a.score);

    // ── Mix familiar-style (weight ≥ 3) with pure discovery (weight ≤ 2) ──
    // Interleaved ~60/40 so hidden gems and popular/familiar picks both
    // surface, rather than one pool dominating the whole feed.
    const familiar  = scored.filter(s => s.weight >= 3);
    const discovery = scored.filter(s => s.weight <= 2);
    const mixed = [];
    let fi = 0, di = 0;
    while (fi < familiar.length || di < discovery.length) {
      for (let i = 0; i < 3 && fi < familiar.length; i++)  mixed.push(familiar[fi++]);
      for (let i = 0; i < 2 && di < discovery.length; i++) mixed.push(discovery[di++]);
    }

    // ── Artist diversity cap (session-wide, not just per-batch) ──
    const accepted = [];
    for (const c of mixed) {
      const ak   = c.track.artist.toLowerCase();
      const used = (_discArtistCounts[ak] || 0) + accepted.filter(x => x.track.artist.toLowerCase() === ak).length;
      if (used >= _DISC_MAX_PER_ARTIST) continue;
      accepted.push(c);
    }

    accepted.forEach(c => {
      _discQueueKeys.add(`${c.track.name}|${c.track.artist}`.toLowerCase());
      _discQueue.push(c);
    });
  } finally {
    _discRefilling = false;
  }
}

// ══════════════════════════════════════════════════════════════
//  RENDER
// ══════════════════════════════════════════════════════════════
function _discRenderNextBatch(isFirst) {
  const list = document.getElementById('discoverList');
  if (!list) return;

  document.getElementById('discTrailingSkel')?.remove();

  const take = _discQueue.splice(0, _DISC_BATCH_SIZE);

  if (isFirst) {
    list.innerHTML = '';
    if (!take.length) { _discShowState('empty'); return; }
    _discShowState('feed');
  } else if (!take.length) {
    // Nothing ready yet — leave the trailing skeleton up; the in-flight
    // background refill (triggered below / by scroll) will call this again.
    _discEnsureTrailingSkeleton();
    return;
  }

  const frag = document.createDocumentFragment();
  take.forEach(({ track, reason }, i) => {
    const k = `${track.name}|${track.artist}`.toLowerCase();
    _discShownKeys.add(k);
    _discQueueKeys.delete(k);
    const ak = track.artist.toLowerCase();
    _discArtistCounts[ak] = (_discArtistCounts[ak] || 0) + 1;

    const el = document.createElement('div');
    el.className = 'disc-card ripple-item';
    el.setAttribute('role', 'listitem');
    el.style.animationDelay = `${Math.min(i, 8) * 0.03}s`;
    el.innerHTML = _discCardInnerHTML(track, reason);

    el.addEventListener('click', e => {
      if (e.target.closest('.disc-card-menu')) return;
      openTrackOnYouTube(track.name, track.artist);
    });
    el.querySelector('.disc-card-menu').addEventListener('click', e => {
      e.stopPropagation();
      _showDiscDropdown(track, e.currentTarget);
    });

    frag.appendChild(el);
  });
  list.appendChild(frag);

  _markAsSeen(take.map(c => c.track));
  _preloadImages(take.filter(c => c.track.image).map(c => c.track));
  _discEnrichBatch(take).catch(() => {});

  if (typeof _initRipples === 'function') {
    _initRipples(document.querySelector('[data-screen="discover"]'));
  }

  // Keep the pool topped up ahead of the user reaching the bottom.
  if (_discQueue.length < _DISC_LOW_WATER && !_discRefilling) {
    _discEnsureTrailingSkeleton();
    _discRefillQueue().catch(() => {});
  }
}

function _discCardInnerHTML(track, reason) {
  const hasImg = track.image && track.image.trim();
  const k      = escAttr(`${track.name}|${track.artist}`.toLowerCase());
  return `
    <div class="disc-card-art-wrap" data-key="${k}">
      ${hasImg ? `<img src="${esc(track.image)}" alt="" class="disc-card-art" loading="lazy" decoding="async" style="opacity:0;transition:opacity 0.25s ease" onload="_discImgLoad(this)" onerror="_discImgError(this)">` : ''}
      <span class="material-symbols-rounded disc-card-art-fallback"${hasImg ? '' : ' style="display:flex"'}>music_note</span>
    </div>
    <div class="disc-card-info">
      <div class="disc-card-title">${esc(track.name)}</div>
      <div class="disc-card-artist">${esc(track.artist)}</div>
      <div class="disc-card-reason"><span class="material-symbols-rounded">auto_awesome</span><span>${esc(reason)}</span></div>
    </div>
    <button class="disc-card-menu" aria-label="More options" aria-haspopup="true">
      <span class="material-symbols-rounded">more_vert</span>
    </button>`;
}

function _discImgLoad(img) {
  img.style.opacity = '1';
  const fb = img.closest('.disc-card-art-wrap')?.querySelector('.disc-card-art-fallback');
  if (fb) fb.style.display = 'none';
}
function _discImgError(img) {
  if (img._retried) { img.style.display = 'none'; return; }
  img._retried = true;
  const src = img.src;
  img.src = '';
  setTimeout(() => { if (src) img.src = src; else img.style.display = 'none'; }, 400);
}

function _discEnsureTrailingSkeleton() {
  const list = document.getElementById('discoverList');
  if (!list || document.getElementById('discTrailingSkel')) return;
  const row = document.createElement('div');
  row.id = 'discTrailingSkel';
  row.className = 'disc-trailing-skel';
  row.innerHTML = `
    <div class="disc-skel-art"></div>
    <div class="disc-skel-lines">
      <div class="disc-skel-line disc-skel-title"></div>
      <div class="disc-skel-line disc-skel-artist"></div>
    </div>`;
  list.appendChild(row);
}

/**
 * Progressive enrichment — fetches album title (never returned by the
 * similar-tracks / tag / chart endpoints) and, only when still missing,
 * artwork. Runs after the card is already on screen so the feed never
 * blocks on this; cards quietly gain an album line / cover when ready.
 */
async function _discEnrichBatch(take) {
  const BATCH = 5;
  for (let i = 0; i < take.length; i += BATCH) {
    const slice = take.slice(i, i + BATCH);
    await Promise.allSettled(slice.map(async ({ track }) => {
      try {
        const info = await _discEnrichTrack(track);
        const key  = `${track.name}|${track.artist}`.toLowerCase();
        const wrap = document.querySelector(`.disc-card-art-wrap[data-key="${CSS.escape(key)}"]`);
        if (!wrap) return;
        const card = wrap.closest('.disc-card');

        if (info.album && card && !card.querySelector('.disc-card-album')) {
          const albumEl = document.createElement('div');
          albumEl.className = 'disc-card-album';
          albumEl.textContent = info.album;
          card.querySelector('.disc-card-reason')?.insertAdjacentElement('beforebegin', albumEl);
        }

        if (info.image && (!track.image || !track.image.trim())) {
          track.image = info.image;
          let img = wrap.querySelector('.disc-card-art');
          const fb = wrap.querySelector('.disc-card-art-fallback');
          if (!img) {
            img = document.createElement('img');
            img.className = 'disc-card-art';
            img.alt = ''; img.loading = 'lazy'; img.decoding = 'async';
            img.style.cssText = 'opacity:0;transition:opacity 0.25s ease';
            wrap.insertBefore(img, fb);
          }
          img.onload  = () => { img.style.opacity = '1'; if (fb) fb.style.display = 'none'; };
          img.onerror = () => { img.style.display = 'none'; };
          img.src = info.image;
        }
      } catch {}
    }));
  }
}

async function _discEnrichTrack(track) {
  const key = `${track.name}|${track.artist}`.toLowerCase();
  if (_discEnrichCache.has(key)) return _discEnrichCache.get(key);

  const result = { image: track.image || '', album: '' };
  try {
    const data  = await lfmCall({ method: 'track.getInfo', track: track.name, artist: track.artist, autocorrect: 1 });
    const album = data?.track?.album;
    if (album?.title) result.album = album.title;
    if (!result.image && album?.image) {
      const img = album.image.find(im => im.size === 'extralarge' && _isRealImg(im['#text']))
               || album.image.find(im => im.size === 'large'      && _isRealImg(im['#text']))
               || album.image.find(im => _isRealImg(im['#text']));
      if (img) result.image = img['#text'];
    }
  } catch { /* network / API error — fall through to iTunes for art only */ }

  if (!result.image) {
    try { result.image = await _itunesFetchArtwork(track.name, track.artist, 'track'); } catch {}
  }

  _discEnrichCache.set(key, result);
  return result;
}

// ══════════════════════════════════════════════════════════════
//  INFINITE SCROLL
//  The scroll host is the wrapper nav.js creates for this screen
//  ([data-screen="discover"]) — same pattern as search/genres,
//  where .page-scroll fills that wrapper rather than scrolling itself.
// ══════════════════════════════════════════════════════════════
function _discGetScrollHost() {
  return document.querySelector('[data-screen="discover"]');
}

function _setupDiscScroll() {
  const host = _discGetScrollHost();
  if (!host || host._discScrollBound) return;
  host._discScrollBound = true;

  host.addEventListener('scroll', () => {
    if (_discLoadingMore || !_discInitialized) return;
    const threshold = 600;
    if (host.scrollTop + host.clientHeight >= host.scrollHeight - threshold) {
      _discLoadingMore = true;
      (async () => {
        if (_discQueue.length < _DISC_BATCH_SIZE && !_discRefilling) {
          _discEnsureTrailingSkeleton();
          await _discRefillQueue().catch(() => {});
        }
        _discRenderNextBatch(false);
      })().finally(() => { _discLoadingMore = false; });
    }
  }, { passive: true });
}

// ══════════════════════════════════════════════════════════════
//  PULL TO REFRESH — mirrors home.js's gesture handling exactly,
//  scoped to the Discover scroll host. Rebuilds the feed from
//  scratch (fresh queue + session dedupe reset), still respecting
//  the cross-session 21-day seen-track cache.
// ══════════════════════════════════════════════════════════════
let _discPtr = { startY: 0, active: false, indicator: null, refreshing: false };

function _setupDiscPullToRefresh() {
  const host = _discGetScrollHost();
  if (!host || host._ptrBound) return;
  host._ptrBound = true;

  if (!_discPtr.indicator) {
    const ind = document.createElement('div');
    ind.id = 'discPtrIndicator';
    ind.style.cssText = [
      'position:fixed', 'top:64px', 'left:50%',
      'transform:translateX(-50%) translateY(-72px)', 'opacity:0',
      'width:32px', 'height:32px', 'border-radius:50%',
      'background:var(--md-surface-container-high)',
      'box-shadow:0 2px 10px rgba(0,0,0,0.22)',
      'display:flex', 'align-items:center', 'justify-content:center',
      'z-index:999', 'pointer-events:none',
    ].join(';');
    ind.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;"><span class="ptr-spinner material-symbols-rounded" style="font-size:18px;color:var(--md-primary)">refresh</span></div>';
    document.body.appendChild(ind);
    _discPtr.indicator = ind;
  }

  const ind = _discPtr.indicator;
  const ic  = () => ind.querySelector('.ptr-spinner');
  const MAX_TRAVEL = 56;

  const ptrTrack = (deltaY) => {
    const travel = deltaY <= 80 ? Math.min(deltaY * 0.55, MAX_TRAVEL) : Math.min(44 + (deltaY - 80) * 0.25, MAX_TRAVEL);
    ind.style.transition = 'none';
    ind.style.transform  = `translateX(-50%) translateY(${travel - 72}px)`;
    ind.style.opacity    = Math.min(travel / 44, 1).toFixed(2);
  };
  const ptrSnap = () => {
    ind.style.transition = 'transform 0.35s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.15s ease';
    ind.style.transform  = 'translateX(-50%) translateY(4px)';
    ind.style.opacity    = '1';
    const s = ic();
    if (s) { s.style.transition = 'none'; s.style.transform = ''; s.style.animation = ''; }
  };
  const ptrHide = () => {
    ind.style.transition = 'transform 0.35s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.25s ease';
    ind.style.transform  = 'translateX(-50%) translateY(-72px)';
    ind.style.opacity    = '0';
    const s = ic();
    if (s) { s.classList.remove('ptr-spinning'); s.style.animation = ''; s.style.transform = ''; }
  };

  host.addEventListener('touchstart', (e) => {
    if (_discPtr.refreshing) return;
    if (host.scrollTop === 0) {
      _discPtr.startY = e.touches[0].clientY;
      _discPtr.active = true;
      const s = ic();
      if (s) { s.style.transform = ''; s.style.animation = ''; void s.offsetWidth; s.classList.add('ptr-spinning'); }
    }
  }, { passive: true });

  host.addEventListener('touchmove', (e) => {
    if (!_discPtr.active || _discPtr.refreshing) return;
    const delta = e.touches[0].clientY - _discPtr.startY;
    if (delta <= 0) { _discPtr.active = false; ptrHide(); return; }
    ptrTrack(delta);
  }, { passive: true });

  host.addEventListener('touchend', (e) => {
    if (!_discPtr.active) return;
    const delta = e.changedTouches[0].clientY - _discPtr.startY;
    _discPtr.active = false;
    if (delta >= 70 && host.scrollTop === 0 && state.username && !_discPtr.refreshing) {
      _discPtr.refreshing = true;
      ptrSnap();
      _discFullRefresh().finally(() => { _discPtr.refreshing = false; ptrHide(); });
    } else {
      ptrHide();
    }
  }, { passive: true });

  host.addEventListener('touchcancel', () => {
    _discPtr.active = false;
    if (!_discPtr.refreshing) ptrHide();
  }, { passive: true });
}

async function _discFullRefresh() {
  _discQueue = []; _discQueueKeys = new Set(); _discShownKeys = new Set(); _discArtistCounts = {};
  document.getElementById('discTrailingSkel')?.remove();
  try {
    await _discRefillQueue();
    _discRenderNextBatch(true);
    if (_discQueue.length || document.querySelectorAll('#discoverList .disc-card').length) {
      showToast('Feed refreshed \u2713', 'success');
    }
  } catch (e) {
    showToast(e?.message || 'Could not refresh — try again', 'error');
  }
}

// ══════════════════════════════════════════════════════════════
//  3-DOT DROPDOWN MENU — same .track-dropdown-menu CSS + pattern
//  used by home/search/genres. Appended to <body>, positioned
//  relative to the tapped button, dismissed on outside tap.
// ══════════════════════════════════════════════════════════════
function _showDiscDropdown(track, anchorBtn) {
  _closeDiscDropdown();

  const menuItems = [
    { icon: 'queue_music',   label: 'Start Mix from this', fn: () => startMixFromTrack(track.name, track.artist) },
    { icon: 'open_in_new',   label: 'Open in Last.fm',     fn: () => openTrackOnLastFm(track.name, track.artist) },
    { icon: 'smart_display', label: 'Play on YouTube',     fn: () => openTrackOnYouTube(track.name, track.artist) },
    { icon: 'image_search',  label: 'Refresh Cover Art',   fn: async () => {
        showToast('Refreshing cover art\u2026');
        const url = typeof _refreshTrackArtwork === 'function' ? await _refreshTrackArtwork(track.name, track.artist) : '';
        if (url) {
          track.image = url;
          const key  = `${track.name}|${track.artist}`.toLowerCase();
          const wrap = document.querySelector(`.disc-card-art-wrap[data-key="${CSS.escape(key)}"]`);
          const img  = wrap?.querySelector('.disc-card-art');
          if (img) img.src = url;
          showToast('Cover art updated \u2713', 'success');
        } else {
          showToast('Cover art not available', 'error');
        }
      }
    },
  ];

  const menuEl = document.createElement('div');
  menuEl.className = 'track-dropdown-menu';
  menuEl.setAttribute('role', 'menu');

  const genreRow = document.createElement('div');
  genreRow.className = 'track-dropdown-genre';
  genreRow.innerHTML = `<span class="material-symbols-rounded">sell</span><span><span class="track-dropdown-genre-label">Genre:</span><span class="td-genre-val"> \u2026</span></span>`;
  menuEl.appendChild(genreRow);

  const exploreBtn = document.createElement('button');
  exploreBtn.className = 'track-dropdown-item track-dropdown-explore';
  exploreBtn.setAttribute('role', 'menuitem');
  exploreBtn.style.display = 'none';
  exploreBtn.innerHTML = `<span class="material-symbols-rounded track-dropdown-icon" style="color:var(--md-primary)">bolt</span><span style="color:var(--md-primary);font-weight:500">Explore this genre</span>`;
  menuEl.appendChild(exploreBtn);

  const divider = document.createElement('div');
  divider.className = 'track-dropdown-divider';
  menuEl.appendChild(divider);

  if (typeof _resolveTrackGenre === 'function') {
    _resolveTrackGenre(track.name, track.artist).then(genre => {
      const el = menuEl.querySelector('.td-genre-val');
      if (el) el.textContent = genre ? ` ${genre}` : ' Unknown';
      if (genre && genre.toLowerCase() !== 'unknown' && genre !== '\u2014') {
        const primaryGenre = genre.split(',')[0].trim();
        exploreBtn.style.display = '';
        exploreBtn.addEventListener('click', e => {
          e.stopPropagation();
          _closeDiscDropdown();
          if (typeof _doExploreGenrePlaylist === 'function') _doExploreGenrePlaylist(primaryGenre, { source: 'discover' });
          else navigateTo('genres');
        });
      }
    }).catch(() => {
      const el = menuEl.querySelector('.td-genre-val');
      if (el) el.textContent = ' Unknown';
    });
  }

  menuItems.forEach(mi => {
    const btn = document.createElement('button');
    btn.className = 'track-dropdown-item';
    btn.setAttribute('role', 'menuitem');
    btn.innerHTML = `<span class="material-symbols-rounded track-dropdown-icon">${mi.icon}</span><span>${esc(mi.label)}</span>`;
    btn.addEventListener('click', e => { e.stopPropagation(); _closeDiscDropdown(); mi.fn(); });
    menuEl.appendChild(btn);
  });

  document.body.appendChild(menuEl);
  _discActiveDropdown = menuEl;
  _discPositionDropdown(menuEl, anchorBtn);

  function _outside(e) {
    if (!menuEl.contains(e.target)) {
      _closeDiscDropdown();
      document.removeEventListener('click', _outside, { capture: true });
      document.removeEventListener('touchstart', _outside, { capture: true });
    }
  }
  setTimeout(() => {
    document.addEventListener('click', _outside, { capture: true });
    document.addEventListener('touchstart', _outside, { capture: true, passive: true });
    menuEl._outsideFn = _outside;
  }, 0);
}

function _discPositionDropdown(menuEl, anchorBtn) {
  const doPos = () => {
    const rect  = anchorBtn.getBoundingClientRect();
    const menuW = 224;
    const menuH = menuEl.offsetHeight || 220;
    const vw = window.innerWidth, vh = window.innerHeight;
    let top = rect.bottom + 6, left = rect.right - menuW;
    if (left < 8) left = 8;
    if (left + menuW > vw - 8) left = vw - menuW - 8;
    if (top + menuH > vh - 8) top = rect.top - menuH - 6;
    menuEl.style.top  = `${Math.max(Math.round(top), 8)}px`;
    menuEl.style.left = `${Math.round(left)}px`;
  };
  doPos();
  if (!menuEl.offsetHeight) requestAnimationFrame(doPos);
}

function _closeDiscDropdown() {
  if (!_discActiveDropdown) return;
  const el = _discActiveDropdown;
  _discActiveDropdown = null;
  if (el._outsideFn) {
    document.removeEventListener('click', el._outsideFn, { capture: true });
    document.removeEventListener('touchstart', el._outsideFn, { capture: true });
  }
  el.classList.add('track-dropdown-leaving');
  el.addEventListener('animationend', () => el.remove(), { once: true });
  setTimeout(() => { if (el.parentNode) el.remove(); }, 250);
}
