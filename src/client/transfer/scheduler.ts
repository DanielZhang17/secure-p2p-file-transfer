export interface ScheduleChunksOptions {
  adaptive?: boolean;
  chunkIndexes: number[];
  lanes: number;
  maxRetries: number;
  minLanes?: number;
  onLaneCountChange?: (lanes: number) => void;
  onRetry?: (chunkIndex: number, retryCount: number) => void;
  sendChunk: (chunkIndex: number) => Promise<void>;
}

export async function scheduleChunks(options: ScheduleChunksOptions): Promise<void> {
  validateOptions(options);

  await runChunkQueue(options);
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

function runChunkQueue(options: ScheduleChunksOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const queue = options.chunkIndexes.slice();
    const failures = new Map<number, number>();
    const minLanes = Math.max(1, options.minLanes ?? 1);
    let active = 0;
    let currentLanes = options.lanes;
    let firstError: unknown;
    let stopped = false;
    let settled = false;

    const settleIfDone = () => {
      if (settled) {
        return;
      }

      if (stopped && active === 0) {
        settled = true;
        reject(firstError);
        return;
      }

      if (!stopped && queue.length === 0 && active === 0) {
        settled = true;
        resolve();
      }
    };

    const startMore = () => {
      if (stopped || settled) {
        settleIfDone();
        return;
      }

      while (active < currentLanes && queue.length > 0) {
        const chunkIndex = queue.shift();
        if (chunkIndex === undefined) {
          break;
        }

        active += 1;
        void options
          .sendChunk(chunkIndex)
          .then(() => {
            active -= 1;
            startMore();
          })
          .catch((error: unknown) => {
            active -= 1;
            const nextFailures = (failures.get(chunkIndex) ?? 0) + 1;
            failures.set(chunkIndex, nextFailures);

            if (nextFailures > options.maxRetries) {
              if (!stopped) {
                stopped = true;
                firstError = error;
              }
              settleIfDone();
              return;
            }

            options.onRetry?.(chunkIndex, nextFailures);
            if (options.adaptive && currentLanes > minLanes) {
              currentLanes = Math.max(minLanes, Math.floor(currentLanes / 2));
              options.onLaneCountChange?.(currentLanes);
            }
            queue.push(chunkIndex);
            startMore();
          });
      }

      settleIfDone();
    };

    startMore();
  });
}
