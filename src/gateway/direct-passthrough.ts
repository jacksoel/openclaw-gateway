import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  Api,
  Context,
  Model,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
} from "@mariozechner/pi-ai";
import * as piAi from "@mariozechner/pi-ai";
import { applyLocalNoAuthHeaderOverride, getApiKeyForModel } from "../agents/model-auth.js";
import { resolveModelAsync } from "../agents/pi-embedded-runner/model.js";
import { createBoundaryAwareStreamFnForModel } from "../agents/provider-transport-stream.js";
import { prepareModelForSimpleCompletion } from "../agents/simple-completion-transport.js";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import { sendJson, setSseHeaders, writeDone } from "./http-common.js";
import { resolveDirectPassthroughModel } from "./http-utils.js";

/**
 * Convert a single OpenAI-format message content block to pi-ai format.
 * Handles: string, {type:"text",text:"..."}, {type:"image_url",image_url:{url:"..."}}
 * Returns `null` if the block is unrecognizable.
 */
function convertContentBlock(
  block: unknown,
): { type: "text"; text: string } | { type: "image"; data: string; mimeType: string } | null {
  if (!block || typeof block !== "object") return null;

  const typedBlock = block as Record<string, unknown>;
  const blockType = typedBlock.type;

  // Plain text block
  if (blockType === "text") {
    const text = String(typedBlock.text ?? "");
    return { type: "text", text };
  }

  // Image block (OpenAI format: {type:"image_url", image_url:{url:"data:..."}})
  if (blockType === "image_url") {
    const imageUrlSpec = typedBlock.image_url;
    if (!imageUrlSpec || typeof imageUrlSpec !== "object") return null;
    const url = String((imageUrlSpec as Record<string, unknown>).url ?? "");
    const dataUriMatch = url.match(/^data:(image\/[a-zA-Z0-9+\-.]+);base64,(.+)$/);
    if (dataUriMatch) {
      return {
        type: "image",
        mimeType: dataUriMatch[1]!,
        data: dataUriMatch[2]!,
      };
    }
    // Fallback: if URL is not a data URI, just return null
    return null;
  }

  // If the block is {type:"image",data:"...",mime_type:"..."} (already pi-ai), pass through
  if (blockType === "image") {
    const data = String(typedBlock.data ?? "");
    const mimeType = String(typedBlock.mimeType ?? typedBlock.mime_type ?? "image/jpeg");
    if (data) return { type: "image", data, mimeType };
    return null;
  }

  return null;
}

/**
 * Convert one OpenAI-format message into a pi-ai Message.
 */
function convertMessage(msg: Record<string, unknown>): {
  role: string;
  content: string | unknown[];
} {
  const role = String(msg.role ?? "");
  const rawContent = msg.content;

  // String content — simplest case
  if (typeof rawContent === "string") {
    return { role, content: rawContent };
  }

  // Array of content blocks — multimodal
  if (Array.isArray(rawContent)) {
    const converted = rawContent
      .map(convertContentBlock)
      .filter((b): b is NonNullable<typeof b> => b !== null);
    return { role, content: converted as unknown[] };
  }

  // Fallback
  return { role, content: String(rawContent ?? "") };
}

/**
 * Convert an OpenAI-format messages array into a pi-ai Context.
 *
 * gpt-5.4-mini (and similar tiny vision models) cannot handle images across
 * multiple conversation turns. We keep images only in the **last** message;
 * all earlier multimodal messages are downgraded to text-only.
 */
