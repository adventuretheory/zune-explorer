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

test('planZuneUpdate finds the old copy on the Zune by file name or old tags', () => {
  const pending = [
    { path: '/m/heaven.mp3', fileName: 'heaven.mp3', before: { title: '1-11_March', artist: '' } },
    { path: '/m/tags.mp3', fileName: 'tags.mp3', before: { title: '2012 (Tags)', artist: 'Jay Sean' } },
    { path: '/m/new.mp3', fileName: 'new.mp3', before: { title: 'Nope', artist: 'Nobody' } },
    { path: '/m/done.mp3', fileName: 'done.mp3', before: { title: 'Old', artist: 'X' } },
    { path: '/m/gone.mp3', fileName: 'gone.mp3', before: { title: 'G', artist: 'G' }, removedFromZune: true },
  ];
  const device = [
    { handle: 11, filename: 'HEAVEN.mp3', title: '1-11_March', artist: '' },
    { handle: 12, filename: 'zune-name.wma', title: '2012 (tags)', artist: 'jay sean' },
    { handle: 13, filename: 'other.mp3', title: 'Fixed', artist: 'X', album: 'Album' },
    { handle: 14, filename: 'unrelated.mp3', title: 'Something', artist: 'Else' },
  ];
  const current = new Map([
    ['/m/heaven.mp3', { title: 'Heaven', artist: 'DJ Sammy', album: 'Heaven' }],
    ['/m/tags.mp3', { title: '2012', artist: 'Jay Sean', album: '2012' }],
    ['/m/new.mp3', { title: 'Brand New', artist: 'Y', album: 'Z' }],
    ['/m/done.mp3', { title: 'Fixed', artist: 'X', album: 'Album' }],
  ]);
  const plan = L.planZuneUpdate(pending, device, current);
  assert.deepEqual(plan.replace, [{ path: '/m/heaven.mp3', handle: 11 }, { path: '/m/tags.mp3', handle: 12 }]);
  assert.deepEqual(plan.notOnZune, ['/m/new.mp3']);
  assert.deepEqual(plan.upToDate, ['/m/done.mp3']);
  assert.deepEqual(plan.resend, ['/m/gone.mp3']);
  assert.deepEqual(plan.needsRescan, []);
});

test('planZuneUpdate never uses one Zune copy for two songs, and asks for a rescan for unsent handles', () => {
  const pending = [
    { path: '/a/intro.mp3', fileName: 'intro.mp3', before: { title: 'Intro', artist: 'A' } },
    { path: '/b/intro.mp3', fileName: 'intro.mp3', before: { title: 'Intro', artist: 'A' } },
    { path: '/c/x.mp3', fileName: 'x.mp3', before: { title: 'X', artist: 'X' } },
  ];
  const device = [
    { handle: 1, filename: 'intro.mp3', title: 'Intro', artist: 'A' },
    { handle: 0, filename: 'x.mp3', title: 'X', artist: 'X' }, // pushed this session, no real handle yet
  ];
  const plan = L.planZuneUpdate(pending, device, new Map());
  assert.deepEqual(plan.replace, [{ path: '/a/intro.mp3', handle: 1 }]);
  assert.deepEqual(plan.notOnZune, ['/b/intro.mp3']);
  assert.deepEqual(plan.needsRescan, ['/c/x.mp3']);
});

test('planZuneUpdate replaces a copy whose title matches but album is still old', () => {
  const pending = [{ path: '/m/s.mp3', fileName: 's.mp3', before: { title: 'Song', artist: 'A' } }];
  const device = [{ handle: 5, filename: 's.mp3', title: 'Song', artist: 'A', album: 'DOPEHOOD.COM' }];
  const plan = L.planZuneUpdate(pending, device, new Map([['/m/s.mp3', { title: 'Song', artist: 'A', album: 'Real Album' }]]));
  assert.deepEqual(plan.replace, [{ path: '/m/s.mp3', handle: 5 }]);
});
