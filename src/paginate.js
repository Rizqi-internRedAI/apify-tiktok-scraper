/**
 * paginate.js — Scroll driver with stall detection
 *
 * Drives TikTok's infinite scroll by executing JavaScript in the page.
 * Monitors for new API responses and stops when:
 * - Target count reached
 * - No more pages (has_more === 0)
 * - N consecutive empty scrolls (stall)
 * - Max scrolls reached
 */

/**
 * Setup scroll-based pagination on a Playwright page
 */
export async function setupPagination(page, options = {}) {
  const {
    targetCount = 200,
    maxScrolls = 50,
    stallLimit = 5,
    scrollDelay = 2000,
    onScroll = () => {},
    onComplete = () => {},
    onStall = () => {},
    // Optional: () => number - the caller's own real captured/deduped item
    // count (e.g. results.length in main.js), used instead of the DOM link
    // count below. The DOM count is only a rough proxy for what's actually
    // been intercepted off the network - TikTok's search API can return far
    // more items per response than are rendered/countable in the DOM at any
    // given instant, so relying on it alone let pagination keep scrolling
    // (or stop late) independently of how many items were truly captured.
    getCount = null,
  } = options;

  let scrollCount = 0;
  let emptyScrolls = 0;
  let lastItemCount = 0;
  let noNewDataCount = 0;

  // A caller-supplied getCount may already be at/above target before the
  // first scroll (e.g. the initial page load's own API response already
  // returned enough items) - check before scrolling at all so we don't
  // scroll (and keep intercepting more than requested) unnecessarily.
  if (getCount) {
    const initialCount = await getCount();
    if (initialCount >= targetCount) {
      onComplete({ reason: 'target_reached', scrollCount, totalItems: initialCount });
      return { scrollCount, totalItems: initialCount, reason: 'target_reached' };
    }
    lastItemCount = initialCount;
  }

  while (scrollCount < maxScrolls) {
    // Perform scroll
    await scrollDown(page);
    scrollCount++;

    // Wait for potential new content
    await waitForResponse(page, scrollDelay);

    // Check if new items were loaded
    const newCount = getCount ? await getCount() : await getItemCount(page);
    const itemsGained = newCount - lastItemCount;

    onScroll({
      scrollCount,
      currentCount: newCount,
      itemsGained,
      targetCount,
    });

    // Check if we've reached target
    if (newCount >= targetCount) {
      onComplete({ reason: 'target_reached', scrollCount, totalItems: newCount });
      return { scrollCount, totalItems: newCount, reason: 'target_reached' };
    }

    // Detect stall - no new items loaded
    if (itemsGained === 0) {
      noNewDataCount++;
      emptyScrolls++;

      if (noNewDataCount >= stallLimit) {
        onStall({ scrollCount, emptyScrolls });
        onComplete({ reason: 'stall', scrollCount, totalItems: newCount });
        return { scrollCount, totalItems: newCount, reason: 'stall' };
      }
    } else {
      noNewDataCount = 0;
      emptyScrolls = 0;
    }

    lastItemCount = newCount;
  }

  onComplete({ reason: 'max_scrolls', scrollCount, totalItems: lastItemCount });
  return { scrollCount, totalItems: lastItemCount, reason: 'max_scrolls' };
}

/**
 * Poll (no scrolling) until getCount() reaches targetCount or timeout
 * elapses. For single-item pages (a video's own detail page) where there's
 * nothing to scroll - just an async XHR to wait for.
 */
export async function waitForCount({ getCount, targetCount = 1, timeout = 20000, pollInterval = 500 }) {
  const start = Date.now();
  let count = await getCount();

  while (count < targetCount && Date.now() - start < timeout) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
    count = await getCount();
  }

  return {
    totalItems: count,
    reason: count >= targetCount ? 'target_reached' : 'timeout',
  };
}

/**
 * Scroll down on the page to trigger infinite scroll
 *
 * Scrolls in small steps (so TikTok's lazy loader sees gradual progress),
 * then jumps to the bottom. Also scrolls the inner results container if
 * the window itself is not the scrollable element.
 */
async function scrollDown(page) {
  await page.evaluate(() => {
    const step = window.innerHeight * 0.8;
    // Gradual steps
    for (let y = window.scrollY; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
    }
    // Final jump to bottom
    window.scrollTo(0, document.documentElement.scrollHeight);

    // Also scroll inner containers (TikTok sometimes scrolls a div, not window)
    const containers = document.querySelectorAll(
      '[class*="DivSearchResultContainer"], [class*="search-result"], main, [class*="DivBrowseContainer"]'
    );
    for (const el of containers) {
      el.scrollTop = el.scrollHeight;
    }
  });
  // Let smooth-scroll / lazy-load settle
  await page.keyboard.press('End').catch(() => {});
}

/**
 * Get current item count from the page (for tracking progress)
 */
async function getItemCount(page) {
  return page.evaluate(() => {
    // Count video links on page - this is the most reliable indicator
    const videoLinks = document.querySelectorAll('a[href*="/video/"]');
    if (videoLinks.length > 0) return videoLinks.length;
    
    // Fallback to container selectors
    const items = document.querySelectorAll('[data-e2e="search_top-item"], [data-e2e="search_video-item"], .DivItemContainer, [class*="ItemContainer"], [class*="video-result"]');
    return items.length;
  });
}

/**
 * Wait for a new response to land (simple delay-based approach)
 */
async function waitForResponse(page, delay) {
  await page.waitForTimeout(delay);
}

/**
 * Check if there's a "no more results" indicator
 */
async function checkHasMore(page) {
  return page.evaluate(() => {
    // Look for end-of-results indicators
    const noMore = document.querySelector('[data-e2e="search-no-more"]');
    const loadMore = document.querySelector('[data-e2e="search-load-more"]');
    return !noMore && !!loadMore;
  });
}

/**
 * Alternative: wait for a specific network response
 */
export async function waitForResponsePromise(page, timeout = 5000) {
  return new Promise((resolve) => {
    let resolved = false;

    const handler = async (response) => {
      const url = response.url();
      if (url.includes('/api/search/') || url.includes('/api/challenge/')) {
        if (!resolved) {
          resolved = true;
          page.off('response', handler);
          resolve(true);
        }
      }
    };

    page.on('response', handler);

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        page.off('response', handler);
        resolve(false);
      }
    }, timeout);
  });
}
