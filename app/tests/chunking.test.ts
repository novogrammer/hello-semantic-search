import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { parseAozora } from "../src/aozora.js";
import { chunkParagraphs, countTokens, MAX_CHUNK_TOKENS } from "../src/chunking.js";

test("短い段落と詩はそのまま保持し、隣接段落を結合しない", () => {
  const paragraphs = ["短い本文。", "詩の一行目\n詩の二行目", "<|endoftext|>という文字列"];
  assert.deepEqual(chunkParagraphs(paragraphs), paragraphs);
});

test("長い段落は改行を優先し、必要なら句点で分割する", () => {
  let line = "日本語の文章です。";
  while (countTokens(line) < 600) line += "日本語の文章です。";
  line += "\n";
  assert.ok(countTokens(line) <= MAX_CHUNK_TOKENS);
  assert.ok(countTokens(line.repeat(2)) > MAX_CHUNK_TOKENS);
  assert.deepEqual(chunkParagraphs([line.repeat(3)]), [line, line, line]);
  const text = "長い会話の内容を順番に説明しています。".repeat(200);
  const chunks = chunkParagraphs([text]);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.endsWith("。")));
  assert.equal(chunks.join(""), text);
});

test("区切りのない長文も日本語・補助文字を壊さず上限内に分割する", () => {
  const text = "漢字𠮷🙂".repeat(600);
  const chunks = chunkParagraphs([text]);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), text);
  for (const chunk of chunks) {
    assert.ok(countTokens(chunk) <= MAX_CHUNK_TOKENS);
    assert.ok(chunk.isWellFormed());
    assert.ok(!chunk.includes("�"));
  }
});

test("全10作品を上限内に分割し、本文の欠落・重複を生まない", async () => {
  for (const file of (await readdir("data")).filter(file => file.endsWith(".html"))) {
    const work = parseAozora(await readFile(`data/${file}`), file);
    const chunks = chunkParagraphs(work.paragraphs);
    assert.equal(chunks.join(""), work.paragraphs.join(""), file);
    assert.ok(chunks.every(chunk => chunk.trim() && countTokens(chunk) <= MAX_CHUNK_TOKENS), file);
    if (work.aozoraWorkId === 2093) {
      const long = work.paragraphs[1564];
      assert.equal(long.length, 12441);
      assert.ok(countTokens(long) > 8192);
      assert.ok(chunkParagraphs([long]).length > 1);
    }
    if (work.aozoraWorkId === 301) {
      const poem = work.paragraphs.find(p => p.includes("けさ　さめて只に荒涼"))!;
      assert.ok(chunks.includes(poem));
    }
  }
});
