import assert from "node:assert/strict";
import test, { after } from "node:test";
import {
  AI_TIMEOUT_MS,
  MANUAL_REVIEW,
  createApp,
  normalizeAiOutput,
  parseTriageRequest,
  triage,
} from "../server.mjs";

const server = createApp();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

after(() => new Promise((resolve) => server.close(resolve)));

function postTriage(body, { raw = false } = {}) {
  return fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ? body : JSON.stringify(body),
  });
}

test("пустой, отсутствующий и нестроковый text отклоняются с 400", async (t) => {
  const cases = [
    ["пустая строка", { text: "" }],
    ["только пробелы", { text: "   \n\t  " }],
    ["нет поля text", { message: "нужна доставка" }],
    ["text не строка", { text: 42 }],
    ["JSON-массив вместо объекта", ["delivery"]],
    ["JSON null", null],
  ];

  for (const [name, payload] of cases) {
    await t.test(name, async () => {
      const response = await postTriage(payload);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { status: "invalid_input" });
    });
  }
});

test("битый JSON отклоняется с 400 и invalid_input", async () => {
  const response = await postTriage("{ это не json", { raw: true });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { status: "invalid_input" });
});

test("пустое тело запроса отклоняется с 400 и invalid_input", async () => {
  const response = await postTriage("", { raw: true });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { status: "invalid_input" });
});

test("корректный ответ модели возвращается как ready", async () => {
  const response = await postTriage({ text: "  Нужна доставка завтра  " });
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.status, "ready");
  assert.equal(body.topic, "delivery");
  assert.equal(typeof body.draft, "string");
  assert.ok(body.draft.trim().length > 0, "черновик не должен быть пустым");
});

test("тема pricing определяется по тексту заявки", async () => {
  const response = await postTriage({ text: "Цена доставки?" });
  const body = await response.json();
  assert.equal(body.status, "ready");
  assert.equal(body.topic, "pricing");
});

test("любой сбой имитатора даёт manual_review без темы и черновика", async (t) => {
  const cases = [
    ["таймаут модели", "[timeout] нужна доставка"],
    ["исключение модели", "[error]"],
    ["ответ не JSON", "[bad-json]"],
    ["недопустимая тема", "[bad-topic]"],
    ["пустой черновик", "[empty-draft]"],
  ];

  for (const [name, text] of cases) {
    await t.test(name, async () => {
      const startedAt = Date.now();
      const response = await postTriage({ text });
      const elapsedMs = Date.now() - startedAt;

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), MANUAL_REVIEW);

      if (name === "таймаут модели") {
        assert.ok(
          elapsedMs < 1000,
          `таймаут должен срабатывать быстро, а не ждать имитатор 1200 мс (получено ${elapsedMs} мс)`,
        );
      }
    });
  }
});

test("таймаут в 300 мс ограничивает даже зависшую модель", async () => {
  const startedAt = Date.now();
  const result = await triage("Нужна доставка", {
    classify: () => new Promise(() => {}),
  });
  const elapsedMs = Date.now() - startedAt;

  assert.deepEqual(result, MANUAL_REVIEW);
  assert.ok(
    elapsedMs >= AI_TIMEOUT_MS - 20,
    `ожидание ${elapsedMs} мс короче таймаута ${AI_TIMEOUT_MS} мс`,
  );
  assert.ok(
    elapsedMs < AI_TIMEOUT_MS + 500,
    `ожидание ${elapsedMs} мс сильно больше таймаута ${AI_TIMEOUT_MS} мс`,
  );
});

test("normalizeAiOutput отбрасывает пустой черновик и чужие темы", () => {
  assert.equal(normalizeAiOutput("not json"), null);
  assert.equal(normalizeAiOutput(JSON.stringify({ topic: "refund", draft: "ok" })), null);
  assert.equal(normalizeAiOutput(JSON.stringify({ topic: "other", draft: "   " })), null);
  assert.equal(normalizeAiOutput(JSON.stringify({ topic: "other", draft: 7 })), null);
  assert.deepEqual(
    normalizeAiOutput(JSON.stringify({ topic: "other", draft: "  Ответ  " })),
    { topic: "other", draft: "Ответ" },
  );
});

test("parseTriageRequest обрезает пробелы и не принимает пустую строку", () => {
  assert.deepEqual(parseTriageRequest('{"text":"  привет  "}'), { text: "привет" });
  assert.equal(parseTriageRequest('{"text":"   "}'), null);
  assert.equal(parseTriageRequest("null"), null);
});

test("страница отдаётся по GET / и содержит блок для черновика", async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);

  const page = await response.text();
  assert.match(page, /id="draft"/);
  assert.match(page, /manual_review/);
});
