import test from 'node:test';
import assert from 'node:assert/strict';
import { findCoordinates, reverseGeocode, extractPostGeo, extractProfileGeo } from '../src/geo.js';

test('findCoordinates finds a lat/lng pair at any depth, with string values', () => {
  const found = findCoordinates({ a: { poi: { latitude: '-6.9175', longitude: '107.6191' } } });
  assert.equal(found.length, 1);
  assert.equal(found[0].path, '.a.poi');
  assert.equal(found[0].latitude, -6.9175);
});

test('findCoordinates ignores 0,0, out-of-range and lone keys', () => {
  assert.equal(findCoordinates({ latitude: 0, longitude: 0 }).length, 0);
  assert.equal(findCoordinates({ lat: 200, lng: 10 }).length, 0);
  assert.equal(findCoordinates({ latitude: 5 }).length, 0);
});

test('reverseGeocode resolves a country offline', () => {
  assert.equal(reverseGeocode(-6.2, 106.85).countryCode, 'ID');
  assert.equal(reverseGeocode(1.3521, 103.8198).countryCode, 'SG');
  assert.equal(reverseGeocode(40.7, -74).countryCode, 'US');
  assert.equal(reverseGeocode(0, 0), null);
});

test('extractPostGeo prefers coordinates over locationCreated', () => {
  const geo = extractPostGeo({ locationCreated: 'US', poi: { name: 'Bandung', latitude: -6.9, longitude: 107.6 } });
  assert.equal(geo.countryCode, 'ID');
  assert.equal(geo.countrySource, 'coordinates');
});

test('extractPostGeo falls back to locationCreated, then to nothing', () => {
  assert.deepEqual(
    (({ countryCode, countrySource }) => ({ countryCode, countrySource }))(extractPostGeo({ locationCreated: 'id' })),
    { countryCode: 'ID', countrySource: 'locationCreated' }
  );
  assert.equal(extractPostGeo({}).countryCode, null);
});

test('extractProfileGeo returns the account region', () => {
  const geo = extractProfileGeo({ user: { region: 'ID', language: 'id' } });
  assert.equal(geo.countryCode, 'ID');
  assert.equal(geo.countrySource, 'region');
  assert.equal(geo.coordinates, null);
});
