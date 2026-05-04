import type { IncomingMessage, ServerResponse } from "node:http";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import * as piAi from "@mariozechner/pi-ai";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { handleDirectChatCompletions } from "./direct-passthrough.js";

// Mocks
vi.mock("./http-utils.js", () => ({
  resolveDirectPassthroughModel: vi.fn(),
}));

vi.mock("../agents/pi-embedded-runner/model.js", () => ({
  resolveModelAsync: vi.fn(),
}));

vi.mock("../agents/simple-completion-transport.js", () => ({
  prepareModelForSimpleCompletion: vi.fn((p) => p.model),
}));

vi.mock("../agents/provider-transport-stream.js", () => ({
  createBoundaryAwareStreamFnForModel: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  streamSimple: vi.fn(),
  completeSimple: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  logWarn: vi.fn(),
}));

const { resolveDirectPassthroughModel } = await import("./http-utils.js");
const { resolveModelAsync } = await import("../agents/pi-embedded-runner/model.js");

describe("direct passthrough", () => {
  let req: Partial<IncomingMessage>;
  let res: Partial<ServerResponse>;

  beforeEach(() => {
    req = { on: vi.fn(), off: vi.fn(), headers: {} };
    res = {
      setHeader: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      writeHead: vi.fn((_code: number) => _code),
      writableEnded: false,
    } as Partial<ServerResponse>;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns false when x-openclaw-direct-model is absent", async () => {
    (resolveDirectPassthroughModel as any).mockReturnValue(undefined);
    const result = await handleDirectChatCompletions(
      req as IncomingMessage,
      res as ServerResponse,
      { model: "openclaw", messages: [], stream: false },
    );
    expect(result).toBe(false);
  });

  it("returns 400 for unknown provider/model", async () => {
    (resolveDirectPassthroughModel as any).mockReturnValue({ provider: "fake", modelId: "model" });
    (resolveModelAsync as any).mockResolvedValue({
      error: "not found",
      authStorage: {},
      modelRegistry: {},
    });

    let code = 0;
    let body: unknown = null;

    const mockRes: any = {
      ...res,
      get statusCode() {
        return code;
      },
      set statusCode(v: number) {
        code = v;
      },
      end: vi.fn((d: string) => {
        body = d ? JSON.parse(d) : null;
      }),
    };

    const result = await handleDirectChatCompletions(
      req as IncomingMessage,
      mockRes as ServerResponse,
      { model: "openclaw", messages: [{ role: "user", content: "hi" }], stream: false },
    );
    expect(result).toBe(true);
    expect(code).toBe(400);
    expect(body).toMatchObject({
      error: { message: expect.stringContaining("not found"), type: "invalid_request_error" },
    });
  });

  it("extracts output_text blocks (OpenAI-style) and returns JSON with X-OpenClaw-Chat-Route", async () => {
    (resolveDirectPassthroughModel as any).mockReturnValue({
      provider: "openai",
      modelId: "gpt-4o-mini",
    });
    (resolveModelAsync as any).mockResolvedValue({
      model: { api: "openai-completions", provider: "openai", id: "gpt-4o-mini" },
      error: undefined,
    });

    const assistantMsg = {
      role: "assistant",
      content: [{ type: "output_text", text: "Hi from output_text" }],
      stopReason: "stop",
      api: "openai-completions",
      provider: "openai",
      model: "gpt-4o-mini",
      usage: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: Date.now(),
    } as AssistantMessage;

    vi.mocked(piAi.completeSimple).mockResolvedValue(assistantMsg);

    let code = 0;
    let body: unknown = null;
    const mockRes: any = {
      ...res,
      set statusCode(v: number) {
        code = v;
      },
      get statusCode() {
        return code;
      },
      setHeader: vi.fn(),
      end: vi.fn((d: string) => {
        body = d ? JSON.parse(d) : null;
      }),
    };

    const result = await handleDirectChatCompletions(
      req as IncomingMessage,
      mockRes as ServerResponse,
      { model: "openclaw/main", messages: [{ role: "user", content: "hi" }], stream: false },
    );
    expect(result).toBe(true);
    expect(
      (body as { choices: Array<{ message: { content: string } }> }).choices[0].message.content,
    ).toBe("Hi from output_text");
    expect(mockRes.setHeader).toHaveBeenCalledWith("X-OpenClaw-Chat-Route", "direct-passthrough");
  });

  it("extracts pi-ai ThinkingContent when no text blocks (keeps direct passthrough)", async () => {
    (resolveDirectPassthroughModel as any).mockReturnValue({
      provider: "ollama",
      modelId: "gemma",
    });
    (resolveModelAsync as any).mockResolvedValue({
      model: { api: "openai-completions", provider: "ollama", id: "gemma" },
      error: undefined,
    });

    const assistantMsg = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "model is gemma" }],
      stopReason: "stop",
      api: "openai-completions",
      provider: "ollama",
      model: "gemma",
      usage: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: Date.now(),
    } as AssistantMessage;

    vi.mocked(piAi.completeSimple).mockResolvedValue(assistantMsg);

    let code = 0;
    let body: unknown = null;
    const mockRes: any = {
      ...res,
      set statusCode(v: number) {
        code = v;
      },
      get statusCode() {
        return code;
      },
      setHeader: vi.fn(),
      end: vi.fn((d: string) => {
        body = d ? JSON.parse(d) : null;
      }),
    };

    const result = await handleDirectChatCompletions(
      req as IncomingMessage,
      mockRes as ServerResponse,
      { model: "openclaw/main", messages: [{ role: "user", content: "hi" }], stream: false },
    );
    expect(result).toBe(true);
    expect(
      (body as { choices: Array<{ message: { content: string } }> }).choices[0].message.content,
    ).toBe("model is gemma");
    expect(mockRes.setHeader).toHaveBeenCalledWith("X-OpenClaw-Chat-Route", "direct-passthrough");
  });

  it("returns false when completeSimple yields no extractable text (fall back to agent path)", async () => {
    (resolveDirectPassthroughModel as any).mockReturnValue({ provider: "openai", modelId: "x" });
    (resolveModelAsync as any).mockResolvedValue({
      model: { api: "openai-completions", provider: "openai", id: "x" },
      error: undefined,
    });

    vi.mocked(piAi.completeSimple).mockResolvedValue({
      role: "assistant",
      content: [{ type: "toolcall", name: "noop", arguments: "{}", id: "1" }],
      stopReason: "stop",
      api: "openai-completions",
      provider: "openai",
      model: "x",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: Date.now(),
    } as AssistantMessage);

    const result = await handleDirectChatCompletions(
      req as IncomingMessage,
      res as ServerResponse,
      { model: "openclaw/main", messages: [{ role: "user", content: "hi" }], stream: false },
    );
    expect(result).toBe(false);
    expect(res.end).not.toHaveBeenCalled();
  });
});
