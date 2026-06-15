// KeystoneBot frontend — centered empty state → bottom-pinned chat layout

const WORKER_URL = 'https://keystonebot-worker.caseyvillanueva.workers.dev';

const body = document.body;
const thread = document.getElementById('thread');
const form = document.getElementById('composer');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const conflictToggle = document.getElementById('conflictToggle');
const roleSelect = document.getElementById('roleSelect');
const composerSlotCenter = document.getElementById('composerSlotCenter');
const composerSlotBottom = document.getElementById('composerSlotBottom');

// Cache full /chat response per bot message so we can re-render on toggle change
const messageData = new WeakMap();

// On load: restore role selection from localStorage
const ROLE_STORAGE_KEY = 'keystonebot:role';
const savedRole = localStorage.getItem(ROLE_STORAGE_KEY);
if (savedRole && ['default', 'hourly', 'executive'].includes(savedRole)) {
  roleSelect.value = savedRole;
}
roleSelect.addEventListener('change', () => {
  localStorage.setItem(ROLE_STORAGE_KEY, roleSelect.value);
});

// On load: park the composer in the centered slot
composerSlotCenter.appendChild(form);

// Empty-state suggestion clicks
document.querySelectorAll('.suggestion').forEach((btn) => {
  btn.addEventListener('click', () => {
    const q = btn.getAttribute('data-q');
    input.value = q;
    form.requestSubmit();
  });
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = input.value.trim();
  if (!message) return;
  if (sendBtn.disabled) return;

  // First-send: move composer to bottom and swap layout state
  if (body.dataset.state === 'empty') {
    transitionToChat();
  }

  addUserMessage(message);
  input.value = '';
  sendBtn.disabled = true;

  const typingEl = addTypingIndicator();

  try {
    const resp = await fetch(`${WORKER_URL}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, role: roleSelect.value }),
    });
    if (!resp.ok) throw new Error(`Server ${resp.status}`);
    const data = await resp.json();
    typingEl.remove();
    addBotMessage(data);
  } catch (err) {
    typingEl.remove();
    addBotMessage({
      answer:
        "I ran into a problem reaching the policy database. Please try again, or reach out to hr@keystone.studio.",
      sources: [],
      conflicts: [],
    });
    console.error(err);
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
});

// Re-render existing bot messages when conflict toggle flips
conflictToggle.addEventListener('change', () => {
  const botMessages = thread.querySelectorAll('.message.bot');
  botMessages.forEach((el) => {
    const data = messageData.get(el);
    if (!data) return;
    renderBotMessageBody(el, data);
  });
});

function transitionToChat() {
  body.dataset.state = 'chat';
  composerSlotBottom.appendChild(form);
  // Refocus after the DOM move so the cursor stays in the input
  requestAnimationFrame(() => input.focus());
}

function addUserMessage(text) {
  const el = document.createElement('div');
  el.className = 'message user';
  const wrap = document.createElement('div');
  wrap.className = 'bubble-wrap';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  wrap.appendChild(bubble);
  el.appendChild(wrap);
  thread.appendChild(el);
  scrollToBottom();
}

function addTypingIndicator() {
  const el = createBotMessageShell();
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = `
    <div class="typing">
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
      <span class="typing-dot"></span>
    </div>
  `;
  el.querySelector('.bubble-wrap').appendChild(bubble);
  thread.appendChild(el);
  scrollToBottom();
  return el;
}

function addBotMessage(data) {
  const el = createBotMessageShell();
  messageData.set(el, data);
  renderBotMessageBody(el, data);
  thread.appendChild(el);
  scrollToBottom();
}

function renderBotMessageBody(el, data) {
  const showConflicts = conflictToggle.checked;
  const wrap = el.querySelector('.bubble-wrap');
  wrap.innerHTML = '';

  // Claude's narration always renders as a bubble (when present)
  if (data.answer) {
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerHTML = renderMarkdown(data.answer);
    wrap.appendChild(bubble);
  }

  // Agentic action flows (Phase 6.2) — skip RAG conflict/sources rendering
  if (data.status === 'pending_confirmation' && data.pending_action) {
    wrap.appendChild(renderConfirmationCard(data.pending_action, data.replay_context));
    return;
  }
  if (data.tool_executed) {
    const resultCard = renderToolResultCard(data.tool_executed);
    if (resultCard) wrap.appendChild(resultCard);
    return;
  }
  if (data.status === 'cancelled') {
    return; // Just the narration bubble
  }

  // Normal RAG answer: conflict banner + sources
  const conflicts = data.conflicts ?? [];
  if (showConflicts && conflicts.length > 0) {
    const banner = document.createElement('div');
    banner.className = 'conflict-banner';
    banner.innerHTML = `
      <span class="icon">⚠️</span>
      <span>Heads up — this topic has conflicting information circulating on
      ${conflicts.map((c) => `<strong>${escapeHtml(c.forum_platform)}</strong>`).join(', ')}.
      The answer above is from official policy.</span>
    `;
    wrap.appendChild(banner);
  }

  const sources = data.sources ?? [];
  const filteredSources = showConflicts
    ? sources
    : sources.filter((s) => s.authority === 'high');

  if (filteredSources.length > 0) {
    wrap.appendChild(renderSources(filteredSources));
  }
}

// ----------------------------------------------------------------------------
// Phase 6.2 — Agentic action cards
// ----------------------------------------------------------------------------

function renderConfirmationCard(pendingAction, replayContext) {
  const card = document.createElement('div');
  card.className = 'action-card action-card-pending';
  card.innerHTML = `
    <div class="action-card-header">
      <span class="action-card-icon">📋</span>
      <span class="action-card-title">Action requires confirmation</span>
      <span class="action-card-badge">SIMULATED</span>
    </div>
    <div class="action-card-body">
      <p class="action-card-preview">${escapeHtml(pendingAction.preview_text)}</p>
    </div>
    <div class="action-card-actions">
      <button type="button" class="action-btn action-btn-cancel">Cancel</button>
      <button type="button" class="action-btn action-btn-confirm">Confirm</button>
    </div>
    <div class="action-card-footer">No real Workday submission — demo only.</div>
  `;

  const confirmBtn = card.querySelector('.action-btn-confirm');
  const cancelBtn = card.querySelector('.action-btn-cancel');
  confirmBtn.addEventListener('click', () =>
    handleConfirmAction(card, pendingAction, replayContext, true)
  );
  cancelBtn.addEventListener('click', () =>
    handleConfirmAction(card, pendingAction, replayContext, false)
  );

  return card;
}

async function handleConfirmAction(cardEl, pendingAction, replayContext, confirmed) {
  cardEl.querySelectorAll('.action-btn').forEach((b) => (b.disabled = true));

  try {
    const resp = await fetch(`${WORKER_URL}/chat/confirm-action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        confirmed,
        pending_action: pendingAction,
        replay_context: replayContext,
      }),
    });
    if (!resp.ok) throw new Error(`Server ${resp.status}`);
    const data = await resp.json();

    cardEl.classList.add('action-card-resolved');
    addBotMessage(data);
  } catch (err) {
    cardEl.classList.add('action-card-resolved');
    addBotMessage({
      answer: 'I ran into a problem completing that action. Please try again.',
      sources: [],
      conflicts: [],
    });
    console.error(err);
  }
}

