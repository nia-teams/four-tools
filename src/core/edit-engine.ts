export type EditResult =
  | {
      ok: true;
      content: string;
      matchedBy: 'exact' | 'normalized';
      line: number;
    }
  | {
      ok: false;
      reason:
        | 'empty_old_string'
        | 'unchanged'
        | 'not_found'
        | 'not_unique'
        | 'ambiguous_normalized';
      count?: number;
    };
const normalize = (s: string) =>
  s
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u202F\u2007]/g, ' ');
/** Only grapheme boundaries map back to source offsets; expansions are indivisible. */
function mapped(source: string) {
  let text = '';
  const starts = new Map<number, number>();
  const ends = new Map<number, number>();
  const lines = source.split(/\r\n|\n|\r/);
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimEnd();
    starts.set(text.length, offset);
    ends.set(text.length, offset);
    for (const segment of new Intl.Segmenter(undefined, {
      granularity: 'grapheme',
    }).segment(trimmed)) {
      starts.set(text.length, offset + segment.index);
      text += normalize(segment.segment);
      ends.set(text.length, offset + segment.index + segment.segment.length);
    }
    const eol = source.slice(offset + line.length).startsWith('\r\n') ? 2 : 1;
    if (i < lines.length - 1) {
      text += '\n';
      offset += line.length + eol;
      starts.set(text.length, offset);
      ends.set(text.length, offset);
    }
  }
  return { text, starts, ends };
}
function occurrences(
  haystack: string,
  needle: string,
  overlapping = false,
): number[] {
  const found: number[] = [];
  for (
    let at = 0;
    (at = haystack.indexOf(needle, at)) !== -1;
    at += overlapping ? 1 : needle.length
  )
    found.push(at);
  return found;
}
export function applyUniqueEdit(
  original: string,
  oldString: string,
  newString: string,
): EditResult {
  if (!oldString) return { ok: false, reason: 'empty_old_string' };
  if (oldString === newString) return { ok: false, reason: 'unchanged' };
  const bom = original.startsWith('\uFEFF') ? '\uFEFF' : '';
  const source = original.slice(bom.length);
  const exact = occurrences(source, oldString);
  if (exact.length > 1)
    return { ok: false, reason: 'not_unique', count: exact.length };
  let start: number, end: number;
  let matchedBy: 'exact' | 'normalized' = 'exact';
  if (exact.length) {
    start = exact[0];
    end = start + oldString.length;
  } else {
    const mapping = mapped(source);
    const needle = mapped(oldString).text;
    if (!needle) return { ok: false, reason: 'not_found' };
    const matches = occurrences(mapping.text, needle, true).filter(
      (at) => mapping.starts.has(at) && mapping.ends.has(at + needle.length),
    );
    if (!matches.length) return { ok: false, reason: 'not_found' };
    if (matches.length > 1)
      return {
        ok: false,
        reason: 'ambiguous_normalized',
        count: matches.length,
      };
    start = mapping.starts.get(matches[0])!;
    end = mapping.ends.get(matches[0] + needle.length)!;
    matchedBy = 'normalized';
    // Prefer the first replaced newline, then the nearest surrounding newline.
    const local = source.slice(start, end).match(/\r\n|\n/);
    const before = [...source.slice(0, start).matchAll(/\r\n|\n/g)].at(-1);
    const after = source.slice(end).match(/\r\n|\n/);
    const nearby =
      before &&
      (!after || start - (before.index! + before[0].length) <= after.index!)
        ? before
        : after;
    const eol = local?.[0] ?? nearby?.[0];
    if (eol) newString = newString.replace(/\r\n|\n/g, eol);
  }
  return {
    ok: true,
    content: bom + source.slice(0, start) + newString + source.slice(end),
    matchedBy,
    line: source.slice(0, start).split(/\r\n|\n|\r/).length,
  };
}
