import OpenAI from "openai";

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;

export function createOpenAI() {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY を設定してください。");
  return new OpenAI({ timeout: 60_000, maxRetries: 2 });
}

export async function embed(client: OpenAI, input: string[]) {
  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    encoding_format: "float",
    input,
  });
  const data = [...response.data].sort((a, b) => a.index - b.index);
  if (data.length !== input.length || data.some((item, i) =>
    item.index !== i || item.embedding.length !== EMBEDDING_DIMENSIONS ||
    !item.embedding.every(Number.isFinite) || !item.embedding.some(value => value !== 0)
  )) throw new Error("Embeddingの応答が不正です。");
  return data.map(item => JSON.stringify(item.embedding));
}
