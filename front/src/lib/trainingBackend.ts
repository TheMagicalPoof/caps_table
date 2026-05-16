import type { ProcessedCapPhoto } from '$lib/datasetVision';

const trainingBackendUrl = 'http://127.0.0.1:8787';

export type TrainingBackendStats = {
  images: number;
  annotations: number;
  accepted: number;
  negative: number;
  types: number;
};

export type TrainingAnnotationRecord = {
  id: string;
  accepted: boolean;
  typeId: number | null;
  averageColor: string | null;
  note: string | null;
  cropPath: string | null;
  cropUrl: string | null;
  createdAt: string | null;
  sourceName: string | null;
};

type TrainingAnnotationInput = {
  photo: ProcessedCapPhoto;
  accepted: boolean;
  typeId: number | null;
  note?: string;
  review?: 'accepted' | 'rejected' | 'crop-good' | 'crop-bad';
};

function makeTrainingPayload({ photo, accepted, typeId, note, review }: TrainingAnnotationInput) {
  return {
    source: {
      name: photo.source.name,
      dataUrl: photo.source.dataUrl,
      width: photo.source.width,
      height: photo.source.height,
      processedWidth: photo.source.processedWidth,
      processedHeight: photo.source.processedHeight,
    },
    box: photo.foregroundBox,
    cropDataUrl: photo.cropDataUrl,
    accepted,
    typeId,
    averageColor: photo.averageColor,
    neuralEmbedding: photo.neuralEmbedding,
    note: [note, review ? `review:${review}` : ''].filter(Boolean).join(' | '),
  };
}

export async function getTrainingBackendStats(): Promise<TrainingBackendStats | null> {
  try {
    const response = await fetch(`${trainingBackendUrl}/api/training/stats`);
    if (!response.ok) return null;

    return (await response.json()) as TrainingBackendStats;
  } catch {
    return null;
  }
}

export async function getTrainingAnnotations(accepted: boolean | null, limit = 80): Promise<{
  items: TrainingAnnotationRecord[];
  counts: TrainingBackendStats;
} | null> {
  try {
    const params = new URLSearchParams({ limit: String(limit) });
    if (accepted !== null) params.set('accepted', String(accepted));
    const response = await fetch(`${trainingBackendUrl}/api/training/annotations?${params.toString()}`);
    if (!response.ok) return null;

    return (await response.json()) as { items: TrainingAnnotationRecord[]; counts: TrainingBackendStats };
  } catch {
    return null;
  }
}

export async function recordTrainingAnnotation(input: TrainingAnnotationInput) {
  try {
    const response = await fetch(`${trainingBackendUrl}/api/training/annotations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(makeTrainingPayload(input)),
    });

    return response.ok;
  } catch {
    // The training backend is dev-only. Dataset UI must remain usable when it is not running.
    return false;
  }
}

export async function deleteTrainingAnnotation(id: string) {
  try {
    const response = await fetch(`${trainingBackendUrl}/api/training/annotations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!response.ok) return null;

    return (await response.json()) as { ok: boolean; counts: TrainingBackendStats };
  } catch {
    return null;
  }
}

export async function downloadTrainingModel(): Promise<File | null> {
  try {
    const response = await fetch(`${trainingBackendUrl}/api/training/model`);
    if (!response.ok) return null;

    const blob = await response.blob();
    return new File([blob], 'cap-detector.onnx', {
      type: 'application/octet-stream',
      lastModified: Date.now(),
    });
  } catch {
    return null;
  }
}

export function getTrainingCropUrl(cropUrl: string | null) {
  return cropUrl ? `${trainingBackendUrl}${cropUrl}` : '';
}
