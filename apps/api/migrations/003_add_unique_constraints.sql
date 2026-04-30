-- ============================================
-- Add Unique Constraints for ON CONFLICT clauses
-- Version: 1.0
-- Date: 2026-04-30
-- ============================================

-- Add unique constraint for string_constants
-- This allows ON CONFLICT (repo_id, file_id, string_value, line_start) to work
CREATE UNIQUE INDEX IF NOT EXISTS idx_string_constants_unique
ON string_constants(repo_id, file_id, string_value, line_start);

-- Add unique constraint for functions
-- This allows ON CONFLICT (repo_id, file_id, full_name, line_start) to work
CREATE UNIQUE INDEX IF NOT EXISTS idx_functions_unique
ON functions(repo_id, file_id, full_name, line_start);

-- Add unique constraint for classes
-- This allows ON CONFLICT (repo_id, file_id, full_name, line_start) to work
CREATE UNIQUE INDEX IF NOT EXISTS idx_classes_unique
ON classes(repo_id, file_id, full_name, line_start);

COMMENT ON INDEX idx_string_constants_unique IS 'Unique constraint for string constants to support upsert operations';
COMMENT ON INDEX idx_functions_unique IS 'Unique constraint for functions to support upsert operations';
COMMENT ON INDEX idx_classes_unique IS 'Unique constraint for classes to support upsert operations';
