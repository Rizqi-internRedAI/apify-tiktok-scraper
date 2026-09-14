/**
 * normalize/challengeItem.js — Normalizer for /api/challenge/item_list/ (hashtag feed)
 *
 * Hashtag-based search returns items in a flat array with cursor-based pagination.
 */

import { normalizeVideoItem } from './shared.js';
import { normalizeClockworksItem } from './clockworks.js';

/**
 * Normalize challenge/hashtag feed response.
 * Returns wrapper objects: { id, compat, clockworks, raw }.
 */
export function normalizeChallengeItem(data, seenIds, meta = {}) {
  const items = data.itemList || data.item_list || data.data || [];
  const results = [];

  for (const item of items) {
    if (!item || !item.id) continue;

    if (seenIds.has(item.id)) continue;
    seenIds.add(item.id);

    const compat = normalizeVideoItem(item);
    if (compat) {
      results.push({
        id: item.id,
        compat,
        clockworks: normalizeClockworksItem(item, meta),
        raw: item,
      });
    }
  }

  return results;
}
