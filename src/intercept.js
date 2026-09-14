/**
 * intercept.js — Response listener + endpoint router
 *
 * Registers network response handlers for TikTok API endpoints.
 * Routes each intercepted response to the appropriate normalizer.
 */

import { normalizeSearchItem, normalizeSearchGeneral } from './normalize/searchItem.js';
import { normalizeChallengeItem } from './normalize/challengeItem.js';
import { normalizeCommentList } from './normalize/comment.js';

// API endpoint path matchers
export const ENDPOINTS = {
  SEARCH_GENERAL: '/api/search/general/full/',
  SEARCH_ITEM: '/api/search/item/full/',
  CHALLENGE_ITEM: '/api/challenge/item_list/',
  POST_ITEM_LIST: '/api/post/item_list/',
  COMMENT_LIST: '/api/comment/list/',
  USER_DETAIL: '/api/user/detail/',
};

// TikTok API status codes
export const STATUS_CODES = {
  OK: 0,
  CAPTCHA: 10000,
  RATE_LIMIT: 10101,
  LOGIN_REQUIRED: 22000,
};

export class CaptchaError extends Error {
  constructor(statusCode, message = 'Captcha/Signature required') {
    super(message);
    this.name = 'CaptchaError';
    this.statusCode = statusCode;
  }
}

export class RateLimitError extends Error {
  constructor(message = 'Rate limited') {
    super(message);
    this.name = 'RateLimitError';
  }
}

/**
 * Register response interception handlers on a Playwright page
 */
export function setupInterceptors(page, options = {}) {
  const {
    onItem = () => {},
    onRaw = () => {},
    onError = () => {},
    endpoints = Object.values(ENDPOINTS),
    dedupSet = null,
    meta = {},
  } = options;

  const seenIds = dedupSet || new Set();

  page.on('response', async (res) => {
    const url = res.url();

    // Check if this response matches any endpoint we care about
    const matchedEndpoint = endpoints.find((t) => url.includes(t));
    if (!matchedEndpoint) return;

    // Only process successful responses
    if (res.status() !== 200) return;

    try {
      const json = await res.json();

      // Check for error status codes
      if (json.status_code && json.status_code !== STATUS_CODES.OK) {
        if (json.status_code === STATUS_CODES.CAPTCHA) {
          throw new CaptchaError(json.status_code);
        }
        if (json.status_code === STATUS_CODES.RATE_LIMIT) {
          throw new RateLimitError();
        }
        // Other status codes - log and continue
        onError(new Error(`API error: ${json.status_code}`));
        return;
      }

      // Route to appropriate normalizer
      const normalized = normalizeResponse(json, matchedEndpoint, seenIds, meta);

      if (normalized && normalized.length > 0) {
        for (const item of normalized) {
          onItem(item);
        }
      }

      // Always emit raw for downstream processing
      onRaw({
        endpoint: matchedEndpoint,
        url,
        data: json,
        itemCount: normalized?.length || 0,
        hasMore: json.hasMore ?? json.has_more ?? false,
        cursor: json.cursor ?? json.minCursor ?? null,
      });
    } catch (e) {
      if (e instanceof CaptchaError || e instanceof RateLimitError) {
        throw e; // Re-throw for the caller to handle
      }
      // Non-JSON response or parse error - skip silently
    }
  });

  return {
    ENDPOINTS,
    STATUS_CODES,
  };
}

/**
 * Route a response to the correct normalizer based on endpoint
 */
function normalizeResponse(data, endpoint, seenIds, meta = {}) {
  switch (endpoint) {
    case ENDPOINTS.SEARCH_GENERAL:
      return normalizeSearchGeneral(data, seenIds, meta);
    case ENDPOINTS.SEARCH_ITEM:
      return normalizeSearchItem(data, seenIds, meta);
    case ENDPOINTS.CHALLENGE_ITEM:
      return normalizeChallengeItem(data, seenIds, meta);
    case ENDPOINTS.POST_ITEM_LIST:
      return normalizeSearchItem(data, seenIds, meta); // Same structure as search
    case ENDPOINTS.COMMENT_LIST:
      return normalizeCommentList(data, seenIds);
    default:
      return [];
  }
}


