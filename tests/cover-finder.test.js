// Album art search order: same album, online (MusicBrainz, Apple, Deezer), stand-ins.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CoverFinder, sameTitle, itunesPick, deezerPick, isImage } = require('../src/main/cover-finder.js');

const jpg = (tag) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2000, tag)]);

function finder(over = {}) {
  const calls = [];
  const deps = {
    fetchJson: async (url) => { calls.push(url); return {}; },
    fetchBinary: async (url) => { calls.push(url); return { data: jpg(9) }; },
    musicbrainzCover: async () => null,
    readCover: async () => null,
    artistPhoto: async () => null,
    identify: async () => null,
    releaseGroupCover: async () => null,
    ...over,
  };
  return { f: new CoverFinder(deps), calls };
}

test('album and song names compare without "(Deluxe Edition)", accents or punctuation', () => {
  assert.equal(sameTitle('Tha Carter III (Deluxe Edition)', 'tha carter iii'), true);
  assert.equal(sameTitle('Beyoncé', 'Beyonce'), true);
  assert.equal(sameTitle('Greatest Hits', 'Greatest Hits Vol. 2'), false);
  assert.equal(sameTitle('Graduation', 'Late Registration'), false);
  assert.equal(isImage(Buffer.alloc(5000)), false);
  assert.equal(isImage(jpg(1)), true);
});

test('Apple and Deezer results only count when artist and album match', () => {
  const apple = { results: [
    { artistName: 'Kanye West', collectionName: 'Late Registration', artworkUrl100: 'https://a/x/100x100bb.jpg' },
    { artistName: 'Kanye West', collectionName: 'Graduation', artworkUrl100: 'https://a/g/100x100bb.jpg' },
  ] };
  assert.equal(itunesPick(apple, { artist: 'Kanye West', album: 'Graduation' }), 'https://a/g/600x600bb.jpg');
  assert.equal(itunesPick(apple, { artist: 'Jay-Z', album: 'Graduation' }), null);
  const deezer = { data: [
    { title: 'Graduation', artist: { name: 'Kanye West' }, cover_xl: 'https://e-cdns-images.dzcdn.net/images/cover//1000x1000.jpg' },
    { title: 'Graduation', artist: { name: 'Kanye West' }, cover_xl: 'https://d/real.jpg' },
  ] };
  assert.equal(deezerPick(deezer, { artist: 'Kanye West', album: 'Graduation' }), 'https://d/real.jpg');
  const track = { data: [{ title: 'Stronger', artist: { name: 'Kanye West' }, album: { title: 'Graduation', cover_xl: 'https://d/s.jpg' } }] };
  assert.equal(deezerPick(track, { artist: 'Kanye West feat. Daft Punk', title: 'Stronger' }), 'https://d/s.jpg');
});

test('a cover from another song on the same album is used first, without going online', async () => {
  const { f, calls } = finder({ readCover: async (p) => (p === '/b.mp3' ? jpg(2) : null) });
  const r = await f.find({ title: 'One', artist: 'Band', album: 'Record' }, { path: '/a.mp3', siblings: ['/c.mp3', '/b.mp3'] });
  assert.equal(r.source, 'album');
  assert.deepEqual(calls, []);
});

test('online: MusicBrainz, then Apple, then Deezer', async () => {
  const urls = [];
  const { f } = finder({
    fetchJson: async (url) => {
      urls.push(url);
      if (url.includes('deezer')) return { data: [{ title: 'Record', artist: { name: 'Band' }, cover_xl: 'https://d/c.jpg' }] };
      return { results: [] };
    },
  });
  const r = await f.find({ title: 'One', artist: 'Band', album: 'Record' });
  assert.equal(r.source, 'deezer');
  assert.ok(urls[0].startsWith('https://itunes.apple.com/search') && urls[0].includes('entity=album'));
  assert.ok(urls.some(u => u.startsWith('https://api.deezer.com/search/album')));

  const { f: mb } = finder({ musicbrainzCover: async () => jpg(3) });
  assert.equal((await mb.find({ title: 'One', artist: 'Band', album: 'Record' })).source, 'musicbrainz');
});

test('without stand-ins, nothing found means no cover', async () => {
  const { f } = finder({ artistPhoto: async () => jpg(4) });
  assert.equal(await f.find({ title: 'One', artist: 'Band', album: 'Record' }, { standIns: false }), null);
});

test('stand-ins: artist photo, else identify by sound and look again, else a made cover', async () => {
  const { f: photo } = finder({ artistPhoto: async () => jpg(4) });
  assert.deepEqual(
    (({ source, standIn }) => ({ source, standIn }))(await photo.find({ title: 'One', artist: 'Band', album: 'Record' }, { path: '/a.mp3', standIns: true })),
    { source: 'artist', standIn: 'artist' });

  const { f: sound } = finder({
    identify: async () => ({ title: 'Real Song', artist: 'Real Band', album: 'Real Album', releaseGroupId: 'rg' }),
    releaseGroupCover: async (id) => (id === 'rg' ? jpg(5) : null),
  });
  const r = await sound.find({ title: 'Track 03', artist: 'Unknown Artist', album: '' }, { path: '/a.mp3', standIns: true });
  assert.equal(r.source, 'sound');
  assert.equal(r.standIn, undefined);
  assert.equal(r.names.title, 'Real Song');

  const { f: none } = finder();
  assert.deepEqual(await none.find({ title: 'x', artist: 'y', album: 'z' }, { path: '/a.mp3', standIns: true }), { needsMade: true, source: 'made' });
});

test('placeholder names are never looked up online', async () => {
  const { f, calls } = finder({ musicbrainzCover: async () => { throw new Error('should not be called'); } });
  assert.equal(await f.online({ title: 'Song', artist: 'Unknown Artist', album: 'Unknown Album' }), null);
  assert.equal(await f.online({ title: '', artist: 'Band', album: 'unknown album' }), null);
  assert.deepEqual(calls, []);
});

test('a site that fails is skipped', async () => {
  const { f } = finder({
    musicbrainzCover: async () => { throw new Error('down'); },
    fetchJson: async (url) => {
      if (url.includes('apple')) throw new Error('blocked');
      return { data: [{ title: 'Record', artist: { name: 'Band' }, cover_xl: 'https://d/c.jpg' }] };
    },
  });
  assert.equal((await f.online({ title: 'One', artist: 'Band', album: 'Record' })).source, 'deezer');
});
