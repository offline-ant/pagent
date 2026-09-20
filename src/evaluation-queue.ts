// Only waiting jobs are cancelled here. Once started, the engine owns interruption
// and must finish its cleanup before the next console evaluation can run.
export class EvaluationQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(new Error("Browser evaluation cancelled before execution"));
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new Error("Browser evaluation cancelled before execution"));
      signal?.addEventListener("abort", abort, { once: true });
      this.tail = this.tail.then(async () => {
        signal?.removeEventListener("abort", abort);
        if (signal?.aborted) return;
        resolve(await run());
      }).catch(reject);
    });
  }
}
