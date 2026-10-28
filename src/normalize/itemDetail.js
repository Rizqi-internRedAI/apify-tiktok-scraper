/**
 * normalize/itemDetail.js — Item extraction for the "scrape by post URL" mode
 *
 * Confirmed via a real run's logs (2026-09-18): TikTok's video detail page
 * is server-side rendered - the item data is embedded directly in the
 * initial HTML, NOT fetched via a separate XHR. /api/item_detail/ (this
 * file's original guess) never fires; the real API calls seen on that page
 * are unrelated (/api/related/item_list/, /tiktok/ppf/api/eligibility/v2).
 *
 * Primary path: read window.__UNIVERSAL_DATA_FOR_REHYDRATION__ out of its
 * <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">
 * tag (reading the DOM script tag rather than the JS global, since some
 * frameworks delete/clear the global after client-side hydration consumes
 * it - the <script type="application/json"> tag itself is inert data and
 * stays in the DOM). Fallback: the older SIGI_STATE script tag, in case a
 * different TikTok build/region still serves that shape. Both are current
 * best-known knowledge, not independently re-verified beyond the one real
 * run above - if both come back empty, extractItemFromPage returns null and
 * the caller logs full diagnostics.
 */

import { normalizeVideoItem } from './shared.js';
import { normalizeClockworksItem } from './clockworks.js';

function buildWrapper(item, seenIds, meta) {
  if (!item || !item.id) return null;
  if (seenIds.has(item.id)) return null;
  seenIds.add(item.id);

  const compat = normalizeVideoItem(item);
  if (!compat) return null;

  return {
    id: item.id,
    compat,
    clockworks: normalizeClockworksItem(item, meta),
    raw: item,
  };
}

/**
 * Kept as a fallback in case /api/item_detail/ (or an equivalent XHR) does
 * fire in some scenario this session's one real run didn't cover (e.g. a
 * different account/region/A-B test) - routed from intercept.js's response
 * listener same as every other endpoint normalizer.
 */
export function normalizeItemDetail(data, seenIds, meta = {}) {
  const wrapper = buildWrapper(data?.itemInfo?.itemStruct, seenIds, meta);
  return wrapper ? [wrapper] : [];
}

/**
 * Runs in the browser: the post's raw item out of a document's embedded SSR
 * state. Passed to page.evaluate as source, so it must not use anything from
 * this module's scope.
 */
function readItemState(doc) {
  function tryUniversalData() {
    const el = doc.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__');
    if (!el || !el.textContent) return null;
    const data = JSON.parse(el.textContent);
    const scope = data?.__DEFAULT_SCOPE__ || {};
    const videoDetail = scope['webapp.video-detail'];
    return videoDetail?.itemInfo?.itemStruct || null;
  }

  function trySigiState() {
    const el = doc.querySelector('#SIGI_STATE');
    if (!el || !el.textContent) return null;
    const data = JSON.parse(el.textContent);
    const itemModule = data?.ItemModule;
    if (!itemModule) return null;
    const firstId = Object.keys(itemModule)[0];
    return firstId ? itemModule[firstId] : null;
  }

  try {
    return tryUniversalData() || trySigiState() || null;
  } catch {
    return null;
  }
}

/**
 * Read the single video's raw item straight out of the page's embedded
 * SSR state - no network wait needed, the data is already in the HTML by
 * the time 'domcontentloaded' fires.
 */
export async function extractItemFromPage(page) {
  return page.evaluate(`(${readItemState})(document)`);
}

/**
 * Fetch a post's raw item from TikTok's item-detail API with fetch() from
 * inside an already-open tiktok.com page (as the comment API is called) -
 * JSON only, far smaller than the post page's HTML. Returns
 * { status, bytes, item }; item is null when the response carries none.
 */
export async function fetchItemFromApi(page, itemId) {
  return page.evaluate(async (url) => {
    try {
      const res = await fetch(url, { credentials: 'include' });
      const text = await res.text();
      const data = text ? JSON.parse(text) : null;
      return { status: res.status, bytes: text.length, item: data?.itemInfo?.itemStruct || null };
    } catch (error) {
      return { error: String((error && error.message) || error), item: null };
    }
  }, `/api/item/detail/?aid=1988&itemId=${itemId}`);
}

/**
 * Fetch a post page's HTML with fetch() from inside an already-open
 * tiktok.com page and read its SSR state, without navigating. Only the HTML
 * document is downloaded - none of the JS/CSS a navigation re-fetches on
 * every post (page.route() disables the HTTP cache). Returns
 * { status, bytes, item }; item is null when the response carries no state.
 */
export async function fetchItemFromPostUrl(page, url) {
  return page.evaluate(`(async () => {
    try {
      const res = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return { status: res.status, bytes: html.length, item: (${readItemState})(doc) };
    } catch (error) {
      return { error: String(error && error.message || error), item: null };
    }
  })()`);
}

/**
 * Wrap a raw item already extracted via extractItemFromPage into the same
 * { id, compat, clockworks, raw } shape every other normalizer produces.
 */
export function normalizeItemFromPageData(item, seenIds, meta = {}) {
  const wrapper = buildWrapper(item, seenIds, meta);
  return wrapper ? [wrapper] : [];
}
