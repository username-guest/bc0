/**
 * A small, strict XML reader for PromoStandards SOAP responses (ADR 0017).
 *
 * Why not a library: we only need elements, attributes and text from well-formed SOAP, and the
 * input comes from third-party servers. This parser refuses DOCTYPE outright, so there are no
 * external entities, entity expansion or DTD tricks to worry about; only the five predefined
 * entities and numeric character references are decoded. Namespace prefixes are stripped: the
 * services use different prefixes across suppliers, and the local names are what the spec fixes.
 */

export interface XmlNode {
  /** Local name, prefix removed (`ns2:ProductId` → `ProductId`). */
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Concatenated text directly inside this element (not its descendants), trimmed. */
  text: string;
}

export class XmlError extends Error {}

const MAX_BYTES = 20 * 1024 * 1024; // a large catalog response is a few MB
const MAX_DEPTH = 64;

const localName = (qname: string) => {
  const i = qname.indexOf(':');
  return i === -1 ? qname : qname.slice(i + 1);
};

function decode(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (_, e: string) => {
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'amp') return '&';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    if (!Number.isFinite(code) || code > 0x10ffff) throw new XmlError('Invalid character reference');
    return String.fromCodePoint(code);
  });
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

export function parseXml(input: string): XmlNode {
  if (input.length > MAX_BYTES) throw new XmlError('Response too large');
  if (/<!DOCTYPE/i.test(input)) throw new XmlError('DOCTYPE is not allowed');
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];
  const texts: string[][] = [[]];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const lt = input.indexOf('<', i);
    if (lt === -1) {
      texts[texts.length - 1]!.push(input.slice(i));
      break;
    }
    if (lt > i) texts[texts.length - 1]!.push(input.slice(i, lt));
    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      if (end === -1) throw new XmlError('Unterminated comment');
      i = end + 3;
    } else if (input.startsWith('<![CDATA[', lt)) {
      const end = input.indexOf(']]>', lt + 9);
      if (end === -1) throw new XmlError('Unterminated CDATA');
      // CDATA is literal: push raw, marked so decode() skips it.
      texts[texts.length - 1]!.push('\u0000' + input.slice(lt + 9, end));
      i = end + 3;
    } else if (input.startsWith('<?', lt)) {
      const end = input.indexOf('?>', lt + 2);
      if (end === -1) throw new XmlError('Unterminated processing instruction');
      i = end + 2;
    } else if (input.startsWith('<!', lt)) {
      throw new XmlError('Declarations are not allowed');
    } else if (input[lt + 1] === '/') {
      const end = input.indexOf('>', lt);
      if (end === -1) throw new XmlError('Unterminated end tag');
      const name = localName(input.slice(lt + 2, end).trim());
      const node = stack.pop();
      const parts = texts.pop()!;
      if (!node || stack.length === 0 || node.name !== name) throw new XmlError(`Mismatched end tag </${name}>`);
      node.text = parts.map((p) => (p.startsWith('\u0000') ? p.slice(1) : decode(p))).join('').trim();
      i = end + 1;
    } else {
      // Start tag; find its end while respecting quoted attribute values.
      let j = lt + 1;
      let quote = '';
      for (; j < n; j++) {
        const c = input[j]!;
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
      }
      if (j >= n) throw new XmlError('Unterminated start tag');
      let body = input.slice(lt + 1, j);
      const selfClosing = body.endsWith('/');
      if (selfClosing) body = body.slice(0, -1);
      const m = /^([^\s/>]+)/.exec(body);
      if (!m) throw new XmlError('Malformed start tag');
      const attrs: Record<string, string> = {};
      for (const a of body.slice(m[1]!.length).matchAll(ATTR_RE)) {
        attrs[localName(a[1]!)] = decode(a[3] ?? a[4] ?? '');
      }
      const node: XmlNode = { name: localName(m[1]!), attrs, children: [], text: '' };
      stack[stack.length - 1]!.children.push(node);
      if (!selfClosing) {
        if (stack.length > MAX_DEPTH) throw new XmlError('Document nested too deeply');
        stack.push(node);
        texts.push([]);
      }
      i = j + 1;
    }
  }
  if (stack.length !== 1) throw new XmlError(`Unclosed element <${stack[stack.length - 1]!.name}>`);
  if (root.children.length !== 1) throw new XmlError('Expected a single root element');
  return root.children[0]!;
}

/* ---- Navigation helpers: all by local name ---- */

export const child = (n: XmlNode | undefined, name: string): XmlNode | undefined => n?.children.find((c) => c.name === name);
export const childrenNamed = (n: XmlNode | undefined, name: string): XmlNode[] => (n ? n.children.filter((c) => c.name === name) : []);
export const text = (n: XmlNode | undefined, name: string): string | undefined => {
  const c = child(n, name);
  return c && c.text !== '' ? c.text : undefined;
};
/** Depth-first search for the first element with this local name. */
export function find(n: XmlNode | undefined, name: string): XmlNode | undefined {
  if (!n) return undefined;
  if (n.name === name) return n;
  for (const c of n.children) {
    const r = find(c, name);
    if (r) return r;
  }
  return undefined;
}
/** Every element with this local name, anywhere below `n`. */
export function findAll(n: XmlNode | undefined, name: string, out: XmlNode[] = []): XmlNode[] {
  if (!n) return out;
  for (const c of n.children) {
    if (c.name === name) out.push(c);
    findAll(c, name, out);
  }
  return out;
}

/** Escape a value for inclusion in an XML request body. */
export function esc(v: string | number): string {
  return String(v).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}
