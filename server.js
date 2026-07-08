import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { algoliasearch } from "algoliasearch";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const {
  ALGOLIA_APP_ID,
  ALGOLIA_PARENT_SEARCH_KEY,
  ALGOLIA_INDEX_NAME,
  PORT = 3000,
} = process.env;

if (!ALGOLIA_APP_ID || !ALGOLIA_PARENT_SEARCH_KEY || !ALGOLIA_INDEX_NAME) {
  throw new Error(
    "Missing ALGOLIA_APP_ID, ALGOLIA_PARENT_SEARCH_KEY, or ALGOLIA_INDEX_NAME in .env"
  );
}

const searchClient = algoliasearch(ALGOLIA_APP_ID, ALGOLIA_PARENT_SEARCH_KEY);

const throttledFingerprints = new Map();
const requestCounters = new Map();
const stagedBotCounters = new Map();
const stagedBotKeys = new Map();

const BOT_DEMO_LIMIT = 15;
const THROTTLE_SECONDS = 120;

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function maskKey(key) {
  if (!key || key.length < 16) {
    return "not available";
  }

  return `${key.slice(0, 8)}...${key.slice(-6)}`;
}

function cleanTag(value) {
  return String(value)
    .replaceAll(".", "_")
    .replaceAll(":", "_")
    .replaceAll(" ", "_")
    .replaceAll("/", "_")
    .replaceAll("\\", "_");
}

function analyticsTagsForIdentity(prefix, identity) {
  return [
    prefix,
    "secured_api_key",
    identity.type,
    `demo_ip_${cleanTag(identity.ip)}`,
    `ua_${cleanTag(identity.userAgent)}`,
    `fingerprint_${cleanTag(identity.fingerprint)}`,
  ];
}

function getDemoIdentity(req) {
  const forwardedFor = req.headers["x-forwarded-for"];

  const realIp = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : forwardedFor?.split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown-ip";

  const ip = req.headers["x-demo-ip"] || realIp;

  const userAgent =
    req.headers["x-demo-user-agent"] ||
    req.headers["user-agent"] ||
    "unknown-user-agent";

  const type = userAgent === "I_am_bot" ? "bot" : "real_user";
  const fingerprint = `${ip}:${userAgent}`;

  return {
    ip,
    userAgent,
    type,
    fingerprint,
  };
}

function isThrottled(fingerprint) {
  const now = nowSeconds();
  const throttleUntil = throttledFingerprints.get(fingerprint);

  if (!throttleUntil) {
    return null;
  }

  if (throttleUntil <= now) {
    throttledFingerprints.delete(fingerprint);
    requestCounters.delete(fingerprint);
    return null;
  }

  return throttleUntil;
}

function throttle(identity, reason) {
  const throttleUntil = nowSeconds() + THROTTLE_SECONDS;

  throttledFingerprints.set(identity.fingerprint, throttleUntil);

  return {
    status: "throttled",
    reason,
    identity,
    retryAfterSeconds: THROTTLE_SECONDS,
  };
}

function generateSecuredKeyForIdentity(identity) {
  const expiresAt = nowSeconds() + 60;

  const securedApiKey = searchClient.generateSecuredApiKey({
    parentApiKey: ALGOLIA_PARENT_SEARCH_KEY,
    restrictions: {
      validUntil: expiresAt,
      restrictIndices: ALGOLIA_INDEX_NAME,
      userToken: identity.fingerprint,
    },
  });

  return {
    apiKey: securedApiKey,
    apiKeyMasked: maskKey(securedApiKey),
    parentKeyMasked: maskKey(ALGOLIA_PARENT_SEARCH_KEY),
    keyType: "secured_api_key",
    expiresAt,
  };
}

