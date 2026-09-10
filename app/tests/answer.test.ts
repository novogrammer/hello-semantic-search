import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import type OpenAI from "openai";
import type { Response, ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import type { Pool } from "pg";
import { answer, MAX_SEARCH_CALLS } from "../src/answer.js";
import { createApp } from "../src/server.js";
import type { SearchResult } from "../src/search.js";

function call(id: string, query = "坊っちゃんと清の信頼関係") {
  return { type: "function_call" as const, name: "search_aozora", call_id: id, arguments: JSON.stringify({ query }) };
}

function reply(output: unknown[], text = "") {
  return { status: "completed", output, output_text: text } as Response;
}

function finalReply(text = "清は坊っちゃんを大切にしています。[1]") {
  return reply([{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }], text);
}

function row(paragraph_no: number, aozora_work_id = 752): SearchResult {
  return { title: "坊っちゃん", author: "夏目漱石", aozora_work_id, paragraph_no, body: `本文${paragraph_no}`, distance: 0.5 };
}

function fixture(replies: Array<Response | Error>, rows: Array<SearchResult[] | Error> = [[row(1)]]) {
  const requests: ResponseCreateParamsNonStreaming[] = [];
  const queries: string[] = [];
  let dbCalls = 0;
  const openai = {
    responses: { create: async (request: ResponseCreateParamsNonStreaming) => {
      requests.push(structuredClone(request));
      const response = replies.shift();
      if (response instanceof Error) throw response;
      assert.ok(response, "予定外のResponses API呼び出し");
      return response;
    } },
    embeddings: { create: async (request: { input: string[] }) => {
      queries.push(...request.input);
      return { data: [{ index: 0, embedding: Array(1536).fill(0.1) }] };
    } },
  } as unknown as OpenAI;
  const pool = { query: async (_sql: string, params: unknown[]) => {
    dbCalls++;
    assert.equal(params[1], 5);
    const result = rows.shift();
    if (result instanceof Error) throw result;
    assert.ok(result, "予定外のDB呼び出し");
    return { rows: result };
  } } as unknown as Pool;
  return { openai, pool, requests, queries, get dbCalls() { return dbCalls; } };
}

test("初回検索を強制し、応答全体とcall_idに対応した資料を渡して回答する", async () => {
  const reasoning = { type: "reasoning", id: "reasoning-1", summary: [] };
  const first = reply([reasoning, call("call-1")]);
  const f = fixture([first, finalReply()]);
  const result = await answer(f.pool, f.openai, "坊っちゃんと清の関係を教えて");
  assert.deepEqual(f.requests[0].tool_choice, { type: "function", name: "search_aozora" });
  assert.equal(f.requests[1].tool_choice, "auto");
  for (const request of f.requests) {
    assert.equal(request.store, false);
    assert.equal(request.parallel_tool_calls, false);
    assert.equal(request.max_output_tokens, 2000);
    assert.match(request.instructions!, new RegExp(`最大${MAX_SEARCH_CALLS}回`));
    assert.equal(request.tools?.[0].type, "function");
    assert.equal((request.tools?.[0] as { strict: boolean }).strict, true);
  }
  const history = f.requests[1].input as Array<Record<string, unknown>>;
  assert.deepEqual(history.slice(1, 3), first.output);
  assert.equal(history[3].call_id, "call-1");
  assert.equal(history[3].type, "function_call_output");
  assert.deepEqual(JSON.parse(history[3].output as string).sources, result.sources);
  assert.equal(result.sources[0].number, 1);
  assert.ok(!("distance" in result.sources[0]));
  assert.deepEqual(result.searches, [{ query: f.queries[0], source_numbers: [1] }]);
  assert.match(result.answer, /\[1\]/);
});

test("最大3回の検索で資料番号を維持し、4回目の生成では検索を禁止する", async () => {
  const f = fixture([
    reply([call("a", "検索1")]), reply([call("b", "検索2")]), reply([call("c", "検索3")]), finalReply(),
  ], [[row(1), row(2)], [row(2), row(3)], [row(1), row(1, 301)]]);
  const result = await answer(f.pool, f.openai, "質問");
  assert.deepEqual(f.queries, ["検索1", "検索2", "検索3"]);
  assert.equal(f.requests.length, 4);
  assert.equal(f.requests[3].tool_choice, "none");
  assert.deepEqual(result.searches.map(s => s.source_numbers), [[1, 2], [2, 3], [1, 4]]);
  assert.deepEqual(result.sources.map(s => s.number), [1, 2, 3, 4]);
});

test("検索0件をLLMへ渡し、再検索または根拠不足の回答を許可する", async () => {
  const f = fixture([reply([call("a")]), reply([call("b")]), finalReply("資料からは判断できません。")], [[], []]);
  const result = await answer(f.pool, f.openai, "質問");
  assert.deepEqual(result.sources, []);
  assert.deepEqual(result.searches.map(s => s.source_numbers), [[], []]);
  assert.equal(result.answer, "資料からは判断できません。");
});

test("不正なツール呼び出しをDB実行前に拒否する", async t => {
  const invalidOutputs = [
    [{ ...call("a"), name: "unknown" }],
    [call("a"), call("b")],
    [{ type: "web_search_call" }],
    ...["{", "null", "[]", '{}', '{"query":42}', '{"query":" "}', '{"query":"a","extra":1}', JSON.stringify({ query: "a".repeat(2001) })]
      .map(argumentsJson => [{ ...call("a"), arguments: argumentsJson }]),
  ];
  for (const [i, output] of invalidOutputs.entries()) {
    await t.test(`ケース${i}`, async () => {
      const f = fixture([reply(output)]);
      await assert.rejects(answer(f.pool, f.openai, "質問"));
      assert.equal(f.dbCalls, 0);
      assert.equal(f.queries.length, 0);
    });
  }
});

test("検索上限に反する応答でも4回目の検索を実行しない", async () => {
  const f = fixture(["a", "b", "c", "d"].map(id => reply([call(id)])), [[], [], []]);
  await assert.rejects(answer(f.pool, f.openai, "質問"));
  assert.equal(f.dbCalls, 3);
  assert.equal(f.requests.length, 4);
});

test("未完了・空の応答と検索なしの回答を拒否する", async () => {
  for (const response of [{ ...finalReply(), status: "incomplete" } as Response, finalReply("")]) {
    const f = fixture([reply([call("a")]), response]);
    await assert.rejects(answer(f.pool, f.openai, "質問"));
  }
  const f = fixture([finalReply()]);
  await assert.rejects(answer(f.pool, f.openai, "質問"));
  assert.equal(f.dbCalls, 0);
});

test("モデル設定を利用し、別の質問に履歴や資料番号を引き継がない", async () => {
  const original = process.env.OPENAI_ANSWER_MODEL;
  try {
    delete process.env.OPENAI_ANSWER_MODEL;
    const f = fixture([reply([call("a")]), finalReply(), reply([call("b")]), finalReply()], [[row(1)], [row(2)]]);
    await answer(f.pool, f.openai, "質問1");
    assert.equal(f.requests[0].model, "gpt-4.1-mini");
    process.env.OPENAI_ANSWER_MODEL = "custom-model";
    const second = await answer(f.pool, f.openai, "質問2");
    assert.equal(f.requests[2].model, "custom-model");
    assert.deepEqual(f.requests[2].input, [{ role: "user", content: "質問2" }]);
    assert.equal(second.sources[0].number, 1);
    assert.equal(second.sources[0].paragraph_no, 2);
  } finally {
    if (original === undefined) delete process.env.OPENAI_ANSWER_MODEL;
    else process.env.OPENAI_ANSWER_MODEL = original;
  }
});

test("POST /askの入力・JSON・サイズ検証と、成功・障害時のレスポンス", async () => {
  const secret = "internal-sensitive-details";
  const f = fixture([
    reply([call("a")]), finalReply(), new Error(secret), reply([call("b")]), reply([call("c")]),
  ], [[row(1)], new Error(secret)]);
  const server = createApp(f.pool, f.openai).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/ask`;
  const post = (body: string) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  try {
    for (const body of ["{", "null", "[]", "{}", '{"question":3}', '{"question":" "}', JSON.stringify({ question: "a".repeat(2001) })]) {
      assert.equal((await post(body)).status, 400);
    }
    assert.equal((await post(JSON.stringify({ question: "あ".repeat(6000) }))).status, 413);
    assert.equal(f.requests.length, 0);
    const success = await post(JSON.stringify({ question: " 質問 " }));
    assert.equal(success.status, 200);
    const result = await success.json();
    assert.equal(result.question, "質問");
    assert.equal(result.sources[0].number, 1);
    assert.equal(result.searches.length, 1);
    // Responses APIとDBの障害は、いずれも内部情報を出さず502にする。
    for (let i = 0; i < 2; i++) {
      const failure = await post('{"question":"質問"}');
      assert.equal(failure.status, 502);
      assert.ok(!(await failure.text()).includes(secret));
    }
    f.openai.embeddings.create = async () => { throw new Error(secret); };
    const failedEmbedding = await post('{"question":"質問"}');
    assert.equal(failedEmbedding.status, 502);
    assert.ok(!(await failedEmbedding.text()).includes(secret));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
