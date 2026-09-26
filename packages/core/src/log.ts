// Structured JSON logging with redaction (DESIGN §15.14). Emails, tokens, cookies, auth headers,
// full IPs and webhook bodies never reach the logs.

type Level = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const SENSITIVE_KEY =
  /(email|token|cookie|authorization|secret|password|passkey|signature|^ip$|ip_address|body|credential)/i;
const SAFE_KEY = /(_hash|_id$|^request_id$|^count$)/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

export function redact(value: unknown, key = "", depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (key && SENSITIVE_KEY.test(key) && !SAFE_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") {
    return value.replace(EMAIL, "[email]").replace(BEARER, "$1 [redacted]").replace(IPV4, "[ip]");
  }
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message, "", depth + 1) };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, "", depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k, depth + 1);
    return out;
  }
  return value;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export function createLogger(base: LogFields = {}): Logger {
  const write = (level: Level, msg: string, fields?: LogFields) => {
    const line = JSON.stringify({
      level,
      msg,
      time: new Date().toISOString(),
      ...(redact({ ...base, ...fields }) as LogFields),
    });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };
  return {
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
    child: (fields) => createLogger({ ...base, ...fields }),
  };
}
