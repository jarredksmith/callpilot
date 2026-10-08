/* CallPilot Mobile: a silent meeting copilot that runs entirely on your phone.
   Speech is turned into text on the phone (iPhone speech) or by OpenAI Whisper, notes come from
   Claude, and everything is stored on this phone only. */
'use strict';

const VERSION = '1.3.0';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// ------------------------------------------------------------------ settings
const DEFAULTS = {
  name: '', context: '', claudeKey: '', model: 'claude-sonnet-5-5', recapModel: 'claude-sonnet-5-5',
  stt: 'auto', openaiKey: '', whisperModel: 'gpt-4o-mini-transcribe', vocab: '',
  interval: 40, minWords: 35,
  glasses: { method: 'off', poUser: '', poToken: '', ntfyTopic: '', style: 'say', silent: true, answers: true, split: 'split', gap: '5', repeat: '0', tight: true, maxChars: 45, titleMax: 70 },
};
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let S = Object.assign({}, DEFAULTS, store.get('cp.settings', {}));
S.glasses = Object.assign({}, DEFAULTS.glasses, S.glasses || {});
const saveSettings = () => store.set('cp.settings', S);

// ------------------------------------------------------------------ storage (IndexedDB)
const DB = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('callpilot', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('calls', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('calls', mode);
      const req = fn(t.objectStore('calls'));
      t.oncomplete = () => res(req ? req.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  };
  return {
    put: c => run('readwrite', s => s.put(JSON.parse(JSON.stringify(c)))),
    del: id => run('readwrite', s => s.delete(id)),
    get: id => run('readonly', s => s.get(id)),
    all: () => run('readonly', s => s.getAll()),
  };
})();

// ------------------------------------------------------------------ prompts
const CALL_TYPES = {
  'General': '',
  '1:1 with my team': "This is a 1:1 with someone on {name}'s team. Watch for blockers he can remove, commitments without dates, workload or morale signals, work that's drifting from priorities, and coaching moments.",
  'Exec / leadership': "This is a leadership or exec meeting. Watch for budget and spend questions, how marketing's contribution to pipeline is framed, optics with the CEO, CFO and board, decisions being made, and asks of {name} that need a clear owner and date. Suggest crisp, data-backed wording.",
  'Client / sales': "This is a client or sales meeting. Watch for buying signals, objections, compliance deadlines and pain points, competitors mentioned, budget and timing, decision makers, and a clear next step. Suggest discovery questions and keep the company's services accurate.",
  'Vendor / partner': "This is a vendor or partner meeting. Watch for pricing and terms, contract length and cancellation, what's included vs. extra, deliverables and dates, and gaps between what's promised and what {name} needs.",
  'Internal team / project': 'This is an internal team or project meeting. Watch for decisions, owners and dates, dependencies on other teams, scope creep, and anything blocked by review.',
  'Conference / networking': "This is an in-person conversation at a conference or event. Watch for the person's role, company, needs and pain points, anything worth following up on, and a natural next step. Suggest short, friendly questions.",
};

const LIVE_RULES = `You are CallPilot, a silent copilot for {name} during a live, in-person meeting. You never speak. You only send short notes that he reads on smart glasses or a glance at his phone, so every note must earn the interruption, and short wins.

The transcript comes from one phone microphone in the room, transcribed automatically. There are no speaker labels: {name}'s words and everyone else's are mixed together. Work out who is speaking from context when it matters, and expect misheard words and names. Lines like "-- Paused --" mark gaps where nothing was recorded.

What good notes look like:
- A sharp question {name} should ask next, with exact wording he can say.
- A flag: a risk, an inconsistency with something said earlier, a commitment with no owner or date, an optics problem, a number that doesn't add up, a decision being made too fast.
- An idea that connects what's being discussed to his priorities in the background below.
- A correction if an earlier note misread the situation.
Do not narrate the meeting back to him, praise, or give generic advice. Do not invent facts or numbers. Prefer silence over a weak note.

Reply with JSON only, no prose, in exactly this shape:
{"notes": [{"kind": "question|flag|idea|action|correction", "headline": "max 10 words", "detail": "max 35 words, optional", "say": "exact words he could say, max 25 words, optional"}],
 "action_items": [{"owner": "name", "item": "what", "due": "date or empty"}]}
Rules: 0 to 2 notes per update, focused on the most recent minutes. "notes": [] is a good answer when nothing new is worth saying. Never repeat or rephrase a note already shown. Only add action items that were actually agreed in the meeting and are not already captured.`;

const ASK_RULES = `You are CallPilot, {name}'s private copilot during a live, in-person meeting. He tapped a quick question. He will read your answer on smart glasses that show a few words at a time for only a few seconds, so answer in at most 25 words, in short sentences, plain text, no headings, no lists unless asked. If useful, give exact wording he can say. Use the transcript (one room microphone, no speaker labels) and the background; say so if they don't cover it.`;

const RECAP_RULES = `You are CallPilot. The meeting has ended. Write {name}'s private recap in Markdown from the transcript (auto-transcribed from one phone microphone in the room, so there are no speaker labels and names or words may be misheard; fix obvious errors and don't guess at what you can't tell). If the setup lists who was there, use those names for owners where the transcript makes it clear. Moments {name} bookmarked mattered to him: make sure each one is covered.

Use these sections:
## Summary (3 to 6 bullets)
## Decisions
## Action items (a table: Owner | Item | Due; write "unassigned" or "no date" where the meeting left it open)
## Open questions
## What {name} should do next (his own follow-ups, most important first)
## Draft recap email (short, plain, ready to paste; no subject-line fluff)

Be concise and specific. Don't pad sections; write "None" if a section is empty.`;

const QUICK_ASKS = ['What should I ask next?', 'Summarize the last 5 minutes', "What's still unresolved?", 'Who owns what so far?', 'What did they just ask for?', 'Any red flags?'];
const KIND_LABEL = { question: 'Ask', flag: 'Flag', idea: 'Idea', action: 'To do', correction: 'Correction', answer: 'Answer', system: 'CallPilot' };
const KINDS = new Set(['question', 'flag', 'idea', 'action', 'correction']);
const CHUNK_LINES = 30;

const fill = s => s.replaceAll('{name}', S.name || 'me');
const glassesOn = () => S.glasses.method !== 'off';
function liveRules() {
  if (!(glassesOn() && S.glasses.tight)) return LIVE_RULES;
  return LIVE_RULES.replace('"headline": "max 10 words"', '"headline": "max 8 words"')
    .replace('"say": "exact words he could say, max 25 words, optional"', '"say": "exact words he could say, max 15 words, optional"')
    .replace('"detail": "max 35 words, optional"', '"detail": "max 20 words, optional"')
    + '\nHe reads notes on smart glasses that show each one for only a few seconds, so keep them very short and plain: no parentheses, no lists.';
}
function systemBlocks(rules) {
  let text = fill(rules);
  if (S.context.trim()) text += `\n\n<background about ${S.name || 'me'} and his work>\n${S.context.trim()}\n</background>`;
  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
}

// ------------------------------------------------------------------ Claude
function quickParams(model) {
  const m = model.toLowerCase();
  if (m.includes('sonnet-5-5')) return { thinking: { type: 'between_tools' } };
  if (['opus-5-5', 'fable', 'mythos'].some(k => m.includes(k))) return { output_config: { effort: 'low' } };
  return { thinking: { type: 'disabled' } };
}

async function anthropicPost(body, timeout) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: {
        'content-type': 'application/json', 'x-api-key': S.claudeKey.trim(), 'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
    const raw = await res.text();
    let json = null; try { json = JSON.parse(raw); } catch {}
    return { ok: res.ok, status: res.status, json, raw };
  } catch (e) {
    return { ok: false, status: 0, json: null, raw: e.name === 'AbortError' ? 'timed out' : String(e.message || e) };
  } finally { clearTimeout(t); }
}