function buildDirectContext(messages: unknown[]): Context {
  const normalized: Array<{ role: string; content: string | unknown[] }> = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    normalized.push(convertMessage(msg as Record<string, unknown>));
  }

  const systemPrompt = normalized
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .filter(Boolean)
    .join("\n\n");

  const contextMessages = normalized
    .filter((m) => m.role !== "system" && m.role !== "developer")
    .map((m, idx, arr) => {
      const isLast = idx === arr.length - 1;
      let content = m.content;

      // pi-ai's AssistantMessage.content must be an array of content blocks — never a plain string.
      // OpenAI-format history messages arrive with string content; wrap them so transform-messages.js
      // (which calls assistantMsg.content.flatMap) does not crash.
      if (m.role === "assistant" && typeof content === "string") {
        content = content ? [{ type: "text", text: content }] : [];
      }

      // Strip images from all but the last message
      if (!isLast && Array.isArray(content)) {
        content = content
          .filter((block: unknown) => {
            if (!block || typeof block !== "object") return true;
            const t = (block as Record<string, unknown>).type;
            return t !== "image" && t !== "image_url";
          })
          .map((block: unknown) => {
            // If it's a text block, keep it
            if (
              block &&
              typeof block === "object" &&
              (block as Record<string, unknown>).type === "text"
            ) {
              return block;
            }
            return { type: "text", text: "" };
          });
        // If after stripping images there's nothing useful, replace with placeholder
        const hasText = (content as unknown[]).some(
          (b: unknown) =>
            b &&
            typeof b === "object" &&
            typeof (b as Record<string, unknown>).text === "string" &&
            (b as Record<string, unknown>).text !== "",
        );
        if (!hasText) {
          content = "[previous message: image omitted]";
        }
      }
      return { role: m.role, content };
    });

  return {
    systemPrompt: systemPrompt || undefined,
    messages: contextMessages as Context["messages"],
  };
}

/** Write a single SSE line to the response. */
function writeSse(res: ServerResponse, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeChunk(
  res: ServerResponse,
  id: string,
  modelName: string,
  delta: { role?: string; content?: string },
  finishReason: string | null = null,
) {
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

function writeUsage(
  res: ServerResponse,
  id: string,
  modelName: string,
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
) {
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [],
    usage,
  });
}

type DirectPayload = {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  temperature?: unknown;
  max_tokens?: unknown;
  stream_options?: unknown;
  [key: string]: unknown;
};

/** When the client omits `max_tokens`, cap generation so slow VLMs do not stream unbounded completion. */
const DEFAULT_DIRECT_MAX_TOKENS = 2048;

/** TTL for the resolved-model cache: 5 minutes. Config changes are picked up on the next expiry. */
const DIRECT_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

type CachedDirectModel = {
  model: Model<Api>;
  apiKey?: string;
  expiresAt: number;
};

const directModelCache = new Map<string, CachedDirectModel>();

function includeUsage(payload: DirectPayload): boolean {
  const opts = payload.stream_options;
  if (!opts || typeof opts !== "object" || Array.isArray(opts)) return false;
  return (opts as { include_usage?: unknown }).include_usage === true;
}

async function resolveDirectModel(
  provider: string,
  modelId: string,
  cfg: OpenClawConfig,
): Promise<{ model: Model<Api>; apiKey?: string; error?: string }> {
  const cacheKey = `${provider}/${modelId}`;
  const cached = directModelCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { model: cached.model, apiKey: cached.apiKey };
  }

  const resolved = await resolveModelAsync(provider, modelId);
  if (resolved.error) {
    return { model: null as unknown as Model<Api>, error: resolved.error };
  }
  if (!resolved.model) {
    return { model: null as unknown as Model<Api>, error: `Unknown model: ${provider}/${modelId}` };
  }
  // Resolve auth the same way the agent pipeline does so cloud providers (e.g.
  // ollama/:cloud models talking to ollama.com) get the right bearer token.
  const auth = await getApiKeyForModel({ model: resolved.model, cfg });
  const authedModel = applyLocalNoAuthHeaderOverride(resolved.model, auth);
  const model = prepareModelForSimpleCompletion({ model: authedModel, cfg });
  const apiKey = auth.apiKey;

  directModelCache.set(cacheKey, {
    model,
    apiKey,
    expiresAt: Date.now() + DIRECT_MODEL_CACHE_TTL_MS,
  });
  return { model, apiKey };
}

