/**
 * KeystoneBot Worker — Phase 4A ingestion ready
 *
 * Endpoints:
 *   - GET  /              → "Hello from KeystoneBot" (deploy check)
 *   - GET  /health        → bindings status
 *   - GET  /setup         → create Vectorize index (run once, idempotent)
 *   - POST /ingest        → read docs from GitHub, chunk, embed, upload to Vectorize
 *   - GET  /ingest/status → count of vectors currently in the index
 *
 * Phase 4B will add the chat/query flow (RAG → Claude).
 */

export interface Env {
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  ANTHROPIC_API_KEY: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
}

const INDEX_NAME = 'keystonebot';
const EMBEDDING_PRESET = '@cf/baai/bge-base-en-v1.5';

// GitHub raw URL prefix for the repo. Reads from `main`.
const GITHUB_RAW_BASE =
  'https://raw.githubusercontent.com/caseyv22/keystonebot/main';

// All docs to ingest, with their paths within the repo
const DOCS_TO_INGEST = [
  // Authoritative docs (authority: high)
  'docs/authoritative/pto-policy.md',
  'docs/authoritative/benefits.md',
  'docs/authoritative/parental-leave.md',
  'docs/authoritative/expense-reimbursement.md',
  'docs/authoritative/code-of-conduct.md',
  'docs/authoritative/perks-and-programs.md',

  // Forum posts (authority: low)
  'docs/forum/viva-pto-rollover-myth.md',
  'docs/forum/confluence-lot-days-cashout.md',
  'docs/forum/sharepoint-parental-leave-mixup.md',
  'docs/forum/slack-expense-receipt-threshold.md',
  'docs/forum/viva-keystoneland-rollover.md',
  'docs/forum/confluence-keystoneland-transferability.md',
  'docs/forum/glint-401k-match-confusion.md',
];

// Cap chunks at this character count. If a section is longer, we split.
const MAX_CHUNK_CHARS = 1800;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
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

        case '/ingest':
          if (request.method !== 'POST') {
            return Response.json(
              { error: 'POST required for /ingest to prevent accidental triggers' },
              { status: 405 }
            );
          }
          return await runIngestion(env);

        case '/ingest/status':
          return await ingestionStatus(env);

        default:
          return new Response('Not found', { status: 404 });
      }
    } catch (err: any) {
      return Response.json(
        {
          status: 'error',
          message: err?.message ?? String(err),
          stack: err?.stack,
        },
        { status: 500 }
      );
    }
  },
};

