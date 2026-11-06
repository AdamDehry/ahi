/**
 * Fetch one picture from the public internet, for the search card's image
 * proxy and for "Attach" (saving a result into the chat files).
 *
 * Why a proxy at all: the app's CSP is `img-src 'self' data: blob:`, and the
 * picture URLs come from strangers' pages. The gateway fetches them instead,
 * which also keeps the owner's address off those servers.
 *
 * Why this is careful: a proxy is a request-forgery vector. The routes only
 * ever hand it URLs that are stored on one of the user's own search cards
 * (never a URL from the query string), and this file then refuses anything
 * that is not plain http(s) on 80/443 to a PUBLIC address. The address check
 * runs inside the socket's own DNS lookup, so the address it checks is the
 * address it connects to (no rebinding between check and connect), and it
 * runs again on every redirect hop.
 */
import { lookup as dnsLookup, type LookupAddress } from "dns";
import { request as httpRequest, type IncomingMessage } from "http";
import { request as httpsRequest } from "https";
import { BlockList, isIP } from "net";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const USER_AGENT = "Mozilla/5.0 (compatible; AHI-Gateway/1.0; +inline-search)";

// Two lists: Node's BlockList also matches an IPv4 address against IPv6
// rules (as ::ffff:a.b.c.d), so one list with a v4-mapped rule would refuse
// every IPv4 address on the internet.
const blocked4 = new BlockList();
const blocked6 = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) blocked4.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64 well-known: embeds an IPv4 — blocked whole rather than re-checked
  ["64:ff9b:1::", 48], // NAT64 local-use
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10], // site-local (deprecated, still routable inside some networks)
  ["2002::", 16], // 6to4: embeds an IPv4 address we would not otherwise check
  ["2001::", 32], // Teredo: same
  ["ff00::", 8],
] as const) blocked6.addSubnet(net, bits, "ipv6");

/** "::ffff:7f00:1" / "::ffff:127.0.0.1" → "127.0.0.1"; else null. */
function v4Mapped(addr: string): string | null {
  const dotted = /^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (dotted) return dotted[1];
  const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(addr);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function isPublicAddress(addr: string): boolean {
  const fam = isIP(addr);
  if (fam === 4) return !blocked4.check(addr, "ipv4");
  if (fam === 6) {
    const mapped = v4Mapped(addr);
    if (mapped) return isIP(mapped) === 4 && !blocked4.check(mapped, "ipv4");
    return !blocked6.check(addr, "ipv6");
  }
  return false;
}

export class FetchRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchRefused";
  }
}

/** URL gate before any socket: scheme, port, no credentials, no bare IP that is private. */
export function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchRefused("not a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new FetchRefused("only http(s)");
  if (url.username || url.password) throw new FetchRefused("credentials in URL");
  if (url.port && url.port !== "80" && url.port !== "443") throw new FetchRefused("non-standard port");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isPublicAddress(host)) throw new FetchRefused("private address");
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) throw new FetchRefused("local host name");
  return url;
}

/** DNS lookup that refuses to hand the socket a non-public address. */
function guardedLookup(
  hostname: string,
  options: object,
  cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  dnsLookup(hostname, { ...(options as object), all: true }, (err, addresses) => {
    if (err) return cb(err, "", 0);
    const list = (addresses as LookupAddress[]).filter((a) => isPublicAddress(a.address));
    if (!list.length) return cb(Object.assign(new Error("refused: private address"), { code: "EREFUSED" }), "", 0);
    if ((options as { all?: boolean }).all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

export interface FetchedImage {
  bytes: Buffer;
  mime: string;
  /** Final URL after redirects (for the saved file's name). */
  url: string;
}

const ALLOWED_IMAGE = /^image\/(jpeg|png|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)$/;

function getOnce(url: URL, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolveP, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "GET",
        lookup: guardedLookup as never,
        headers: { "user-agent": USER_AGENT, accept: "image/avif,image/webp,image/*;q=0.8" },
        signal,
      },
      resolveP,
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * GET a picture: public addresses only, ≤3 redirects (each re-checked),
 * image/* only (no SVG — it can carry script), ≤8 MB, one deadline for all.
 */
export async function fetchPublicImage(raw: string, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<FetchedImage> {
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
  const max = opts.maxBytes ?? MAX_IMAGE_BYTES;
  let url = checkUrl(raw);
  for (let hop = 0; ; hop++) {
    const res = await getOnce(url, signal);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.destroy();
      if (hop >= MAX_REDIRECTS) throw new FetchRefused("too many redirects");
      url = checkUrl(new URL(res.headers.location, url).toString());
      continue;
    }
    if (status !== 200) {
      res.destroy();
      throw new FetchRefused(`upstream ${status}`);
    }
    const mime = String(res.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (!ALLOWED_IMAGE.test(mime)) {
      res.destroy();
      throw new FetchRefused(`not a picture (${mime || "no type"})`);
    }
    const declared = Number(res.headers["content-length"]);
    if (Number.isFinite(declared) && declared > max) {
      res.destroy();
      throw new FetchRefused("picture too large");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res) {
      total += (chunk as Buffer).length;
      if (total > max) {
        res.destroy();
        throw new FetchRefused("picture too large");
      }
      chunks.push(chunk as Buffer);
    }
    return { bytes: Buffer.concat(chunks), mime, url: url.toString() };
  }
}
