import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_COVER_BYTES = 8 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_MAX_CACHE_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_CACHE_ENTRIES = 2_000;
const ACCENT_PATTERN = /^rgb\(\d{1,3} \d{1,3} \d{1,3}\)$/u;

interface CacheManifest {
  readonly contentType: string;
  readonly byteLength: number;
  readonly accent?: string;
}

export interface CachedCover {
  readonly key: string;
  readonly path: string;
  readonly contentType: string;
  readonly accent?: string;
}

export interface CoverCacheDependencies {
  readonly fetcher: (url: string, init: RequestInit) => Promise<Response>;
  readonly accentFromImage: (bytes: Uint8Array) => string | undefined;
}

export interface CoverCacheOptions {
  readonly downloadTimeoutMs?: number;
  readonly maxConcurrency?: number;
  readonly maxCacheBytes?: number;
  readonly maxCacheEntries?: number;
}

interface CoverJob {
  readonly key: string;
  readonly sourceUrl: string;
  readonly controller: AbortController;
  readonly requestIds: Set<string>;
  readonly promise: Promise<CachedCover>;
  readonly resolve: (cover: CachedCover) => void;
  readonly reject: (error: unknown) => void;
  persistent: boolean;
}

/** Remote cover URLs are untrusted persisted input. Network resolution is
 * separately pinned to a validated public address by the privileged fetcher. */
export function normalizeTrustedCoverUrl(value: string): string {
  if (typeof value !== "string" || value.length > 2_048) throw new Error("Cover URL is invalid");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("Cover URL must use standard HTTPS without credentials");
  }
  url.hash = "";
  return url.toString();
}

function imageContentType(bytes: Uint8Array, header: string | null): string {
  const contentType = header?.split(";", 1)[0]?.trim().toLowerCase();
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  const webp = bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  if (jpeg && contentType === "image/jpeg") return contentType;
  if (png && contentType === "image/png") return contentType;
  if (webp && contentType === "image/webp") return contentType;
  throw new Error("Cover response is not a supported image");
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort)).catch(() => undefined);
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Cover download was cancelled");
}

async function readBounded(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const statedLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(statedLength) && statedLength > MAX_COVER_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Cover image is too large");
  }
  if (!response.body) throw new Error("Cover response is empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      length += value.byteLength;
      if (length > MAX_COVER_BYTES) throw new Error("Cover image is too large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (length === 0) throw new Error("Cover response is empty");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function download(sourceUrl: string, fetcher: CoverCacheDependencies["fetcher"], signal: AbortSignal): Promise<{ bytes: Uint8Array; contentType: string }> {
  let url = normalizeTrustedCoverUrl(sourceUrl);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await abortable(fetcher(url, {
      redirect: "manual",
      credentials: "omit",
      signal,
      headers: { Accept: "image/avif,image/webp,image/png,image/jpeg" },
    }), signal);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location || redirect === MAX_REDIRECTS) throw new Error("Cover redirect is invalid");
      url = normalizeTrustedCoverUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Cover could not be downloaded");
    }
    const bytes = await readBounded(response, signal);
    return { bytes, contentType: imageContentType(bytes, response.headers.get("content-type")) };
  }
  throw new Error("Cover redirect is invalid");
}

export class CoverCache {
  readonly #directory: string;
  readonly #dependencies: CoverCacheDependencies;
  readonly #jobs = new Map<string, CoverJob>();
  readonly #requestKeys = new Map<string, string>();
  readonly #queue: CoverJob[] = [];
  readonly #options: Required<CoverCacheOptions>;
  #active = 0;