const textOf = j => ((j && j.content) || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();

async function claude({ model, system, messages, max_tokens, quick = true, timeout = 60000 }) {
  if (!S.claudeKey.trim()) throw new Error('Add your Claude API key in Settings.');
  const extra = quick ? quickParams(model) : {};
  let body = { model, max_tokens, messages, ...extra };
  if (system) body.system = system;
  let r = await anthropicPost(body, timeout);
  if (!r.ok && r.status === 400 && Object.keys(extra).length && /thinking|effort|output_config/i.test(r.raw)) {
    body = { model, max_tokens: Math.max(max_tokens, 8000), messages, ...(system ? { system } : {}) };
    r = await anthropicPost(body, timeout);
  }
  for (let i = 0; i < 2 && !r.ok && [0, 429, 500, 502, 503, 529].includes(r.status); i++) {
    await sleep(1500 * (i + 1));
    r = await anthropicPost(body, timeout);
  }
  if (!r.ok) {
    const msg = (r.json && r.json.error && r.json.error.message) || r.raw || 'no response';
    if (r.status === 401) throw new Error('Claude rejected the API key. Check it in Settings.');
    if (r.status === 404) throw new Error(`Model not found (${model}). Pick another in Settings.`);
    throw new Error(`Claude error ${r.status || ''}: ${String(msg).slice(0, 160)}`);
  }
  let text = textOf(r.json);
  if (!text && r.json && r.json.stop_reason === 'max_tokens') {
    body.max_tokens = Math.min(16000, Math.max(4000, body.max_tokens * 4));
    r = await anthropicPost(body, timeout);
    text = r.ok ? textOf(r.json) : '';
  }
  if (!text) throw new Error('Claude returned no text.');
  return text;
}

function extractJSON(text) {
  let t = text.trim();
  const m = t.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  if (m) t = m[1];
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

function parseLive(text) {
  const d = extractJSON(text) || {};
  const notes = [];
  for (const n of d.notes || []) {
    if (!n || typeof n !== 'object') continue;
    const headline = String(n.headline || '').trim();
    if (!headline) continue;
    const kind = String(n.kind || 'idea').trim().toLowerCase();
    notes.push({ kind: KINDS.has(kind) ? kind : 'idea', headline, detail: String(n.detail || '').trim(), say: String(n.say || '').trim() });
  }
  const actions = [];
  for (const a of d.action_items || []) {
    if (a && typeof a === 'object' && String(a.item || '').trim()) {
      actions.push({ owner: String(a.owner || '').trim() || 'unassigned', item: String(a.item).trim(), due: String(a.due || '').trim() });
    }
  }
  return { notes: notes.slice(0, 2), actions };
}

function transcriptBlocks(lines, maxChars = 120000) {
  const nFrozen = Math.floor(lines.length / CHUNK_LINES) * CHUNK_LINES;
  const chunks = [];
  for (let i = 0; i < nFrozen; i += CHUNK_LINES) chunks.push(lines.slice(i, i + CHUNK_LINES).join('\n'));
  const tail = lines.slice(nFrozen).join('\n');
  while (chunks.length && chunks.reduce((n, c) => n + c.length, 0) + tail.length > maxChars) chunks.shift();
  const blocks = [{ type: 'text', text: 'TRANSCRIPT SO FAR (oldest first):' }, ...chunks.map(c => ({ type: 'text', text: c }))];
  if (blocks.length > 1) blocks[blocks.length - 1].cache_control = { type: 'ephemeral' };
  return { blocks, tail };
}

function setupText(c) {
  const parts = [];
  if (c.callType && CALL_TYPES[c.callType]) parts.push(`Meeting type: ${c.callType}. ` + fill(CALL_TYPES[c.callType]));
  if (c.people && c.people.length) parts.push(`There besides ${S.name || "me"}: ${c.people.join(', ')}`);
  return parts.join('\n');
}
const lineTexts = c => c.lines.map(l => l.mark ? `-- ${l.text} --` : `[${mmss(l.t)}] ${l.text}`);
const actionsText = acts => acts.map(a => `- ${a.owner}: ${a.item}${a.due ? ` (due ${a.due})` : ''}`).join('\n') || '- none yet';

async function liveNotes(c, forced) {
  const { blocks, tail } = transcriptBlocks(lineTexts(c));
  const shown = c.notes.filter(n => KINDS.has(n.kind)).slice(-40).map(n => `- [${n.kind}] ${n.headline}`).join('\n') || '- none yet';
  const st = setupText(c);
  blocks.push({ type: 'text', text:
    `${tail}\n\n---\nMeeting topic: ${c.topic || 'not given'}\nElapsed: ${mmss(elapsed())}\n`
    + (st ? `Setup:\n${st}\n` : '')
    + `Notes already shown (do not repeat):\n${shown}\nAction items already captured:\n${actionsText(c.actions)}\n\n`
    + (forced ? "He just tapped 'Note now': give him the single most useful note for this moment, even if it's small.\n" : '')
    + 'Return the JSON now.' });
  const text = await claude({ model: S.model, max_tokens: 1500, system: systemBlocks(liveRules()), messages: [{ role: 'user', content: blocks }] });
  return parseLive(text);
}

async function askClaude(c, question) {
  const { blocks, tail } = transcriptBlocks(lineTexts(c));
  const st = setupText(c);
  blocks.push({ type: 'text', text: `${tail}\n\n---\nMeeting topic: ${c.topic || 'not given'}\n${st ? `Setup:\n${st}\n` : ''}\nQuestion: ${question}` });
  return claude({ model: S.model, max_tokens: 1000, system: systemBlocks(ASK_RULES), messages: [{ role: 'user', content: blocks }] });
}

async function recapClaude(c) {
  const shown = c.notes.filter(n => KINDS.has(n.kind)).map(n => `- [${n.kind}] ${n.headline}`).join('\n') || '- none';
  const bm = (c.bookmarks || []).map(b => `- ${b.stamp}: ${b.context.join(' / ')}`).join('\n') || '- none';
  const st = setupText(c);
  const body = `Meeting topic: ${c.topic || 'not given'}\nStarted: ${new Date(c.started).toLocaleString()}\n${st ? `Setup:\n${st}\n` : ''}`
    + `\nTRANSCRIPT:\n${lineTexts(c).join('\n').slice(-400000)}`
    + `\n\nMoments ${S.name || "I"} bookmarked (time: what was being said):\n${bm}`
    + `\n\nAction items captured live:\n${actionsText(c.actions)}\n\nNotes CallPilot showed live:\n${shown}`;
  return claude({ model: S.recapModel, max_tokens: 16000, quick: false, timeout: 300000, system: systemBlocks(RECAP_RULES), messages: [{ role: 'user', content: body }] });
}

// ------------------------------------------------------------------ speech to text
const HALLUCINATIONS = /^(thank you\.?|thanks for watching\.?|you\.?|bye\.?|\.+|thank you very much\.?|subtitles by.*|♪+)$/i;

class BuiltinSTT {
  static available() { return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }
  constructor(h) { this.h = h; this.running = false; this.rec = null; this.lastFinal = ''; }
  start() {
    this.running = true; this.fails = 0; this.spawn();
    this.watch = setInterval(() => this.watchdog(), 1500);
  }
  spawn() {
    if (!this.running) return;
    const R = window.SpeechRecognition || window.webkitSpeechRecognition;
    const r = new R();
    this.rec = r; this.interim = ''; this.interimAt = Date.now(); this.activity = Date.now(); this.segStart = this.h.now();
    r.lang = 'en-US'; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
    r.onresult = e => {
      this.activity = Date.now(); this.fails = 0;
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i], txt = (res[0] && res[0].transcript || '').trim();
        if (!txt) continue;
        if (res.isFinal) this.commit(txt); else interim += (interim ? ' ' : '') + txt;
      }
      if (interim !== this.interim) { this.interim = interim; this.interimAt = Date.now(); }
      this.h.onInterim(interim);
    };
    r.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.running = false; this.h.onFatal(e.error === 'not-allowed' ? 'Microphone or speech recognition permission was denied.' : 'iPhone speech recognition is not available here.');
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        this.fails++;
        if (this.fails >= 6) { this.running = false; this.h.onFatal(`iPhone speech keeps failing (${e.error}).`); }
      }
    };
    r.onend = () => {
      if (this.interim) { this.commit(this.interim); this.interim = ''; }
      if (this.running) setTimeout(() => this.spawn(), 200);
    };
    try { r.start(); } catch (err) { this.fails++; if (this.running) setTimeout(() => this.spawn(), 800); }
  }
  commit(txt) {
    txt = txt.trim();
    if (!txt || txt === this.lastFinal || HALLUCINATIONS.test(txt)) return;
    // iOS sometimes re-sends the whole utterance with more words on the end
    if (this.lastFinal && txt.startsWith(this.lastFinal) && txt.length > this.lastFinal.length) txt = txt.slice(this.lastFinal.length).trim();
    this.lastFinal = txt;
    this.h.onText(txt, this.segStart);
    this.segStart = this.h.now();
    this.h.onInterim('');
  }
  watchdog() {
    if (!this.running || !this.rec) return;
    const now = Date.now();
    // iPhone often never marks a result final: close the utterance after a pause so it lands
    if (this.interim && now - this.interimAt > 2200) { this.rec.stop(); return; }
    if (this.interim.length > 320) { this.rec.stop(); return; }
    // stuck (no results or end event for a long time): restart
    if (now - this.activity > 25000) { this.activity = now; try { this.rec.abort(); } catch {} }
  }
  stop() {
    this.running = false; clearInterval(this.watch);
    if (this.rec) { try { this.rec.stop(); } catch {} }
    this.rec = null;
  }
}

