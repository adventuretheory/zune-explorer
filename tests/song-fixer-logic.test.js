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

test('findDuplicateGroups groups same title+artist with similar length and suggests a keeper', () => {
  const groups = L.findDuplicateGroups([
    { id: 'a', title: 'Heaven', artist: 'DJ Sammy', album: 'DOPEHOOD.COM', duration: 230, size: 9e6 },
    { id: 'b', title: 'heaven', artist: 'dj sammy', album: 'Heaven', duration: 231.5, size: 5e6, hasArt: true },
    { id: 'c', title: 'Heaven', artist: 'DJ Sammy', album: 'Heaven (Remixes)', duration: 420, size: 1e7 }, // extended mix
    { id: 'd', title: 'Heaven', artist: 'Someone Else', album: 'X', duration: 230 },
    { id: 'e', title: 'Unknown', artist: 'A', duration: 100 },
    { id: 'f', title: 'Unknown', artist: 'A', duration: 100 },
    { id: 'g', title: 'Clocks', artist: 'Coldplay', album: 'A Rush', duration: 0, size: 1 },
    { id: 'h', title: 'Clocks', artist: 'Coldplay', album: '', duration: 307, size: 2 },
  ]);
  assert.deepEqual(groups.map(g => [g.title, g.items.map(i => i.id), g.keepId]), [
    ['Clocks', ['g', 'h'], 'g'],      // unknown length joins; real album wins over size
    ['heaven', ['b', 'a'], 'b'],      // named after the keeper; remix (7 min) and other artist left out; real album wins
  ]);
});

test('planZuneUpdate removes deleted songs from the Zune unless another copy stays', () => {
  const pending = [
    { path: '/m/junk.mp3', fileName: 'junk.mp3', before: { title: 'Junk', artist: 'X' }, action: 'delete' },
    { path: '/m/dup.mp3', fileName: 'dup.mp3', before: { title: 'Song', artist: 'Y' }, action: 'delete' },
    { path: '/m/gone.mp3', fileName: 'gone.mp3', before: { title: 'G', artist: 'G' }, action: 'delete', removedFromZune: true },
    { path: '/m/never.mp3', fileName: 'never.mp3', before: { title: 'Never', artist: 'Z' }, action: 'delete' },
  ];
  const device = [
    { handle: 7, filename: 'junk.mp3', title: 'Junk', artist: 'X' },
    { handle: 8, filename: 'dup.mp3', title: 'Song', artist: 'Y' },
  ];
  const plan = L.planZuneUpdate(pending, device, new Map(), { libraryKeys: new Set([L.tagKey('Song', 'Y')]) });
  assert.deepEqual(plan.remove, [{ path: '/m/junk.mp3', handle: 7 }]);
  assert.deepEqual(plan.kept, ['/m/dup.mp3']);
  assert.deepEqual(plan.upToDate, ['/m/gone.mp3']);
  assert.deepEqual(plan.notOnZune, ['/m/never.mp3']);
  assert.deepEqual(plan.replace, []);
  assert.deepEqual(plan.resend, []);
});

