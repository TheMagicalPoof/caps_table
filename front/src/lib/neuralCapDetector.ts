import { base } from '$app/paths';

type OrtModule = typeof import('onnxruntime-web');

type StoredModel = {
  id: 'active';
  name: string;
  size: number;
  updatedAt: string;
  buffer: ArrayBuffer;
};

export type CapDetectorModelMeta = {
  name: string;
  size: number;
  updatedAt: string;
};

export type NeuralCapDetection = {
  x: number;
  y: number;
  width: number;
  height: number;
  stage: 'neural';
  neuralEmbedding?: number[];
};

export type NeuralDetectorStatus = {
  state: 'idle' | 'no-model' | 'running' | 'used' | 'empty' | 'error';
  message: string;
  rawBoxes: number;
  selectedBoxes: number;
  inputSize?: string;
  outputShape?: string;
  updatedAt: string;
};

type NeuralBox = NeuralCapDetection & {
  confidence: number;
  candidateIndex: number;
};

const dbName = 'caps-table-neural-detector';
const storeName = 'models';
const modelKey = 'active';
const metaKey = 'caps-table-neural-detector-meta';
const confidenceThreshold = 0.28;
const nmsThreshold = 0.42;

let cachedSessionPromise: Promise<import('onnxruntime-web').InferenceSession | null> | null = null;
let lastStatus: NeuralDetectorStatus = {
  state: 'idle',
  message: 'not run',
  rawBoxes: 0,
  selectedBoxes: 0,
  updatedAt: new Date(0).toISOString(),
};

function setLastStatus(status: Omit<NeuralDetectorStatus, 'updatedAt'>) {
  lastStatus = {
    ...status,
    updatedAt: new Date().toISOString(),
  };
}

export function getLastNeuralDetectorStatus() {
  return lastStatus;
}

function configureOrt(ort: OrtModule) {
  const wasmBase = `${window.location.origin}${base}/ort/`;
  ort.env.wasm.wasmPaths = wasmBase;
}

function isBrowser() {
  return typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
}

function openModelDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Не удалось открыть хранилище модели'));
  });
}

function runStoreTransaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    openModelDb()
      .then((db) => {
        const transaction = db.transaction(storeName, mode);
        const request = action(transaction.objectStore(storeName));

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('Не удалось прочитать модель'));
        transaction.oncomplete = () => db.close();
        transaction.onerror = () => {
          db.close();
          reject(transaction.error ?? new Error('Ошибка хранилища модели'));
        };
      })
      .catch(reject);
  });
}

function readModelMetaFromStorage(): CapDetectorModelMeta | null {
  if (!isBrowser()) return null;

  try {
    const rawMeta = localStorage.getItem(metaKey);
    if (!rawMeta) return null;

    const meta = JSON.parse(rawMeta) as Partial<CapDetectorModelMeta>;
    if (typeof meta.name !== 'string' || typeof meta.size !== 'number' || typeof meta.updatedAt !== 'string') {
      return null;
    }

    return {
      name: meta.name,
      size: meta.size,
      updatedAt: meta.updatedAt,
    };
  } catch {
    return null;
  }
}

export function getCapDetectorModelMeta() {
  return readModelMetaFromStorage();
}

export async function saveCapDetectorModel(file: File): Promise<CapDetectorModelMeta> {
  if (!isBrowser()) throw new Error('Хранилище модели доступно только в браузере');

  const buffer = await file.arrayBuffer();
  const meta = {
    name: file.name,
    size: file.size,
    updatedAt: new Date().toISOString(),
  };

  await runStoreTransaction('readwrite', (store) =>
    store.put({
      id: modelKey,
      ...meta,
      buffer,
    } satisfies StoredModel),
  );

  localStorage.setItem(metaKey, JSON.stringify(meta));
  cachedSessionPromise = null;

  return meta;
}

export async function clearCapDetectorModel() {
  if (!isBrowser()) return;

  await runStoreTransaction('readwrite', (store) => store.delete(modelKey));
  localStorage.removeItem(metaKey);
  cachedSessionPromise = null;
}

async function readStoredModel(): Promise<StoredModel | null> {
  if (!isBrowser()) return null;

  const model = await runStoreTransaction<StoredModel | undefined>('readonly', (store) => store.get(modelKey));
  return model ?? null;
}

