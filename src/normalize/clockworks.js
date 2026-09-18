/**
 * normalize/clockworks.js — Maps a raw TikTok API item to the field shape
 * clockworks/tiktok-scraper produces, so red-pharmatiq-api's existing
 * BigQueryPostRowMapper / keyword_matching / language_filter / subtitle_fetcher
 * code (none of which is being changed) keeps working unmodified.
 *
 * Field-by-field confidence notes live inline. Fields marked "best-effort"
 * have no proven mapping elsewhere in this codebase and should be checked
 * against a real run before this actor replaces clockworks in production.
 */

function pickUrl(list) {
  if (Array.isArray(list) && list.length) return list[0];
  return null;
}

// Accepts either this project's Actor.log/logger shape (.warning) or plain
// console (.warn) - a raw console.warn() call was silently not showing up
// in the Apify run log the way every other [WARN]-prefixed line here does.
function warn(log, message) {
  if (log?.warning) return log.warning(message);
  if (log?.warn) return log.warn(message);
  console.warn(message);
}

let loggedMissingDownloadAddrOnce = false;

/**
 * Normalize one raw TikTok item into the clockworks output shape.
 * `inputValue` is the search query / hashtag / profile that produced this
 * item — stamped onto the `input` field, same as clockworks does.
 * `log` (optional, threaded through from main.js via the same `meta` object
 * used for `inputValue`) is used for the diagnostic below.
 */
