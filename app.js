/**
 * LOSSLESS CORE - STATE ENGINE
 */
class PlayerEngine {
  constructor() {
    this.audio = new Audio();
    this.queue = [];
    this.currentIndex = 0;
    this.isPlaying = false;
    
    this.initElements();
    this.bindEvents();
  }

  initElements() {
    this.els = {
      playBtn: document.getElementById('playBtn'),
      nextBtn: document.getElementById('nextBtn'),
      prevBtn: document.getElementById('prevBtn'),
      title: document.getElementById('track-title'),
      artist: document.getElementById('track-artist'),
      art: document.getElementById('main-art'),
      bgArt: document.getElementById('bg-art'),
      progress: document.getElementById('progress-fill'),
      curTime: document.getElementById('cur-time'),
      totTime: document.getElementById('total-time'),
      fileInput: document.getElementById('fileInput'),
      artCard: document.getElementById('art-card')
    };
  }

  bindEvents() {
    this.els.playBtn.onclick = () => this.togglePlay();
    this.els.fileInput.onchange = (e) => this.loadFiles(e.target.files);
    
    this.audio.ontimeupdate = () => this.updateProgress();
    this.audio.onended = () => this.next();

    // Media Session Support (iOS/Android Lockscreen)
    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('play', () => this.togglePlay());
      navigator.mediaSession.setActionHandler('pause', () => this.togglePlay());
    }
  }

  async loadFiles(files) {
    this.queue = Array.from(files).map(file => ({
      file,
      url: URL.createObjectURL(file),
      title: file.name,
      artist: 'Unknown Artist'
    }));
    this.currentIndex = 0;
    this.playTrack(this.queue[0]);
  }

  async playTrack(track) {
    this.audio.src = track.url;
    this.audio.play();
    this.isPlaying = true;
    this.updateUI(track);
    
    // Squashing metadata errors by chaining jsmediatags -> Apple API
    jsmediatags.read(track.file, {
      onSuccess: (tag) => {
        const { title, artist } = tag.tags;
        this.fetchEnhancedMetadata(title || track.title, artist || "");
      }
    });
  }

  async fetchEnhancedMetadata(title, artist) {
    try {
      const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(title + ' ' + artist)}&entity=song&limit=1`);
      const data = await res.json();
      if (data.results[0]) {
        const t = data.results[0];
        const highResArt = t.artworkUrl100.replace('100x100bb', '800x800bb');
        this.els.title.textContent = t.trackName;
        this.els.artist.textContent = t.artistName;
        this.els.art.src = highResArt;
        this.els.bgArt.src = highResArt;
        
        if ('mediaSession' in navigator) {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: t.trackName,
            artist: t.artistName,
            artwork: [{ src: highResArt, sizes: '512x512', type: 'image/jpeg' }]
          });
        }
      }
    } catch (e) { console.error("Metadata fetch error", e); }
  }

  togglePlay() {
    if (this.audio.paused) {
      this.audio.play();
      this.isPlaying = true;
    } else {
      this.audio.pause();
      this.isPlaying = false;
    }
    this.updatePlayStateUI();
  }

  updatePlayStateUI() {
    document.getElementById('icon-play').classList.toggle('hidden', this.isPlaying);
    document.getElementById('icon-pause').classList.toggle('hidden', !this.isPlaying);
    this.els.artCard.classList.toggle('playing', this.isPlaying);
  }

  updateProgress() {
    const p = (this.audio.currentTime / this.audio.duration) * 100;
    this.els.progress.style.width = `${p}%`;
    this.els.curTime.textContent = this.formatTime(this.audio.currentTime);
    this.els.totTime.textContent = this.formatTime(this.audio.duration);
  }

  formatTime(s) {
    if (isNaN(s)) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  }

  updateUI(track) {
    this.els.title.textContent = track.title;
    this.els.artist.textContent = track.artist;
    this.updatePlayStateUI();
  }
}

// Start the Engine
const core = new PlayerEngine();
