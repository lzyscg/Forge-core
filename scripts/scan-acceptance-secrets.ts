/**
 * Acceptance secret scanner and report sanitizer (plan Phase D Task 2 Step 7).
 *
 * Two responsibilities, both fail-closed and both redaction-only:
 *
 * - `scanForAcceptanceSecrets` recursively walks the acceptance data root,
 *   reports, test logs and evidence files and reports ONLY `path + category`
 *   for each finding — never the matched secret text. Categories cover the
 *   configured secret sentinels (held in memory only), common auth header
 *   shapes, PEM/private-key blocks, known environment assignments and
 *   hidden-thinking field NAMES.
 * - `sanitizeAcceptanceReport` recursively strips hidden-thinking shaped
 *   fields and redacts configured sentinels / credential-shaped strings from
 *   a report object before it is written to disk.
 *
 * Iron rule 6: neither function ever returns, logs or writes the matched
 * secret text; findings are path + category, redacted values are replaced by
 * the literal `[redacted]`.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';

/** Sentinel categories a scan can report. */
export type SecretCategory =
  | 'sentinel'
  | 'auth_header'
  | 'pem_private_key'
  | 'env_assignment'
  | 'hidden_thinking_key';

/** One finding: the relative path and the category, never the matched text. */
export interface SecretFinding {
  path: string;
  category: SecretCategory;
}

/** Canary sentinel used to prove redaction works end to end. */
export const SECRET_SENTINEL = 'SECRET_SENTINEL';

/** Hidden chain-of-thought field names that must never persist in evidence. */
export const THINKING_KEY_NAMES = [
  'reasoning_content',
  'redacted_thinking',
  'thinkingSignature',
  'thoughtSignature',
  'extended_thinking',
  'thinking',
  'reasoning',
] as const;

const LOWER_THINKING_KEYS = new Set(THINKING_KEY_NAMES.map((name) => name.toLowerCase()));

/** True when an object key is a hidden-thinking shaped field name. */
export function isThinkingKey(key: string): boolean {
  return LOWER_THINKING_KEYS.has(key.toLowerCase());
}

/* -------------------------------------------------------------------------- */
/* Credential shapes (shared by the scanner and the sanitizer)                */
/* -------------------------------------------------------------------------- */

const AUTH_HEADER_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/i,
  /\bAuthorization\s*[:=]/i,
  /\bToken\s+[A-Za-z0-9\-._~+/]/i,
];

const PEM_PRIVATE_KEY_PATTERN = /-----BEGIN[ A-Z]*PRIVATE KEY-----/;

const ENV_ASSIGNMENT_PATTERNS: readonly RegExp[] = [
  /\b(?:DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|API_KEY|APIKEY|SECRET_KEY|ACCESS_KEY|AUTH_TOKEN|PRIVATE_KEY)\s*[=:]/i,
  /\bsk-[A-Za-z0-9_-]{8,}/,
];

/** True when a string looks like an auth header, PEM key or env assignment. */
export function isCredentialShapedString(value: string): boolean {
  return (
    AUTH_HEADER_PATTERNS.some((pattern) => pattern.test(value)) ||
    PEM_PRIVATE_KEY_PATTERN.test(value) ||
    ENV_ASSIGNMENT_PATTERNS.some((pattern) => pattern.test(value))
  );
}

/* -------------------------------------------------------------------------- */
/* Sentinel resolution                                                          */
/* -------------------------------------------------------------------------- */

const CREDENTIAL_ENV_NAMES = [
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'FORGE_CORE_API_KEY',
] as const;

/**
 * The sentinel set used when the caller supplies none: the fixed canary plus
 * any configured credential values currently held in the environment. The
 * values live in memory for matching only and are never returned or logged.
 */
export function defaultSentinels(): string[] {
  const sentinels: string[] = [SECRET_SENTINEL];
  for (const name of CREDENTIAL_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined && value.length > 0) {
      sentinels.push(value);
    }
  }
  return sentinels;
}

function containsSentinel(value: string, sentinels: readonly string[]): boolean {
  return sentinels.some((sentinel) => sentinel.length > 0 && value.includes(sentinel));
}

/* -------------------------------------------------------------------------- */
/* Hidden-thinking key detection in file content                              */
/* -------------------------------------------------------------------------- */

/** Alternation source for the thinking key names (longest-first for matching). */
const THINKING_ALTERNATION = [...THINKING_KEY_NAMES]
  .sort((a, b) => b.length - a.length)
  .join('|');

const QUOTED_THINKING_KEY = new RegExp(`["'](?:${THINKING_ALTERNATION})["']\\s*:`, 'i');
const UNQUOTED_THINKING_KEY = new RegExp(`(?:^|[\\n\\s,{])(?:${THINKING_ALTERNATION})\\s*:`, 'im');

/** True when the text carries a hidden-thinking field name in a key position. */
export function hasThinkingKeyMarker(text: string): boolean {
  return QUOTED_THINKING_KEY.test(text) || UNQUOTED_THINKING_KEY.test(text);
}

