# hello-semantic-search

青空文庫の段落を自然文で検索する学習用アプリです。Node.js / TypeScript / Express、PostgreSQL 18 + pgvector、OpenAI Embeddings API、Cheerioを使用します。

## 起動と検索

リポジトリ直下の `.env` に `OPENAI_API_KEY` を設定してください。`.env` はGit管理対象外です。

```bash
docker compose up --build -d
# まず羅生門1作品を投入（OpenAI APIの利用料金が発生します）
docker compose run --rm app npm run import -- data/127_15260.html
curl --get 'http://localhost:3000/search' --data-urlencode 'query=行き場を失い、これからどう生きていけばよいか途方に暮れている場面' --data 'limit=10'
```

検索文には、探したい場面や感情を具体的に書きます。例えば「孤独」という単語だけより、「周囲に理解されず、誰とも心を通わせられない寂しさを感じている場面」とすると、求める内容を詳しく指定できます。検索文と意味が近い本文を返す仕組みで、入力した単語が本文に含まれることは必須ではありません。

検索対象は取り込み済みの作品だけです。上の手順では『羅生門』のみが対象になります。作品を横断して試す場合は、下記の全作品投入を実行してください。

`GET /search?query=...&limit=10` は `query` と `results` を返します。各結果には `title`、`author`、`aozora_work_id`、`paragraph_no`、`body`、`distance` が含まれます。コサイン距離 `distance` が小さい順です。HNSWは近似検索です。

queryは空白だけを除く1〜2000文字、limitは1〜50の整数（省略時10）です。不正入力は400、DBまたはEmbedding処理の失敗は502になります。データがなければ結果は空配列です。検索時にもEmbedding APIの利用料金が発生します。

## データ投入

```bash
# data/内の全HTMLを投入
docker compose run --rm app npm run import
# API・DBを使わず、作品名・段落数・先頭段落を確認
docker compose run --rm --no-deps app npm run import -- --dry-run
```

入力は `app/data/作品ID_ファイルID.html`（`.xhtml`も可）です。追加したファイルをコンテナで使う場合は `docker compose build app` で再ビルドしてください。ファイルのダウンロードは行いません。

BufferをCheerioの `loadBuffer()` に渡し、文字コードを判定します。`.main_text` 内のルビの `rt` / `rp` を除去し、親文字を残します。外部CSSやJavaScriptの読み込み・実行はありません。HTMLソース整形用の改行を除去し、`br` を改行として扱います。行頭の全角空白、連続する `br` による空行、ブロック要素の境界で段落を区切ります。単独の `br` は段落内の改行として残します。全角空白を判定してからtrimし、空段落を除いた順に1から段落番号を付けます。本文内の `h1`〜`h6` は除外し、その位置に段落境界を残します。本文外の作品名・著者は引き続き取得します。

形式による段落抽出の後に、Embedding用の分割を行います。`js-tiktoken` の `cl100k_base` で計測し、1,000トークンを超える段落だけ、段落内改行 → 句点・疑問符・感嘆符 → Unicode文字境界の順に分割します。上限は `app/src/chunking.ts` の `MAX_CHUNK_TOKENS` で定義しています。本文の切り捨て、複数段落の結合、オーバーラップは行いません。

全入力ファイルの分割・上限検査を完了してからDB/APIへ接続します。`--dry-run` では形式分割の段落数、保存用の段落数、分割後の最大トークン数を確認できます。

分割後の1段落を1行・1Embeddingとして保存します。`paragraph_no` は原文の段落番号ではなく、分割後の作品内連番（1始まり）です。DB構造は変更しません。APIへは16段落ずつ送信します。モデルは取り込み・検索とも `text-embedding-3-small`、1536次元で固定しています（[OpenAI公式ドキュメント](https://developers.openai.com/api/docs/guides/embeddings)）。

作品ごとにトランザクションを使い、途中で失敗した作品のDB変更をロールバックします。それ以前に完了した作品は残ります。既存の `aozora_work_id` はAPIを呼ばずスキップするので、再実行で重複しません。失敗前に実行したAPI呼び出しの料金は戻らず、再試行時には再度Embeddingを作ります。

## 開発・検証

```bash
docker compose -f compose.yaml -f compose.dev.yaml up --build
```

開発時は `src/` と `scripts/` のみbind mountし、`tsx watch` で起動します。依存変更時は再ビルドが必要です。

```bash
cd app
npm ci
npm run build
npm test
npm run import -- --dry-run
```

テストは保存済みHTMLの抽出と、API・DBをモックした検索処理を検証します。実APIや実DBには接続しません。ビルド成果物は `dist/src/` と `dist/scripts/` に出力されます。

PostgreSQLデータはnamed volumeに保存されます。`db/init/001-schema.sql` は空のDBを初期化するときだけ実行され、既存volumeには自動適用されません。現在のComposeは固定タグ `pgvector/pgvector:0.8.6-pg18-trixie` を使用します。アプリはDBのhealthcheck成功後に起動します。

ORM、migrationツール、認証、フロントエンド、RAG・回答生成は含みません。ポートはローカル学習用に127.0.0.1へbindしています。
