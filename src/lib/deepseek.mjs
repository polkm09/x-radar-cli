import { request } from 'node:https';

export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash';
export const DEFAULT_DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

export async function callDeepSeek({ system, user, model = DEFAULT_DEEPSEEK_MODEL, url = DEFAULT_DEEPSEEK_URL, timeout = 120, reasoningEffort = 'medium' }) {
  const apiKey = getDeepSeekApiKey();
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not set');
  const payload = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    thinking: { type: 'enabled' },
    reasoning_effort: reasoningEffort,
    stream: false,
  };
  const raw = await postJson(url, payload, apiKey, timeout);
  const data = JSON.parse(raw);
  const content = data?.choices?.[0]?.message?.content || '';
  if (!content.trim()) throw new Error(`DeepSeek returned empty content: ${raw.slice(0, 500)}`);
  return { content: normalizeDeepSeekContent(content), raw: data };
}

export function hasDeepSeekAuth() {
  return Boolean(getDeepSeekApiKey());
}

export function getDeepSeekApiKey() {
  return String(process.env.DEEPSEEK_API_KEY || '').trim();
}

export function parseJsonText(text) {
  const value = String(text || '').trim();
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) return JSON.parse(fenced);
    const object = value.match(/\{[\s\S]*\}/)?.[0];
    if (object) return JSON.parse(object);
    throw new Error('DeepSeek output is not valid JSON');
  }
}

function normalizeDeepSeekContent(value) {
  return String(value || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
}

function postJson(urlString, payload, apiKey, timeoutSeconds) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const url = new URL(urlString);
    const body = Buffer.from(JSON.stringify(payload));
    const hardTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy(new Error(`DeepSeek API hard timed out after ${timeoutSeconds}s`));
      reject(new Error(`DeepSeek API hard timed out after ${timeoutSeconds}s`));
    }, timeoutSeconds * 1000);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      fn(value);
    };
    const req = request({
      protocol: url.protocol,
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      timeout: timeoutSeconds * 1000,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Content-Length': body.length,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          finish(reject, new Error(`DeepSeek API HTTP ${res.statusCode}: ${raw.slice(0, 1000)}`));
          return;
        }
        finish(resolve, raw);
      });
    });
    req.on('error', (error) => finish(reject, error));
    req.on('timeout', () => {
      req.destroy(new Error(`DeepSeek API request timed out after ${timeoutSeconds}s`));
    });
    req.write(body);
    req.end();
  });
}
