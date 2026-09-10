import express from "express";
import type { Pool } from "pg";
import type OpenAI from "openai";
import { createPool } from "./db.js";
import { createOpenAI } from "./embeddings.js";
import { search } from "./search.js";
import { answer } from "./answer.js";

export function createApp(pool: Pool, openai: OpenAI) {
  const app = express();
  app.post("/ask", express.json({ limit: "16kb" }), async (req, res) => {
    const question: unknown = req.body?.question;
    if (typeof question !== "string" || !question.trim() || question.length > 2000) {
      res.status(400).json({ error: "questionは1〜2000文字の文字列で指定してください。" });
      return;
    }
    try {
      res.json(await answer(pool, openai, question.trim()));
    } catch {
      console.error("回答生成に失敗しました。DB接続とOpenAI APIの設定・利用状況を確認してください。");
      res.status(502).json({ error: "回答生成に失敗しました。" });
    }
  });
  app.get("/search", async (req, res) => {
    const query = req.query.query;
    const rawLimit = req.query.limit;
    if (typeof query !== "string" || !query.trim() || query.length > 2000) {
      res.status(400).json({ error: "queryは1〜2000文字の文字列で指定してください。" });
      return;
    }
    if (rawLimit !== undefined && (typeof rawLimit !== "string" || !/^\d+$/.test(rawLimit))) {
      res.status(400).json({ error: "limitは1〜50の整数で指定してください。" });
      return;
    }
    const limit = rawLimit === undefined ? 10 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      res.status(400).json({ error: "limitは1〜50の整数で指定してください。" });
      return;
    }
    try {
      res.json({ query: query.trim(), results: await search(pool, openai, query.trim(), limit) });
    } catch {
      console.error("検索に失敗しました。DB接続とOpenAI APIの設定・利用状況を確認してください。");
      res.status(502).json({ error: "検索処理に失敗しました。" });
    }
  });
  const handleBodyError: express.ErrorRequestHandler = (error, _req, res, _next) => {
    if (error?.type === "entity.too.large") {
      res.status(413).json({ error: "リクエスト本文は16KB以内で指定してください。" });
    } else {
      res.status(400).json({ error: "リクエスト本文を正しいJSONで指定してください。" });
    }
  };
  app.use(handleBodyError);
  return app;
}

async function main() {
  const openai = createOpenAI();
  const pool = createPool();
  try {
    await pool.query("SELECT 1");
    const server = createApp(pool, openai).listen(3000, "0.0.0.0", () => {
      console.log("検索API: http://localhost:3000/search?query=孤独");
    });
    server.on("error", () => { void pool.end(); process.exitCode = 1; });
    const shutdown = () => server.close(() => { void pool.end(); });
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch {
    await pool.end();
    throw new Error("DB接続に失敗しました。");
  }
}

if (require.main === module) {
  main().catch(() => {
    console.error("起動に失敗しました。DATABASE_URL、OPENAI_API_KEY、DBの起動状態を確認してください。");
    process.exitCode = 1;
  });
}
