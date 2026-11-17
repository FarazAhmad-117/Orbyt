const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * `{{name}}` / `{{ first_name | there }}` merge tags. Unknown or empty values use the fallback
 * after `|`, or "" — never the literal tag. Values are inserted as-is (callers escape for HTML).
 */
export function renderTemplate(
  template: string,
  vars: Record<string, unknown>,
): string {
  return template.replace(
    /\{\{\s*([a-zA-Z0-9_.]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g,
    (_m, key: string, fallback?: string) => {
      const value = vars[key];
      return value === undefined || value === null || value === ""
        ? (fallback ?? "")
        : String(value);
    },
  );
}

export function mergeVars(
  contact: {
    email: string;
    name: string | null;
    phone: string | null;
    customFields: Record<string, unknown>;
  },
  company?: string | null,
): Record<string, unknown> {
  const [first = "", ...rest] = (contact.name ?? "").trim().split(/\s+/);
  return {
    ...contact.customFields,
    email: contact.email,
    name: contact.name,
    first_name: first,
    last_name: rest.join(" "),
    phone: contact.phone,
    company,
  };
}

const URL_RE = /https?:\/\/[^\s<>"')]+/g;

/** Plain text -> minimal HTML: escapes, links URLs (optionally rewriting them), keeps line breaks. */
export function textToHtml(
  text: string,
  rewriteUrl?: (url: string) => string,
): string {
  const parts: string[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    parts.push(escapeHtml(text.slice(last, m.index)));
    const href = rewriteUrl ? rewriteUrl(m[0]) : m[0];
    parts.push(`<a href="${escapeHtml(href)}">${escapeHtml(m[0])}</a>`);
    last = m.index + m[0].length;
  }
  parts.push(escapeHtml(text.slice(last)));
  return parts.join("").replace(/\r?\n/g, "<br>\n");
}

export interface BuiltEmail {
  subject: string;
  text: string;
  html: string;
}

/**
 * Assembles the final email. The footer (postal address, wording) and unsubscribe link are always
 * appended — compliance is not optional (CAN-SPAM). Tracking is opt-in per sequence.
 */
export function buildEmail(input: {
  subject: string;
  body: string;
  footer: string | null;
  unsubscribeUrl: string;
  rewriteLink?: (url: string) => string;
  openPixelUrl?: string;
}): BuiltEmail {
  const footer = [input.footer?.trim(), `Unsubscribe: ${input.unsubscribeUrl}`]
    .filter(Boolean)
    .join("\n");
  const text = `${input.body}\n\n--\n${footer}`;
  const html =
    `<div>${textToHtml(input.body, input.rewriteLink)}</div>` +
    `<br><div style="color:#666;font-size:12px">-- <br>${textToHtml(footer)}</div>` +
    (input.openPixelUrl
      ? `<img src="${escapeHtml(input.openPixelUrl)}" width="1" height="1" alt="" style="display:none">`
      : "");
  return { subject: input.subject, text, html };
}
