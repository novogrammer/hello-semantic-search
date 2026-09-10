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
  // ソース整形用の改行を先に除去し、br由来の改行と二重に数えない。
  // 行頭の全角空白は、段落開始の判定に使うため残す。
  main.find("*").addBack().contents().each((_, node) => {
    if (node.type === "text") node.data = node.data.replace(/[ \t]*[\r\n]+[ \t]*/g, "");
  });
  // 本文内の見出しだけを除外し、前後の本文の段落境界は残す。
  main.find("h1, h2, h3, h4, h5, h6").replaceWith("\n\n");
  main.find("br").replaceWith("\n");
  main.find("p, div").before("\n\n").after("\n\n");
  main.find("img.gaiji").each((_, element) => { $(element).replaceWith($(element).attr("alt") ?? ""); });
  const paragraphs: string[] = [];
  let lines: string[] = [];
  const flush = () => {
    if (lines.length) paragraphs.push(lines.join("\n"));
    lines = [];
  };
  for (const line of main.text().split("\n")) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^[ \t]*　/.test(line)) flush();
    lines.push(line.trim());
  }
  flush();
  if (!paragraphs.length) throw new Error("本文に段落がありません。");
  return { aozoraWorkId, title, author, paragraphs };
}
