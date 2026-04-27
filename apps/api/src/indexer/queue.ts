import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { indexRepository, indexMultipleFiles } from './indexer.js';

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
  gitlabToken?: string;
};

export type IncrementalIndexJobData = {
  repoId: number;
  repoPath: string;
  files: string[]; // relative paths
};

export function startIndexWorker() {
  const worker = new Worker<IndexJobData | IncrementalIndexJobData>(
    'index-repo',
    async (job) => {
      console.log(`Processing index job ${job.id}`);

      try {
        if (job.name === 'index') {
          const data = job.data as IndexJobData;
          console.log(`Full indexing for repo ${data.repoName}`);
          await indexRepository(data);
        } else if (job.name === 'incremental-index') {
          const data = job.data as IncrementalIndexJobData;
          console.log(`Incremental indexing ${data.files.length} files for repo ${data.repoId}`);
          await indexMultipleFiles(data.repoId, data.repoPath, data.files);
        }
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

export async function enqueueIncrementalIndexJob(data: IncrementalIndexJobData) {
  const job = await indexQueue.add('incremental-index', data);
  return job.id;
}
