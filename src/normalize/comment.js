/**
 * normalize/comment.js — Normalizer for /api/comment/list/
 *
 * Maps TikTok's comment list response to a flat comment structure.
 */

/**
 * Normalize comment list response.
 * Returns wrapper objects: { id, compat, clockworks, raw } — clockworks is
 * always null, comments aren't part of that contract.
 */
export function normalizeCommentList(data, seenIds) {
  const comments = data.comments || data.data || [];
  const results = [];

  for (const comment of comments) {
    if (!comment || !comment.cid) continue;

    if (seenIds.has(comment.cid)) continue;
    seenIds.add(comment.cid);

    const normalized = normalizeComment(comment);
    if (normalized) {
      results.push({
        id: comment.cid,
        compat: normalized,
        clockworks: null,
        raw: comment,
      });
    }
  }

  return results;
}

/**
 * Normalize a single comment
 */
function normalizeComment(comment) {
  if (!comment) return null;

  const user = comment.user || {};
  const stats = comment.stats || {};

  return {
    post_id: comment.cid,
    shortcode: null,
    post_url: comment.share_info?.share_url || null,
    text: comment.text || '',
    timestamp: comment.create_time
      ? new Date(parseInt(comment.create_time, 10) * 1000).toISOString()
      : null,
    user: {
      user_id: user.uid || user.id || null,
      username: user.unique_id || user.uniqueId || null,
      full_name: user.nickname || null,
      profile_url: `https://www.tiktok.com/@${user.unique_id || user.uniqueId || ''}`,
      profile_pic_url: user.avatar_thumb?.url_list?.[0] || user.avatar_thumb || null,
      is_verified: user.custom_verify || user.verified || false,
      follower_count: user.follower_count || null,
    },
    likes: stats.digg_count || comment.digg_count || 0,
    replies: stats.reply_comment_total || comment.reply_comment_total || 0,
    reposts: null,
    quotes: null,
    reshares: null,
    views: null,
    images: [],
    videos: [],
    is_reply: comment.reply_id && comment.reply_id !== '0',
    source: 'api',
    _type: 'comment',
    // Comment-specific fields
    aweme_id: comment.aweme_id || null,
    reply_id: comment.reply_id || null,
    reply_to_reply_id: comment.reply_to_reply_id || null,
    sub_comment_count: comment.sub_comment_count || 0,
  };
}
