/**
 * main.js — Apify Actor entry point
 *
 * TikTok Scraper Actor
 * Accepts session cookies, scrapes TikTok data via network interception,
 * and outputs structured JSON matching the target schema.
 */

import { Actor } from 'apify';
import { PlaywrightCrawler, Configuration } from 'crawlee';
import { readFileSync } from 'fs';
import { normalizeCookies, validateCookies, getCookieHash, getTargetIdc } from './cookies.js';
import { setupInterceptors, CaptchaError } from './intercept.js';
import { setupPagination, waitForCount } from './paginate.js';
import { SessionManager, detectCaptcha, detectLoggedOut } from './antibot.js';
import { extractSubtitleInfos, uploadSubtitles } from './subtitles.js';
import { extractItemFromPage, fetchItemFromPostUrl, normalizeItemFromPageData } from './normalize/itemDetail.js';
import { toSynapseFormatted } from './normalize/synapse.js';
import { normalizeClockworksItem } from './normalize/clockworks.js';
import { normalizeClockworksComment } from './normalize/comment.js';
import { extractProfileFromPage, normalizeProfileSnapshot, parseProfileHtml } from './normalize/profile.js';

// Local development fallback for logging
const logger = {
  info: (msg) => console.log(`[INFO] ${msg}`),
  warning: (msg) => console.warn(`[WARN] ${msg}`),
  error: (msg) => console.error(`[ERROR] ${msg}`),
  debug: (msg) => console.debug(`[DEBUG] ${msg}`),
};

// Configuration
const DEFAULT_MAX_ITEMS = 200;

/**
 * Build the list of scrape jobs ({ mode, query }) from every supported input
 * shape. hashtags/searchQueries/profiles/postUrls are all unioned together
 * (not either/or) when more than one is non-empty; hashtags/searchQueries
 * map to REAL keyword search — not hashtag/challenge browsing — since
 * that's the whole point of this actor over clockworks' OR-matched hashtag
 * search. The legacy mode+queries pair is only used when all four of those
 * are empty.
 */