class WhisperSTT {
  constructor(h) { this.h = h; this.running = false; this.queue = Promise.resolve(); this.seq = 0; }
  async start() {
    if (!S.openaiKey.trim()) throw new Error('Whisper needs an OpenAI API key in Settings.');
    this.running = true;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.an = this.ctx.createAnalyser(); this.an.fftSize = 1024; src.connect(this.an);
    this.buf = new Float32Array(this.an.fftSize);
    this.noise = 0.004;
    this.mime = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find(m => window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
    this.newSegment();
    this.tick = setInterval(() => this.level(), 100);
  }
  newSegment() {
    if (!this.running) return;
    const rec = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime } : undefined);
    const seg = { chunks: [], start: this.h.now(), began: Date.now(), voiced: 0, silentSince: 0, rec };
    rec.ondataavailable = e => { if (e.data && e.data.size) seg.chunks.push(e.data); };
    rec.onstop = () => this.finish(seg);
    rec.start();
    this.seg = seg;
  }
  level() {
    if (!this.running || !this.seg) return;
    if (this.stream.getAudioTracks().every(t => t.readyState === 'ended')) { this.h.onLost(); return; }
    this.an.getFloatTimeDomainData(this.buf);
    let sum = 0; for (const v of this.buf) sum += v * v;
    const rms = Math.sqrt(sum / this.buf.length);
    const voice = rms > Math.max(0.006, this.noise * 3);
    if (!voice) this.noise = this.noise * 0.98 + rms * 0.02;
    const seg = this.seg, now = Date.now(), dur = now - seg.began;
    if (voice) { seg.voiced += 100; seg.silentSince = 0; if (!this.hearing) { this.hearing = true; this.h.onInterim('speech…'); } }
    else if (this.hearing && seg.silentSince && now - seg.silentSince > 1500) { this.hearing = false; this.h.onInterim(''); }
    else if (!seg.silentSince) seg.silentSince = now;
    const quietFor = seg.silentSince ? now - seg.silentSince : 0;
    if ((dur > 7000 && quietFor > 700) || dur > 25000) this.cut();
  }
  cut() {
    const old = this.seg; this.seg = null;
    try { old.rec.stop(); } catch {}
    this.newSegment();
  }
  finish(seg) {
    if (seg.voiced < 400 || !seg.chunks.length) return;   // nothing worth sending
    const blob = new Blob(seg.chunks, { type: seg.chunks[0].type || this.mime || 'audio/mp4' });
    const my = ++this.seq;
    this.queue = this.queue.then(() => this.send(blob, seg.start, my)).catch(() => {});
  }
  async send(blob, start) {
    const ext = /mp4|m4a|aac/.test(blob.type) ? 'm4a' : /ogg/.test(blob.type) ? 'ogg' : 'webm';
    const prompt = [S.vocab, this.h.recent()].filter(Boolean).join('. ').slice(-600);
    for (let attempt = 0; attempt < 3; attempt++) {
      const fd = new FormData();
      fd.append('file', blob, `seg.${ext}`);
      fd.append('model', S.whisperModel || 'gpt-4o-mini-transcribe');
      fd.append('language', 'en');
      if (prompt) fd.append('prompt', prompt);
      fd.append('response_format', 'json');
      try {
        const res = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${S.openaiKey.trim()}` }, body: fd });
        if (res.status === 401) { this.h.onError('OpenAI rejected the API key. Check it in Settings.'); return; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        const txt = String(j.text || '').trim();
        if (txt && !HALLUCINATIONS.test(txt)) this.h.onText(txt, start);
        this.h.onInterim('');
        return;
      } catch (e) {
        if (attempt === 2) this.h.onError(`Whisper couldn't transcribe a few seconds (${e.message}).`);
        await sleep(1200 * (attempt + 1));
      }
    }
  }
  async stop() {
    this.running = false; clearInterval(this.tick);
    if (this.seg) {
      const s = this.seg; this.seg = null;
      const done = new Promise(res => { const fin = s.rec.onstop; s.rec.onstop = () => { fin(); res(); }; setTimeout(res, 1500); });
      try { s.rec.stop(); } catch {}
      await done;   // the last few seconds get transcribed too
    }
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    if (this.ctx) this.ctx.close().catch(() => {});
    return Promise.race([this.queue, sleep(20000)]);
  }
}

// ------------------------------------------------------------------ glasses / notifications
let swReg = null;
const GLASS_TAG = { question: 'Ask', flag: 'Flag', idea: 'Idea', action: 'To do', correction: 'Fix', answer: 'Answer', system: 'CallPilot' };
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

function glassesText(n) {
  const tag = GLASS_TAG[n.kind] || 'Note';
  const style = S.glasses.style;
  const title = clip(`${tag}: ${n.headline}`, 90);
  let body = '';
  if (n.kind === 'answer') body = clip(n.detail || '', style === 'full' ? 900 : 260);
  else if (style === 'short') body = n.say ? `“${n.say}”` : (n.detail || '');
  else if (style === 'full') body = [n.detail, n.say ? `“${n.say}”` : ''].filter(Boolean).join('\n');
  return { title, body: clip(body, style === 'full' ? 900 : 200) };
}

// Break text into pieces short enough for the glasses to show whole (they cut off long notifications).
// Splits at sentence ends first, then at commas and similar, then between words. Never adds "…".
const glassMax = () => Math.max(20, Number(S.glasses.maxChars) || 45);

const titleMax = () => Math.max(20, Number(S.glasses.titleMax) || 70);

