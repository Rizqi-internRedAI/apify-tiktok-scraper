# TikTok Scraper Actor

An Apify actor that scrapes TikTok data using session cookies and network interception. No DOM parsing required — data is captured directly from TikTok's internal API.

## Features

- **Network Interception**: Captures responses from TikTok's API endpoints without parsing HTML
- **Session Cookie Support**: Accepts cookies in multiple formats (raw header, JSON array, Netscape cookies.txt)
- **Multiple Modes**: Search, hashtag, and profile scraping
- **Efficient Resource Usage**: Blocks heavy resources (images, media, fonts) while keeping CSS for proper scroll behavior
- **Anti-Bot Handling**: Captcha detection, exponential backoff, and session rotation
- **Deduplication**: Automatic deduplication by item ID
- **Flexible Output**: Compat (Threads-style), native (full TikTok data), or both

## Input

The Console form only shows the two fields that actually drive what gets
scraped — everything else is either config (cookies, proxy, output shape) or
a filter:

- **`hashtags`** — the field `red-pharmatiq-api` actually sends brand
  keywords in. Runs each as a **real TikTok keyword search** (leading `#`
  stripped) rather than clockworks' hashtag/challenge OR-match — that's the
  whole point of using this actor instead of clockworks.
- **`profiles`** — usernames to scrape as profile feeds. Used by
  `red-pharmatiq-api`'s `POST /api/scrape/tiktok/profile`.

Both are queued together (not either/or) when both are non-empty.

<details>
<summary>Legacy/advanced fields (hidden from the Console form, still accepted if sent programmatically)</summary>

`mode` + `queries` (this actor's original fields, used only when
`profiles`/`hashtags`/`searchQueries` are all empty), `searchQueries` (same as
`hashtags` but without the `#` stripped — `red-pharmatiq-api` doesn't use
this one), and `maxItems` (alias for `resultsPerPage`, same effect). Left out
of `INPUT_SCHEMA.json` to keep the form focused on what's actually used, but
`src/main.js` still reads them if present.

</details>

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `profiles` | array | `[]` | Usernames to scrape as profile feeds |
| `hashtags` | array | `[]` | Keywords — run as real keyword search (leading `#` stripped), not hashtag OR-match. What `red-pharmatiq-api` sends |
| `resultsPerPage` | integer | `150` | Max items scraped per `hashtags`/`profiles` entry |
| `sessionCookies` | string | `""` | Session cookies (raw header, JSON, or cookies.txt) |
| `cookiePool` | array | `[]` | Multiple cookie sets for rotation |
| `sortBy` | string | `relevance` | Sort order: `relevance` or `latest` |
| `publishedWithin` | string | `all` | Server-side time filter: `all`, `1d`, `7d`, `30d`, `90d`, `180d` |
| `dateFrom` | string | `""` | Keep posts published on/after this date (`YYYY-MM-DD` or ISO datetime). Client-side, all modes |
| `dateTo` | string | `""` | Keep posts published on/before this date (inclusive). Client-side, all modes |
| `language` | string | `""` | ISO language code to scope search results. Empty by default — `red-pharmatiq-api`'s ingestion pipeline already filters to id/en downstream, so the scrape itself doesn't need to narrow by language |
| `includeComments` | boolean | `false` | Whether to scrape comments |
| `commentsPerPost` | integer | *(unset, falls back to 20)* | Max comments per video, only relevant when `includeComments` is on — not currently used by `red-pharmatiq-api` |
| `downloadMedia` | boolean | `false` | Download media to KV store |
| `outputSchema` | string | `clockworks` | Output format: `clockworks` (default), `compat`, `native`, or `both` |
| `proxyCountryCode` | string | `""` | clockworks-compatible. Proxy exit country code (e.g. `ID`); overrides the tt-target-idc guess |
| `downloadSubtitlesOptions` | string | `NO_SUBTITLES` | clockworks-compatible. `DOWNLOAD_SUBTITLES` fetches TikTok's native closed captions and re-hosts them in this run's key-value store |

