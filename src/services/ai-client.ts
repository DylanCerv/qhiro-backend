import { env } from '../config/env.js';
import type { AiAnalysisRequest, AiAnalysisResponse } from '../types/index.js';

export async function requestAiAnalysis(payload: AiAnalysisRequest): Promise<AiAnalysisResponse> {
  const response = await fetch(`${env.aiBackendUrl}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`AI backend error (${response.status}): ${text}`);
  }

  return response.json() as Promise<AiAnalysisResponse>;
}