test('duplicate keeper prefers the original album, the Music folder and real files over copies', () => {
  const groups = L.findDuplicateGroups([
    // Same song on a compilation (bigger file) vs. the original album
    { id: 'comp', title: 'Clocks', artist: 'Coldplay', album: 'Now That’s What I Call Music! 54', duration: 307, size: 12.3e6, where: '/Music/Now 54/Clocks.mp3', hasArt: true, trackNumber: 3, year: 2003 },
    { id: 'orig', title: 'Clocks', artist: 'Coldplay', album: 'A Rush of Blood to the Head', duration: 307, size: 12.2e6, where: '/Music/Coldplay/Clocks.mp3', hasArt: true, trackNumber: 5, year: 2002 },
    // Identical file sitting in Downloads, and a Finder-style "(1)" copy
    { id: 'dl', title: 'Heaven', artist: 'DJ Sammy', album: 'Heaven', duration: 230, size: 9.2e6, where: '/Users/me/Downloads/Heaven.mp3', trackNumber: 3 },
    { id: 'lib', title: 'Heaven', artist: 'DJ Sammy', album: 'Heaven', duration: 230, size: 9.2e6, where: '/Users/me/Music/Heaven.mp3', trackNumber: 3 },
    { id: 'one', title: 'Heaven', artist: 'DJ Sammy', album: 'Heaven', duration: 230, size: 9.2e6, where: '/Users/me/Music/Heaven (1).mp3', trackNumber: 3 },
    // Low bitrate rip vs. good one; the bad one has a website as its album
    { id: 'low', title: 'Song', artist: 'A', album: 'DOPEHOOD.COM', duration: 200, size: 3.2e6, where: '/Music/a.mp3' },
    { id: 'hi', title: 'Song', artist: 'A', album: 'Album', duration: 200, size: 8e6, where: '/Music/b.mp3' },
  ]);
  const byTitle = Object.fromEntries(groups.map(g => [g.title, g]));

  assert.equal(byTitle.Clocks.keepId, 'orig');
  assert.equal(byTitle.Clocks.kind, 'different');
  assert.ok(byTitle.Clocks.items[0].good.includes('original album'));
  assert.ok(byTitle.Clocks.items[1].bad.includes('compilation'));

  assert.equal(byTitle.Heaven.keepId, 'lib');
  assert.equal(byTitle.Heaven.kind, 'identical');
  const notes = Object.fromEntries(byTitle.Heaven.items.map(i => [i.id, i.bad]));
  assert.ok(notes.dl.includes('in downloads/desktop'));
  assert.ok(notes.one.includes('looks like a copy'));

  assert.equal(byTitle.Song.keepId, 'hi');
  assert.equal(byTitle.Song.kind, 'messy'); // the extra only adds junk tags and lower quality
  assert.ok(byTitle.Song.items[1].bad.some(b => /lower quality \(128 kbps\)/.test(b)));
});

test('a song named "Part 2" is not mistaken for a copy', () => {
  const groups = L.findDuplicateGroups([
    { id: 'x', title: 'Intro', artist: 'A', album: 'Album', duration: 60, size: 2e6, where: '/Music/Album/Part 2.mp3' },
    { id: 'y', title: 'Intro', artist: 'A', album: 'Album', duration: 60, size: 2e6, where: '/Music/Other/Intro.mp3' },
  ]);
  assert.ok(!groups[0].items.some(i => i.bad.includes('looks like a copy')));
});

test('titleSearchTerms cleans messy titles but keeps numbers that are part of the name', () => {
  const t = (title, artist, file = '/m/x.mp3') => L.titleSearchTerms({ title, artist }, file);
  assert.equal(t('1-11_March_2005-02-DJ_Sammy-Heaven(1-11_remix)', 'Unknown Artist').text, 'dj sammy heaven remix');
  assert.equal(t('{09316835-3188-481c-a359-0f8d2a937ac8} - DJ Got Us Falling In Love - Usher').text, 'dj got us falling in love usher');
  assert.equal(t('Usher - OMG (Official Music Video) [www.dopehood.com] 320kbps').text, 'usher omg');
  assert.equal(t('', '', '/m/03 Coldplay - Clocks.mp3').text, 'coldplay clocks');
  assert.equal(t('99 Problems', 'Jay-Z').text, '99 problems');
  assert.equal(t('7 Rings').text, '7 rings');
  assert.equal(t('2012 (Tags)', 'Jay Sean').text, '2012 tags');
  assert.equal(t('2012 (Tags)', 'Jay Sean').artist, 'Jay Sean');
  assert.equal(t('x', '{09316835-3188-481c-a359-0f8d2a937ac8}').artist, '');
});

test('titleSearchQueries searches title words against the known artist first', () => {
  const q = L.titleSearchQueries(L.titleSearchTerms({ title: 'Jay Sean - Down', artist: 'Jay Sean' }, '/m/x.mp3'));
  assert.equal(q[0], 'recording:(down) AND artist:(jay sean)');
  assert.equal(q[1], 'recording:(jay sean down) AND artist:(jay sean down)');
  assert.deepEqual(L.titleSearchQueries({ text: '', artist: '' }), []);
});

