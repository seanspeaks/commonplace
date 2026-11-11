export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface LlmUsage {
  calls: number;
  tokensIn: number;
  tokensOut: number;
}

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Any OpenAI-compatible chat completions API: OpenAI, OpenRouter, Together, Groq, Ollama, vLLM... */
export class Llm {
  readonly usage: LlmUsage = { calls: 0, tokensIn: 0, tokensOut: 0 };
  private jsonMode = true;

  constructor(readonly config: LlmConfig) {}

  async json(system: string, user: string): Promise<unknown> {
    let res = await this.post(system, user);
    if (res.status === 400 && this.jsonMode) {
      // Some providers reject response_format. Ask for JSON in the prompt alone from here on.
      this.jsonMode = false;
      res = await this.post(system, user);
    }
    if (!res.ok) throw new Error(`Inference provider returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as ChatResponse;
    this.usage.calls += 1;
    this.usage.tokensIn += body.usage?.prompt_tokens ?? 0;
    this.usage.tokensOut += body.usage?.completion_tokens ?? 0;
    const content = body.choices?.[0]?.message?.content ?? '';
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('Inference provider did not return a JSON object');
    return JSON.parse(content.slice(start, end + 1));
  }

  private post(system: string, user: string): Promise<Response> {
    return fetch(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}) },
      body: JSON.stringify({
        model: this.config.model,
        temperature: 0,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        ...(this.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(90_000),
    });
  }
}
