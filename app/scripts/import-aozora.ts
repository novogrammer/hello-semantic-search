import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseAozora } from "../src/aozora.js";
import { createPool } from "../src/db.js";
import { createOpenAI, embed } from "../src/embeddings.js";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const paths = args.filter(arg => arg !== "--dry-run");
  if (paths.some(path => path.startsWith("--"))) throw new Error("未知のオプションです。");
  const files = paths.length ? paths : (await readdir("data"))
    .filter(name => /\.(?:html|xhtml)$/i.test(name)).sort().map(name => join("data", name));
  if (!files.length) throw new Error("取り込むHTMLがありません。");
  const pool = dryRun ? undefined : createPool();
  try {
    const openai = dryRun ? undefined : createOpenAI();
    for (const file of files) {
      console.log(`読み込み: ${file}`);
      const work = parseAozora(await readFile(file), file);
      console.log(`${work.author}「${work.title}」: ${work.paragraphs.length}段落`);
      if (!pool || !openai) {
        console.log(`先頭段落: ${work.paragraphs[0].slice(0, 120)}`);
        continue;
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const inserted = await client.query<{ id: string }>(`
          INSERT INTO works (aozora_work_id, author, title) VALUES ($1, $2, $3)
          ON CONFLICT (aozora_work_id) DO NOTHING RETURNING id
        `, [work.aozoraWorkId, work.author, work.title]);
        if (!inserted.rows.length) {
          await client.query("COMMIT");
          console.log("取り込み済みのためスキップしました。");
          continue;
        }
        for (let offset = 0; offset < work.paragraphs.length; offset += 16) {
          const batch = work.paragraphs.slice(offset, offset + 16);
          console.log(`Embedding: 段落${offset + 1}〜${offset + batch.length}`);
          const vectors = await embed(openai, batch);
          for (let i = 0; i < batch.length; i++) {
            await client.query(`
              INSERT INTO chunks (work_id, paragraph_no, body, embedding)
              VALUES ($1, $2, $3, $4::vector)
            `, [inserted.rows[0].id, offset + i + 1, batch[i], vectors[i]]);
          }
        }
        await client.query("COMMIT");
        console.log("保存しました。");
      } catch {
        await client.query("ROLLBACK");
        throw new Error("作品の取り込みに失敗しました。");
      } finally {
        client.release();
      }
    }
  } finally {
    await pool?.end();
  }
}

main().catch(() => {
  console.error("取り込み失敗。直前のファイル・段落範囲、HTML形式、DB接続、APIキー・上限を確認してください。失敗した作品は保存されません。");
  process.exitCode = 1;
});
