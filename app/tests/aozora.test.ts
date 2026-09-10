import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { parseAozora } from "../src/aozora.js";

test("Shift_JISの羅生門を復号し、ルビの親文字と段落順を保持する", async () => {
  const work = parseAozora(await readFile("data/127_15260.html"), "127_15260.html");
  assert.equal(work.title, "羅生門");
  assert.equal(work.author, "芥川龍之介");
  assert.equal(work.aozoraWorkId, 127);
  assert.equal(work.paragraphs[0], "ある日の暮方の事である。一人の下人が、羅生門の下で雨やみを待っていた。");
  assert.match(work.paragraphs[1], /^広い門の下には/);
  assert.ok(!work.paragraphs.join("").includes("底本："));
});

test("空段落、ルビ、スクリプトを除き、p内の単独brは段落内改行にする", () => {
  const html = Buffer.from('<meta charset="utf-8"><h1 class="title">題</h1><h2 class="author">著者</h2><div class="main_text"><p>　<ruby>漢字<rp>（</rp><rt>かんじ</rt><rp>）</rp></ruby>　</p><br><p>次<br>最後<script>throw Error()</script></p></div><p>本文外</p>');
  assert.deepEqual(parseAozora(html, "1_2.html").paragraphs, ["漢字", "次\n最後"]);
  assert.throws(() => parseAozora(html, "unknown.html"));
  assert.throws(() => parseAozora(Buffer.from("<html></html>"), "1_2.html"));
});

test("行頭の全角空白と連続brで区切り、HTMLソースの改行では区切らない", () => {
  const html = Buffer.from(`<meta charset="utf-8"><h1 class="title">題</h1><h2 class="author">著者</h2>
    <div class="main_text">
　最初の文。<br />
「だめ」<br />
　次の文。途中の　空白。<br />
<br />
詩の一行目<br />
詩の二行目<br />
<br /><br />
最後の文。
    </div>`);
  assert.deepEqual(parseAozora(html, "1_2.html").paragraphs, [
    "最初の文。\n「だめ」", "次の文。途中の　空白。", "詩の一行目\n詩の二行目", "最後の文。",
  ]);
});

test("人間失格の詩を空行で区切り、四行を一つの段落として保持する", async () => {
  const work = parseAozora(await readFile("data/301_14912.html"), "301_14912.html");
  const stanza = work.paragraphs.filter(p => p.includes("けさ　さめて只に荒涼"));
  assert.deepEqual(stanza, [
    "よべ　酒充ちて我ハートは喜びに充ち\nけさ　さめて只に荒涼\nいぶかし　一夜さの中\n様変りたる此気分よ",
  ]);
});

test("保存済みの全作品を文字化けせずに抽出できる", async () => {
  const files = (await readdir("data")).filter(file => file.endsWith(".html"));
  assert.equal(files.length, 10);
  for (const file of files) {
    const work = parseAozora(await readFile(`data/${file}`), file);
    assert.ok(work.paragraphs.length > 0, file);
    assert.ok(![work.title, work.author, ...work.paragraphs].join("").includes("�"), file);
    assert.ok(work.paragraphs.every(p => p === p.trim() && p.length > 0), file);
  }
});
