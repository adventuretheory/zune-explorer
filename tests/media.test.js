// Import new music and audio CDs: pure helpers, plus import and rip with real files.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const M = require('../src/shared/media-logic.js');

let ffmpegPath = null;
try { ffmpegPath = require('ffmpeg-static'); } catch {}
const haveFfmpeg = !!ffmpegPath && fs.existsSync(ffmpegPath);

test('only finished audio files are offered for import', () => {
  assert.equal(M.isImportableAudio('Song.mp3'), true);
  assert.equal(M.isImportableAudio('Song.M4A'), true);
  assert.equal(M.isImportableAudio('Song.mp3.part'), false);
  assert.equal(M.isImportableAudio('Song.crdownload'), false);
  assert.equal(M.isImportableAudio('.hidden.mp3'), false);
  assert.equal(M.isImportableAudio('notes.pdf'), false);
});

test('songs are filed as Artist / Album / "01 Title.ext", safely named', () => {
  assert.deepEqual(M.organizedParts({ artist: 'AC/DC', album: 'Back in Black', title: 'Hells Bells', trackNumber: 1 }, '.MP3'),
    ['AC_DC', 'Back in Black', '01 Hells Bells.mp3']);
  assert.deepEqual(M.organizedParts({ artist: 'Beyoncé', albumArtist: 'Various Artists', album: 'Now 30', title: 'Halo', trackNumber: 7, discNumber: 2 }, '.m4a'),
    ['Various Artists', 'Now 30', '2-07 Halo.m4a']);
  assert.deepEqual(M.organizedParts({ title: 'Untitled Thing' }), ['Unknown Artist', 'Unknown Album', 'Untitled Thing.mp3']);
  assert.equal(M.safeName('...hidden'), 'hidden');
  assert.equal(M.safeName('what?: "yes"'), 'what__ _yes_');
});

test('disc ID matches MusicBrainz\'s documented example', () => {
  const toc = { first: 1, last: 6, leadout: 95462, offsets: [150, 15363, 32314, 46592, 63414, 80489] };
  const id = M.discIdFromHash(crypto.createHash('sha1').update(M.discIdSource(toc)).digest('base64'));
  assert.equal(id, '49HHV7Eb8UKF3aQiNmu1GR8vKTY-');
  assert.equal(M.tocParam(toc), '1+6+95462+150+15363+32314+46592+63414+80489');
});

test('the macOS CD table of contents is read, including enhanced CDs with a data session', () => {
  const plain = {
    Sessions: [{
      'First Track': 1, 'Last Track': 3, 'Leadout Block': 30000, 'Session Number': 1,
      'Track Array': [
        { Point: 1, 'Start Block': 0, Data: false }, { Point: 2, 'Start Block': 10000, Data: false }, { Point: 3, 'Start Block': 20000, Data: false },
      ],
    }],
  };
  assert.deepEqual(M.parseMacToc(plain), { first: 1, last: 3, offsets: [150, 10150, 20150], leadout: 30150 });
  assert.deepEqual(M.trackSeconds(M.parseMacToc(plain)).map(s => Math.round(s)), [133, 133, 133]);
  const enhanced = {
    Sessions: [plain.Sessions[0], { 'Track Array': [{ Point: 4, 'Start Block': 50000, Data: true }] }],
  };
  assert.equal(M.parseMacToc(enhanced).leadout, 50000 - 11400 + 150);
  assert.equal(M.parseMacToc({}), null);
});

test('disc lookups keep the matching disc of releases with the right number of tracks', () => {
  const res = {
    releases: [
      { id: 'r2', title: 'Album', date: '2010-01-01', 'artist-credit': [{ name: 'Band' }], media: [
        { position: 1, discs: [{ id: 'X' }], tracks: [{ position: 1, recording: { title: 'One' } }, { position: 2, recording: { title: 'Two' } }] }] },
      { id: 'r1', title: 'Album (deluxe)', date: '2008', 'artist-credit': [{ name: 'Band' }], media: [
        { position: 1, discs: [{ id: 'other' }], tracks: [{ position: 1, title: 'One' }, { position: 2, title: 'Two' }, { position: 3, title: 'Three' }] }] },
      { id: 'r3', title: 'Album', date: '2009', 'artist-credit': [{ name: 'Band', joinphrase: ' & ' }, { name: 'Guest' }], media: [
        { position: 2, discs: [{ id: 'Y' }], tracks: [{ position: 1, recording: { title: 'Uno' } }, { position: 2, recording: { title: 'Dos' } }] }, { position: 1, discs: [] }] },
    ],
  };
  const c = M.discCandidates(res, 'X', 2);
  assert.deepEqual(c.map(x => x.releaseId), ['r2', 'r3']);
  assert.equal(c[0].exact, true);
  assert.deepEqual(c[0].tracks.map(t => t.title), ['One', 'Two']);
  assert.equal(c[1].artist, 'Band & Guest');
  assert.equal(c[1].discs, 2);
});

test('cdFits counts 2-second gaps and the 99-song limit', () => {
  assert.equal(M.cdFits([4000, 700]).fits, true);
  assert.equal(M.cdFits([4000, 800]).fits, false);
  assert.equal(M.cdFits(Array(100).fill(10)).tooMany, true);
});

function makeTools(dir) {
  const { SongFixer } = require('../src/main/song-fixer.js');
  const { MediaTools } = require('../src/main/media-tools.js');
  const songFixer = new SongFixer({ ffmpegPath, dataDir: dir });
  const trashed = [];
  const tools = new MediaTools({
    ffmpegPath, dataDir: path.join(dir, 'data'), songFixer,
    trashItem: async (p) => { trashed.push(p); fs.rmSync(p); },
    findAlbumArt: async () => fs.readFileSync(path.join(dir, 'cover.jpg')),
  });
  return { tools, songFixer, trashed };
}

