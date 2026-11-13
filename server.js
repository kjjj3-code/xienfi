import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const PASSWORD = process.env.APP_PASSWORD || "";
// 비밀번호를 설정했다면 폰 등 다른 기기에서도 접속할 수 있게 엽니다.
const HOST = process.env.HOST || (PASSWORD ? "0.0.0.0" : "127.0.0.1");
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.MODEL || "claude-opus-5-5";
const MOCK = process.env.MOCK === "1";
const MAX_BODY = 20 * 1024 * 1024;

const isLoopback = ["127.0.0.1", "localhost", "::1"].includes(HOST);
if (!isLoopback && !PASSWORD) {
  console.error(
    `HOST=${HOST} 는 다른 기기에서도 접속할 수 있는 주소입니다.\n` +
      "아무나 내 API 키로 번역하지 못하도록 .env 에 APP_PASSWORD 를 설정한 뒤 다시 실행하세요.",
  );
  process.exit(1);
}

const client = MOCK ? null : new Anthropic();

const Region = z.object({
  x: z.number().describe("Left edge of the text area, in pixels of the supplied image"),
  y: z.number().describe("Top edge of the text area, in pixels"),
  width: z.number().describe("Width of the text area, in pixels"),
  height: z.number().describe("Height of the text area, in pixels"),
  type: z.enum(["bubble", "narration", "sfx", "other"]),
  original: z.string().describe("The text exactly as written in the image"),
  translated: z.string().describe("The translation that will be lettered into the same area"),
});
const PageTranslation = z.object({
  source_language: z.string(),
  regions: z.array(Region),
});

const SYSTEM = `You translate comic pages (manga, manhwa, manhua, webtoons) for a typesetting tool.

The tool erases each text area you report and letters your translation into that same rectangle, so the rectangle and the translation both matter:

- Report one region per speech bubble, narration box or standalone caption, in natural reading order for the source language (right-to-left for Japanese manga pages, top-to-bottom for webtoons).
- The rectangle should tightly enclose the lettering itself, not the whole bubble outline: everything inside it gets painted over, so keep bubble borders, tails and artwork outside it, but leave no stray glyphs outside it either. Coordinates are pixels of the image as supplied, origin at the top-left.
- Translate for a reader, not word-for-word: natural spoken dialogue that fits each character's tone, with honorifics, names and running jokes handled consistently across the page. Keep it about as long as the original so it fits the bubble.
- Use line breaks only where a deliberate pause is intended; the tool wraps lines itself.
- Text that is already in the target language, page numbers, watermarks and credits need no region.
- If the page has no translatable text, return an empty regions list.`;