// ============================================================================
// /setup — create the Vectorize index
// ============================================================================
async function createVectorizeIndex(env: Env): Promise<Response> {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
    return Response.json(
      {
        error: 'Missing setup credentials',
        needed: ['CLOUDFLARE_ACCOUNT_ID (var)', 'CLOUDFLARE_API_TOKEN (secret)'],
      },
      { status: 500 }
    );
  }

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/vectorize/v2/indexes`;

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: INDEX_NAME,
      description: 'KeystoneBot RAG index — Keystone Studios HR docs + forum posts',
      config: { preset: EMBEDDING_PRESET },
    }),
  });

  const json = (await resp.json()) as any;

  if (!resp.ok && json?.errors?.[0]?.message?.toLowerCase().includes('already')) {
    return Response.json({
      status: 'already_exists',
      message: `Vectorize index "${INDEX_NAME}" already exists. Nothing to do.`,
    });
  }

  if (!resp.ok) {
    return Response.json(
      { status: 'error', cloudflare_status: resp.status, cloudflare_response: json },
      { status: 500 }
    );
  }

  return Response.json({
    status: 'created',
    message: `Vectorize index "${INDEX_NAME}" created successfully.`,
    index: json.result,
  });
}

// ============================================================================
// /ingest — read docs from GitHub, chunk, embed, upload
// ============================================================================

type DocMetadata = Record<string, string>;

interface Chunk {
  id: string;
  text: string;
  metadata: Record<string, string | number>;
}

async function runIngestion(env: Env): Promise<Response> {
  const startTime = Date.now();
  const perDoc: Array<{ path: string; chunks: number; ok: boolean; error?: string }> = [];
  let totalChunks = 0;

  for (const docPath of DOCS_TO_INGEST) {
    try {
      const raw = await fetchDoc(docPath);
      const { frontmatter, body } = parseFrontmatter(raw);
      const docMeta = buildDocMetadata(docPath, frontmatter);
      const chunks = chunkByHeadings(body, docPath, docMeta);

      // Embed and upload in batches (Workers AI handles single-shot fine, but we batch
      // the Vectorize upserts so a single failure doesn't lose all chunks for the doc).
      const vectors: VectorizeVector[] = [];
      for (const chunk of chunks) {
        const embedding = await embedText(env, chunk.text);
        vectors.push({
          id: chunk.id,
          values: embedding,
          metadata: chunk.metadata,
        });
      }

      if (vectors.length > 0) {
        await env.VECTORIZE.upsert(vectors);
      }

      perDoc.push({ path: docPath, chunks: vectors.length, ok: true });
      totalChunks += vectors.length;
    } catch (err: any) {
      perDoc.push({
        path: docPath,
        chunks: 0,
        ok: false,
        error: err?.message ?? String(err),
      });
    }
  }

  return Response.json({
    status: 'complete',
    duration_ms: Date.now() - startTime,
    total_chunks: totalChunks,
    docs_processed: perDoc.length,
    docs_ok: perDoc.filter((d) => d.ok).length,
    docs_failed: perDoc.filter((d) => !d.ok).length,
    per_doc: perDoc,
  });
}

async function ingestionStatus(env: Env): Promise<Response> {
  // Vectorize doesn't expose a raw count via the binding, so we use the REST API.
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/vectorize/v2/indexes/${INDEX_NAME}/info`;
  const resp = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
  });
  const json = (await resp.json()) as any;

  if (!resp.ok) {
    return Response.json({ status: 'error', response: json }, { status: 500 });
  }

  return Response.json({
    status: 'ok',
    index_info: json.result,
  });
}

// ============================================================================
// Helpers
// ============================================================================

async function fetchDoc(path: string): Promise<string> {
  const url = `${GITHUB_RAW_BASE}/${path}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to fetch ${path}: ${resp.status} ${resp.statusText}`);
  }
  return await resp.text();
}

/**
 * Parse YAML-style frontmatter (---\nkey: value\n---) from the top of a doc.
 * Returns { frontmatter: {key: value, ...}, body: "rest of doc" }.
 * Frontmatter is optional — if not present, returns empty object and full text as body.
 */
function parseFrontmatter(raw: string): { frontmatter: DocMetadata; body: string } {
  const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!fmMatch) {
    return { frontmatter: {}, body: raw };
  }

  const fmBlock = fmMatch[1];
  const body = fmMatch[2];
  const frontmatter: DocMetadata = {};

  for (const line of fmBlock.split('\n')) {
    const m = line.match(/^([a-zA-Z_]+):\s*(.+)$/);
    if (m) {
      frontmatter[m[1]] = m[2].trim();
    }
  }

  return { frontmatter, body };
}

/**
 * Build per-doc metadata that will be attached to every chunk from that doc.
 * Authoritative docs default to authority=high; forum docs come tagged in frontmatter.
 */
function buildDocMetadata(docPath: string, frontmatter: DocMetadata): DocMetadata {
  const isAuthoritative = docPath.includes('/authoritative/');

  // Extract a "doc_name" from the path (e.g. "pto-policy" → "PTO Policy")
  const filename = docPath.split('/').pop()!.replace(/\.md$/, '');
  const docName = filename
    .split('-')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');

  return {
    doc_name: docName,
    doc_path: docPath,
    source_type: isAuthoritative ? 'authoritative' : (frontmatter.source_type ?? 'forum'),
    authority: isAuthoritative ? 'high' : (frontmatter.authority ?? 'low'),
    platform: frontmatter.platform ?? (isAuthoritative ? 'Keystone HR' : 'unknown'),
    topic: frontmatter.topic ?? '',
    contradicts: frontmatter.contradicts ?? '',
    posted_date: frontmatter.posted_date ?? '',
  };
}

