/**
 * Structured logger for a stdio MCP server.
 *
 * CRITICAL: on stdio transport, stdout carries the JSON-RPC protocol. Writing anything
 * else there corrupts the stream and breaks the client connection, so every log line goes
 * to stderr — which MCP clients surface as server logs.
 *
 * Output is one JSON object per line (easy for clients and CI to parse), or human-readable
 * text when RADAR_LOG_FORMAT=text.
 */

export const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

/** Keys whose values are replaced with "[redacted]" before serialization. */
const SENSITIVE_KEY =
  /^(.*(authorization|cookie|api[-_]?key|secret|token|password|passwd|credential|session|client[-_]?id).*)$/i;

/** Query params that commonly carry credentials inside URLs. */
const SENSITIVE_PARAM =
  /^(access_token|api_key|apikey|key|token|password|secret|signature|sig|auth)$/i;

const envLevel = () => {
  const raw = String(process.env.RADAR_LOG_LEVEL ?? 'info').toLowerCase();
  return raw in LEVELS ? raw : 'info';
};

const envFormat = () =>
  String(process.env.RADAR_LOG_FORMAT ?? 'json').toLowerCase() === 'text' ? 'text' : 'json';

/**
 * Strip credentials from a URL so logging one can never leak them: userinfo
 * (https://user:pw@host) is dropped and sensitive query params are masked.
 */
export function sanitizeUrl(value) {
  try {
    const u = new URL(String(value));
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
    }
    for (const k of [...u.searchParams.keys()]) {
      if (SENSITIVE_PARAM.test(k)) u.searchParams.set(k, '[redacted]');
    }
    return u.href;
  } catch {
    return String(value);
  }
}

/** Recursively redact sensitive keys and sanitize anything URL-shaped. */
export function redact(value, depth = 0) {
  if (depth > 6 || value == null) return value;
  if (typeof value === 'string') {
    return /^https?:\/\//i.test(value) ? sanitizeUrl(value) : value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

function emit(level, message, fields = {}) {
  if (LEVELS[level] > LEVELS[envLevel()]) return;

  const safe = redact(fields);
  if (envFormat() === 'text') {
    const tail = Object.keys(safe).length ? ` ${JSON.stringify(safe)}` : '';
    process.stderr.write(`[radar] ${level.toUpperCase()} ${message}${tail}\n`);
    return;
  }
  process.stderr.write(
    `${JSON.stringify({
      // Timestamp is intentionally the only nondeterministic field; tests set level=silent.
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...safe,
    })}\n`,
  );
}

export const log = {
  error: (msg, fields) => emit('error', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  debug: (msg, fields) => emit('debug', msg, fields),
  level: envLevel,
};
