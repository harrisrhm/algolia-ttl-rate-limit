# Algolia Short-Lived Secured Key + 429 Demo

This is a local demo showing how short-lived Algolia secured API keys can work together with bot fingerprinting and layered rate limiting.

## What this demo shows

The demo has two simulated clients:

- A real user, who searches normally.
- A bot-like client, which is rate limited.

Both clients receive short-lived secured API keys from the local backend.

The demo separates two kinds of 429 responses:

- **Backend 429**: the local backend blocks suspicious bot traffic before it reaches Algolia. This represents an application, CDN, or WAF-style protection layer.
- **Algolia 429**: the request reaches Algolia, and Algolia rate-limits it because the parent API key has a low API-call limit.

## Setup

### 1. Clone the repo

```bash
git clone <repo-url>
cd algolia-ttl-rate-limit-demo
```

### 2. Install dependencies

```bash
npm install
```

This recreates `node_modules` from `package.json` and `package-lock.json`.

### 3. Create a local `.env` file

```bash
cp .env.example .env
```

Then edit `.env`:

```env
ALGOLIA_APP_ID=your_app_id
ALGOLIA_PARENT_SEARCH_KEY=your_custom_rate_limited_search_key
ALGOLIA_INDEX_NAME=your_index_name
PORT=3000
```

The parent search key should be a custom search-only key with a low API-call limit, for example:

```text
Max API calls/IP/hour: 10
```

### 4. Run the demo

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

## Running the demo

Click:

```text
Run both users
```

Expected result:

- The real user continues to get successful search responses.
- The bot-like client first receives Backend 429s.
- The bot-like client then continues with the same short-lived secured API key.
- Algolia returns Algolia 429s after the secured-key request stream exceeds the parent key's rate limit.

## How the demo works

When you click **Run both users**:

1. The real user receives a short-lived secured API key.
2. The real user sends search requests and continues successfully.
3. The bot-like client also receives one short-lived secured API key.
4. The backend first returns Backend 429s for the bot-like client.
5. The demo then allows the remaining bot traffic through to Algolia using the same secured API key.
6. Algolia eventually returns Algolia 429s when the secured-key request stream exceeds the parent key's low API-call limit.

## Demo identity

The app simulates different clients by sending demo headers from the browser to the local backend.

The backend uses those headers to build a fingerprint and issue secured API keys.

These demo identifiers are only for local simulation. Algolia logs may show the real network source IP, while the simulated identity is passed through fields such as `userToken` and analytics tags when available.

## Optional debug endpoint

There is also a backend debug endpoint that directly tests the parent key rate limit:

```bash
curl -X POST http://localhost:3000/debug/algolia-parent-key-burst \
  -H "content-type: application/json" \
  -d '{"attempts":50}'
```

Expected result with a low limit:

```json
{
  "http200": 10,
  "http429": 40
}
```

Exact numbers may vary slightly.

## Interpreting the logs

In the UI:

- **200s** means successful searches.
- **Backend 429s** means the local backend blocked the bot-like client before the request reached Algolia.
- **Algolia 429s** means the request reached Algolia and Algolia rate-limited it.
- **Total 429s** is the sum of Backend 429s and Algolia 429s.

In Algolia logs:

- Successful requests may include the simulated identity in `userToken`.
- Some 429 rows may not expose `userToken` or analytics tags in the exported logs.
- Grouping logs by API key can help show the sequence of successful requests followed by 429s.

