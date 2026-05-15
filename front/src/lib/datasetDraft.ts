export const DATASET_DRAFT_STORAGE_KEY = 'caps-table-dataset-draft-v1';

export type DatasetDraftSample = {
  id: string;
  type_id: number | null;
  averageColor: string;
  averageRgb: [number, number, number];
  cropDataUrl: string;
  sampleCircle?: {
    x: number;
    y: number;
    radius: number;
  };
  histogram: number[];
  quantity?: number;
  sourceName: string;
  note: string;
  createdAt: string;
};

export type DatasetDraft = {
  samples: DatasetDraftSample[];
};

export type DraftCapType = {
  type_id: number;
  color: string;
  count: number;
  diameter?: number;
  label?: string;
  name?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isDraftSample(value: unknown): value is DatasetDraftSample {
  return isRecord(value) && typeof value.id === 'string' && typeof value.averageColor === 'string';
}

export function readDatasetDraft(): DatasetDraft {
  const raw = localStorage.getItem(DATASET_DRAFT_STORAGE_KEY);
  if (!raw) return { samples: [] };

  try {
    const parsed = JSON.parse(raw);
    if (isRecord(parsed) && Array.isArray(parsed.samples)) {
      return {
        samples: parsed.samples.filter(isDraftSample),
      };
    }
  } catch {
    localStorage.removeItem(DATASET_DRAFT_STORAGE_KEY);
  }

  return { samples: [] };
}

export function writeDatasetDraft(samples: DatasetDraftSample[]) {
  localStorage.setItem(DATASET_DRAFT_STORAGE_KEY, JSON.stringify({ samples: normalizeDatasetDraftSamples(samples) }));
}

export function clearDatasetDraft() {
  localStorage.removeItem(DATASET_DRAFT_STORAGE_KEY);
}

export function ensureSampleTypeIds(samples: DatasetDraftSample[]) {
  let nextTypeId =
    Math.max(0, ...samples.map((sample) => sample.type_id).filter((typeId): typeId is number => typeId !== null)) + 1;

  return samples.map((sample) => {
    if (sample.type_id !== null) return sample;
    const typedSample = { ...sample, type_id: nextTypeId };
    nextTypeId += 1;
    return typedSample;
  });
}

function getSampleCreatedTime(sample: DatasetDraftSample) {
  const timestamp = Date.parse(sample.createdAt);
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}

export function normalizeDatasetDraftSamples(samples: DatasetDraftSample[]) {
  const groups = new Map<number, DatasetDraftSample[]>();
  const samplesWithoutType: DatasetDraftSample[] = [];

  for (const sample of samples) {
    if (sample.type_id === null) {
      samplesWithoutType.push(sample);
      continue;
    }

    groups.set(sample.type_id, [...(groups.get(sample.type_id) ?? []), sample]);
  }

  const normalizedSamples = [...groups.entries()].map(([typeId, typeSamples]) => {
    const explicitQuantities = typeSamples
      .map((sample) => sample.quantity)
      .filter((quantity): quantity is number => typeof quantity === 'number');
    const quantity = explicitQuantities.length ? Math.max(...explicitQuantities) : typeSamples.length;
    const keeper = [...typeSamples].sort((a, b) => getSampleCreatedTime(a) - getSampleCreatedTime(b))[0] ?? typeSamples[0];
    const note = keeper.note || typeSamples.find((sample) => sample.note)?.note || '';

    return {
      ...keeper,
      type_id: typeId,
      note,
      quantity,
    };
  });

  return [...normalizedSamples, ...samplesWithoutType];
}

export function getNextTypeId(samples: DatasetDraftSample[]) {
  const usedTypeIds = samples.map((sample) => sample.type_id).filter((typeId): typeId is number => typeId !== null);
  return usedTypeIds.length ? Math.max(...usedTypeIds) + 1 : 1;
}

export function datasetDraftToCapTypes(samples: DatasetDraftSample[], diameter = 30): DraftCapType[] {
  const groups = new Map<number, DraftCapType & { sampleCount: number }>();

  for (const sample of normalizeDatasetDraftSamples(samples)) {
    if (sample.type_id === null) continue;

    const existing = groups.get(sample.type_id);
    if (existing) {
      existing.sampleCount += 1;
      existing.count = Math.max(existing.count, sample.quantity ?? existing.sampleCount);
      continue;
    }

    const label = sample.note.trim() || `type-${sample.type_id}`;
    groups.set(sample.type_id, {
      type_id: sample.type_id,
      color: sample.averageColor,
      count: Math.max(0, sample.quantity ?? 1),
      diameter,
      label,
      name: label,
      sampleCount: 1,
    });
  }

  return [...groups.values()]
    .map(({ sampleCount: _sampleCount, ...type }) => type)
    .sort((a, b) => a.type_id - b.type_id);
}

export function datasetDraftToCapsInventory(samples: DatasetDraftSample[], diameter = 30) {
  const groupedSamples = new Map<number, DatasetDraftSample[]>();
  const normalizedSamples = normalizeDatasetDraftSamples(samples);
  const capTypes = datasetDraftToCapTypes(normalizedSamples, diameter);

  for (const sample of normalizedSamples) {
    if (sample.type_id === null) continue;
    groupedSamples.set(sample.type_id, [...(groupedSamples.get(sample.type_id) ?? []), sample]);
  }

  return {
    version: 2,
    caps: capTypes.flatMap((capType) => {
      const typeSamples = groupedSamples.get(capType.type_id) ?? [];
      return Array.from({ length: capType.count }, (_, index) => {
        const sample = typeSamples[index % Math.max(1, typeSamples.length)];
        return {
          color: sample?.averageColor ?? capType.color,
          diameter,
          image: sample?.cropDataUrl,
          label: capType.label,
          type_id: capType.type_id,
        };
      });
    }),
  };
}
