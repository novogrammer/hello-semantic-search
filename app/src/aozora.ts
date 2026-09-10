import { basename } from "node:path";
import { loadBuffer } from "cheerio";

export function parseAozora(buffer: Buffer, filename: string) {
  const match = /^(\d+)_\d+\.(?:html|xhtml)$/i.exec(basename(filename));
  const aozoraWorkId = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(aozoraWorkId) || aozoraWorkId < 1 || aozoraWorkId > 2147483647) {
    throw new Error("ファイル名は青空文庫の 作品ID_ファイルID.html 形式にしてください。");
  }
  const $ = loadBuffer(buffer);
  $("ruby rt, ruby rp, script, style").remove();
  const title = $(".title").first().text().trim();
  const author = $(".author").first().text().trim();
  const main = $(".main_text").first();
  if (!title || !author || !main.length) throw new Error("作品名・著者・本文が見つかりません。");
  // brとブロック境界を改行にする。ルビの親文字はそのまま残す。
  main.find("br").replaceWith("\n");
  main.find("p, div, h1, h2, h3, h4, h5, h6").before("\n").after("\n");
  main.find("img.gaiji").each((_, element) => { $(element).replaceWith($(element).attr("alt") ?? ""); });
  const paragraphs = main.text().split(/\r?\n/).map(text => text.trim()).filter(Boolean);
  if (!paragraphs.length) throw new Error("本文に段落がありません。");
  return { aozoraWorkId, title, author, paragraphs };
}