function getStreamFn(
  model: Model<Api>,
): (
  model: Model<Api>,
  context: Context,
  options?: Record<string, unknown>,
) => AssistantMessageEventStream {
  const transportFn = createBoundaryAwareStreamFnForModel(model);
  if (transportFn) return transportFn as ReturnType<typeof getStreamFn>;
  return piAi.streamSimple as ReturnType<typeof getStreamFn>;
}

/**
 * Extract plain text from an AssistantMessage's content blocks.
 * Mirrors `openai-http` / `session-utils` handling: some providers emit `output_text`
 * or `input_text` instead of `text`; treating only `text` yields empty HTTP 200 bodies
 * and forces clients to retry (e.g. Clicky multimodal voice).
 */
function extractTextContent(msg: AssistantMessage): string {
  const raw = msg.content as unknown;
  if (typeof raw === "string") {
    return raw;
  }
  if (!Array.isArray(raw)) {
    return "";
  }
  const textChunks: string[] = [];
  const thinkingChunks: string[] = [];
  for (const part of raw) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const p = part as Record<string, unknown>;
    const type = typeof p.type === "string" ? p.type : "";
    const text = typeof p.text === "string" ? p.text : "";
    const inputText = typeof p.input_text === "string" ? p.input_text : "";
    if (type === "text" || type === "output_text" || type === "input_text") {
      const piece = text || inputText;
      if (piece) {
        textChunks.push(piece);
      }
      continue;
    }
    if (type === "thinking") {
      const thinking = typeof p.thinking === "string" ? p.thinking : "";
      if (thinking) {
        thinkingChunks.push(thinking);
      }
      continue;
    }
    if (inputText) {
      textChunks.push(inputText);
    }
  }
  const primary = textChunks.join("\n").trim();
  if (primary.length > 0) {
    return primary;
  }
  // pi-ai uses `ThinkingContent` for some providers; without this we return "" and
  // openai-http falls through to the agent pipeline (no X-OpenClaw-Chat-Route).
  return thinkingChunks.join("\n").trim();
}

