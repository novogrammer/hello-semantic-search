import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import OpenAI from "openai";
import { parseAozora } from "../src/aozora.js";
import { createPool } from "../src/db.js";
import { createOpenAI, documentEmbeddingInput, embed } from "../src/embeddings.js";
import { chunkParagraphs, countTokens } from "../src/chunking.js";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const paths = args.filter(arg => arg !== "--dry-run");
  if (paths.some(path => path.startsWith("--"))) throw new Error("未知のオプションです。");
  const files = paths.length ? paths : (await readdir("data"))
    .filter(name => /\.(?:html|xhtml)$/i.test(name)).sort().map(name => join("data", name));
  if (!files.length) throw new Error("取り込むHTMLがありません。");
  // 全ファイルの抽出・分割・上限検査を済ませてからDB/APIに接続する。
  const preparedWorks = [];
  for (const file of files) {
    console.log(`読み込み: ${file}`);
    const work = parseAozora(await readFile(file), file);
    const paragraphs = chunkParagraphs(work.paragraphs, work);
    const maxTokens = paragraphs.reduce((max, body) => Math.max(max, countTokens(documentEmbeddingInput(work, body))), 0);
    console.log(`${work.author}「${work.title}」: 形式分割${work.paragraphs.length}段落 → 保存用${paragraphs.length}段落（作品名・著者込みで最大${maxTokens}トークン）`);
    if (dryRun) console.log(`先頭段落: ${paragraphs[0].slice(0, 120)}`);
    preparedWorks.push({ ...work, file, paragraphs });
  }
  if (dryRun) return;
  const openai = createOpenAI();
  const pool = createPool();
  try {
    for (const work of preparedWorks) {
      console.log(`取り込み: ${work.file}「${work.title}」`);
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
          let vectors: string[];
          try {
            vectors = await embed(openai, batch.map(body => documentEmbeddingInput(work, body)));
          } catch (error) {
            // APIのエラー全文・ヘッダーは出さず、判別に必要な情報だけ表示する。
            if (error instanceof OpenAI.APIError) {
              const reason = /maximum context length|too many tokens|max_tokens_per_request/i.test(error.message)
                ? "入力トークン数の上限超過"
                : error.status === 429 ? "レート制限または利用枠の上限"
                : error.status === 401 ? "認証エラー"
                : "APIリクエスト失敗";
              console.error(`OpenAI: ${reason}（HTTP ${error.status ?? "応答なし"}）`);
            } else {
              console.error("Embedding応答の処理に失敗しました。");
            }
            console.error(`各段落の文字数: ${batch.map((body, i) => `${offset + i + 1}=${body.length}`).join(", ")}`);
            throw error;
          }
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
