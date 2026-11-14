// Client for the /api/v1 endpoints. Only ciphertext and the tokens the
// server issued ever go over the wire.

import { apiURL } from './config.ts';

const ID = /^[0-9a-f]{32}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Size of each upload request. The server accepts up to 8 MiB and requires
 * at least 4 MiB for every chunk but the last.
 */
export const UPLOAD_CHUNK = 4 * 1024 * 1024;
export const MAX_BURN_READS = 1000;

/** Deadlines, so a server that stops answering cannot leave the page waiting forever. */
const REQUEST_MS = 60_000;
const CHUNK_MS = 6 * 60_000; // the server allows a chunk 5 minutes
const COMMENTS_MS = 6 * 60_000; // the server allows a full discussion (about 9 MB) about 5.5 minutes

const base: RequestInit = {
  credentials: 'omit',
  cache: 'no-store',
  redirect: 'error',
  referrerPolicy: 'no-referrer',
};

export class ApiError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body['error'] === 'string' ? body['error'] : `HTTP ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function errorFrom(resp: Response): Promise<ApiError> {
  let body: Record<string, unknown> = {};
  try {
    const v: unknown = await resp.json();
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) body = v as Record<string, unknown>;
  } catch {
    // not JSON
  }
  return new ApiError(resp.status, body);
}

export interface Created {
  id: string;
  uploadToken: string;
  deleteToken: string;
}

/** One separate recipient link at creation: its access token and open limit (null for none). */
export interface RecipientRequest {
  token: string;
  maxReads: number | null;
}

/**
 * Starts an upload. A comment token (derived from the key) enables a
 * discussion. Recipient links replace the single burn token: the paste can
 * then be opened only through one of them.
 */
export async function createPaste(expiresIn: number, burn: boolean, totalSize: number, commentToken: string | null, burnToken: string | null = null, maxReads = 1, recipients: readonly RecipientRequest[] | null = null): Promise<Created> {
  const body: Record<string, unknown> = { expires_in: expiresIn, burn_after_reading: burn || recipients !== null, total_size: totalSize };
  if (recipients !== null) {
    body['recipients'] = recipients.map((r) => (r.maxReads === null ? { token: r.token } : { token: r.token, max_reads: r.maxReads }));
  } else {
    if (commentToken !== null) body['comment_token'] = commentToken;
    if (burnToken !== null) body['burn_token'] = burnToken;
    if (burn && maxReads !== 1) body['max_reads'] = maxReads;
  }
  const resp = await fetch(apiURL('/api/v1/pastes'), {
    ...base, signal: AbortSignal.timeout(REQUEST_MS),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (resp.status !== 201) throw await errorFrom(resp);
  const v = (await resp.json()) as Record<string, unknown>;
  const { id, upload_token: up, delete_token: del } = v;
  if (typeof id !== 'string' || !ID.test(id) || typeof up !== 'string' || !TOKEN.test(up) || typeof del !== 'string' || !TOKEN.test(del)) {
    throw new Error('The server sent an invalid response.');
  }
  return { id, uploadToken: up, deleteToken: del };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Uploads chunk n, retrying a few times on network errors, 429, 5xx and a
 * busy upload. If an earlier attempt was stored but its response was lost,
 * the server answers 409 with next_chunk = n + 1, which counts as success.
 */
export async function putChunk(id: string, n: number, uploadToken: string, data: Uint8Array<ArrayBuffer>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    let resp: Response | null = null;
    try {
      resp = await fetch(apiURL(`/api/v1/pastes/${id}/chunks/${n}`), {
        ...base, signal: AbortSignal.timeout(CHUNK_MS),
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'Nullbin-Upload-Token': uploadToken },
        body: data,
      });
    } catch (e) {
      if (attempt >= 3) throw e;
    }
    if (resp?.status === 204) return;
    let busy = false;
    if (resp?.status === 409) {
      const err = await errorFrom(resp);
      if (attempt > 0 && err.body['next_chunk'] === n + 1) return;
      if (err.body['next_chunk'] !== undefined || attempt >= 3) throw err;
      busy = true; // another request for this upload is still running
    }
    // A full server (507) stays full for longer than the retries take.
    const retryable = busy || resp === null || resp.status === 429 || (resp.status >= 500 && resp.status !== 507);
    if (!retryable || attempt >= 3) throw resp ? await errorFrom(resp) : new Error('Upload failed.');
    const after = Number(resp?.headers.get('Retry-After'));
    await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 1000 * 2 ** attempt);
  }
}

/**
 * Publishes a finished upload. A busy or rate-limited server is retried,
 * honouring Retry-After: giving up would throw away the whole upload.
 */
export async function finalizePaste(id: string, uploadToken: string): Promise<Date | null> {
  let resp: Response;
  for (let attempt = 0; ; attempt++) {
    resp = await fetch(apiURL(`/api/v1/pastes/${id}/finalize`), {
      ...base, signal: AbortSignal.timeout(REQUEST_MS),
      method: 'POST',
      headers: { 'Nullbin-Upload-Token': uploadToken },
    });
    const retryable = resp.status === 409 || resp.status === 429 || resp.status === 503;
    if (!retryable || attempt >= 4) break;
    const after = Number(resp.headers.get('Retry-After'));
    await resp.body?.cancel();
    await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 1000 * 2 ** attempt);
  }
  if (resp.status !== 200) throw await errorFrom(resp);
  const v = (await resp.json()) as Record<string, unknown>;
  const d = typeof v['expires_at'] === 'string' ? new Date(v['expires_at']) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

/** The longest a paste can last (a month), with room for clock differences. */
const MAX_EXPIRES_IN = 31 * 24 * 3600;

/**
 * Starts downloading a paste's ciphertext. With a token it opens a burn paste
 * or a recipient link; `limited` says whether that link has an open limit
 * (one without sends no count). expiresIn is the seconds left, if known.
 */
export async function fetchPaste(id: string, burnToken: string | null = null, limited = true, recipientLink = false): Promise<{ body: ReadableStream<Uint8Array>; size: number; readsRemaining: number | null; expiresIn: number | null }> {
  // Only the wait for the response to start is limited here; a download can
  // take long, and ByteReader fails one that stops arriving.
  const started = new AbortController();
  const timer = setTimeout(() => started.abort(), REQUEST_MS);
  let resp: Response;
  try {
    resp = await fetch(apiURL(`/api/v1/pastes/${id}${burnToken === null ? '' : '/read'}`), {
      ...base, signal: started.signal, method: burnToken === null ? 'GET' : 'POST',
      headers: burnToken === null ? {} : { 'Nullbin-Burn-Token': burnToken },
    });
  } finally {
    clearTimeout(timer);
  }
  if (resp.status !== 200 || !resp.body) throw await errorFrom(resp);
  const size = Number(resp.headers.get('Content-Length'));
  let readsRemaining: number | null = null;
  if (burnToken !== null && (limited || recipientLink)) {
    const raw = resp.headers.get('Nullbin-Reads-Remaining');
    // Older servers support only single-open burns and omit this header. For
    // a separate link the server's answer decides, whatever the link says:
    // a count if the link has a limit, none if it has not.
    readsRemaining = raw === null ? (recipientLink ? null : 0) : Number(raw);
    if (readsRemaining !== null && ((raw !== null && !/^\d+$/.test(raw)) || !Number.isSafeInteger(readsRemaining) || readsRemaining < 0 || readsRemaining >= MAX_BURN_READS)) {
      await resp.body.cancel();
      throw new Error('The server sent an invalid read count.');
    }
  }
  const left = resp.headers.get('Nullbin-Expires-In');
  const expiresIn = left !== null && /^\d{1,8}$/.test(left) && Number(left) <= MAX_EXPIRES_IN ? Number(left) : null;
  return { body: resp.body, size: Number.isSafeInteger(size) && size > 0 ? size : 0, readsRemaining, expiresIn };
}

/** One recipient link as its owner sees it. */
export interface RecipientState {
  opens: number;
  /** null: no limit. */
  maxOpens: number | null;
  revoked: boolean;
}

/** The state of each separate link, for the holder of the delete token. */
export async function fetchRecipients(id: string, deleteToken: string): Promise<RecipientState[]> {
  const resp = await fetch(apiURL(`/api/v1/pastes/${id}/recipients`), {
    ...base, signal: AbortSignal.timeout(REQUEST_MS),
    method: 'GET',
    headers: { 'Nullbin-Delete-Token': deleteToken },
  });
  if (resp.status !== 200) throw await errorFrom(resp);
  const v = (await resp.json()) as Record<string, unknown>;
  const list = v['recipients'];
  if (!Array.isArray(list) || list.length < 2 || list.length > 20) throw new Error('The server sent an invalid response.');
  const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  return list.map((item: unknown) => {
    const r = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    const { opens, max_opens: max, revoked } = r;
    if (!count(opens) || !(max === null || (count(max) && (max as number) >= 1 && (max as number) <= MAX_BURN_READS)) || typeof revoked !== 'boolean') {
      throw new Error('The server sent an invalid response.');
    }
    return { opens: opens as number, maxOpens: max as number | null, revoked };
  });
}

/** Closes separate link n (counting from 0) for good. */
export async function revokeRecipient(id: string, deleteToken: string, n: number): Promise<void> {
  const resp = await fetch(apiURL(`/api/v1/pastes/${id}/recipients/${n}/revoke`), {
    ...base, signal: AbortSignal.timeout(REQUEST_MS),
    method: 'POST',
    headers: { 'Nullbin-Delete-Token': deleteToken },
  });
  if (resp.status !== 204) throw await errorFrom(resp);
}

/** Only the public format prefix is exposed before authorizing a burn. */
export async function fetchBurnPrefix(id: string): Promise<Uint8Array> {
  const resp = await fetch(apiURL(`/api/v1/pastes/${id}/prefix`), { ...base, signal: AbortSignal.timeout(REQUEST_MS), method: 'GET' });
  if (resp.status !== 200 || !resp.body) throw await errorFrom(resp);
  const reader = resp.body.getReader();
  const prefix = new Uint8Array(22);
  let off = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (off + value.length > prefix.length) throw new Error('Invalid paste prefix.');
      prefix.set(value, off);
      off += value.length;
    }
    if (off !== prefix.length) throw new Error('Invalid paste prefix.');
    return prefix;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function deletePaste(id: string, deleteToken: string): Promise<void> {
  const resp = await fetch(apiURL(`/api/v1/pastes/${id}`), {
    ...base, signal: AbortSignal.timeout(REQUEST_MS),
    method: 'DELETE',
    headers: { 'Nullbin-Delete-Token': deleteToken },
  });
  if (resp.status !== 204) throw await errorFrom(resp);
}

/** Regroups a stream of byte arrays into pieces of exactly `size` bytes (the last may be shorter). */
export async function* rechunk(src: AsyncIterable<Uint8Array>, size: number): AsyncGenerator<Uint8Array<ArrayBuffer>, void, undefined> {
  let buf = new Uint8Array(size);
  let len = 0;
  for await (const piece of src) {
    let off = 0;
    while (off < piece.length) {
      const take = Math.min(size - len, piece.length - off);
      buf.set(piece.subarray(off, off + take), len);
      len += take;
      off += take;
      if (len === size) {
        yield buf;
        buf = new Uint8Array(size);
        len = 0;
      }
    }
  }
  if (len > 0) yield buf.slice(0, len);
}

/** Posts one encrypted comment. Retries briefly while the paste is busy. */
export async function postComment(id: string, commentToken: string, data: Uint8Array<ArrayBuffer>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const resp = await fetch(apiURL(`/api/v1/pastes/${id}/comments`), {
      ...base, signal: AbortSignal.timeout(REQUEST_MS),
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Nullbin-Comment-Token': commentToken },
      body: data,
    });
    if (resp.status === 201) return;
    const err = await errorFrom(resp);
    const busy = resp.status === 409 && err.message.includes('busy');
    if (!busy || attempt >= 4) throw err;
    await sleep(250 * (attempt + 1));
  }
}

/** Fetches a discussion's encrypted comments, in arrival order. */
export async function fetchComments(id: string, commentToken: string): Promise<Uint8Array[]> {
  const resp = await fetch(apiURL(`/api/v1/pastes/${id}/comments`), {
    ...base, signal: AbortSignal.timeout(COMMENTS_MS),
    method: 'GET',
    headers: { 'Nullbin-Comment-Token': commentToken },
  });
  if (resp.status !== 200) throw await errorFrom(resp);
  const v = (await resp.json()) as Record<string, unknown>;
  const list = v['comments'];
  if (!Array.isArray(list) || list.length > 1000) throw new Error('The server sent an invalid response.');
  const out: Uint8Array[] = [];
  for (const item of list) {
    if (typeof item !== 'string' || item.length > 64 * 1024) continue;
    try {
      out.push(Uint8Array.from(atob(item), (c) => c.charCodeAt(0)));
    } catch {
      // Not base64: skip it. It could never decrypt anyway.
    }
  }
  return out;
}
