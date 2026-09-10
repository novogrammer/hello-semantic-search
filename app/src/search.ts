import type { Pool } from "pg";
import type OpenAI from "openai";
import { embed } from "./embeddings.js";

export async function search(pool: Pool, openai: OpenAI, query: string, limit = 10) {
  const [vector] = await embed(openai, [query]);
  const result = await pool.query(`
    SELECT works.title, works.author, works.aozora_work_id,
           chunks.paragraph_no, chunks.body,
           chunks.embedding <=> $1::vector AS distance
    FROM chunks JOIN works ON works.id = chunks.work_id
    WHERE chunks.embedding IS NOT NULL
    ORDER BY chunks.embedding <=> $1::vector
    LIMIT $2
  `, [vector, limit]);
  return result.rows;
}
