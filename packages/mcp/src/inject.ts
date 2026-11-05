// Prompt-injection scan for the text that asked for a payment (an invoice, email, web page,
// tool output). Deterministic and explainable: no model, just known tricks. It can only make
// things stricter: a hit turns check_address into warn/block and makes agentguard_pay ask the
// vault to hold the payment for the owner (force_review). A clean scan proves nothing; the
// vault's on-chain rules are still the real guard.

export type Severity = "none" | "suspicious" | "hostile";

export interface Signal {
  kind: string;
  severity: Exclude<Severity, "none">;
  /** What was found. Quoted text is short and shown as evidence, never as an instruction. */
  detail: string;
}

export interface ScanResult {
  severity: Severity;
  signals: Signal[];
  /** Text hidden in invisible Unicode "tag" characters, decoded so a human can see it. */
  hidden_text?: string;
}

export const MAX_SCAN_CHARS = 20_000;

// Zero-width and joiner characters, bidi overrides/isolates, BOM, word joiners.
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿­]/gu;
// Unicode tag characters (U+E0000–U+E007F): invisible copies of ASCII, used to smuggle text.
const TAGS = /[\u{E0000}-\u{E007F}]/gu;

const HOSTILE: [string, RegExp][] = [
  ["instruction_override", /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|your|system|original)\b[^.\n]{0,20}\b(instructions?|rules?|prompts?|guidelines|directives?|polic(y|ies))\b/],
  ["instruction_override", /\b(new|updated|real|actual)\s+(system\s+)?instructions?\s*:/],
  ["instruction_override", /\byou are now\b|\bdeveloper mode\b|\bjailbreak/],
  ["approval_evasion", /\b(do not|don't|dont|never|without)\s+(tell(ing)?|ask(ing)?|notify(ing)?|inform(ing)?|alert(ing)?|confirm(ing)?|check(ing)? with)\s+(the\s+|your\s+)?(user|owner|human|operator|anyone|admin)/],
  ["approval_evasion", /\bwithout\s+(asking|approval|confirmation|review|permission)\b/],
  ["approval_evasion", /\b(bypass|skip|disable|circumvent|get around|turn off|ignore)\s+(the\s+|your\s+|any\s+|all\s+)?(spending\s+)?(limits?|approvals?|allowlist|checks?|rules|polic(y|ies)|firewall|agentguard|vault|review|guard ?rails?)\b/],
  ["fake_role", /<\/?\s*(system|assistant|developer|admin)\s*>|\[\s*(system|admin|developer)\s*\]|<\|im_(start|end)\|>|^\s*#{1,6}\s*(system|instructions?)\b|^\s*(system|assistant)\s*:/m],
];

const SUSPICIOUS: [string, RegExp][] = [
  ["addressed_to_ai", /\b(if you are|you are|attention|note to|dear)\s+(an?\s+|the\s+)?(ai|a\.i\.|llm|language model|assistant|agent|chatbot|bot)\b/],
  ["addressed_to_ai", /\b(ai|llm|assistant|agent|bot)s?\s*[,:]\s*(please\s+)?(pay|send|transfer|approve)\b/],
  ["hidden_markup", /<!--|display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(px|pt|em)?\b|opacity\s*:\s*0(\.0+)?\s*[;"']|color\s*:\s*(white|#fff\b|#ffffff\b)/],
  ["payment_redirect", /\b(new|updated|changed|different)\s+(payment\s+|bank\s+|wallet\s+|receiving\s+)?(address|account|wallet|details)\b|\b(pay|send)\b[^.\n]{0,40}\binstead\b/],
];

const ACCOUNT = /\b[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.(?:near|testnet)\b/g;
const BLOB = /[A-Za-z0-9+/]{120,}={0,2}/;

const quote = (s: string) => `"${s.replace(/\s+/g, " ").trim().slice(0, 60)}"`;

/**
 * Scan text for prompt-injection tricks. `recipient` is the account being paid: other NEAR
 * accounts named in the text are reported, since swapping the recipient is the usual goal.
 * `self` lists accounts that may appear without counting (e.g. the paying vault itself).
 */
export function scanText(text: string, opts: { recipient?: string; self?: string[] } = {}): ScanResult {
  const signals: Signal[] = [];
  const raw = text.slice(0, MAX_SCAN_CHARS);
  if (text.length > MAX_SCAN_CHARS) signals.push({ kind: "too_long", severity: "suspicious", detail: `only the first ${MAX_SCAN_CHARS} characters were scanned` });

  let hidden_text: string | undefined;
  const tags = raw.match(TAGS) ?? [];
  if (tags.length) {
    hidden_text = tags
      .map((c) => String.fromCodePoint(c.codePointAt(0)! - 0xe0000))
      .join("")
      .replace(/[^\x20-\x7e]/g, "")
      .slice(0, 200);
    signals.push({ kind: "hidden_characters", severity: "hostile", detail: `${tags.length} invisible Unicode tag characters carrying hidden text (decoded in hidden_text)` });
  }
  const invisible = raw.match(INVISIBLE) ?? [];
  if (invisible.length) {
    const codes = [...new Set(invisible.map((c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`))].slice(0, 5);
    signals.push({ kind: "hidden_characters", severity: "hostile", detail: `${invisible.length} invisible or direction-changing characters (${codes.join(", ")})` });
  }

  // Match on a normalized copy: compatibility forms folded, invisible characters removed (they are
  // used to split words like "ign​ore"), hidden tag text appended, lower case.
  const norm = (raw.normalize("NFKC").replace(INVISIBLE, "").replace(TAGS, "") + (hidden_text ? `\n${hidden_text}` : "")).toLowerCase();

  const seen = new Set<string>();
  for (const [kind, re] of HOSTILE) {
    const m = norm.match(re);
    if (m && !seen.has(kind)) {
      seen.add(kind);
      signals.push({ kind, severity: "hostile", detail: `text says ${quote(m[0])}` });
    }
  }
  for (const [kind, re] of SUSPICIOUS) {
    const m = norm.match(re);
    if (m && !seen.has(kind)) {
      seen.add(kind);
      signals.push({ kind, severity: "suspicious", detail: `text says ${quote(m[0])}` });
    }
  }

  if (BLOB.test(raw)) signals.push({ kind: "encoded_blob", severity: "suspicious", detail: "a long base64-like block (could hide instructions)" });

  const recipient = opts.recipient?.toLowerCase();
  if (recipient) {
    const ok = new Set([recipient, ...(opts.self ?? []).map((a) => a.toLowerCase())]);
    const others = [...new Set(norm.match(ACCOUNT) ?? [])].filter((a) => !ok.has(a));
    if (others.length)
      signals.push({ kind: "other_accounts", severity: "suspicious", detail: `text also names ${others.slice(0, 5).join(", ")}, not just ${recipient}` });
  }

  const severity: Severity = signals.some((s) => s.severity === "hostile") ? "hostile" : signals.length ? "suspicious" : "none";
  return hidden_text ? { severity, signals, hidden_text } : { severity, signals };
}
