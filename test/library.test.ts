import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseName, meiMeta, musicXmlMeta, scoreKind } from '../src/score/meta.ts';
import { ago, diffFolder, type FoundFile, type StoredFile } from '../src/library/scan.ts';

test('musicXmlMeta: work title, composer, entities', () => {
  const xml = `<score-partwise><work><work-title>Salt &amp; Pepper &#233;tude</work-title></work>
    <identification><creator type="composer">C. P. E. Bach</creator></identification>`;
  assert.deepEqual(musicXmlMeta(xml), { title: 'Salt & Pepper étude', composer: 'C. P. E. Bach' });
});

test('musicXmlMeta: falls back to the movement title; no composer is empty', () => {
  const xml = '<score-partwise><movement-title> Waltz </movement-title><part-list/>';
  assert.deepEqual(musicXmlMeta(xml), { title: 'Waltz', composer: '' });
  assert.deepEqual(musicXmlMeta('<score-partwise/>'), { title: '', composer: '' });
});

test('meiMeta reads verovio\'s header', () => {
  const mei = `<mei><meiHead xml:id="m1"><fileDesc><titleStmt xml:id="t1"><title>Minuet in G</title>
    <respStmt><persName role="composer">J. S. Bach</persName></respStmt></titleStmt></fileDesc></meiHead>
    <music><title>not this</title></music></mei>`;
  assert.deepEqual(meiMeta(mei), { title: 'Minuet in G', composer: 'J. S. Bach' });
});

test('scoreKind and baseName', () => {
  assert.equal(scoreKind('Waltz.musicxml'), 'xml');
  assert.equal(scoreKind('old/Waltz.XML'), 'xml');
  assert.equal(scoreKind('Waltz.mxl'), 'mxl');
  assert.equal(scoreKind('Waltz.pdf'), undefined);
  assert.equal(scoreKind('Waltz.mscz'), undefined);
  assert.equal(baseName('export/Etude C-dur.musicxml'), 'Etude C-dur');
});

const found = (path: string, lastModified = 1, size = 100): FoundFile => ({ path, lastModified, size });
const stored = (id: string, path: string, lastModified = 1, size = 100, missing = false): StoredFile =>
  ({ id, path, lastModified, size, missing });

test('diffFolder: new, changed, unchanged, deleted', () => {
  const d = diffFolder(
    [stored('a', 'A.musicxml'), stored('b', 'B.musicxml'), stored('c', 'C.musicxml'), stored('d', 'sub/D.mxl', 1, 5)],
    [found('A.musicxml'), found('B.musicxml', 2), found('sub/D.mxl', 1, 6), found('sub/deeper/E.musicxml')],
  );
  assert.deepEqual(d.add.map((a) => a.file.path), ['sub/deeper/E.musicxml']);
  assert.deepEqual(d.changed.map((c) => c.id), ['b', 'd']);           // date, then size
  assert.deepEqual(d.unchanged.map((u) => u.id), ['a']);
  assert.deepEqual(d.missing, ['c']);
});

test('diffFolder: a rename is missing + add; already-missing is not reported again', () => {
  const d = diffFolder([stored('a', 'Old.musicxml'), stored('m', 'Gone.musicxml', 1, 100, true)], [found('New.musicxml')]);
  assert.deepEqual(d.missing, ['a']);
  assert.deepEqual(d.add.map((a) => [a.file.path, a.adopt]), [['New.musicxml', undefined]]);
});

test('diffFolder: a score that comes back is no longer missing', () => {
  const d = diffFolder([stored('m', 'Back.musicxml', 1, 100, true)], [found('Back.musicxml')]);
  assert.deepEqual(d.unchanged.map((u) => u.id), ['m']);
  assert.deepEqual(d.missing, []);
});

test('diffFolder: relinking an unlinked folder adopts its old records by path', () => {
  const d = diffFolder([], [found('A.musicxml'), found('B.musicxml')], [stored('old-a', 'A.musicxml')]);
  assert.deepEqual(d.add.map((a) => a.adopt), ['old-a', undefined]);
});

test('ago', () => {
  const now = Date.parse('2026-09-13T12:00:00Z');
  assert.equal(ago(undefined, now), 'never');
  assert.equal(ago('2026-09-13T11:59:40Z', now), 'just now');
  assert.equal(ago('2026-09-13T11:15:00Z', now), '45 min ago');
  assert.equal(ago('2026-09-13T09:00:00Z', now), '3 h ago');
  assert.equal(ago('2026-09-10T12:00:00Z', now), '3 days ago');
});