// Shaped like MusicBrainz /ws/2/recording?query=...&fmt=json
const mbHeaven = {
  recordings: [
    { id: 'wrong', score: 100, title: 'Heaven', length: 245000, 'artist-credit': [{ name: 'Bryan Adams' }], releases: [] },
    { id: 'long', score: 95, title: 'Heaven (Extended Mix)', length: 412000, 'artist-credit': [{ name: 'DJ Sammy' }], releases: [] },
    {
      id: 'rec-heaven', score: 90, title: 'Heaven', length: 231000,
      'artist-credit': [{ name: 'DJ Sammy', joinphrase: ' & ' }, { name: 'Yanou' }],
      releases: [
        { id: 'r1', title: 'Heaven', date: '2002-06-10', 'release-group': { id: 'rg-album', 'primary-type': 'Album', 'secondary-types': [] },
          media: [{ position: 1, track: [{ number: '3' }] }] },
        { id: 'r2', title: 'Now 54', date: '2003', 'release-group': { id: 'rg-now', 'primary-type': 'Album', 'secondary-types': ['Compilation'] },
          media: [{ position: 1, track: [{ number: '12' }] }] },
      ],
    },
  ],
};

test('pickTitleSearchMatch needs the title and artist words in the messy title, and a matching length', () => {
  const terms = L.titleSearchTerms({ title: '1-11_March_2005-02-DJ_Sammy-Heaven(1-11_remix)' }, '/m/x.mp3');
  const p = L.pickTitleSearchMatch(mbHeaven, terms, 230);
  assert.equal(p.source, 'title');
  assert.equal(p.recordingId, 'rec-heaven');      // not Bryan Adams (artist not in title), not the 7-minute mix
  assert.equal(p.artist, 'DJ Sammy & Yanou');
  assert.equal(p.album, 'Heaven');
  assert.equal(p.year, 2002);
  assert.equal(p.trackNumber, 3);
  assert.equal(p.releaseGroupId, 'rg-album');
  assert.ok(p.score > 0.5 && p.score <= 0.95);
  assert.deepEqual(p.albums.map(a => a.album), ['Heaven', 'Now 54']);

  // Wrong length (a 4-minute file) rules out the 3:51 recording
  assert.equal(L.pickTitleSearchMatch(mbHeaven, terms, 300), null);
  // Title words missing from what we have -> no match
  const other = L.titleSearchTerms({ title: 'DJ Sammy - Sunlight' }, '/m/x.mp3');
  assert.equal(L.pickTitleSearchMatch(mbHeaven, other, 230), null);
});

test('copies with junk artists are grouped with the clean song and marked messy', () => {
  const G = '{09316835-3188-481c-a359-0f8d2a937ac8}';
  const groups = L.findDuplicateGroups([
    { id: 'clean', title: 'DJ Got Us Falling In Love', artist: 'Usher', album: 'Versus', duration: 221, size: 8.8e6, where: '/Music/Usher/DJ Got Us Falling In Love.mp3', hasArt: true },
    // Copied off the Zune: ID artist, title from the file name
    { id: 'zcopy', title: `${G} - DJ Got Us Falling In Love`, artist: 'Unknown Artist', album: 'Unknown Album', duration: 222, size: 8.9e6, where: `/Music/${G} - DJ Got Us Falling In Love.mp3` },
    // Old download named "ID - Title - Artist"
    { id: 'old', title: `${G} - DJ Got Us Falling In Love - Usher`, artist: G, album: 'DOPEHOOD.COM', duration: 221, size: 5e6, where: '/Downloads/x.mp3' },
    // Same title, different real artist: a different song
    { id: 'other', title: 'DJ Got Us Falling In Love', artist: 'Someone Else', album: 'Covers', duration: 221, size: 8e6, where: '/Music/o.mp3' },
  ]);
  // Two real artists share the title: the copy named "... - Usher" still joins
  // Usher's song, but the copy with no artist at all can't be placed
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].items.map(i => i.id).sort(), ['clean', 'old']);

  const g2 = L.findDuplicateGroups([
    { id: 'clean', title: 'DJ Got Us Falling In Love', artist: 'Usher', album: 'Versus', duration: 221, size: 8.8e6, where: '/Music/Usher/a.mp3', hasArt: true },
    { id: 'zcopy', title: `${G} - DJ Got Us Falling In Love`, artist: 'Unknown Artist', album: 'Unknown Album', duration: 222, size: 8.9e6, where: `/Music/${G} - DJ Got Us Falling In Love.mp3` },
    { id: 'old', title: `${G} - DJ Got Us Falling In Love - Usher`, artist: G, album: 'DOPEHOOD.COM', duration: 221, size: 5e6, where: '/Downloads/x.mp3' },
  ]);
  assert.equal(g2.length, 1);
  assert.equal(g2[0].keepId, 'clean');
  assert.equal(g2[0].kind, 'messy');
  assert.deepEqual(g2[0].items.map(i => i.id).sort(), ['clean', 'old', 'zcopy']);
  assert.equal(g2[0].title, 'DJ Got Us Falling In Love');
});

