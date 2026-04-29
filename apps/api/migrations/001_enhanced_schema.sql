-- ============================================
-- Enhanced Code Search Schema Migration
-- Version: 1.0
-- Date: 2026-04-29
-- ============================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================
-- 1. Extend existing code_chunks table
-- ============================================
ALTER TABLE code_chunks
  ADD COLUMN IF NOT EXISTS metadata JSONB,
  ADD COLUMN IF NOT EXISTS node_type VARCHAR(50),
  ADD COLUMN IF NOT EXISTS parent_chunk_id INT REFERENCES code_chunks(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_code_chunks_node_type ON code_chunks(node_type);
CREATE INDEX IF NOT EXISTS idx_code_chunks_metadata ON code_chunks USING gin(metadata);

COMMENT ON COLUMN code_chunks.metadata IS 'Additional metadata: imports, exports, decorators, complexity, etc.';
COMMENT ON COLUMN code_chunks.node_type IS 'Type of code node: function, class, variable, interface, etc.';

-- ============================================
-- 2. String Constants Table
-- ============================================
CREATE TABLE IF NOT EXISTS string_constants (
  id SERIAL PRIMARY KEY,
  repo_id INT NOT NULL,
  file_id INT NOT NULL,
  chunk_id INT,

  -- Constant information
  symbol_name VARCHAR(255),
  string_value TEXT NOT NULL,
  constant_type VARCHAR(50),

  -- Location
  line_start INT NOT NULL,
  line_end INT NOT NULL,

  -- Context
  parent_object VARCHAR(255),
  export_type VARCHAR(20),

  -- Code snippet
  code TEXT,

  -- Vector for semantic search
  embedding vector(1536),

  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
  FOREIGN KEY (chunk_id) REFERENCES code_chunks(id) ON DELETE CASCADE
);

CREATE INDEX idx_string_constants_repo ON string_constants(repo_id);
CREATE INDEX idx_string_constants_file ON string_constants(file_id);
CREATE INDEX idx_string_constants_symbol ON string_constants(symbol_name);
CREATE INDEX idx_string_constants_type ON string_constants(constant_type);
CREATE INDEX idx_string_constants_value ON string_constants USING gin(string_value gin_trgm_ops);
CREATE INDEX idx_string_constants_embedding ON string_constants USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

COMMENT ON TABLE string_constants IS 'String constants extracted from code: URLs, error codes, event names, etc.';

-- ============================================
-- 3. URL Patterns Table
-- ============================================
CREATE TABLE IF NOT EXISTS url_patterns (
  id SERIAL PRIMARY KEY,
  repo_id INT NOT NULL,

  -- URL information
  pattern TEXT NOT NULL,
  normalized_pattern TEXT,
  method VARCHAR(10),

  -- Definition location
  definition_file_id INT,
  definition_chunk_id INT,
  definition_line INT,
  definition_code TEXT,

  -- Components (JSON array)
  components JSONB NOT NULL,

  -- Parameters
  path_params JSONB,
  query_params JSONB,

  -- Vector for semantic search
  embedding vector(1536),

  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE,
  FOREIGN KEY (definition_file_id) REFERENCES files(id) ON DELETE CASCADE,
  FOREIGN KEY (definition_chunk_id) REFERENCES code_chunks(id) ON DELETE CASCADE
);

CREATE INDEX idx_url_patterns_repo ON url_patterns(repo_id);
CREATE INDEX idx_url_patterns_pattern ON url_patterns USING gin(pattern gin_trgm_ops);
CREATE INDEX idx_url_patterns_normalized ON url_patterns USING gin(normalized_pattern gin_trgm_ops);
CREATE INDEX idx_url_patterns_method ON url_patterns(method);
CREATE INDEX idx_url_patterns_embedding ON url_patterns USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

COMMENT ON TABLE url_patterns IS 'URL patterns extracted from code with their components and usage';

-- ============================================
-- 4. Functions Table
-- ============================================
CREATE TABLE IF NOT EXISTS functions (
  id SERIAL PRIMARY KEY,
  repo_id INT NOT NULL,
  file_id INT NOT NULL,
  chunk_id INT NOT NULL,

  -- Function information
  name VARCHAR(255) NOT NULL,
  full_name TEXT,
  signature TEXT,
  return_type VARCHAR(255),

  -- Classification
  function_type VARCHAR(50),
  visibility VARCHAR(20),
  is_async BOOLEAN DEFAULT FALSE,
  is_exported BOOLEAN DEFAULT FALSE,

  -- Parameters
  parameters JSONB,

  -- Complexity metrics
  cyclomatic_complexity INT,
  lines_of_code INT,

  -- Location
  line_start INT NOT NULL,
  line_end INT NOT NULL,

  -- Code snippet
  code TEXT,

  -- Vector for semantic search
  embedding vector(1536),

  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
  FOREIGN KEY (chunk_id) REFERENCES code_chunks(id) ON DELETE CASCADE
);

CREATE INDEX idx_functions_repo ON functions(repo_id);
CREATE INDEX idx_functions_file ON functions(file_id);
CREATE INDEX idx_functions_name ON functions(name);
CREATE INDEX idx_functions_full_name ON functions USING gin(full_name gin_trgm_ops);
CREATE INDEX idx_functions_type ON functions(function_type);
CREATE INDEX idx_functions_exported ON functions(is_exported);
CREATE INDEX idx_functions_embedding ON functions USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

COMMENT ON TABLE functions IS 'Functions and methods extracted from code';

-- ============================================
-- 5. Classes Table
-- ============================================
CREATE TABLE IF NOT EXISTS classes (
  id SERIAL PRIMARY KEY,
  repo_id INT NOT NULL,
  file_id INT NOT NULL,
  chunk_id INT NOT NULL,

  -- Class information
  name VARCHAR(255) NOT NULL,
  full_name TEXT,
  class_type VARCHAR(50),

  -- Inheritance
  extends_class VARCHAR(255),
  implements_interfaces JSONB,

  -- Members
  properties JSONB,
  methods JSONB,

  -- Decorators
  decorators JSONB,

  -- Location
  line_start INT NOT NULL,
  line_end INT NOT NULL,

  -- Code snippet
  code TEXT,

  -- Vector for semantic search
  embedding vector(1536),

  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE,
  FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
  FOREIGN KEY (chunk_id) REFERENCES code_chunks(id) ON DELETE CASCADE
);

CREATE INDEX idx_classes_repo ON classes(repo_id);
CREATE INDEX idx_classes_file ON classes(file_id);
CREATE INDEX idx_classes_name ON classes(name);
CREATE INDEX idx_classes_type ON classes(class_type);
CREATE INDEX idx_classes_embedding ON classes USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

COMMENT ON TABLE classes IS 'Classes, interfaces, and types extracted from code';

-- ============================================
-- 6. Import Relations Table
-- ============================================
CREATE TABLE IF NOT EXISTS import_relations (
  id SERIAL PRIMARY KEY,
  repo_id INT NOT NULL,

  -- Importer
  importer_file_id INT NOT NULL,
  importer_chunk_id INT,
  importer_line INT,

  -- Imported
  imported_file_id INT,
  imported_symbol VARCHAR(255),
  import_type VARCHAR(20),

  -- Import path
  import_path TEXT NOT NULL,
  is_external BOOLEAN DEFAULT FALSE,

  -- Alias
  alias VARCHAR(255),

  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE,
  FOREIGN KEY (importer_file_id) REFERENCES files(id) ON DELETE CASCADE,
  FOREIGN KEY (imported_file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE INDEX idx_import_relations_repo ON import_relations(repo_id);
CREATE INDEX idx_import_relations_importer ON import_relations(importer_file_id);
CREATE INDEX idx_import_relations_imported ON import_relations(imported_file_id);
CREATE INDEX idx_import_relations_symbol ON import_relations(imported_symbol);
CREATE INDEX idx_import_relations_path ON import_relations USING gin(import_path gin_trgm_ops);

COMMENT ON TABLE import_relations IS 'Import/export relationships between files';

-- ============================================
-- 7. Constant References Table
-- ============================================
CREATE TABLE IF NOT EXISTS constant_references (
  id SERIAL PRIMARY KEY,
  repo_id INT NOT NULL,

  -- Referrer
  referrer_file_id INT NOT NULL,
  referrer_chunk_id INT,
  referrer_line INT,
  referrer_context TEXT,

  -- Referenced constant
  constant_id INT NOT NULL,

  -- Reference type
  reference_type VARCHAR(50),

  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE,
  FOREIGN KEY (referrer_file_id) REFERENCES files(id) ON DELETE CASCADE,
  FOREIGN KEY (constant_id) REFERENCES string_constants(id) ON DELETE CASCADE
);

CREATE INDEX idx_constant_references_repo ON constant_references(repo_id);
CREATE INDEX idx_constant_references_constant ON constant_references(constant_id);
CREATE INDEX idx_constant_references_referrer ON constant_references(referrer_file_id);

COMMENT ON TABLE constant_references IS 'References to string constants from code';

-- ============================================
-- 8. URL Usages Table
-- ============================================
CREATE TABLE IF NOT EXISTS url_usages (
  id SERIAL PRIMARY KEY,
  repo_id INT NOT NULL,

  -- URL pattern
  url_pattern_id INT NOT NULL,

  -- Usage location
  usage_file_id INT NOT NULL,
  usage_chunk_id INT,
  usage_line INT,
  usage_code TEXT,

  -- Usage context
  usage_context VARCHAR(50),
  http_method VARCHAR(10),

  -- Call stack
  call_stack JSONB,

  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE,
  FOREIGN KEY (url_pattern_id) REFERENCES url_patterns(id) ON DELETE CASCADE,
  FOREIGN KEY (usage_file_id) REFERENCES files(id) ON DELETE CASCADE
);

CREATE INDEX idx_url_usages_repo ON url_usages(repo_id);
CREATE INDEX idx_url_usages_pattern ON url_usages(url_pattern_id);
CREATE INDEX idx_url_usages_file ON url_usages(usage_file_id);

COMMENT ON TABLE url_usages IS 'Usage locations of URL patterns in code';

-- ============================================
-- 9. Extend call_graph table
-- ============================================
ALTER TABLE call_graph
  ADD COLUMN IF NOT EXISTS call_type VARCHAR(50),
  ADD COLUMN IF NOT EXISTS arguments JSONB,
  ADD COLUMN IF NOT EXISTS call_line INT;

CREATE INDEX IF NOT EXISTS idx_call_graph_type ON call_graph(call_type);

COMMENT ON COLUMN call_graph.call_type IS 'Type of call: direct, callback, promise, async_await';
COMMENT ON COLUMN call_graph.arguments IS 'Arguments passed in the call';

-- ============================================
-- 10. File Dependencies Table
-- ============================================
CREATE TABLE IF NOT EXISTS file_dependencies (
  id SERIAL PRIMARY KEY,
  repo_id INT NOT NULL,

  source_file_id INT NOT NULL,
  target_file_id INT NOT NULL,

  -- Dependency strength
  dependency_count INT DEFAULT 1,

  -- Dependency types
  dependency_types JSONB,

  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE,
  FOREIGN KEY (source_file_id) REFERENCES files(id) ON DELETE CASCADE,
  FOREIGN KEY (target_file_id) REFERENCES files(id) ON DELETE CASCADE,

  UNIQUE(source_file_id, target_file_id)
);

CREATE INDEX idx_file_dependencies_repo ON file_dependencies(repo_id);
CREATE INDEX idx_file_dependencies_source ON file_dependencies(source_file_id);
CREATE INDEX idx_file_dependencies_target ON file_dependencies(target_file_id);

COMMENT ON TABLE file_dependencies IS 'File-level dependency graph';

-- ============================================
-- 11. Search Logs Table (for optimization)
-- ============================================
CREATE TABLE IF NOT EXISTS search_logs (
  id SERIAL PRIMARY KEY,
  repo_id INT NOT NULL,

  query TEXT NOT NULL,
  query_type VARCHAR(50),

  -- Search strategies
  strategies_used JSONB,

  -- Results
  result_count INT,
  top_result_ids JSONB,

  -- User feedback
  clicked_result_id INT,
  feedback_score INT,

  -- Performance
  search_time_ms INT,

  created_at TIMESTAMP DEFAULT NOW(),

  FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
);

CREATE INDEX idx_search_logs_repo ON search_logs(repo_id);
CREATE INDEX idx_search_logs_query ON search_logs USING gin(query gin_trgm_ops);
CREATE INDEX idx_search_logs_created ON search_logs(created_at);
CREATE INDEX idx_search_logs_type ON search_logs(query_type);

COMMENT ON TABLE search_logs IS 'Search query logs for analysis and optimization';

-- ============================================
-- 12. Create views for common queries
-- ============================================

-- View: URL patterns with their components resolved
CREATE OR REPLACE VIEW url_patterns_detailed AS
SELECT
  up.id,
  up.repo_id,
  up.pattern,
  up.method,
  up.definition_file_id,
  f.path as definition_file_path,
  up.definition_line,
  up.components,
  up.path_params,
  up.query_params,
  COUNT(uu.id) as usage_count
FROM url_patterns up
LEFT JOIN files f ON up.definition_file_id = f.id
LEFT JOIN url_usages uu ON up.id = uu.url_pattern_id
GROUP BY up.id, f.path;

-- View: Constants with their references
CREATE OR REPLACE VIEW constants_with_references AS
SELECT
  sc.id,
  sc.repo_id,
  sc.symbol_name,
  sc.string_value,
  sc.constant_type,
  f.path as file_path,
  sc.line_start,
  COUNT(cr.id) as reference_count
FROM string_constants sc
LEFT JOIN files f ON sc.file_id = f.id
LEFT JOIN constant_references cr ON sc.id = cr.constant_id
GROUP BY sc.id, f.path;

-- View: Functions with call counts
CREATE OR REPLACE VIEW functions_with_calls AS
SELECT
  fn.id,
  fn.repo_id,
  fn.name,
  fn.full_name,
  fn.function_type,
  f.path as file_path,
  fn.line_start,
  COUNT(DISTINCT cg1.id) as calls_to,
  COUNT(DISTINCT cg2.id) as called_by
FROM functions fn
LEFT JOIN files f ON fn.file_id = f.id
LEFT JOIN code_chunks cc ON fn.chunk_id = cc.id
LEFT JOIN call_graph cg1 ON cc.id = cg1.from_chunk_id
LEFT JOIN call_graph cg2 ON cc.symbol_name = cg2.to_symbol
GROUP BY fn.id, f.path;

-- ============================================
-- 13. Helper functions
-- ============================================

-- Function to normalize URL patterns
CREATE OR REPLACE FUNCTION normalize_url_pattern(url TEXT)
RETURNS TEXT AS $$
BEGIN
  -- Replace UUIDs with :id
  url := regexp_replace(url, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', ':id', 'gi');
  -- Replace long hex strings with :id
  url := regexp_replace(url, '/[0-9a-f]{20,}', '/:id', 'gi');
  -- Replace numeric IDs with :id
  url := regexp_replace(url, '/\d+', '/:id', 'g');
  RETURN url;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Function to infer constant type
CREATE OR REPLACE FUNCTION infer_constant_type(value TEXT)
RETURNS VARCHAR(50) AS $$
BEGIN
  IF value ~ '^(https?://|/[a-z])' THEN
    RETURN 'url_segment';
  ELSIF value ~ '^E\d+$' THEN
    RETURN 'error_code';
  ELSIF value ~ ':' THEN
    RETURN 'event_name';
  ELSIF value ~ '^\.' THEN
    RETURN 'css_class';
  ELSIF value ~ '^[A-Z_]+$' THEN
    RETURN 'env_var';
  ELSE
    RETURN 'string';
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ============================================
-- 14. Triggers for automatic updates
-- ============================================

-- Trigger to update file_dependencies count
CREATE OR REPLACE FUNCTION update_file_dependency_count()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO file_dependencies (repo_id, source_file_id, target_file_id, dependency_count, dependency_types)
  VALUES (NEW.repo_id, NEW.importer_file_id, NEW.imported_file_id, 1, jsonb_build_array(NEW.import_type))
  ON CONFLICT (source_file_id, target_file_id)
  DO UPDATE SET
    dependency_count = file_dependencies.dependency_count + 1,
    dependency_types = file_dependencies.dependency_types || jsonb_build_array(NEW.import_type),
    updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_file_dependency
AFTER INSERT ON import_relations
FOR EACH ROW
WHEN (NEW.imported_file_id IS NOT NULL)
EXECUTE FUNCTION update_file_dependency_count();

-- ============================================
-- Migration complete
-- ============================================

-- Log migration
DO $$
BEGIN
  RAISE NOTICE 'Enhanced schema migration completed successfully';
  RAISE NOTICE 'Created tables: string_constants, url_patterns, functions, classes, import_relations, constant_references, url_usages, file_dependencies, search_logs';
  RAISE NOTICE 'Extended tables: code_chunks, call_graph';
  RAISE NOTICE 'Created views: url_patterns_detailed, constants_with_references, functions_with_calls';
  RAISE NOTICE 'Created helper functions: normalize_url_pattern, infer_constant_type';
END $$;
