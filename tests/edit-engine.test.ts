import { test, expect } from 'vitest';
import { applyUniqueEdit as edit } from '../src/index.js';
test('exact splice preserves BOM and all untouched bytes', () => {
  expect(
    edit('\uFEFFbefore  \r\nhello\r\nafter  ', 'hello', 'new\nline'),
  ).toEqual({
    ok: true,
    content: '\uFEFFbefore  \r\nnew\nline\r\nafter  ',
    matchedBy: 'exact',
    line: 2,
  });
});
test('reject empty, unchanged, missing, and non-unique strings', () => {
  expect(edit('a', '', 'b')).toMatchObject({
    ok: false,
    reason: 'empty_old_string',
  });
  expect(edit('a', 'a', 'a')).toMatchObject({ ok: false, reason: 'unchanged' });
  expect(edit('aaa', 'a', 'b')).toEqual({
    ok: false,
    reason: 'not_unique',
    count: 3,
  });
  expect(edit('a', 'z', 'b')).toEqual({ ok: false, reason: 'not_found' });
});
test('normalized multiline edit preserves untouched trailing spaces, quotes, CRLF, and BOM', () => {
  const source =
    '\uFEFFkeep “quote”  \r\nprefix ‘hello’ — Ａ  \r\nworld\u202Fend suffix\r\nlast  \r\n';
  expect(edit(source, "'hello' - A\nworld end", 'new\nvalue')).toEqual({
    ok: true,
    content: '\uFEFFkeep “quote”  \r\nprefix new\r\nvalue suffix\r\nlast  \r\n',
    matchedBy: 'normalized',
    line: 2,
  });
});
test.each([
  ['prefix “hi” suffix', '"hi"', 'prefix NEW suffix'],
  ['a\u00A0b', 'a b', 'NEW'],
  ['a\u2007b', 'a b', 'NEW'],
  ['cafe\u0301', 'café', 'NEW'],
  ['ﬃ', 'ffi', 'NEW'],
  ['“a”  \nnext', '"a"\nnext', 'NEW'],
])(
  'maps normalized characters back to exact offsets: %s',
  (source, old, expected) => {
    expect(edit(source, old, 'NEW')).toMatchObject({
      ok: true,
      content: expected,
      matchedBy: 'normalized',
    });
  },
);
test('does not split normalization expansions', () => {
  expect(edit('ﬃ', 'f', 'x')).toMatchObject({ ok: false, reason: 'not_found' });
});
test('rejects ambiguous normalized matches', () => {
  expect(edit('“hi”\n“hi”', '"hi"', 'x')).toEqual({
    ok: false,
    reason: 'ambiguous_normalized',
    count: 2,
  });
});

test('normalized edits use replaced-region line endings instead of file majority', () => {
  expect(
    edit('lf\nlf\nlf\n“a”  \r\nb  \r\ntail\n', '"a"\nb', 'x\ny'),
  ).toMatchObject({ ok: true, content: 'lf\nlf\nlf\nx\r\ny  \r\ntail\n' });
  expect(
    edit('crlf\r\ncrlf\r\ncrlf\r\n“a” \nb \nend\r\n', '"a"\nb', 'x\r\ny'),
  ).toMatchObject({
    ok: true,
    content: 'crlf\r\ncrlf\r\ncrlf\r\nx\ny \nend\r\n',
  });
});
test('single-line normalized match adopts the nearest newline context', () => {
  expect(
    edit('many\nmany\nmany\nlocal\r\n“a”\r\nend', '"a"', 'x\ny'),
  ).toMatchObject({
    ok: true,
    content: 'many\nmany\nmany\nlocal\r\nx\r\ny\r\nend',
  });
});
