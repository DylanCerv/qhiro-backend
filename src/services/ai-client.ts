import { env } from '../config/env.js';
import type { AiAnalysisRequest, AiAnalysisResponse } from '../types/index.js';

async function fetchAiService(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${env.aiBackendUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw new Error(
      'El servicio de IA no está disponible. Verifica que qhiro-backend-ia esté en ejecución.',
    );
  }

  const data = (await response.json().catch(() => ({}))) as {
    detail?: unknown;
    error?: string;
  };

  if (!response.ok) {
    const detail = data.detail;
    const message =
      typeof detail === 'string'
        ? detail
        : data.error ?? `AI backend error (${response.status})`;
    throw new Error(message);
  }

  return data as Record<string, unknown>;
}

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

export async function getAiAdminStatus(): Promise<Record<string, unknown>> {
  return fetchAiService('/admin/ai');
}

export async function setAiAdminModel(modelId: string): Promise<Record<string, unknown>> {
  return fetchAiService('/admin/ai/model', {
    method: 'PUT',
    body: JSON.stringify({ modelId }),
  });
}
