import { randomUUID } from 'node:crypto';
import PDFDocument from 'pdfkit';
import type { AiAnalysisResponse, Report } from '../types/index.js';
import { getAlerts, getParcel, saveReport, uploadReportPdf } from './firebase.js';

export async function generateAndStoreReport(
  userId: string,
  parcelId: string,
  analysis: AiAnalysisResponse,
): Promise<Report> {
  const parcel = await getParcel(userId, parcelId);
  const alerts = await getAlerts(userId);
  const zoneHistory = alerts
    .filter((a) => a.parcelId === parcelId)
    .slice(0, 30);

  const reportId = randomUUID();
  const buffer = await buildPdfReport({
    parcelName: parcel?.name ?? parcelId,
    cropType: parcel?.cropType ?? 'unknown',
    analysis,
    zoneHistory,
  });
  validatePdfBuffer(buffer);

  const storagePath = await uploadReportPdf(userId, reportId, buffer);

  const report: Report = {
    reportId,
    userId,
    parcelId,
    severity: analysis.severity,
    diagnosis: analysis.diagnosis,
    npkFormula: analysis.recommendedNpkFormula,
    storagePath,
    createdAt: new Date().toISOString(),
  };

  await saveReport(userId, report);
  return report;
}

interface PdfInput {
  parcelName: string;
  cropType: string;
  analysis: AiAnalysisResponse;
  zoneHistory: { createdAt: string; message: string; severity: number }[];
}

function buildPdfReport(input: PdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks: Buffer[] = [];

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).text('Qhiro Symbiotic — Informe de análisis del cultivo', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Parcela: ${input.parcelName}`);
    doc.text(`Tipo de cultivo: ${input.cropType}`);
    doc.text(`Generado: ${new Date().toISOString()}`);
    doc.moveDown();

    doc.fontSize(14).text('Diagnóstico de IA');
    doc.fontSize(11).text(input.analysis.diagnosis);
    doc.moveDown();

    doc.fontSize(14).text('Nivel de severidad');
    doc.fontSize(11).text(String(input.analysis.severity));
    doc.moveDown();

    doc.fontSize(14).text('Fórmula NPK recomendada');
    const npk = input.analysis.recommendedNpkFormula;
    doc.fontSize(11).text(`N: ${npk.nitrogen} | P: ${npk.phosphorus} | K: ${npk.potassium}`);
    doc.moveDown();

    doc.fontSize(14).text('Acción recomendada');
    doc.fontSize(11).text(input.analysis.recommendedAction);
    doc.moveDown();

    doc.fontSize(14).text('Historial de zona (últimos 30 días)');
    if (input.zoneHistory.length === 0) {
      doc.fontSize(11).text('No hay alertas recientes registradas.');
    } else {
      for (const entry of input.zoneHistory) {
        doc.fontSize(10).text(`${entry.createdAt} — [${entry.severity}] ${entry.message}`);
      }
    }

    doc.moveDown();
    doc.fontSize(10).text('Imagen del dron: adjunta mediante el flujo de captura de vuelo.');

    doc.end();
  });
}

function validatePdfBuffer(buffer: Buffer): void {
  const header = buffer.subarray(0, 5).toString('utf-8');
  const trailer = buffer.subarray(Math.max(0, buffer.length - 1024)).toString('latin1');

  if (header !== '%PDF-' || !trailer.includes('%%EOF')) {
    throw new Error('Generated report is not a valid PDF document.');
  }
}