function renderToolResultCard(toolExecuted) {
  const card = document.createElement('div');
  card.className = 'action-card action-card-result';

  const r = toolExecuted.result ?? {};

  switch (toolExecuted.name) {
    case 'check_pto_balance':
      card.innerHTML = `
        <div class="action-card-header">
          <span class="action-card-icon">📊</span>
          <span class="action-card-title">PTO Balance</span>
          <span class="action-card-badge">SIMULATED</span>
        </div>
        <div class="action-card-body action-card-stats">
          <div class="action-card-stat">
            <span class="action-card-stat-label">PTO remaining</span>
            <span class="action-card-stat-value">${escapeHtml(String(r.pto_hours_remaining ?? '?'))} hrs <small>/ ${escapeHtml(String(r.pto_hours_total ?? '?'))}</small></span>
          </div>
          <div class="action-card-stat">
            <span class="action-card-stat-label">Lot Days remaining</span>
            <span class="action-card-stat-value">${escapeHtml(String(r.lot_days_remaining ?? '?'))} / ${escapeHtml(String(r.lot_days_total ?? '?'))}</span>
          </div>
          ${r.anniversary_milestone ? `<div class="action-card-stat-note">⭐ ${escapeHtml(r.anniversary_milestone)}</div>` : ''}
        </div>
        <div class="action-card-footer">No real Workday data — demo only.</div>
      `;
      break;

    case 'submit_pto_request':
      card.innerHTML = `
        <div class="action-card-header">
          <span class="action-card-icon">✅</span>
          <span class="action-card-title">PTO Request Submitted</span>
          <span class="action-card-badge">SIMULATED</span>
        </div>
        <div class="action-card-body action-card-stats">
          <div class="action-card-stat">
            <span class="action-card-stat-label">Confirmation ID</span>
            <span class="action-card-stat-value action-card-confirmation-id">${escapeHtml(r.confirmation_id ?? '?')}</span>
          </div>
          <div class="action-card-stat">
            <span class="action-card-stat-label">Hours / Date</span>
            <span class="action-card-stat-value">${escapeHtml(String(r.hours_requested ?? '?'))} hrs · ${escapeHtml(r.date_requested ?? '?')}</span>
          </div>
          <div class="action-card-stat">
            <span class="action-card-stat-label">Manager notified</span>
            <span class="action-card-stat-value">${escapeHtml(r.manager_notified ?? '—')}</span>
          </div>
          <div class="action-card-stat">
            <span class="action-card-stat-label">Remaining balance</span>
            <span class="action-card-stat-value">${escapeHtml(String(r.remaining_balance_hours ?? '?'))} hrs</span>
          </div>
        </div>
        <div class="action-card-footer">No real Workday submission — demo only.</div>
      `;
      break;

    case 'request_keystoneland_tickets':
      card.innerHTML = `
        <div class="action-card-header">
          <span class="action-card-icon">🎟️</span>
          <span class="action-card-title">KeystoneLand Tickets Requested</span>
          <span class="action-card-badge">SIMULATED</span>
        </div>
        <div class="action-card-body action-card-stats">
          <div class="action-card-stat">
            <span class="action-card-stat-label">Confirmation ID</span>
            <span class="action-card-stat-value action-card-confirmation-id">${escapeHtml(r.confirmation_id ?? '?')}</span>
          </div>
          <div class="action-card-stat">
            <span class="action-card-stat-label">Tickets / Date</span>
            <span class="action-card-stat-value">${escapeHtml(String(r.tickets_requested ?? '?'))} · ${escapeHtml(r.date_requested ?? '?')}</span>
          </div>
          <div class="action-card-stat">
            <span class="action-card-stat-label">Remaining this quarter</span>
            <span class="action-card-stat-value">${escapeHtml(String(r.tickets_remaining_this_quarter ?? '?'))} / 2</span>
          </div>
        </div>
        <div class="action-card-footer">No real ticket reservation — demo only.</div>
      `;
      break;

    default:
      return null;
  }

  return card;
}