test('import finds new songs, files them Artist/Album/Title with clean tags and art, and trashes the originals', { skip: !haveFfmpeg && 'ffmpeg binary not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-'));
  try {
    const dl = path.join(dir, 'Downloads');
    const music = path.join(dir, 'Music');
    fs.mkdirSync(path.join(dl, 'album zip'), { recursive: true });
    fs.mkdirSync(music);
    execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=200x200:d=1', '-frames:v', '1', '-y', path.join(dir, 'cover.jpg')]);
    const mk = (f, tags) => execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=12', '-c:a', 'libmp3lame', '-b:a', '128k',
      ...Object.entries(tags).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]), '-y', f]);
    mk(path.join(dl, 'Akon - Beautiful [www.site.com].mp3'), { title: 'Beautiful (www.site.com)', artist: 'Akon', album: 'DOPEHOOD.COM' });
    mk(path.join(dl, 'album zip', '03 Song.mp3'), { title: 'Song', artist: 'Band', album: 'Record', track: '3' });
    mk(path.join(music, 'already.mp3'), { title: 'Old' });
    fs.writeFileSync(path.join(dl, 'half.mp3.part'), Buffer.alloc(200000));
    fs.writeFileSync(path.join(dl, 'ding.mp3'), Buffer.alloc(1000)); // too small to be a song

    const { tools, songFixer, trashed } = makeTools(dir);
    const found = await tools.scan([dl, music], [music]);
    assert.deepEqual(found.map(f => f.name).sort(), ['03 Song.mp3', 'Akon - Beautiful [www.site.com].mp3']);

    const akon = found.find(f => f.name.startsWith('Akon'));
    const r = await tools.importFile(akon.path, { title: 'Beautiful', artist: 'Akon', album: '' }, music);
    assert.equal(r.path, path.join(music, 'Akon', 'Unknown Album', 'Beautiful.mp3'));
    assert.equal(r.artAdded, true);
    const tags = await songFixer.readTags(r.path);
    assert.equal(tags.title, 'Beautiful');
    assert.equal(tags.hasCover, true);
    assert.deepEqual(trashed, [akon.path]);

    const song = found.find(f => f.name === '03 Song.mp3');
    const r2 = await tools.importFile(song.path, { title: 'Song', artist: 'Band', album: 'Record', trackNumber: 3 }, music, { move: false, findArt: false });
    assert.equal(r2.path, path.join(music, 'Band', 'Record', '03 Song.mp3'));
    assert.ok(fs.existsSync(song.path), 'original kept when not moving');

    // Ignored files aren't offered again
    await tools.ignore([song.path]);
    assert.deepEqual((await tools.scan([dl], [music])).map(f => f.name), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ripping CD tracks makes tagged files with the cover, filed by artist and album', { skip: !haveFfmpeg && 'ffmpeg binary not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rip-'));
  try {
    const cd = path.join(dir, 'Audio CD');
    const music = path.join(dir, 'Music');
    fs.mkdirSync(cd);
    fs.mkdirSync(music);
    execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=200x200:d=1', '-frames:v', '1', '-y', path.join(dir, 'cover.jpg')]);
    for (const n of [1, 2]) {
      execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=f=${300 * n}:d=5`, '-ac', '2', '-ar', '44100',
        '-c:a', 'pcm_s16be', '-y', path.join(cd, `${n} Audio Track.aiff`)]);
    }
    const { tools, songFixer } = makeTools(dir);
    tools.coverForRelease = async () => fs.readFileSync(path.join(dir, 'cover.jpg'));
    const progress = [];
    const r = await tools.rip(
      [{ n: 1, file: path.join(cd, '1 Audio Track.aiff'), title: 'Intro', artist: 'Band' }, { n: 2, file: path.join(cd, '2 Audio Track.aiff'), title: 'Song: Two?', artist: 'Band feat. Guest' }],
      { album: 'First Album', albumArtist: 'Band', year: '2001', genre: 'Rock', disc: 1, discs: 1, trackCount: 2, releaseId: 'x' },
      music, 'mp3', (p) => progress.push(p.phase));
    assert.deepEqual(r.failed, []);
    assert.deepEqual(r.done, [path.join(music, 'Band', 'First Album', '01 Intro.mp3'), path.join(music, 'Band', 'First Album', '02 Song_ Two_.mp3')]);
    const t2 = await songFixer.readTags(r.done[1]);
    assert.equal(t2.title, 'Song: Two?');
    assert.equal(t2.artist, 'Band feat. Guest');
    assert.equal(t2.album, 'First Album');
    assert.equal(t2.albumArtist, 'Band');
    assert.equal(t2.trackNumber, 2);
    assert.equal(t2.hasCover, true);
    assert.ok(Math.abs(t2.duration - 5) < 0.5);
    assert.deepEqual(progress, ['ripping', 'ripping', 'done']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('burning is refused clearly where it isn\'t supported', { skip: process.platform === 'darwin' && 'runs on macOS' }, async () => {
  const { MediaTools } = require('../src/main/media-tools.js');
  const tools = new MediaTools({ ffmpegPath: 'unused', dataDir: os.tmpdir() });
  await assert.rejects(tools.burn(['/x.mp3']), /only works on a Mac/);
  assert.deepEqual(await tools.findAudioCd(), { supported: false });
});
