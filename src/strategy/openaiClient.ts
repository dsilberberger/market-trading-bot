import { LLMClient } from './llmProposer';

const defaultModel = process.env.OPENAI_MODEL || 'gpt-4o-mini';

export class OpenAIClient implements LLMClient {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string = defaultModel) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async complete(prompt: string): Promise<string> {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0,
        top_p: 1,
        max_tokens: 800
      })
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`OpenAI error ${resp.status}: ${text}`);
    }
    const json = await resp.json();
    const content = json?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('OpenAI returned empty content');
    }
    return content;
  }
}

export const getLLMClient = (): LLMClient | null => {
  const key = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) return null;
  if (process.env.USE_REAL_LLM?.toLowerCase() === 'true') {
    return new OpenAIClient(key);
  }
  return null;
};
