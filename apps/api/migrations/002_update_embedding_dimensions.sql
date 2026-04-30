-- Migration: Update embedding dimensions from 1024 to 1536
-- This is required when upgrading from text-embedding-v3 to text-embedding-v4

-- First, clear all existing embeddings (they will be regenerated during reindex)
UPDATE code_chunks SET embedding = NULL WHERE embedding IS NOT NULL;

-- Drop the old embedding column
ALTER TABLE code_chunks DROP COLUMN embedding;

-- Add new embedding column with 1536 dimensions
ALTER TABLE code_chunks ADD COLUMN embedding vector(1536);

-- Recreate the HNSW index for vector search
CREATE INDEX idx_code_chunks_embedding_hnsw ON code_chunks
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Note: Existing embeddings will need to be regenerated
-- Run: npm run reindex <repo_id> <repo_path>