function createBotMessageShell() {
  const el = document.createElement('div');
  el.className = 'message bot';

  const avatar = document.createElement('div');
  avatar.className = 'bot-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = 'K';

  const wrap = document.createElement('div');
  wrap.className = 'bubble-wrap';

  el.appendChild(avatar);
  el.appendChild(wrap);
  return el;
}

function renderSources(sources) {
  const wrap = document.createElement('div');
  wrap.className = 'sources';

  const toggle = document.createElement('button');
  toggle.className = 'sources-toggle';
  toggle.textContent = `▸ Sources (${sources.length})`;

  const list = document.createElement('div');
  list.className = 'sources-list';

  for (const s of sources) {
    const card = document.createElement('div');
    card.className = `source-card ${s.authority === 'high' ? 'authoritative' : 'forum'}`;
    const icon = s.authority === 'high' ? '📘' : '💬';
    const sectionLabel = s.section_heading && s.section_heading !== 'preamble'
      ? ` · ${escapeHtml(s.section_heading)}`
      : '';
    card.innerHTML = `
      <span class="source-icon">${icon}</span>
      <div class="source-meta">
        <span class="source-name">${escapeHtml(s.doc_name)}${sectionLabel}</span>
        <span class="source-detail">${escapeHtml(s.platform)}</span>
      </div>
    `;
    list.appendChild(card);
  }

  toggle.addEventListener('click', () => {
    const isOpen = list.classList.toggle('open');
    toggle.textContent = `${isOpen ? '▾' : '▸'} Sources (${sources.length})`;
  });

  wrap.appendChild(toggle);
  wrap.appendChild(list);
  return wrap;
}

function scrollToBottom() {
  thread.scrollTop = thread.scrollHeight;
}

/**
 * Minimal markdown: ### → h4, ## → h3, - bullets, **bold**, blank-line paragraphs.
 */
function renderMarkdown(text) {
  if (!text) return '';
  const safe = escapeHtml(text);

  const blocks = safe.split(/\n{2,}/);
  return blocks
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return '';

      const h3 = trimmed.match(/^###\s+(.+)$/);
      if (h3) return `<h4>${applyInline(h3[1])}</h4>`;

      const h2 = trimmed.match(/^##\s+(.+)$/);
      if (h2) return `<h3>${applyInline(h2[1])}</h3>`;

      const lines = trimmed.split('\n');
      if (lines.length > 0 && lines.every((l) => /^\s*[-*]\s+/.test(l))) {
        const items = lines
          .map((l) => l.replace(/^\s*[-*]\s+/, ''))
          .map((l) => `<li>${applyInline(l)}</li>`)
          .join('');
        return `<ul>${items}</ul>`;
      }

      return `<p>${applyInline(trimmed.replace(/\n/g, '<br>'))}</p>`;
    })
    .filter(Boolean)
    .join('');
}

function applyInline(text) {
  return text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