async function getSession() {
  if (!cachedSessionPromise) {
    cachedSessionPromise = (async () => {
      const storedModel = await readStoredModel();
      if (!storedModel) return null;

      const ort: OrtModule = await import('onnxruntime-web');
      configureOrt(ort);
      return ort.InferenceSession.create(new Uint8Array(storedModel.buffer), {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
    })();
  }

  return cachedSessionPromise;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function getModelInputSize(session: import('onnxruntime-web').InferenceSession) {
  const inputName = session.inputNames[0] ?? '';
  const inputMetadata = session.inputMetadata as unknown;
  const metadata = Array.isArray(inputMetadata)
    ? (inputMetadata[0] as { dimensions?: readonly unknown[] } | undefined)
    : (inputMetadata as Record<string, { dimensions?: readonly unknown[] } | undefined>)[inputName];
  const dimensions = metadata?.dimensions ?? [];
  const numericDimensions = dimensions.map((dimension: unknown) => (typeof dimension === 'number' ? dimension : 0));
  const height = numericDimensions[2] || numericDimensions[1] || 640;
  const width = numericDimensions[3] || numericDimensions[2] || 640;

  return {
    width: Math.max(160, Math.min(2048, width)),
    height: Math.max(160, Math.min(2048, height)),
  };
}

function prepareInput(sourceCanvas: HTMLCanvasElement, inputWidth: number, inputHeight: number) {
  const canvas = document.createElement('canvas');
  canvas.width = inputWidth;
  canvas.height = inputHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas недоступен');

  const scale = Math.min(inputWidth / sourceCanvas.width, inputHeight / sourceCanvas.height);
  const drawWidth = sourceCanvas.width * scale;
  const drawHeight = sourceCanvas.height * scale;
  const offsetX = (inputWidth - drawWidth) / 2;
  const offsetY = (inputHeight - drawHeight) / 2;

  ctx.fillStyle = '#727272';
  ctx.fillRect(0, 0, inputWidth, inputHeight);
  ctx.drawImage(sourceCanvas, offsetX, offsetY, drawWidth, drawHeight);

  const imageData = ctx.getImageData(0, 0, inputWidth, inputHeight);
  const planeSize = inputWidth * inputHeight;
  const input = new Float32Array(planeSize * 3);

  for (let index = 0; index < planeSize; index += 1) {
    const pixel = index * 4;
    input[index] = imageData.data[pixel] / 255;
    input[index + planeSize] = imageData.data[pixel + 1] / 255;
    input[index + planeSize * 2] = imageData.data[pixel + 2] / 255;
  }

  return {
    input,
    scale,
    offsetX,
    offsetY,
  };
}

function toSourceBox(
  raw: { cx: number; cy: number; width: number; height: number; confidence: number },
  inputWidth: number,
  inputHeight: number,
  sourceWidth: number,
  sourceHeight: number,
  scale: number,
  offsetX: number,
  offsetY: number,
): NeuralBox | null {
  const normalized = Math.max(raw.cx, raw.cy, raw.width, raw.height) <= 2;
  const cx = normalized ? raw.cx * inputWidth : raw.cx;
  const cy = normalized ? raw.cy * inputHeight : raw.cy;
  const boxWidth = normalized ? raw.width * inputWidth : raw.width;
  const boxHeight = normalized ? raw.height * inputHeight : raw.height;
  const size = Math.max(boxWidth, boxHeight) * 1.08;
  const sourceCx = (cx - offsetX) / scale;
  const sourceCy = (cy - offsetY) / scale;
  const sourceSize = size / scale;

  if (sourceCx < 0 || sourceCy < 0 || sourceCx > sourceWidth || sourceCy > sourceHeight) return null;

  const x = Math.max(0, Math.min(sourceWidth - sourceSize, sourceCx - sourceSize / 2));
  const y = Math.max(0, Math.min(sourceHeight - sourceSize, sourceCy - sourceSize / 2));
  const width = Math.min(sourceSize, sourceWidth - x);
  const height = Math.min(sourceSize, sourceHeight - y);
  const finalSize = Math.max(8, Math.min(width, height));

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(finalSize),
    height: Math.round(finalSize),
    stage: 'neural',
    confidence: raw.confidence,
    candidateIndex: 0,
  };
}

function parseOutputTensor(
  tensor: import('onnxruntime-web').Tensor,
  inputWidth: number,
  inputHeight: number,
  sourceWidth: number,
  sourceHeight: number,
  scale: number,
  offsetX: number,
  offsetY: number,
) {
  const data = tensor.data as Float32Array | number[];
  const dims = tensor.dims;
  const boxes: NeuralBox[] = [];

  if (dims.length < 2) return boxes;

  const rows = dims[dims.length - 2] ?? 0;
  const columns = dims[dims.length - 1] ?? 0;
  const transposed = rows > columns && columns >= 5;
  const itemCount = transposed ? rows : columns;
  const itemSize = transposed ? columns : rows;

  if (itemSize < 5 || itemCount < 1) return boxes;

  for (let index = 0; index < itemCount; index += 1) {
    const values = new Array(itemSize);
    for (let itemIndex = 0; itemIndex < itemSize; itemIndex += 1) {
      values[itemIndex] = transposed ? data[index * itemSize + itemIndex] : data[itemIndex * itemCount + index];
    }

    const objectness = values[4] ?? 1;
    const classScore = itemSize > 5 ? Math.max(...values.slice(5)) : 1;
    const confidence = objectness * classScore;
    if (confidence < confidenceThreshold) continue;

    const box = toSourceBox(
      {
        cx: values[0],
        cy: values[1],
        width: values[2],
        height: values[3],
        confidence,
      },
      inputWidth,
      inputHeight,
      sourceWidth,
      sourceHeight,
      scale,
      offsetX,
      offsetY,
    );

    if (box) {
      box.candidateIndex = index;
      boxes.push(box);
    }
  }

  return boxes;
}

function parseEmbeddingTensor(tensor: import('onnxruntime-web').Tensor | undefined, itemCount: number) {
  if (!tensor || itemCount < 1) return [];

  const data = tensor.data as Float32Array | number[];
  const dims = tensor.dims;
  if (dims.length < 2) return [];

  const rows = dims[dims.length - 2] ?? 0;
  const columns = dims[dims.length - 1] ?? 0;
  const transposed = rows === itemCount;
  const embeddingSize = transposed ? columns : rows;
  const embeddings: number[][] = [];

  if (embeddingSize < 4 || (!transposed && columns !== itemCount)) return [];

  for (let index = 0; index < itemCount; index += 1) {
    const embedding = new Array(embeddingSize);
    let length = 0;

    for (let itemIndex = 0; itemIndex < embeddingSize; itemIndex += 1) {
      const value = transposed ? data[index * embeddingSize + itemIndex] : data[itemIndex * itemCount + index];
      embedding[itemIndex] = value;
      length += value * value;
    }

    const norm = Math.sqrt(length) || 1;
    embeddings[index] = embedding.map((value) => value / norm);
  }

  return embeddings;
}

function intersectionOverUnion(a: NeuralCapDetection, b: NeuralCapDetection) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a.width * a.height + b.width * b.height - intersection;

  return union ? intersection / union : 0;
}

function nms(boxes: NeuralBox[]) {
  const selected: NeuralBox[] = [];

  for (const box of boxes.sort((a, b) => b.confidence - a.confidence)) {
    if (selected.some((item) => intersectionOverUnion(item, box) > nmsThreshold)) continue;
    selected.push(box);
  }

  return selected;
}

export async function detectCapsWithStoredModel(sourceCanvas: HTMLCanvasElement): Promise<NeuralCapDetection[] | null> {
  let session: import('onnxruntime-web').InferenceSession | null = null;
  try {
    session = await getSession();
  } catch (error) {
    cachedSessionPromise = null;
    setLastStatus({
      state: 'error',
      message: `ONNX session failed: ${getErrorMessage(error)}`,
      rawBoxes: 0,
      selectedBoxes: 0,
    });
    throw error;
  }

  if (!session) {
    setLastStatus({
      state: 'no-model',
      message: 'ONNX model is not stored in IndexedDB',
      rawBoxes: 0,
      selectedBoxes: 0,
    });
    return null;
  }

  let ort: OrtModule;
  let inputName = '';
  let outputName = '';
  let embeddingOutputName: string | undefined;
  let inputWidth = 640;
  let inputHeight = 640;
  let prepared: ReturnType<typeof prepareInput>;
  let tensor: import('onnxruntime-web').Tensor;

  try {
    ort = await import('onnxruntime-web');
    configureOrt(ort);
    inputName = session.inputNames[0];
    outputName = session.outputNames[0];
    embeddingOutputName = session.outputNames[1];
    const inputSize = getModelInputSize(session);
    inputWidth = inputSize.width;
    inputHeight = inputSize.height;
    prepared = prepareInput(sourceCanvas, inputWidth, inputHeight);
    tensor = new ort.Tensor('float32', prepared.input, [1, 3, inputHeight, inputWidth]);
  } catch (error) {
    setLastStatus({
      state: 'error',
      message: `ONNX input failed: ${getErrorMessage(error)}`,
      rawBoxes: 0,
      selectedBoxes: 0,
      inputSize: `${inputWidth}x${inputHeight}`,
    });
    throw error;
  }

  setLastStatus({
    state: 'running',
    message: 'ONNX inference is running',
    rawBoxes: 0,
    selectedBoxes: 0,
    inputSize: `${inputWidth}x${inputHeight}`,
  });

  try {
    const output = await session.run({ [inputName]: tensor });
    const outputTensor = output[outputName];
    const boxes = parseOutputTensor(
      outputTensor,
      inputWidth,
      inputHeight,
      sourceCanvas.width,
      sourceCanvas.height,
      prepared.scale,
      prepared.offsetX,
      prepared.offsetY,
    );
    const embeddingCount = Math.max(0, ...boxes.map((box) => box.candidateIndex)) + 1;
    const embeddings = parseEmbeddingTensor(output[embeddingOutputName], embeddingCount);
    for (const box of boxes) {
      box.neuralEmbedding = embeddings[box.candidateIndex];
    }

    const selected = nms(boxes).map(({ confidence: _confidence, candidateIndex: _candidateIndex, ...box }) => box);
    setLastStatus({
      state: selected.length ? 'used' : 'empty',
      message: selected.length ? `ONNX used ${selected.length} boxes` : 'ONNX returned 0 boxes above threshold',
      rawBoxes: boxes.length,
      selectedBoxes: selected.length,
      inputSize: `${inputWidth}x${inputHeight}`,
      outputShape: outputTensor.dims.join('x'),
    });

    return selected;
  } catch (error) {
    setLastStatus({
      state: 'error',
      message: error instanceof Error ? error.message : 'ONNX inference failed',
      rawBoxes: 0,
      selectedBoxes: 0,
      inputSize: `${inputWidth}x${inputHeight}`,
    });
    throw error;
  }
}