// Lay text out on the glasses' lines. Notifications alternate a title line and a body line, each with its
// own width. Uses the fewest lines, keeps them even, and prefers breaking at sentence ends, then commas.
function layoutLines(segments, capOf) {
  const lines = [];
  for (const seg of segments) {
    let words = String(seg || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    if (!words.length) continue;
    const start = lines.length, minCap = Math.min(capOf(0), capOf(1));
    words = words.flatMap(w => { const out = []; while (w.length > minCap) { out.push(w.slice(0, minCap)); w = w.slice(minCap); } out.push(w); return out; });
    const n = words.length, memo = new Map();
    const solve = (i, k) => {
      if (i === n) return { cost: 0 };
      const key = i * 100 + (k - start);
      if (memo.has(key)) return memo.get(key);
      const cap = capOf(k);
      let best = null, len = -1;
      for (let j = i; j < n; j++) {
        len += words[j].length + 1;
        if (len > cap) break;
        const last = j === n - 1;
        const w = words[j];
        const bonus = last ? 0 : /[.!?]["”’)]*$/.test(w) ? 1500 : /[,;:—–]$/.test(w) ? 600 : 0;
        const rest = solve(j + 1, k + 1);
        if (!rest) continue;
        const cost = 100000 + (cap - len) ** 2 * (last ? 0.3 : 1) - bonus + rest.cost;
        if (!best || cost < best.cost) best = { cost, next: j + 1 };
      }
      memo.set(key, best);
      return best;
    };
    let i = 0, k = start;
    while (i < n) { const r = solve(i, k); lines.push(words.slice(i, r.next).join(' ')); i = r.next; k++; }
  }
  return lines;
}
function chunkText(text, max) { return layoutLines([text], () => max); }

// Turn a note into notifications: line 1 of the text is the title, line 2 the body, and so on.
function glassesParts(n) {
  const { title, body } = glassesText(n);
  const style = S.glasses.style;
  if (S.glasses.split !== 'split' || style === 'full') return [{ title, body }];
  const caps = k => (k % 2 === 0 ? titleMax() : glassMax());
  const tag = GLASS_TAG[n.kind] || 'Note';
  const sayText = n.say ? n.say.replace(/^["“]|["”]$/g, '') : '';
  let segments;
  if (n.kind === 'answer') segments = [n.detail];
  else if (n.kind === 'system') segments = [n.headline, n.detail];
  else if (style === 'say') segments = [sayText || `${tag}: ${n.headline}`];
  else if (style === 'headline') segments = [`${tag}: ${n.headline}`];
  else segments = [`${tag}: ${n.headline}`, sayText ? `“${sayText}”` : n.detail];
  const lines = layoutLines(segments.slice(0, 2), caps).slice(0, 12);
  const out = [];
  for (let i = 0; i < lines.length; i += 2) out.push({ title: lines[i], body: lines[i + 1] || '' });
  return out;
}

let glassWarned = false;
let glassQueue = Promise.resolve();
let lastGlassNote = null;

async function deliver(title, body) {
  const g = S.glasses;
  if (!body && g.method !== 'app') {
    // Pushover and ntfy need a message: put the label in the title and the headline in the message
    const m = title.match(/^([^:]{1,14}):\s*(.+)$/);
    if (m) { title = m[1]; body = m[2]; } else body = title;
  }
  if (g.method === 'app') {
    if (!('Notification' in window)) throw new Error(isIOS && !standalone() ? 'open CallPilot from its Home Screen icon first' : 'notifications are not supported here');
    if (Notification.permission !== 'granted') throw new Error('notifications are not allowed yet (tap Allow notifications)');
    const reg = swReg || await navigator.serviceWorker.ready;
    await reg.showNotification(title, { body: body || '', tag: 'cp-' + Date.now() + Math.random(), silent: !!g.silent, icon: 'icon-192.png', badge: 'icon-192.png' });
  } else if (g.method === 'pushover') {
    if (!g.poUser || !g.poToken) throw new Error('add your Pushover user key and app token');
    const fd = new URLSearchParams({ token: g.poToken.trim(), user: g.poUser.trim(), title, message: body, priority: '0' });
    if (g.silent) fd.set('sound', 'none');
    const r = await fetch('https://api.pushover.net/1/messages.json', { method: 'POST', body: fd });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error((j.errors || [`HTTP ${r.status}`]).join(', ')); }
  } else if (g.method === 'ntfy') {
    if (!g.ntfyTopic) throw new Error('set an ntfy channel name');
    const r = await fetch('https://ntfy.sh/', { method: 'POST', body: JSON.stringify({ topic: g.ntfyTopic.trim(), title, message: body, priority: g.silent ? 2 : 3 }) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  }
}

function sendGlasses(n, force = false) {
  const g = S.glasses;
  if (g.method === 'off') return Promise.resolve(force ? Promise.reject(new Error('choose how to send notes first')) : 'off');
  if (n.kind === 'answer' && !g.answers && !force) return Promise.resolve('skipped');
  if (n.kind !== 'system') lastGlassNote = n;
  const parts = glassesParts(n);
  const gap = Math.max(2, Number(g.gap) || 5) * 1000;
  const job = glassQueue.then(async () => {
    for (let i = 0; i < parts.length; i++) {
      if (i) await sleep(gap);
      await deliver(parts[i].title, parts[i].body);
    }
    glassWarned = false;
    return 'sent';
  });
  glassQueue = job.catch(() => {}).then(() => sleep(1200));   // a short breather so notes don't stack up
  const repeat = Number(g.repeat) || 0;
  if (repeat && !force && n.kind !== 'system') setTimeout(() => { if (C && lastGlassNote === n) sendGlassesAgain(n); }, repeat * 1000 + (parts.length - 1) * gap);
  if (force) return job;
  return job.catch(e => { if (!glassWarned) { glassWarned = true; toast(`Couldn't send to glasses: ${e.message}`); } return 'failed'; });
}
function sendGlassesAgain(n) { const r = S.glasses.repeat; S.glasses.repeat = '0'; sendGlasses(n); S.glasses.repeat = r; }
function replayLast() {
  if (!lastGlassNote) { toast('No note to replay yet.'); return; }
  if (S.glasses.method === 'off') { toast('Glasses are off in Settings.'); return; }
  sendGlassesAgain(lastGlassNote);
  if (!$('#pocket').classList.contains('on')) toast('Replaying the last note.');
}

// ------------------------------------------------------------------ live meeting state
let C = null;               // the current meeting
let stt = null;             // the speech engine in use
let engineName = '';
let insightBusy = false, pendingForce = false, lastInsight = 0, wordsAtLast = 0, hiddenAt = 0;
let wake = null, autosaveTimer = null, tickTimer = null;

const nowSec = () => (C ? Math.max(0, (Date.now() - C.started) / 1000) : 0);
const elapsed = nowSec;
function mmss(sec) {
  sec = Math.floor(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(s).padStart(2, '0');
}
const words = s => (s.match(/\S+/g) || []).length;
const totalWords = () => (C ? C.lines.reduce((n, l) => n + (l.mark ? 0 : words(l.text)), 0) : 0);

function setStatus(text, cls = '') { const el = $('#status'); el.textContent = text; el.className = 'pill ' + cls; }
function baseStatus() {
  if (!C) return setStatus('Ready');
  if (C.paused) return setStatus('Paused', 'pause');
  setStatus(insightBusy ? 'Thinking' : `Listening${engineName ? ' · ' + engineName : ''}`, insightBusy ? 'think' : 'live');
}

function addLine(text, t) {
  if (!C || C.paused) return;
  C.lines.push({ t: t ?? nowSec(), text });
  C.lines.sort((a, b) => a.t - b.t);
  renderTranscript();
}
function addMark(text) { if (C) { C.lines.push({ t: nowSec(), text, mark: true }); renderTranscript(); } }

const sttHooks = {
  now: () => nowSec(),
  onText: (txt, t) => addLine(txt, t),
  onInterim: txt => { $('#heard').textContent = txt ? `Hearing: ${txt}` : (C && C.paused ? 'Paused' : 'Listening…'); },
  onError: msg => toast(msg),
  onFatal: msg => fallbackToWhisper(msg),
  onLost: () => restartSTT('the microphone stopped'),
  recent: () => (C ? C.lines.filter(l => !l.mark).slice(-3).map(l => l.text).join(' ') : ''),
};

async function startSTT() {
  const want = S.stt;
  if ((want === 'auto' || want === 'builtin') && BuiltinSTT.available()) {
    stt = new BuiltinSTT(sttHooks); engineName = 'iPhone speech'; stt.start(); return;
  }
  if (want === 'builtin') throw new Error('Built-in speech recognition is not available in this browser. Choose Whisper in Settings.');
  stt = new WhisperSTT(sttHooks); engineName = 'Whisper';
  await stt.start();
}

async function fallbackToWhisper(reason) {
  if (!C) return;
  if (S.stt === 'auto' && S.openaiKey.trim() && !(stt instanceof WhisperSTT)) {
    toast(`${reason} Switching to Whisper.`);
    try { stt && stt.stop(); } catch {}
    stt = new WhisperSTT(sttHooks); engineName = 'Whisper';
    try { await stt.start(); addMark('Switched to Whisper'); } catch (e) { pushSystem(`Can't listen: ${e.message}`); }
  } else {
    pushSystem(`Stopped listening: ${reason}${S.openaiKey.trim() ? '' : ' Add an OpenAI key in Settings to use Whisper as a backup.'}`);
    setStatus('Not listening', 'err');
  }
  baseStatus();
}

async function restartSTT(why) {
  if (!C || C.paused) return;
  try { if (stt) await stt.stop(); } catch {}
  try { await startSTT(); } catch (e) { pushSystem(`Couldn't restart listening (${why}): ${e.message}`); }
  baseStatus();
}

async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) { wake = await navigator.wakeLock.request('screen'); }
    else if (!on && wake) { await wake.release(); wake = null; }
  } catch {}
}

async function startMeeting() {
  if (!S.claudeKey.trim()) { toast('Add your Claude API key in Settings first.'); showView('settings'); return; }
  const people = $('#people').value.split(',').map(s => s.trim()).filter(Boolean);
  C = { id: 'c' + Date.now(), topic: $('#topic').value.trim(), callType: $('#callType').value, people, started: Date.now(), ended: null,
        lines: [], notes: [], actions: [], bookmarks: [], recap: '', status: 'live', paused: false, engine: '' };
  insightBusy = false; pendingForce = false; lastInsight = Date.now(); wordsAtLast = 0;
  try {
    await startSTT();
  } catch (e) {
    C = null;
    toast(e.name === 'NotAllowedError' ? 'Microphone access was denied. Allow it in iPhone Settings > Safari (or the app) > Microphone.' : e.message);
    return;
  }
  C.engine = engineName;
  store.set('cp.lastSetup', { topic: C.topic, callType: C.callType, people: $('#people').value });
  $('#setup').hidden = true; $('#live').hidden = false; $('#feed').innerHTML = '';
  renderTranscript(); renderActions();
  keepAwake(true);
  baseStatus();
  tickTimer = setInterval(tick, 1000);
  autosaveTimer = setInterval(() => C && DB.put(C).catch(() => {}), 20000);
  DB.put(C).catch(() => {});
  if (!('wakeLock' in navigator)) pushSystem('This phone may lock the screen during the meeting, which stops listening. Set Auto-Lock to Never while you use CallPilot.');
}

function tick() {
  if (!C) return;
  $('#timer').textContent = mmss(nowSec());
  if (C.paused || insightBusy) return;
  const newWords = totalWords() - wordsAtLast;
  if (Date.now() - lastInsight >= S.interval * 1000 && newWords >= S.minWords) runNotes(false);
}

async function runNotes(forced) {
  if (!C) return;
  if (insightBusy) { if (forced) pendingForce = true; return; }
  if (!C.lines.some(l => !l.mark)) { if (forced) toast('Nothing heard yet.'); return; }
  insightBusy = true; baseStatus();
  lastInsight = Date.now(); wordsAtLast = totalWords();
  const meeting = C;
  try {
    const { notes, actions } = await liveNotes(meeting, forced);
    if (meeting !== C) return;
    for (const n of notes) addNote(n);
    for (const a of actions) {
      if (!meeting.actions.some(x => x.item.toLowerCase() === a.item.toLowerCase())) meeting.actions.push(a);
    }
    if (actions.length) renderActions();
    if (forced && !notes.length) toast('Nothing new worth saying right now.');
  } catch (e) {
    toast(e.message);
    setStatus('Error', 'err');
    await sleep(2500);
  } finally {
    insightBusy = false; baseStatus();
    if (pendingForce) { pendingForce = false; runNotes(true); }
  }
}

function addNote(n) {
  if (!C) return;
  n = Object.assign({ detail: '', say: '' }, n, { stamp: mmss(nowSec()) });
  C.notes.push(n);
  renderNote(n, true);
  sendGlasses(n);
}

function pushSystem(text) {
  const n = { kind: 'system', headline: text, detail: '', say: '', stamp: mmss(nowSec()) };
  if (C) C.notes.push(n);
  renderNote(n, false);
}

function renderNote(n, fresh) {
  const feed = $('#feed');
  $$('.note.fresh', feed).forEach(el => el.classList.remove('fresh'));
  const el = document.createElement('div');
  el.className = `note k-${n.kind}${fresh ? ' fresh' : ''}`;
  el.innerHTML = `<div class="meta"><span>${esc(KIND_LABEL[n.kind] || n.kind)}</span><span>${esc(n.stamp || '')}</span></div>
    <h3>${esc(n.headline)}</h3>${n.detail ? `<p>${esc(n.detail)}</p>` : ''}${n.say ? `<div class="say">“${esc(n.say)}”</div>` : ''}`;
  feed.prepend(el);
}

function togglePause() {
  if (!C) return;
  if (!C.paused && !C.pausing) {
    const engine = stt;
    addMark('Paused'); $('#pauseBtn').textContent = 'Resume';
    Promise.resolve(engine && engine.stop()).catch(() => {}).finally(() => { if (C && C.pausing) { C.pausing = false; C.paused = true; baseStatus(); sttHooks.onInterim(''); } });
    C.pausing = true;
  } else {
    C.paused = false; C.pausing = false; addMark('Resumed'); $('#pauseBtn').textContent = 'Pause';
    startSTT().catch(e => pushSystem(`Couldn't resume listening: ${e.message}`));
  }
  sttHooks.onInterim(''); baseStatus();
}

function bookmark() {
  if (!C) return;
  const ctx = C.lines.filter(l => !l.mark).slice(-3).map(l => l.text);
  C.bookmarks.push({ stamp: mmss(nowSec()), context: ctx });
  addMark('Bookmarked');
  toast(`Marked at ${mmss(nowSec())}`);
}

async function ask(question) {
  if (!C || !question.trim()) return;
  closeSheet();
  toast('Asking…');
  const meeting = C;
  try {
    const answer = await askClaude(meeting, question.trim());
    if (meeting !== C) return;
    $('#toast').classList.remove('on');
    addNote({ kind: 'answer', headline: question.trim(), detail: answer, say: '' });
  } catch (e) { toast(e.message); }
}

async function endMeeting() {
  if (!C) return;
  const meeting = C;
  clearInterval(tickTimer); clearInterval(autosaveTimer);
  if (stt) { try { await stt.stop(); } catch {} }
  await sleep(400);
  stt = null;
  meeting.ended = Date.now(); meeting.status = 'ended';
  keepAwake(false); closePocket();
  C = null;
  $('#live').hidden = true; $('#setup').hidden = false; $('#timer').textContent = '';
  await DB.put(meeting).catch(() => {});
  setStatus('Writing recap', 'think');
  await makeRecap(meeting);
  baseStatus();
  await renderLibrary();
  openDetail(meeting.id);
}

async function makeRecap(meeting) {
  if (!meeting.lines.some(l => !l.mark)) { meeting.recap = '_Nothing was transcribed in this meeting._'; await DB.put(meeting); return; }
  try {
    meeting.recap = await recapClaude(meeting);
    meeting.status = 'done';
    await DB.put(meeting);
    if (S.glasses.method !== 'off') sendGlasses({ kind: 'system', headline: `Recap ready: ${meeting.topic || 'meeting'}`, detail: `${meeting.actions.length} action items`, say: '' });
  } catch (e) {
    toast(`Recap failed: ${e.message}. Open it in the Library and tap Write recap to try again.`);
  }
}

// ------------------------------------------------------------------ rendering
function renderTranscript() {
  const box = $('#transcript');
  const c = C;
  if (!c || !c.lines.length) { box.innerHTML = '<div class="empty">The transcript shows up here once a meeting starts.</div>'; return; }
  const atBottom = $('main').scrollTop + $('main').clientHeight >= $('main').scrollHeight - 40;
  box.innerHTML = c.lines.map(l => l.mark ? `<div class="tline mark">— ${esc(l.text)} —</div>` : `<div class="tline"><b>${mmss(l.t)}</b>${esc(l.text)}</div>`).join('');
  if (atBottom && $('#v-transcript').classList.contains('on')) $('main').scrollTop = $('main').scrollHeight;
}

function actionsHTML(acts) {
  if (!acts.length) return '<div class="empty">No action items yet.</div>';
  return acts.map(a => `<div class="act"><div class="who">${esc(a.owner)}</div><div><div>${esc(a.item)}</div>${a.due ? `<div class="due">Due ${esc(a.due)}</div>` : ''}</div></div>`).join('');
}
function renderActions() { $('#actions').innerHTML = C ? actionsHTML(C.actions) : '<div class="empty">Action items agreed during the meeting show up here.</div>'; }

function md(src) {
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*(?!\s)(.+?)\*/g, '$1<em>$2</em>').replace(/_(.+?)_/g, '<em>$1</em>').replace(/`(.+?)`/g, '<code>$1</code>');
  const out = []; const lines = String(src || '').split('\n');
  let i = 0, list = false;
  const closeList = () => { if (list) { out.push('</ul>'); list = false; } };
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*\|.*\|\s*$/.test(l)) {
      closeList();
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(lines[i]); i++; }
      const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const body = rows.filter(r => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
      out.push('<table>' + body.map((r, k) => `<tr>${cells(r).map(c => k === 0 ? `<th>${inline(c)}</th>` : `<td>${inline(c)}</td>`).join('')}</tr>`).join('') + '</table>');
      continue;
    }
    let m;
    if ((m = l.match(/^(#{1,4})\s+(.*)/))) { closeList(); out.push(`<h${m[1].length <= 2 ? 2 : 3}>${inline(m[2])}</h${m[1].length <= 2 ? 2 : 3}>`); }
    else if ((m = l.match(/^\s*[-*•]\s+(.*)/)) || (m = l.match(/^\s*\d+[.)]\s+(.*)/))) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (!l.trim()) closeList();
    else { closeList(); out.push(`<p>${inline(l)}</p>`); }
    i++;
  }
  closeList();
  return out.join('');
}

// ------------------------------------------------------------------ library
let libCache = [];
async function renderLibrary() {
  try { libCache = (await DB.all()).sort((a, b) => b.started - a.started); } catch { libCache = []; }
  const q = $('#libSearch').value.trim().toLowerCase();
  const items = libCache.filter(c => !q || [c.topic, c.recap, c.people.join(' '), c.lines.map(l => l.text).join(' ')].join(' ').toLowerCase().includes(q));
  $('#library').innerHTML = items.length ? items.map(c => {
    const dur = c.ended ? mmss((c.ended - c.started) / 1000) : 'unfinished';
    const d = new Date(c.started);
    return `<button class="lib-item" data-id="${esc(c.id)}"><div class="t">${esc(c.topic || 'Untitled meeting')}</div>
      <div class="s">${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${dur} · ${c.actions.length} action items${c.recap ? '' : ' · no recap yet'}</div></button>`;
  }).join('') : `<div class="empty">${q ? 'No meetings match.' : 'Finished meetings are saved here, on this phone.'}</div>`;
}

let detailId = null, detailTab = 'recap';
async function openDetail(id) {
  const c = await DB.get(id); if (!c) return;
  detailId = id; detailTab = c.recap ? 'recap' : 'transcript';
  $('#detailTitle').textContent = c.topic || 'Untitled meeting';
  $('#detail').classList.add('on');
  renderDetail(c);
}
function detailText(c, tab) {
  if (tab === 'recap') return c.recap || '';
  if (tab === 'notes') return c.notes.filter(n => n.kind !== 'system').map(n => `[${n.stamp}] ${KIND_LABEL[n.kind] || n.kind}: ${n.headline}${n.detail ? '\n' + n.detail : ''}${n.say ? `\n"${n.say}"` : ''}`).join('\n\n');
  if (tab === 'actions') return c.actions.map(a => `- ${a.owner}: ${a.item}${a.due ? ` (due ${a.due})` : ''}`).join('\n');
  return lineTexts(c).join('\n');
}
function renderDetail(c) {
  $$('#detailSeg button').forEach(b => b.classList.toggle('on', b.dataset.t === detailTab));
  const body = $('#detailBody');
  if (detailTab === 'recap') body.innerHTML = c.recap ? `<div class="md">${md(c.recap)}</div>` : '<div class="empty">No recap yet. Tap Write recap.</div>';
  else if (detailTab === 'notes') body.innerHTML = c.notes.length ? c.notes.slice().reverse().map(n => `<div class="note k-${n.kind}"><div class="meta"><span>${esc(KIND_LABEL[n.kind] || n.kind)}</span><span>${esc(n.stamp)}</span></div><h3>${esc(n.headline)}</h3>${n.detail ? `<p>${esc(n.detail)}</p>` : ''}${n.say ? `<div class="say">“${esc(n.say)}”</div>` : ''}</div>`).join('') : '<div class="empty">No notes.</div>';
  else if (detailTab === 'actions') body.innerHTML = actionsHTML(c.actions);
  else body.innerHTML = c.lines.length ? c.lines.map(l => l.mark ? `<div class="tline mark">— ${esc(l.text)} —</div>` : `<div class="tline"><b>${mmss(l.t)}</b>${esc(l.text)}</div>`).join('') : '<div class="empty">Nothing was transcribed.</div>';
  $('#detailRecap').textContent = c.recap ? 'Rewrite recap' : 'Write recap';
}

async function shareDetail() {
  const c = await DB.get(detailId); if (!c) return;
  const title = `${c.topic || 'Meeting'} ${new Date(c.started).toLocaleDateString()}`;
  const text = detailText(c, detailTab) || detailText(c, 'transcript');
  const file = new File([`${title}\n\n${text}`], `${title.replace(/[\\/:*?"<>|]/g, '-')} - ${detailTab}.txt`, { type: 'text/plain' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title });
    else if (navigator.share) await navigator.share({ title, text });
    else { await navigator.clipboard.writeText(text); toast('Copied.'); }
  } catch (e) { if (e.name !== 'AbortError') toast(`Couldn't share: ${e.message}`); }
}

