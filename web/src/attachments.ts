/** Bound retained plaintext for cloning and fallback downloads. */
export const MAX_BUFFERED_DOWNLOAD = 64 * 1024 * 1024;

/** Cache small attachments only after their complete stream authenticates. */
export class CloneableAttachment {
  private cached: File | null = null;
  private started = false;
  private readonly source: AsyncGenerator<Uint8Array>;
  private readonly name: string;
  readonly size: number;
  private readonly mime: string;

  constructor(
    source: AsyncGenerator<Uint8Array>, name: string, size: number, mime: string,
  ) { this.source = source; this.name = name; this.size = size; this.mime = mime; }

  get canClone(): boolean { return this.size <= MAX_BUFFERED_DOWNLOAD && (!this.started || this.cached !== null); }

  async *stream(): AsyncGenerator<Uint8Array> {
    if (this.cached) {
      for (let offset = 0; offset < this.cached.size; offset += 64 * 1024) {
        yield new Uint8Array(await this.cached.slice(offset, offset + 64 * 1024).arrayBuffer());
      }
      return;
    }
    if (this.started) throw new Error('The attachment is already being read or could not be verified.');
    this.started = true;
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let received = 0;
    try {
      for await (const chunk of this.source) {
        received += chunk.length;
        if (received > this.size) throw new Error('The attachment size does not match.');
        if (this.size <= MAX_BUFFERED_DOWNLOAD) parts.push(chunk as Uint8Array<ArrayBuffer>);
        yield chunk;
      }
      if (received !== this.size) throw new Error('The attachment is incomplete.');
      if (this.size <= MAX_BUFFERED_DOWNLOAD) this.cached = new File(parts, this.name, { type: this.mime });
    } finally {
      parts.length = 0;
    }
  }

  async clone(): Promise<File> {
    if (this.size > MAX_BUFFERED_DOWNLOAD) throw new Error('Cloning attachments is limited to 64 MiB. Save the file and attach it to a new paste instead.');
    if (!this.cached) for await (const _chunk of this.stream()) { /* verify the entire stream */ }
    if (!this.cached) throw new Error('The attachment could not be verified.');
    return this.cached;
  }
}
