/** Bound retained plaintext for cloning and fallback downloads. */
export const MAX_BUFFERED_DOWNLOAD = 64 * 1024 * 1024;

/**
 * Keeps small attachments only after their complete stream authenticates.
 * The verified bytes stay in plain arrays, which wipe() can zero; a File (a
 * Blob, which the browser may page to disk) is made only when the reader
 * asks for a preview or a clone.
 */
export class CloneableAttachment {
  private verified: Uint8Array<ArrayBuffer>[] | null = null;
  private file: File | null = null;
  private started = false;
  /** Changes on wipe(), so a read that was running then fails instead of finishing. */
  private generation = 0;
  private readonly source: AsyncGenerator<Uint8Array>;
  private readonly name: string;
  readonly size: number;
  private readonly mime: string;

  constructor(
    source: AsyncGenerator<Uint8Array>, name: string, size: number, mime: string,
  ) { this.source = source; this.name = name; this.size = size; this.mime = mime; }

  get canClone(): boolean { return this.size <= MAX_BUFFERED_DOWNLOAD && (!this.started || this.verified !== null); }

  async *stream(): AsyncGenerator<Uint8Array> {
    const generation = this.generation;
    const checkNotWiped = () => {
      if (this.generation !== generation) throw new Error('The attachment was cleared from memory.');
    };
    if (this.verified) {
      // Copies, so wipe() cannot change bytes a consumer is still writing;
      // a wipe in between makes the read fail rather than end early.
      for (const part of this.verified) {
        checkNotWiped();
        yield part.slice();
      }
      checkNotWiped();
      return;
    }
    if (this.started) throw new Error('The attachment is already being read or could not be verified.');
    this.started = true;
    const keep = this.size <= MAX_BUFFERED_DOWNLOAD;
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let received = 0;
    try {
      for await (const chunk of this.source) {
        checkNotWiped();
        received += chunk.length;
        if (received > this.size) throw new Error('The attachment size does not match.');
        if (keep) parts.push(chunk as Uint8Array<ArrayBuffer>);
        yield chunk;
      }
      checkNotWiped();
      if (received !== this.size) throw new Error('The attachment is incomplete.');
      if (keep) this.verified = parts;
    } finally {
      if (this.verified !== parts) {
        for (const part of parts) part.fill(0);
        parts.length = 0;
      }
    }
  }

  /** Reads and verifies the whole attachment, keeping it in memory. */
  async verify(): Promise<void> {
    if (this.size > MAX_BUFFERED_DOWNLOAD) throw new Error('Cloning attachments is limited to 64 MiB. Save the file and attach it to a new paste instead.');
    if (!this.verified) for await (const _chunk of this.stream()) { /* verify the entire stream */ }
    if (!this.verified) throw new Error('The attachment could not be verified.');
  }

  async clone(): Promise<File> {
    await this.verify();
    this.file ??= new File(this.verified!, this.name, { type: this.mime });
    return this.file;
  }

  /** Zeroes the verified bytes held in memory. The attachment can no longer be read. */
  wipe(): void {
    this.generation++;
    for (const part of this.verified ?? []) part.fill(0);
    this.verified = null;
    this.file = null;
    this.started = true;
  }
}
