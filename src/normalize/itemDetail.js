/**
 * normalize/itemDetail.js — Normalizer for /api/item_detail/ (single video
 * page hydration, used by the "scrape by post URL" mode)
 *
 * Field name note: '/api/item_detail/' is the best-known current TikTok API
 * path for this (same "not independently live-verified this session" caveat
 * as src/subtitles.js's video.subtitleInfos) - if wrong, main.js logs the
 * actual XHR URLs seen during that page load so it's fast to spot and fix.
 *
 * Response shape differs from search/challenge endpoints: the single item
 * lives at data.itemInfo.itemStruct, not a data[] array.
 */

import { normalizeVideoItem } from './shared.js';
import { normalizeClockworksItem } from './clockworks.js';

export function normalizeItemDetail(data, seenIds, meta = {}) {
  const item = data?.itemInfo?.itemStruct;
  if (!item || !item.id) return [];

  if (seenIds.has(item.id)) return [];
  seenIds.add(item.id);

  const compat = normalizeVideoItem(item);
  if (!compat) return [];

  return [{
    id: item.id,
    compat,
    clockworks: normalizeClockworksItem(item, meta),
    raw: item,
  }];
}
