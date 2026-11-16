/**
 * Country filter for scraped posts (`postCountries` input).
 *
 * `locationCreated` (the country a post was made in, e.g. "ID") is only on a
 * post's own page, so a keyword/hashtag scrape never has it unless
 * `enrichPostDetails` is on. Setting `postCountries` turns that enrichment on
 * and drops every post made in another country, so foreign content never
 * reaches the dataset (and nothing downstream pays to analyze it).
 */

/** Accepts an array or a comma/space separated string; returns unique upper-case codes. */
export function normalizeCountryList(value) {
  const parts = Array.isArray(value) ? value : String(value ?? '').split(/[\s,;]+/);
  return [...new Set(
    parts.map((part) => String(part ?? '').trim().toUpperCase()).filter(Boolean)
  )];
}

/**
 * Whether a post made in `locationCreated` stays. An empty `allowed` list
 * keeps everything. A post whose country is unknown (its page could not be
 * read) stays unless `keepUnknown` is false: dropping it would also drop real
 * Indonesian posts whenever TikTok throttles the page fetch.
 */
export function keepByPostCountry(locationCreated, allowed, keepUnknown = true) {
  if (!allowed || allowed.length === 0) return true;
  const code = String(locationCreated ?? '').trim().toUpperCase();
  if (!code) return keepUnknown;
  return allowed.includes(code);
}
