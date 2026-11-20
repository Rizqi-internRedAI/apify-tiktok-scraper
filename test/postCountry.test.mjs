import test from 'node:test';
import assert from 'node:assert/strict';
import { keepByPostCountry, normalizeCountryList } from '../src/postCountry.js';

test('normalizeCountryList accepts arrays and strings, upper-cases and dedupes', () => {
  assert.deepEqual(normalizeCountryList(['id', ' ID ', 'my']), ['ID', 'MY']);
  assert.deepEqual(normalizeCountryList('id, my;sg'), ['ID', 'MY', 'SG']);
  assert.deepEqual(normalizeCountryList(undefined), []);
  assert.deepEqual(normalizeCountryList([null, '']), []);
});

test('empty allowed list keeps everything', () => {
  assert.equal(keepByPostCountry('US', [], true), true);
  assert.equal(keepByPostCountry(null, [], false), true);
});

test('keeps allowed countries (case-insensitive) and drops others', () => {
  assert.equal(keepByPostCountry('ID', ['ID']), true);
  assert.equal(keepByPostCountry('id', ['ID']), true);
  assert.equal(keepByPostCountry('US', ['ID']), false);
  assert.equal(keepByPostCountry('PH', ['ID', 'MY']), false);
});

test('unknown country follows keepUnknown', () => {
  assert.equal(keepByPostCountry(null, ['ID'], true), true);
  assert.equal(keepByPostCountry('', ['ID'], true), true);
  assert.equal(keepByPostCountry(undefined, ['ID'], false), false);
});
