import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { indexRepository } from './indexer.js';

const connection = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: null,
});

export const indexQueue = new Queue('index-repo', { connection });

export type IndexJobData = {
  repoId: number;
  repoName: string;
  source: 'gitlab' | 'zip';
  url?: string;
  zipPath?: string;
};

export function startIndexWorker() {
  const worker = new Worker<IndexJobData>(
    'index-repo',
    async (job) => {
      console.log(`Processing index job ${job.id} for repo ${job.data.repoName}`);

      try {
        await indexRepository(job.data);
        console.log(`Index job ${job.id} completed`);
      } catch (error) {
        console.error(`Index job ${job.id} failed:`, error);
        throw error;
      }
    },
    { connection }
  );

  worker.on('completed', (job) => {
    console.log(`Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`Job ${job?.id} failed:`, err);
  });

  return worker;
}

export async function enqueueIndexJob(data: IndexJobData) {
  const job = await indexQueue.add('index', data);
  return job.id;
}
