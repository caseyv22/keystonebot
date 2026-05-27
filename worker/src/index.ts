/**
 * KeystoneBot Worker — Phase 4A ingestion (hash-ID fix)
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
  readableId: string;
  text: string;
  metadata: Record<string, string | number>;
}

async function runIngestion(env: Env): Promise<Response> {
  const startTime = Date.now();
  const perDoc: Array<{
    path: string;
    chunks: number;
    ok: boolean;
    error?: string;
    sample_ids?: string[];
  }> = [];
  let totalChunks = 0;

  for (const docPath of DOCS_TO_INGEST) {
    try {
      const raw = await fetchDoc(docPath);
      const { frontmatter, body } = parseFrontmatter(raw);
      const docMeta = buildDocMetadata(docPath, frontmatter);
      const chunks = await chunkByHeadings(body, docPath, docMeta);

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

      perDoc.push({
        path: docPath,
        chunks: vectors.length,
        ok: true,
        sample_ids: chunks.slice(0, 2).map((c) => c.readableId),
      });
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
 */
function buildDocMetadata(docPath: string, frontmatter: DocMetadata): DocMetadata {
  const isAuthoritative = docPath.includes('/authoritative/');

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
 * Chunk a markdown body at heading boundaries.
 *
 * Each chunk includes the doc title + section heading so retrieved chunks are
 * self-contained. Sections over MAX_CHUNK_CHARS split on paragraph boundaries.
 *
 * Now async because chunk IDs are SHA-256 hashes (Web Crypto is async).
 */
async function chunkByHeadings(
  body: string,
  docPath: string,
  docMeta: DocMetadata
): Promise<Chunk[]> {
  const chunks: Chunk[] = [];

  const h1Match = body.match(/^#\s+(.+)$/m);
  const docTitle = h1Match ? h1Match[1].trim() : docMeta.doc_name;

  // Split on H2 boundaries
  const sections = body.split(/^##\s+/m);

  // Preamble (anything before the first H2)
  const preamble = sections[0].trim();
  if (preamble.length > 100) {
    const readableId = makeReadableId(docPath, 'preamble');
    chunks.push({
      id: await hashId(readableId),
      readableId,
      text: `# ${docTitle}\n\n${preamble}`,
      metadata: {
        ...docMeta,
        section_heading: 'preamble',
        chunk_id_readable: readableId,
        part: '0',
      },
    });
  }

  // Each H2 section
  for (let i = 1; i < sections.length; i++) {
    const sectionText = sections[i];

    // Defensive: if section has no newline (file ends right after heading), bail.
    const headingEnd = sectionText.indexOf('\n');
    const sectionHeading =
      headingEnd === -1
        ? sectionText.trim()
        : sectionText.slice(0, headingEnd).trim();
    const sectionBody =
      headingEnd === -1 ? '' : sectionText.slice(headingEnd).trim();

    if (!sectionHeading) continue;

    const fullSection = `# ${docTitle}\n\n## ${sectionHeading}\n\n${sectionBody}`;

    if (fullSection.length <= MAX_CHUNK_CHARS) {
      const readableId = makeReadableId(docPath, sectionHeading);
      chunks.push({
        id: await hashId(readableId),
        readableId,
        text: fullSection,
        metadata: {
          ...docMeta,
          section_heading: sectionHeading,
          chunk_id_readable: readableId,
          part: '0',
        },
      });
    } else {
      // Oversized — split on paragraph boundaries
      const paragraphs = sectionBody.split(/\n\s*\n/);
      const header = `# ${docTitle}\n\n## ${sectionHeading}\n\n`;
      let current = header;
      let partIndex = 0;

      for (const para of paragraphs) {
        if (
          (current + para).length > MAX_CHUNK_CHARS &&
          current.length > header.length
        ) {
          const readableId = makeReadableId(docPath, sectionHeading, partIndex);
          chunks.push({
            id: await hashId(readableId),
            readableId,
            text: current.trim(),
            metadata: {
              ...docMeta,
              section_heading: sectionHeading,
              chunk_id_readable: readableId,
              part: String(partIndex),
            },
          });
          partIndex++;
          current = header;
        }
        current += para + '\n\n';
      }

      if (current.length > header.length) {
        const readableId = makeReadableId(docPath, sectionHeading, partIndex);
        chunks.push({
          id: await hashId(readableId),
          readableId,
          text: current.trim(),
          metadata: {
            ...docMeta,
            section_heading: sectionHeading,
            chunk_id_readable: readableId,
            part: String(partIndex),
          },
        });
      }
    }
  }

  return chunks;
}

/**
 * Human-readable chunk ID — kept in metadata for debuggability.
 * Example: "docs/forum/viva-pto-rollover-myth.md::frequently-confused-points::p0"
 */
function makeReadableId(docPath: string, heading: string, part?: number): string {
  const slug = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const base = `${docPath}::${slug(heading)}`;
  return part !== undefined ? `${base}::p${part}` : `${base}::p0`;
}

/**
 * Hash-based ID: "kb_" + first 16 hex chars of SHA-256.
 * Always exactly 19 bytes — well under Vectorize's 64-byte cap.
 * Stable: same readableId always produces the same hash, so re-ingestion upserts.
 */
async function hashId(readableId: string): Promise<string> {
  const data = new TextEncoder().encode(readableId);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hex = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  return `kb_${hex.slice(0, 16)}`;
}

/**
 * Embed a single text chunk using Workers AI.
 */
async function embedText(env: Env, text: string): Promise<number[]> {
  const result = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: [text] });
  return (result as any).data[0];
}