### Cookie Format

Cookies can be provided in any of these formats:

1. **Raw Cookie header** (copy from browser DevTools):
   ```
   sessionid=abc123; sessionid_ss=abc123; sid_tt=xyz789; sid_guard=xyz789; msToken=...
   ```

2. **JSON array** (EditThisCookie/Playwright format):
   ```json
   [{"name": "sessionid", "value": "abc123", "domain": ".tiktok.com"}, ...]
   ```

3. **Netscape cookies.txt**:
   ```
   # Netscape HTTP Cookie File
   .tiktok.com	TRUE	/	TRUE	1234567890	sessionid	abc123
   ```

### Required Cookies

At minimum, these cookies must be present:
- `sessionid`
- `sessionid_ss`
- `sid_tt`
- `sid_guard`

Additional cookies that improve results:
- `ttwid`, `msToken`, `tt-target-idc`, `uid_tt`

### Cookies for clockworks-compatible callers (no `sessionCookies` in the payload)

`red-pharmatiq-api`'s payloads are built to match clockworks/tiktok-scraper's
input shape (`hashtags`/`searchQueries`/`profiles`/`resultsPerPage`/
`proxyCountryCode`/`downloadSubtitlesOptions`) and never include
`sessionCookies` or `cookiePool` — clockworks handles its own auth, so the
backend was never written to send a cookie. This actor needs one, so when
both are absent from the input it falls back to Actor-level environment
variables:

- `TIKTOK_SESSION_COOKIES` — same formats as the `sessionCookies` input field
- `TIKTOK_COOKIE_POOL` — a JSON array string, same shape as `cookiePool`

Set these in **Apify Console → Actor → Settings → Environment variables**,
marked **Secret** so they're encrypted and hidden from logs/run details. Do
**not** put a real cookie in `INPUT_SCHEMA.json`'s `default` or in
`input.json` — either would commit a live session credential to this repo's
git history.

## Output Schema

Each item in the dataset includes:

```json
{
  "post_id": "7123456789012345678",
  "shortcode": "7123456789012345678",
  "post_url": "https://www.tiktok.com/@username/video/7123456789012345678",
  "text": "Video caption text...",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "user": {
    "user_id": "1234567890",
    "username": "username",
    "full_name": "Display Name",
    "profile_url": "https://www.tiktok.com/@username",
    "profile_pic_url": "https://p16-sign.tiktokcdn.com/...",
    "is_verified": true,
    "follower_count": 100000
  },
  "likes": 50000,
  "replies": 1200,
  "reposts": 500,
  "quotes": null,
  "reshares": 3000,
  "views": 500000,
  "images": [],
  "videos": [{"url": "https://v16-webapp.tiktok.com/...", "duration": 30}],
  "is_reply": false,
  "source": "api",
  "hashtags": [{"id": "123", "name": "fyp"}],
  "mentions": [],
  "music": {"id": "123", "title": "Original Sound", "author": "Creator", "is_original": true},
  "video_duration": 30,
  "video_width": 1080,
  "video_height": 1920,
  "is_ad": false,
  "region": "US",
  "engagement_rate": 10.5
}
```

### `clockworks` Output Schema (drop-in replacement mode, default)

This is the default output — no input field needs to be set. It emits the
same field names `clockworks/tiktok-scraper` produces (including the post
thumbnail at `videoMeta.coverUrl` and the poster's profile photo at
`authorMeta.avatar`), so `red-pharmatiq-api` (unmodified) keeps working. It's
the default specifically because `red-pharmatiq-api`'s payloads never set
`outputSchema` — pass `outputSchema: "compat"` explicitly if you want the
legacy Threads-style shape instead:

