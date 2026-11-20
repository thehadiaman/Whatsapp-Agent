/**
 * Just enough of OGG (RFC 3533) and Ogg Opus (RFC 7845) to read and rewrite
 * a voice note's comment header (OpusTags) and to measure its length.
 *
 * Why: in mock mode the simulator writes what the customer "said" into the
 * voice note's comments, and the mock speech-to-text reads it back from the
 * stored file. The audio pages are copied untouched.
 */

export class OggError extends Error {
  constructor(message: string) {
    super(`ogg: ${message}`);
    this.name = 'OggError';
  }
}

interface Page {
  headerType: number;
  granule: bigint;
  serial: number;
  sequence: number;
  /** Lacing values: each segment's length; a value under 255 ends a packet. */
  segments: number[];
  body: Uint8Array;
}

const CAPTURE = [0x4f, 0x67, 0x67, 0x53]; // "OggS"
const CONTINUED = 0x01;
const BOS = 0x02;

// CRC-32 with polynomial 0x04c11db7, no reflection, initial value 0 (RFC 3533 §6).
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let r = i << 24;
    for (let bit = 0; bit < 8; bit += 1) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes)
    crc = ((crc << 8) ^ (CRC_TABLE[((crc >>> 24) ^ byte) & 0xff] ?? 0)) >>> 0;
  return crc;
}

function parsePages(bytes: Uint8Array): Page[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pages: Page[] = [];
  let at = 0;
  while (at < bytes.length) {
    if (at + 27 > bytes.length) throw new OggError('truncated page header');
    if (CAPTURE.some((b, i) => bytes[at + i] !== b)) throw new OggError('missing OggS capture');
    if (bytes[at + 4] !== 0) throw new OggError('unsupported version');
    const count = bytes[at + 26] ?? 0;
    const segments = Array.from(bytes.subarray(at + 27, at + 27 + count));
    if (segments.length !== count) throw new OggError('truncated segment table');
    const headerLength = 27 + count;
    const bodyLength = segments.reduce((sum, n) => sum + n, 0);
    const end = at + headerLength + bodyLength;
    if (end > bytes.length) throw new OggError('truncated page body');

    const raw = bytes.slice(at, end);
    const stored = view.getUint32(at + 22, true);
    raw.fill(0, 22, 26);
    if (crc32(raw) !== stored) throw new OggError('page checksum mismatch');

    pages.push({
      headerType: bytes[at + 5] ?? 0,
      granule: view.getBigInt64(at + 6, true),
      serial: view.getUint32(at + 14, true),
      sequence: view.getUint32(at + 18, true),
      segments,
      body: bytes.subarray(at + headerLength, end),
    });
    at = end;
  }
  if (pages.length === 0) throw new OggError('empty file');
  return pages;
}

function writePage(page: Page): Uint8Array {
  const out = new Uint8Array(27 + page.segments.length + page.body.length);
  const view = new DataView(out.buffer);
  out.set(CAPTURE, 0);
  out[4] = 0;
  out[5] = page.headerType;
  view.setBigInt64(6, page.granule, true);
  view.setUint32(14, page.serial, true);
  view.setUint32(18, page.sequence, true);
  out[26] = page.segments.length;
  out.set(page.segments, 27);
  out.set(page.body, 27 + page.segments.length);
  view.setUint32(22, crc32(out), true);
  return out;
}

/** The first two packets (OpusHead, OpusTags) and the index of the first audio page. */
function headers(pages: Page[]): { head: Uint8Array; tags: Uint8Array; audioFrom: number } {
  const packets: Uint8Array[] = [];
  let current: number[] = [];
  for (let p = 0; p < pages.length; p += 1) {
    const page = pages[p];
    if (!page) break;
    let offset = 0;
    for (const length of page.segments) {
      current.push(...page.body.subarray(offset, offset + length));
      offset += length;
      if (length < 255) {
        packets.push(Uint8Array.from(current));
        current = [];
        if (packets.length === 2) {
          // RFC 7845 §3: audio data starts on a fresh page after the comment header.
          if (offset !== page.body.length) throw new OggError('audio shares a page with OpusTags');
          const [head, tags] = packets as [Uint8Array, Uint8Array];
          return { head, tags, audioFrom: p + 1 };
        }
      }
    }
  }
  throw new OggError('missing Opus headers');
}

const text = new TextDecoder('utf-8', { fatal: false });
const encode = (value: string) => new TextEncoder().encode(value);

function startsWith(bytes: Uint8Array, ascii: string): boolean {
  return ascii.split('').every((c, i) => bytes[i] === c.charCodeAt(0));
}