test('a messy copy of a different length is not grouped, and two clean versions stay "different"', () => {
  const groups = L.findDuplicateGroups([
    { id: 'a', title: 'Heaven', artist: 'DJ Sammy', album: 'Heaven', duration: 230, size: 9e6, where: '/Music/a.mp3' },
    { id: 'b', title: 'Heaven', artist: 'Unknown Artist', album: '', duration: 420, size: 9e6, where: '/Music/b.mp3' }, // extended mix
    { id: 'c', title: 'Clocks', artist: 'Coldplay', album: 'A Rush of Blood to the Head', duration: 307, size: 12e6, where: '/Music/c.mp3' },
    { id: 'd', title: 'Clocks', artist: 'Coldplay', album: 'Live 2003', duration: 307, size: 11e6, where: '/Music/d.mp3' },
  ]);
  assert.deepEqual(groups.map(g => [g.title, g.kind, g.items.length]), [['Clocks', 'different', 2]]);
});

test('planZuneUpdate uses known links for songs copied off the Zune and then fixed', () => {
  const G = '{09316835-3188-481c-a359-0f8d2a937ac8}';
  const pending = [
    // Copied off the Zune (no tags), then fixed: name and old tags share nothing with the Zune copy
    { path: `/Music/${G} - DJ Got Us Falling In Love.mp3`, fileName: `${G} - DJ Got Us Falling In Love.mp3`, before: { title: '', artist: '' } },
    // Only on the Mac
    { path: '/Music/mac-only.mp3', fileName: 'mac-only.mp3', before: { title: 'Old', artist: 'X' } },
    // Already updated earlier: the Zune copy has the new tags
    { path: '/Music/done.mp3', fileName: 'done.mp3', before: { title: 'Was', artist: 'Y' } },
  ];
  const device = [
    { handle: 501, filename: 'unknown album', title: 'DJ Got Us Falling In Love', artist: G, album: '' },
    { handle: 777, filename: 'done.mp3', title: 'Now', artist: 'Y', album: 'Real' },
  ];
  const current = new Map([
    [pending[0].path, { title: 'DJ Got Us Falling In Love', artist: 'Usher', album: 'Versus' }],
    ['/Music/mac-only.mp3', { title: 'New', artist: 'X', album: 'A' }],
    ['/Music/done.mp3', { title: 'Now', artist: 'Y', album: 'Real' }],
  ]);
  const linked = new Map([[pending[0].path, 501]]);

  const without = L.planZuneUpdate(pending, device, current);
  assert.deepEqual(without.replace, [], 'without links the copied song looks "not on zune" (the bug)');

  const plan = L.planZuneUpdate(pending, device, current, { linked });
  assert.deepEqual(plan.replace, [{ path: pending[0].path, handle: 501 }]);
  assert.deepEqual(plan.notOnZune, ['/Music/mac-only.mp3']);
  assert.deepEqual(plan.upToDate, ['/Music/done.mp3']);
});

test('a stale link to a deleted Zune copy falls back to the other ways of matching', () => {
  const pending = [{ path: '/m/s.mp3', fileName: 's.mp3', before: { title: 'Song', artist: 'A' } }];
  const device = [{ handle: 9, filename: 's.mp3', title: 'Song', artist: 'A', album: 'old' }];
  const plan = L.planZuneUpdate(pending, device, new Map([['/m/s.mp3', { title: 'Song', artist: 'A', album: 'new' }]]), { linked: new Map([['/m/s.mp3', 12345]]) });
  assert.deepEqual(plan.replace, [{ path: '/m/s.mp3', handle: 9 }]);
});

