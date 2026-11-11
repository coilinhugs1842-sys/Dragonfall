/**
 * Fetches and decodes audio files a few at a time, most wanted first (T-4.8). Used for both the
 * sound samples and the music tracks. Nothing here runs per frame: work happens when a file is
 * asked for and when one finishes.
 *
 * A failed fetch or decode is not an error for the game: the callback gets null and the engine
 * keeps the procedural fallback for that sound.
 */

/** The part of `fetch` this needs (tests pass a fake). */
export type FetchLike = (url: string) => Promise<{
  readonly ok: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
}>;

/** The part of AudioContext this needs. */
export interface AudioDecoder {
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
}

export type LoadCallback = (buffer: AudioBuffer | null) => void;

/** Files in flight at once: enough to fill a connection, few enough not to stall a frame. */
export const LOAD_CONCURRENCY = 3;

interface Job {
  readonly url: string;
  /** Caller's group number (the engine uses the sound index), for `raise`. -1 = none. */
  readonly tag: number;
  priority: number;
  readonly order: number;
  readonly done: LoadCallback;
}

export interface LoaderStats {
  loaded: number;
  failed: number;
  /** Queued plus in flight. */
  pending: number;
  /** Compressed bytes fetched so far. */
  bytes: number;
}

export class AssetLoader {
  readonly stats: LoaderStats = { loaded: 0, failed: 0, pending: 0, bytes: 0 };
  private readonly queue: Job[] = [];
  private inFlight = 0;
  private order = 0;
  private disposed = false;

  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly decoder: AudioDecoder,
    private readonly concurrency: number = LOAD_CONCURRENCY,
  ) {}

  /** Queues a file. Higher priority goes first; equal priorities go in request order. */
  request(url: string, priority: number, tag: number, done: LoadCallback): void {
    if (this.disposed) {
      done(null);
      return;
    }
    this.queue.push({ url, tag, priority, order: this.order++, done });
    this.stats.pending++;
    this.pump();
  }

  /** Moves the queued files of a group up to at least `priority`. */
  raise(tag: number, priority: number): void {
    for (const job of this.queue) {
      if (job.tag === tag && job.priority < priority) job.priority = priority;
    }
  }

  /** Drops everything queued (their callbacks get null) and ignores what is in flight. */
  dispose(): void {
    this.disposed = true;
    const dropped = this.queue.splice(0);
    for (const job of dropped) job.done(null);
    this.stats.pending = 0;
  }

  private pump(): void {
    while (!this.disposed && this.inFlight < this.concurrency && this.queue.length > 0) {
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) {
        const job = this.queue[i];
        const top = this.queue[best];
        if (job === undefined || top === undefined) continue;
        if (job.priority > top.priority || (job.priority === top.priority && job.order < top.order)) {
          best = i;
        }
      }
      const job = this.queue.splice(best, 1)[0];
      if (job !== undefined) this.run(job);
    }
  }

  private run(job: Job): void {
    this.inFlight++;
    const finish = (buffer: AudioBuffer | null): void => {
      this.inFlight--;
      if (this.disposed) {
        job.done(null);
        return;
      }
      this.stats.pending--;
      if (buffer === null) this.stats.failed++;
      else this.stats.loaded++;
      try {
        job.done(buffer);
      } finally {
        this.pump();
      }
    };
    let started: Promise<AudioBuffer>;
    try {
      started = this.fetchImpl(job.url)
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP error for ${job.url}`);
          return response.arrayBuffer();
        })
        .then((data) => {
          this.stats.bytes += data.byteLength;
          return this.decoder.decodeAudioData(data);
        });
    } catch {
      finish(null);
      return;
    }
    started.then(
      (buffer) => finish(buffer),
      () => finish(null),
    );
  }
}
