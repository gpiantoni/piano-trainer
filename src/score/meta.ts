// Score metadata and file types. Pure (no DOM, no verovio): used by the app's
// import, by vite.config.ts for the bundled manifest, and by the Node tests.

export type ScoreKind = 'xml' | 'mxl';
export type ScoreMeta = { title: string; composer: string };

// .xml is what MuseScore 3 and many other apps export; .mxl is zipped MusicXML.
export const SCORE_EXTENSIONS = ['.musicxml', '.xml', '.mxl'] as const;

export function scoreKind(fileName: string): ScoreKind | undefined {
  const name = fileName.toLowerCase();
  if (name.endsWith('.mxl')) return 'mxl';
  if (name.endsWith('.musicxml') || name.endsWith('.xml')) return 'xml';
  return undefined;
}

// "Etude C-dur.musicxml" -> "Etude C-dur": the title of last resort.
export const baseName = (path: string) =>
  (path.split('/').pop() ?? path).replace(/\.(musicxml|xml|mxl)$/i, '');

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === '#'
      ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
      : ENTITIES[e] ?? m);
}

const tag = (xml: string, re: RegExp) => decode(xml.match(re)?.[1].trim() ?? '');

// The header sits at the top of the file; don't regex a whole 500 KB score.
export function musicXmlMeta(xml: string): ScoreMeta {
  const head = xml.slice(0, 4000);
  return {
    title: tag(head, /<work-title>([^<]*)</) || tag(head, /<movement-title>([^<]*)</),
    composer: tag(head, /<creator type="composer">([^<]*)</),
  };
}

// Verovio's MEI header, for .mxl files whose MusicXML we never see as text.
export function meiMeta(mei: string): ScoreMeta {
  const head = mei.slice(0, mei.indexOf('</meiHead>') + 1 || 4000);
  return {
    title: tag(head, /<title(?:\s[^>]*)?>([^<]*)</),     // not <titleStmt>
    composer: tag(head, /<persName\s[^>]*role="composer"[^>]*>([^<]*)</),
  };
}
