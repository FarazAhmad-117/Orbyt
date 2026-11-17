import { assertPublicUrl } from "../ssrf";

export type ProviderKind = "anthropic" | "openai" | "gemini" | "ollama";

export interface LlmConfig {
  provider: ProviderKind;
  model: string;
  apiKey: string | null;
  baseUrl: string | null;
}
export interface LlmRequest {
  system?: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  /** Ask the model for a JSON object (best effort; callers still validate the result). */
  json?: boolean;
}
export interface LlmResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/** A provider-side or transport failure. `status` is the provider's HTTP status (0 = network/timeout). */
export class LlmError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

const DEFAULT_URLS: Record<ProviderKind, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  gemini: "https://generativelanguage.googleapis.com",
  ollama: "http://localhost:11434",
};

const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;
const obj = (v: unknown) =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

/** Calls one provider with one prompt. Never puts the API key into an error message. */
export async function callLlm(
  cfg: LlmConfig,
  req: LlmRequest,
): Promise<LlmResult> {
  const base = (cfg.baseUrl ?? DEFAULT_URLS[cfg.provider]).replace(/\/+$/, "");
  // User-supplied endpoints get the SSRF guard (set ORBYT_ALLOW_PRIVATE_URLS=true to use a local
  // Ollama). The vendor defaults are public hosts.
  try {
    await assertPublicUrl(base);
  } catch (err) {
    throw new LlmError((err as Error).message, 0);
  }
  const maxTokens = req.maxTokens ?? 1024;
  const { url, headers, body } = build(cfg, base, req, maxTokens);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new LlmError(
      `Could not reach the ${cfg.provider} endpoint: ${(err as Error).message}`,
      0,
    );
  }
  const raw = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = obj(JSON.parse(raw));
  } catch {
    /* non-JSON body: handled below */
  }
  if (!res.ok) {
    const detail =
      (obj(data.error).message as string | undefined) ??
      (typeof data.error === "string" ? data.error : undefined) ??
      raw.slice(0, 200);
    throw new LlmError(
      `${cfg.provider} answered ${res.status}: ${detail}`,
      res.status,
    );
  }
  return parse(cfg.provider, data);
}

function build(
  cfg: LlmConfig,
  base: string,
  req: LlmRequest,
  maxTokens: number,
): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  switch (cfg.provider) {
    case "anthropic":
      return {
        url: `${base}/v1/messages`,
        headers: {
          "x-api-key": cfg.apiKey ?? "",
          "anthropic-version": "2023-06-01",
        },
        body: {
          model: cfg.model,
          max_tokens: maxTokens,
          ...(req.system ? { system: req.system } : {}),
          ...(req.temperature !== undefined
            ? { temperature: req.temperature }
            : {}),
          messages: [{ role: "user", content: req.user }],
        },
      };
    case "openai":
      return {
        url: `${base}/v1/chat/completions`,
        headers: { authorization: `Bearer ${cfg.apiKey ?? ""}` },
        body: {
          model: cfg.model,
          max_completion_tokens: maxTokens,
          ...(req.temperature !== undefined
            ? { temperature: req.temperature }
            : {}),
          ...(req.json ? { response_format: { type: "json_object" } } : {}),
          messages: [
            ...(req.system ? [{ role: "system", content: req.system }] : []),
            { role: "user", content: req.user },
          ],
        },
      };
    case "gemini":
      return {
        url: `${base}/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`,
        headers: { "x-goog-api-key": cfg.apiKey ?? "" },
        body: {
          ...(req.system
            ? { systemInstruction: { parts: [{ text: req.system }] } }
            : {}),
          contents: [{ role: "user", parts: [{ text: req.user }] }],
          generationConfig: {
            maxOutputTokens: maxTokens,
            ...(req.temperature !== undefined
              ? { temperature: req.temperature }
              : {}),
            ...(req.json ? { responseMimeType: "application/json" } : {}),
          },
        },
      };
    case "ollama":
      return {
        url: `${base}/api/chat`,
        headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {},
        body: {
          model: cfg.model,
          stream: false,
          ...(req.json ? { format: "json" } : {}),
          options: {
            num_predict: maxTokens,
            ...(req.temperature !== undefined
              ? { temperature: req.temperature }
              : {}),
          },
          messages: [
            ...(req.system ? [{ role: "system", content: req.system }] : []),
            { role: "user", content: req.user },
          ],
        },
      };
  }
}

function parse(provider: ProviderKind, d: Record<string, unknown>): LlmResult {
  let text = "";
  let input = 0;
  let output = 0;
  switch (provider) {
    case "anthropic": {
      const blocks = Array.isArray(d.content) ? (d.content as unknown[]) : [];
      text = blocks
        .map((b) => (obj(b).type === "text" ? String(obj(b).text ?? "") : ""))
        .join("");
      input = num(obj(d.usage).input_tokens);
      output = num(obj(d.usage).output_tokens);
      break;
    }
    case "openai": {
      const choice = obj((Array.isArray(d.choices) ? d.choices : [])[0]);
      text = String(obj(choice.message).content ?? "");
      input = num(obj(d.usage).prompt_tokens);
      output = num(obj(d.usage).completion_tokens);
      break;
    }
    case "gemini": {
      const cand = obj((Array.isArray(d.candidates) ? d.candidates : [])[0]);
      const parts = Array.isArray(obj(cand.content).parts)
        ? (obj(cand.content).parts as unknown[])
        : [];
      text = parts.map((p) => String(obj(p).text ?? "")).join("");
      input = num(obj(d.usageMetadata).promptTokenCount);
      output = num(obj(d.usageMetadata).candidatesTokenCount);
      break;
    }
    case "ollama":
      text = String(obj(d.message).content ?? "");
      input = num(d.prompt_eval_count);
      output = num(d.eval_count);
      break;
  }
  if (!text.trim())
    throw new LlmError(`${provider} returned an empty answer`, 502);
  return { text, inputTokens: input, outputTokens: output };
}

/** Pulls a JSON object out of model output that may be wrapped in prose or ``` fences. */
export function parseJsonObject(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1] ?? text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end <= start)
    throw new Error("No JSON object in the answer");
  return JSON.parse(fenced.slice(start, end + 1));
}