export async function handleDirectChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  payload: DirectPayload,
): Promise<boolean> {
  // Tool-calling requests must use the full agent path; passthrough is chat-only.
  const tools = (payload as { tools?: unknown }).tools;
  if (Array.isArray(tools) && tools.length > 0) {
    return false;
  }

  const directModel = resolveDirectPassthroughModel(req);
  if (!directModel) return false;

  const cfg = loadConfig();
  const { model, apiKey, error } = await resolveDirectModel(
    directModel.provider,
    directModel.modelId,
    cfg,
  );
  if (error || !model) {
    sendJson(res, 400, {
      error: {
        message: error ?? `Unknown model: ${directModel.provider}/${directModel.modelId}`,
        type: "invalid_request_error",
      },
    });
    return true;
  }

  const runId = `chatcmpl_${randomUUID()}`;
  const shouldStream = Boolean(payload.stream);
  const modelName = `${directModel.provider}/${directModel.modelId}`;
  const messages = Array.isArray(payload.messages) ? payload.messages : [];

  if (!shouldStream) {
    try {
      const context = buildDirectContext(messages);
      const result: AssistantMessage = await piAi.completeSimple(model, context, {
        maxTokens:
          typeof payload.max_tokens === "number" ? payload.max_tokens : DEFAULT_DIRECT_MAX_TOKENS,
        temperature: typeof payload.temperature === "number" ? payload.temperature : undefined,
        ...(apiKey ? { apiKey } : {}),
      });
      const content = extractTextContent(result).trim();
      const usage = result.usage ?? { input: 0, output: 0, totalTokens: 0 };

      if (!content) {
        const rawPreview = JSON.stringify(result.content).slice(0, 400);
        const stopReason = result.stopReason ?? "unknown";
        const errorMsg = (result as unknown as { errorMessage?: string }).errorMessage ?? "";
        logWarn(
          `direct-passthrough: completeSimple returned no extractable text (provider=${directModel.provider} model=${directModel.modelId} api=${model.api} baseUrl=${model.baseUrl}) stopReason=${stopReason} errorMessage=${errorMsg} raw_content=${rawPreview}; falling back to agent pipeline`,
        );
        return false;
      }

      // Clicky / clients can log this to confirm `x-openclaw-direct-model` hit the fast path (non-streaming only).
      res.setHeader("X-OpenClaw-Chat-Route", "direct-passthrough");
      sendJson(res, 200, {
        id: runId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: modelName,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: usage.input ?? 0,
          completion_tokens: usage.output ?? 0,
          total_tokens: usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0),
        },
      });
    } catch (err) {
      logWarn(`direct-passthrough: non-streaming completion failed: ${String(err)}`);
      sendJson(res, 500, { error: { message: "internal error", type: "api_error" } });
    }
    return true;
  }

  // Streaming path — X-OpenClaw-Chat-Route must be set BEFORE setSseHeaders because
  // setSseHeaders calls res.flushHeaders(), which commits all headers to the wire.
  res.setHeader("X-OpenClaw-Chat-Route", "direct-passthrough");
  setSseHeaders(res);

  const abortController = new AbortController();
  let cleanupCalled = false;
  const cleanup = () => {
    if (!cleanupCalled) {
      cleanupCalled = true;
      abortController.abort();
    }
  };

  req.on("close", cleanup);
  res.on("close", cleanup);

  void (async () => {
    let wroteRole = false;
    let wroteStopChunk = false;
    let finalContent = "";
    let finalUsage: { input: number; output: number; total: number } | undefined;

    try {
      const context = buildDirectContext(messages);
      const streamFn = getStreamFn(model);
      const eventStream = streamFn(model, context, {
        maxTokens:
          typeof payload.max_tokens === "number" ? payload.max_tokens : DEFAULT_DIRECT_MAX_TOKENS,
        temperature: typeof payload.temperature === "number" ? payload.temperature : undefined,
        signal: abortController.signal,
        ...(apiKey ? { apiKey } : {}),
      });

      for await (const event of eventStream as unknown as AsyncIterable<AssistantMessageEvent>) {
        if (abortController.signal.aborted) break;

        const ev = event as AssistantMessageEvent & {
          type: string;
          delta?: string;
          text?: string;
          message?: AssistantMessage;
          contentIndex?: number;
        };

        if (ev.type === "start") continue;

        if (ev.type === "text_delta") {
          const text = ev.delta ?? "";
          if (!text) continue;

          if (!wroteRole) {
            wroteRole = true;
            writeChunk(res, runId, modelName, { role: "assistant" });
          }

          finalContent += text;
          writeChunk(res, runId, modelName, { content: text });
          continue;
        }

        if (ev.type === "text_start") {
          if (!wroteRole) {
            wroteRole = true;
            writeChunk(res, runId, modelName, { role: "assistant" });
          }
          continue;
        }

        if (ev.type === "done") {
          const usage = ev.message?.usage;
          if (usage) {
            finalUsage = {
              input: usage.input ?? 0,
              output: usage.output ?? 0,
              total: usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0),
            };
          }
          break;
        }

        if (ev.type === "error") {
          logWarn(`direct-passthrough: stream error event`);
          break;
        }
      }

      if (!cleanupCalled && !res.writableEnded) {
        if (!wroteStopChunk) {
          if (!wroteRole && finalContent) {
            writeChunk(res, runId, modelName, { role: "assistant" });
          }
          writeChunk(res, runId, modelName, {}, "stop");
          wroteStopChunk = true;
        }

        if (includeUsage(payload) && finalUsage) {
          writeUsage(res, runId, modelName, {
            prompt_tokens: finalUsage.input,
            completion_tokens: finalUsage.output,
            total_tokens: finalUsage.total,
          });
        }

        writeDone(res);
        res.end();
      }
    } catch (err) {
      logWarn(`direct-passthrough: streaming completion failed: ${String(err)}`);
      if (!cleanupCalled && !res.writableEnded) {
        writeChunk(res, runId, modelName, { content: "Error: internal error" }, "stop");
        writeDone(res);
        res.end();
      }
    } finally {
      cleanup();
      req.off("close", cleanup);
      res.off("close", cleanup);
    }
  })();

  return true;
}
