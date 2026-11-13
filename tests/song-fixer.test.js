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

test('fixed songs are remembered for the Zune until updated, and undo forgets them', { skip: !haveFfmpeg && 'ffmpeg binary not installed' }, async () => {
  const { SongFixer } = require('../src/main/song-fixer.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'songfixer-'));
  try {
    const mk = (name, title) => {
      const p = path.join(dir, name);
      execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=300:d=3',
        '-c:a', 'libmp3lame', '-metadata', `title=${title}`, '-y', p]);
      return p;
    };
    const a = mk('a.mp3', 'Old A');
    const b = mk('b.mp3', 'Old B');
    const sf = new SongFixer({ ffmpegPath, dataDir: dir });
    await sf.apply('200', a, { title: 'New A' });
    await sf.apply('200', a, { title: 'Newer A' }); // fixed twice: keep the oldest tags
    await sf.apply('201', b, { title: 'New B' });

    let pending = await sf.zunePending();
    assert.deepEqual(pending.map(e => [e.fileName, e.before.title]), [['a.mp3', 'Old A'], ['b.mp3', 'Old B']]);

    await sf.undoLast(); // undoes b
    pending = await sf.zunePending();
    assert.deepEqual(pending.map(e => e.fileName), ['a.mp3']);

    await sf.zuneMarkRemoved([a]);
    assert.equal((await sf.zunePending())[0].removedFromZune, true);
    await sf.zuneDone([a]);
    // Done songs leave the to-do list but stay in the fix history, where the
    // plan finds them up to date (or not on the Zune) and skips them
    const after = await sf.zunePending();
    assert.deepEqual(after.map(e => [path.basename(e.path), !!e.fromHistory]), [['a.mp3', true]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('songs fixed before the Zune list existed are picked up from undo records', async () => {
  const { SongFixer } = require('../src/main/song-fixer.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'songfixer-'));
  try {
    const song = path.join(dir, 'old.mp3');
    fs.writeFileSync(song, 'x');
    fs.mkdirSync(path.join(dir, 'song-fixer'));
    fs.writeFileSync(path.join(dir, 'song-fixer', '1700.json'),
      JSON.stringify([{ path: song, before: { title: 'Was', artist: 'Someone', album: 'DOPEHOOD.COM' }, addedCover: false }]));
    const sf = new SongFixer({ ffmpegPath: 'unused', dataDir: dir });
    const pending = await sf.zunePending();
    assert.deepEqual(pending, [{ path: song, fileName: 'old.mp3', before: { title: 'Was', artist: 'Someone', album: 'DOPEHOOD.COM' }, removedFromZune: false }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('trash moves files away and queues Zune removal only when asked', async () => {
  const { SongFixer } = require('../src/main/song-fixer.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'songfixer-'));
  try {
    const trashDir = path.join(dir, 'Trash');
    fs.mkdirSync(trashDir);
    const a = path.join(dir, 'a.mp3');
    const b = path.join(dir, 'b.mp3');
    fs.writeFileSync(a, 'not really audio');
    fs.writeFileSync(b, 'not really audio');
    const sf = new SongFixer({
      ffmpegPath: 'unused', dataDir: dir,
      trashItem: async (p) => fs.renameSync(p, path.join(trashDir, path.basename(p))),
    });
    const r1 = await sf.trash([a], { removeFromZune: true });
    assert.deepEqual(r1.trashed, [a]);
    const r2 = await sf.trash([b, path.join(dir, 'missing.mp3')], { removeFromZune: false });
    assert.deepEqual(r2.trashed, [b]);
    assert.equal(r2.failed.length, 1);
    assert.deepEqual(fs.readdirSync(trashDir).sort(), ['a.mp3', 'b.mp3']);
    const pending = await sf.zunePending();
    assert.deepEqual(pending.map(e => [e.fileName, e.action]), [['a.mp3', 'delete']]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('identify falls back to a title search when there is no AcoustID key', async () => {
  const { SongFixer } = require('../src/main/song-fixer.js');
  const queries = [];
  const sf = new SongFixer({
    ffmpegPath: 'unused', dataDir: os.tmpdir(),
    searchRecordings: async (q) => {
      queries.push(q);
      return { recordings: [{ id: 'r', score: 100, title: 'OMG', length: 269000,
        'artist-credit': [{ name: 'Usher', joinphrase: ' feat. ' }, { name: 'will.i.am' }],
        releases: [{ title: 'Raymond v. Raymond', date: '2010-03-30', 'release-group': { id: 'rg', 'primary-type': 'Album' }, media: [{ position: 1, track: [{ number: '4' }] }] }] }] };
    },
  });
  // A file we can't read: tags come from the library's view of it
  const r = await sf.identify('/nonexistent/02-Usher-OMG.mp3', '', { title: '02-Usher-OMG (Official Video)', artist: 'Unknown Artist', duration: 270 });
  assert.equal(queries[0], 'recording:(usher omg) AND artist:(usher omg)');
  assert.equal(r.proposal.source, 'title');
  assert.equal(r.proposal.title, 'OMG');
  assert.equal(r.proposal.artist, 'Usher feat. will.i.am');
  assert.equal(r.proposal.album, 'Raymond v. Raymond');
  assert.equal(r.proposal.trackNumber, 4);
});

test('songs marked done still come back from the fix history for re-checking', async () => {
  const { SongFixer } = require('../src/main/song-fixer.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'songfixer-'));
  try {
    const a = path.join(dir, 'a.mp3');
    fs.writeFileSync(a, 'x');
    fs.mkdirSync(path.join(dir, 'song-fixer'));
    fs.writeFileSync(path.join(dir, 'song-fixer', '1800.json'), JSON.stringify([{ path: a, before: { title: 'Old' } }]));
    const sf = new SongFixer({ ffmpegPath: 'unused', dataDir: dir });
    await sf.zunePending(); // seeds the list
    await sf.zuneDone([a]); // wrongly marked done
    const again = await sf.zunePending();
    assert.equal(again.length, 1);
    assert.equal(again[0].path, a);
    assert.equal(again[0].fromHistory, true);
    assert.equal(again[0].before.title, 'Old');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