function parseTags(packet: Uint8Array): { vendor: string; comments: [string, string][] } {
  if (!startsWith(packet, 'OpusTags')) throw new OggError('second packet is not OpusTags');
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  let at = 8;
  const read = (): string => {
    if (at + 4 > packet.length) throw new OggError('truncated OpusTags');
    const length = view.getUint32(at, true);
    at += 4;
    if (at + length > packet.length) throw new OggError('truncated OpusTags');
    const value = text.decode(packet.subarray(at, at + length));
    at += length;
    return value;
  };
  const vendor = read();
  if (at + 4 > packet.length) throw new OggError('truncated OpusTags');
  const count = view.getUint32(at, true);
  at += 4;
  const comments: [string, string][] = [];
  for (let i = 0; i < count; i += 1) {
    const entry = read();
    const split = entry.indexOf('=');
    if (split > 0) comments.push([entry.slice(0, split).toUpperCase(), entry.slice(split + 1)]);
  }
  return { vendor, comments };
}

function buildTags(vendor: string, comments: [string, string][]): Uint8Array {
  const parts = [encode(vendor), ...comments.map(([k, v]) => encode(`${k}=${v}`))];
  const size = 8 + 4 + 4 + parts.reduce((sum, p) => sum + 4 + p.length, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(encode('OpusTags'), 0);
  let at = 8;
  const put = (part: Uint8Array) => {
    view.setUint32(at, part.length, true);
    out.set(part, at + 4);
    at += 4 + part.length;
  };
  const [vendorBytes, ...rest] = parts as [Uint8Array, ...Uint8Array[]];
  put(vendorBytes);
  view.setUint32(at, rest.length, true);
  at += 4;
  for (const part of rest) put(part);
  return out;
}

/** Splits one packet into pages of at most 255 segments (RFC 3533 lacing). */
function packetPages(packet: Uint8Array, serial: number, firstSequence: number): Page[] {
  const lacing: number[] = [];
  let left = packet.length;
  while (left >= 255) {
    lacing.push(255);
    left -= 255;
  }
  lacing.push(left);
  const pages: Page[] = [];
  let offset = 0;
  for (let i = 0; i < lacing.length; i += 255) {
    const segments = lacing.slice(i, i + 255);
    const length = segments.reduce((sum, n) => sum + n, 0);
    pages.push({
      headerType: i === 0 ? 0 : CONTINUED,
      // Header pages carry granule 0 (RFC 7845 §3).
      granule: 0n,
      serial,
      sequence: firstSequence + pages.length,
      segments,
      body: packet.subarray(offset, offset + length),
    });
    offset += length;
  }
  return pages;
}

export interface OggOpusInfo {
  /** Comment keys upper-cased, as RFC 7845 says they compare. */
  comments: Record<string, string>;
  durationMs: number;
}

/** Reads an Ogg Opus file's comments and length. Throws OggError if it is not one. */
export function readOggOpus(bytes: Uint8Array): OggOpusInfo {
  const pages = parsePages(bytes);
  const { head, tags } = headers(pages);
  if (!startsWith(head, 'OpusHead') || head.length < 19) throw new OggError('not an Opus stream');
  const preSkip = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint16(10, true);
  const last = pages.at(-1)?.granule ?? 0n;
  const samples = Number(last) - preSkip;
  return {
    comments: Object.fromEntries(parseTags(tags).comments),
    durationMs: Math.max(0, Math.round(samples / 48)),
  };
}

/**
 * Returns a copy with these comments set (replacing any with the same key).
 * Audio pages are copied byte for byte apart from their sequence number and
 * checksum, which change when the comment header grows by a page.
 */
export function withComments(bytes: Uint8Array, set: Record<string, string>): Uint8Array {
  const pages = parsePages(bytes);
  const { tags, audioFrom } = headers(pages);
  const first = pages[0];
  if (!first || (first.headerType & BOS) === 0) throw new OggError('first page is not BOS');
  const parsed = parseTags(tags);
  const keys = new Set(Object.keys(set).map((k) => k.toUpperCase()));
  for (const key of keys) {
    if (!/^[\x20-\x3C\x3E-\x7D]+$/.test(key)) throw new OggError(`invalid comment key ${key}`);
  }
  const comments: [string, string][] = [
    ...parsed.comments.filter(([k]) => !keys.has(k)),
    ...Object.entries(set).map(([k, v]): [string, string] => [k.toUpperCase(), v]),
  ];

  const tagPages = packetPages(buildTags(parsed.vendor, comments), first.serial, 1);
  const audio = pages.slice(audioFrom).map((page, i) => ({
    ...page,
    sequence: 1 + tagPages.length + i,
  }));
  const out = [first, ...tagPages, ...audio].map(writePage);
  const total = out.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(total);
  let at = 0;
  for (const page of out) {
    result.set(page, at);
    at += page.length;
  }
  return result;
}
