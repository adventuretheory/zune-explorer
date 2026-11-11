const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/shared/song-fixer-logic.js');

test('suspectReasons flags placeholder, GUID, filename-like and spam tags', () => {
  assert.deepEqual(L.suspectReasons({ title: 'Clocks', artist: 'Coldplay', album: 'A Rush of Blood to the Head' }, '/m/Clocks.mp3'), []);
  assert.deepEqual(
    L.suspectReasons({ title: '8-Bit Trip', artist: '{09316835-3188-481c-a359-0f8d2a937ac8}', album: 'Unknown Album' }, '/m/x.mp3'),
    ['no artist', 'no album']);
  assert.ok(L.suspectReasons({ title: '1-11_March_2005-02-DJ_Sammy-Heaven', artist: 'Unknown Artist', album: 'x' }, '/m/1-11_March_2005-02-DJ_Sammy-Heaven.mp3')
    .includes('title is a filename'));
  assert.deepEqual(L.suspectReasons({ title: '2012 (Tags)', artist: 'Jay Sean', album: 'DOPEHOOD.COM' }, '/m/a.mp3'), ['website in album']);
  assert.deepEqual(L.suspectReasons({ title: 'Song', artist: 'A', album: 'www.EveryoneLovesHipHop.com' }, '/m/a.mp3'), ['website in album']);
  assert.ok(L.suspectReasons({ title: '', artist: 'A', album: 'B' }, '/m/a.mp3').includes('no title'));
  assert.ok(L.suspectReasons({ title: 'Track 04', artist: 'A', album: 'B' }, '/m/a.mp3').includes('no title'));
});

// Shaped like an AcoustID /v2/lookup response with meta=recordings releasegroups releases tracks
const response = {
  status: 'ok',
  results: [
    { id: 'low', score: 0.3, recordings: [{ id: 'r0', title: 'Wrong Song', artists: [{ name: 'Nobody' }] }] },
    {
      id: 'aid1', score: 0.94,
      recordings: [
        { id: 'rec-remix', title: 'Heaven (Remix)', artists: [{ name: 'DJ Sammy' }], releasegroups: [] },
        {
          id: 'rec1', title: 'Heaven',
          artists: [{ name: 'DJ Sammy', joinphrase: ' & ' }, { name: 'Yanou' }],
          releasegroups: [
            { id: 'rg-comp', title: 'Now 54', type: 'Album', secondarytypes: ['Compilation'], artists: [{ name: 'Various Artists' }],
              releases: [{ id: 'rel-c', date: { year: 2003 }, mediums: [{ position: 1, tracks: [{ position: 12 }] }] }] },
            { id: 'rg-single', title: 'Heaven', type: 'Single', releases: [{ date: { year: 2001 }, mediums: [{ position: 1, tracks: [{ position: 1 }] }] }] },
            { id: 'rg-album', title: 'Heaven', type: 'Album', secondarytypes: [], artists: [{ name: 'DJ Sammy' }],
              releases: [
                { date: { year: 2004 }, mediums: [{ position: 1, tracks: [{ position: 5 }] }] },
                { date: { year: 2002 }, mediums: [{ position: 1, tracks: [{ position: 3 }] }] },
              ] },
          ],
        },
      ],
    },
  ],
};

test('pickBestMatch prefers the canonical recording and the studio album', () => {
  const p = L.pickBestMatch(response, { title: '1-11_March_2005', artist: 'Unknown Artist', album: '' });
  assert.equal(p.title, 'Heaven');
  assert.equal(p.artist, 'DJ Sammy & Yanou');
  assert.equal(p.album, 'Heaven');
  assert.equal(p.releaseGroupId, 'rg-album');
  assert.equal(p.year, 2002);
  assert.equal(p.trackNumber, 3);
  assert.equal(p.albums.length, 3);
  assert.equal(p.albums[1].releaseGroupId, 'rg-single');
  assert.equal(p.albums.at(-1).album, 'Now 54');
});

test('pickBestMatch keeps the album the file already has when it is an option', () => {
  const p = L.pickBestMatch(response, { title: 'Heaven', artist: 'DJ Sammy', album: 'now 54' });
  assert.equal(p.album, 'Now 54');
  assert.equal(p.trackNumber, 12);
});

test('pickBestMatch returns null for weak or empty results', () => {
  assert.equal(L.pickBestMatch({ status: 'ok', results: [] }), null);
  assert.equal(L.pickBestMatch({ status: 'ok', results: [response.results[0]] }), null);
  assert.equal(L.pickBestMatch({ status: 'ok', results: [{ id: 'x', score: 0.99 }] }), null);
});

test('proposedChanges lists only fields that differ', () => {
  const changes = L.proposedChanges({ title: 'Heaven', artist: 'x', album: '', year: 2002 }, { title: 'Heaven', artist: 'DJ Sammy', album: 'Heaven', year: 2002, trackNumber: null });
  assert.deepEqual(changes.map(c => c.field), ['artist', 'album']);
});

test('buildTagArgs copies audio, keeps existing tags, and maps names per format', () => {
  const mp3 = L.buildTagArgs('in.mp3', 'out.mp3', { title: 'T', year: 2002, albumArtist: 'AA' }, { ext: '.mp3' });
  assert.ok(mp3.join(' ').includes('-map 0:a -map 0:v? -map_metadata 0 -c copy'));
  assert.ok(mp3.includes('title=T') && mp3.includes('date=2002') && mp3.includes('album_artist=AA'));
  assert.ok(mp3.includes('-id3v2_version'));

  const withCover = L.buildTagArgs('in.mp3', 'out.mp3', {}, { ext: '.mp3', coverPath: 'c.jpg' });
  assert.ok(withCover.join(' ').includes('-i c.jpg -map 0:a -map 1:0'));
  assert.ok(withCover.includes('attached_pic'));

  assert.ok(L.buildTagArgs('a.wma', 'b.wma', { year: 1999 }, { ext: '.wma' }).includes('WM/Year=1999'));
  const ogg = L.buildTagArgs('a.ogg', 'b.ogg', { title: 'T' }, { ext: '.ogg' });
  assert.ok(ogg.includes('-metadata:s:a:0'));
  // Clearing a field (used by undo) passes an empty value
  assert.ok(L.buildTagArgs('a.mp3', 'b.mp3', { album: '' }, { ext: '.mp3' }).includes('album='));
});
