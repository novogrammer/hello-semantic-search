import pg from "pg";

export function createPool() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL を設定してください。");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  pool.on("error", () => console.error("DB接続でエラーが発生しました。"));
  return pool;
}