// ------------------------------------------------------------------ UI plumbing
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), Math.min(7000, 2200 + msg.length * 35));
}
function showView(v) {
  $$('.view').forEach(s => s.classList.toggle('on', s.id === 'v-' + v));
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  $('main').scrollTop = 0;
  if (v === 'library') renderLibrary();
  if (v === 'transcript') { renderTranscript(); $('main').scrollTop = $('main').scrollHeight; }
  if (v === 'settings') refreshNotifState();
}
function openSheet() { $('#askSheet').classList.add('on'); $('#askInput').value = ''; setTimeout(() => $('#askInput').focus(), 50); }
function closeSheet() { $('#askSheet').classList.remove('on'); $('#askInput').blur(); }
function openPocket() { $('#pocket').classList.add('on'); }
function closePocket() { $('#pocket').classList.remove('on'); }

function refreshNotifState() {
  const el = $('#notifState');
  if (!('Notification' in window)) el.innerHTML = isIOS && !standalone() ? 'On iPhone, add CallPilot to your Home Screen (Share > Add to Home Screen) and open it from there to allow notifications.' : 'This browser does not support notifications.';
  else el.textContent = { granted: 'Notifications are allowed.', denied: 'Notifications are blocked. Turn them on in iPhone Settings > Notifications > CallPilot.', default: 'Not allowed yet.' }[Notification.permission];
}
function showGlassOpts() {
  const m = S.glasses.method;
  $('#g-app').hidden = m !== 'app'; $('#g-pushover').hidden = m !== 'pushover'; $('#g-ntfy').hidden = m !== 'ntfy'; $('#g-common').hidden = m === 'off';
}
function readyLine() {
  const bits = [];
  if (!S.claudeKey.trim()) bits.push('<span class="bad">Add your Claude key in Settings.</span>');
  const eng = S.stt === 'whisper' ? 'Whisper' : (BuiltinSTT.available() ? 'iPhone speech' : (S.openaiKey ? 'Whisper' : 'no speech engine'));
  bits.push(`Speech: ${eng}`);
  bits.push(`Glasses: ${{ off: 'off', app: 'this app', pushover: 'Pushover', ntfy: 'ntfy' }[S.glasses.method]}`);
  $('#readyLine').innerHTML = bits.join(' · ');
  const ib = $('#installBanner');
  if (isIOS && !standalone()) { ib.hidden = false; ib.textContent = 'For the best results, tap Share > Add to Home Screen, then open CallPilot from its icon. Set up your keys there; the Home Screen app keeps its own settings.'; }
  else ib.hidden = true;
}

