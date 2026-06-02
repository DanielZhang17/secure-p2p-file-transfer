export interface ScheduleChunksOptions {
  chunkIndexes: number[];
  lanes: number;
  maxRetries: number;
  sendChunk: (chunkIndex: number) => Promise<void>;
}

export async function scheduleChunks(options: ScheduleChunksOptions): Promise<void> {
  const queue = options.chunkIndexes.slice();
  const failures = new Map<number, number>();
  const workers = Array.from({ length: options.lanes }, () => runLane(queue, failures, options));

  await Promise.all(workers);
}

async function runLane(
  queue: number[],
  failures: Map<number, number>,
  options: ScheduleChunksOptions,
): Promise<void> {
  for (;;) {
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
        throw error;
      }

      queue.push(chunkIndex);
    }
  }
}