function getOrCreateStagedBotSecuredKey(identity) {
  const now = nowSeconds();
  const existing = stagedBotKeys.get(identity.fingerprint);

  if (existing && existing.expiresAt > now) {
    return existing;
  }

  const issued = generateSecuredKeyForIdentity(identity);

  stagedBotKeys.set(identity.fingerprint, issued);

  return issued;
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/algolia-key", (req, res) => {
  const identity = getDemoIdentity(req);
  const throttleUntil = isThrottled(identity.fingerprint);

  if (throttleUntil) {
    return res.status(429).json({
      error: "This client is temporarily throttled by the demo backend.",
      identity,
      retryAfterSeconds: throttleUntil - nowSeconds(),
    });
  }

  const issuedKey = generateSecuredKeyForIdentity(identity);

  res.json({
    appId: ALGOLIA_APP_ID,
    indexName: ALGOLIA_INDEX_NAME,
    apiKey: issuedKey.apiKey,
    keyType: issuedKey.keyType,
    parentKeyMasked: issuedKey.parentKeyMasked,
    identity,
    expiresAt: issuedKey.expiresAt,
  });
});

app.post("/record-search", (req, res) => {
  const identity = getDemoIdentity(req);
  const throttleUntil = isThrottled(identity.fingerprint);

  if (throttleUntil) {
    return res.status(429).json({
      error: "Client is already throttled.",
      identity,
      retryAfterSeconds: throttleUntil - nowSeconds(),
    });
  }

  const currentCount = requestCounters.get(identity.fingerprint) || 0;
  const nextCount = currentCount + 1;

  requestCounters.set(identity.fingerprint, nextCount);

  if (identity.type === "bot" && nextCount > BOT_DEMO_LIMIT) {
    return res.status(429).json(
      throttle(identity, `Demo bot exceeded ${BOT_DEMO_LIMIT} allowed searches`)
    );
  }

  res.json({
    status: "allowed",
    identity,
    requestCount: nextCount,
    demoLimit: identity.type === "bot" ? BOT_DEMO_LIMIT : null,
  });
});

app.post("/429-observed", (req, res) => {
  const identity = getDemoIdentity(req);

  res.status(429).json(throttle(identity, "Algolia 429 observed by client"));
});

// Staged bot demo using one reused short-lived secured API key.
//
// One bot journey:
//
// Attempts 1-5:
//   Backend/CDN/WAF-style layer returns Backend 429s first.
//
// Attempts 6+:
//   Backend allows remaining bot traffic through to Algolia using the same
//   short-lived secured API key.
//
// If the parent key's Max API calls/IP/hour applies through secured keys,
// Algolia should eventually return 429.
app.post("/demo/staged-bot-search", async (req, res) => {
  const identity = getDemoIdentity(req);
  const query = req.body?.query || "iphone";

  if (identity.type !== "bot") {
    return res.status(400).json({
      error: "This staged endpoint is only for the bot demo.",
      identity,
    });
  }

  const currentCount = stagedBotCounters.get(identity.fingerprint) || 0;
  const attempt = currentCount + 1;

  stagedBotCounters.set(identity.fingerprint, attempt);

  const issuedKey = getOrCreateStagedBotSecuredKey(identity);

  const isBackendThrottlePhase = attempt >= 1 && attempt <= 5;

  if (isBackendThrottlePhase) {
    return res.status(429).json({
      source: "BACKEND",
      phase: "backend_first_throttle",
      attempt,
      identity,
      keyType: issuedKey.keyType,
      apiKeyMasked: issuedKey.apiKeyMasked,
      parentKeyMasked: issuedKey.parentKeyMasked,
      expiresAt: issuedKey.expiresAt,
      reason:
        "Backend/CDN/WAF-style layer throttled this bot fingerprint first.",
      continueAfterThisForDemo: true,
    });
  }

  const securedClient = algoliasearch(ALGOLIA_APP_ID, issuedKey.apiKey);
  const analyticsTags = analyticsTagsForIdentity("staged_bot_demo", identity);

  try {
    const result = await securedClient.search([
      {
        indexName: ALGOLIA_INDEX_NAME,
        params: {
          query,
          hitsPerPage: 5,
          userToken: identity.fingerprint,
          analyticsTags,
        },
      },
    ]);

    return res.json({
      source: "ALGOLIA",
      phase: "post_backend_continue_with_secured_key",
      attempt,
      identity,
      keyType: issuedKey.keyType,
      apiKeyMasked: issuedKey.apiKeyMasked,
      parentKeyMasked: issuedKey.parentKeyMasked,
      expiresAt: issuedKey.expiresAt,
      analyticsTags,
      httpCode: 200,
      hits: result.results?.[0]?.hits?.length || 0,
    });
  } catch (err) {
    const status = err.status || err.statusCode;

    if (Number(status) === 429 || String(err.message).includes("429")) {
      return res.status(429).json({
        source: "ALGOLIA",
        phase: "secured_key_algolia_rate_limited",
        attempt,
        identity,
        keyType: issuedKey.keyType,
        apiKeyMasked: issuedKey.apiKeyMasked,
        parentKeyMasked: issuedKey.parentKeyMasked,
        expiresAt: issuedKey.expiresAt,
        analyticsTags,
        httpCode: 429,
        reason:
          "Algolia returned 429 while the bot was using the same short-lived secured API key.",
        message: err.message,
      });
    }

    return res.status(500).json({
      source: "ALGOLIA",
      phase: "algolia_error",
      attempt,
      identity,
      keyType: issuedKey.keyType,
      apiKeyMasked: issuedKey.apiKeyMasked,
      parentKeyMasked: issuedKey.parentKeyMasked,
      expiresAt: issuedKey.expiresAt,
      analyticsTags,
      status,
      message: err.message,
    });
  }
});

