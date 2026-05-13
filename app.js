/**
 * Lossless Core — app.js
 * Clean engine: local file playback, module bridge, am-lyrics sync.
 */

/* ─────────────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────────────── */
const $ = (id) => document.getElementById(id);

function fmtMs(ms) {
  if (!ms || isNaN(ms) || ms < 0) return '0:00';
  const s  = Math.floor(ms / 1000);
  const m  = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ─────────────────────────────────────────────────────
   TRACK  { title, artist, album, art, duration, src, quality, isrc }
───────────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────────
   CORE
───────────────────────────────────────────────────── */
class LosslessCore {
  constructor() {
    /* playback */
    this.audio      = new Audio();
    this.audio.crossOrigin = 'anonymous';
    this.audio.preload     = 'auto';

    /* state */
    this.queue      = [];
    this.idx        = 0;
    this.playing    = false;
    this.shuffle    = false;
    this.repeat     = 'none';   // none | all | one
    this.curMs      = 0;
    this.durMs      = 0;

    /* lyrics */
    this.lyricsMode = 'none';   // none | synced | plain
    this.lyricsOpen = false;
    this._lyricsRaf = null;
    this._lyricsStart   = 0;   // audio time in ms at last sync
    this._lyricsSystem  = 0;   // Date.now() at last sync

    /* module */
    this.mod   = null;
    this._cb   = this._emptyCb();

    /* seek drag */
    this._dragging  = false;
    this._dragRatio = 0;

    /* toast */
    this._toastTimer = null;

    this._wire();
    this._registerSW();
    window.core = this;
  }

  /* ── Wire all DOM events ────────────────────────── */
  _wire() {
    const a = this.audio;

    a.addEventListener('timeupdate', () => {
      if (this._dragging) return;
      this.curMs = a.currentTime * 1000;
      this._updateProgress();
      this._lyricsStart  = this.curMs;
      this._lyricsSystem = Date.now();
    });

    a.addEventListener('loadedmetadata', () => {
      this.durMs = a.duration * 1000;
      this._updateProgress();
    });

    a.addEventListener('play',  () => this._setPlaying(true));
    a.addEventListener('pause', () => this._setPlaying(false));

    a.addEventListener('ended', () => {
      if (this.repeat === 'one') {
        a.currentTime = 0; a.play();
      } else {
        this._autoNext();
      }
    });

    a.addEventListener('error', () => {
      this.toast('Audio error — unsupported format or bad URL');
    });

    /* controls */
    $('playBtn').onclick   = () => this.toggle();
    $('prevBtn').onclick   = () => this.prev();
    $('nextBtn').onclick   = () => this.next();
    $('shuffleBtn').onclick = () => this._toggleShuffle();
    $('repeatBtn').onclick  = () => this._cycleRepeat();
    $('vol').oninput        = (e) => this._setVol(e.target.value);
    $('favBtn').onclick     = () => $('favBtn').classList.toggle('active');

    /* file open */
    $('openBtn').onclick   = () => $('fileInput').click();
    $('fileInput').onchange = (e) => { this._loadFiles(e.target.files); e.target.value=''; };

    /* module */
    $('moduleBtn').onclick  = () => $('modInput').click();
    $('modInput').onchange  = (e) => { this._loadModule(e.target.files[0]); e.target.value=''; };

    /* lyrics */
    $('lyricsBtn').onclick    = () => this._openLyrics();
    $('closeLyricsBtn').onclick = () => this._closeLyrics();

    /* queue */
    $('queueBtn').onclick      = () => this._openQueue();
    $('closeQueueBtn').onclick  = () => this._closeQueue();

    /* scrim closes everything */
    $('scrim').onclick = () => { this._closeLyrics(); this._closeQueue(); };

    /* seekbar */
    this._wireSeek();

    /* keyboard */
    this._wireKeys();

    /* drag & drop files */
    this._wireDrop();

    /* media session */
    this._wireMediaSession();
  }

  /* ── Local File Import ──────────────────────────── */
  async _loadFiles(fileList) {
    if (!fileList?.length) return;
    const files = Array.from(fileList);
    const tracks = [];

    this.toast(`Reading ${files.length} file${files.length>1?'s':''}…`);

    for (const file of files) {
      const track = await this._readFileMeta(file);
      tracks.push(track);
    }

    this.queue = tracks;
    this.idx   = 0;
    this._renderQueue();
    this._loadTrack(0);
    $('source-pill').textContent = 'Local Files';
  }

  _readFileMeta(file) {
    return new Promise((resolve) => {
      /* Blob URL for playback */
      const src = URL.createObjectURL(file);

      /* Quality label from file type */
      const ext  = file.name.split('.').pop().toUpperCase();
      const qual = file.type === 'audio/flac' || ext === 'FLAC' ? `FLAC`
                 : file.type === 'audio/wav'  || ext === 'WAV'  ? `WAV`
                 : file.type === 'audio/aiff' || ext === 'AIFF' ? `AIFF`
                 : ext;

      /* Base track from filename */
      const base = file.name.replace(/\.[^.]+$/, '');
      const baseTrack = {
        title:   base,
        artist:  'Unknown Artist',
        album:   '',
        art:     null,
        src,
        quality: qual,
        isrc:    null,
        _artBlob: null,
      };

      /* Try ID3 tags via jsmediatags */
      if (window.jsmediatags) {
        window.jsmediatags.read(file, {
          onSuccess(tag) {
            const t = tag.tags;
            baseTrack.title  = t.title  || base;
            baseTrack.artist = t.artist || 'Unknown Artist';
            baseTrack.album  = t.album  || '';
            if (t.picture) {
              try {
                const byteArr = new Uint8Array(t.picture.data);
                const blob    = new Blob([byteArr], { type: t.picture.format });
                baseTrack.art = URL.createObjectURL(blob);
                baseTrack._artBlob = baseTrack.art;
              } catch {}
            }
            resolve(baseTrack);
          },
          onError() { resolve(baseTrack); },
        });
      } else {
        resolve(baseTrack);
      }
    });
  }

  /* ── Load a track from the queue ────────────────── */
  _loadTrack(index) {
    if (!this.queue.length) return;
    this.idx  = Math.max(0, Math.min(index, this.queue.length - 1));
    const t   = this.queue[this.idx];
    this.curMs = 0;
    this.durMs = 0;

    /* Update audio */
    this.audio.src = t.src || '';
    this.audio.load();
    if (this.playing) this.audio.play().catch(() => {});

    /* Update UI */
    this._updateMeta(t);
    this._setQueueIndex(this.idx);

    /* Lyrics: start am-lyrics sync if we have a title+artist */
    if (t.title && t.artist) {
      this._startLyricsSync(t);
    } else {
      this._stopLyrics();
    }

    /* Media session */
    this._updateMediaSession(t);
  }

  /* ── UI: meta & art ─────────────────────────────── */
  _updateMeta(t) {
    $('title').textContent  = t.title  || 'Unknown';
    $('artist').textContent = t.artist || '';
    $('quality-label').textContent = t.quality || '';
    $('lyr-title').textContent  = t.title  || '';
    $('lyr-artist').textContent = t.artist || '';

    /* art */
    const artEl = $('art');
    const bgEl  = $('bg-art');
    const lyrArt = $('lyr-art');
    const empty = $('art-empty');

    artEl.classList.remove('loaded');

    if (t.art) {
      artEl.onload  = () => { artEl.classList.add('loaded'); empty.style.display='none'; };
      artEl.onerror = () => { empty.style.display='flex'; };
      artEl.src = t.art;
      bgEl.src  = t.art;
      bgEl.classList.add('visible');
      lyrArt.src = t.art;
    } else {
      artEl.src    = '';
      bgEl.src     = '';
      bgEl.classList.remove('visible');
      lyrArt.src   = '';
      empty.style.display = 'flex';
    }
  }

  /* ── Playback controls ──────────────────────────── */
  toggle() {
    if (!this.queue.length && !this.mod) return;
    if (this.audio.src) {
      this.playing ? this.audio.pause() : this.audio.play().catch(()=>{});
    } else {
      /* Module-controlled audio */
      this.playing = !this.playing;
      this._setPlaying(this.playing);
      if (this.playing) {
        this._cb.play.forEach(fn => { try{fn();}catch{} });
        this.mod?.play?.();
      } else {
        this._cb.pause.forEach(fn => { try{fn();}catch{} });
        this.mod?.pause?.();
      }
    }
  }

  next() {
    if (this._cb.next) { try{this._cb.next();}catch{} return; }
    if (this.mod?.next) { this.mod.next(); return; }
    this._autoNext();
  }

  prev() {
    if (this.curMs > 3000) { this._seek(0); return; }
    if (this._cb.prev) { try{this._cb.prev();}catch{} return; }
    if (this.mod?.prev) { this.mod.prev(); return; }
    const i = this.shuffle
      ? Math.floor(Math.random() * this.queue.length)
      : (this.idx - 1 + this.queue.length) % this.queue.length;
    this._loadTrack(i);
  }

  _autoNext() {
    if (!this.queue.length) return;
    let i;
    if (this.shuffle) {
      i = Math.floor(Math.random() * this.queue.length);
    } else {
      i = this.idx + 1;
      if (i >= this.queue.length) {
        if (this.repeat === 'all') { i = 0; }
        else { this._setPlaying(false); return; }
      }
    }
    this._loadTrack(i);
  }

  _setPlaying(p) {
    this.playing = p;
    $('iconPlay').classList.toggle('hidden', p);
    $('iconPause').classList.toggle('hidden', !p);
    $('art-card').classList.toggle('playing', p);

    if (p) {
      this._startLyricsRaf();
    } else {
      this._stopLyricsRaf();
    }

    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = p ? 'playing' : 'paused';
    }
  }

  _toggleShuffle() {
    this.shuffle = !this.shuffle;
    $('shuffleBtn').classList.toggle('active', this.shuffle);
    if (this._cb.shuffle) try{this._cb.shuffle(this.shuffle);}catch{}
    this.toast(this.shuffle ? 'Shuffle on' : 'Shuffle off');
  }

  _cycleRepeat() {
    const modes = ['none','all','one'];
    this.repeat = modes[(modes.indexOf(this.repeat)+1) % modes.length];
    $('repeatBtn').classList.toggle('active', this.repeat !== 'none');
    $('iconRepeat').classList.toggle('hidden', this.repeat === 'one');
    $('iconRepeatOne').classList.toggle('hidden', this.repeat !== 'one');
    if (this._cb.repeat) try{this._cb.repeat(this.repeat);}catch{}
    this.toast({ none:'Repeat off', all:'Repeat all', one:'Repeat one' }[this.repeat]);
  }

  _setVol(v) {
    this.audio.volume = Math.max(0, Math.min(1, parseFloat(v)));
    if (this._cb.volume) try{this._cb.volume(this.audio.volume);}catch{}
  }

  /* ── Seek ───────────────────────────────────────── */
  _seek(ms) {
    ms = Math.max(0, Math.min(ms, this.durMs));
    this.curMs = ms;
    if (this.audio.src && this.durMs > 0) this.audio.currentTime = ms / 1000;
    this._updateProgress();
    this._cb.seek.forEach(fn => { try{fn(ms);}catch{} });
    this.mod?.seek?.(ms);
    /* Resync lyrics rAF clock */
    this._lyricsStart  = ms;
    this._lyricsSystem = Date.now();
  }

  _wireSeek() {
    const bar = $('seekbar');
    const ratio = (e) => {
      const touch = e.touches?.[0] ?? e;
      const r     = bar.getBoundingClientRect();
      return Math.max(0, Math.min(1, (touch.clientX - r.left) / r.width));
    };
    const start = (e) => {
      this._dragging  = true;
      const r = ratio(e);
      this._dragRatio = r;
      this._setFill(r);
      $('t-cur').textContent = fmtMs(r * this.durMs);
    };
    const move = (e) => {
      if (!this._dragging) return;
      const r = ratio(e);
      this._dragRatio = r;
      this._setFill(r);
      $('t-cur').textContent = fmtMs(r * this.durMs);
    };
    const end = () => {
      if (!this._dragging) return;
      this._dragging = false;
      this._seek(this._dragRatio * this.durMs);
    };
    bar.addEventListener('mousedown', start);
    bar.addEventListener('touchstart', start, { passive: true });
    document.addEventListener('mousemove', move);
    document.addEventListener('touchmove', move, { passive: true });
    document.addEventListener('mouseup', end);
    document.addEventListener('touchend', end);
    bar.addEventListener('keydown', (e) => {
      if (e.key==='ArrowRight') this._seek(this.curMs+5000);
      if (e.key==='ArrowLeft')  this._seek(this.curMs-5000);
    });
  }

  _setFill(ratio) {
    const pct = `${ratio*100}%`;
    $('seek-fill').style.width = pct;
    $('seek-thumb').style.left = pct;
    const bar = $('seekbar');
    bar.setAttribute('aria-valuenow', Math.round(ratio*100));
  }

  _updateProgress() {
    if (this._dragging || this.durMs <= 0) return;
    const ratio = this.curMs / this.durMs;
    this._setFill(ratio);
    $('t-cur').textContent = fmtMs(this.curMs);
    $('t-tot').textContent = fmtMs(this.durMs);

    if ('mediaSession' in navigator && navigator.mediaSession.setPositionState) {
      try {
        navigator.mediaSession.setPositionState({
          duration:     this.durMs / 1000,
          playbackRate: this.audio.playbackRate ?? 1,
          position:     Math.min(this.curMs / 1000, this.durMs / 1000),
        });
      } catch {}
    }
  }

  /* ── am-lyrics sync ─────────────────────────────── */
  _startLyricsSync(t) {
    const el = $('amLyrics');
    el.setAttribute('song-title',    t.title   ?? '');
    el.setAttribute('song-artist',   t.artist  ?? '');
    el.setAttribute('song-album',    t.album   ?? '');
    el.setAttribute('song-duration', t.duration ?? this.durMs ?? 0);
    el.setAttribute('query',         `${t.title} ${t.artist}`);
    if (t.isrc)    el.setAttribute('isrc',     t.isrc);
    if (t.musicId) el.setAttribute('music-id', t.musicId);
    el.setAttribute('current-time', '0');
    this.lyricsMode = 'synced';
    $('lyrics-plain').style.display = 'none';
  }

  _stopLyrics() {
    const el = $('amLyrics');
    el.setAttribute('current-time', '-1');
    this.lyricsMode = 'none';
  }

  _startLyricsRaf() {
    this._stopLyricsRaf();
    if (this.lyricsMode !== 'synced') return;
    this._lyricsStart  = this.audio.currentTime * 1000;
    this._lyricsSystem = Date.now();
    const tick = () => {
      const elapsed = Date.now() - this._lyricsSystem;
      const ms      = this._lyricsStart + elapsed;
      $('amLyrics').setAttribute('current-time', ms);
      this._lyricsRaf = requestAnimationFrame(tick);
    };
    this._lyricsRaf = requestAnimationFrame(tick);
  }

  _stopLyricsRaf() {
    if (this._lyricsRaf) {
      cancelAnimationFrame(this._lyricsRaf);
      this._lyricsRaf = null;
    }
  }

  /* ── Lyrics sheet ───────────────────────────────── */
  _openLyrics() {
    this.lyricsOpen = true;
    $('lyrics-sheet').classList.add('open');
    $('lyrics-sheet').setAttribute('aria-hidden', 'false');
    $('scrim').classList.add('active');
    if (this.playing) this._startLyricsRaf();
  }

  _closeLyrics() {
    this.lyricsOpen = false;
    $('lyrics-sheet').classList.remove('open');
    $('lyrics-sheet').setAttribute('aria-hidden', 'true');
    if (!this._isQueueOpen()) $('scrim').classList.remove('active');
    this._stopLyricsRaf();
  }

  /* ── Queue drawer ───────────────────────────────── */
  _openQueue() {
    $('queue-drawer').classList.add('open');
    $('queue-drawer').setAttribute('aria-hidden', 'false');
    $('scrim').classList.add('active');
  }

  _closeQueue() {
    $('queue-drawer').classList.remove('open');
    $('queue-drawer').setAttribute('aria-hidden', 'true');
    if (!this.lyricsOpen) $('scrim').classList.remove('active');
  }

  _isQueueOpen() {
    return $('queue-drawer').classList.contains('open');
  }

  _setQueueIndex(i) {
    this.idx = i;
    this._renderQueue();
  }

  _renderQueue() {
    const list = $('queue-list');
    if (!this.queue.length) {
      list.innerHTML = '<div class="q-empty">Queue is empty</div>';
      return;
    }
    list.innerHTML = this.queue.map((t, i) => `
      <div class="q-item${i===this.idx?' active':''}" role="listitem"
           onclick="core._queueTap(${i})" tabindex="0"
           aria-label="${esc(t.title)} by ${esc(t.artist)}">
        <div class="q-art">${t.art ? `<img src="${esc(t.art)}" alt="" loading="lazy">` : ''}</div>
        <div class="q-info">
          <div class="q-title">${esc(t.title||'Unknown')}</div>
          <div class="q-sub">${esc(t.artist||'')}</div>
        </div>
        ${t.duration ? `<div class="q-dur">${fmtMs(t.duration)}</div>` : ''}
      </div>
    `).join('');
  }

  _queueTap(i) {
    if (this._cb.playIndex) { try{this._cb.playIndex(i);}catch{} }
    else this._loadTrack(i);
    this._closeQueue();
  }

  /* ── Drag & drop ────────────────────────────────── */
  _wireDrop() {
    const drop = $('drop-overlay');
    document.addEventListener('dragenter', (e) => {
      if ([...e.dataTransfer.items].some(i => i.kind==='file')) {
        e.preventDefault();
        drop.classList.add('active');
      }
    });
    document.addEventListener('dragover', (e) => { e.preventDefault(); });
    document.addEventListener('dragleave', (e) => {
      if (e.relatedTarget === null || !document.contains(e.relatedTarget)) {
        drop.classList.remove('active');
      }
    });
    document.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('active');
      const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('audio/') || /\.(flac|wav|aiff?|dsf|dff|ogg|opus|mp3|m4a|aac)$/i.test(f.name));
      if (files.length) this._loadFiles(files);
    });
  }

  /* ── Keyboard ───────────────────────────────────── */
  _wireKeys() {
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName==='INPUT' || e.target.tagName==='TEXTAREA') return;
      switch (e.code) {
        case 'Space':      e.preventDefault(); this.toggle(); break;
        case 'ArrowRight': e.preventDefault(); this._seek(this.curMs + 10000); break;
        case 'ArrowLeft':  e.preventDefault(); this._seek(this.curMs - 10000); break;
        case 'ArrowUp':    e.preventDefault(); this.audio.volume = Math.min(1, this.audio.volume+0.05); $('vol').value=this.audio.volume; break;
        case 'ArrowDown':  e.preventDefault(); this.audio.volume = Math.max(0, this.audio.volume-0.05); $('vol').value=this.audio.volume; break;
        case 'KeyN':  this.next(); break;
        case 'KeyP':  this.prev(); break;
        case 'KeyL':  this.lyricsOpen ? this._closeLyrics() : this._openLyrics(); break;
        case 'KeyQ':  this._isQueueOpen() ? this._closeQueue() : this._openQueue(); break;
        case 'KeyS':  this._toggleShuffle(); break;
        case 'KeyR':  this._cycleRepeat(); break;
        case 'Escape': this._closeLyrics(); this._closeQueue(); break;
      }
    });
  }

  /* ── Media Session ──────────────────────────────── */
  _wireMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler('play',          () => this.toggle());
    ms.setActionHandler('pause',         () => this.toggle());
    ms.setActionHandler('nexttrack',     () => this.next());
    ms.setActionHandler('previoustrack', () => this.prev());
    ms.setActionHandler('stop',          () => { this.audio.pause(); this._seek(0); });
    ms.setActionHandler('seekto',        (d) => { if(d.seekTime!=null) this._seek(d.seekTime*1000); });
    ms.setActionHandler('seekforward',   (d) => this._seek(this.curMs+(d.seekOffset??10)*1000));
    ms.setActionHandler('seekbackward',  (d) => this._seek(this.curMs-(d.seekOffset??10)*1000));
  }

  _updateMediaSession(t) {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title:   t.title  ?? '',
      artist:  t.artist ?? '',
      album:   t.album  ?? '',
      artwork: t.art ? [
        { src: t.art, sizes: '96x96'  },
        { src: t.art, sizes: '512x512' },
      ] : [],
    });
  }

  /* ── MODULE SYSTEM ──────────────────────────────── */
  async _loadModule(file) {
    if (!file) return;
    if (this.mod?.destroy) { try{await this.mod.destroy();}catch{} }
    this._resetModState();

    const url = URL.createObjectURL(file);
    try {
      const mod    = await import(/* @vite-ignore */ url);
      this.mod     = mod;
      const name   = mod.name || file.name.replace(/\.js$/,'');
      $('source-pill').textContent = name;
      this.toast(`Module: ${name}`);
      if (mod.init) await mod.init(this._bridge());
    } catch (err) {
      console.error('[Core] Module error:', err);
      this.toast(`Module error: ${err.message}`);
    }
  }

  _resetModState() {
    this._cb        = this._emptyCb();
    this.queue      = [];
    this.idx        = 0;
    this.audio.pause();
    this.audio.src  = '';
    this.curMs      = 0;
    this.durMs      = 0;
    this._setPlaying(false);
    this._setFill(0);
    $('t-cur').textContent = '0:00';
    $('t-tot').textContent = '0:00';
    this._renderQueue();
    this._stopLyrics();
    this._updateMeta({ title:'Lossless Core', artist:'Load a module to begin', art:null, quality:'' });
  }

  _emptyCb() {
    return { play:[], pause:[], seek:[], next:null, prev:null, shuffle:null, repeat:null, volume:null, playIndex:null };
  }

  /**
   * Bridge API — the surface exposed to community modules via init(bridge).
   */
  _bridge() {
    const C = this;
    return {
      /* Meta */
      updateMeta(title, artist, album, artUrl) {
        C._updateMeta({ title, artist, album, art: artUrl });
        if ('mediaSession' in navigator) {
          C._updateMediaSession({ title, artist, album, art: artUrl });
        }
      },

      /* Progress (module-controlled clock) */
      updateProgress(curMs, totalMs) {
        C.curMs  = curMs;
        C.durMs  = totalMs;
        C._updateProgress();
        C._lyricsStart  = curMs;
        C._lyricsSystem = Date.now();
      },

      /* Audio — give core a URL to play */
      setAudioUrl(url, mimeType) {
        if (mimeType) C.audio.type = mimeType;
        C.audio.src = url;
        C.audio.load();
        if (C.playing) C.audio.play().catch(()=>{});
      },

      /* Quality badge */
      setQualityLabel(label) { $('quality-label').textContent = label; },

      /* Queue */
      setQueue(tracks) { C.queue = tracks||[]; C._renderQueue(); },
      updateQueue(tracks) { C.queue = tracks||[]; C._renderQueue(); },
      setQueueIndex(i) { C._setQueueIndex(i); },

      /* am-lyrics synced */
      startLyricsSync(title, artist, album, durationMs, isrc, musicId) {
        C._startLyricsSync({ title, artist, album, duration: durationMs, isrc, musicId });
      },
      setCurrentTime(ms) {
        C._lyricsStart  = ms;
        C._lyricsSystem = Date.now();
        $('amLyrics').setAttribute('current-time', ms);
      },
      stopLyrics() { C._stopLyrics(); },

      /* Plain text lyrics fallback */
      updateLyrics(text) {
        const el = $('lyrics-plain');
        el.textContent = text;
        el.style.display = 'block';
        $('amLyrics').setAttribute('current-time', '-1');
        C.lyricsMode = 'plain';
      },

      /* Toast */
      toast(msg, ms) { C.toast(msg, ms); },

      /* AudioContext (advanced Web Audio) */
      getAudioContext() {
        if (!C._ctx) {
          C._ctx = new (window.AudioContext||window.webkitAudioContext)({ sampleRate:192000, latencyHint:'playback' });
        }
        return C._ctx;
      },

      /* Callbacks */
      onPlay(cb)         { C._cb.play.push(cb); },
      onPause(cb)        { C._cb.pause.push(cb); },
      onSeek(cb)         { C._cb.seek.push(cb); },
      onNext(cb)         { C._cb.next = cb; },
      onPrev(cb)         { C._cb.prev = cb; },
      onShuffle(cb)      { C._cb.shuffle = cb; },
      onRepeat(cb)       { C._cb.repeat = cb; },
      onVolumeChange(cb) { C._cb.volume = cb; },
      onPlayIndex(cb)    { C._cb.playIndex = cb; },
    };
  }

  /* ── Toast ──────────────────────────────────────── */
  toast(msg, dur=2400) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.remove('show'), dur);
  }

  /* ── Service Worker ─────────────────────────────── */
  async _registerSW() {
    if (!('serviceWorker' in navigator)) return;
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w.addEventListener('statechange', () => {
          if (w.state==='installed' && navigator.serviceWorker.controller) {
            this.toast('Update available — refresh to apply', 5000);
          }
        });
      });
    } catch (e) {
      console.warn('[Core] SW:', e);
    }
  }
}

/* Boot */
new LosslessCore();

app.js
Displaying app.js.