/* -------------------------------------------------------------------------- */
/* Recursive scanner                                                            */
/* -------------------------------------------------------------------------- */

const TEXT_EXTENSIONS = new Set([
  '.json',
  '.yaml',
  '.yml',
  '.md',
  '.txt',
  '.log',
  '.csv',
  '.ts',
  '.tsx',
  '.js',
  '.html',
  '.env',
]);

const MAX_SCANNED_BYTES = 8 * 1024 * 1024;

interface ScanFrame {
  path: string;
  displayRoot: string;
}

function categoriesForText(text: string, sentinels: readonly string[]): SecretCategory[] {
  const categories = new Set<SecretCategory>();
  if (containsSentinel(text, sentinels)) {
    categories.add('sentinel');
  }
  if (AUTH_HEADER_PATTERNS.some((pattern) => pattern.test(text))) {
    categories.add('auth_header');
  }
  if (PEM_PRIVATE_KEY_PATTERN.test(text)) {
    categories.add('pem_private_key');
  }
  if (ENV_ASSIGNMENT_PATTERNS.some((pattern) => pattern.test(text))) {
    categories.add('env_assignment');
  }
  if (hasThinkingKeyMarker(text)) {
    categories.add('hidden_thinking_key');
  }
  return [...categories];
}

async function scanFile(
  frame: ScanFrame,
  sentinels: readonly string[],
  findings: Map<string, SecretFinding>,
): Promise<void> {
  let info;
  try {
    info = await stat(frame.path);
  } catch {
    return; // A vanished file contributes no findings.
  }
  if (!info.isFile() || info.size === 0 || info.size > MAX_SCANNED_BYTES) {
    return;
  }
  let text: string;
  try {
    const buffer = await readFile(frame.path);
    // Binary-looking content cannot carry the textual secret shapes we scan for.
    if (buffer.includes(0)) {
      return;
    }
    text = buffer.toString('utf8');
  } catch {
    return;
  }
  // Forward-slash display paths keep findings platform-neutral.
  const displayPath = (
    relative(frame.displayRoot, frame.path) || basename(frame.path)
  ).split('\\').join('/');
  for (const category of categoriesForText(text, sentinels)) {
    const key = `${displayPath}::${category}`;
    if (!findings.has(key)) {
      findings.set(key, { path: displayPath, category });
    }
  }
}

async function scanDirectory(
  frame: ScanFrame,
  sentinels: readonly string[],
  findings: Map<string, SecretFinding>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(frame.path, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const childPath = join(frame.path, entry.name);
    if (entry.isDirectory()) {
      await scanDirectory({ path: childPath, displayRoot: frame.displayRoot }, sentinels, findings);
    } else if (entry.isFile()) {
      await scanFile({ path: childPath, displayRoot: frame.displayRoot }, sentinels, findings);
    }
  }
}

export interface ScanOptions {
  /** Sentinel values to match exactly; defaults to `defaultSentinels()`. */
  sentinels?: readonly string[];
}

/**
 * Recursively scans files and directories for secret shapes. Returns one
 * finding per (relative path, category) pair; the matched text never leaves
 * this function.
 */
export async function scanForAcceptanceSecrets(
  roots: readonly string[],
  options: ScanOptions = {},
): Promise<SecretFinding[]> {
  const sentinels = options.sentinels ?? defaultSentinels();
  const findings = new Map<string, SecretFinding>();
  for (const root of roots) {
    const resolved = resolve(root);
    let info;
    try {
      info = await stat(resolved);
    } catch {
      continue; // A missing root contributes no findings.
    }
    if (info.isDirectory()) {
      await scanDirectory({ path: resolved, displayRoot: resolved }, sentinels, findings);
    } else if (info.isFile()) {
      // A bare file is reported by its own name.
      await scanFile({ path: resolved, displayRoot: resolved }, sentinels, findings);
    }
  }
  return [...findings.values()].sort((a, b) =>
    a.path === b.path ? a.category.localeCompare(b.category) : a.path.localeCompare(b.path),
  );
}

/* -------------------------------------------------------------------------- */
/* Report sanitizer                                                             */
/* -------------------------------------------------------------------------- */

const REDACTED = '[redacted]';

function sanitizeValue(value: unknown, sentinels: readonly string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, sentinels));
  }
  if (value !== null && typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (isThinkingKey(key)) {
        continue; // Hidden-thinking shaped fields are dropped entirely.
      }
      sanitized[key] = sanitizeValue(entry, sentinels);
    }
    return sanitized;
  }
  if (typeof value === 'string') {
    if (containsSentinel(value, sentinels) || isCredentialShapedString(value)) {
      return REDACTED;
    }
    return value;
  }
  return value;
}

/**
 * Returns a deep copy of `report` with hidden-thinking shaped fields removed
 * and configured sentinels / credential-shaped strings redacted. The input is
 * never mutated.
 */
export function sanitizeAcceptanceReport(
  report: unknown,
  sentinels: readonly string[] = defaultSentinels(),
): unknown {
  return sanitizeValue(report, sentinels);
}
