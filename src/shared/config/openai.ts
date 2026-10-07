import 'dotenv/config';

export function getOpenAIApiKey(): string | undefined {
  return process.env.OPENAI_API_KEY;
}

export function assertOpenAIConfig(): string {
  const apiKey = getOpenAIApiKey();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required to run the agent workflow.');
  }
  return apiKey;
}