app.get("/debug/throttles", (req, res) => {
  const now = nowSeconds();

  res.json({
    throttles: [...throttledFingerprints.entries()].map(
      ([fingerprint, until]) => ({
        fingerprint,
        throttleUntil: until,
        retryAfterSeconds: Math.max(until - now, 0),
      })
    ),
    counters: [...requestCounters.entries()].map(([fingerprint, count]) => ({
      fingerprint,
      count,
    })),
    stagedBotCounters: [...stagedBotCounters.entries()].map(
      ([fingerprint, count]) => ({
        fingerprint,
        count,
      })
    ),
    stagedBotKeys: [...stagedBotKeys.entries()].map(([fingerprint, issued]) => ({
      fingerprint,
      keyType: issued.keyType,
      apiKeyMasked: issued.apiKeyMasked,
      parentKeyMasked: issued.parentKeyMasked,
      expiresAt: issued.expiresAt,
      ttlSeconds: Math.max(issued.expiresAt - now, 0),
    })),
  });
});

app.post("/debug/reset", (req, res) => {
  throttledFingerprints.clear();
  requestCounters.clear();
  stagedBotCounters.clear();
  stagedBotKeys.clear();

  res.json({
    status: "reset",
    message:
      "Cleared throttles, request counters, staged bot counters, and staged secured keys",
  });
});

// Separate backend proof endpoint.
// This directly proves that the parent search key returns Algolia 429s.
// It is not used by the main UI flow.
app.post("/debug/algolia-parent-key-burst", async (req, res) => {
  const attempts = Number(req.body?.attempts || 50);
  const query = req.body?.query || "iphone";

  const directClient = algoliasearch(
    ALGOLIA_APP_ID,
    ALGOLIA_PARENT_SEARCH_KEY
  );

  const results = {
    appId: ALGOLIA_APP_ID,
    indexName: ALGOLIA_INDEX_NAME,
    parentKeyMasked: maskKey(ALGOLIA_PARENT_SEARCH_KEY),
    attempts,
    query,
    http200: 0,
    http429: 0,
    otherErrors: 0,
    errors: [],
  };

  for (let i = 1; i <= attempts; i++) {
    try {
      await directClient.search([
        {
          indexName: ALGOLIA_INDEX_NAME,
          params: {
            query,
            hitsPerPage: 5,
            userToken: "server-burst-test",
            analyticsTags: ["server_burst_test", "parent_key_direct"],
          },
        },
      ]);

      results.http200 += 1;
    } catch (err) {
      const status = err.status || err.statusCode;

      if (Number(status) === 429 || String(err.message).includes("429")) {
        results.http429 += 1;
      } else {
        results.otherErrors += 1;
      }

      results.errors.push({
        attempt: i,
        status,
        message: err.message,
      });
    }
  }

  res.json(results);
});

app.listen(PORT, () => {
  console.log(`Demo server running on http://localhost:${PORT}`);
});