import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { indexRepository, indexMultipleFiles, refreshGitLabRepo } from './indexer.js';
import { updateRepoStatus } from '../db/index.js';

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

export type RefreshJobData = {
  repoId: number;
  url: string;
  gitlabToken?: string;
};

export function startIndexWorker() {
  const worker = new Worker<IndexJobData | IncrementalIndexJobData | RefreshJobData>(
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
        } else if (job.name === 'refresh') {
          const data = job.data as RefreshJobData;
          console.log(`Refreshing repo ${data.repoId}`);
          await refreshGitLabRepo(data.repoId, data.url, data.gitlabToken);
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

  worker.on('failed', async (job, err) => {
    console.error(`Job ${job?.id} failed:`, err);

    // Update repo status to 'failed' if it's a full index job
    if (job && job.name === 'index') {
      const data = job.data as IndexJobData;
      try {
        await updateRepoStatus(data.repoId, 'failed');
        console.log(`Updated repo ${data.repoId} status to 'failed'`);
      } catch (updateError) {
        console.error(`Failed to update repo status:`, updateError);
      }
    }
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

export async function enqueueRefreshJob(data: RefreshJobData) {
  const job = await indexQueue.add('refresh', data);
  return job.id;
}