test('numbered copies ("Song (2)") made by repeated copying group with the original', () => {
  const G = '{09316835-3188-481c-a359-0f8d2a937ac8}';
  const mk = (id, n) => ({ id, title: `${G} - 8-Bit Trip${n ? ` (${n})` : ''}`, artist: 'Unknown Artist', album: 'Unknown Album', duration: 180, size: 4e6, where: `/Music/${G} - 8-Bit Trip${n ? ` (${n})` : ''}.mp3` });
  const groups = L.findDuplicateGroups([mk('a'), mk('b', 2), mk('c', 3), mk('d', 4),
    // A real song whose title ends in a number in brackets stays itself
    { id: 'x', title: 'Track (2)', artist: 'Band', album: 'A', duration: 100, where: '/m/x.mp3' },
    { id: 'y', title: 'Track', artist: 'Band', album: 'A', duration: 100, where: '/m/y.mp3' }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, '8-Bit Trip');
  assert.equal(groups[0].items.length, 4);
  assert.equal(groups[0].keepId, 'a'); // the un-numbered one; the others "look like a copy"
});

test('cleanTagText removes ID codes, websites and video junk', () => {
  assert.equal(L.cleanTagText('www.EveryoneLovesHipHop.com'), '');
  assert.equal(L.cleanTagText('DOPEHOOD.COM'), '');
  assert.equal(L.cleanTagText('Newgrounds Audio Portal - http://www.newgrounds.com/audio'), 'Newgrounds Audio Portal');
  assert.equal(L.cleanTagText('WWW.BUMSQUADDJZ.COM (NEW MUSIC STUDIO RELOADED)'), 'NEW MUSIC STUDIO RELOADED');
  assert.equal(L.cleanTagText('Usher - OMG (Official Music Video) [www.dopehood.com] 320kbps'), 'Usher - OMG');
  assert.equal(L.cleanTagText('{09316835-3188-481c-a359-0f8d2a937ac8} - Down'), 'Down');
  assert.equal(L.cleanTagText('-~-BEST TECHNO SONG EVER-~-'), 'BEST TECHNO SONG EVER');
  assert.equal(L.cleanTagText('LMFAO Feat Lauren Bennett amp Goon Rock'), 'LMFAO Feat Lauren Bennett & Goon Rock');
  // Real names are left alone
  assert.equal(L.cleanTagText('We R Who We R (Clean)'), 'We R Who We R (Clean)');
  assert.equal(L.cleanTagText('Mr. Brightside'), 'Mr. Brightside');
  assert.equal(L.cleanTagText('8-Bit Trip'), '8-Bit Trip');
});

test('proposeCleanTags splits "Artist - Title", fixes case, and keeps numbers in names', () => {
  const G = '{09316835-3188-481c-a359-0f8d2a937ac8}';
  const p = (title, artist = 'Unknown Artist', album = 'Unknown Album') => L.proposeCleanTags({ title, artist, album }, '/m/x.mp3', new Set(['basshunter']));
  assert.deepEqual(p(`${G} - headhunters - the power of the mind`), { title: 'The Power Of The Mind', artist: 'Headhunters', album: '' });
  assert.deepEqual(p(`${G} - Basshunter-Welcome To Rainbow Hardstyle Mix`), { title: 'Welcome To Rainbow Hardstyle Mix', artist: 'Basshunter', album: '' });
  assert.deepEqual(p(`${G} - Flo-rida Lady Gaga J.Timberlake PCD`), { title: 'Flo-rida Lady Gaga J.Timberlake PCD', artist: '', album: '' }); // unknown artist: no split on "-"
  assert.deepEqual(p(`${G} - 8-Bit Trip`), { title: '8-Bit Trip', artist: '', album: '' });
  assert.deepEqual(p('03 Coldplay - Clocks'), { title: 'Clocks', artist: 'Coldplay', album: '' });
  assert.deepEqual(p('99 Problems', 'Jay-Z', 'The Black Album'), { title: '99 Problems', artist: 'Jay-Z', album: 'The Black Album' });
});

test('cleanupProposal empties fields that only held junk', () => {
  const r = L.cleanupProposal({ title: 'All Mine', artist: 'Kevin Rudolf', album: 'DOPEHOOD.COM' }, '/m/x.mp3');
  assert.equal(r.source, 'cleanup');
  assert.equal(r.title, 'All Mine');
  assert.equal(r.artist, 'Kevin Rudolf');
  assert.equal(r.album, null);
  assert.deepEqual(r.clear, ['album']);
  // "Unknown Album" is a placeholder the library shows, not something to clear
  assert.deepEqual(L.cleanupProposal({ title: 'x - y', artist: 'Unknown Artist', album: 'Unknown Album' }, '/m/x.mp3').clear, []);
});

test('sortSongs orders by name, length, quality and messiness', () => {
  const songs = [
    { t: 'Clocks', a: 'Coldplay', al: 'A Rush of Blood', d: 307, s: 12e6 },   // ~313 kbps
    { t: 'Angel', a: 'Akon', al: 'DOPEHOOD.COM', d: 200, s: 3.2e6 },          // 128 kbps, website album
    { t: 'Zombie', a: 'The Cranberries', al: '', d: 0, s: 5e6 },              // unknown length
    { t: '99 Problems', a: 'Jay-Z', al: 'The Black Album', d: 234, s: 9.0e6 },   // ~308 kbps
  ];
  const get = (x) => ({ title: x.t, artist: x.a, album: x.al, duration: x.d, size: x.s, path: `/m/${x.t}.mp3` });
  const order = (key) => L.sortSongs(songs, key, get).map(x => x.t);
  assert.deepEqual(order('title'), ['99 Problems', 'Angel', 'Clocks', 'Zombie']);
  assert.deepEqual(order('artist'), ['Akon', 'Coldplay', 'Jay-Z', 'The Cranberries'].map(a => songs.find(s => s.a === a).t));
  assert.deepEqual(order('album'), ['Clocks', 'Angel', '99 Problems', 'Zombie']); // "" last
  assert.deepEqual(order('longest'), ['Clocks', '99 Problems', 'Angel', 'Zombie']); // unknown last
  assert.deepEqual(order('shortest'), ['Angel', '99 Problems', 'Clocks', 'Zombie']);
  assert.deepEqual(order('best'), ['Clocks', '99 Problems', 'Angel', 'Zombie']);
  assert.deepEqual(order('worst'), ['Angel', '99 Problems', 'Clocks', 'Zombie']);
  assert.equal(order('messy')[0], 'Angel');
  assert.equal(L.kbpsFrom(12e6, 307), 313);
});

test('planZuneUpdate replaces a Zune copy when only the cover art changed', () => {
  const pending = [{ path: '/m/s.mp3', fileName: 's.mp3', before: { title: 'Song', artist: 'A', album: 'B' }, artChanged: true }];
  const device = [{ handle: 3, filename: 's.mp3', title: 'Song', artist: 'A', album: 'B' }];
  const current = new Map([['/m/s.mp3', { title: 'Song', artist: 'A', album: 'B' }]]);
  assert.deepEqual(L.planZuneUpdate(pending, device, current).replace, [{ path: '/m/s.mp3', handle: 3 }]);
  // Without the art flag the same copy counts as up to date
  assert.deepEqual(L.planZuneUpdate([{ ...pending[0], artChanged: false }], device, current).upToDate, ['/m/s.mp3']);
});

test('planZuneUpdate treats "Unknown Album" and a blank album as the same (no endless re-sync)', () => {
  const pending = [{ path: '/m/s.mp3', fileName: 's.mp3', before: { title: 'Old', artist: 'A' } }];
  const device = [{ handle: 3, filename: 's.mp3', title: 'Song', artist: 'A', album: '' }];
  const current = new Map([['/m/s.mp3', { title: 'Song', artist: 'A', album: 'Unknown Album' }]]);
  assert.deepEqual(L.planZuneUpdate(pending, device, current).upToDate, ['/m/s.mp3']);
});
