const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { captureException } = require('../errorTracking');

const router = express.Router();
const SYSTEM_PROMPT = `You are Etriod, a capable general-purpose personal AI assistant. Help with reasoning, writing, coding, mathematics, learning, translation, planning, and everyday questions. Be clear, warm, practical, and appropriately concise. For complex requests, organize the answer into useful steps and give a brief rationale without revealing hidden chain-of-thought. Check arithmetic and code carefully. State uncertainty, assumptions, and knowledge limits; never invent sources or claim to have browsed the web. You cannot access external accounts or execute real-world actions in this app: never claim to send messages, make purchases, change calendars, or complete errands. You can prepare drafts, explain how to do something, and help the user plan the next action. Ask a focused clarifying question when a missing detail materially changes the result.`;
router.use(requireAuth);

function modelUrl() {
  return (process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
}

function modelName() {
  return process.env.OLLAMA_MODEL || 'qwen3:8b';
}

function modelOptions() {
  const configuredContext = Number.parseInt(process.env.OLLAMA_NUM_CTX || '16384', 10);
  const configuredOutput = Number.parseInt(process.env.OLLAMA_NUM_PREDICT || '2048', 10);
  return {
    num_ctx: Number.isFinite(configuredContext) ? Math.min(Math.max(configuredContext, 2048), 32768) : 16384,
    num_predict: Number.isFinite(configuredOutput) ? Math.min(Math.max(configuredOutput, 128), 8192) : 2048
  };
}

function thinkingOption() {
  if (process.env.OLLAMA_THINKING === 'true') return true;
  if (process.env.OLLAMA_THINKING === 'false') return false;
  return undefined;
}

function modelUnavailable() {
  return new Error('The private AI model is unavailable. Start the self-hosted Ollama service and confirm OLLAMA_BASE_URL and OLLAMA_MODEL.');
}

function titleFrom(text) {
  const clean = text.trim().replace(/\s+/g, ' ');
  return clean.length > 42 ? clean.slice(0, 42) + '…' : clean;
}

function historyQuery(conversationId) {
  return pool.query(
    `SELECT role, content FROM (
       SELECT role, content, created_at FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at DESC
       LIMIT 40
     ) recent ORDER BY created_at ASC`,
    [conversationId]
  );
}

async function generate(messages) {
  let response;
  try {
    response = await fetch(`${modelUrl()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(Number(process.env.OLLAMA_TIMEOUT_MS || 50000)),
      body: JSON.stringify({
        model: modelName(),
        messages,
        stream: false,
        ...(thinkingOption() === undefined ? {} : { think: thinkingOption() }),
        options: modelOptions()
      })
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error('The private AI model timed out. Try again or use a smaller local model.');
    }
    throw modelUnavailable();
  }
  if (!response.ok) {
    const details = await response.text().catch(() => '');
    console.error('[chat/model]', response.status, details.slice(0, 500));
    throw modelUnavailable();
  }
  const result = await response.json();
  if (typeof result.message?.content !== 'string' || !result.message.content.trim()) {
    throw new Error('The private AI model returned an empty response.');
  }
  return result.message.content;
}

router.post('/:conversationId/messages', async (req, res) => {
  const { conversationId } = req.params;
  const { content } = req.body || {};
  if (!content || !content.trim()) return res.status(400).json({ error: 'Message content is required.' });
  if (content.length > 8000) return res.status(400).json({ error: 'Message is too long (8,000 character limit).' });

  const convoCheck = await pool.query(
    'SELECT id FROM conversations WHERE id = $1 AND user_id = $2',
    [conversationId, req.user.id]
  );
  if (!convoCheck.rows.length) return res.status(404).json({ error: 'Conversation not found.' });

  try {
    await pool.query(
      `INSERT INTO messages (id, conversation_id, role, content) VALUES ($1, $2, 'user', $3)`,
      [crypto.randomUUID(), conversationId, content]
    );
    const history = await historyQuery(conversationId);
    const replyText = await generate([{ role: 'system', content: SYSTEM_PROMPT }, ...history.rows]);
    await pool.query(
      `INSERT INTO messages (id, conversation_id, role, content) VALUES ($1, $2, 'assistant', $3)`,
      [crypto.randomUUID(), conversationId, replyText]
    );
    const isFirstMessage = history.rows.length === 1;
    await pool.query(
      `UPDATE conversations SET last_active_at = now()${isFirstMessage ? ', title = $2' : ''} WHERE id = $1`,
      isFirstMessage ? [conversationId, titleFrom(content)] : [conversationId]
    );
    res.json({ reply: replyText });
  } catch (err) {
    captureException(err, { route: 'chat/message', conversationId });
    const status = /private AI model/.test(err.message) ? 503 : 502;
    res.status(status).json({ error: err.message || 'The private AI model could not complete this request.' });
  }
});

router.post('/:conversationId/stream', async (req, res) => {
  const { conversationId } = req.params;
  const { content } = req.body || {};
  if (!content || !content.trim()) return res.status(400).json({ error: 'Message content is required.' });
  if (content.length > 8000) return res.status(400).json({ error: 'Message is too long (8,000 character limit).' });

  const convoCheck = await pool.query(
    'SELECT id FROM conversations WHERE id = $1 AND user_id = $2',
    [conversationId, req.user.id]
  );
  if (!convoCheck.rows.length) return res.status(404).json({ error: 'Conversation not found.' });

  let history;
  try {
    await pool.query(
      `INSERT INTO messages (id, conversation_id, role, content) VALUES ($1, $2, 'user', $3)`,
      [crypto.randomUUID(), conversationId, content]
    );
    history = await historyQuery(conversationId);
    const isFirstMessage = history.rows.length === 1;
    await pool.query(
      `UPDATE conversations SET last_active_at = now()${isFirstMessage ? ', title = $2' : ''} WHERE id = $1`,
      isFirstMessage ? [conversationId, titleFrom(content)] : [conversationId]
    );
  } catch (err) {
    console.error('[chat/stream:setup]', err);
    return res.status(500).json({ error: 'Could not start the conversation.' });
  }

  let upstream;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.OLLAMA_TIMEOUT_MS || 50000));
  try {
    upstream = await fetch(`${modelUrl()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: modelName(),
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history.rows],
        stream: true,
        ...(thinkingOption() === undefined ? {} : { think: thinkingOption() }),
        options: modelOptions()
      })
    });
  } catch (err) {
    clearTimeout(timer);
    return res.status(503).json({ error: err.name === 'AbortError' ? 'The private AI model timed out.' : modelUnavailable().message });
  }
  if (!upstream.ok || !upstream.body) {
    clearTimeout(timer);
    const details = await upstream.text().catch(() => '');
    console.error('[chat/stream:model]', upstream.status, details.slice(0, 500));
    return res.status(503).json({ error: modelUnavailable().message });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const send = event => {
    if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  let fullText = '';
  let failed = false;
  let buffer = '';
  const decoder = new TextDecoder();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  try {
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.error) throw new Error(event.error);
        const delta = event.message?.content;
        if (typeof delta === 'string' && delta) {
          fullText += delta;
          send({ type: 'delta', text: delta });
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const event = JSON.parse(buffer);
      if (event.error) throw new Error(event.error);
      if (typeof event.message?.content === 'string') {
        fullText += event.message.content;
        send({ type: 'delta', text: event.message.content });
      }
    }
    if (!fullText.trim()) throw new Error('The private AI model returned an empty response.');
  } catch (err) {
    failed = true;
    captureException(err, { route: 'chat/stream', conversationId });
    send({ type: 'error', error: err.name === 'AbortError' ? 'The private AI model timed out.' : 'The private AI model could not complete this request.' });
  } finally {
    clearTimeout(timer);
  }

  if (!failed) {
    try {
      await pool.query(
        `INSERT INTO messages (id, conversation_id, role, content) VALUES ($1, $2, 'assistant', $3)`,
        [crypto.randomUUID(), conversationId, fullText]
      );
    } catch (err) {
      failed = true;
      captureException(err, { route: 'chat/stream:persist', conversationId });
      send({ type: 'error', error: 'The response was generated but could not be saved. Please check your connection before retrying.' });
    }
  }
  send({ type: 'done' });
  res.end();
});

module.exports = router;
