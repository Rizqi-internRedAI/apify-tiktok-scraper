/**
 * normalize/synapse.js — Maps a normalized wrapper item to the shape accepted
 * by red-synapse-dbs-be's POST /api/v1/ingest (ScrapedThread), so a scraper
 * can group the dataset by `tag` and post it without any reshaping.
 *
 * Differences from the legacy 'compat' schema, all dictated by the backend's
 * ScrapedThread model:
 *   - `platform` is always 'tiktok' (the backend defaults to 'threads').
 *   - `videos` is a list of URL strings, with the duration moved to
 *     `duration_seconds` (compat emits [{ url, duration }], which the
 *     backend rejects).
 *   - `hashtags` is one space-separated string ('#a #b'), not a list.
 *   - `saves`, `follows`, `music_name`, `music_author`, `content_type` are
 *     filled; compat leaves them out.
 *   - `tag` is the job query (search term / hashtag / profile / URL) that
 *     produced the post. The backend matches posts to products by the
 *     payload-level tag, so callers group items by this field.
 *
 * Items without a post id or a timestamp are dropped: the backend's rollups
 * are bucketed by date and cannot use them.
 */

function intOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'string' ? parseInt(value, 10) : value;
  return Number.isFinite(n) ? Math.round(n) : null;
}

function strOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

export function toSynapseFormatted(wrapperItem) {
  const { compat, clockworks } = wrapperItem || {};
  if (!compat || !clockworks || !compat.post_id || !compat.timestamp) return null;

  const user = compat.user || {};
  const images = (compat.images || []).filter(Boolean);

  const videoUrl = clockworks.videoMeta?.downloadAddr
    || compat.videos?.[0]?.url
    || null;
  const videos = images.length === 0 && videoUrl ? [videoUrl] : [];
  const durationSeconds = intOrNull(compat.video_duration ?? compat.videos?.[0]?.duration);

  const hashtags = (compat.hashtags || [])
    .map((h) => (h && h.name ? `#${h.name}` : null))
    .filter(Boolean)
    .join(' ');

  const followerCount = intOrNull(user.follower_count);

  return {
    post_id: String(compat.post_id),
    shortcode: String(compat.shortcode || compat.post_id),
    post_url: compat.post_url,
    text: compat.text || '',
    timestamp: compat.timestamp,
    user: {
      user_id: strOrNull(user.user_id),
      username: user.username || '',
      full_name: user.full_name || null,
      profile_url: user.profile_url || null,
      profile_pic_url: user.profile_pic_url || null,
      is_verified: user.is_verified ?? null,
      follower_count: followerCount,
    },
    likes: intOrNull(compat.likes),
    replies: intOrNull(compat.replies),
    reposts: intOrNull(compat.reposts),
    quotes: null,
    reshares: intOrNull(compat.reshares),
    views: intOrNull(compat.views),
    saves: intOrNull(clockworks.collectCount),
    follows: followerCount,
    images,
    videos,
    is_reply: false,
    source: 'api',
    platform: 'tiktok',
    content_type: images.length > 0 ? 'slideshow' : 'video',
    duration_seconds: durationSeconds,
    hashtags: hashtags || null,
    music_name: compat.music?.title || null,
    music_author: compat.music?.author || null,
    tag: clockworks.input ?? null,
  };
}
