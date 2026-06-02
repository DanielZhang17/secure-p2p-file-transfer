export interface ScheduleChunksOptions {
  chunkIndexes: number[];
  lanes: number;
  maxRetries: number;
  sendChunk: (chunkIndex: number) => Promise<void>;
}

export async function scheduleChunks(options: ScheduleChunksOptions): Promise<void> {
  validateOptions(options);

  const queue = options.chunkIndexes.slice();
  const failures = new Map<number, number>();
  let stopped = false;
  let firstError: unknown;

  const workers = Array.from({ length: options.lanes }, async () => {
    while (!stopped) {
      const chunkIndex = queue.shift();
      if (chunkIndex === undefined) {
        return;
      }

      try {
        await options.sendChunk(chunkIndex);
      } catch (error) {
        const nextFailures = (failures.get(chunkIndex) ?? 0) + 1;
        failures.set(chunkIndex, nextFailures);

        if (nextFailures > options.maxRetries) {
          if (!stopped) {
            stopped = true;
            firstError = error;
          }
          return;
        }

        if (!stopped) {
          queue.push(chunkIndex);
        }
      }
    }
  });
  await Promise.all(workers);

  if (stopped) {
    throw firstError;
  }
}

function validateOptions(options: ScheduleChunksOptions): void {
  if (!Number.isInteger(options.lanes) || options.lanes <= 0) {
    throw new Error("lanes must be a positive integer");
  }

  if (!Number.isInteger(options.maxRetries) || options.maxRetries < 0) {
    throw new Error("maxRetries must be a non-negative integer");
  }

  if (options.chunkIndexes.some((chunkIndex) => !Number.isInteger(chunkIndex) || chunkIndex < 0)) {
    throw new Error("chunk indexes must be non-negative integers");
  }
}