const SET_MAP = { claudeKey: 's-claudeKey', model: 's-model', recapModel: 's-recapModel', stt: 's-stt', openaiKey: 's-openaiKey', whisperModel: 's-whisperModel', vocab: 's-vocab', name: 's-name', context: 's-context', interval: 's-interval', minWords: 's-minWords' };
const GLASS_MAP = { method: 's-gMethod', poUser: 's-poUser', poToken: 's-poToken', ntfyTopic: 's-ntfyTopic', style: 's-gStyle', split: 's-gSplit', gap: 's-gGap', repeat: 's-gRepeat', maxChars: 's-gMax', titleMax: 's-gTitleMax' };
function fillSettings() {
  for (const [k, id] of Object.entries(SET_MAP)) $('#' + id).value = S[k];
  for (const [k, id] of Object.entries(GLASS_MAP)) $('#' + id).value = S.glasses[k];
  $('#s-gSilent').checked = !!S.glasses.silent; $('#s-gAnswers').checked = !!S.glasses.answers; $('#s-gTight').checked = !!S.glasses.tight;
  showGlassOpts();
}
function bindSettings() {
  const map = { claudeKey: 's-claudeKey', model: 's-model', recapModel: 's-recapModel', stt: 's-stt', openaiKey: 's-openaiKey', whisperModel: 's-whisperModel', vocab: 's-vocab', name: 's-name', context: 's-context', interval: 's-interval', minWords: 's-minWords' };
  for (const [k, id] of Object.entries(map)) {
    const el = $('#' + id); el.value = S[k];
    el.addEventListener('change', () => { S[k] = el.type === 'number' ? Math.max(Number(el.min) || 0, Number(el.value) || DEFAULTS[k]) : el.value; saveSettings(); readyLine(); });
  }
  for (const [k, id] of Object.entries(GLASS_MAP)) {
    const el = $('#' + id); el.value = S.glasses[k];
    el.addEventListener('change', () => { S.glasses[k] = el.value.trim(); saveSettings(); showGlassOpts(); readyLine(); });
  }
  for (const [k, id] of [['silent', 's-gSilent'], ['answers', 's-gAnswers'], ['tight', 's-gTight']]) {
    const el = $('#' + id); el.checked = !!S.glasses[k];
    el.addEventListener('change', () => { S.glasses[k] = el.checked; saveSettings(); });
  }
  showGlassOpts();
  $('#ver').textContent = `CallPilot Mobile ${VERSION}`;
}

