import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
/**
 * Загружает inline-скрипт index.html в фейковый DOM, чтобы проверить
 * реальное поведение страницы без браузера и без зависимостей.
 */
function loadTriagePage() {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const match = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  assert.ok(match, "на странице должен быть module-скрипт");

  function makeElement(name) {
    return {
      name,
      textContent: "",
      value: "",
      hidden: false,
      disabled: false,
      dataset: {},
      listeners: new Map(),
      addEventListener(type, handler) {
        this.listeners.set(type, handler);
      },
      querySelector() {
        return null;
      },
      focus() {},
    };
  }

  const form = makeElement("form");
  const input = makeElement("#message");
  const status = makeElement("#status");
  const result = makeElement("#result");
  const topic = makeElement("#topic");
  const draft = makeElement("#draft");
  const button = makeElement("button");
  const elements = { form, input, status, result, topic, draft, button };

  form.querySelector = (selector) => (selector === "button" ? button : null);

  const bySelector = {
    form,
    "#message": input,
    "#status": status,
    "#result": result,
    "#topic": topic,
    "#draft": draft,
  };
  const documentStub = { querySelector: (selector) => bySelector[selector] ?? null };

  const calls = [];
  let reply = { status: 200, body: null };

  async function fetchStub(url, options) {
    calls.push({ url, options });
    return { status: reply.status, json: async () => reply.body };
  }

  // Скрипт страницы не содержит import/export, поэтому его можно выполнить
  // как обычную функцию, подменив document и fetch.
  const runPage = new Function("document", "fetch", match[1]);
  runPage(documentStub, fetchStub);

  return {
    elements,
    calls,
    respondWith({ status = 200, body = null }) {
      reply = { status, body };
    },
    async submit() {
      const handler = form.listeners.get("submit");
      assert.ok(handler, "форма должна обрабатывать submit");
      await handler({ preventDefault() {} });
    },
  };
}

test("сбой manual_review очищает предыдущий черновик на странице", async () => {
  const page = loadTriagePage();
  page.elements.input.value = "Нужна доставка";
  page.elements.topic.textContent = "Доставка";
  page.elements.draft.textContent = "Старый черновик";
  page.elements.result.hidden = false;
  page.respondWith({ status: 200, body: { status: "manual_review", topic: null, draft: null } });

  await page.submit();

  assert.equal(page.elements.topic.textContent, "");
  assert.equal(page.elements.draft.textContent, "");
  assert.equal(page.elements.result.hidden, true);
  assert.match(page.elements.status.textContent, /вручную/);
  assert.equal(page.elements.button.disabled, false);
});

test("ответ не-JSON очищает предыдущий черновик и показывает ручной разбор", async () => {
  const page = loadTriagePage();
  page.elements.input.value = "Заявка";
  page.elements.draft.textContent = "Старый черновик";
  page.elements.result.hidden = false;
  page.respondWith({ status: 200, body: null });

  await page.submit();

  assert.equal(page.elements.draft.textContent, "");
  assert.equal(page.elements.result.hidden, true);
  assert.match(page.elements.status.textContent, /вручную/);
});

test("пустой ввод очищает черновик и не обращается к API", async () => {
  const page = loadTriagePage();
  page.elements.draft.textContent = "Старый черновик";
  page.elements.result.hidden = false;

  await page.submit();

  assert.equal(page.calls.length, 0);
  assert.equal(page.elements.draft.textContent, "");
  assert.equal(page.elements.result.hidden, true);
  assert.match(page.elements.status.textContent, /Введите текст заявки/);
});

test("успех заменяет старый черновик новым", async () => {
  const page = loadTriagePage();
  page.elements.input.value = "Цена доставки?";
  page.elements.draft.textContent = "Старый черновик";
  page.respondWith({
    status: 200,
    body: { status: "ready", topic: "pricing", draft: "Новый черновик" },
  });

  await page.submit();

  assert.equal(page.elements.topic.textContent, "Стоимость");
  assert.equal(page.elements.draft.textContent, "Новый черновик");
  assert.equal(page.elements.result.hidden, false);
});