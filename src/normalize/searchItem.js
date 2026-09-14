/**
 * normalize/searchItem.js — Normalizers for /api/search/general/full/ and /api/search/item/full/
 *
 * Maps TikTok's raw API item structure to the target output schema.
 * Also handles user card normalization from type:4 entries.
 */

import { normalizeVideoItem } from './shared.js';
import { normalizeClockworksItem } from './clockworks.js';

/**
 * Normalize search response (general/full and item/full).
 * Returns wrapper objects: { id, compat, clockworks, raw }.
 */
export function normalizeSearchItem(data, seenIds, meta = {}) {
  const items = data.data || [];
  const results = [];

  for (const entry of items) {
    const item = entry.item || entry;
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

/**
 * Normalize general search results (videos + user cards mixed)
 */
export function normalizeSearchGeneral(data, seenIds, meta = {}) {
  const items = data.data || [];
  const results = [];

  for (const entry of items) {
    if (entry.type === 1) {
      // Video item
      const item = entry.item;
      if (item && item.id && !seenIds.has(item.id)) {
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
    } else if (entry.type === 4) {
      // User card — not part of the clockworks video-item contract.
      const user = entry.item;
      if (user && user.id && !seenIds.has(`user_${user.id}`)) {
        seenIds.add(`user_${user.id}`);
        results.push({
          id: `user_${user.id}`,
          compat: normalizeUserCard(user),
          clockworks: null,
          raw: user,
        });
      }
    }
  }

  return results;
}

/**
 * Normalize a user card entry (type:4 in general search)
 */
export function normalizeUserCard(user) {
  if (!user) return null;

  return {
    post_id: `user_${user.id}`,
    shortcode: null,
    post_url: `https://www.tiktok.com/@${user.uniqueId || ''}`,
    text: user.signature || '',
    timestamp: null,
    user: {
      user_id: user.id || null,
      username: user.uniqueId || null,
      full_name: user.nickname || null,
      profile_url: `https://www.tiktok.com/@${user.uniqueId || ''}`,
      profile_pic_url: user.avatarLarger || user.avatarMedium || user.avatarThumb || null,
      is_verified: user.verified || false,
      follower_count: user.followerCount || null,
    },
    likes: null,
    replies: null,
    reposts: null,
    quotes: null,
    reshares: null,
    views: null,
    images: [],
    videos: [],
    is_reply: false,
    source: 'api',
    _type: 'user_card',
  };
}