  constructor(cacheDirectory: string, dependencies: CoverCacheDependencies, options: CoverCacheOptions = {}) {
    this.#directory = join(cacheDirectory, "covers", "v1");
    this.#dependencies = dependencies;
    this.#options = {
      downloadTimeoutMs: positiveInteger(options.downloadTimeoutMs, DEFAULT_DOWNLOAD_TIMEOUT_MS),
      maxConcurrency: positiveInteger(options.maxConcurrency, DEFAULT_MAX_CONCURRENCY),
      maxCacheBytes: positiveInteger(options.maxCacheBytes, DEFAULT_MAX_CACHE_BYTES),
      maxCacheEntries: positiveInteger(options.maxCacheEntries, DEFAULT_MAX_CACHE_ENTRIES),
    };
    this.#prune();
  }

  resolve(sourceUrl: string, requestId?: string): Promise<CachedCover> {
    if (requestId !== undefined && !isUuid(requestId)) throw new Error("Cover request ID is invalid");
    const normalized = normalizeTrustedCoverUrl(sourceUrl);
    const key = createHash("sha256").update(normalized).digest("hex");
    const cached = this.read(key);
    if (cached) return Promise.resolve(cached);
    const active = this.#jobs.get(key);
    if (active) {
      this.#subscribe(active, requestId);
      return active.promise;
    }
    rmSync(join(this.#directory, `${key}.image`), { force: true });
    rmSync(join(this.#directory, `${key}.json`), { force: true });
    let resolve!: (cover: CachedCover) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<CachedCover>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
    const job: CoverJob = {
      key,
      sourceUrl: normalized,
      controller: new AbortController(),
      requestIds: new Set(),
      promise,
      resolve,
      reject,
      persistent: false,
    };
    this.#subscribe(job, requestId);
    this.#jobs.set(key, job);
    this.#queue.push(job);
    this.#drain();
    return promise;
  }

  cancel(requestId: string): void {
    if (!isUuid(requestId)) throw new Error("Cover request ID is invalid");
    const key = this.#requestKeys.get(requestId);
    if (!key) return;
    this.#requestKeys.delete(requestId);
    const job = this.#jobs.get(key);
    job?.requestIds.delete(requestId);
    if (job && !job.persistent && job.requestIds.size === 0) {
      job.controller.abort(new Error("Cover download was cancelled"));
      this.#drain();
    }
  }

  close(): void {
    for (const job of this.#jobs.values()) job.controller.abort(new Error("Cover cache closed"));
  }

  read(key: string): CachedCover | undefined {
    if (!/^[0-9a-f]{64}$/u.test(key)) return undefined;
    const imagePath = join(this.#directory, `${key}.image`);
    const manifestPath = join(this.#directory, `${key}.json`);
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Partial<CacheManifest>;
      const size = statSync(imagePath).size;
      if (typeof manifest.contentType !== "string" || !["image/jpeg", "image/png", "image/webp"].includes(manifest.contentType) ||
          manifest.byteLength !== size || size < 1 || size > MAX_COVER_BYTES ||
          (manifest.accent !== undefined && (typeof manifest.accent !== "string" || !ACCENT_PATTERN.test(manifest.accent)))) return undefined;
      const now = new Date();
      utimesSync(imagePath, now, now);
      return { key, path: imagePath, contentType: manifest.contentType, ...(manifest.accent ? { accent: manifest.accent } : {}) };
    } catch {
      return undefined;
    }
  }

  #subscribe(job: CoverJob, requestId: string | undefined): void {
    if (requestId === undefined) {
      job.persistent = true;
      return;
    }
    const previous = this.#requestKeys.get(requestId);
    if (previous && previous !== job.key) throw new Error("Cover request ID is already in use");
    job.requestIds.add(requestId);
    this.#requestKeys.set(requestId, job.key);
  }

  #drain(): void {
    while (this.#active < this.#options.maxConcurrency && this.#queue.length > 0) {
      const job = this.#queue.shift();
      if (!job) return;
      if (job.controller.signal.aborted) {
        job.reject(abortReason(job.controller.signal));
        this.#finish(job);
        continue;
      }
      this.#active += 1;
      const timeout = setTimeout(() => {
        job.controller.abort(new Error("Cover download timed out"));
      }, this.#options.downloadTimeoutMs);
      void this.#downloadAndStore(job.key, job.sourceUrl, job.controller.signal).then(job.resolve, job.reject).finally(() => {
        clearTimeout(timeout);
        this.#active -= 1;
        this.#finish(job);
        this.#drain();
      });
    }
  }

  #finish(job: CoverJob): void {
    if (this.#jobs.get(job.key) === job) this.#jobs.delete(job.key);
    for (const requestId of job.requestIds) this.#requestKeys.delete(requestId);
  }

  async #downloadAndStore(key: string, sourceUrl: string, signal: AbortSignal): Promise<CachedCover> {
    const { bytes, contentType } = await download(sourceUrl, this.#dependencies.fetcher, signal);
    const accent = this.#dependencies.accentFromImage(bytes);
    if (accent !== undefined && !ACCENT_PATTERN.test(accent)) throw new Error("Cover accent is invalid");
    mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    const imagePath = join(this.#directory, `${key}.image`);
    const manifestPath = join(this.#directory, `${key}.json`);
    const temporaryStem = join(this.#directory, `.${key}.${process.pid}.${randomUUID()}`);
    const temporaryImage = `${temporaryStem}.image`;
    const temporaryManifest = `${temporaryStem}.json`;
    try {
      writeFileSync(temporaryImage, bytes, { mode: 0o600, flag: "wx" });
      writeFileSync(temporaryManifest, `${JSON.stringify({ contentType, byteLength: bytes.byteLength, ...(accent ? { accent } : {}) })}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temporaryImage, imagePath);
      renameSync(temporaryManifest, manifestPath);
    } finally {
      if (existsSync(temporaryImage)) rmSync(temporaryImage);
      if (existsSync(temporaryManifest)) rmSync(temporaryManifest);
    }
    this.#prune();
    if (!existsSync(imagePath)) throw new Error("Cover image exceeds the cache quota");
    return { key, path: imagePath, contentType, ...(accent ? { accent } : {}) };
  }

  #prune(): void {
    if (!existsSync(this.#directory)) return;
    const entries = readdirSync(this.#directory)
      .filter((name) => /^[0-9a-f]{64}\.image$/u.test(name))
      .map((name) => {
        const key = name.slice(0, -".image".length);
        const path = join(this.#directory, name);
        const manifest = join(this.#directory, `${key}.json`);
        try {
          if (!existsSync(manifest)) throw new Error("missing manifest");
          const stat = statSync(path);
          return { key, path, manifest, size: stat.size, lastAccessed: stat.mtimeMs };
        } catch {
          rmSync(path, { force: true });
          rmSync(manifest, { force: true });
          return undefined;
        }
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
      .sort((left, right) => left.lastAccessed - right.lastAccessed || left.key.localeCompare(right.key));
    let bytes = entries.reduce((total, entry) => total + entry.size, 0);
    while (entries.length > this.#options.maxCacheEntries || bytes > this.#options.maxCacheBytes) {
      const oldest = entries.shift();
      if (!oldest) break;
      rmSync(oldest.path, { force: true });
      rmSync(oldest.manifest, { force: true });
      bytes -= oldest.size;
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}
