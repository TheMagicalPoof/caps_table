<script lang="ts">
  import { base } from '$app/paths';
  import {
    clearDatasetDraft,
    ensureSampleTypeIds,
    getNextTypeId as getNextDraftTypeId,
    normalizeDatasetDraftSamples,
    readDatasetDraft,
    writeDatasetDraft,
    type DatasetDraftSample,
  } from '$lib/datasetDraft';
  import {
    findDuplicateCandidates,
    processCapBatchPhoto,
    reprocessCapCrop,
    reprocessCapSampling,
    type DetectionBox,
    type DuplicateCandidate,
    type ProcessedCapPhoto,
    type Rgb,
    type SampleCircle,
    type SampleFingerprint,
  } from '$lib/datasetVision';
  import { detectBrowserLocale, formatCandidateCount as formatLocalizedCandidateCount, t, type Locale } from '$lib/i18n';
  import { clearCapDetectorModel, getCapDetectorModelMeta, saveCapDetectorModel, type CapDetectorModelMeta } from '$lib/neuralCapDetector';
  import {
    deleteTrainingAnnotation,
    downloadTrainingModel,
    getTrainingAnnotations,
    getTrainingBackendStats,
    getTrainingCropUrl,
    recordTrainingAnnotation,
    type TrainingAnnotationRecord,
    type TrainingBackendStats,
  } from '$lib/trainingBackend';
  import { onMount, tick } from 'svelte';

  type DatasetSample = DatasetDraftSample &
    SampleFingerprint & {
    id: string;
    type_id: number | null;
    averageColor: string;
    cropDataUrl: string;
    sampleCircle?: SampleCircle;
    sourceName: string;
    note: string;
    createdAt: string;
  };

  type PendingPhoto = {
    id: string;
    photo: ProcessedCapPhoto;
    duplicateCandidates: DuplicateCandidate[];
    similarPendingCount: number;
    selectedTypeId: number | null;
    note: string;
    trainingGoodBoxKey?: string;
    cropReview?: 'good' | 'bad';
  };

  type DraftTypeGroup = {
    typeId: number;
    note: string;
    quantity: number;
    samples: DatasetSample[];
    colors: string[];
  };

  let samples: DatasetSample[] = [];
  let pendingPhotos: PendingPhoto[] = [];
  const foregroundThreshold = 42;
  let status = '';
  let error = '';
  let detectorModelMeta: CapDetectorModelMeta | null = null;
  let detectorModelSyncing = false;
  let trainingBackendOnline = false;
  let trainingBackendStats: TrainingBackendStats | null = null;
  let trainingAnnotations: TrainingAnnotationRecord[] = [];
  let trainingAnnotationsFilter: 'good' | 'bad' = 'good';
  let trainingAnnotationsBusy = false;
  let trainingBackendLastSync = '';
  let trainingBackendLastSyncOk: boolean | null = null;
  let locale: Locale = 'ru';
  let isDraggingPhoto = false;
  let showDetectionDebug = true;
  let manualAddMode = false;
  let minimapZoom = 1;
  let minimapPanX = 0;
  let minimapPanY = 0;
  let minimapElement: HTMLElement | null = null;
  let cropDrag:
    | {
        pendingId: string;
        mode: 'move' | 'resize';
        startClientX: number;
        startClientY: number;
        startBox: { x: number; y: number; width: number; height: number };
        startPointerRadius: number;
        imageRect: DOMRect;
      }
    | null = null;
  let minimapDrag:
    | {
        startClientX: number;
        startClientY: number;
        startPanX: number;
        startPanY: number;
      }
    | null = null;
  let sampleDrag:
    | {
        pendingId: string;
        mode: 'move' | 'resize';
        startClientX: number;
        startClientY: number;
        startCircle: SampleCircle;
        startPointerRadius: number;
        previewRect: DOMRect;
      }
    | null = null;

  type CropBox = { x: number; y: number; width: number; height: number };
  const datasetSettingsKey = 'caps-table-dataset-settings';

  function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  function clamp(value: number, lower: number, upper: number) {
    return Math.max(lower, Math.min(upper, value));
  }

  function getActivePending() {
    return pendingPhotos[0] ?? null;
  }

  function persistDraft() {
    writeDatasetDraft(samples);
  }

  async function refreshTrainingBackendStatus() {
    const stats = await getTrainingBackendStats();
    trainingBackendOnline = Boolean(stats);
    trainingBackendStats = stats;
  }

  async function syncDetectorModelFromBackend(silent = false) {
    if (detectorModelSyncing) return;

    detectorModelSyncing = true;
    try {
      const file = await downloadTrainingModel();
      if (!file) {
        if (!silent) {
          error = 'Backend ONNX-модель недоступна';
          status = '';
        }
        return;
      }

      detectorModelMeta = await saveCapDetectorModel(file);
      if (!silent) {
        status = `ONNX-модель загружена из backend: ${file.name}`;
        error = '';
      }
    } catch (modelError) {
      if (!silent) {
        error = modelError instanceof Error ? modelError.message : 'Не удалось загрузить ONNX из backend';
        status = '';
      }
    } finally {
      detectorModelSyncing = false;
    }
  }

  async function refreshTrainingAnnotations() {
    if (trainingAnnotationsBusy) return;

    trainingAnnotationsBusy = true;
    const accepted = trainingAnnotationsFilter === 'good';
    const result = await getTrainingAnnotations(accepted, 120);
    trainingAnnotationsBusy = false;

    if (!result) {
      trainingAnnotations = [];
      return;
    }

    trainingAnnotations = result.items;
    trainingBackendStats = result.counts;
    trainingBackendOnline = true;
  }

  async function setTrainingAnnotationsFilter(nextFilter: 'good' | 'bad') {
    trainingAnnotationsFilter = nextFilter;
    await refreshTrainingAnnotations();
  }

  async function removeTrainingAnnotation(id: string) {
    const result = await deleteTrainingAnnotation(id);
    if (!result?.ok) {
      trainingBackendLastSyncOk = false;
      trainingBackendLastSync = 'не удалилось';
      return;
    }

    trainingAnnotations = trainingAnnotations.filter((item) => item.id !== id);
    trainingBackendStats = result.counts;
    trainingBackendLastSyncOk = true;
    trainingBackendLastSync = 'разметка удалена';
  }

  async function sendTrainingAnnotation(
    photo: ProcessedCapPhoto,
    accepted: boolean,
    typeId: number | null,
    note?: string,
    review?: 'accepted' | 'rejected' | 'crop-good' | 'crop-bad',
  ) {
    const ok = await recordTrainingAnnotation({ photo, accepted, typeId, note, review });
    trainingBackendLastSyncOk = ok;
    trainingBackendLastSync = ok
      ? review === 'crop-good'
        ? 'кроп ок'
        : review === 'crop-bad'
          ? 'кроп плохой'
          : accepted
            ? 'пример принят'
            : 'skip принят'
      : 'backend недоступен';
    await refreshTrainingBackendStatus();
    await refreshTrainingAnnotations();
  }

  function getPhotoBoxKey(photo: ProcessedCapPhoto) {
    const box = photo.foregroundBox;
    return [photo.source.name, box.x, box.y, box.width, box.height].map((value) => String(value)).join(':');
  }

  function restoreDraft() {
    samples = normalizeDatasetDraftSamples(ensureSampleTypeIds(readDatasetDraft().samples)) as DatasetSample[];
    persistDraft();
  }

  function getNextTypeId() {
    return getNextDraftTypeId(samples);
  }

  function getDraftQuantityTotal() {
    return getDraftTypeGroups().reduce((sum, group) => sum + group.quantity, 0);
  }

  function getDraftTypeGroups(): DraftTypeGroup[] {
    const groups = new Map<number, DraftTypeGroup>();

    for (const sample of samples) {
      if (sample.type_id === null) continue;

      const group = groups.get(sample.type_id) ?? {
        typeId: sample.type_id,
        note: sample.note,
        quantity: sample.quantity ?? 0,
        samples: [],
        colors: [],
      };
      group.samples.push(sample);
      group.quantity = Math.max(group.quantity, sample.quantity ?? group.samples.length);
      if (!group.colors.includes(sample.averageColor)) {
        group.colors.push(sample.averageColor);
      }
      if (!group.note && sample.note) {
        group.note = sample.note;
      }
      groups.set(sample.type_id, group);
    }

    return [...groups.values()].sort((a, b) => a.typeId - b.typeId);
  }

  function getBaseMinimapLayerSize(minimapRect: DOMRect, photo: ProcessedCapPhoto) {
    const scale = Math.min(minimapRect.width / photo.source.processedWidth, minimapRect.height / photo.source.processedHeight);

    return {
      width: photo.source.processedWidth * scale,
      height: photo.source.processedHeight * scale,
    };
  }

  function focusMinimapOnPhoto(photo: ProcessedCapPhoto) {
    if (!minimapElement) return;

    const minimapRect = minimapElement.getBoundingClientRect();
    if (!minimapRect.width || !minimapRect.height) return;

    const box = photo.foregroundBox;
    const cropRatio = Math.max(box.width / photo.source.processedWidth, box.height / photo.source.processedHeight);
    const nextZoom = clamp(0.58 / Math.max(cropRatio, 0.001), 1, 6);
    const base = getBaseMinimapLayerSize(minimapRect, photo);
    const centerX = (box.x + box.width / 2) / photo.source.processedWidth;
    const centerY = (box.y + box.height / 2) / photo.source.processedHeight;

    minimapZoom = nextZoom;
    minimapPanX = -(centerX - 0.5) * base.width * nextZoom;
    minimapPanY = -(centerY - 0.5) * base.height * nextZoom;
  }

  async function focusActivePendingMinimap() {
    await tick();
    const active = getActivePending();
    if (active) {
      focusMinimapOnPhoto(active.photo);
    } else {
      resetMinimapView();
    }
  }

  function makePendingPhoto(photo: ProcessedCapPhoto, previousPending: PendingPhoto[]): PendingPhoto {
    const comparisonPool: SampleFingerprint[] = [
      ...samples,
      ...pendingPhotos.map((pending) => pending.photo),
      ...previousPending.map((pending) => pending.photo),
    ];
    const allCandidates = findDuplicateCandidates(photo, comparisonPool);

    return {
      id: crypto.randomUUID(),
      photo,
      duplicateCandidates: allCandidates.filter((candidate) => candidate.index < samples.length),
      similarPendingCount: allCandidates.filter((candidate) => candidate.index >= samples.length).length,
      selectedTypeId: null,
      note: '',
    };
  }

  async function processUploadedPhotos(files: File[]) {
    const imageFiles = files.filter((file) => file.type.startsWith('image/'));
    if (!imageFiles.length) {
      error = t(locale, 'imageFileRequired');
      status = '';
      return;
    }

    status = t(locale, 'processingPhotos', { count: imageFiles.length });
    error = '';
    let foundCaps = 0;

    for (let index = 0; index < imageFiles.length; index += 1) {
      const file = imageFiles[index];
      status = t(locale, 'processingPhoto', { current: index + 1, total: imageFiles.length, name: file.name });

      try {
        const processed = await processCapBatchPhoto(file, foregroundThreshold);
        const nextPending: PendingPhoto[] = [];
        for (const photo of processed) {
          nextPending.push(makePendingPhoto(photo, nextPending));
        }
        const shouldFocusNewQueue = !pendingPhotos.length && nextPending.length > 0;
        pendingPhotos = [...pendingPhotos, ...nextPending];
        if (shouldFocusNewQueue) {
          await focusActivePendingMinimap();
        }
        foundCaps += processed.length;
      } catch (photoError) {
        error = photoError instanceof Error ? photoError.message : t(locale, 'processPhotoFailed');
      }
    }

    status = '';
  }

  async function handlePhotoUpload(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    await processUploadedPhotos([...Array.from(input.files ?? [])]);
    input.value = '';
  }

  async function handleDrop(event: DragEvent) {
    event.preventDefault();
    isDraggingPhoto = false;
    await processUploadedPhotos([...Array.from(event.dataTransfer?.files ?? [])]);
  }

  function handlePageDragLeave(event: DragEvent) {
    if (!event.relatedTarget) {
      isDraggingPhoto = false;
    }
  }

  function addPendingSample(pendingId: string) {
    const pending = pendingPhotos.find((item) => item.id === pendingId);
    if (!pending) return;

    const existingTypeId = pending.selectedTypeId;

    if (existingTypeId !== null && samples.some((sample) => sample.type_id === existingTypeId)) {
      const nextQuantity = getTypeQuantity(existingTypeId) + 1;
      samples = samples.map((sample) => {
        if (sample.type_id !== existingTypeId) return sample;

        const trainingEmbeddings = pending.photo.neuralEmbedding?.length
          ? [...(sample.trainingEmbeddings ?? []), pending.photo.neuralEmbedding]
          : sample.trainingEmbeddings;

        return {
          ...sample,
          quantity: nextQuantity,
          trainingEmbeddings,
        };
      });
      samples = normalizeDatasetDraftSamples(samples) as DatasetSample[];
      if (pending.trainingGoodBoxKey !== getPhotoBoxKey(pending.photo)) {
        void sendTrainingAnnotation(pending.photo, true, existingTypeId, pending.note, 'accepted');
      }
      pendingPhotos = pendingPhotos.filter((item) => item.id !== pendingId);
      persistDraft();
      status = t(locale, 'typeQuantityIncreased', { id: existingTypeId });
      void focusActivePendingMinimap();
      return;
    }

    const typeId = existingTypeId ?? getNextTypeId();
    const nextQuantity = 1;
    const sample: DatasetSample = {
      id: crypto.randomUUID(),
      type_id: typeId,
      averageColor: pending.photo.averageColor,
      averageRgb: pending.photo.averageRgb,
      cropDataUrl: pending.photo.cropDataUrl,
      sampleCircle: pending.photo.sampleCircle,
      histogram: pending.photo.histogram,
      neuralEmbedding: pending.photo.neuralEmbedding,
      trainingEmbeddings: pending.photo.neuralEmbedding?.length ? [pending.photo.neuralEmbedding] : undefined,
      sourceName: pending.photo.source.name,
      note: pending.note,
      quantity: nextQuantity,
      createdAt: new Date().toISOString(),
    };

    samples = normalizeDatasetDraftSamples([sample, ...samples]) as DatasetSample[];
    if (pending.trainingGoodBoxKey !== getPhotoBoxKey(pending.photo)) {
      void sendTrainingAnnotation(pending.photo, true, typeId, pending.note, 'accepted');
    }
    pendingPhotos = pendingPhotos.filter((item) => item.id !== pendingId);
    persistDraft();
    status = t(locale, 'sampleAdded');
    void focusActivePendingMinimap();
  }

  function skipPendingSample(pendingId: string) {
    const pending = pendingPhotos.find((item) => item.id === pendingId);
    if (pending) {
      void sendTrainingAnnotation(pending.photo, false, pending.selectedTypeId, pending.note, 'rejected');
    }
    pendingPhotos = pendingPhotos.filter((item) => item.id !== pendingId);
    void focusActivePendingMinimap();
  }

  function updatePendingType(pendingId: string, typeId: number | null) {
    pendingPhotos = pendingPhotos.map((item) => (item.id === pendingId ? { ...item, selectedTypeId: typeId } : item));
  }

  function markCropQuality(pendingId: string, quality: 'good' | 'bad') {
    const pending = pendingPhotos.find((item) => item.id === pendingId);
    if (!pending) return;

    const accepted = quality === 'good';
    const boxKey = getPhotoBoxKey(pending.photo);
    void sendTrainingAnnotation(
      pending.photo,
      accepted,
      pending.selectedTypeId,
      pending.note,
      accepted ? 'crop-good' : 'crop-bad',
    );
    pendingPhotos = pendingPhotos.map((item) =>
      item.id === pendingId
        ? {
            ...item,
            cropReview: quality,
            trainingGoodBoxKey: accepted ? boxKey : item.trainingGoodBoxKey,
          }
        : item,
    );
  }

  function makeCenteredCropBox(centerX: number, centerY: number, sizeInput: number, sourceWidth: number, sourceHeight: number): CropBox {
    const size = clamp(Math.round(sizeInput), 24, Math.min(sourceWidth, sourceHeight));
    const radius = size / 2;
    const x = clamp(centerX, radius, sourceWidth - radius) - radius;
    const y = clamp(centerY, radius, sourceHeight - radius) - radius;

    return {
      x: Math.round(x),
      y: Math.round(y),
      width: size,
      height: size,
    };
  }

  async function applyPendingCrop(pendingId: string, nextBoxInput: CropBox) {
    const pending = pendingPhotos.find((item) => item.id === pendingId);
    if (!pending) return;

    const sourceWidth = pending.photo.source.processedWidth;
    const sourceHeight = pending.photo.source.processedHeight;
    const normalizedBox = {
      x: Math.round(nextBoxInput.x),
      y: Math.round(nextBoxInput.y),
      width: clamp(Math.round(nextBoxInput.width), 24, Math.min(sourceWidth, sourceHeight)),
      height: clamp(Math.round(nextBoxInput.height), 24, Math.min(sourceWidth, sourceHeight)),
    };
    const size = Math.min(normalizedBox.width, normalizedBox.height);
    const nextBox = makeCenteredCropBox(
      normalizedBox.x + normalizedBox.width / 2,
      normalizedBox.y + normalizedBox.height / 2,
      size,
      sourceWidth,
      sourceHeight,
    );

    try {
      const photo = await reprocessCapCrop(pending.photo, nextBox);
      pendingPhotos = pendingPhotos.map((item) =>
        item.id === pendingId
          ? {
              ...item,
              photo,
              duplicateCandidates: findDuplicateCandidates(photo, samples),
            }
          : item,
      );
    } catch (cropError) {
      error = cropError instanceof Error ? cropError.message : t(locale, 'updateCropFailed');
    }
  }

  function makeSampleCircle(centerX: number, centerY: number, radiusInput: number): SampleCircle {
    const radius = clamp(Math.round(radiusInput), 12, 80);

    return {
      x: clamp(Math.round(centerX), radius, 160 - radius),
      y: clamp(Math.round(centerY), radius, 160 - radius),
      radius,
    };
  }

  function getSampleRingStyle(photo: ProcessedCapPhoto) {
    const circle = photo.sampleCircle;
    const diameter = circle.radius * 2;

    return `
      --sx: ${((circle.x - circle.radius) / 160) * 100}%;
      --sy: ${((circle.y - circle.radius) / 160) * 100}%;
      --ss: ${(diameter / 160) * 100}%;
    `;
  }

  async function applyPendingSampleCircle(pendingId: string, nextCircleInput: SampleCircle) {
    const pending = pendingPhotos.find((item) => item.id === pendingId);
    if (!pending) return;

    const nextCircle = makeSampleCircle(nextCircleInput.x, nextCircleInput.y, nextCircleInput.radius);

    try {
      const photo = await reprocessCapSampling(pending.photo, nextCircle);
      pendingPhotos = pendingPhotos.map((item) =>
        item.id === pendingId
          ? {
              ...item,
              photo,
              duplicateCandidates: findDuplicateCandidates(photo, samples),
            }
          : item,
      );
    } catch (sampleError) {
      error = sampleError instanceof Error ? sampleError.message : t(locale, 'updateColorAreaFailed');
    }
  }

  function getMinimapCropStyle(photo: ProcessedCapPhoto) {
    const box = photo.foregroundBox;
    const centerX = ((box.x + box.width / 2) / photo.source.processedWidth) * 100;
    const centerY = ((box.y + box.height / 2) / photo.source.processedHeight) * 100;
    const width = (box.width / photo.source.processedWidth) * 100;
    const height = (box.height / photo.source.processedHeight) * 100;
    const x = centerX - width / 2;
    const y = centerY - height / 2;

    return `
      --x: ${x}%;
      --y: ${y}%;
      --w: ${width}%;
      --h: ${height}%;
    `;
  }

  function getDetectionBoxStyle(photo: ProcessedCapPhoto, box: DetectionBox) {
    const width = (box.width / photo.source.processedWidth) * 100;
    const height = (box.height / photo.source.processedHeight) * 100;
    const x = (box.x / photo.source.processedWidth) * 100;
    const y = (box.y / photo.source.processedHeight) * 100;

    return `
      --x: ${x}%;
      --y: ${y}%;
      --w: ${width}%;
      --h: ${height}%;
    `;
  }

  function getDetectionBoxLabel(stage: DetectionBox['stage']) {
    if (stage === 'manual') return 'ручная область';
    if (stage === 'neural') return 'нейросеть';
    if (stage === 'accepted') return t(locale, 'detectionAccepted');
    if (stage === 'circle') return t(locale, 'detectionCircle');
    if (stage === 'foreground') return t(locale, 'detectionForeground');
    if (stage === 'dense') return t(locale, 'detectionDense');
    return t(locale, 'detectionFallback');
  }

  function isVisibleDetectionBox(box: DetectionBox) {
    return box.stage !== 'foreground' && box.stage !== 'dense';
  }

  function getMinimapLayerStyle(photo: ProcessedCapPhoto, zoom: number, panX: number, panY: number) {
    const isWide = photo.source.processedWidth >= photo.source.processedHeight;

    return `
      --pan-x: ${panX}px;
      --pan-y: ${panY}px;
      --map-zoom: ${zoom};
      --source-aspect: ${photo.source.processedWidth} / ${photo.source.processedHeight};
      --layer-width: ${isWide ? `calc(100% * ${zoom})` : 'auto'};
      --layer-height: ${isWide ? 'auto' : `calc(100% * ${zoom})`};
    `;
  }

  function resetMinimapView() {
    minimapZoom = 1;
    minimapPanX = 0;
    minimapPanY = 0;
  }

  function startCropDrag(event: PointerEvent, pendingId: string, mode: 'move' | 'resize') {
    const pending = pendingPhotos.find((item) => item.id === pendingId);
    const minimap = event.currentTarget instanceof HTMLElement ? event.currentTarget.closest('.minimap') : null;
    if (!pending || !(minimap instanceof HTMLElement)) return;
    const layer = minimap.querySelector('.minimap-layer');
    if (!(layer instanceof HTMLElement)) return;

    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const imageRect = layer.getBoundingClientRect();
    const imageScale = imageRect.width / pending.photo.source.processedWidth;
    const startBox = { ...pending.photo.foregroundBox };
    const startCenterX = startBox.x + startBox.width / 2;
    const startCenterY = startBox.y + startBox.height / 2;
    const pointerSourceX = (event.clientX - imageRect.left) / imageScale;
    const pointerSourceY = (event.clientY - imageRect.top) / imageScale;
    cropDrag = {
      pendingId,
      mode,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startBox,
      startPointerRadius: Math.hypot(pointerSourceX - startCenterX, pointerSourceY - startCenterY),
      imageRect,
    };
  }

  function moveCropDrag(event: PointerEvent) {
    if (!cropDrag) return;

    const pending = pendingPhotos.find((item) => item.id === cropDrag?.pendingId);
    if (!pending) return;

    const imageScale = cropDrag.imageRect.width / pending.photo.source.processedWidth;
    const dx = (event.clientX - cropDrag.startClientX) / imageScale;
    const dy = (event.clientY - cropDrag.startClientY) / imageScale;
    const sourceWidth = pending.photo.source.processedWidth;
    const sourceHeight = pending.photo.source.processedHeight;
    const startCenterX = cropDrag.startBox.x + cropDrag.startBox.width / 2;
    const startCenterY = cropDrag.startBox.y + cropDrag.startBox.height / 2;
    let nextBox: CropBox;

    if (cropDrag.mode === 'move') {
      nextBox = makeCenteredCropBox(startCenterX + dx, startCenterY + dy, cropDrag.startBox.width, sourceWidth, sourceHeight);
    } else {
      const pointerSourceX = (event.clientX - cropDrag.imageRect.left) / imageScale;
      const pointerSourceY = (event.clientY - cropDrag.imageRect.top) / imageScale;
      const pointerRadius = Math.hypot(pointerSourceX - startCenterX, pointerSourceY - startCenterY);
      const radiusDelta = pointerRadius - cropDrag.startPointerRadius;
      const maxCenteredSize = Math.max(
        24,
        2 * Math.min(startCenterX, sourceWidth - startCenterX, startCenterY, sourceHeight - startCenterY),
      );
      nextBox = makeCenteredCropBox(
        startCenterX,
        startCenterY,
        clamp(cropDrag.startBox.width + radiusDelta * 2, 24, maxCenteredSize),
        sourceWidth,
        sourceHeight,
      );
    }
    pendingPhotos = pendingPhotos.map((item) =>
      item.id === pending.id
        ? {
            ...item,
            photo: {
              ...item.photo,
              foregroundBox: nextBox,
            },
          }
        : item,
    );
  }

  async function finishCropDrag() {
    if (!cropDrag) return;

    const pendingId = cropDrag.pendingId;
    cropDrag = null;
    const pending = pendingPhotos.find((item) => item.id === pendingId);
    if (!pending) return;

    await applyPendingCrop(pendingId, pending.photo.foregroundBox);
  }

  async function addManualPendingFromMinimap(event: PointerEvent) {
    const pending = getActivePending();
    const minimap = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    const layer = minimap?.querySelector('.minimap-layer');
    if (!pending || !minimap || !(layer instanceof HTMLElement)) return false;

    const imageRect = layer.getBoundingClientRect();
    const imageScale = imageRect.width / pending.photo.source.processedWidth;
    if (!imageScale) return false;

    const sourceX = (event.clientX - imageRect.left) / imageScale;
    const sourceY = (event.clientY - imageRect.top) / imageScale;
    const sourceWidth = pending.photo.source.processedWidth;
    const sourceHeight = pending.photo.source.processedHeight;
    const size = clamp(
      pending.photo.foregroundBox.width,
      24,
      Math.min(sourceWidth, sourceHeight),
    );
    const nextBox = makeCenteredCropBox(sourceX, sourceY, size, sourceWidth, sourceHeight);

    try {
      const photo = await reprocessCapCrop(pending.photo, nextBox);
      photo.source.detectionBoxes = [
        ...(photo.source.detectionBoxes ?? []),
        {
          ...nextBox,
          stage: 'manual',
        },
      ];
      const manualPending = makePendingPhoto(photo, []);
      pendingPhotos = [manualPending, ...pendingPhotos];
      manualAddMode = false;
      status = 'Manual candidate added';
      error = '';
      await focusActivePendingMinimap();
      return true;
    } catch (manualError) {
      error = manualError instanceof Error ? manualError.message : t(locale, 'updateCropFailed');
      return false;
    }
  }

  function startMinimapDrag(event: PointerEvent) {
    if ((event.target as HTMLElement).closest('.crop-control')) return;

    if (manualAddMode) {
      event.preventDefault();
      void addManualPendingFromMinimap(event);
      return;
    }

    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    minimapDrag = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPanX: minimapPanX,
      startPanY: minimapPanY,
    };
  }

  function moveMinimapDrag(event: PointerEvent) {
    if (!minimapDrag) return;

    minimapPanX = minimapDrag.startPanX + event.clientX - minimapDrag.startClientX;
    minimapPanY = minimapDrag.startPanY + event.clientY - minimapDrag.startClientY;
  }

  function finishMinimapDrag() {
    minimapDrag = null;
  }

  function zoomMinimapAt(event: WheelEvent) {
    const minimap = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    const layer = minimap?.querySelector('.minimap-layer');
    if (!minimap || !(layer instanceof HTMLElement)) return;

    event.preventDefault();
    const before = layer.getBoundingClientRect();
    const minimapRect = minimap.getBoundingClientRect();
    if (!before.width || !before.height || !minimapRect.width || !minimapRect.height) return;

    const nextZoom = clamp(minimapZoom * Math.exp(-event.deltaY * 0.0015), 1, 8);
    if (nextZoom === minimapZoom) return;

    const layerCenterX = before.left + before.width / 2;
    const layerCenterY = before.top + before.height / 2;
    const pointerContentX = (event.clientX - layerCenterX) / minimapZoom;
    const pointerContentY = (event.clientY - layerCenterY) / minimapZoom;
    const minimapCenterX = minimapRect.left + minimapRect.width / 2;
    const minimapCenterY = minimapRect.top + minimapRect.height / 2;

    minimapZoom = nextZoom;
    minimapPanX = event.clientX - minimapCenterX - pointerContentX * nextZoom;
    minimapPanY = event.clientY - minimapCenterY - pointerContentY * nextZoom;
  }

  function startSampleDrag(event: PointerEvent, pendingId: string, mode: 'move' | 'resize') {
    const pending = pendingPhotos.find((item) => item.id === pendingId);
    const preview = event.currentTarget instanceof HTMLElement ? event.currentTarget.closest('.crop-preview') : null;
    if (!pending || !(preview instanceof HTMLElement)) return;

    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const previewRect = preview.getBoundingClientRect();
    const scale = 160 / previewRect.width;
    const pointerX = (event.clientX - previewRect.left) * scale;
    const pointerY = (event.clientY - previewRect.top) * scale;
    sampleDrag = {
      pendingId,
      mode,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startCircle: { ...pending.photo.sampleCircle },
      startPointerRadius: Math.hypot(pointerX - pending.photo.sampleCircle.x, pointerY - pending.photo.sampleCircle.y),
      previewRect,
    };
  }

  function moveSampleDrag(event: PointerEvent) {
    if (!sampleDrag) return;

    const pending = pendingPhotos.find((item) => item.id === sampleDrag?.pendingId);
    if (!pending) return;

    const scale = 160 / sampleDrag.previewRect.width;
    const dx = (event.clientX - sampleDrag.startClientX) * scale;
    const dy = (event.clientY - sampleDrag.startClientY) * scale;
    let nextCircle: SampleCircle;

    if (sampleDrag.mode === 'move') {
      nextCircle = makeSampleCircle(
        sampleDrag.startCircle.x + dx,
        sampleDrag.startCircle.y + dy,
        sampleDrag.startCircle.radius,
      );
    } else {
      const pointerX = (event.clientX - sampleDrag.previewRect.left) * scale;
      const pointerY = (event.clientY - sampleDrag.previewRect.top) * scale;
      const pointerRadius = Math.hypot(pointerX - sampleDrag.startCircle.x, pointerY - sampleDrag.startCircle.y);
      const radiusDelta = pointerRadius - sampleDrag.startPointerRadius;
      const maxRadius = Math.min(
        sampleDrag.startCircle.x,
        160 - sampleDrag.startCircle.x,
        sampleDrag.startCircle.y,
        160 - sampleDrag.startCircle.y,
      );
      nextCircle = makeSampleCircle(
        sampleDrag.startCircle.x,
        sampleDrag.startCircle.y,
        clamp(sampleDrag.startCircle.radius + radiusDelta, 12, maxRadius),
      );
    }

    pendingPhotos = pendingPhotos.map((item) =>
      item.id === pending.id
        ? {
            ...item,
            photo: {
              ...item.photo,
              sampleCircle: nextCircle,
            },
          }
        : item,
    );
  }

  async function finishSampleDrag() {
    if (!sampleDrag) return;

    const pendingId = sampleDrag.pendingId;
    sampleDrag = null;
    const pending = pendingPhotos.find((item) => item.id === pendingId);
    if (!pending) return;

    await applyPendingSampleCircle(pendingId, pending.photo.sampleCircle);
  }

  function updateTypeNote(typeId: number, nextNote: string) {
    samples = samples.map((sample) => (sample.type_id === typeId ? { ...sample, note: nextNote } : sample));
    persistDraft();
  }

  function getTypeQuantity(typeId: number) {
    const typeSamples = samples.filter((sample) => sample.type_id === typeId);
    return Math.max(0, typeSamples[0]?.quantity ?? typeSamples.length);
  }

  function updateTypeQuantity(typeId: number, nextQuantity: number) {
    const quantity = Math.max(0, Math.floor(Number.isFinite(nextQuantity) ? nextQuantity : 0));
    samples = samples.map((sample) => (sample.type_id === typeId ? { ...sample, quantity } : sample));
    persistDraft();
  }

  function adjustTypeQuantity(typeId: number, delta: number) {
    updateTypeQuantity(typeId, getTypeQuantity(typeId) + delta);
  }

  function removeSample(sampleId: string) {
    samples = samples.filter((sample) => sample.id !== sampleId);
    persistDraft();
  }

  function clearDraft() {
    samples = [];
    pendingPhotos = [];
    clearDatasetDraft();
    status = t(locale, 'draftCleared');
  }

  function exportDataset() {
    const dataset = {
      version: 1,
      generated_at: new Date().toISOString(),
      samples: samples.map((sample) => ({
        id: sample.id,
        type_id: sample.type_id,
        quantity: sample.quantity,
        image: sample.cropDataUrl,
        sample_circle: sample.sampleCircle,
        source_name: sample.sourceName,
        average_color: sample.averageColor,
        fingerprint: {
          average_rgb: sample.averageRgb.map((value) => Math.round(value)) as Rgb,
          histogram_rgb_4x4x4: sample.histogram,
          neural_embedding: sample.neuralEmbedding,
          training_embeddings: sample.trainingEmbeddings,
        },
        note: sample.note,
        created_at: sample.createdAt,
      })),
    };
    const blob = new Blob([JSON.stringify(dataset, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'dataset.json';
    link.click();
    URL.revokeObjectURL(url);
  }

  async function importDataset(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    try {
      const parsed = JSON.parse(await file.text());
      const rawSamples = isRecord(parsed) && Array.isArray(parsed.samples) ? parsed.samples : [];
      const importedSamples = rawSamples
        .map((item): DatasetSample | null => {
          if (!isRecord(item)) return null;

          const fingerprint = isRecord(item.fingerprint) ? item.fingerprint : {};
          const averageRgb = Array.isArray(fingerprint.average_rgb)
            ? fingerprint.average_rgb.map(Number).slice(0, 3)
            : [];
          const histogram = Array.isArray(fingerprint.histogram_rgb_4x4x4)
            ? fingerprint.histogram_rgb_4x4x4.map(Number)
            : [];
          const neuralEmbedding = Array.isArray(fingerprint.neural_embedding)
            ? fingerprint.neural_embedding.map(Number).filter(Number.isFinite)
            : undefined;
          const trainingEmbeddings = Array.isArray(fingerprint.training_embeddings)
            ? fingerprint.training_embeddings
                .filter(Array.isArray)
                .map((embedding) => embedding.map(Number).filter(Number.isFinite))
                .filter((embedding) => embedding.length > 0)
            : undefined;
          const image = typeof item.image === 'string' ? item.image : '';
          const averageColor = typeof item.average_color === 'string' ? item.average_color : '';
          const typeId = Number(item.type_id);

          if (!image || !averageColor || averageRgb.length !== 3 || !Number.isFinite(typeId)) return null;

          return {
            id: typeof item.id === 'string' ? item.id : crypto.randomUUID(),
            type_id: typeId,
            quantity: Math.max(0, Math.floor(Number(item.quantity) || 0)),
            averageColor,
            averageRgb: averageRgb as Rgb,
            cropDataUrl: image,
            sampleCircle: isRecord(item.sample_circle) ? (item.sample_circle as SampleCircle) : undefined,
            histogram,
            neuralEmbedding,
            trainingEmbeddings,
            sourceName: typeof item.source_name === 'string' ? item.source_name : file.name,
            note: typeof item.note === 'string' ? item.note : '',
            createdAt: typeof item.created_at === 'string' ? item.created_at : new Date().toISOString(),
          };
        })
        .filter((sample): sample is DatasetSample => Boolean(sample));

      samples = normalizeDatasetDraftSamples(ensureSampleTypeIds(importedSamples)) as DatasetSample[];
      pendingPhotos = [];
      persistDraft();
      status = t(locale, 'importedTypes', { count: getDraftTypeGroups().length });
      error = '';
    } catch (importError) {
      error = importError instanceof Error ? importError.message : t(locale, 'importDatasetFailed');
      status = '';
    } finally {
      input.value = '';
    }
  }

  async function importDetectorModel(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    try {
      detectorModelMeta = await saveCapDetectorModel(file);
      status = `ONNX-модель сохранена: ${file.name}`;
      error = '';
    } catch (modelError) {
      error = modelError instanceof Error ? modelError.message : 'Не удалось сохранить ONNX-модель';
      status = '';
    } finally {
      input.value = '';
    }
  }

  async function removeDetectorModel() {
    await clearCapDetectorModel();
    detectorModelMeta = null;
    status = 'ONNX-модель удалена.';
  }

  function formatSimilarity(score: number) {
    return `${Math.round(Math.max(0, Math.min(1, 1 - score)) * 100)}%`;
  }

  function formatCandidateCount(count: number) {
    return formatLocalizedCandidateCount(locale, count);
  }

  function persistDatasetSettings() {
    localStorage.setItem(datasetSettingsKey, JSON.stringify({ showDetectionDebug }));
  }

  function restoreDatasetSettings() {
    try {
      const rawSettings = localStorage.getItem(datasetSettingsKey);
      if (!rawSettings) return;

      const settings = JSON.parse(rawSettings) as { showDetectionDebug?: unknown };
      if (typeof settings.showDetectionDebug === 'boolean') {
        showDetectionDebug = settings.showDetectionDebug;
      }
    } catch {
      localStorage.removeItem(datasetSettingsKey);
    }
  }

  function setDetectionDebug(nextValue: boolean) {
    showDetectionDebug = nextValue;
    persistDatasetSettings();
  }

  function setManualAddMode(nextValue: boolean) {
    manualAddMode = nextValue;
  }

  onMount(() => {
    locale = detectBrowserLocale();
    document.documentElement.lang = locale;
    detectorModelMeta = getCapDetectorModelMeta();
    restoreDatasetSettings();
    restoreDraft();
    void (async () => {
      await refreshTrainingBackendStatus();
      if (!detectorModelMeta && trainingBackendOnline) {
        await syncDetectorModelFromBackend(true);
      }
    })();
    void refreshTrainingAnnotations();
    const backendStatusInterval = window.setInterval(() => {
      void refreshTrainingBackendStatus();
    }, 5000);

    return () => {
      window.clearInterval(backendStatusInterval);
    };
  });
</script>

<svelte:window
  onpointermove={(event) => {
    moveMinimapDrag(event);
    moveCropDrag(event);
    moveSampleDrag(event);
  }}
  onpointerup={() => {
    finishMinimapDrag();
    finishCropDrag();
    finishSampleDrag();
  }}
  onpointercancel={() => {
    finishMinimapDrag();
    finishCropDrag();
    finishSampleDrag();
  }}
/>

<svelte:head>
  <title>{t(locale, 'datasetTitle')}</title>
  <meta
    name="description"
    content={t(locale, 'datasetDescription')}
  />
  <meta property="og:title" content={t(locale, 'datasetTitle')} />
  <meta
    property="og:description"
    content={t(locale, 'datasetOgDescription')}
  />
</svelte:head>

<main
  class:dragging-files={isDraggingPhoto}
  class="dataset-app"
  data-drop-label={t(locale, 'dropPhotoHere')}
  ondragenter={(event) => {
    event.preventDefault();
    isDraggingPhoto = true;
  }}
  ondragover={(event) => {
    event.preventDefault();
    isDraggingPhoto = true;
  }}
  ondragleave={handlePageDragLeave}
  ondrop={handleDrop}
>
  <header class="topbar">
    <div class="brand">
      <img class="brand-icon" src={`${base}/favicon.png`} alt="" />
      <div class="brand-text">
        <strong>Caps Table</strong>
        <span>{t(locale, 'datasetSubtitle')}</span>
      </div>
    </div>
    <label class="nav-link upload-action" for="photoUpload">{t(locale, 'uploadPhoto')}</label>
    <input id="photoUpload" class="file-input" type="file" accept="image/*" multiple onchange={handlePhotoUpload} />
    <div class="model-control">
      <label class="nav-link model-action" for="detectorModelUpload">ONNX</label>
      <input id="detectorModelUpload" class="file-input" type="file" accept=".onnx,application/octet-stream" onchange={importDetectorModel} />
      <button class="nav-link model-action model-sync" disabled={detectorModelSyncing || !trainingBackendOnline} type="button" onclick={() => syncDetectorModelFromBackend(false)}>
        ONNX ↓
      </button>
      {#if detectorModelMeta}
        <span class="model-name" title={detectorModelMeta.name}>{detectorModelMeta.name}</span>
        <button class="model-clear" type="button" aria-label="Удалить ONNX-модель" onclick={removeDetectorModel}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8" />
          </svg>
        </button>
      {/if}
    </div>
    <div class:online={trainingBackendOnline} class="training-status" title={trainingBackendLastSync || 'training backend'}>
      <span class="training-dot"></span>
      <strong>{trainingBackendOnline ? 'TRAIN' : 'OFF'}</strong>
      {#if trainingBackendStats}
        <span>{trainingBackendStats.accepted}+ / {trainingBackendStats.negative}-</span>
      {/if}
      {#if trainingBackendLastSync}
        <em class:ok={trainingBackendLastSyncOk === true} class:fail={trainingBackendLastSyncOk === false}>{trainingBackendLastSync}</em>
      {/if}
    </div>
    <div class="topbar-actions">
      <nav class="mode-switch" aria-label={t(locale, 'modeNavLabel')}>
        <a class="active" href={`${base}/dataset`}>{t(locale, 'navDataset')}</a>
        <a href={`${base}/layout`}>{t(locale, 'navLayout')}</a>
      </nav>
    </div>
  </header>

  <section class="workspace">

    <section class="review-pane">
      {#if getActivePending()}
        {@const pending = getActivePending()!}
        <section class="current-sample">
          <div class="preview">
            <div class="crop-preview-row">
              <div class="crop-preview">
                <img src={pending.photo.cropDataUrl} alt={t(locale, 'cropPreviewAlt')} />
                <button
                  class="color-sample-ring"
                  aria-label={t(locale, 'moveColorSampleArea')}
                  style={getSampleRingStyle(pending.photo)}
                  onpointerdown={(event) => startSampleDrag(event, pending.id, 'move')}
                >
                  <span class="sample-center"></span>
                  <span
                    class="sample-handle"
                    onpointerdown={(event) => {
                      event.stopPropagation();
                      startSampleDrag(event, pending.id, 'resize');
                    }}
                  ></span>
                </button>
              </div>
              <div class="crop-legend" aria-label={t(locale, 'cropLegendLabel')}>
                <span><i class="legend-detected"></i>{t(locale, 'legendCandidate')}</span>
                <span><i class="legend-crop"></i>{t(locale, 'legendCrop')}</span>
                <span><i class="legend-color"></i>{t(locale, 'legendAverageColor')}</span>
                <span><i class="legend-manual"></i>ручная область</span>
              </div>
            </div>
            <div class:manual-add-mode={manualAddMode} class="minimap" bind:this={minimapElement} onpointerdown={startMinimapDrag} onwheel={zoomMinimapAt}>
              <div class="minimap-layer" style={getMinimapLayerStyle(pending.photo, minimapZoom, minimapPanX, minimapPanY)}>
                <img draggable="false" src={pending.photo.source.dataUrl} alt={t(locale, 'sourcePhotoAlt')} />
                {#if showDetectionDebug}
                  {#each (pending.photo.source.detectionBoxes ?? []).filter(isVisibleDetectionBox) as box}
                    <span
                      class={`detection-box detection-box-${box.stage}`}
                      style={getDetectionBoxStyle(pending.photo, box)}
                      title={getDetectionBoxLabel(box.stage)}
                    ></span>
                  {/each}
                {/if}
                <div
                  class="crop-box"
                  style={getMinimapCropStyle(pending.photo)}
                >
                  <button
                    class="crop-center crop-control"
                    aria-label={t(locale, 'moveCrop')}
                    type="button"
                    onpointerdown={(event) => {
                      event.stopPropagation();
                      startCropDrag(event, pending.id, 'move');
                    }}
                  ></button>
                  <button
                    class="crop-handle crop-control"
                    aria-label={t(locale, 'resizeCrop')}
                    type="button"
                    onpointerdown={(event) => {
                      event.stopPropagation();
                      startCropDrag(event, pending.id, 'resize');
                    }}
                  ></button>
                </div>
              </div>
              <button
                class="debug-toggle minimap-debug-toggle"
                type="button"
                role="switch"
                aria-checked={showDetectionDebug}
                onpointerdown={(event) => event.stopPropagation()}
                onclick={(event) => {
                  event.stopPropagation();
                  setDetectionDebug(!showDetectionDebug);
                }}
              >
                <i aria-hidden="true"></i>
                <span>{t(locale, 'lines')}</span>
              </button>
              <button
                class="debug-toggle minimap-manual-toggle"
                type="button"
                aria-pressed={manualAddMode}
                onpointerdown={(event) => event.stopPropagation()}
                onclick={(event) => {
                  event.stopPropagation();
                  setManualAddMode(!manualAddMode);
                }}
              >
                <i aria-hidden="true"></i>
                <span>Manual</span>
              </button>
            </div>
          </div>

          <div class="sample-info">
            <div class="color-row">
              <span class="color-label">{t(locale, 'averageColor')}</span>
              <span class="swatch" style={`--swatch: ${pending.photo.averageColor}`}></span>
              <strong>{pending.photo.averageColor}</strong>
              {#if pending.selectedTypeId !== null}
                <span>→ #{pending.selectedTypeId}</span>
              {/if}
            </div>
            {#if pending.photo.source.neuralStatus}
              <div
                class:used={pending.photo.source.neuralStatus.state === 'used'}
                class:error-state={pending.photo.source.neuralStatus.state === 'error'}
                class="neural-debug"
                title={pending.photo.source.neuralStatus.message}
              >
                <strong>NN</strong>
                <span>{pending.photo.source.neuralStatus.state}</span>
                <span>{pending.photo.source.neuralStatus.selectedBoxes}/{pending.photo.source.neuralStatus.rawBoxes}</span>
                {#if pending.photo.source.neuralStatus.outputShape}
                  <span>{pending.photo.source.neuralStatus.outputShape}</span>
                {/if}
                <em>{pending.photo.source.neuralStatus.message}</em>
              </div>
            {/if}

            {#if status}
              <p class="status">{status}</p>
            {/if}
            {#if error}
              <p class="error">{error}</p>
            {/if}

            {#if pending.duplicateCandidates.length}
              <div class="duplicates">
                <h3>{t(locale, 'similarToTitle')}</h3>
                <div class="duplicate-grid">
                  {#each pending.duplicateCandidates.slice(0, 5) as candidate}
                    {@const sample = samples[candidate.index]}
                    <button class="duplicate-card" onclick={() => updatePendingType(pending.id, sample.type_id)}>
                      <span class="duplicate-card-header">
                        <strong>#{sample.type_id ?? t(locale, 'noType')}</strong>
                        <span
                          class="type-color-dot"
                          style={`--swatch: ${sample.averageColor}`}
                          data-color={sample.averageColor}
                          title={sample.averageColor}
                          aria-label={`${t(locale, 'colorLabel')} ${sample.averageColor}`}
                        ></span>
                      </span>
                      <img src={sample.cropDataUrl} alt="" />
                      <span class="duplicate-similarity">{t(locale, 'similarTo', { value: formatSimilarity(candidate.score) })}</span>
                    </button>
                  {/each}
                </div>
              </div>
            {/if}

            <div class="crop-quality-row" aria-label="Оценка кропа для обучения">
              <button
                class:active={pending.cropReview === 'good'}
                class="crop-quality good"
                type="button"
                onclick={() => markCropQuality(pending.id, 'good')}
              >
                Кроп ок
              </button>
              <button
                class:active={pending.cropReview === 'bad'}
                class="crop-quality bad"
                type="button"
                onclick={() => markCropQuality(pending.id, 'bad')}
              >
                Кроп плохой
              </button>
            </div>

            <div class="action-row">
              <button class="review-action confirm" onclick={() => addPendingSample(pending.id)}>{t(locale, 'add')}</button>
              <button class="review-action reject" onclick={() => skipPendingSample(pending.id)}>{t(locale, 'skip')}</button>
            </div>
            <span class="queue-note">{t(locale, 'queue', { value: formatCandidateCount(pendingPhotos.length) })}</span>
          </div>
        </section>
      {:else}
        <section class="empty-state">
          <h1>{t(locale, 'emptyTitle')}</h1>
          <p>{t(locale, 'emptyP1')}</p>
          <p>{t(locale, 'emptyP2')}</p>
          <p>{t(locale, 'emptyP3')}</p>
          {#if status}
            <p class="status">{status}</p>
          {/if}
          {#if error}
            <p class="error">{error}</p>
          {/if}
        </section>
      {/if}

    </section>

    <aside class="samples-sidebar">
      <section class="samples">
        <header>
          <span class="draft-summary">{t(locale, 'draftSummary', { types: getDraftTypeGroups().length, caps: getDraftQuantityTotal() })}</span>
        </header>

        <div class="draft-tools">
          <label class="import-button" for="datasetImport">{t(locale, 'import')}</label>
          <input id="datasetImport" class="file-input" type="file" accept=".json,application/json" onchange={importDataset} />
          <button class="wide-button" disabled={!samples.length} onclick={exportDataset}>{t(locale, 'export')}</button>
          <button class="wide-button danger" disabled={!samples.length} onclick={clearDraft}>{t(locale, 'clearDraft')}</button>
        </div>

        <section class="training-review">
          <header>
            <strong>Разметка</strong>
            {#if trainingBackendStats}
              <span>{trainingBackendStats.accepted} good · {trainingBackendStats.negative} bad</span>
            {/if}
          </header>
          <div class="training-review-tabs" aria-label="Фильтр обучающих кропов">
            <button
              class:active={trainingAnnotationsFilter === 'good'}
              type="button"
              onclick={() => setTrainingAnnotationsFilter('good')}
            >
              good
            </button>
            <button
              class:active={trainingAnnotationsFilter === 'bad'}
              type="button"
              onclick={() => setTrainingAnnotationsFilter('bad')}
            >
              bad
            </button>
            <button class="training-refresh" type="button" disabled={trainingAnnotationsBusy} onclick={refreshTrainingAnnotations}>
              ↻
            </button>
          </div>
          <div class="training-crop-grid">
            {#each trainingAnnotations as item}
              <article class:bad={!item.accepted} class="training-crop-card">
                {#if item.cropUrl}
                  <img src={getTrainingCropUrl(item.cropUrl)} alt="" loading="lazy" title={item.sourceName ?? ''} />
                {:else}
                  <span class="training-crop-missing">нет фото</span>
                {/if}
                <span class="training-crop-meta">
                  {#if item.typeId !== null}#{item.typeId}{:else}skip{/if}
                  {#if item.averageColor}
                    <i style={`--swatch: ${item.averageColor}`} title={item.averageColor}></i>
                  {/if}
                </span>
                <button
                  class="training-delete"
                  type="button"
                  aria-label="Удалить разметку"
                  title="Удалить из обучения"
                  onclick={() => removeTrainingAnnotation(item.id)}
                >
                  <svg aria-hidden="true" viewBox="0 0 16 16">
                    <path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" />
                  </svg>
                </button>
              </article>
            {/each}
          </div>
        </section>

        <div class="sample-grid">
          {#each getDraftTypeGroups() as group}
            <article class="sample-card">
              <header class="type-card-header">
                <div class="type-id-row">
                  <strong>#{group.typeId}</strong>
                  <span
                    class="type-color-dot"
                    data-color={group.colors[0]}
                    style={`--swatch: ${group.colors[0]}`}
                    title={group.colors[0]}
                  ></span>
                </div>
                <button
                  class="delete-type"
                  aria-label={`${t(locale, 'deleteType')} #${group.typeId}`}
                  title={t(locale, 'deleteType')}
                  onclick={() => group.samples.forEach((sample) => removeSample(sample.id))}
                >
                  <svg aria-hidden="true" viewBox="0 0 16 16">
                    <path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" />
                  </svg>
                </button>
              </header>

              <div class="type-samples">
                <div class="type-sample-thumb">
                  <img src={group.samples[0].cropDataUrl} alt={t(locale, 'capPhotoAlt')} title={group.samples[0].averageColor} />
                </div>
              </div>

              <div class="quantity-control" aria-label={t(locale, 'typeQuantityLabel', { id: group.typeId })}>
                <button class="quantity-step wide" type="button" title="-10" onclick={() => adjustTypeQuantity(group.typeId, -10)}>-10</button>
                <button class="quantity-step" type="button" title="-1" onclick={() => adjustTypeQuantity(group.typeId, -1)}>-1</button>
                <input
                  aria-label={t(locale, 'typeQuantityLabel', { id: group.typeId })}
                  min="0"
                  type="number"
                  value={group.quantity}
                  oninput={(event) => updateTypeQuantity(group.typeId, Number(event.currentTarget.value))}
                />
                <button class="quantity-step" type="button" title="+1" onclick={() => adjustTypeQuantity(group.typeId, 1)}>+1</button>
                <button class="quantity-step wide" type="button" title="+10" onclick={() => adjustTypeQuantity(group.typeId, 10)}>+10</button>
              </div>

              <label class="type-note">
                <input
                  aria-label={t(locale, 'typeNameLabel', { id: group.typeId })}
                  maxlength="28"
                  placeholder={t(locale, 'typeNamePlaceholder')}
                  type="text"
                  value={group.note}
                  oninput={(event) => updateTypeNote(group.typeId, event.currentTarget.value)}
                />
              </label>
            </article>
          {/each}
        </div>
      </section>
    </aside>
  </section>
</main>

<style>
  :global(html),
  :global(body) {
    height: 100%;
    margin: 0;
    background: #202833;
    color: #edf2f7;
    overflow: hidden;
  }

  :global(*) {
    box-sizing: border-box;
  }

  .dataset-app {
    --accent: #38bdf8;
    --bg: #202833;
    --control: #343d4a;
    --control-hover: #3d4857;
    --line: rgba(203, 213, 225, 0.2);
    --muted: #b9c5d4;
    --panel: #2b333f;
    --panel-2: #343d4a;
    --scrollbar-thumb: rgba(148, 163, 184, 0.42);
    --scrollbar-thumb-hover: rgba(56, 189, 248, 0.58);
    --scrollbar-track: rgba(15, 23, 42, 0.2);
    --text: #edf2f7;
    --text-strong: #ffffff;

    background: var(--bg);
    color: var(--text);
    height: 100vh;
    overflow: hidden;
    position: relative;
    scrollbar-color: var(--scrollbar-thumb) transparent;
    scrollbar-width: thin;
  }

  .dataset-app * {
    scrollbar-color: var(--scrollbar-thumb) transparent;
    scrollbar-width: thin;
  }

  .dataset-app *::-webkit-scrollbar {
    height: 10px;
    width: 10px;
  }

  .dataset-app *::-webkit-scrollbar-button {
    display: none;
    height: 0;
    width: 0;
  }

  .dataset-app *::-webkit-scrollbar-track {
    background: transparent;
  }

  .dataset-app *::-webkit-scrollbar-thumb {
    background:
      linear-gradient(var(--scrollbar-thumb), var(--scrollbar-thumb)) padding-box,
      linear-gradient(var(--scrollbar-track), var(--scrollbar-track)) border-box;
    border: 3px solid transparent;
    border-radius: 999px;
  }

  .dataset-app *::-webkit-scrollbar-thumb:hover {
    background:
      linear-gradient(var(--scrollbar-thumb-hover), var(--scrollbar-thumb-hover)) padding-box,
      linear-gradient(var(--scrollbar-track), var(--scrollbar-track)) border-box;
  }

  .dataset-app.dragging-files::after {
    align-items: center;
    background: rgba(15, 23, 42, 0.72);
    border: 2px dashed var(--accent);
    color: var(--text-strong);
    content: attr(data-drop-label);
    display: flex;
    font-size: 24px;
    font-weight: 700;
    inset: 72px 16px 16px;
    justify-content: center;
    pointer-events: none;
    position: fixed;
    z-index: 20;
  }

  .topbar {
    align-items: center;
    background: var(--panel);
    border-bottom: 1px solid var(--line);
    display: flex;
    height: 56px;
    justify-content: space-between;
    padding: 0 18px;
  }

  .brand {
    align-items: center;
    display: flex;
    gap: 8px;
    min-width: 0;
  }

  .brand-icon {
    flex: 0 0 auto;
    height: 28px;
    width: 28px;
  }

  .brand-text {
    align-items: baseline;
    display: flex;
    gap: 8px;
    min-width: 0;
  }

  .file-input {
    display: none;
  }

  .topbar-actions {
    align-items: center;
    display: flex;
    gap: 10px;
    min-width: 0;
  }

  .model-control {
    align-items: center;
    display: flex;
    gap: 6px;
    min-width: 0;
  }

  .model-action {
    min-height: 30px;
    padding-inline: 9px;
  }

  .model-sync {
    font-size: 12px;
  }

  .model-name {
    color: var(--muted);
    display: inline-block;
    font-size: 12px;
    max-width: 150px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .model-clear {
    border-radius: 999px;
    height: 24px;
    min-height: 24px;
    padding: 0;
    width: 24px;
  }

  .model-clear svg {
    height: 14px;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-width: 2;
    width: 14px;
  }

  .training-status {
    align-items: center;
    background: color-mix(in srgb, var(--control), #000 10%);
    border: 1px solid rgba(248, 113, 113, 0.28);
    border-radius: 999px;
    color: var(--muted);
    display: inline-flex;
    flex: 0 0 auto;
    font-size: 12px;
    gap: 6px;
    min-height: 30px;
    padding: 4px 9px;
    white-space: nowrap;
  }

  .training-status.online {
    border-color: rgba(74, 222, 128, 0.35);
    color: var(--text-strong);
  }

  .training-dot {
    background: #f87171;
    border-radius: 999px;
    box-shadow: 0 0 0 3px rgba(248, 113, 113, 0.1);
    height: 8px;
    width: 8px;
  }

  .training-status.online .training-dot {
    background: #4ade80;
    box-shadow: 0 0 0 3px rgba(74, 222, 128, 0.12);
  }

  .training-status strong {
    color: inherit;
    font-size: 11px;
    letter-spacing: 0;
  }

  .training-status em {
    color: var(--muted);
    font-style: normal;
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .training-status em.ok {
    color: #bbf7d0;
  }

  .training-status em.fail {
    color: #fecaca;
  }

  .mode-switch {
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 8px;
    display: inline-grid;
    grid-template-columns: 1fr 1fr;
    padding: 3px;
  }

  .mode-switch a {
    align-items: center;
    border-radius: 6px;
    color: var(--text-strong);
    display: inline-flex;
    font-size: 13px;
    justify-content: center;
    min-height: 28px;
    padding: 4px 10px;
    text-decoration: none;
  }

  .mode-switch a.active {
    background: var(--accent);
    color: #06121f;
  }

  .brand strong,
  h1,
  h3 {
    color: var(--text-strong);
  }

  .brand strong {
    font-size: 17px;
    white-space: nowrap;
  }

  .brand span,
  .samples > header span,
  .type-card-header span {
    color: var(--muted);
  }

  .brand span {
    font-size: 13px;
    white-space: nowrap;
  }

  .import-button,
  .nav-link,
  button,
  input {
    font: inherit;
  }

  .import-button,
  .nav-link,
  button {
    background: var(--control);
    border: 1px solid var(--line);
    border-radius: 6px;
    color: var(--text-strong);
    cursor: pointer;
    display: inline-flex;
    justify-content: center;
    align-items: center;
    min-height: 36px;
    padding: 7px 10px;
    text-decoration: none;
  }

  .import-button:hover,
  button:hover,
  .nav-link:hover {
    background: var(--control-hover);
    border-color: var(--accent);
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  .workspace {
    display: grid;
    gap: 16px;
    grid-template-columns: minmax(620px, 1.25fr) minmax(520px, 0.8fr) minmax(520px, 1fr);
    grid-template-rows: auto auto 1fr;
    height: calc(100vh - 56px);
    min-height: 0;
    overflow: hidden;
    padding: 16px;
  }

  .samples-sidebar {
    background: color-mix(in srgb, var(--panel), var(--bg) 18%);
    border: 1px solid var(--line);
    border-radius: 8px;
    grid-column: 3;
    grid-row: 1 / span 3;
    max-height: 100%;
    min-width: 0;
    overflow: hidden;
    padding: 16px;
  }

  .type-note {
    display: grid;
    font-size: 13px;
    gap: 7px;
  }

  input {
    background: var(--control);
    border: 1px solid var(--line);
    border-radius: 6px;
    color: var(--text-strong);
    min-height: 36px;
    padding: 6px 8px;
    width: 100%;
  }

  .status,
  .error {
    font-size: 13px;
    margin: 0;
  }

  .neural-debug {
    align-items: center;
    background: rgba(148, 163, 184, 0.12);
    border: 1px solid rgba(148, 163, 184, 0.24);
    border-radius: 999px;
    color: var(--muted);
    display: inline-flex;
    font-size: 11px;
    gap: 7px;
    justify-self: start;
    min-height: 24px;
    padding: 3px 9px;
  }

  .neural-debug strong {
    color: var(--text-strong);
    font-size: 11px;
    letter-spacing: 0.08em;
  }

  .neural-debug em {
    font-style: normal;
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .neural-debug.used {
    background: rgba(239, 68, 68, 0.12);
    border-color: rgba(239, 68, 68, 0.44);
    color: #fecaca;
  }

  .neural-debug.error-state {
    background: rgba(245, 158, 11, 0.12);
    border-color: rgba(245, 158, 11, 0.42);
    color: #fde68a;
  }

  .error {
    color: #fca5a5;
  }

  .draft-summary {
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
  }

  .wide-button {
    width: 100%;
  }

  .danger {
    border-color: rgba(248, 113, 113, 0.35);
    color: #fecaca;
  }

  .review-pane {
    display: contents;
  }

  .current-sample {
    display: contents;
  }

  .preview {
    display: contents;
  }

  .crop-preview-row {
    align-items: center;
    display: grid;
    gap: 9px;
    grid-column: 2;
    grid-row: 2;
    grid-template-columns: minmax(0, 450px) auto;
    justify-content: center;
    justify-self: center;
    min-width: 0;
    width: min(100%, 600px);
  }

  .crop-preview {
    aspect-ratio: 1;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 50%;
    overflow: hidden;
    position: relative;
    justify-self: center;
    width: min(100%, 450px);
  }

  .crop-legend {
    align-self: center;
    color: var(--muted);
    display: grid;
    font-size: 12px;
    gap: 7px;
    justify-self: start;
    min-width: 54px;
  }

  .crop-legend span {
    align-items: center;
    display: inline-flex;
    gap: 7px;
    min-width: 0;
  }

  .crop-legend i {
    border-radius: 999px;
    display: inline-block;
    height: 10px;
    width: 22px;
  }

  .legend-crop {
    background: #38bdf8;
  }

  .legend-color {
    background: #f59e0b;
  }

  .legend-detected {
    background: #22c55e;
  }

  .legend-manual {
    background: #f472b6;
  }

  .crop-preview img,
  .sample-card img,
  .duplicate-card img {
    aspect-ratio: 1;
    border-radius: 50%;
    display: block;
    object-fit: cover;
    width: 100%;
  }

  .color-sample-ring {
    appearance: none;
    background: transparent;
    border: 2px dashed rgba(245, 158, 11, 0.96);
    border-radius: 50%;
    box-shadow:
      0 0 0 1px rgba(6, 18, 31, 0.9),
      0 0 18px rgba(245, 158, 11, 0.38),
      inset 0 0 0 1px rgba(255, 247, 237, 0.42);
    cursor: move;
    display: block;
    height: var(--ss);
    left: var(--sx);
    min-height: 0;
    padding: 0;
    position: absolute;
    top: var(--sy);
    touch-action: none;
    width: var(--ss);
  }

  .color-sample-ring:hover,
  .color-sample-ring:focus,
  .color-sample-ring:focus-visible {
    background: transparent;
    outline: none;
  }

  .color-sample-ring:focus-visible {
    box-shadow:
      0 0 0 1px rgba(6, 18, 31, 0.9),
      0 0 0 4px rgba(245, 158, 11, 0.28),
      0 0 18px rgba(245, 158, 11, 0.38),
      inset 0 0 0 1px rgba(255, 247, 237, 0.42);
  }

  .sample-center {
    background: #f59e0b;
    border: 1px solid #06121f;
    border-radius: 50%;
    box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.2);
    height: 14px;
    left: 50%;
    pointer-events: none;
    position: absolute;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 14px;
  }

  .sample-handle {
    background: #f59e0b;
    border: 1px solid #06121f;
    border-radius: 50%;
    bottom: 14.64%;
    cursor: nwse-resize;
    height: 14px;
    position: absolute;
    right: 14.64%;
    transform: translate(50%, 50%);
    touch-action: none;
    width: 14px;
  }

  .minimap {
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 6px;
    cursor: grab;
    grid-column: 1;
    grid-row: 1 / span 3;
    height: 100%;
    justify-self: stretch;
    overflow: hidden;
    position: relative;
    touch-action: none;
    user-select: none;
    width: 100%;
  }

  .minimap:active {
    cursor: grabbing;
  }

  .minimap.manual-add-mode {
    cursor: crosshair;
  }

  .minimap.manual-add-mode::after {
    border: 1px dashed rgba(74, 222, 128, 0.75);
    border-radius: 6px;
    content: '';
    inset: 8px;
    pointer-events: none;
    position: absolute;
    z-index: 5;
  }

  .minimap-debug-toggle {
    bottom: 10px;
    left: calc(50% - 48px);
    position: absolute;
    transform: translateX(-50%);
    z-index: 6;
  }

  .minimap-manual-toggle {
    bottom: 10px;
    left: calc(50% + 58px);
    position: absolute;
    transform: translateX(-50%);
    z-index: 6;
  }

  .minimap-layer {
    aspect-ratio: var(--source-aspect);
    height: var(--layer-height);
    left: 50%;
    position: absolute;
    top: 50%;
    transform: translate(calc(-50% + var(--pan-x, 0)), calc(-50% + var(--pan-y, 0)));
    transform-origin: center;
    width: var(--layer-width);
  }

  .minimap img {
    height: 100%;
    border-radius: 0;
    display: block;
    object-fit: fill;
    pointer-events: none;
    user-select: none;
    width: 100%;
  }

  .crop-box {
    background: transparent;
    border: 2px solid #38bdf8;
    border-radius: 50%;
    box-shadow:
      0 0 0 1px rgba(6, 18, 31, 0.85),
      inset 0 0 0 1px rgba(6, 18, 31, 0.72);
    display: block;
    height: var(--h);
    left: var(--x);
    pointer-events: none;
    position: absolute;
    top: var(--y);
    width: var(--w);
    z-index: 4;
  }

  .detection-box {
    border: 1.5px dashed rgba(226, 232, 240, 0.75);
    border-radius: 50%;
    height: var(--h);
    left: var(--x);
    opacity: 0.82;
    pointer-events: none;
    position: absolute;
    top: var(--y);
    width: var(--w);
    z-index: 2;
  }

  .detection-box-accepted {
    border-color: #22c55e;
    border-style: solid;
    box-shadow: 0 0 0 1px rgba(34, 197, 94, 0.2);
    opacity: 0.94;
    z-index: 3;
  }

  .detection-box-circle {
    border-color: #a78bfa;
  }

  .detection-box-neural {
    border-color: #ef4444;
    border-style: solid;
    box-shadow:
      0 0 0 1px rgba(239, 68, 68, 0.26),
      0 0 16px rgba(239, 68, 68, 0.22);
    opacity: 0.96;
    z-index: 3;
  }

  .detection-box-foreground {
    border-color: #f59e0b;
  }

  .detection-box-dense {
    border-color: #fb923c;
  }

  .detection-box-fallback {
    border-color: #94a3b8;
  }

  .detection-box-manual {
    border-color: #f472b6;
    border-style: solid;
    box-shadow:
      0 0 0 1px rgba(244, 114, 182, 0.25),
      0 0 18px rgba(244, 114, 182, 0.28);
    opacity: 0.96;
    z-index: 3;
  }

  .crop-center {
    appearance: none;
    background: #38bdf8;
    border: 1px solid #06121f;
    border-radius: 50%;
    box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.18);
    cursor: move;
    height: 14px;
    left: 50%;
    min-height: 0;
    padding: 0;
    pointer-events: auto;
    position: absolute;
    top: 50%;
    touch-action: none;
    transform: translate(-50%, -50%);
    width: 14px;
  }

  .crop-handle {
    appearance: none;
    background: #38bdf8;
    border: 1px solid #06121f;
    border-radius: 50%;
    bottom: 14.64%;
    cursor: nwse-resize;
    height: 14px;
    min-height: 0;
    padding: 0;
    pointer-events: auto;
    position: absolute;
    right: 14.64%;
    transform: translate(50%, 50%);
    touch-action: none;
    width: 14px;
  }

  .crop-control:hover,
  .crop-control:focus,
  .crop-control:focus-visible {
    background: #38bdf8;
    outline: none;
  }

  .crop-control:focus-visible {
    box-shadow:
      0 0 0 1px rgba(6, 18, 31, 0.85),
      0 0 0 4px rgba(56, 189, 248, 0.28),
      0 0 0 7px rgba(56, 189, 248, 0.16);
  }

  .sample-info {
    align-self: start;
    display: grid;
    gap: 14px;
    grid-column: 2;
    grid-row: 3;
    max-height: calc(100vh - 392px);
    max-width: 100%;
    min-height: 0;
    overflow: auto;
    padding-right: 4px;
    scrollbar-gutter: stable;
  }

  .color-row {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .color-label {
    color: var(--muted);
    font-size: 13px;
  }

  .swatch {
    background: var(--swatch);
    border: 1px solid var(--line);
    border-radius: 50%;
    height: 28px;
    width: 28px;
  }

  .duplicates {
    display: grid;
    gap: 8px;
    min-height: 0;
  }

  .duplicates h3 {
    font-size: 13px;
    margin: 0;
  }

  .duplicate-grid {
    display: grid;
    gap: 8px;
    grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
  }

  .debug-toggle {
    align-items: center;
    background: color-mix(in srgb, var(--panel-2), transparent 35%);
    border: 1px solid var(--line);
    border-radius: 6px;
    color: var(--muted);
    display: inline-flex;
    font-size: 12px;
    gap: 6px;
    min-height: 36px;
    padding: 0 10px;
    white-space: nowrap;
  }

  .debug-toggle i {
    background: rgba(148, 163, 184, 0.34);
    border-radius: 999px;
    display: inline-block;
    height: 14px;
    position: relative;
    width: 26px;
  }

  .debug-toggle i::after {
    background: #94a3b8;
    border-radius: 50%;
    content: '';
    height: 10px;
    left: 2px;
    position: absolute;
    top: 2px;
    transition: transform 120ms ease, background 120ms ease;
    width: 10px;
  }

  .debug-toggle[aria-checked='true'] i::after,
  .debug-toggle[aria-pressed='true'] i::after {
    background: #38bdf8;
    transform: translateX(12px);
  }

  .minimap-manual-toggle[aria-pressed='true'] {
    border-color: rgba(74, 222, 128, 0.55);
    color: #bbf7d0;
  }

  .minimap-manual-toggle[aria-pressed='true'] i::after {
    background: #4ade80;
  }

  .duplicate-card {
    align-items: center;
    background: var(--panel);
    border: 1.5px solid var(--line);
    border-radius: 8px;
    display: grid;
    gap: 6px;
    justify-items: center;
    min-height: 0;
    min-width: 0;
    padding: 7px;
    text-align: center;
  }

  .duplicate-card:hover {
    border-color: rgba(56, 189, 248, 0.5);
    transform: translateY(-1px);
  }

  .duplicate-card-header {
    align-items: center;
    display: flex;
    gap: 5px;
    justify-content: center;
    min-width: 0;
    width: 100%;
  }

  .duplicate-card-header strong {
    color: var(--text-strong);
    font-size: 12px;
  }

  .duplicate-card .type-color-dot {
    height: 13px;
    top: 0;
    width: 13px;
  }

  .duplicate-card img {
    background: var(--panel-2);
    border: 1px solid var(--line);
    width: min(70px, 100%);
  }

  .duplicate-similarity {
    color: var(--muted);
    font-size: 11px;
    line-height: 1.15;
    min-height: 26px;
  }

  .action-row {
    background:
      linear-gradient(to bottom, color-mix(in srgb, var(--bg), transparent 100%), var(--bg) 18%),
      var(--bg);
    bottom: 0;
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    padding-top: 10px;
    position: sticky;
    z-index: 5;
  }

  .crop-quality-row {
    display: grid;
    gap: 8px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .crop-quality {
    border-radius: 7px;
    color: var(--muted);
    font-size: 13px;
    font-weight: 700;
    min-height: 38px;
    padding: 0 10px;
  }

  .crop-quality.good {
    background: rgba(34, 197, 94, 0.1);
    border-color: rgba(74, 222, 128, 0.25);
  }

  .crop-quality.good:hover,
  .crop-quality.good.active {
    background: rgba(34, 197, 94, 0.2);
    border-color: rgba(134, 239, 172, 0.48);
    color: #bbf7d0;
  }

  .crop-quality.bad {
    background: rgba(244, 114, 182, 0.1);
    border-color: rgba(244, 114, 182, 0.25);
  }

  .crop-quality.bad:hover,
  .crop-quality.bad.active {
    background: rgba(244, 114, 182, 0.2);
    border-color: rgba(249, 168, 212, 0.5);
    color: #fbcfe8;
  }

  .review-action {
    border-radius: 8px;
    font-size: 16px;
    font-weight: 800;
    min-height: 54px;
    padding: 0 18px;
  }

  .review-action.confirm {
    background: linear-gradient(180deg, rgba(34, 197, 94, 0.24), rgba(21, 128, 61, 0.18));
    border-color: rgba(74, 222, 128, 0.38);
    box-shadow: 0 10px 22px rgba(22, 163, 74, 0.08);
    color: #bbf7d0;
  }

  .review-action.confirm:hover {
    background: linear-gradient(180deg, rgba(34, 197, 94, 0.34), rgba(21, 128, 61, 0.26));
    border-color: rgba(134, 239, 172, 0.56);
    color: #dcfce7;
  }

  .review-action.reject {
    background: linear-gradient(180deg, rgba(239, 68, 68, 0.22), rgba(153, 27, 27, 0.18));
    border-color: rgba(248, 113, 113, 0.38);
    box-shadow: 0 10px 22px rgba(185, 28, 28, 0.08);
    color: #fecaca;
  }

  .review-action.reject:hover {
    background: linear-gradient(180deg, rgba(239, 68, 68, 0.32), rgba(153, 27, 27, 0.25));
    border-color: rgba(252, 165, 165, 0.56);
    color: #fee2e2;
  }

  .secondary {
    color: var(--muted);
  }

  .empty-state {
    border-bottom: 1px solid var(--line);
    grid-column: 1 / 3;
    grid-row: 2;
    padding: 24px 0 30px;
  }

  .empty-state h1 {
    font-size: 26px;
    margin: 0 0 8px;
  }

  .empty-state p {
    color: var(--muted);
    margin: 0;
    max-width: 720px;
  }

  .samples {
    display: grid;
    gap: 14px;
    grid-template-rows: auto auto auto minmax(0, 1fr);
    height: 100%;
    min-height: 0;
  }

  .draft-tools {
    display: grid;
    gap: 10px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .draft-tools .danger {
    grid-column: 1 / -1;
  }

  .training-review {
    background: color-mix(in srgb, var(--panel-2), transparent 34%);
    border: 1px solid rgba(148, 163, 184, 0.18);
    border-radius: 8px;
    display: grid;
    gap: 8px;
    min-height: 0;
    padding: 8px;
  }

  .training-review > header {
    align-items: center;
    display: flex;
    gap: 8px;
    justify-content: space-between;
  }

  .training-review > header strong {
    color: var(--text-strong);
    font-size: 12px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .training-review > header span {
    color: var(--muted);
    font-size: 11px;
    white-space: nowrap;
  }

  .training-review-tabs {
    display: grid;
    gap: 6px;
    grid-template-columns: 1fr 1fr 34px;
  }

  .training-review-tabs button {
    background: rgba(15, 23, 42, 0.2);
    border: 1px solid rgba(148, 163, 184, 0.24);
    color: var(--muted);
    min-height: 28px;
    padding: 4px 8px;
  }

  .training-review-tabs button.active {
    background: rgba(56, 189, 248, 0.12);
    border-color: rgba(56, 189, 248, 0.45);
    color: #e0f2fe;
  }

  .training-review-tabs .training-refresh {
    font-size: 15px;
    padding: 0;
  }

  .training-crop-grid {
    display: grid;
    gap: 6px;
    grid-auto-rows: 54px;
    grid-template-columns: repeat(auto-fill, minmax(54px, 1fr));
    max-height: 126px;
    min-height: 0;
    overflow: auto;
    padding-right: 2px;
  }

  .training-crop-card {
    aspect-ratio: 1;
    background: var(--panel);
    border: 1px solid rgba(74, 222, 128, 0.35);
    border-radius: 7px;
    min-width: 0;
    overflow: hidden;
    position: relative;
  }

  .training-crop-card.bad {
    border-color: rgba(248, 113, 113, 0.38);
  }

  .training-crop-card img {
    display: block;
    height: 100%;
    object-fit: cover;
    width: 100%;
  }

  .training-crop-missing {
    align-items: center;
    color: var(--muted);
    display: flex;
    font-size: 10px;
    height: 100%;
    justify-content: center;
    text-align: center;
  }

  .training-crop-meta {
    align-items: center;
    background: rgba(15, 23, 42, 0.66);
    border-radius: 999px;
    bottom: 3px;
    color: #f8fafc;
    display: flex;
    font-size: 10px;
    gap: 3px;
    left: 3px;
    max-width: calc(100% - 6px);
    padding: 2px 5px;
    position: absolute;
  }

  .training-crop-meta i {
    background: var(--swatch);
    border: 1px solid rgba(255, 255, 255, 0.55);
    border-radius: 50%;
    display: block;
    height: 8px;
    width: 8px;
  }

  .training-delete {
    align-items: center;
    background: rgba(15, 23, 42, 0.68);
    border: 1px solid rgba(148, 163, 184, 0.34);
    border-radius: 50%;
    color: #cbd5e1;
    display: flex;
    height: 20px;
    justify-content: center;
    min-height: 0;
    padding: 0;
    position: absolute;
    right: 3px;
    top: 3px;
    width: 20px;
  }

  .training-delete svg {
    height: 12px;
    width: 12px;
  }

  .training-delete path {
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-width: 1.8;
  }

  .training-delete:hover {
    background: rgba(127, 29, 29, 0.72);
    border-color: rgba(248, 113, 113, 0.76);
    color: #fecaca;
  }

  .samples > header {
    align-items: center;
    display: flex;
    gap: 12px;
    justify-content: space-between;
  }

  .sample-grid {
    align-content: start;
    align-items: start;
    display: grid;
    gap: 8px;
    grid-template-columns: repeat(auto-fill, 144px);
    justify-content: center;
    min-height: 0;
    overflow: auto;
    padding-right: 2px;
    scrollbar-gutter: stable;
  }

  .sample-card {
    align-self: start;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    display: grid;
    gap: 6px;
    justify-items: center;
    min-width: 0;
    padding: 7px;
    width: 144px;
  }

  .type-card-header {
    align-items: center;
    display: flex;
    gap: 6px;
    justify-content: space-between;
    width: 100%;
  }

  .type-id-row {
    align-items: baseline;
    display: flex;
    gap: 5px;
    min-width: 0;
  }

  .type-card-header strong {
    color: var(--text-strong);
    font-size: 14px;
  }

  .delete-type {
    align-items: center;
    background: transparent;
    border: 1px solid rgba(148, 163, 184, 0.36);
    border-radius: 50%;
    color: var(--muted);
    display: flex;
    height: 20px;
    justify-content: center;
    line-height: 1;
    min-height: 0;
    padding: 0;
    width: 20px;
  }

  .delete-type svg {
    display: block;
    height: 12px;
    width: 12px;
  }

  .delete-type path {
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-width: 1.8;
  }

  .delete-type:hover {
    background: rgba(127, 29, 29, 0.22);
    border-color: rgba(248, 113, 113, 0.72);
    color: #fca5a5;
  }

  .type-samples {
    display: grid;
    gap: 5px;
    grid-template-columns: 128px;
    justify-content: center;
  }

  .type-sample-thumb {
    aspect-ratio: 1;
    position: relative;
    width: 128px;
  }

  .type-sample-thumb img {
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 50%;
    height: 100%;
    object-fit: cover;
    width: 100%;
  }

  .quantity-control {
    align-items: center;
    background: color-mix(in srgb, var(--panel-2), transparent 20%);
    border: 1px solid rgba(148, 163, 184, 0.22);
    border-radius: 6px;
    display: grid;
    gap: 1px;
    grid-template-columns: 23px 18px minmax(30px, 1fr) 18px 23px;
    height: 25px;
    overflow: hidden;
    padding: 1px;
    width: 128px;
  }

  .quantity-control button {
    background: transparent;
    border: 0;
    border-radius: 4px;
    color: var(--muted);
    font-size: 9px;
    font-weight: 700;
    min-width: 0;
    min-height: 21px;
    padding: 0;
  }

  .quantity-control button:hover {
    background: rgba(56, 189, 248, 0.14);
    color: var(--text-strong);
  }

  .quantity-control input {
    appearance: textfield;
    background: rgba(251, 146, 60, 0.14);
    border: 1px solid rgba(251, 146, 60, 0.38);
    border-radius: 4px;
    color: #fed7aa;
    font-size: 11px;
    font-weight: 700;
    min-width: 0;
    min-height: 21px;
    padding: 1px 2px;
    text-align: center;
  }

  .quantity-control input:focus {
    border-color: rgba(251, 146, 60, 0.68);
    outline: 2px solid rgba(251, 146, 60, 0.18);
  }

  .quantity-control input::-webkit-outer-spin-button,
  .quantity-control input::-webkit-inner-spin-button {
    appearance: none;
    margin: 0;
  }

  .type-color-dot {
    background: var(--swatch);
    border: 1px solid rgba(255, 255, 255, 0.25);
    border-radius: 50%;
    box-shadow: 0 0 0 1px rgba(6, 18, 31, 0.65);
    height: 16px;
    flex: 0 0 auto;
    position: relative;
    top: 1px;
    width: 16px;
  }

  .type-color-dot:hover::after {
    background: #101722;
    border: 1px solid var(--line);
    border-radius: 6px;
    bottom: calc(100% + 7px);
    color: var(--text-strong);
    content: attr(data-color);
    font-size: 12px;
    left: 50%;
    padding: 4px 6px;
    position: absolute;
    transform: translateX(-50%);
    white-space: nowrap;
    z-index: 30;
  }

  .type-note {
    width: 128px;
  }

  .type-note input {
    font-size: 12px;
    min-height: 24px;
    overflow: hidden;
    padding: 3px 6px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (max-width: 1600px) {
    .workspace {
      grid-template-columns: minmax(520px, 1.15fr) minmax(420px, 0.85fr);
    }

    .samples-sidebar {
      grid-column: 1 / -1;
      grid-row: auto;
      max-height: none;
      position: static;
    }

    .sample-grid {
      grid-template-columns: repeat(auto-fill, 144px);
    }
  }

  @media (max-width: 840px) {
    .workspace {
      grid-template-columns: 1fr;
    }

    .crop-preview,
    .sample-info,
    .minimap,
    .samples-sidebar,
    .empty-state {
      grid-column: 1;
      grid-row: auto;
    }

    .sample-info {
      max-height: none;
      overflow: visible;
      padding-right: 0;
    }

    .duplicates {
      max-height: 280px;
    }

    .minimap {
      width: min(100%, 420px);
    }
  }

  @media (max-width: 460px) {
    .topbar {
      padding: 0 10px;
    }

    .brand {
      gap: 7px;
    }

    .brand strong {
      font-size: 15px;
    }

    .brand span {
      font-size: 11px;
    }

    .mode-switch a {
      font-size: 13px;
      padding: 4px 8px;
    }
  }
</style>
