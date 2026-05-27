# KeystoneBot

A RAG chatbot prototype demonstrating **source-authority handling in enterprise AI** — built for a fictional company (Keystone Studios) where the corpus deliberately mixes official HR documents with employee forum posts containing misinformation.

> **Why it exists:** Most enterprise chatbot demos show that a bot can answer questions from documents. This one shows that a bot can be the *authoritative source* in an environment where employees already have wrong information — flagging conflicts, citing sources, and refusing gracefully when it doesn't know.

Built as a portfolio piece for a Lead PM application on Disney's Workforce Technology team.

---

## Architecture

- **Cloudflare Worker** — backend (retrieval + generation orchestration)
- **Cloudflare Vectorize** — vector storage with metadata
- **Workers AI** (`@cf/baai/bge-base-en-v1.5`) — embeddings
- **Anthropic Claude** — generation
- **Cloudflare Pages** — chat UI (Phase 4C)

The split is deliberate: Cloudflare-native infrastructure where edge speed and simplicity matter, Anthropic where generation quality matters.

## What's in this repo

```
docs/
  authoritative/    Official Keystone HR policies (6 docs)
  forum/            Fake employee forum posts with misinformation (7 docs)
worker/             Cloudflare Worker code (ingestion + chat)
CLAUDE.md           Full project knowledge: thesis, decisions, architecture
company-fiction.md  Source-of-truth on the fictional company Keystone Studios
```

Each forum post has YAML frontmatter declaring its `authority: low` status, source platform (Viva Engage, Slack, Confluence, etc.), and the doc it `contradicts`. The Worker uses this metadata to prefer authoritative chunks and surface conflicts.

## Build status

- [x] Phase 1: Workspace & project knowledge
- [x] Phase 2: Content — 13-doc corpus
- [x] Phase 3: Cloudflare infrastructure
- [ ] Phase 4A: Ingestion *(in progress)*
- [ ] Phase 4B: RAG flow + Claude integration
- [ ] Phase 4C: Chat UI
- [ ] Phase 4D: Evals
- [ ] Phase 5: Polish

## Note on fictional content

Every document, person, policy, phone number, and Slack channel in this repo is fictional. **No real Disney content, internal or public, is used anywhere.** Keystone Studios is a synthetic company scaffolded from publicly available open-source handbooks (GitLab, Basecamp, state government, university HR) and rewritten into a consistent voice.
