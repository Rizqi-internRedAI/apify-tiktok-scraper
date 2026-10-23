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

  // authorStatsV2 carries the same counts as strings; prefer it when present
  // (on profile pages it holds the exact figure where authorStats is rounded).
  const authorStatsV2 = item.authorStatsV2 || {};
  const authorStat = (key) => numOrNull(authorStatsV2[key]) ?? numOrNull(authorStats[key]);

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
    fans: authorStat('followerCount'),
    following: authorStat('followingCount'),
    video: authorStat('videoCount'),
    // Total likes the account's videos have received.
    heart: authorStat('heartCount') ?? authorStat('heart'),
    // Likes the account has given to other videos.
    digg: authorStat('diggCount'),
    // best-effort: not a standard TikTok authorStats field; fall back to null.
    friends: authorStat('friendCount') ?? author.friendCount ?? null,
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
    // Seconds. Slideshows have no video duration.
    duration: numOrNull(video.duration),
    definition: video.definition || null,
    height: numOrNull(video.height),
    width: numOrNull(video.width),
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
    // Raw TikTok isAd. Not a paid-ad flag in practice: search and profile
    // feeds return true for most TikTok Shop posts (12 of 15 in a 2026-10-23
    // sample, 11 of them Shop posts). Use hasTikTokShopProduct for affiliate
    // content.
    isAd: item.isAd || false,
    // TikTok Shop product link on the post ("keranjang kuning"), same field
    // name clockworks uses. creatorType treats such posts as affiliate
    // content and everything else as regular creator content.
    hasTikTokShopProduct: hasShopProduct(item),
    creatorType: hasShopProduct(item) ? 'affiliate' : 'content_creator',
    // The products behind the keranjang kuning (see extractShopProducts).
    tiktokShopProducts: extractShopProducts(item),
    // TikTok's own content labels, e.g. ["Health & Wellness", "Fitness &
    // Health"]. Only present on the post's own page, so null for search and
    // profile-feed items unless enrichPostDetails is on.
    contentCategories: Array.isArray(item.diversificationLabels) ? item.diversificationLabels : null,
    // TikTok's numeric content category id (no public name mapping).
    categoryType: numOrNull(item.CategoryType ?? item.categoryType),
    // Country the post was created in, e.g. "ID" (post page only).
    locationCreated: item.locationCreated || null,
    moderation: extractModeration(item),
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
    // Filled in later by main.js's extractRelatedSearchWords when the
    // scrapeRelatedSearchWords input option is on (search mode only) -
    // empty here so the key always exists regardless.
    relatedSearchWords: [],
    commentsDatasetUrl: null,
    // Filled in by main.js when includeComments is on (see normalize/comment.js).
    comments: null,
    // Filled in by main.js for profile jobs: the account's own page data,
    // with the time it was read (see normalize/profile.js).
    authorProfile: null,
    error: null,
  };
}

/**
 * TikTok Shop products linked from a post. Each Shop product is an anchor of
 * type 33 whose `extra` JSON holds the product; TikTok also nests them as a
 * JSON list inside a type-35 anchor's `extra`. Price is not exposed (TikTok
 * sends 0), so it is left out.
 */
function extractShopProducts(item) {
  const products = [];
  const seen = new Set();

  const addProduct = (entry) => {
    if (Number(entry?.type) !== SHOP_PRODUCT_ANCHOR_TYPE) return;
    const extra = parseJson(entry.extra) || {};
    // product_id / seller_id are 19-digit numbers in the JSON, beyond what a
    // JS number holds exactly - read them as text so they stay exact.
    const productId = bigIdFromJson(entry.extra, 'product_id') || (entry.id ? String(entry.id) : '');
    if (!productId || seen.has(productId)) return;
    seen.add(productId);
    const categories = Array.isArray(extra.categories)
      ? [...extra.categories].sort((a, b) => (a.level ?? 0) - (b.level ?? 0)).map((c) => c.category_name).filter(Boolean)
      : [];
    products.push({
      productId,
      title: extra.title || entry.keyword || null,
      shortTitle: extra.elastic_title || entry.keyword || null,
      sellerId: bigIdFromJson(entry.extra, 'seller_id'),
      categories,
      productUrl: extra.seo_url || null,
      source: extra.source || null,
    });
  };

  for (const anchor of Array.isArray(item.anchors) ? item.anchors : []) {
    addProduct(anchor);
    const nested = parseJson(anchor?.extra);
    if (Array.isArray(nested)) nested.forEach(addProduct);
  }
  return products;
}

/** TikTok's own moderation state of the post. */
function extractModeration(item) {
  const penalty = item.penaltyContext || {};
  return {
    isProhibited: item.isProhibited ?? null,
    takeDown: numOrNull(item.takeDown),
    warnings: Array.isArray(item.warnInfo) ? item.warnInfo : [],
    penaltyStatus: numOrNull(penalty.status),
    isReviewing: item.isReviewing ?? null,
    isAigc: item.IsAigc ?? (item.aigcLabelType ? true : null),
  };
}

function bigIdFromJson(text, key) {
  if (typeof text !== 'string') return null;
  const match = text.match(new RegExp(`"${key}"\\s*:\\s*"?(\\d+)`));
  return match ? match[1] : null;
}

function parseJson(value) {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// Checked against clockworks' own hasTikTokShopProduct labels: isECVideo=1
// and anchor type 33 appear only on Shop posts. Other anchor types (e.g. 35,
// 54 for CapCut) also show up on regular posts, so they don't count.
const SHOP_PRODUCT_ANCHOR_TYPE = 33;

function hasShopProduct(item) {
  if (Number(item.isECVideo) === 1) return true;
  const anchorTypes = [
    ...(Array.isArray(item.AnchorTypes) ? item.AnchorTypes : []),
    ...(Array.isArray(item.anchors) ? item.anchors.map((a) => a?.type) : []),
  ];
  return anchorTypes.some((t) => Number(t) === SHOP_PRODUCT_ANCHOR_TYPE);
}

function numOrNull(value) {
  if (value === undefined || value === null) return null;
  const n = typeof value === 'string' ? parseInt(value, 10) : value;
  return Number.isFinite(n) ? n : null;
}