function newTopicName() {
  const a = new Uint8Array(9); crypto.getRandomValues(a);
  return 'callpilot-' + [...a].map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
}

async function importSettings(file) {
  try {
    const d = JSON.parse(await file.text());
    for (const k of ['name', 'context', 'vocab', 'model', 'recapModel', 'stt', 'whisperModel', 'interval', 'minWords']) if (d[k] !== undefined) S[k] = d[k];
    if (d.glasses && typeof d.glasses === 'object') for (const k of ['method', 'style', 'silent', 'answers', 'split', 'gap', 'repeat', 'tight', 'maxChars', 'titleMax']) if (d.glasses[k] !== undefined) S.glasses[k] = d.glasses[k];
    saveSettings(); fillSettings(); readyLine();
    toast('Settings imported. Add your API keys if you haven’t yet.');
  } catch (e) { toast(`That file couldn't be read: ${e.message}`); }
}
async function exportSettings() {
  const out = { name: S.name, context: S.context, vocab: S.vocab, model: S.model, recapModel: S.recapModel, stt: S.stt, whisperModel: S.whisperModel, interval: S.interval, minWords: S.minWords, glasses: { method: S.glasses.method, style: S.glasses.style, silent: S.glasses.silent, answers: S.glasses.answers, split: S.glasses.split, gap: S.glasses.gap, repeat: S.glasses.repeat, tight: S.glasses.tight, maxChars: S.glasses.maxChars, titleMax: S.glasses.titleMax } };
  const file = new File([JSON.stringify(out, null, 2)], 'CallPilot Mobile settings.json', { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file] });
    else { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click(); }
  } catch {}
}

async function checkInterrupted() {
  let calls = [];
  try { calls = await DB.all(); } catch { return; }
  const live = calls.filter(c => c.status === 'live');
  for (const c of live) { c.status = 'ended'; c.ended = c.ended || (c.lines.length ? c.started + c.lines[c.lines.length - 1].t * 1000 : c.started); await DB.put(c).catch(() => {}); }
  if (live.length) {
    const c = live[0];
    $('#resumeCard').innerHTML = `<div class="card"><strong>A meeting was cut off</strong><div class="hint">“${esc(c.topic || 'Untitled')}” stopped before it ended (the app was closed or the phone locked). Its transcript is saved.</div><div class="row" style="margin-top:10px"><button class="btn small primary" id="recoverBtn">Write its recap</button></div></div>`;
    $('#recoverBtn').onclick = async () => { $('#resumeCard').innerHTML = ''; setStatus('Writing recap', 'think'); await makeRecap(c); baseStatus(); openDetail(c.id); };
  }
}

