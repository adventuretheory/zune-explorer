class AudioPlayer {
  constructor() {
    this.audio = new Audio();
    this.queue = [];
    this.currentIndex = -1;
    this.isPlaying = false;
    // Shuffle plays every song in the queue once, in random order, before
    // any repeats; "previous" goes back through what was actually played.
    let savedShuffle = false;
    try { savedShuffle = localStorage.getItem('player-shuffle') === '1'; } catch { /* not saved */ }
    this.shuffle = savedShuffle;
    this._shufflePlayed = new Set();
    this._shuffleHistory = [];
    this.repeat = 'none'; // 'none', 'all', 'one'
    this.currentMetadata = null;
    this._listeners = {};

    this.audio.addEventListener('timeupdate', () => {
      this.emit('timeupdate', {
        currentTime: this.audio.currentTime,
        duration: this.audio.duration || 0,
      });
    });

    this.audio.addEventListener('ended', () => {
      if (this.repeat === 'one') {
        this.audio.currentTime = 0;
        this.audio.play();
      } else {
        this.next();
      }
    });

    this.audio.addEventListener('loadedmetadata', () => {
      this.emit('loaded', { duration: this.audio.duration });
    });

    this.audio.addEventListener('error', (e) => {
      console.error('Audio playback error:', e);
      this.emit('error', e);
    });
  }

  on(event, callback) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(callback);
  }

  emit(event, data) {
    if (this._listeners[event]) {
      this._listeners[event].forEach(cb => cb(data));
    }
  }

  async play(file, queue) {
    this.queue = queue || [file];
    this._shufflePlayed = new Set();
    this._shuffleHistory = [];
    this.currentIndex = this.queue.findIndex(f => (f.id && f.id === file.id) || f.path === file.path);
    if (this.currentIndex === -1) this.currentIndex = 0;
    await this.loadAndPlay(this.queue[this.currentIndex]);
  }

  async loadAndPlay(file) {
    // Remember what has played, for shuffle's no-repeat order and "previous"
    if (this.currentIndex >= 0) {
      this._shufflePlayed.add(this.currentIndex);
      if (this._shuffleHistory[this._shuffleHistory.length - 1] !== this.currentIndex) this._shuffleHistory.push(this.currentIndex);
      if (this._shuffleHistory.length > 1000) this._shuffleHistory.splice(0, this._shuffleHistory.length - 1000);
    }
    try {
      if (file.isPodcast) {
        // Podcast episode — metadata is inline, no IPC needed
        this.currentMetadata = {
          title: file.title,
          artist: file.podcastName,
          album: file.podcastName,
          picture: file.artworkPath ? [{ data: file.artworkPath, format: 'path' }] : null,
          duration: file.duration,
        };
        // Use local file if downloaded, otherwise stream from URL
        if (file.localPath) {
          this.audio.src = window.pathUtils.toFileUrl(file.localPath);
        } else {
          this.audio.src = file.enclosureUrl;
        }
        // Resume from saved position — must wait for media to load
        if (file.playbackPosition && file.playbackPosition > 0) {
          const resumePos = file.playbackPosition;
          await new Promise((resolve) => {
            const onLoaded = () => {
              this.audio.currentTime = resumePos;
              this.audio.removeEventListener('loadedmetadata', onLoaded);
              resolve();
            };
            this.audio.addEventListener('loadedmetadata', onLoaded);
          });
        }
      } else {
        // Music track
        const metadata = await window.electronAPI.getAudioMetadata(file.path);
        this.currentMetadata = metadata;
        let src = file.path;
        // Windows Media can't be played directly: play a converted copy
        if (/\.(wma|asf)$/i.test(file.path) && window.electronAPI.getPlayablePath) {
          this.emit('converting', { file });
          const r = await window.electronAPI.getPlayablePath(file.path);
          if (!r.success) {
            const err = new Error(r.drm
              ? `\u201c${file.title || file.name || 'this song'}\u201d is copy-protected (Zune Pass / DRM) \u2014 it only plays on your zune`
              : `couldn\u2019t play this WMA file: ${r.error}`);
            err.friendly = true;
            throw err;
          }
          src = r.path;
        }
        this.audio.src = window.pathUtils.toFileUrl(src);
      }
      await this.audio.play();
      this._failStreak = 0;
      this.isPlaying = true;
      this.emit('trackchange', { file, metadata: this.currentMetadata, index: this.currentIndex, queue: this.queue });
      this.emit('play');
    } catch (error) {
      console.error('Error loading track:', error);
      let message;
      if (error && error.friendly) {
        message = error.message;
      } else if (file.isPodcast) {
        const type = file.enclosureType || 'audio';
        message = file.localPath
          ? `unable to play downloaded episode`
          : `unable to stream episode (${type})`;
      } else {
        const ext = (file.path || '').split('.').pop().toLowerCase();
        const mediaError = this.audio.error;
        if (mediaError && mediaError.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
          message = `unable to play .${ext} files on this platform`;
        } else if (mediaError && mediaError.code === MediaError.MEDIA_ERR_DECODE) {
          message = `unable to decode .${ext} file`;
        } else {
          message = `unable to play: ${file.name || file.title || ext}`;
        }
      }
      this.isPlaying = false;
      this.emit('playbackerror', { file, message });
      // Skip to the next song rather than stopping (but not forever if nothing plays)
      this._failStreak = (this._failStreak || 0) + 1;
      if (!file.isPodcast && this.queue.length > 1 && this._failStreak < 5) {
        const at = this.currentIndex;
        setTimeout(() => { if (this.currentIndex === at && !this.isPlaying) this.next(); }, 1200);
      }
    }
  }

  pause() {
    this.audio.pause();
    this.isPlaying = false;
    this.emit('pause');
  }

  resume() {
    this.audio.play();
    this.isPlaying = true;
    this.emit('play');
  }

  togglePlayPause() {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.resume();
    }
  }

  async next() {
    if (this.queue.length === 0) return;

    let nextIndex;
    if (this.shuffle) {
      const unplayed = () => {
        const list = [];
        for (let i = 0; i < this.queue.length; i++) if (!this._shufflePlayed.has(i) && i !== this.currentIndex) list.push(i);
        return list;
      };
      let left = unplayed();
      if (left.length === 0 && this.repeat === 'all' && this.queue.length > 0) {
        // Everything has played: start a new random round
        this._shufflePlayed = new Set([this.currentIndex]);
        left = unplayed();
        if (left.length === 0) left = [this.currentIndex];
      }
      nextIndex = left.length ? left[Math.floor(Math.random() * left.length)] : this.queue.length;
    } else {
      nextIndex = this.currentIndex + 1;
    }

    if (nextIndex >= this.queue.length) {
      if (this.repeat === 'all') {
        nextIndex = 0;
      } else {
        this.isPlaying = false;
        this.emit('queueend');
        return;
      }
    }

    this.currentIndex = nextIndex;
    await this.loadAndPlay(this.queue[this.currentIndex]);
  }

  async previous() {
    if (this.queue.length === 0) return;

    // If more than 3 seconds in, restart current track
    if (this.audio.currentTime > 3) {
      this.audio.currentTime = 0;
      return;
    }

    // Shuffle: back to the song that played before this one
    if (this.shuffle && this._shuffleHistory.length > 1) {
      if (this._shuffleHistory[this._shuffleHistory.length - 1] === this.currentIndex) this._shuffleHistory.pop();
      const back = this._shuffleHistory.pop();
      if (back != null && back < this.queue.length) {
        this.currentIndex = back;
        await this.loadAndPlay(this.queue[this.currentIndex]);
        return;
      }
    }

    let prevIndex = this.currentIndex - 1;
    if (prevIndex < 0) {
      if (this.repeat === 'all') {
        prevIndex = this.queue.length - 1;
      } else {
        prevIndex = 0;
      }
    }

    this.currentIndex = prevIndex;
    await this.loadAndPlay(this.queue[this.currentIndex]);
  }

  seek(percent) {
    if (this.audio.duration) {
      this.audio.currentTime = this.audio.duration * (percent / 100);
    }
  }

  toggleShuffle() {
    this.setShuffle(!this.shuffle);
  }

  setShuffle(on) {
    this.shuffle = !!on;
    // A fresh round from the current song
    this._shufflePlayed = new Set(this.currentIndex >= 0 ? [this.currentIndex] : []);
    this._shuffleHistory = this.currentIndex >= 0 ? [this.currentIndex] : [];
    try { localStorage.setItem('player-shuffle', this.shuffle ? '1' : '0'); } catch { /* per-session only */ }
    this.emit('shufflechange', this.shuffle);
  }

  toggleRepeat() {
    const modes = ['none', 'all', 'one'];
    const currentIdx = modes.indexOf(this.repeat);
    this.repeat = modes[(currentIdx + 1) % modes.length];
    this.emit('repeatchange', this.repeat);
  }

  formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  getCurrentFile() {
    return this.queue[this.currentIndex] || null;
  }
}
