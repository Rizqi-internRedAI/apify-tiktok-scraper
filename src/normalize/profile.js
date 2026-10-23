/**
 * normalize/profile.js — The account-level data of a profile job, read from
 * the profile page's embedded SSR state (webapp.user-detail). Unlike the
 * per-post authorStats (rounded, e.g. 87600), the profile page carries exact
 * counts (statsV2, e.g. 87637) plus account facts that never appear on a
 * post: creation date, seller flags, language.
 *
 * Each snapshot is stamped with scrapedAt, so calling the actor on a schedule
 * builds the follower history TikTok itself does not expose (follower growth
 * cannot be backdated).
 */

/**
 * Read the raw webapp.user-detail userInfo off the current profile page.
 * Returns null when the page has no such state (private/banned account,
 * captcha wall, or TikTok changed its SSR shape).
 */
export async function extractProfileFromPage(page) {
  return page.evaluate(() => {
    try {
      const el = document.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__');
      if (!el || !el.textContent) return null;
      const scope = JSON.parse(el.textContent)?.__DEFAULT_SCOPE__ || {};
      const detail = scope['webapp.user-detail'];
      if (!detail || detail.statusCode !== 0) return null;
      return detail.userInfo || null;
    } catch {
      return null;
    }
  });
}

function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) ? n : null;
}

/**
 * Flatten the raw userInfo into the snapshot attached to every item of the
 * profile job (clockworks `authorProfile`) and saved to the run's key-value
 * store (PROFILE_SNAPSHOTS).
 */
export function normalizeProfileSnapshot(userInfo, { scrapedAt = new Date().toISOString() } = {}) {
  if (!userInfo?.user) return null;
  const user = userInfo.user;
  // statsV2 holds exact counts as strings; stats holds rounded numbers.
  const stats = { ...(userInfo.stats || {}), ...(userInfo.statsV2 || {}) };
  const createTime = num(user.createTime);

  return {
    scrapedAt,
    id: user.id || null,
    uniqueId: user.uniqueId || null,
    nickname: user.nickname || null,
    profileUrl: user.uniqueId ? `https://www.tiktok.com/@${user.uniqueId}` : null,
    signature: user.signature || null,
    verified: user.verified ?? null,
    privateAccount: user.privateAccount ?? null,
    isOrganization: user.isOrganization === undefined ? null : Boolean(user.isOrganization),
    language: user.language || null,
    accountCreateTime: createTime,
    accountCreateTimeISO: createTime ? new Date(createTime * 1000).toISOString() : null,
    // TikTok seller account / commerce (affiliate-enabled) account flags.
    ttSeller: user.ttSeller ?? null,
    commerceUser: user.commerceUserInfo?.commerceUser ?? null,
    followerCount: num(stats.followerCount),
    followingCount: num(stats.followingCount),
    heartCount: num(stats.heartCount ?? stats.heart),
    videoCount: num(stats.videoCount),
    diggCount: num(stats.diggCount),
    friendCount: num(stats.friendCount),
  };
}
