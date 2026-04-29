-- Migration: Update embedding dimensions from 1024 to 1536
-- This is required when upgrading from text-embedding-v3 to text-embedding-v4

-- Update code_chunks table embedding dimension
ALTER TABLE code_chunks
ALTER COLUMN embedding TYPE vector(1536);

-- Note: Existing embeddings will need to be regenerated
-- Run: npm run reindex <repo_id> <repo_path>
