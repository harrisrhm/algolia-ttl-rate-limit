import dotenv from "dotenv";
import { algoliasearch } from "algoliasearch";

dotenv.config();

const BASE_URL = "http://localhost:3000";
const USER_TOKEN = process.argv[2] || "cli-bot-user";

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getKey() {
  const response = await fetch(
    `${BASE_URL}/algolia-key?userToken=${encodeURIComponent(USER_TOKEN)}`
  );

  const body = await response.json();

  if (!response.ok) {
    throw new Error(`Key request failed ${response.status}: ${JSON.stringify(body)}`);
  }

  return body;
}

async function report429() {
  const response = await fetch(`${BASE_URL}/429-observed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userToken: USER_TOKEN }),
  });

  return response.json();
}

async function main() {
  const keyPayload = await getKey();

  console.log("Issued secured key:", {
    indexName: keyPayload.indexName,
    userToken: keyPayload.userToken,
    expiresAt: keyPayload.expiresAt,
  });

  const client = algoliasearch(keyPayload.appId, keyPayload.apiKey);

  const delayMs = 50;

  for (let i = 1; i <= 500; i++) {
    try {
      const result = await client.search([
        {
          indexName: keyPayload.indexName,
          params: {
            query: "iphone",
            hitsPerPage: 5,
            userToken: USER_TOKEN,
          },
        },
      ]);

      console.log(`200 search ${i}`, {
        hits: result.results[0].hits.length,
      });
    } catch (error) {
      const status = error.status || error.statusCode;

      console.log("Search failed:", {
        status,
        message: error.message,
      });

      if (Number(status) === 429 || String(error.message).includes("429")) {
        const throttle = await report429();

        console.log("Backend throttle activated:", throttle);
        console.log("Stopping bot demo.");
        break;
      }

      throw error;
    }

    await sleep(delayMs);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
