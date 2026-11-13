export class FileMutationQueue {
  private readonly tails = new Map<string, Promise<void>>();
  async run<T>(
    envId: string,
    canonicalPath: string,
    mutate: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const key = `${envId}\0${canonicalPath}`;
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, tail);
    await previous;
    try {
      signal?.throwIfAborted();
      return await mutate();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
/** Independent factory calls also share file serialization by default. */
export const defaultMutationQueue = new FileMutationQueue();
