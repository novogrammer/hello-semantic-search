import { getEncoding } from "js-tiktoken";
import { documentEmbeddingInput, type WorkMetadata } from "./embeddings.js";

// text-embedding-3-smallに対応。作品情報を含む送信テキストのトークン数で制限する。
const tokenizer = getEncoding("cl100k_base");
export const MAX_CHUNK_TOKENS = 1000;

export function countTokens(text: string) {
  // 特殊トークンに似た文字列も、文学作品の本文としてそのまま数える。
  return tokenizer.encode(text, [], []).length;
}

function splitLongText(text: string, measure: (text: string) => number, level = 0): string[] {
  if (measure(text) <= MAX_CHUNK_TOKENS) return [text];

  if (level < 2) {
    // 改行 → 文末の順で細分化する。区切り文字と閉じ括弧も本文に残す。
    const parts = level === 0
      ? text.split(/(?<=\n)/u)
      : text.match(/[\s\S]*?[。！？!?]+[」』”"]*|[\s\S]+$/gu) ?? [text];
    const chunks: string[] = [];
    let current = "";
    for (const part of parts) {
      for (const piece of splitLongText(part, measure, level + 1)) {
        if (current && measure(current + piece) > MAX_CHUNK_TOKENS) {
          chunks.push(current);
          current = "";
        }
        current += piece;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  // 一文でも上限を超える場合。トークン列を途中でdecodeすると日本語が
  // 壊れる場合があるため、Unicodeコードポイントの境界で切って再計測する。
  const characters = Array.from(text);
  const chunks: string[] = [];
  let offset = 0;
  while (offset < characters.length) {
    let low = 1;
    let high = characters.length - offset;
    let accepted = 0;
    while (low <= high) {
      const length = Math.floor((low + high) / 2);
      const candidate = characters.slice(offset, offset + length).join("");
      if (measure(candidate) <= MAX_CHUNK_TOKENS) {
        accepted = length;
        low = length + 1;
      } else {
        high = length - 1;
      }
    }
    if (!accepted) throw new Error("1文字をEmbedding用の上限内に収められません。");
    chunks.push(characters.slice(offset, offset + accepted).join(""));
    offset += accepted;
  }
  return chunks;
}

export function chunkParagraphs(paragraphs: string[], work?: WorkMetadata) {
  const measure = (body: string) => countTokens(work ? documentEmbeddingInput(work, body) : body);
  if (measure("") >= MAX_CHUNK_TOKENS) {
    throw new Error("作品名・著者だけでEmbedding用の上限に達しています。");
  }
  // 元の段落をまたぐ結合やオーバーラップは行わない。
  const chunks = paragraphs.flatMap(paragraph => splitLongText(paragraph, measure));
  if (chunks.some(chunk => !chunk.trim() || measure(chunk) > MAX_CHUNK_TOKENS)) {
    throw new Error("Embedding用の段落に空文字または上限超過があります。");
  }
  return chunks;
}
