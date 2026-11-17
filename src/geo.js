/**
 * Geo data of a post or a profile (`extractGeo` input).
 *
 * What TikTok exposes (checked on real pages, see README "Geo data"):
 *  - post page: `locationCreated` (ISO country the post was made in) and, only
 *    when the creator tagged a place, a `poi` / location tag with name, address,
 *    city and GeoNames ids. Latitude/longitude are returned when the page's JSON
 *    carries them; `findCoordinates` scans the whole raw item for any lat/lng
 *    pair so a new TikTok field name is picked up (and reported) automatically.
 *  - profile page: `user.region` (account country) and `user.language`; no
 *    coordinates.
 *
 * Coordinates are turned into a place offline: country with
 * @rapideditor/country-coder (border polygons, ISO 3166-1 codes) and the nearest
 * known city with offline-geocode-city. No network call, no API key.
 */
import * as countryCoder from '@rapideditor/country-coder';
import { getNearestCity } from 'offline-geocode-city';

const LAT_KEYS = ['latitude', 'lat', 'poilatitude', 'poi_latitude', 'poilat'];
const LNG_KEYS = ['longitude', 'lng', 'lon', 'long', 'poilongitude', 'poi_longitude', 'poilng'];
const PLACE_KEY = /(^|_)(poi|location|region|country|city|address|geo|place)/i;

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) ? n : null;
}

function validPair(lat, lng) {
  if (lat === null || lng === null) return false;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
  // 0,0 is TikTok's "no value", not a place in the Gulf of Guinea.
  return !(lat === 0 && lng === 0);
}

/**
 * Every latitude/longitude pair anywhere in `obj` (objects holding both a
 * latitude-like and a longitude-like key). Returns [{ path, latitude, longitude }].
 */
export function findCoordinates(obj, { maxDepth = 8 } = {}) {
  const found = [];
  const seen = new Set();
  const walk = (node, path, depth) => {
    if (!node || typeof node !== 'object' || depth > maxDepth || seen.has(node)) return;
    seen.add(node);
    if (!Array.isArray(node)) {
      const lower = Object.fromEntries(Object.keys(node).map((key) => [key.toLowerCase(), key]));
      const latKey = LAT_KEYS.find((key) => key in lower);
      const lngKey = LNG_KEYS.find((key) => key in lower);
      if (latKey && lngKey) {
        const latitude = toNumber(node[lower[latKey]]);
        const longitude = toNumber(node[lower[lngKey]]);
        if (validPair(latitude, longitude)) found.push({ path: path || '$', latitude, longitude });
      }
    }
    for (const [key, value] of Object.entries(node)) walk(value, `${path}.${key}`, depth + 1);
  };
  walk(obj, '', 0);
  return found;
}

/** Country (ISO alpha-2) and nearest city for a coordinate, fully offline. */
export function reverseGeocode(latitude, longitude) {
  if (!validPair(toNumber(latitude), toNumber(longitude))) return null;
  const country = countryCoder.iso1A2Code([longitude, latitude]) || null;
  let nearest = null;
  try {
    nearest = getNearestCity(latitude, longitude);
  } catch {
    nearest = null;
  }
  return {
    countryCode: country || nearest?.countryIso2 || null,
    country: country ? (countryCoder.feature([longitude, latitude])?.properties?.nameEn ?? nearest?.countryName ?? null) : (nearest?.countryName ?? null),
    nearestCity: nearest?.cityName ?? null,
  };
}

/** Flat list of the place-like fields of a raw object, for discovering what TikTok sends. */
export function placeFields(obj, { maxDepth = 6, limit = 60 } = {}) {
  const out = {};
  const seen = new Set();
  const walk = (node, path, depth) => {
    if (!node || typeof node !== 'object' || depth > maxDepth || seen.has(node) || Object.keys(out).length >= limit) return;
    seen.add(node);
    for (const [key, value] of Object.entries(node)) {
      const next = path ? `${path}.${key}` : key;
      if (value !== null && typeof value === 'object') {
        if (PLACE_KEY.test(key) && !Array.isArray(value)) out[next] = '{…}';
        walk(value, next, depth + 1);
      } else if (PLACE_KEY.test(key) || /(^|\.)(poi|location)\./i.test(next)) {
        out[next] = typeof value === 'string' ? value.slice(0, 120) : value;
      }
    }
  };
  walk(obj, '', 0);
  return out;
}

function poiOf(raw) {
  const poi = raw?.poi || raw?.poiInfo || raw?.locationInfo || null;
  return poi && typeof poi === 'object' ? poi : null;
}

/**
 * Geo block of one post (raw TikTok item).
 * `coordinates` = first lat/lng pair found; `place` = what that pair resolves to.
 */
export function extractPostGeo(raw, { debug = false } = {}) {
  const pairs = findCoordinates(raw);
  const first = pairs[0] || null;
  const poi = poiOf(raw);
  const geo = {
    locationCreated: raw?.locationCreated || null,
    coordinates: first ? { latitude: first.latitude, longitude: first.longitude, source: first.path } : null,
    place: first ? reverseGeocode(first.latitude, first.longitude) : null,
    poi: poi
      ? {
        id: poi.id ?? poi.poiId ?? null,
        name: poi.name ?? poi.title ?? null,
        address: poi.address ?? null,
        city: poi.city ?? null,
        cityCode: poi.cityCode ?? null,
        countryCode: poi.countryCode ?? null,
        type: poi.type ?? poi.typeCode ?? null,
      }
      : null,
    // Country used by the prefilter: coordinates beat the page's country tag.
    countryCode: null,
    countrySource: null,
  };
  if (geo.place?.countryCode) {
    geo.countryCode = geo.place.countryCode;
    geo.countrySource = 'coordinates';
  } else if (geo.locationCreated) {
    geo.countryCode = String(geo.locationCreated).toUpperCase();
    geo.countrySource = 'locationCreated';
  }
  if (debug) geo.debug = { coordinatePairs: pairs, placeFields: placeFields(raw) };
  return geo;
}

/**
 * Geo block of one profile (raw webapp.user-detail userInfo). TikTok gives the
 * account's region, never coordinates; any pair that does appear is still returned.
 */
export function extractProfileGeo(userInfo, { debug = false } = {}) {
  const user = userInfo?.user || {};
  const pairs = findCoordinates(userInfo);
  const first = pairs[0] || null;
  const geo = {
    region: user.region || null,
    language: user.language || null,
    coordinates: first ? { latitude: first.latitude, longitude: first.longitude, source: first.path } : null,
    place: first ? reverseGeocode(first.latitude, first.longitude) : null,
    countryCode: null,
    countrySource: null,
  };
  if (geo.place?.countryCode) {
    geo.countryCode = geo.place.countryCode;
    geo.countrySource = 'coordinates';
  } else if (geo.region) {
    geo.countryCode = String(geo.region).toUpperCase();
    geo.countrySource = 'region';
  }
  if (debug) {
    geo.debug = {
      coordinatePairs: pairs,
      placeFields: placeFields(userInfo),
      userKeys: Object.keys(user).sort(),
      userInfoKeys: Object.keys(userInfo || {}).sort(),
    };
  }
  return geo;
}
