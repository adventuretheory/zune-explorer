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
    // Done and unchanged since: not offered again
    assert.deepEqual(await sf.zunePending(), []);
    // Changed again (a new fix): back for the Zune
    await sf.apply('202', a, { title: 'Newest A' });
    assert.deepEqual((await sf.zunePending()).map(e => path.basename(e.path)), ['a.mp3']);
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
    assert.deepEqual(r2.missing, [path.join(dir, 'missing.mp3')]); // already gone: not an error
    assert.equal(r2.failed.length, 0);
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
    // Crossed off by the old bug: removed from the list without a "synced"
    // record, so the fix history still brings it back
    await sf._writePending([]);
    const again = await sf.zunePending();
    assert.equal(again.length, 1);
    assert.equal(again[0].path, a);
    assert.equal(again[0].fromHistory, true);
    assert.equal(again[0].before.title, 'Old');
    // Properly done (with a synced record) and unchanged: stays away
    await sf.zuneDone([a]);
    assert.deepEqual(await sf.zunePending(), []);
    // The file changes afterwards: it comes back
    fs.writeFileSync(a, 'xy');
    assert.equal((await sf.zunePending()).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('trash reports files already gone, and never deletes a copy whose kept copy is unreachable', async () => {
  const { SongFixer } = require('../src/main/song-fixer.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'songfixer-'));
  try {
    const trashDir = path.join(dir, 'Trash');
    fs.mkdirSync(trashDir);
    const keep = path.join(dir, 'keep.mp3');
    const extra = path.join(dir, 'extra.mp3');
    const extra2 = path.join(dir, 'extra2.mp3');
    for (const f of [keep, extra, extra2]) fs.writeFileSync(f, 'x');
    const sf = new SongFixer({
      ffmpegPath: 'unused', dataDir: dir,
      trashItem: async (p) => fs.renameSync(p, path.join(trashDir, path.basename(p))),
    });
    const r = await sf.trash([extra, extra2, path.join(dir, 'gone.mp3')], {
      keepers: {
        [extra]: [keep],                                   // kept copy is here: delete
        [extra2]: ['/Volumes/Unplugged Drive/keep.mp3'],   // kept copy unreachable: don't
      },
    });
    assert.deepEqual(r.trashed, [extra]);
    assert.deepEqual(r.missing, [path.join(dir, 'gone.mp3')]);
    assert.equal(r.failed.length, 1);
    assert.equal(r.failed[0].path, extra2);
    assert.equal(r.failed[0].keeperMissing, true);
    assert.ok(fs.existsSync(extra2), 'the only reachable copy was not deleted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a song with no usable length in its header gets measured, so AcoustID gets a real duration', { skip: !haveFfmpeg && 'ffmpeg binary not installed' }, async () => {
  const { SongFixer } = require('../src/main/song-fixer.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'songfixer-'));
  try {
    const song = path.join(dir, 'song.mp3');
    execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=220:d=12',
      '-c:a', 'libmp3lame', '-write_xing', '0', '-y', song]);
    const sf = new SongFixer({ ffmpegPath, dataDir: dir, searchRecordings: async () => ({ recordings: [] }) });

    const measured = await sf.measureDuration(song);
    assert.ok(Math.abs(measured - 12) < 0.5, `measured ${measured}`);

    // Pretend the header reported nonsense
    sf.readTags = async () => ({ title: 'x', artist: '', album: '', duration: Infinity });
    let sentDuration = null;
    sf._acoustidLookup = async (key, fp, duration) => { sentDuration = duration; return { status: 'ok', results: [] }; };
    const r = await sf.identify(song, 'somekey');
    assert.ok(Math.abs(sentDuration - 12) < 0.5, `sent ${sentDuration}`);
    assert.equal(r.proposal, null);

    // A sound-check failure is a note on "not recognised", not an error
    sf._acoustidLookup = async () => { throw new Error('AcoustID: missing required parameter "duration"'); };
    const r2 = await sf.identify(song, 'somekey');
    assert.equal(r2.proposal, null);
    assert.match(r2.note, /couldn.t check the sound \(missing required parameter "duration"\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('addCover embeds art, queues the song for the Zune, and undo removes it', { skip: !haveFfmpeg && 'ffmpeg binary not installed' }, async () => {
  const { SongFixer } = require('../src/main/song-fixer.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'songfixer-'));
  try {
    const song = path.join(dir, 'song.mp3');
    const cover = path.join(dir, 'cover.jpg');
    const wma = path.join(dir, 'song.wma');
    execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=300:d=4', '-c:a', 'libmp3lame', '-metadata', 'title=Song', '-y', song]);
    execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'mandelbrot=s=300x300', '-frames:v', '1', '-y', cover]);
    execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=300:d=2', '-c:a', 'wmav2', '-y', wma]);
    const sf = new SongFixer({ ffmpegPath, dataDir: dir });

    assert.equal((await sf.readTags(song)).hasCover, false);
    const r = await sf.addCover('300', song, fs.readFileSync(cover));
    assert.equal(r.added, true);
    const tags = await sf.readTags(song);
    assert.equal(tags.hasCover, true);
    assert.equal(tags.title, 'Song', 'other tags are kept');

    // Already has art: skipped unless replacing
    assert.equal((await sf.addCover('301', song, fs.readFileSync(cover))).skipped, 'already has album art');

    const pending = await sf.zunePending();
    assert.equal(pending.find(e => e.path === song).artChanged, true);

    await assert.rejects(sf.addCover('302', wma, fs.readFileSync(cover)), /can't be added to WMA/);

    await sf.undoLast(); // undoes batch 300 (301/302 recorded nothing)
    assert.equal((await sf.readTags(song)).hasCover, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a fake ".mp3" holding AAC audio still gets fixed (converted to real MP3)', { skip: !haveFfmpeg && 'ffmpeg binary not installed' }, async () => {
  const { SongFixer } = require('../src/main/song-fixer.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'songfixer-'));
  try {
    const song = path.join(dir, 'The Beatles - Help!.mp3');
    // AAC audio in an MP4 container, named .mp3 (common for downloads)
    execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=300:d=5',
      '-c:a', 'aac', '-f', 'mp4', '-y', song]);
    const sf = new SongFixer({ ffmpegPath, dataDir: dir });
    const r = await sf.apply('400', song, { title: 'Help!', artist: 'The Beatles', album: 'Help!' }, { addCover: false });
    assert.equal(r.transcoded, true);
    const tags = await sf.readTags(song);
    assert.equal(tags.title, 'Help!');
    assert.equal(tags.artist, 'The Beatles');
    assert.ok(Math.abs(tags.duration - 5) < 0.5);
    const { parseFile } = await import('music-metadata');
    assert.match((await parseFile(song)).format.codec || '', /MPEG.*layer 3|mp3/i, 'now real MP3 audio');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a broken cover image doesn\'t stop the tags being fixed', { skip: !haveFfmpeg && 'ffmpeg binary not installed' }, async () => {
  const { SongFixer } = require('../src/main/song-fixer.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'songfixer-'));
  try {
    const song = path.join(dir, 'song.mp3');
    execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=300:d=4', '-c:a', 'libmp3lame', '-y', song]);
    const junk = Buffer.alloc(5000, 7); // says image/jpeg, isn't
    const sf = new SongFixer({ ffmpegPath, dataDir: dir, fetchBinary: async () => ({ data: junk, contentType: 'image/jpeg' }) });
    const r = await sf.apply('401', song, { title: 'Fixed' }, { releaseGroupId: '11111111-2222-3333-4444-555555555555', addCover: true });
    assert.equal(r.coverSkipped, true);
    assert.equal(r.addedCover, false);
    assert.equal((await sf.readTags(song)).title, 'Fixed');
    // And the error, when nothing can be saved, carries ffmpeg's reason
    await assert.rejects(sf._rewrite(path.join(dir, 'missing.mp3'), { title: 'x' }), (e) => /Could not update tags|ENOENT/.test(e.message));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a song saved as ".net" gets its real ending, and VBR files without a length header still save', { skip: !haveFfmpeg && 'ffmpeg binary not installed' }, async () => {
  const { SongFixer } = require('../src/main/song-fixer.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'songfixer-'));
  try {
    const art = path.join(dir, 'art.jpg');
    execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=s=800x800:d=1',
      '-frames:v', '1', '-q:v', '1', '-y', art]);
    // VBR MP3 with no Xing header (so its length is a guess) and a big cover
    const song = path.join(dir, 'Akon - Beautiful (www.hear-it-first).net');
    execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=f=220:d=4,volume=0.1', '-f', 'lavfi', '-i', 'anoisesrc=d=16:a=0.6:c=white', '-i', art,
      '-filter_complex', '[0][1]concat=n=2:v=0:a=1[a]', '-map', '[a]', '-map', '2:v',
      '-c:a', 'libmp3lame', '-q:a', '6', '-write_xing', '0', '-c:v', 'copy', '-id3v2_version', '3',
      '-f', 'mp3', '-y', song]);

    const sf = new SongFixer({ ffmpegPath, dataDir: dir });
    const res = await sf.apply('200', song, { title: 'Beautiful', artist: 'Akon' });
    assert.equal(res.renamedTo, path.join(dir, 'Akon - Beautiful (www.hear-it-first).mp3'));
    assert.equal(fs.existsSync(song), false);
    assert.equal((await sf.readTags(res.renamedTo)).title, 'Beautiful');

    // Dropping the cover shrinks the file, so lengths are compared
    await sf._rewrite(res.renamedTo, {}, { dropCover: true });
    assert.equal((await sf.readTags(res.renamedTo)).hasCover, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