function userPrompt({ width, height, targetLang, includeSfx, notes }) {
  const sfx = includeSfx
    ? "Also translate sound effects and hand-drawn onomatopoeia as type \"sfx\"."
    : "Skip sound effects and hand-drawn onomatopoeia that are part of the artwork.";
  return [
    `This image is ${width}×${height} pixels. Translate its text into ${targetLang}.`,
    sfx,
    notes ? `Notes from the reader (names, glossary, tone preferences):\n${notes}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function translate(body) {
  const { image, mediaType, width, height } = body;
  if (MOCK) {
    await new Promise((r) => setTimeout(r, 600));
    return {
      source_language: "Japanese",
      regions: [
        { x: width * 0.1, y: height * 0.08, width: width * 0.3, height: height * 0.16, type: "bubble", original: "これはテストです", translated: "이건 테스트 번역이에요. 실제 번역이 아닙니다!" },
        { x: width * 0.55, y: height * 0.5, width: width * 0.32, height: height * 0.14, type: "narration", original: "モック", translated: "MOCK 모드" },
      ],
    };
  }

  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    // 모델이 정책상 거절하면 서버가 대체 모델로 같은 요청을 한 번 더 시도합니다.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
          { type: "text", text: userPrompt(body) },
        ],
      },
    ],
    output_config: { format: betaZodOutputFormat(PageTranslation) },
  });

  if (response.stop_reason === "refusal") {
    throw new HttpError(422, "모델이 이 페이지의 번역을 거절했습니다.");
  }
  if (response.stop_reason === "max_tokens") {
    throw new HttpError(422, "글자가 너무 많아 응답이 잘렸습니다. 이미지를 나눠서 올려 보세요.");
  }
  if (!response.parsed_output) {
    throw new HttpError(502, "모델 응답을 해석하지 못했습니다. 다시 시도해 주세요.");
  }
  return response.parsed_output;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function describeError(err) {
  if (err instanceof HttpError) return [err.status, err.message];
  if (err instanceof Anthropic.AuthenticationError)
    return [500, "API 키가 올바르지 않습니다. .env 의 ANTHROPIC_API_KEY 를 확인하세요."];
  if (err instanceof Anthropic.PermissionDeniedError)
    return [500, `이 API 키로는 ${MODEL} 모델을 쓸 수 없습니다.`];
  if (err instanceof Anthropic.NotFoundError)
    return [500, `모델 ${MODEL} 을(를) 찾을 수 없습니다. .env 의 MODEL 값을 확인하세요.`];
  if (err instanceof Anthropic.RateLimitError)
    return [429, "요청 한도에 걸렸습니다. 잠시 후 다시 시도해 주세요."];
  if (err instanceof Anthropic.APIConnectionError)
    return [502, "Anthropic API 에 연결하지 못했습니다. 네트워크를 확인하세요."];
  if (err instanceof Anthropic.APIError) return [502, `API 오류 (${err.status}): ${err.message}`];
  if (/API key|apiKey|authToken/i.test(err?.message || ""))
    return [500, "API 키가 없습니다. .env 파일에 ANTHROPIC_API_KEY 를 넣고 다시 실행하세요."];
  console.error(err);
  return [500, "서버 오류가 발생했습니다."];
}

// ── 인증: 비밀번호를 설정한 경우에만 사용 ─────────────────────────────
const sessionToken = PASSWORD
  ? crypto.createHmac("sha256", PASSWORD).update("manga-translator-session").digest("hex")
  : "";

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function isAuthed(req) {
  if (!PASSWORD) return true;
  const m = /(?:^|;\s*)mt_session=([a-f0-9]+)/.exec(req.headers.cookie || "");
  return !!m && safeEqual(m[1], sessionToken);
}

// ── HTTP ───────────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "이미지가 너무 큽니다.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "잘못된 요청입니다.");
  }
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: "not found" });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "not found" });
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && pathname === "/api/config") {
      return sendJson(res, 200, {
        authRequired: !!PASSWORD,
        authed: isAuthed(req),
        model: MOCK ? "mock" : MODEL,
      });
    }
    if (req.method === "POST" && pathname === "/api/login") {
      const { password } = await readJson(req);
      if (!PASSWORD || (typeof password === "string" && safeEqual(password, PASSWORD))) {
        return sendJson(res, 200, { ok: true }, {
          "Set-Cookie": `mt_session=${sessionToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`,
        });
      }
      await new Promise((r) => setTimeout(r, 800));
      throw new HttpError(401, "비밀번호가 틀렸습니다.");
    }
    if (req.method === "POST" && pathname === "/api/translate") {
      if (!isAuthed(req)) throw new HttpError(401, "로그인이 필요합니다.");
      const body = await readJson(req);
      const ok =
        typeof body.image === "string" &&
        ["image/jpeg", "image/png", "image/webp"].includes(body.mediaType) &&
        body.width > 0 &&
        body.height > 0 &&
        typeof body.targetLang === "string";
      if (!ok) throw new HttpError(400, "잘못된 요청입니다.");
      body.targetLang = body.targetLang.slice(0, 40);
      body.notes = typeof body.notes === "string" ? body.notes.slice(0, 2000) : "";
      return sendJson(res, 200, await translate(body));
    }
    if (req.method === "GET") return serveStatic(req, res, pathname);
    sendJson(res, 405, { error: "method not allowed" });
  } catch (err) {
    const [status, message] = describeError(err);
    sendJson(res, status, { error: message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`만화 번역기 실행 중 → http://localhost:${PORT}`);
  if (!isLoopback) {
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .filter((n) => n && n.family === "IPv4" && !n.internal)
      .map((n) => `http://${n.address}:${PORT}`);
    if (lan.length) console.log(`같은 Wi-Fi 의 폰에서 접속 → ${lan.join("  또는  ")}`);
  }
  console.log(MOCK ? "MOCK 모드: 실제 번역 없이 가짜 결과를 돌려줍니다." : `모델: ${MODEL}`);
  if (PASSWORD) console.log("비밀번호 보호가 켜져 있습니다.");
});
