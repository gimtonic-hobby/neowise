import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));

export const AI_TIMEOUT_MS = 300;
export const MAX_BODY_BYTES = 64 * 1024;

const ALLOWED_TOPICS = new Set(["delivery", "pricing", "other"]);

export const INVALID_INPUT = Object.freeze({ status: "invalid_input" });
export const MANUAL_REVIEW = Object.freeze({
  status: "manual_review",
  topic: null,
  draft: null,
});

function sendJson(response, status, body) {
  if (response.headersSent) {
    response.end();
    return;
  }
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  response.end(payload);
}

async function readBody(request) {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Возвращает { text } для корректного ввода и null для пустого,
 * отсутствующего, нестрокового или битого JSON.
 */
export function parseTriageRequest(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  if (typeof body.text !== "string") return null;
  const text = body.text.trim();
  if (text === "") return null;
  return { text };
}

/**
 * Приводит ответ модели к { topic, draft } или возвращает null,
 * если ответ не JSON, тема не входит в список или черновик пуст.
 */
export function normalizeAiOutput(output) {
  if (typeof output !== "string") return null;

  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const { topic, draft } = parsed;
  if (typeof topic !== "string" || !ALLOWED_TOPICS.has(topic)) return null;
  if (typeof draft !== "string") return null;

  const trimmedDraft = draft.trim();
  if (trimmedDraft === "") return null;

  return { topic, draft: trimmedDraft };
}

/**
 * Ждёт модель не дольше timeoutMs. Любой сбой (таймаут, исключение,
 * неожиданный ответ) превращается в manual_review.
 */
export async function triage(
  text,
  { timeoutMs = AI_TIMEOUT_MS, classify: classifyFn = classify } = {},
) {
  const controller = new AbortController();
  let timer;

  // Promise.race ограничивает ожидание, даже если модель игнорирует signal.
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("ai_timeout"));
    }, timeoutMs);
  });

  try {
    const output = await Promise.race([
      Promise.resolve().then(() => classifyFn(text, { signal: controller.signal })),
      timeout,
    ]);
    const normalized = normalizeAiOutput(output);
    return normalized === null ? MANUAL_REVIEW : { status: "ready", ...normalized };
  } catch {
    return MANUAL_REVIEW;
  } finally {
    clearTimeout(timer);
  }
}

async function handleTriage(request, response) {
  let raw = null;
  try {
    raw = await readBody(request);
  } catch {
    raw = null;
  }

  const input = raw === null ? null : parseTriageRequest(raw);
  if (input === null) {
    return sendJson(response, 400, INVALID_INPUT);
  }

  const result = await triage(input.text);
  return sendJson(response, 200, result);
}

export function createApp() {
  return createServer(async (request, response) => {
    try {
      const { pathname } = new URL(request.url ?? "/", "http://127.0.0.1");

      if (request.method === "GET" && pathname === "/") {
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": Buffer.byteLength(html),
          "Cache-Control": "no-store",
        });
        response.end(html);
        return;
      }

      if (request.method === "POST" && pathname === "/api/triage") {
        await handleTriage(request, response);
        return;
      }

      sendJson(response, 404, { status: "not_found" });
    } catch {
      sendJson(response, 500, { status: "server_error" });
    }
  });
}

const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryPoint) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, "127.0.0.1", () => {
    console.log(`Сервер запущен: http://127.0.0.1:${port}`);
  });
}