// Size the app to the area iOS actually lets a web app draw in. (iOS 26 Home Screen apps leave a band at
// the bottom that pages can't draw into; the page background colour below makes it match the tab bar.)
function fitScreen() {
  const h = window.innerHeight;
  document.documentElement.style.setProperty('--app-h', h + 'px');
  // When iOS keeps its own band at the bottom, the home-indicator padding is already outside the page
  const tall = Math.max(screen.height, screen.width), short = Math.min(screen.height, screen.width);
  const full = window.matchMedia('(orientation: portrait)').matches ? tall : short;
  document.documentElement.classList.toggle('ios-band', isIOS && standalone() && full - h > 20);
}

function init() {
  fitScreen();
  window.addEventListener('resize', fitScreen);
  window.addEventListener('orientationchange', () => setTimeout(fitScreen, 300));
  // call types and the last setup
  $('#callType').innerHTML = Object.keys(CALL_TYPES).map(k => `<option>${esc(k)}</option>`).join('');
  const last = store.get('cp.lastSetup', null);
  if (last) { $('#callType').value = last.callType || 'General'; }
  $('#quickAsks').innerHTML = $('#askChips').innerHTML = QUICK_ASKS.map(q => `<button class="chip">${esc(q)}</button>`).join('');
  bindSettings(); readyLine();

  $$('#tabs button').forEach(b => b.addEventListener('click', () => showView(b.dataset.v)));
  $('#startBtn').onclick = startMeeting;
  $('#noteBtn').onclick = () => { toast('Thinking…'); runNotes(true); };
  $('#askBtn').onclick = openSheet;
  $('#askCancel').onclick = closeSheet;
  $('#askSend').onclick = () => ask($('#askInput').value);
  $('#askInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask($('#askInput').value); } });
  $('#askSheet').addEventListener('click', e => { if (e.target.id === 'askSheet') closeSheet(); });
  $('#quickAsks').addEventListener('click', e => { if (e.target.classList.contains('chip')) ask(e.target.textContent); });
  $('#askChips').addEventListener('click', e => { if (e.target.classList.contains('chip')) ask(e.target.textContent); });
  $('#markBtn').onclick = bookmark;
  $('#pauseBtn').onclick = togglePause;
  $('#pocketBtn').onclick = openPocket;
  $('#endBtn').onclick = () => { if (confirmEnd()) endMeeting(); };
  // pocket screen: one tap replays the last note on the glasses, two quick taps wake the screen
  let tapTimer = null;
  $('#pocket').addEventListener('click', () => {
    if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; closePocket(); return; }
    tapTimer = setTimeout(() => { tapTimer = null; replayLast(); }, 380);
  });
  $('#replayBtn').onclick = replayLast;

  $('#libSearch').addEventListener('input', renderLibrary);
  $('#library').addEventListener('click', e => { const b = e.target.closest('.lib-item'); if (b) openDetail(b.dataset.id); });
  $('#detailBack').onclick = () => { $('#detail').classList.remove('on'); renderLibrary(); };
  $('#detailSeg').addEventListener('click', async e => { const b = e.target.closest('button'); if (!b) return; detailTab = b.dataset.t; renderDetail(await DB.get(detailId)); });
  $('#detailShare').onclick = shareDetail;
  $('#detailCopy').onclick = async () => { const c = await DB.get(detailId); try { await navigator.clipboard.writeText(detailText(c, detailTab)); toast('Copied.'); } catch { toast("Couldn't copy."); } };
  $('#detailEmail').onclick = async () => {
    const c = await DB.get(detailId);
    const m = (c.recap || '').match(/##\s*Draft recap email\s*\n([\s\S]*?)(\n##\s|$)/i);
    const body = (m ? m[1] : c.recap || detailText(c, 'actions')).trim();
    location.href = `mailto:?subject=${encodeURIComponent('Recap: ' + (c.topic || 'meeting'))}&body=${encodeURIComponent(body)}`;
  };
  $('#detailRecap').onclick = async () => { const c = await DB.get(detailId); toast('Writing recap…'); await makeRecap(c); detailTab = 'recap'; renderDetail(await DB.get(detailId)); };
  $('#detailDelete').onclick = async () => { if (!window.confirm('Delete this meeting from this phone?')) return; await DB.del(detailId); $('#detail').classList.remove('on'); renderLibrary(); };

  $('#testClaude').onclick = async () => {
    $('#claudeResult').textContent = 'Testing…';
    try { const t = await claude({ model: S.model, max_tokens: 200, messages: [{ role: 'user', content: 'Reply with the word OK.' }] }); $('#claudeResult').innerHTML = `<span class="ok">Works.</span> Claude said: ${esc(t.slice(0, 40))}`; }
    catch (e) { $('#claudeResult').innerHTML = `<span class="bad">${esc(e.message)}</span>`; }
  };
  $('#enableNotif').onclick = async () => {
    if (!('Notification' in window)) { refreshNotifState(); return; }
    try { await Notification.requestPermission(); } catch {}
    refreshNotifState();
  };
  $('#ntfyNew').onclick = () => { S.glasses.ntfyTopic = newTopicName(); $('#s-ntfyTopic').value = S.glasses.ntfyTopic; saveSettings(); };
  $('#testGlasses').onclick = async () => {
    $('#glassesResult').textContent = 'Sending in 3 seconds… lock the phone or switch apps if you want to test that too.';
    await sleep(3000);
    try {
      await sendGlasses({ kind: 'question', headline: 'Ask who owns the 48-hour lead upload', say: 'Who’s on point for getting our show leads into Salesforce within two days?', detail: '' }, true);
      $('#glassesResult').innerHTML = '<span class="ok">Sent.</span> Did it show on your phone and glasses?';
    } catch (e) { $('#glassesResult').innerHTML = `<span class="bad">Not sent: ${esc(e.message)}</span>`; }
  };
  $('#measureGlasses').onclick = async () => {
    $('#glassesResult').textContent = 'Sending a ruler in 3 seconds…';
    await sleep(3000);
    try {
      // each number sits exactly at that character count: ".......10.......20" and so on
      let ruler = '';
      for (let p = 10; p <= 150; p += 10) ruler = ruler.padEnd(p - String(p).length, '.') + p;
      await deliver(ruler, ruler.slice(0, 120));
      $('#glassesResult').innerHTML = 'Sent. Each number marks that many characters. Enter the last number you can read fully on the <b>top</b> line as the title line, and on the <b>second</b> line as the body line.';
    } catch (e) { $('#glassesResult').innerHTML = `<span class="bad">Not sent: ${esc(e.message)}</span>`; }
  };
  $('#importBtn').onclick = () => $('#importFile').click();
  $('#importFile').addEventListener('change', e => { const f = e.target.files[0]; if (f) importSettings(f); e.target.value = ''; });
  $('#exportBtn').onclick = exportSettings;

  document.addEventListener('visibilitychange', () => {
    if (!C) return;
    if (document.hidden) { hiddenAt = nowSec(); return; }
    keepAwake(true);
    if (hiddenAt && nowSec() - hiddenAt > 3) {
      addMark(`App was in the background ${mmss(hiddenAt)} to ${mmss(nowSec())}, not listening`);
      pushSystem(`Wasn't listening from ${mmss(hiddenAt)} to ${mmss(nowSec())} because CallPilot left the screen. Keep it open, and use Pocket to dim it.`);
      restartSTT('the app came back');
    }
    hiddenAt = 0;
  });
  window.addEventListener('beforeunload', () => { if (C) DB.put(C); });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').then(r => { swReg = r; }).catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  checkInterrupted();
}

function confirmEnd() { return window.confirm('End the meeting and write the recap?'); }

// a small hook for automated tests (inject transcript lines without a microphone)
window.__cp = { chunkText, addLine: t => addLine(t), state: () => C, stt: () => stt, glassesParts, liveRules, replayLast, runNotes, ask, endMeeting, settings: () => S, glassesText };

init();
