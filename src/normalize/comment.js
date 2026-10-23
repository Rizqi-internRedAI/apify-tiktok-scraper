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

/**
 * One comment in the shape attached to clockworks items (`comments`). Keeps
 * what is usable for audience analysis: the text, its language, TikTok's own
 * purchase-intent flag, and who commented. TikTok's web comment API does not
 * expose the commenter's age, gender, region or follower count.
 */
export function normalizeClockworksComment(comment, { authorId = null } = {}) {
  const user = comment.user || {};
  const createTime = comment.create_time ? parseInt(comment.create_time, 10) : null;
  const isByAuthor = authorId ? String(user.uid) === String(authorId) : null;
  // Replies are only present when includeReplies fetched them; null means
  // "not fetched", [] means "fetched, none".
  const replies = Array.isArray(comment.replies)
    ? comment.replies.map((reply) => normalizeClockworksComment(reply, { authorId }))
    : null;
  return {
    id: comment.cid,
    text: comment.text || '',
    createTime,
    createTimeISO: createTime ? new Date(createTime * 1000).toISOString() : null,
    diggCount: comment.digg_count ?? 0,
    replyCount: comment.reply_comment_total ?? 0,
    language: comment.comment_language || null,
    // TikTok's own flag for comments that signal intent to buy.
    isHighPurchaseIntent: comment.is_high_purchase_intent ?? null,
    isReply: Boolean(comment.reply_id && comment.reply_id !== '0'),
    // For a reply: the comment it belongs to.
    parentCommentId: comment.reply_id && comment.reply_id !== '0' ? comment.reply_id : null,
    // Written by the post's creator (null when the creator is unknown).
    isByAuthor,
    likedByAuthor: comment.is_author_digged ?? null,
    pinnedByAuthor: Boolean(comment.author_pin),
    // Whether the creator replied to this comment (null until replies were fetched).
    repliedByAuthor: replies && isByAuthor !== null ? replies.some((r) => r.isByAuthor) : null,
    user: {
      id: user.uid || null,
      uniqueId: user.unique_id || null,
      nickname: user.nickname || null,
      profileUrl: user.unique_id ? `https://www.tiktok.com/@${user.unique_id}` : null,
      verified: Boolean(user.custom_verify || user.enterprise_verify_reason),
    },
    replies,
  };
}