export function normalizeClockworksItem(item, { inputValue = null, log = console } = {}) {
  if (!item || !item.id) return null;

  const author = item.author || item.authorInfo || {};
  const authorStats = item.authorStats || {};
  const stats = item.stats || item.statsV2 || {};
  const video = item.video || {};
  const music = item.music || {};
  const textExtra = item.textExtra || [];

  const hashtags = textExtra
    .filter((t) => t.hashtagName)
    .map((t) => ({ name: t.hashtagName }));

  // Plain username list — BigQuery models `mentions` as STRING REPEATED,
  // unlike `detailedMentions` which is a full RECORD per mention below.
  const mentionEntries = textExtra.filter((t) => t.type === 0 && t.userName);
  const mentions = mentionEntries.map((t) => t.userName);
  const detailedMentions = mentionEntries.map((t) => ({
    id: t.userId ? Number(t.userId) || null : null,
    name: t.userName || null,
    nickName: null,
    profileUrl: t.userName ? `https://www.tiktok.com/@${t.userName}` : null,
  }));

  const mediaUrls = (item.imagePost?.images || [])
    .map((img) => pickUrl(img.imageURL?.urlList) || img.url || null)
    .filter(Boolean);

  const musicMeta = music.id
    ? {
        musicId: music.id ? Number(music.id) || null : null,
        musicName: music.title || null,
        musicAuthor: music.authorName || null,
        musicOriginal: music.original || false,
        musicAlbum: music.album || null,
        playUrl: pickUrl(music.playUrl?.urlList) || null,
        coverMediumUrl: pickUrl(music.coverMedium?.urlList) || null,
        // best-effort: TikTok rarely exposes a distinct "original" cover for
        // reused sounds; fall back to the same cover art.
        originalCoverMediumUrl: pickUrl(music.coverMedium?.urlList) || null,
      }
    : null;

  const authorMeta = {
    // clockworks splits handle vs display name across `name`/`nickName`.
    name: author.uniqueId || null,
    nickName: author.nickname || null,
    avatar: author.avatarLarger || author.avatarMedium || author.avatarThumb || null,
    profileUrl: author.uniqueId ? `https://www.tiktok.com/@${author.uniqueId}` : null,
    id: author.id ? Number(author.id) || null : null,
    verified: author.verified || false,
    privateAccount: author.privateAccount ?? null,
    signature: author.signature || null,
    fans: authorStats.followerCount ?? null,
    following: authorStats.followingCount ?? null,
    video: authorStats.videoCount ?? null,
    // best-effort: not a standard TikTok authorStats field; fall back to null.
    friends: authorStats.friendCount ?? author.friendCount ?? null,
  };

  // best-effort: `videoMeta.subtitleLinks` is filled in later by
  // src/subtitles.js when downloadSubtitlesOptions is enabled — left empty
  // here so the field always exists even when subtitle fetching is off.
  //
  // downloadAddr note (2026-09-18): a real run confirmed video.cover/
  // originCover are correct, but video.downloadAddr/video.playAddr came back
  // empty on every item - TikTok apparently doesn't expose a flat playable
  // URL on this shape. video.bitrateInfo[].PlayAddr.UrlList is a commonly
  // seen TikTok pattern for the same data, tried here as a next-best guess;
  // if that's ALSO wrong, the diagnostic below logs the real keys under
  // item.video once per run so it's fast to fix for real next time.
  const bitrateVariant = Array.isArray(video.bitrateInfo) ? video.bitrateInfo[0] : null;
  const downloadAddr = video.downloadAddr
    || video.playAddr
    || pickUrl(bitrateVariant?.PlayAddr?.UrlList)
    || pickUrl(bitrateVariant?.PlayAddr?.url_list)
    || null;

  if (!downloadAddr && Object.keys(video).length && !loggedMissingDownloadAddrOnce) {
    loggedMissingDownloadAddrOnce = true;
    warn(
      log,
      `videoMeta.downloadAddr came up empty for item ${item.id}; ` +
      `video.downloadAddr=${JSON.stringify(video.downloadAddr)}, video.playAddr=${JSON.stringify(video.playAddr)}; ` +
      `keys under item.video: [${Object.keys(video).join(', ')}]` +
      (bitrateVariant ? `; keys under video.bitrateInfo[0]: [${Object.keys(bitrateVariant).join(', ')}]` : '; video.bitrateInfo is not an array/absent')
    );
  }

  const videoMeta = {
    coverUrl: pickUrl(video.cover?.urlList) || video.cover || null,
    originalCoverUrl: pickUrl(video.originCover?.urlList) || video.originCover || null,
    downloadAddr,
    subtitleLinks: [],
  };

  const createTime = item.createTime ? parseInt(item.createTime, 10) : null;

  return {
    id: item.id,
    text: item.desc || '',
    createTime,
    createTimeISO: createTime ? new Date(createTime * 1000).toISOString() : null,
    webVideoUrl: `https://www.tiktok.com/@${author.uniqueId || 'user'}/video/${item.id}`,
    url: null,
    diggCount: numOrNull(stats.diggCount),
    shareCount: numOrNull(stats.shareCount),
    playCount: numOrNull(stats.playCount),
    collectCount: numOrNull(stats.collectCount),
    commentCount: numOrNull(stats.commentCount),
    repostCount: numOrNull(stats.repostCount),
    // best-effort: no reliable "boosted/branded content" flag on search-mode
    // items; TikTok's isAd covers actual ad units (see isAd below).
    isSponsored: null,
    // best-effort field name.
    isPinned: item.isPinnedItem ?? null,
    // derived, not a real TikTok flag: a photo-carousel post has imagePost set.
    isSlideshow: !!item.imagePost,
    isAd: item.isAd || false,
    effectStickers: item.effectStickers || null,
    hashtags,
    mentions,
    detailedMentions,
    mediaUrls,
    musicMeta,
    authorMeta,
    videoMeta,
    textLanguage: item.textLanguage || null,
    input: inputValue,
    // best-effort: only meaningful for challenge/hashtag-browse results,
    // which this actor's search-mode jobs don't produce.
    searchHashtag: null,
    commentsDatasetUrl: null,
    error: null,
  };
}

function numOrNull(value) {
  if (value === undefined || value === null) return null;
  const n = typeof value === 'string' ? parseInt(value, 10) : value;
  return Number.isFinite(n) ? n : null;
}
