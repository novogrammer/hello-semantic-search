CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE works (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  aozora_work_id integer UNIQUE,
  author text NOT NULL,
  title text NOT NULL
);

CREATE TABLE chunks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  work_id bigint NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  paragraph_no integer NOT NULL,
  body text NOT NULL,
  embedding vector(1536)
);

CREATE INDEX chunks_embedding_idx
ON chunks
USING hnsw (embedding vector_cosine_ops);