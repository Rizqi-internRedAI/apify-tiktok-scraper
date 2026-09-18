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
import { extractItemFromPage, normalizeItemFromPageData } from './normalize/itemDetail.js';

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
  const downloadMedia = input.downloadMedia || false;
  // 'clockworks' is the default, not 'compat': red-pharmatiq-api's payloads
  // never set outputSchema (it's not part of clockworks' own input contract),
  // so the shape it actually gets has to work with no explicit opt-in.
  // Pass outputSchema:'compat' explicitly for the legacy Threads-style shape.
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
  const proxyCountryCode = input.proxyCountryCode || null;
  const downloadSubtitles = input.downloadSubtitlesOptions === 'DOWNLOAD_SUBTITLES';

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
    downloadMedia,
    outputSchema,
    proxyCountryCode,
    downloadSubtitles,
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

/**
 * Scrape comments for a specific video
 */
async function scrapeComments(page, videoId, authorUsername, config) {
  if (!config.includeComments) return [];

  const log = Actor.log;
  log.info(`Scraping comments for video: ${videoId}`);

  const comments = [];
  const dedupSet = new Set();

  // Setup comment interceptor
  setupInterceptors(page, {
    endpoints: ['/api/comment/list/'],
    dedupSet,
    onItem: (item) => {
      if (item.compat && item.compat._type === 'comment') {
        comments.push(item.compat);
      }
    },
    onError: (error) => {
      log.warning(`Comment interceptor error: ${error.message}`);
    },
  });

  // Navigate to video page
  await page.goto(`https://www.tiktok.com/@${authorUsername}/video/${videoId}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  // Wait for comments to load
  await page.waitForTimeout(2000);

  // Scroll to load more comments
  await setupPagination(page, {
    targetCount: config.commentsPerPost,
    stallLimit: 3,
    scrollDelay: 1500,
  });

  return comments;
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

  // Setup interceptor BEFORE navigation - captures initial search API response
  setupInterceptors(page, {
    endpoints: [
      '/api/search/general/full/',
      '/api/search/item/full/',
      '/api/challenge/item_list/',
      '/api/post/item_list/',
      '/api/comment/list/',
      '/api/item_detail/',
    ],
    dedupSet,
    meta: { inputValue: query },
    onItem: (item) => {
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
  try {
    await page.waitForSelector(
      'a[href*="/video/"], [data-e2e="search_top-item"], [data-e2e="search_video-item"], #captcha_container, #captcha-verify, [data-e2e="captcha-container"]',
      { timeout: 20000 }
    );
  } catch {
    // Selector timeout is non-fatal - pagination/interceptor may still
    // have captured API responses; log state for diagnostics.
    log.warning('Timed out waiting for search results/captcha selector; continuing anyway');
  }

  try {
    if (await detectCaptcha(page)) {
      throw new CaptchaError(10000, 'Captcha wall detected after navigation');
    }
  } catch (err) {
    if (err?.name === 'CaptchaError') throw err;
    // detectCaptcha itself failed (e.g. page closed) - ignore, continue
  }

  log.info(`Results after initial load: ${results.length}`);

  if (mode === 'post') {
    // Primary path (confirmed via a real run's logs on 2026-09-18): the
    // video detail page is server-side rendered, so the item is already in
    // the HTML by the time 'domcontentloaded' fires - no network wait
    // needed. See normalize/itemDetail.js for the extraction details.
    const rawItem = await extractItemFromPage(page);
    if (rawItem) {
      for (const item of normalizeItemFromPageData(rawItem, dedupSet, { inputValue: query })) {
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

  log.info(`Scraped ${results.length} items for ${mode} job: "${query}"` +
    (skippedByDate > 0 ? ` (skipped ${skippedByDate} outside date range)` : ''));

  // Wait for any in-flight subtitle downloads/uploads to finish before this
  // job's items are pushed to the dataset.
  if (subtitleTasks.length) {
    log.info(`Waiting for ${subtitleTasks.length} subtitle fetch(es) to finish`);
    await Promise.all(subtitleTasks);
  }

  // Optionally scrape comments for each video
  if (config.includeComments) {
    const videosWithComments = results.filter((r) => r.compat?.videos && r.compat.videos.length > 0);
    log.info(`Scraping comments for ${videosWithComments.length} videos`);

    for (const video of videosWithComments.slice(0, 10)) {
      try {
        const comments = await scrapeComments(page, video.compat.post_id, video.compat.user.username, config);
        video.compat.comments = comments;
      } catch (error) {
        log.warning(`Failed to scrape comments for ${video.compat.post_id}: ${error.message}`);
      }
    }
  }

  return {
    query,
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
      (config.downloadSubtitles ? ', subtitles: on' : '')
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

  // proxyCountryCode (clockworks-compatible input field) takes priority over
  // the tt-target-idc-derived guess when choosing the proxy exit region.
  const proxyCountryCode = config.proxyCountryCode
    || (targetIdc === 'alisg' ? 'SG' : (targetIdc === 'useast2a' ? 'US' : undefined));

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
        // Override navigator.webdriver to avoid detection
        await page.addInitScript(() => {
          Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined,
          });
          // Override chrome detection
          window.chrome = { runtime: {} };
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
      const currentSession = sessionManager.getCurrent();

      // Inject cookies from current session
      const context = page.context();
      await context.addCookies(currentSession);

      // Scrape the job
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
      } catch (error) {
        // Handle session rotation on failure
        log.error(`Error scraping "${job.query}": ${error.message}`);
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

  // Add proxy configuration only if on Apify platform (has proxy support)
  // For local dev, you need APIFY_PROXY_PASSWORD or APIFY_TOKEN env var
  // Or use a custom residential proxy
  if (Actor.apifyClient) {
    crawlerOptions.proxyConfiguration = await Actor.createProxyConfiguration({
      groups: ['RESIDENTIAL'],
      countryCode: proxyCountryCode,
    });
  } else {
    // Local development - try to use Apify Proxy if available
    try {
      crawlerOptions.proxyConfiguration = await Actor.createProxyConfiguration({
        groups: ['RESIDENTIAL'],
        countryCode: proxyCountryCode,
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
