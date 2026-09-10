import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import type OpenAI from "openai";
import type { Pool } from "pg";
import { createApp } from "../src/server.js";
import { embed } from "../src/embeddings.js";

test("Embedding応答のindex順を復元し、次元不一致を拒否する", async () => {
  const first = Array(1536).fill(0.1);
  const second = Array(1536).fill(0.2);
  const mock = { embeddings: { create: async () => ({ data: [
    { index: 1, embedding: second }, { index: 0, embedding: first },
  ] }) } } as unknown as OpenAI;
  assert.deepEqual(await embed(mock, ["一", "二"]), [JSON.stringify(first), JSON.stringify(second)]);
  second.pop();
  await assert.rejects(embed(mock, ["一", "二"]));
});

test("検索APIが不正入力を拒否し、有効な検索だけEmbeddingとSQLへ渡す", async () => {
  let apiCalls = 0;
  let dbCalls = 0;
  const openai = { embeddings: { create: async (request: { input: string[]; model: string; dimensions: number }) => {
    apiCalls++;
    assert.deepEqual(request.input, ["孤独"]);
    assert.equal(request.model, "text-embedding-3-small");
    assert.equal(request.dimensions, 1536);
    return { data: [{ index: 0, embedding: Array(1536).fill(0.1) }] };
  } } } as unknown as OpenAI;
  const pool = { query: async (sql: string, params: unknown[]) => {
    dbCalls++;
    assert.match(sql, /ORDER BY chunks.embedding <=> \$1::vector/);
    assert.equal(params[1], 3);
    return { rows: [{ title: "羅生門", author: "芥川龍之介", paragraph_no: 1, body: "本文", distance: 0.2 }] };
  } } as unknown as Pool;
  const server = createApp(pool, openai).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/search`;
  try {
    for (const suffix of ["", "?query=", "?query=%20", "?query=a&query=b", "?query=a&limit=0", "?query=a&limit=51", "?query=a&limit=1.5", "?query=a&limit=x", `?query=${"a".repeat(2001)}`]) {
      assert.equal((await fetch(base + suffix)).status, 400, suffix);
    }
    assert.equal(apiCalls, 0);
    const response = await fetch(`${base}?query=${encodeURIComponent(" 孤独 ")}&limit=3`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.query, "孤独");
    assert.equal(body.results[0].title, "羅生門");
    assert.equal(apiCalls, 1);
    assert.equal(dbCalls, 1);
    pool.query = async () => { throw new Error("internal details"); };
    const failed = await fetch(`${base}?query=${encodeURIComponent("孤独")}&limit=3`);
    assert.equal(failed.status, 502);
    assert.ok(!(await failed.text()).includes("internal details"));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