```json
{
  "id": "7123456789012345678",
  "text": "Video caption text...",
  "createTime": 1705315800,
  "createTimeISO": "2024-01-15T10:30:00.000Z",
  "webVideoUrl": "https://www.tiktok.com/@username/video/7123456789012345678",
  "diggCount": 50000,
  "shareCount": 3000,
  "playCount": 500000,
  "collectCount": 1200,
  "commentCount": 1200,
  "repostCount": 500,
  "isAd": false,
  "hashtags": [{"name": "fyp"}],
  "authorMeta": {
    "name": "username",
    "nickName": "Display Name",
    "avatar": "https://p16-sign.tiktokcdn.com/...",
    "profileUrl": "https://www.tiktok.com/@username",
    "id": 1234567890,
    "verified": true,
    "fans": 100000
  },
  "videoMeta": {
    "coverUrl": "https://...",
    "downloadAddr": "https://...",
    "subtitleLinks": [
      {"downloadLink": "https://api.apify.com/v2/key-value-stores/.../records/subtitle_7123.../0", "language": "eng-US"}
    ]
  },
  "textLanguage": "en",
  "input": "asthinforce"
}
```

Some fields (subtitle track field name, cover URLs, `isPinned`/`isSlideshow`,
`authorMeta.friends`) are mapped from general TikTok API knowledge rather than
independently re-verified live — see the confidence notes in
`src/normalize/clockworks.js`. Run once for real and spot-check a few items
against a past clockworks dataset before pointing production traffic at this
actor.

## Usage

### On Apify Platform

1. Create a new actor on [Apify Console](https://console.apify.com)
2. Set the build to use the Dockerfile
3. Configure input:
   ```json
   {
     "hashtags": ["SamsungGalaxyS25Ultra"],
     "resultsPerPage": 100,
     "sessionCookies": "sessionid=...; sessionid_ss=...; sid_tt=...; sid_guard=..."
   }
   ```

### Locally

```bash
# Install dependencies
npm install

# Run with input
npm start -- --input '{"hashtags":["fyp"],"sessionCookies":"..."}'
```

### With Apify CLI

```bash
apify login
apify create tiktok-scraper --template project_empty
# Copy files to the new project
cd tiktok-scraper
apify run
```

## Architecture

```
src/
  main.js              # Actor entry point, input validation, crawler setup
  cookies.js           # Cookie parsing/normalization/validation
  intercept.js         # Network response interception + endpoint routing
  paginate.js          # Scroll-based pagination with stall detection
  antibot.js           # Captcha detection, backoff, session rotation
  subtitles.js         # Native TikTok subtitle fetch + KV store re-hosting
  normalize/
    shared.js          # Shared video item normalization (compat schema)
    searchItem.js      # Search endpoint normalizers
    challengeItem.js   # Hashtag/challenge normalizer
    comment.js         # Comment normalizer
    clockworks.js      # clockworks/tiktok-scraper-compatible normalizer
```

## How It Works

1. **Browser Launch**: Playwright launches a headless Chrome instance
2. **Cookie Injection**: Session cookies are injected into the browser context
3. **Resource Blocking**: Heavy resources (images, media, fonts) are blocked to reduce bandwidth
4. **Navigation**: The page navigates to TikTok search/hashtag/profile URL
5. **Network Interception**: Responses from TikTok API endpoints are intercepted
6. **Scroll Pagination**: The page scrolls to trigger infinite scroll, loading more results
7. **Normalization**: Raw API responses are normalized to the output schema
8. **Dataset Output**: Items are pushed to the Apify dataset

## Known Limitations

- **Search depth**: ~300-450 items max per query due to TikTok's internal limits
- **Media URLs**: Video URLs expire in ~2 hours; download during the run if needed
- **Personalization**: Results are personalized per account (logged-in vs anonymous differ)
- **Account risk**: Heavy scraping may rate-limit or ban the account; use throwaway accounts

## Cost Optimization

- Resource blocking reduces bandwidth by ~90%
- Network interception avoids DOM parsing overhead
- Session rotation distributes load across multiple accounts
- Configurable max items and pagination limits

## License

ISC