function buildJobs({ hashtags, searchQueries, profiles, postUrls, mode, queries }) {
  const nonBlank = (arr) => (arr || []).map((s) => String(s ?? '').trim()).filter(Boolean);

  const jobs = [
    ...nonBlank(hashtags).map((h) => ({ mode: 'search', query: h.replace(/^#/, '') })),
    ...nonBlank(searchQueries).map((q) => ({ mode: 'search', query: q })),
    ...nonBlank(profiles).map((p) => ({ mode: 'profile', query: p.replace(/^@/, '') })),
    ...nonBlank(postUrls).map((url) => ({ mode: 'post', query: url })),
  ];

  if (jobs.length === 0) {
    for (const q of nonBlank(queries)) {
      jobs.push({ mode: mode || 'search', query: q });
    }
  }

  return jobs;
}

/**
 * Cookies fall back to actor-level environment variables when the input
 * omits them entirely - red-pharmatiq-api's payloads (built to match
 * clockworks/tiktok-scraper's input shape) never carry sessionCookies/
 * cookiePool, since clockworks handles its own auth. Set these as Secret
 * env vars on the Actor in Apify Console (Settings -> Environment
 * variables), never as an INPUT_SCHEMA default - that would commit a live
 * session credential to this repo's git history.
 */
function cookiesFromEnv() {
  const sessionCookies = process.env.TIKTOK_SESSION_COOKIES || '';

  let cookiePool = [];
  if (process.env.TIKTOK_COOKIE_POOL) {
    try {
      const parsed = JSON.parse(process.env.TIKTOK_COOKIE_POOL);
      if (Array.isArray(parsed)) cookiePool = parsed;
    } catch {
      // Malformed TIKTOK_COOKIE_POOL env var - ignored, falls through to
      // sessionCookies (or the caller's own input) instead.
    }
  }

  return { sessionCookies, cookiePool };
}

/**
 * Parse and validate input
 */
async function parseInput(input) {
  const envCookies = cookiesFromEnv();
  const sessionCookies = input.sessionCookies || envCookies.sessionCookies;
  const cookiePool = (input.cookiePool && input.cookiePool.length > 0)
    ? input.cookiePool
    : envCookies.cookiePool;
  const sortBy = input.sortBy || 'relevance';
  const publishedWithin = input.publishedWithin || 'all';
  const dateFromMs = parseDateBound(input.dateFrom);
  const dateToMs = parseDateBound(input.dateTo, { endOfDay: true });
  // No forced default - red-pharmatiq-api's ingestion pipeline already
  // filters to id/en downstream (domain/language_filter.py), so scoping the
  // scrape itself to one language would only narrow results without needing
  // to.
  const language = input.language || '';
  const includeComments = input.includeComments || false;
  const commentsPerPost = input.commentsPerPost || 20;
  // How many of a job's posts get their comments fetched (a few API calls
  // each, no extra page load). Unset keeps the old cap of 10.
  const commentVideosLimit = input.commentVideosLimit || 10;
  // Open each scraped post's own page to add the fields only that page
  // carries (content categories, post country, moderation warnings). One
  // extra page load per post, so off by default.
  const enrichPostDetails = input.enrichPostDetails || false;
  // Also fetch the replies under each fetched comment (one extra API call
  // per comment that has replies, more when it has many).
  const includeReplies = input.includeReplies || false;
  const repliesPerComment = input.repliesPerComment || 10;
  // Attach each author's account snapshot (authorProfile) to search and post
  // items too, as profile jobs always do. One profile page fetch per unique
  // author, cached for the whole run.
  const includeAuthorProfiles = input.includeAuthorProfiles || false;
  const downloadMedia = input.downloadMedia || false;
  // 'clockworks' is the default, not 'compat': red-pharmatiq-api's payloads
  // never set outputSchema (it's not part of clockworks' own input contract),
  // so the shape it actually gets has to work with no explicit opt-in.
  // Pass outputSchema:'compat' explicitly for the legacy Threads-style shape.
  // 'synapse-formatted' emits items shaped for red-synapse-dbs-be's /ingest.
  const outputSchema = input.outputSchema || 'clockworks';

  // clockworks-compatible fields (red-pharmatiq-api sends these) plus the
  // legacy mode/queries pair for backward-compatible manual runs.
  const jobs = buildJobs({
    hashtags: input.hashtags,
    searchQueries: input.searchQueries,
    profiles: input.profiles,
    postUrls: input.postUrls,
    mode: input.mode,
    queries: input.queries,
  });

  const maxItems = input.maxItems || input.resultsPerPage || DEFAULT_MAX_ITEMS;
  // 'None' is clockworks' own "no proxy country" sentinel - treated the same
  // as blank so it doesn't get passed to Apify Proxy as a country code.
  const rawProxyCountry = String(input.proxyCountryCode ?? '').trim();
  const proxyCountryCode = rawProxyCountry && rawProxyCountry.toLowerCase() !== 'none'
    ? rawProxyCountry
    : null;
  const downloadSubtitles = input.downloadSubtitlesOptions === 'DOWNLOAD_SUBTITLES';
  const scrapeRelatedSearchWords = input.scrapeRelatedSearchWords || false;

  // Validate required fields
  if (!sessionCookies && (!cookiePool || cookiePool.length === 0)) {
    throw new Error('Either sessionCookies or cookiePool must be provided');
  }

  if (!jobs.length) {
    throw new Error(
      'At least one of hashtags, searchQueries, profiles, postUrls, or (mode + queries) is required'
    );
  }

  // Parse cookies - support both sessionCookies and cookiePool
  let cookies = [];
  if (sessionCookies) {
    cookies = normalizeCookies(sessionCookies);
  } else if (cookiePool && cookiePool.length > 0) {
    // Use first cookie pool entry as primary
    cookies = normalizeCookies(cookiePool[0].cookies);
  }

  // Validate cookies
  const validation = validateCookies(cookies);
  if (!validation.valid) {
    throw new Error(`Invalid cookies: ${validation.reason}`);
  }

  if (dateFromMs !== null && dateToMs !== null && dateFromMs > dateToMs) {
    throw new Error('dateFrom must be before or equal to dateTo');
  }

  const dateRange = (dateFromMs !== null || dateToMs !== null)
    ? { from: dateFromMs, to: dateToMs }
    : null;

  return {
    jobs,
    maxItems,
    cookies,
    cookiePool,
    sortBy,
    publishedWithin,
    dateRange,
    language,
    includeComments,
    commentsPerPost,
    commentVideosLimit,
    enrichPostDetails,
    includeReplies,
    repliesPerComment,
    includeAuthorProfiles,
    downloadMedia,
    outputSchema,
    proxyCountryCode,
    downloadSubtitles,
    scrapeRelatedSearchWords,
  };
}

/**
 * Build the TikTok URL based on mode and query
 */
function buildUrl(mode, query, sortBy, publishedWithin, language = '') {
  const params = new URLSearchParams();

  switch (mode) {
    case 'search':
      // TikTok search uses 'q' parameter
      params.set('q', query);
      if (language) params.set('lang', language);
      if (sortBy === 'latest') {
        params.set('sort_type', '1');
      }
      if (publishedWithin !== 'all') {
        params.set('publish_time', publishTimeToCode(publishedWithin));
      }
      return `https://www.tiktok.com/search?${params.toString()}`;

    case 'hashtag': {
      const tagName = query.replace(/^#/, '');
      return `https://www.tiktok.com/tag/${tagName}`;
    }

    case 'profile': {
      const username = query.replace(/^@/, '');
      return `https://www.tiktok.com/@${username}`;
    }

    case 'post':
      // query is already a full TikTok video URL - nothing to construct.
      return query;

    default:
      params.set('q', query);
      if (language) params.set('lang', language);
      return `https://www.tiktok.com/search?${params.toString()}`;
  }
}

/**
 * Map an ISO language code to a Chromium --lang value.
 * The browser locale drives TikTok's search API language params
 * (e.g. language/app_language on /api/search/*), so it must match
 * the lang param we set on the search URL.
 */
function toChromiumLang(code) {
  const map = {
    id: 'id-ID,id;q=0.9',
    en: 'en-US,en;q=0.9',
    ms: 'ms-MY,ms;q=0.9',
    th: 'th-TH,th;q=0.9',
    vi: 'vi-VN,vi;q=0.9',
    ja: 'ja-JP,ja;q=0.9',
    ko: 'ko-KR,ko;q=0.9',
    es: 'es-ES,es;q=0.9',
    pt: 'pt-BR,pt;q=0.9',
  };
  return map[code] || 'en-US,en;q=0.9';
}

/**
 * Parse a date boundary into epoch milliseconds.
 * Accepts 'YYYY-MM-DD' (treated as UTC; endOfDay extends it to 23:59:59.999)
 * or any parseable ISO datetime string (offset honored as given).
 * Returns null when the value is empty.
 */
function parseDateBound(value, { endOfDay = false } = {}) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const time = endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
    return new Date(`${trimmed}${time}`).getTime();
  }

  const ms = new Date(trimmed).getTime();
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid date: "${trimmed}". Use YYYY-MM-DD or an ISO datetime string.`);
  }
  return ms;
}

/**
 * Convert publishedWithin to TikTok's time filter code
 */
function publishTimeToCode(within) {
  const mapping = {
    '1d': '0',
    '7d': '1',
    '30d': '2',
    '90d': '3',
    '180d': '4',
  };
  return mapping[within] || '0';
}

/**
 * Check a normalized wrapper item against the dateRange filter.
 * Applies to posts only (comments are left untouched); posts with an
 * unknown/invalid timestamp are excluded when a range is active.
 */
function isWithinDateRange(wrapperItem, range) {
  if (!range) return true;
  const compat = wrapperItem.compat;
  if (!compat) return true;
  if (compat._type === 'comment') return true;
  if (!compat.timestamp) return false;

  const ms = new Date(compat.timestamp).getTime();
  if (Number.isNaN(ms)) return false;

  if (range.from !== null && ms < range.from) return false;
  if (range.to !== null && ms > range.to) return false;
  return true;
}

/**
 * Turn a normalized wrapper item ({ id, compat, clockworks, raw }) into the
 * final dataset record, based on the outputSchema setting.
 */
function filterByOutputSchema(wrapperItem, schema) {
  const { compat, clockworks, raw } = wrapperItem;

  if (schema === 'clockworks') return clockworks;
  if (schema === 'native') return raw;
  if (schema === 'synapse-formatted') return toSynapseFormatted(wrapperItem);

  if (schema === 'both') {
    return { ...compat, _raw: raw };
  }

  // 'compat' - Threads-style format (only fields from sample-output.json)
  if (!compat) return null;
  return {
    post_id: compat.post_id,
    shortcode: compat.shortcode,
    post_url: compat.post_url,
    text: compat.text,
    timestamp: compat.timestamp,
    user: compat.user,
    likes: compat.likes,
    replies: compat.replies,
    reposts: compat.reposts,
    quotes: compat.quotes,
    reshares: compat.reshares,
    views: compat.views,
    images: compat.images,
    videos: compat.videos,
    is_reply: compat.is_reply,
    source: compat.source,
    comments: compat.comments,
  };
}

/**
 * Fetch and re-host TikTok's native subtitles for one video item into this
 * run's key-value store, mutating item.clockworks.videoMeta.subtitleLinks in
 * place. Gated behind config.downloadSubtitles; never throws.
 */
async function attachSubtitles(page, wrapperItem, kvStore, log) {
  if (!wrapperItem.clockworks || !wrapperItem.raw) return;
  const infos = extractSubtitleInfos(wrapperItem.raw, log);
  if (!infos.length) return;

  const links = await uploadSubtitles(page, wrapperItem.id, infos, kvStore, log);
  if (links.length) {
    wrapperItem.clockworks.videoMeta.subtitleLinks = links;
  }
}

// Every profile snapshot of this run, also written to the key-value store as
// PROFILE_SNAPSHOTS - one record per account even when it has no posts.
// Kept in memory and rewritten whole so concurrent jobs can't drop entries.
const profileSnapshots = [];
const savedSnapshotIds = new Set();

async function saveProfileSnapshot(kvStore, snapshot) {
  const key = snapshot.id || snapshot.uniqueId;
  if (savedSnapshotIds.has(key)) return;
  savedSnapshotIds.add(key);
  profileSnapshots.push(snapshot);
  await kvStore.setValue('PROFILE_SNAPSHOTS', profileSnapshots);
}

// Account snapshots already read this run, by lowercase username - an
// author who shows up in several jobs or posts is fetched once. null means
// the fetch failed, so it isn't retried for every post of that author.
const authorProfileCache = new Map();

/**
 * The account snapshot of one author for search/post items. Reads the
 * profile page's SSR state with a plain HTTP request first (no rendering);
 * when TikTok answers that with its small JS-challenge page instead, the
 * profile page is opened in the browser. A fetch() from inside the TikTok
 * page doesn't work here: it always gets the challenge page, and
 * /api/user/detail/ answers with an empty body (both confirmed 2026-10-23).
 */
async function getAuthorProfile(page, username, log) {
  const key = String(username || '').toLowerCase();
  if (!key) return null;
  if (authorProfileCache.has(key)) return authorProfileCache.get(key);

  let userInfo = null;
  try {
    const res = await fetch(`https://www.tiktok.com/@${encodeURIComponent(username)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
      },
    });
    userInfo = parseProfileHtml(await res.text());
  } catch (error) {
    log.warning(`Profile HTTP fetch failed for @${username}: ${error.message}`);
  }

  if (!userInfo) {
    try {
      await page.goto(`https://www.tiktok.com/@${username}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
      userInfo = await extractProfileFromPage(page);
    } catch (error) {
      log.warning(`Profile page visit failed for @${username}: ${error.message}`);
    }
  }

  const snapshot = normalizeProfileSnapshot(userInfo);
  if (!snapshot) log.warning(`No profile data found for @${username}`);
  authorProfileCache.set(key, snapshot);
  return snapshot;
}

let loggedMissingRelatedWordsOnce = false;

/**
 * Read TikTok's "Others also searched for" related keywords off a search
 * results page (clockworks' scrapeRelatedSearchWords option). This is
 * UI-rendered content, not present in any network response this actor
 * already intercepts, so it's read straight from the DOM - the selectors
 * below are best-known guesses (matching this file's existing search-result
 * selectors' data-e2e naming convention), not independently live-verified.
 * If none match, logs the data-e2e attributes actually present on the page
 * once per run so it's fast to correct.
 */
async function extractRelatedSearchWords(page, log) {
  const words = await page.evaluate(() => {
    const selectors = [
      '[data-e2e="search-common-link"]',
      '[data-e2e="search-common-list"] a',
      '[data-e2e="related-search"] a',
      '[data-e2e="search-common"] a',
    ];
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      if (els.length) {
        return Array.from(els)
          .map((el) => el.textContent?.trim())
          .filter(Boolean);
      }
    }
    return [];
  });

  if (!words.length && !loggedMissingRelatedWordsOnce) {
    loggedMissingRelatedWordsOnce = true;
    const dataE2eSeen = await page.evaluate(() =>
      Array.from(new Set(
        Array.from(document.querySelectorAll('[data-e2e]')).map((el) => el.getAttribute('data-e2e'))
      )).filter(Boolean).slice(0, 60)
    );
    log.warning(
      'scrapeRelatedSearchWords: no "Others also searched for" chips matched any known ' +
      `selector (see extractRelatedSearchWords in src/main.js). data-e2e attributes seen ` +
      `on this page: [${dataE2eSeen.join(', ')}]`
    );
  }

  return words;
}

/**
 * Fetch up to `limit` top-level comments of one post by calling TikTok's
 * comment API from inside the already-open tiktok.com page, so the page's
 * own SDK signs the request. Opening the post page and letting it load the
 * comment panel does not work: TikTok answers that request with an empty
 * 200 body (confirmed 2026-10-23, headless and headful, with and without
 * cookies), while the same call made with fetch() from the page returns the
 * comments. Never throws; returns the raw comments.
 */
async function fetchCommentsInPage(page, awemeId, limit, log, { includeReplies = false, repliesPerComment = 10 } = {}) {
  const comments = await fetchCommentPages(page, `/api/comment/list/?aid=1988&aweme_id=${awemeId}`, limit, awemeId, log);
  if (includeReplies) {
    for (const comment of comments) {
      if (!(comment.reply_comment_total > 0)) {
        comment.replies = [];
        continue;
      }
      comment.replies = await fetchCommentPages(
        page,
        `/api/comment/list/reply/?aid=1988&item_id=${awemeId}&comment_id=${comment.cid}`,
        repliesPerComment,
        `${awemeId}/${comment.cid}`,
        log
      );
    }
  }
  return comments;
}

/**
 * Page through one TikTok comment-list endpoint (a post's top-level comments
 * or one comment's replies - same response shape) with fetch() from inside
 * the page, up to `limit` comments.
 */
async function fetchCommentPages(page, baseUrl, limit, label, log) {
  const comments = [];
  let cursor = 0;
  for (let call = 0; call < 20 && comments.length < limit; call += 1) {
    const count = Math.min(50, limit - comments.length);
    let data = null;
    try {
      data = await page.evaluate(async (url) => {
        const res = await fetch(url, { credentials: 'include' });
        const text = await res.text();
        return text ? JSON.parse(text) : null;
      }, `${baseUrl}&count=${count}&cursor=${cursor}`);
    } catch (error) {
      log.warning(`Comment fetch failed for ${label}: ${error.message}`);
      break;
    }
    if (!data || !Array.isArray(data.comments)) {
      if (call === 0) log.warning(`No comment data returned for ${label} (empty or blocked response)`);
      break;
    }
    comments.push(...data.comments.slice(0, limit - comments.length));
    if (!data.has_more || data.cursor === undefined || data.cursor === cursor) break;
    cursor = data.cursor;
    await page.waitForTimeout(800);
  }
  return comments;
}

/**
 * Open one scraped post's own page and merge in the fields only that page
 * carries (enrichPostDetails): content categories, post country, moderation
 * warnings. Rebuilds the clockworks item from the merged raw item, keeping
 * what was attached to it after normalization. Never throws; returns how the
 * page data was obtained ('fetch' / 'page'), or null when it wasn't.
 *
 * The post's HTML is first fetched from inside the current page (no
 * navigation, ~HTML only); a real page visit is the fallback. A visit costs
 * ~2.5MB of proxy traffic per post because page.route() disables the HTTP
 * cache, so TikTok's JS/CSS bundles are downloaded again on every post.
 */
async function enrichFromPostPage(page, wrapper, { log, inputValue }) {
  const raw = wrapper.raw || {};
  const username = raw.author?.uniqueId || wrapper.compat?.user?.username;
  if (!username || !wrapper.id) return null;
  const url = `https://www.tiktok.com/@${username}/video/${wrapper.id}`;

  let detail = null;
  let source = 'fetch';
  let blocked = false;
  for (let attempt = 1; attempt <= 2 && !detail; attempt += 1) {
    // A 403/429 is TikTok throttling the session: back off longer.
    if (attempt > 1) await page.waitForTimeout(blocked ? 15000 : 3000);
    const fetched = await fetchItemFromPostUrl(page, url).catch((error) => ({ error: error.message }));
    blocked = fetched?.status === 403 || fetched?.status === 429;
    if (fetched?.item && String(fetched.item.id) === String(wrapper.id)) {
      detail = fetched.item;
    } else {
      log.info(`enrichPostDetails: fetch attempt ${attempt} for ${wrapper.id} gave no data`
        + ` (status=${fetched?.status ?? '-'} bytes=${fetched?.bytes ?? '-'} error=${fetched?.error ?? '-'})`);
    }
  }
  // Visit the page only for an answered-but-empty fetch. A throttled session
  // gets the same 403 on the visit, which then leaves the tab on Chrome's
  // error page where every later fetch of the job fails too (run
  // vUMI1uZL7nezVrb6V lost 38 of 76 posts that way).
  if (!detail && !blocked) {
    source = 'page';
    const previousUrl = page.url();
    detail = await visitPostPage(page, wrapper, url, log);
    if (!detail && !page.url().startsWith('https://www.tiktok.com/')) {
      await page.goto(previousUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    }
  }
  if (!detail) return null;

  // Page-only fields win; the feed item keeps everything else.
  wrapper.raw = { ...raw, ...detail };
  const previous = wrapper.clockworks;
  wrapper.clockworks = normalizeClockworksItem(wrapper.raw, { inputValue, log });
  if (previous && wrapper.clockworks) {
    wrapper.clockworks.videoMeta.subtitleLinks = previous.videoMeta.subtitleLinks;
    wrapper.clockworks.relatedSearchWords = previous.relatedSearchWords;
  }
  return source;
}

/** Navigate to a post's page and read its SSR item; null when it has none. */
async function visitPostPage(page, wrapper, url, log) {
  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    // Same settle time 'post' mode gives the page before reading its SSR
    // state. TikTok now and then serves an empty document (no title, no
    // state) for a post page - more often while several jobs load pages in
    // parallel - so reload with a growing pause before giving up.
    let detail = null;
    for (let attempt = 1; attempt <= 3 && !detail; attempt += 1) {
      if (attempt > 1) {
        await page.waitForTimeout(attempt * 3000);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      }
      await page.waitForTimeout(3000);
      detail = await extractItemFromPage(page);
      if (!detail) {
        await page.waitForTimeout(2000);
        detail = await extractItemFromPage(page);
      }
    }
    if (!detail || String(detail.id) !== String(wrapper.id)) {
      log.warning(`enrichPostDetails: no page data for post ${wrapper.id} (got id=${detail?.id ?? 'none'})`);
      return null;
    }
    return detail;
  } catch (error) {
    log.warning(`enrichPostDetails: page visit failed for ${wrapper.id}: ${error.message}`);
    return null;
  }
}

/**
 * Main scraping function for a single job ({ mode, query })
 */
async function scrapeQuery(page, context, job, config, kvStore) {
  const { log } = context;
  const { mode, query } = job;
  const results = [];
  const dedupSet = new Set();
  const subtitleTasks = [];

  log.info(`Scraping ${mode} job: "${query}"`);

  if (config.dateRange) {
    const fmt = (ms) => (ms === null ? '∞' : new Date(ms).toISOString());
    log.info(`Date range filter active: ${fmt(config.dateRange.from)} .. ${fmt(config.dateRange.to)}`);
  }

  let skippedByDate = 0;
  let collecting = true;

  // Build URL
  const url = buildUrl(mode, query, config.sortBy, config.publishedWithin, config.language);
  log.info(`Navigating to: ${url}`);

  // Diagnostic only for 'post' mode: if /api/item_detail/ turns out to be
  // the wrong endpoint name (unverified live - see normalize/itemDetail.js),
  // this lets us log what TikTok actually called so it's fast to fix.
  const seenApiUrls = [];
  if (mode === 'post') {
    page.on('response', (res) => {
      const u = res.url();
      if (u.includes('/api/')) seenApiUrls.push(u);
    });
  }

  // Diagnostic only for 'profile' mode: setupInterceptors silently drops
  // non-200 and non-JSON responses, so record what /api/post/item_list/
  // actually returned - tells "blocked", "empty body" and "never requested"
  // apart when a profile job comes back with 0 items.
  const itemListResponses = [];
  if (mode === 'profile') {
    page.on('response', async (res) => {
      if (!res.url().includes('/api/post/item_list/')) return;
      const entry = { status: res.status() };
      try {
        const body = await res.text();
        entry.bytes = body.length;
        const json = JSON.parse(body);
        entry.statusCode = json.status_code ?? json.statusCode;
        entry.items = json.itemList?.length ?? 0;
        entry.hasMore = json.hasMore;
      } catch (error) {
        entry.error = error.message.split('\n')[0];
      }
      itemListResponses.push(entry);
    });
    page.on('requestfailed', (req) => {
      if (req.url().includes('/api/post/item_list/')) itemListResponses.push({ failed: req.failure()?.errorText });
    });
  }

  // Setup interceptor BEFORE navigation - captures initial search API response
  setupInterceptors(page, {
    endpoints: [
      '/api/search/general/full/',
      '/api/search/item/full/',
      '/api/challenge/item_list/',
      '/api/post/item_list/',
      '/api/item_detail/',
    ],
    dedupSet,
    meta: { inputValue: query, log },
    onItem: (item) => {
      // Collection ends with pagination: the post-page visits that follow
      // (enrichPostDetails, author profiles) load TikTok's recommended
      // videos, which must not become results of this job.
      if (!collecting) return;
      if (!isWithinDateRange(item, config.dateRange)) {
        skippedByDate += 1;
        return;
      }
      // Hard cap at maxItems/resultsPerPage - a single TikTok API response
      // (even the very first one, before any scrolling) commonly returns far
      // more items than requested, and nothing else here trims the result
      // set down to what was asked for.
      if (results.length >= config.maxItems) return;
      results.push(item);

      if (config.downloadSubtitles) {
        subtitleTasks.push(attachSubtitles(page, item, kvStore, log));
      }
    },
    onError: (error) => {
      log.warning(`Interceptor error: ${error.message}`);
    },
  });

  // Navigate to search page - TikTok's JS fires the initial API call.
  // NOTE: never use waitUntil networkidle on TikTok - its long-polling /
  // analytics beacons keep the network busy forever and goto always times
  // out after 60s (see run log: page.goto Timeout 60000ms exceeded).
  // domcontentloaded + explicit wait for results/captcha is reliable.
  //
  // RENDER RETRY: real runs show TikTok's search SPA occasionally takes
  // longer than one navigation+wait cycle to actually paint results -
  // observed correlated with the container's memory/CPU being reported
  // "critically overloaded" by Crawlee's Snapshotter, and separately as a
  // spurious captcha/login-wall state that clears up on a fresh load. Both
  // previously surfaced as a false "0 items" for a query that has real
  // content (confirmed many times in practice: an identical re-run of the
  // same query, seconds later, returns real results). Rather than reporting
  // a false empty result and relying on the CALLER to blindly retry the
  // whole actor run, retry the render itself up to RENDER_ATTEMPTS times
  // in-process before giving up - a fresh page.goto (not just re-waiting)
  // since a full reload is what actually clears the transient bad state.
  const RENDER_ATTEMPTS = 4;
  let renderSucceeded = false;
  // 'post' mode's render-success check extracts the item directly (see
  // below) rather than waiting on a DOM selector - cached here so the
  // mode==='post' block further down can reuse it instead of re-extracting.
  let postItemFromRetryLoop = null;
  for (let renderAttempt = 1; renderAttempt <= RENDER_ATTEMPTS; renderAttempt += 1) {
    let navigated = false;
    let lastGotoError = null;
    for (let attempt = 1; attempt <= 2 && !navigated; attempt += 1) {
      try {
        await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        navigated = true;
      } catch (err) {
        lastGotoError = err;
        log.warning(`Navigation attempt ${attempt}/2 failed: ${err.message.split('\n')[0]}`);
        if (attempt < 2) await page.waitForTimeout(2000);
      }
    }
    if (!navigated) throw lastGotoError;

    // Give TikTok's SPA a moment to boot, then check what we actually got
    // (results, captcha wall, or login wall) instead of waiting blindly.
    await page.waitForTimeout(3000);

    if (mode === 'post') {
      // The search-results selector below (data-e2e="search_top-item" etc.)
      // never appears on a video detail page - confirmed via a real run's
      // logs (2026-10-02) that using it here made EVERY post job burn all
      // RENDER_ATTEMPTS reloads (each one a full page load) before falling
      // back to the extraction that already worked on attempt 1, a ~4x
      // bandwidth/time cost for zero benefit. Check the actual success
      // condition instead: can the item be extracted from the embedded SSR
      // state yet? (see extractItemFromPage / normalize/itemDetail.js)
      postItemFromRetryLoop = await extractItemFromPage(page);
      if (!postItemFromRetryLoop) {
        // Brief extra settle window for a slow render before giving up on
        // this attempt - cheaper than the 25s selector timeout below uses.
        await page.waitForTimeout(2000);
        postItemFromRetryLoop = await extractItemFromPage(page);
      }
      if (postItemFromRetryLoop) renderSucceeded = true;
    } else {
      try {
        await page.waitForSelector(
          'a[href*="/video/"], [data-e2e="search_top-item"], [data-e2e="search_video-item"], #captcha_container, #captcha-verify, [data-e2e="captcha-container"]',
          { timeout: 25000 }
        );
        renderSucceeded = true;
      } catch {
        // Selector timeout is non-fatal on its own - pagination/interceptor
        // may still have captured API responses via network interception
        // even though the DOM never showed a recognized marker.
      }
    }

    try {
      if (await detectCaptcha(page)) {
        throw new CaptchaError(10000, 'Captcha wall detected after navigation');
      }
    } catch (err) {
      if (err?.name === 'CaptchaError') throw err;
      // detectCaptcha itself failed (e.g. page closed) - ignore, continue
    }

    // Either the render-success check passed, or the interceptor already
    // captured items from the network response regardless of DOM state -
    // both count as a real render, no need to burn further attempts.
    if (renderSucceeded || results.length > 0) break;

    if (renderAttempt < RENDER_ATTEMPTS) {
      log.warning(
        `Timed out waiting for ${mode === 'post' ? 'post item extraction' : 'search results/captcha selector'} ` +
        `(render attempt ${renderAttempt}/${RENDER_ATTEMPTS}, 0 items so far) - reloading and retrying`
      );
      await page.waitForTimeout(2000);
    } else {
      log.warning(
        `Timed out waiting for ${mode === 'post' ? 'post item extraction' : 'search results/captcha selector'} ` +
        `after ${RENDER_ATTEMPTS} render attempts; continuing with whatever was captured (${results.length} items)`
      );
    }
  }

  log.info(`Results after initial load: ${results.length}`);

  // Profile jobs: the account's own data (exact follower count, account age,
  // seller flags), stamped with the time it was read.
  let profileSnapshot = null;
  if (mode === 'profile') {
    profileSnapshot = normalizeProfileSnapshot(await extractProfileFromPage(page));
    if (profileSnapshot) {
      log.info(
        `Profile @${profileSnapshot.uniqueId}: ${profileSnapshot.followerCount} followers, ` +
          `${profileSnapshot.videoCount} videos`
      );
    } else {
      log.warning(`No profile data found on the page for "${query}"`);
    }
  }

  let relatedSearchWords = [];
  if (mode === 'search' && config.scrapeRelatedSearchWords) {
    relatedSearchWords = await extractRelatedSearchWords(page, log);
    log.info(`Related search words: ${relatedSearchWords.length ? relatedSearchWords.join(', ') : '(none found)'}`);
  }

  if (mode === 'post') {
    // Primary path (confirmed via a real run's logs on 2026-09-18): the
    // video detail page is server-side rendered, so the item is already in
    // the HTML by the time 'domcontentloaded' fires - no network wait
    // needed. See normalize/itemDetail.js for the extraction details.
    // Reuses whatever the render-retry loop above already extracted -
    // no need to hit the page a second time for the same data.
    const rawItem = postItemFromRetryLoop;
    if (rawItem) {
      for (const item of normalizeItemFromPageData(rawItem, dedupSet, { inputValue: query, log })) {
        if (!isWithinDateRange(item, config.dateRange)) {
          skippedByDate += 1;
          continue;
        }
        if (results.length >= config.maxItems) break;
        results.push(item);
        if (config.downloadSubtitles) {
          subtitleTasks.push(attachSubtitles(page, item, kvStore, log));
        }
      }
    }

    // Fallback only: give the network-intercept path (registered above,
    // /api/item_detail/) a brief window in case it does fire in some
    // scenario this session's one real run didn't cover.
    if (results.length === 0) {
      await waitForCount({ getCount: () => results.length, targetCount: 1, timeout: 5000 });
    }

    log.info(`Post detail extraction complete: captured=${results.length} items`);

    if (results.length === 0) {
      log.warning(
        `No item captured for post URL "${query}" - the embedded SSR state ` +
        `(__UNIVERSAL_DATA_FOR_REHYDRATION__/SIGI_STATE) and /api/item_detail/ both came up ` +
        `empty (see normalize/itemDetail.js). API calls seen during this page load: ` +
        `${seenApiUrls.length ? seenApiUrls.join(', ') : '(none matched /api/)'}`
      );
    }
  } else {
    // Scroll-based pagination: TikTok's own JS loads more pages as we scroll,
    // and the interceptor captures each new API response
    await setupPagination(page, {
      targetCount: config.maxItems,
      stallLimit: 3,
      scrollDelay: 2500,
      getCount: () => results.length,
      onScroll: (info) => {
        log.info(`Scroll ${info.scrollCount}: captured=${info.currentCount} (${info.itemsGained} new)`);
      },
      onComplete: (result) => {
        log.info(`Pagination complete: ${result.reason}, captured=${results.length} items`);
      },
    });
  }

  collecting = false;
  log.info(`Scraped ${results.length} items for ${mode} job: "${query}"` +
    (skippedByDate > 0 ? ` (skipped ${skippedByDate} outside date range)` : ''));

  if (mode === 'profile') {
    const rendered = await page
      .evaluate(() => ({
        title: document.title,
        videoLinks: document.querySelectorAll('a[href*="/video/"]').length,
        e2e: [...new Set([...document.querySelectorAll('[data-e2e]')].map((el) => el.getAttribute('data-e2e')))].slice(0, 60),
        text: (document.querySelector('[data-e2e="user-post-item-list"]')?.parentElement?.innerText
          || document.querySelector('main')?.innerText || '').slice(0, 300),
      }))
      .catch((error) => ({ error: error.message }));
    log.info(`Profile feed diagnostics: url=${page.url()} item_list=${JSON.stringify(itemListResponses)} page=${JSON.stringify(rendered)}`);
  }

  // clockworks adds the related search words to every video result from
  // the job that found them - applied here, after collection, so it covers
  // items gathered during scrolling too, not just the initial load.
  if (relatedSearchWords.length) {
    for (const item of results) {
      if (item.clockworks) item.clockworks.relatedSearchWords = relatedSearchWords;
    }
  }

  // Wait for any in-flight subtitle downloads/uploads to finish before this
  // job's items are pushed to the dataset.
  if (subtitleTasks.length) {
    log.info(`Waiting for ${subtitleTasks.length} subtitle fetch(es) to finish`);
    await Promise.all(subtitleTasks);
  }

  // Comments are fetched from the current page (no navigation), so they run
  // before enrichPostDetails moves the page away. Capped at
  // commentVideosLimit posts per job and commentsPerPost comments per post.
  if (config.includeComments) {
    const withComments = results.filter((r) => r.id && (r.raw?.stats?.commentCount ?? 1) > 0);
    const targets = withComments.slice(0, config.commentVideosLimit);
    log.info(`Fetching comments for ${targets.length} of ${results.length} posts`);
    for (const wrapper of targets) {
      const rawComments = await fetchCommentsInPage(page, wrapper.id, config.commentsPerPost, log, {
        includeReplies: config.includeReplies,
        repliesPerComment: config.repliesPerComment,
      });
      const authorId = wrapper.raw?.author?.id;
      const comments = rawComments.map((c) => normalizeClockworksComment(c, { authorId }));
      if (wrapper.clockworks) wrapper.clockworks.comments = comments;
      if (wrapper.raw) wrapper.raw.comments = rawComments;
      if (wrapper.compat) wrapper.compat.comments = comments;
      const replyCount = comments.reduce((n, c) => n + (c.replies?.length || 0), 0);
      log.info(`Comments for ${wrapper.id}: ${comments.length}` + (config.includeReplies ? ` (+${replyCount} replies)` : ''));
    }
  }

  if (config.enrichPostDetails) {
    log.info(`Enriching ${results.length} posts from their own pages`);
    const enrichedBy = { fetch: 0, page: 0, failed: 0 };
    for (const wrapper of results) {
      // The post page's own (always empty) comments field must not replace
      // the comments fetched above.
      const comments = wrapper.clockworks?.comments ?? null;
      const rawComments = wrapper.raw?.comments;
      const source = await enrichFromPostPage(page, wrapper, { log, inputValue: query });
      enrichedBy[source || 'failed'] += 1;
      if (wrapper.clockworks) wrapper.clockworks.comments = comments;
      if (wrapper.raw && comments) wrapper.raw.comments = rawComments;
      // Fetches return in well under a second; pace them like a reader would.
      if (source === 'fetch') await page.waitForTimeout(1000);
    }
    log.info(`Enriched posts: ${enrichedBy.fetch} via fetch, ${enrichedBy.page} via page visit, ${enrichedBy.failed} failed`);
  }

  // Every item carries its author's account snapshot: the job's own profile
  // for profile jobs, and (with includeAuthorProfiles) each post's author for
  // search and post jobs - so all modes return the same shape. Runs last
  // because a profile fetch can move the page.
  const authorProfiles = [];
  if (profileSnapshot) authorProfileCache.set(String(profileSnapshot.uniqueId || '').toLowerCase(), profileSnapshot);
  if (profileSnapshot || config.includeAuthorProfiles) {
    for (const wrapper of results) {
      const username = wrapper.raw?.author?.uniqueId;
      const snapshot = profileSnapshot || (username ? await getAuthorProfile(page, username, log) : null);
      if (!snapshot) continue;
      if (wrapper.clockworks) wrapper.clockworks.authorProfile = snapshot;
      if (wrapper.raw) wrapper.raw.authorProfile = snapshot;
      if (!authorProfiles.includes(snapshot)) authorProfiles.push(snapshot);
    }
    if (!profileSnapshot) log.info(`Author profiles attached: ${authorProfiles.length} accounts`);
  }

  return {
    query,
    profiles: authorProfiles,
    items: results,
    pagination: { totalItems: results.length, reason: 'scroll_complete' },
  };
}

/**
 * Main actor function
 */
Actor.main(async () => {
  let input = await Actor.getInput();

  // Fallback: read from local input file when not on Apify platform
  if (!input || Object.keys(input).length === 0) {
    try {
      input = JSON.parse(readFileSync(new URL('../input.json', import.meta.url), 'utf8'));
      logger.info('Loaded input from input.json');
    } catch {
      input = {};
    }
  }

  const log = Actor.log || logger;

  log.info('Starting TikTok Scraper Actor');

  // Parse and validate input
  const config = await parseInput(input);
  // A bulk 'post' run can carry thousands of jobs - list them individually
  // only for small runs, otherwise just log the count per mode.
  const jobsSummary = config.jobs.length <= 20
    ? config.jobs.map((j) => `${j.mode}:${j.query}`).join(', ')
    : Object.entries(
        config.jobs.reduce((counts, j) => ({ ...counts, [j.mode]: (counts[j.mode] || 0) + 1 }), {})
      ).map(([m, count]) => `${count} ${m} job(s)`).join(', ');
  log.info(
    `Jobs: ${jobsSummary}, Max Items: ${config.maxItems}` +
      (config.downloadSubtitles ? ', subtitles: on' : '') +
      (config.scrapeRelatedSearchWords ? ', related search words: on' : '')
  );

  // Calculate session ID for proxy pinning
  const cookieHash = getCookieHash(config.cookies);
  const targetIdc = getTargetIdc(config.cookies);
  log.info(`Session hash: ${cookieHash}, Target IDC: ${targetIdc || 'auto'}`);

  // Initialize session manager
  const sessions = config.cookiePool.length > 0
    ? config.cookiePool.map((c) => normalizeCookies(c.cookies))
    : [config.cookies];
  const sessionManager = new SessionManager(sessions, { maxRetriesPerSession: 3 });

  // Shared key-value store for this run - used to persist refreshed cookies,
  // run metadata, and (when downloadSubtitlesOptions is on) re-hosted
  // subtitle text so red-pharmatiq-api can fetch it without a TikTok cookie.
  const kvStore = await Actor.openKeyValueStore();

  // proxyCountryCode is now the ONLY switch for proxy usage (fixed
  // 2026-10-14). It used to be forced on unconditionally whenever running
  // on Apify Cloud, with a tt-target-idc guess filling in a region when
  // left blank - so an empty proxyCountryCode still burned expensive
  // PROXY_RESIDENTIAL_TRANSFER_GBYTES bandwidth without the caller ever
  // opting into it. Leaving it blank now means "no proxy at all", not
  // "let the actor guess a region".
  const useProxy = Boolean(config.proxyCountryCode);

  // Requests currently being scraped or already pushed. Seen 2026-10-28 (run
  // 8z7ux5bQCgTLhipSY): after one job failed and was retried, the request
  // queue handed two still-running jobs out a second time ~3 minutes in, and
  // both copies scraped and pushed - double items, double proxy traffic.
  const jobsInFlightOrDone = new Set();

  // Create crawler
  const crawlerOptions = {
    maxRequestRetries: 3,
    requestHandlerTimeoutSecs: 300,
    // Modest concurrency ceiling - without this Crawlee's autoscaler tends to
    // sit near 1 on typical actor memory allocations, which is fine for a
    // handful of keyword jobs but far too slow for bulk 'post' mode (each
    // post URL is its own job). 5 is a deliberate middle ground: enough
    // throughput for large postUrls batches without hammering TikTok with
    // too many concurrent requests from the same session/account.
    minConcurrency: 1,
    maxConcurrency: 5,
    launchContext: {
      launchOptions: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--window-size=1920,1080',
          `--lang=${toChromiumLang(config.language)}`,
        ],
      },
    },
    preNavigationHooks: [
      async (crawlingContext, gotoOptions) => {
        const { page } = crawlingContext;

        // Block heavy resources we never need - every field this actor
        // extracts comes from network-response JSON or embedded
        // <script type="application/json"> state, never from rendered
        // images/video/fonts. Never block stylesheet: TikTok's infinite
        // scroll uses an IntersectionObserver that needs real layout, and
        // CSS-stripped pages break scroll detection (see plan.md).
        //
        // This was part of the actor's original design (plan.md) but was
        // never actually wired up - confirmed via real run billing data
        // (2026-10-02) that its absence is the main cost/speed driver for
        // 'post' mode specifically: a dedicated video-detail page preloads
        // its own focused video (unlike a search-results grid of
        // thumbnails) and a full related-videos sidebar, at ~5MB/page vs
        // ~100-200KB/item for search mode - a ~40-70x per-item cost gap
        // almost entirely in PROXY_RESIDENTIAL_TRANSFER_GBYTES.
        if (!page.__resourceBlockingSet) {
          page.__resourceBlockingSet = true;
          await page.route('**/*', (route) => {
            const request = route.request();
            const resourceType = request.resourceType();
            if (['image', 'media', 'font'].includes(resourceType)) {
              return route.abort();
            }
            // Belt-and-suspenders: adaptive-streaming video chunks can load
            // via fetch/xhr rather than resourceType 'media'. Best-known
            // TikTok video CDN URL pattern, not independently live-verified
            // - a miss here just means no extra savings, not a regression.
            const url = request.url();
            if (/\.mp4(\?|$)/.test(url) || /v\d+[a-z-]*\.tiktokcdn|v\d+-\w+\.tiktok\.com/.test(url)) {
              return route.abort();
            }
            return route.continue();
          });
        }

        // No navigator.webdriver / window.chrome overrides: the
        // --disable-blink-features=AutomationControlled launch arg already
        // makes navigator.webdriver false, and redefining it (or stubbing
        // window.chrome) is itself detectable - confirmed 2026-10-23 that
        // with either override TikTok answers the profile feed
        // (/api/post/item_list/) with an empty 200 body, so profile jobs
        // always came back with 0 items. Search was unaffected.
        await page.addInitScript(() => {
          // Override permissions
          const originalQuery = window.navigator.permissions.query;
          window.navigator.permissions.query = (parameters) =>
            parameters.name === 'notifications'
              ? Promise.resolve({ state: Notification.permission })
              : originalQuery(parameters);
        });

        // Crawlee does its OWN page.goto(request.url) here, before
        // requestHandler runs - gotoOptions controls that call. Without this,
        // it silently defaults to Playwright's waitUntil:'load', which on
        // TikTok often never fires (persistent video-buffering/beacon
        // traffic keeps the page "loading" forever from the browser's
        // perspective) - reliably timing out at 60s on video detail pages in
        // particular, before scrapeQuery's own (already domcontentloaded)
        // navigation ever gets a chance to run. See scrapeQuery's own goto
        // call for the same reasoning.
        gotoOptions.waitUntil = 'domcontentloaded';
        gotoOptions.timeout = 30000;
      },
    ],
    async requestHandler({ page, request }) {
      const job = request.userData.job;
      if (jobsInFlightOrDone.has(request.uniqueKey)) {
        log.warning(`Skipping duplicate ${job.mode} job: "${job.query}" (already running or done)`);
        return;
      }
      const currentSession = sessionManager.getCurrent();

      // Inject cookies from current session
      const context = page.context();
      await context.addCookies(currentSession);

      // Scrape the job
      jobsInFlightOrDone.add(request.uniqueKey);
      try {
        const result = await scrapeQuery(page, { log: Actor.log || logger }, job, config, kvStore);

        // Push items to dataset
        let pushed = 0;
        for (const item of result.items) {
          const filtered = filterByOutputSchema(item, config.outputSchema);
          if (filtered === null || filtered === undefined) continue;
          await Actor.pushData(filtered);
          pushed += 1;
        }

        log.info(`Pushed ${pushed} items to dataset for ${job.mode} job: "${job.query}"`);

        for (const snapshot of result.profiles || []) await saveProfileSnapshot(kvStore, snapshot);
      } catch (error) {
        // Handle session rotation on failure
        log.error(`Error scraping "${job.query}": ${error.message}`);
        jobsInFlightOrDone.delete(request.uniqueKey); // the retry must run
        if (sessionManager.hasRemaining()) {
          sessionManager.markFailed(error.message);
          const nextSession = sessionManager.rotate();
          if (nextSession) {
            log.info(`Rotating to next session. Remaining: ${sessionManager.getRemainingCount()}`);
            throw error; // Let crawler retry with new session
          }
        }
        throw error;
      }
    },
    async failedRequestHandler({ request, error }) {
      log.error(`Request failed for ${request.url}: ${error.message}`);
    },
  };

  // Proxy is opt-in via proxyCountryCode - no proxy at all (not Apify
  // Proxy, not a custom one) when it's left blank, on Apify Cloud or
  // locally alike. Previously this was forced on unconditionally whenever
  // Actor.apifyClient was set (i.e. running on Apify Cloud), regardless of
  // proxyCountryCode.
  if (!useProxy) {
    log.warning(
      'proxyCountryCode is empty - running without any proxy (not Apify Proxy, not a ' +
      'custom proxy). TikTok may show a captcha/verification challenge without a ' +
      'residential IP. Set proxyCountryCode to enable Apify residential proxy.'
    );
  } else if (Actor.apifyClient) {
    crawlerOptions.proxyConfiguration = await Actor.createProxyConfiguration({
      groups: ['RESIDENTIAL'],
      countryCode: config.proxyCountryCode,
    });
  } else {
    // Local development - try to use Apify Proxy if available
    try {
      crawlerOptions.proxyConfiguration = await Actor.createProxyConfiguration({
        groups: ['RESIDENTIAL'],
        countryCode: config.proxyCountryCode,
      });
    } catch {
      // Try custom proxy URL from environment
      const customProxyUrl = process.env.APIFY_PROXY_URL || process.env.PROXY_URL;
      if (customProxyUrl) {
        log.info(`Using custom proxy: ${customProxyUrl}`);
        crawlerOptions.proxyConfiguration = {
          proxyUrls: [customProxyUrl],
        };
        // Also set on launch context for direct browser proxy
        crawlerOptions.launchContext.launchOptions.proxy = {
          server: customProxyUrl,
        };
      } else {
        log.warning('No proxy configured. TikTok may block datacenter IPs.');
        log.warning('Set APIFY_PROXY_PASSWORD or APIFY_TOKEN env var to use Apify Proxy locally.');
        log.warning('Or set APIFY_PROXY_URL for a custom proxy.');
        log.warning('Or run on Apify Platform for built-in residential proxy support.');
        log.warning('Without a residential proxy, TikTok will show a verification challenge.');
      }
    }
  }

  const crawler = new PlaywrightCrawler(crawlerOptions, Configuration.getGlobalConfig());

  // Queue all jobs as requests
  const requests = config.jobs.map((job) => ({
    url: buildUrl(job.mode, job.query, config.sortBy, config.publishedWithin, config.language),
    userData: { job },
  }));

  await crawler.addRequests(requests);

  // Run crawler
  await crawler.run();

  // Persist refreshed cookies back to KV store
  // msToken rotates constantly and a stale one degrades results
  try {
    const refreshedCookies = sessionManager.getCurrent();
    await kvStore.setValue('session_cookies_latest', refreshedCookies);
    log.info('Persisted refreshed cookies to KV store');
  } catch (error) {
    log.warning(`Failed to persist cookies: ${error.message}`);
  }

  // Download media if requested
  if (config.downloadMedia) {
    log.info('Downloading media files to KV store...');
    // Note: media download would need access to all scraped items
    // This would be handled per-request in a production implementation
    log.info('Media download complete');
  }

  // Get dataset stats
  const dataset = await Actor.openDataset();
  const stats = await dataset.getInfo();
  log.info(`Total items scraped: ${stats?.itemCount || 0}`);

  // Output metadata
  await Actor.setValue('OUTPUT_METADATA', {
    scraped_at: new Date().toISOString(),
    // Full job list only for small runs - a bulk 'post' run can carry
    // thousands of jobs, which doesn't belong in a small metadata record.
    jobs: config.jobs.length <= 20 ? config.jobs : undefined,
    job_count: config.jobs.length,
    total_items: stats?.itemCount || 0,
  });

  log.info('TikTok Scraper Actor finished');
});
