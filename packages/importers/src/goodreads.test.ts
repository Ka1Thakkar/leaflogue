import { describe, expect, it } from "vitest";
import { parseGoodreadsCsv } from "./goodreads";
import { readCsv } from "./csv";

const header = 'Book Id,Title,Author,ISBN13,Exclusive Shelf,My Review';
const csv = (review = 'A personal reflection.') => `${header}\r\n42,"A title, with a comma",A Reader,"=""9780306406157""",read,"${review.replaceAll('"', '""')}"\r\n`;

describe('Goodreads CSV', () => {
  it('keeps stable book/review identity, quoted fields, multiline Unicode and standalone reviews', () => {
    const preview = parseGoodreadsCsv('\uFEFF' + csv('A "quiet" thought.\n第二行.'));
    expect(preview.document.books).toEqual([{ providerRecordId: 'goodreads:42', title: 'A title, with a comma', authors: ['A Reader'], isbn13: '9780306406157', status: 'finished' }]);
    expect(preview.document.annotations).toEqual([{ providerRecordId: 'goodreads:42:review', bookProviderRecordId: 'goodreads:42', note: 'A "quiet" thought.\n第二行.' }]);
    expect(parseGoodreadsCsv(csv('An edited review.')).document.annotations[0]?.providerRecordId).toBe(preview.document.annotations[0]?.providerRecordId);
  });
  it('supports shelves without reviews, without manufacturing quotations', () => {
    const parsed = parseGoodreadsCsv(`${header}\n1,Next book,, ,to-read,\n2,Current book,Reader,,currently-reading,`);
    expect(parsed.document.books.map(b => b.status)).toEqual(['unread', 'reading']);
    expect(parsed.document.annotations).toEqual([]);
  });
  it('warns about invalid ISBN and unsupported shelf without losing the book or review', () => {
    const parsed = parseGoodreadsCsv(`${header}\n1,Book,Reader,not-an-isbn,custom,A review`);
    expect(parsed.warnings).toHaveLength(2);
    expect(parsed.document.books[0]).not.toHaveProperty('status');
    expect(parsed.document.books[0]).not.toHaveProperty('isbn13');
    expect(parsed.document.annotations).toHaveLength(1);
  });
  it('refuses duplicate source IDs and unsupported headers instead of guessing the format', () => {
    expect(() => parseGoodreadsCsv(csv() + csv().split('\r\n')[1])).toThrow();
    expect(() => parseGoodreadsCsv('Title,Author\nA book,A person')).toThrow(/required columns/);
    expect(() => parseGoodreadsCsv(header)).toThrow(/no books/);
  });
  it.each(['a,"unfinished', 'a,"closed"garbage', 'a,un"quoted'])('rejects malformed CSV %s', source => {
    expect(() => readCsv(source)).toThrow(/CSV/);
  });
  it('bounds malformed width, cell size, bytes and control characters', () => {
    expect(() => readCsv(Array(102).fill('x').join(','))).toThrow(/columns/);
    expect(() => readCsv('a'.repeat(200_001))).toThrow(/cell/);
    expect(() => readCsv('x'.repeat(16 * 1024 * 1024 + 1))).toThrow(/MiB/);
    expect(() => readCsv('a,\u0000')).toThrow(/control/);
    expect(() => parseGoodreadsCsv(`${header}\n1,Only two`)).toThrow(/columns/);
  });
});

it('rejects oversized review bodies explicitly instead of truncating user writing', () => {
  expect(() => parseGoodreadsCsv(csv('é'.repeat(12_289)))).toThrow(/24 KiB/);
});