/**
 * Chunk a markdown body at heading boundaries (## and ###).
 *
 * Each chunk includes the doc title context + the section heading so that retrieved
 * chunks are self-contained when they reach the LLM. If any single section exceeds
 * MAX_CHUNK_CHARS, we split it on paragraph boundaries.
 */
function chunkByHeadings(
  body: string,
  docPath: string,
  docMeta: DocMetadata
): Chunk[] {
  const chunks: Chunk[] = [];

  // Extract the H1 title (e.g. "# PTO Policy") as a context prefix for all chunks
  const h1Match = body.match(/^#\s+(.+)$/m);
  const docTitle = h1Match ? h1Match[1].trim() : docMeta.doc_name;

  // Split on H2 boundaries. Each section starts with "## ..." and runs until the next "## " or EOF.
  const sections = body.split(/^##\s+/m);

  // The first split element is anything before the first H2 (frontmatter remnants, intro paragraphs).
  // Treat it as a "preamble" chunk only if it has substantive text.
  const preamble = sections[0].trim();
  if (preamble.length > 100) {
    chunks.push({
      id: makeChunkId(docPath, 'preamble'),
      text: `# ${docTitle}\n\n${preamble}`,
      metadata: { ...docMeta, section_heading: 'preamble' },
    });
  }

  // Process each H2-and-below section
  for (let i = 1; i < sections.length; i++) {
    const sectionText = sections[i];
    const headingEnd = sectionText.indexOf('\n');
    const sectionHeading = sectionText.slice(0, headingEnd).trim();
    const sectionBody = sectionText.slice(headingEnd).trim();

    const fullSection = `# ${docTitle}\n\n## ${sectionHeading}\n\n${sectionBody}`;

    if (fullSection.length <= MAX_CHUNK_CHARS) {
      chunks.push({
        id: makeChunkId(docPath, sectionHeading),
        text: fullSection,
        metadata: { ...docMeta, section_heading: sectionHeading },
      });
    } else {
      // Split oversized section on paragraph boundaries (blank lines)
      const paragraphs = sectionBody.split(/\n\s*\n/);
      const header = `# ${docTitle}\n\n## ${sectionHeading}\n\n`;
      let current = header;
      let partIndex = 0;

      for (const para of paragraphs) {
        if ((current + para).length > MAX_CHUNK_CHARS && current.length > header.length) {
          chunks.push({
            id: makeChunkId(docPath, sectionHeading, partIndex),
            text: current.trim(),
            metadata: { ...docMeta, section_heading: sectionHeading, part: String(partIndex) },
          });
          partIndex++;
          current = header;
        }
        current += para + '\n\n';
      }

      if (current.length > header.length) {
        chunks.push({
          id: makeChunkId(docPath, sectionHeading, partIndex),
          text: current.trim(),
          metadata: { ...docMeta, section_heading: sectionHeading, part: String(partIndex) },
        });
      }
    }
  }

  return chunks;
}

/**
 * Generate a stable, unique chunk ID. Stable = same doc + same heading produces the
 * same ID, which means re-running ingestion overwrites (upserts) rather than duplicates.
 */
function makeChunkId(docPath: string, heading: string, part?: number): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);
  const id = `${slug(docPath)}::${slug(heading)}`;
  return part !== undefined ? `${id}::p${part}` : id;
}

/**
 * Embed a single text chunk using Workers AI.
 */
async function embedText(env: Env, text: string): Promise<number[]> {
  const result = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [text] });
  // Workers AI returns { shape, data: [[...embedding...]] }
  return (result as any).data[0];
}
