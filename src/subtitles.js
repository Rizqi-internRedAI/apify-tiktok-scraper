/**
 * subtitles.js — Downloads TikTok's own closed-caption tracks and re-hosts
 * them in this run's Apify key-value store, so red-pharmatiq-api's
 * subtitle_fetcher.py (unchanged) can fetch videoMeta.subtitleLinks[].downloadLink
 * with just `?token=<apify token>` appended, no TikTok cookie required.
 *
 * Field name note: `video.subtitleInfos` is the best-known current TikTok API
 * field for closed-caption tracks (used by other TikTok tooling for years),
 * but has not been independently re-verified live in this session. If it's
 * wrong, extractSubtitleInfos logs the actual keys under item.video once per
 * run so it's fast to spot and fix on the first real run with cookies.
 */

let loggedMissingOnce = false;

/**
 * Read the raw closed-caption track list off a TikTok item, if present.
 */
export function extractSubtitleInfos(item, log = console) {
  const video = item?.video || {};
  const infos = video.subtitleInfos;
  if (Array.isArray(infos) && infos.length) return infos;

  if (!loggedMissingOnce) {
    loggedMissingOnce = true;
    log.warning?.(
      `video.subtitleInfos not found on item ${item?.id}; keys under item.video: ` +
        `[${Object.keys(video).join(', ')}]. If TikTok renamed this field, ` +
        `update src/subtitles.js accordingly.`
    );
  }
  return [];
}

/**
 * Download each subtitle track (via the page's authenticated request
 * context, so it reuses the active session automatically) and re-host the
 * raw text in `kvStore`. Never throws — a failed track is just dropped.
 * Returns an array shaped for videoMeta.subtitleLinks.
 */
export async function uploadSubtitles(page, itemId, subtitleInfos, kvStore, log = console) {
  const results = [];

  for (let i = 0; i < subtitleInfos.length; i += 1) {
    const info = subtitleInfos[i];
    const url = info?.Url || info?.url;
    if (!url) continue;

    try {
      const response = await page.context().request.get(url);
      if (!response.ok()) {
        log.warning?.(`Subtitle fetch failed for item ${itemId} (${response.status()}): ${url}`);
        continue;
      }
      const text = await response.text();
      if (!text) continue;

      const key = `subtitle_${itemId}_${i}`;
      await kvStore.setValue(key, text, { contentType: 'text/vtt' });
      // getPublicUrl is the documented Apify SDK v3 helper for this; fall
      // back to constructing the record URL by hand if it's ever missing
      // (e.g. an older SDK version) so this doesn't hard-fail silently.
      const downloadLink = typeof kvStore.getPublicUrl === 'function'
        ? kvStore.getPublicUrl(key)
        : `https://api.apify.com/v2/key-value-stores/${kvStore.id}/records/${key}`;

      results.push({
        downloadLink,
        language: info?.LanguageCodeName || info?.LanguageID || null,
      });
    } catch (err) {
      log.warning?.(`Subtitle upload error for item ${itemId}: ${err.message}`);
    }
  }

  return results;
}
