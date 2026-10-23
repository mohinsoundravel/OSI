/**
 * Minimal, dependency-free XML helpers for RSS and CAP 1.2 documents.
 *
 * Security model: this is not a general XML parser. It never resolves DTDs,
 * external entities or custom entity declarations, and it rejects any document
 * that declares a DOCTYPE or ENTITY outright. That removes XXE and
 * entity-expansion ("billion laughs") attacks by construction rather than by
 * configuration. Only the five predefined XML entities and numeric character
 * references are decoded.
 */

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export class UnsafeXmlError extends Error {}

export function assertSafeXml(xml) {
  if (typeof xml !== 'string') throw new UnsafeXmlError('XML input must be a string');
  if (xml.length > MAX_DOCUMENT_BYTES) throw new UnsafeXmlError(`XML document exceeds ${MAX_DOCUMENT_BYTES} bytes`);
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
    throw new UnsafeXmlError('XML documents declaring a DOCTYPE or ENTITY are rejected');
  }
}

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0x9 || code > 0x10ffff) return '';
      try {
        return String.fromCodePoint(code);
      } catch {
        return '';
      }
    }
    return Object.hasOwn(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : match;
  });
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches an element by local name, ignoring any namespace prefix (e.g. cap:polygon). */
function elementPattern(localName) {
  const name = `(?:[A-Za-z_][\\w.-]*:)?${escapeRegExp(localName)}`;
  return new RegExp(`<(${name})(?:\\s[^>]*)?>([\\s\\S]*?)</\\1\\s*>`, 'g');
}

/** Raw inner markup of every element with the given local name. */
export function rawElements(xml, localName) {
  const out = [];
  for (const m of xml.matchAll(elementPattern(localName))) out.push(m[2]);
  return out;
}

/** Text content: CDATA unwrapped, nested tags stripped, entities decoded, whitespace collapsed. */
export function textOf(raw) {
  if (raw == null) return '';
  const withoutCdata = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner) => inner.replace(/&/g, '&amp;').replace(/</g, '&lt;'));
  const stripped = withoutCdata.replace(/<[^>]*>/g, ' ');
  return decodeEntities(stripped).replace(/\s+/g, ' ').trim();
}

export function firstText(xml, localName) {
  const [raw] = rawElements(xml, localName);
  return raw === undefined ? '' : textOf(raw);
}

export function allText(xml, localName) {
  return rawElements(xml, localName).map(textOf).filter(Boolean);
}

/** Clamp untrusted strings before they are stored or sent anywhere. */
export function clampText(value, maxLength) {
  const s = String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  return s.length > maxLength ? `${s.slice(0, maxLength - 1)}…` : s;
}
