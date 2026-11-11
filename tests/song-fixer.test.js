// End-to-end: fingerprint a generated song, rewrite its tags, undo.
// Needs the ffmpeg binary that ffmpeg-static downloads on install; skipped without it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let ffmpegPath = null;
try { ffmpegPath = require('ffmpeg-static'); } catch {}
const haveFfmpeg = !!ffmpegPath && fs.existsSync(ffmpegPath);

test('song fixer fingerprints, rewrites tags and undoes', { skip: !haveFfmpeg && 'ffmpeg binary not installed' }, async () => {
  const { SongFixer } = require('../src/main/song-fixer.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'songfixer-'));
  try {
    const song = path.join(dir, 'song.mp3');
    execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=f=220:d=20', '-f', 'lavfi', '-i', 'anoisesrc=d=20:a=0.2:c=pink',
      '-filter_complex', 'amix=inputs=2', '-c:a', 'libmp3lame', '-b:a', '128k',
      '-metadata', 'title=1-11_Track_name', '-metadata', 'album=DOPEHOOD.COM', '-y', song]);

    const sf = new SongFixer({ ffmpegPath, dataDir: dir });
    const fp = await sf.fingerprint(song);
    assert.match(fp, /^AQA[A-Za-z0-9_-]{20,}$/);

    await sf.apply('100', song, { title: 'Heaven', artist: 'DJ Sammy', album: 'Heaven', year: 2002, trackNumber: 3 });
    let tags = await sf.readTags(song);
    assert.equal(tags.title, 'Heaven');
    assert.equal(tags.artist, 'DJ Sammy');
    assert.equal(tags.year, 2002);
    assert.equal(tags.trackNumber, 3);
    assert.equal((await sf.undoInfo()).count, 1);

    const undo = await sf.undoLast();
    assert.equal(undo.failed.length, 0);
    tags = await sf.readTags(song);
    assert.equal(tags.title, '1-11_Track_name');
    assert.equal(tags.album, 'DOPEHOOD.COM');
    assert.equal(tags.artist, '');
    assert.equal(await sf.undoInfo(), null);
    // No temp files left behind
    assert.deepEqual(fs.readdirSync(dir).filter(n => n.endsWith('.mp3')), ['song.mp3']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
