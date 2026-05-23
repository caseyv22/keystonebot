/**
 * KeystoneBot Worker — Phase 3 bootstrap
 *
 * Current responsibilities:
 *   - GET /         → "Hello from KeystoneBot" (deploy verification)
 *   - GET /setup    → Create the Vectorize index (run once)
 *   - GET /health   → JSON status (used to verify bindings)
 *
 * Phase 4 will replace the body of this Worker with the real RAG flow:
 *   embed query → query Vectorize → call Anthropic → return answer + citations
 */

export interface Env {
  // Bindings — wired up in Cloudflare dashboard (Step 3.4 and beyond)
  AI: Ai;                              // Workers AI (embeddings)
  VECTORIZE: VectorizeIndex;           // Bound once the index exists
  ANTHROPIC_API_KEY: string;           // Encrypted secret

  // Used by /setup to create the index via Cloudflare's REST API
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;        // Encrypted secret
}

const INDEX_NAME = 'keystonebot';
const EMBEDDING_PRESET = '@cf/baai/bge-base-en-v1.5';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/':
        return new Response('Hello from KeystoneBot 👋', {
          headers: { 'content-type': 'text/plain' },
        });

      case '/health':
        return Response.json({
          status: 'ok',
          bindings: {
            ai: !!env.AI,
            vectorize: !!env.VECTORIZE,
            anthropic_key: !!env.ANTHROPIC_API_KEY,
            cloudflare_account_id: !!env.CLOUDFLARE_ACCOUNT_ID,
            cloudflare_api_token: !!env.CLOUDFLARE_API_TOKEN,
          },
          timestamp: new Date().toISOString(),
        });

      case '/setup':
        return await createVectorizeIndex(env);

      default:
        return new Response('Not found', { status: 404 });
    }
  },
};

/**
 * Creates the Vectorize index by calling Cloudflare's REST API.
 * Idempotent: if the index already exists, returns 200 with a note.
 *
 * This endpoint only needs to be hit once after first deploy.
 * Safe to leave in the code — it's gated by needing a valid API token.
 */
async function createVectorizeIndex(env: Env): Promise<Response> {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
    return Response.json(
      {
        error: 'Missing setup secrets',
        needed: ['CLOUDFLARE_ACCOUNT_ID (var)', 'CLOUDFLARE_API_TOKEN (secret)'],
      },
      { status: 500 }
    );
  }

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/vectorize/v2/indexes`;

  const body = {
    name: INDEX_NAME,
    description: 'KeystoneBot RAG index — Keystone Studios HR docs + forum posts',
    config: {
      preset: EMBEDDING_PRESET,
    },
  };

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const json = await resp.json() as any;

  // Already-exists is fine — return a 200 with a note
  if (!resp.ok && json?.errors?.[0]?.message?.toLowerCase().includes('already')) {
    return Response.json({
      status: 'already_exists',
      message: `Vectorize index "${INDEX_NAME}" already exists. Nothing to do.`,
    });
  }

  if (!resp.ok) {
    return Response.json(
      {
        status: 'error',
        cloudflare_status: resp.status,
        cloudflare_response: json,
      },
      { status: 500 }
    );
  }

  return Response.json({
    status: 'created',
    message: `Vectorize index "${INDEX_NAME}" created successfully.`,
    index: json.result,
  });
}
