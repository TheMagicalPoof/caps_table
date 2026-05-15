export type Rgb = [number, number, number];

export type SampleCircle = {
  x: number;
  y: number;
  radius: number;
};

export type DetectionBox = {
  x: number;
  y: number;
  width: number;
  height: number;
  stage: 'circle' | 'foreground' | 'dense' | 'accepted' | 'fallback';
};

export type ProcessedCapPhoto = {
  averageColor: string;
  averageRgb: Rgb;
  cropDataUrl: string;
  foregroundBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  histogram: number[];
  sampleCircle: SampleCircle;
  source: {
    name: string;
    width: number;
    height: number;
    dataUrl: string;
    processedWidth: number;
    processedHeight: number;
    detectionBoxes?: DetectionBox[];
  };
};

export type SampleFingerprint = {
  averageRgb: Rgb;
  histogram: number[];
};

export type DuplicateCandidate = {
  index: number;
  score: number;
  colorDistance: number;
  histogramDistance: number;
};

const NORMALIZED_SIZE = 160;
const MIN_COMPONENT_AREA = 900;
const GRID_CELL = 18;
const MAX_DUPLICATE_COLOR_DISTANCE = 110;
const MAX_DUPLICATE_HISTOGRAM_DISTANCE = 0.3;
const DUPLICATE_SCORE_THRESHOLD = 0.24;

function clamp(value: number, lower = 0, upper = 255) {
  return Math.max(lower, Math.min(upper, value));
}

function rgbToHex(rgb: Rgb) {
  return `#${rgb.map((value) => clamp(Math.round(value)).toString(16).padStart(2, '0')).join('')}`;
}

function distance(a: Rgb, b: Rgb) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

function loadImage(file: File) {
  return new Promise<{ image: HTMLImageElement; dataUrl: string }>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Не удалось прочитать фото'));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('Не удалось загрузить фото'));
      const dataUrl = String(reader.result);
      image.onload = () => resolve({ image, dataUrl });
      image.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

function getPixel(data: Uint8ClampedArray, width: number, x: number, y: number): Rgb {
  const index = (y * width + x) * 4;
  return [data[index], data[index + 1], data[index + 2]];
}

function sampleBackground(data: Uint8ClampedArray, width: number, height: number): Rgb {
  const points: Array<[number, number]> = [
    [4, 4],
    [width - 5, 4],
    [4, height - 5],
    [width - 5, height - 5],
    [Math.floor(width / 2), 4],
    [Math.floor(width / 2), height - 5],
  ];
  const sum: Rgb = [0, 0, 0];

  for (const [rawX, rawY] of points) {
    const [r, g, b] = getPixel(data, width, clamp(rawX, 0, width - 1), clamp(rawY, 0, height - 1));
    sum[0] += r;
    sum[1] += g;
    sum[2] += b;
  }

  return [sum[0] / points.length, sum[1] / points.length, sum[2] / points.length];
}

function detectRawForegroundBounds(data: Uint8ClampedArray, width: number, height: number, threshold: number) {
  const background = sampleBackground(data, width, height);
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let count = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const current = getPixel(data, width, x, y);
      if (distance(current, background) < threshold) continue;

      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      count += 1;
    }
  }

  if (count < width * height * 0.01) {
    return null;
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    count,
  };
}

function squareBoxAround(box: { x: number; y: number; width: number; height: number }, width: number, height: number, padRatio: number) {
  let minX = box.x;
  let minY = box.y;
  let maxX = box.x + box.width - 1;
  let maxY = box.y + box.height - 1;
  const pad = Math.ceil(Math.max(maxX - minX, maxY - minY) * 0.12);
  const adjustedPad = Math.ceil(pad * (padRatio / 0.12));

  minX = clamp(minX - adjustedPad, 0, width - 1);
  minY = clamp(minY - adjustedPad, 0, height - 1);
  maxX = clamp(maxX + adjustedPad, 0, width - 1);
  maxY = clamp(maxY + adjustedPad, 0, height - 1);

  const boxWidth = maxX - minX + 1;
  const boxHeight = maxY - minY + 1;
  const size = Math.min(Math.max(boxWidth, boxHeight), Math.max(width, height));
  const centerX = minX + boxWidth / 2;
  const centerY = minY + boxHeight / 2;
  const x = clamp(Math.round(centerX - size / 2), 0, Math.max(0, width - size));
  const y = clamp(Math.round(centerY - size / 2), 0, Math.max(0, height - size));

  return { x, y, width: size, height: size };
}

function detectForegroundBox(data: Uint8ClampedArray, width: number, height: number, threshold: number) {
  const rawBox = detectRawForegroundBounds(data, width, height, threshold);
  if (!rawBox) return { x: 0, y: 0, width, height };

  return squareBoxAround(rawBox, width, height, 0.12);
}

function isDominantSingleObject(box: { x: number; y: number; width: number; height: number }, width: number, height: number) {
  const minDimension = Math.min(width, height);
  const maxDimension = Math.max(width, height);
  const boxSize = Math.max(box.width, box.height);
  const boxArea = box.width * box.height;
  const frameArea = width * height;
  const touchesTooMuchFrame =
    box.x <= minDimension * 0.015 ||
    box.y <= minDimension * 0.015 ||
    box.x + box.width >= width - minDimension * 0.015 ||
    box.y + box.height >= height - minDimension * 0.015;

  return boxSize >= minDimension * 0.38 && boxSize <= maxDimension * 0.96 && boxArea >= frameArea * 0.18 && !touchesTooMuchFrame;
}

function buildForegroundMask(data: Uint8ClampedArray, width: number, height: number, threshold: number) {
  const background = sampleBackground(data, width, height);
  const mask = new Uint8Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const current = getPixel(data, width, x, y);
      mask[y * width + x] = distance(current, background) >= threshold ? 1 : 0;
    }
  }

  return mask;
}

function detectForegroundComponents(data: Uint8ClampedArray, width: number, height: number, threshold: number) {
  const mask = buildForegroundMask(data, width, height, threshold);
  const visited = new Uint8Array(width * height);
  const components: Array<{ x: number; y: number; width: number; height: number; area: number }> = [];
  const minArea = Math.max(MIN_COMPONENT_AREA, width * height * 0.0015);

  for (let startY = 0; startY < height; startY += 1) {
    for (let startX = 0; startX < width; startX += 1) {
      const startIndex = startY * width + startX;
      if (!mask[startIndex] || visited[startIndex]) continue;

      const queue = [startIndex];
      visited[startIndex] = 1;
      let minX = startX;
      let minY = startY;
      let maxX = startX;
      let maxY = startY;
      let area = 0;

      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const index = queue[cursor];
        const x = index % width;
        const y = Math.floor(index / width);
        area += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);

        const neighbors = [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ];

        for (const [nx, ny] of neighbors) {
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const neighborIndex = ny * width + nx;
          if (!mask[neighborIndex] || visited[neighborIndex]) continue;

          visited[neighborIndex] = 1;
          queue.push(neighborIndex);
        }
      }

      const boxWidth = maxX - minX + 1;
      const boxHeight = maxY - minY + 1;
      const ratio = boxWidth / Math.max(1, boxHeight);
      if (area < minArea || ratio < 0.45 || ratio > 2.2) continue;

      const pad = Math.ceil(Math.max(boxWidth, boxHeight) * 0.14);
      minX = clamp(minX - pad, 0, width - 1);
      minY = clamp(minY - pad, 0, height - 1);
      maxX = clamp(maxX + pad, 0, width - 1);
      maxY = clamp(maxY + pad, 0, height - 1);

      const paddedWidth = maxX - minX + 1;
      const paddedHeight = maxY - minY + 1;
      const size = Math.min(Math.max(paddedWidth, paddedHeight), Math.max(width, height));
      const centerX = minX + paddedWidth / 2;
      const centerY = minY + paddedHeight / 2;
      const x = clamp(Math.round(centerX - size / 2), 0, Math.max(0, width - size));
      const y = clamp(Math.round(centerY - size / 2), 0, Math.max(0, height - size));

      if (size > Math.min(width, height) * 0.48) continue;

      components.push({ x, y, width: size, height: size, area });
    }
  }

  return components.sort((a, b) => b.area - a.area);
}

function intersectionOverUnion(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a.width * a.height + b.width * b.height - intersection;

  return union ? intersection / union : 0;
}

function getBoxCenter(box: { x: number; y: number; width: number; height: number }) {
  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  };
}

function mergeDetectedComponents(
  groups: Array<Array<{ x: number; y: number; width: number; height: number; area: number }>>,
) {
  const merged: Array<{ x: number; y: number; width: number; height: number; area: number }> = [];

  for (const group of groups) {
    for (const candidate of sortBoxesForReadingOrder(group)) {
      const candidateCenter = getBoxCenter(candidate);
      const candidateRadius = candidate.width / 2;
      const isDuplicate = merged.some((item) => {
        const itemCenter = getBoxCenter(item);
        const itemRadius = item.width / 2;
        const centerDistance = Math.hypot(itemCenter.x - candidateCenter.x, itemCenter.y - candidateCenter.y);
        return intersectionOverUnion(item, candidate) > 0.18 || centerDistance < Math.max(itemRadius, candidateRadius) * 0.62;
      });

      if (!isDuplicate) {
        merged.push(candidate);
      }
    }
  }

  return sortBoxesForReadingOrder(merged);
}

function detectDenseForegroundWindows(data: Uint8ClampedArray, width: number, height: number, threshold: number) {
  const mask = buildForegroundMask(data, width, height, threshold);
  const cols = Math.ceil(width / GRID_CELL);
  const rows = Math.ceil(height / GRID_CELL);
  const densities: number[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      let filled = 0;
      let total = 0;
      const startX = col * GRID_CELL;
      const startY = row * GRID_CELL;
      const endX = Math.min(width, startX + GRID_CELL);
      const endY = Math.min(height, startY + GRID_CELL);

      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          filled += mask[y * width + x];
          total += 1;
        }
      }

      densities[row * cols + col] = filled / Math.max(1, total);
    }
  }

  const candidates: Array<{ x: number; y: number; width: number; height: number; area: number; score: number }> = [];

  for (let row = 1; row < rows - 1; row += 1) {
    for (let col = 1; col < cols - 1; col += 1) {
      const centerDensity = densities[row * cols + col];
      if (centerDensity < 0.32) continue;

      const neighborDensity =
        densities[(row - 1) * cols + col] +
        densities[(row + 1) * cols + col] +
        densities[row * cols + col - 1] +
        densities[row * cols + col + 1];
      const score = centerDensity + neighborDensity * 0.25;
      if (score < 0.65) continue;

      let minX = col * GRID_CELL;
      let minY = row * GRID_CELL;
      let maxX = minX + GRID_CELL;
      let maxY = minY + GRID_CELL;

      for (let grow = 1; grow <= 5; grow += 1) {
        const left = Math.max(0, col - grow);
        const right = Math.min(cols - 1, col + grow);
        const top = Math.max(0, row - grow);
        const bottom = Math.min(rows - 1, row + grow);
        const ring = [
          densities[top * cols + col],
          densities[bottom * cols + col],
          densities[row * cols + left],
          densities[row * cols + right],
        ];
        if (ring.every((density) => density < 0.12)) break;

        minX = left * GRID_CELL;
        minY = top * GRID_CELL;
        maxX = Math.min(width, (right + 1) * GRID_CELL);
        maxY = Math.min(height, (bottom + 1) * GRID_CELL);
      }

      const size = Math.max(maxX - minX, maxY - minY);
      if (size < 28 || size > Math.min(width, height) * 0.42) continue;

      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      const cropSize = Math.min(size * 1.18, Math.min(width, height));
      const x = clamp(Math.round(centerX - cropSize / 2), 0, Math.max(0, width - cropSize));
      const y = clamp(Math.round(centerY - cropSize / 2), 0, Math.max(0, height - cropSize));

      candidates.push({
        x,
        y,
        width: Math.round(cropSize),
        height: Math.round(cropSize),
        area: Math.round(cropSize * cropSize),
        score,
      });
    }
  }

  const selected: Array<{ x: number; y: number; width: number; height: number; area: number }> = [];
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    if (selected.some((item) => intersectionOverUnion(item, candidate) > 0.22)) continue;
    selected.push(candidate);
    if (selected.length >= 120) break;
  }

  return selected;
}

function percentile(values: number[], p: number) {
  if (!values.length) return 0;

  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))];
}

function median(values: number[]) {
  return percentile(values, 0.5);
}

function detectCircleCandidates(data: Uint8ClampedArray, width: number, height: number, sensitivity: number) {
  const gray = new Float32Array(width * height);
  for (let index = 0; index < width * height; index += 1) {
    const pixel = index * 4;
    gray[index] = data[pixel] * 0.299 + data[pixel + 1] * 0.587 + data[pixel + 2] * 0.114;
  }

  const magnitudes: number[] = [];
  const gradients: Array<{ x: number; y: number; gx: number; gy: number; magnitude: number }> = [];
  const edgeStride = Math.max(1, Math.round(Math.min(width, height) / 700));

  for (let y = 1; y < height - 1; y += edgeStride) {
    for (let x = 1; x < width - 1; x += edgeStride) {
      const topLeft = gray[(y - 1) * width + x - 1];
      const top = gray[(y - 1) * width + x];
      const topRight = gray[(y - 1) * width + x + 1];
      const left = gray[y * width + x - 1];
      const right = gray[y * width + x + 1];
      const bottomLeft = gray[(y + 1) * width + x - 1];
      const bottom = gray[(y + 1) * width + x];
      const bottomRight = gray[(y + 1) * width + x + 1];
      const gx = -topLeft - left * 2 - bottomLeft + topRight + right * 2 + bottomRight;
      const gy = -topLeft - top * 2 - topRight + bottomLeft + bottom * 2 + bottomRight;
      const magnitude = Math.sqrt(gx * gx + gy * gy);

      magnitudes.push(magnitude);
      gradients.push({ x, y, gx, gy, magnitude });
    }
  }

  const percentileLevel = 0.94 - (clamp(sensitivity, 10, 120) - 10) / 110 * 0.2;
  const edgeThreshold = Math.max(32, percentile(magnitudes, percentileLevel));
  const edges = gradients.filter((edge) => edge.magnitude >= edgeThreshold);
  if (!edges.length) return [];

  const minDimension = Math.min(width, height);
  const minRadius = Math.max(16, Math.round(minDimension * 0.018));
  const maxRadius = Math.max(minRadius + 8, Math.round(minDimension * 0.095));
  const radiusStep = Math.max(3, Math.round(minRadius * 0.28));
  const voteScale = Math.max(3, Math.round(minDimension / 420));
  const accWidth = Math.ceil(width / voteScale);
  const accHeight = Math.ceil(height / voteScale);
  const candidates: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    area: number;
    centerX: number;
    centerY: number;
    radius: number;
    score: number;
  }> = [];

  function sampleGray(x: number, y: number) {
    return gray[clamp(Math.round(y), 0, height - 1) * width + clamp(Math.round(x), 0, width - 1)];
  }

  function getOuterRingContrast(centerX: number, centerY: number, radius: number) {
    const samples = 24;
    let innerSum = 0;
    let outerSum = 0;
    let used = 0;

    for (let index = 0; index < samples; index += 1) {
      const angle = (Math.PI * 2 * index) / samples;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const innerX = centerX + cos * radius * 0.86;
      const innerY = centerY + sin * radius * 0.86;
      const outerX = centerX + cos * radius * 1.12;
      const outerY = centerY + sin * radius * 1.12;
      if (outerX < 0 || outerY < 0 || outerX >= width || outerY >= height) continue;

      innerSum += sampleGray(innerX, innerY);
      outerSum += sampleGray(outerX, outerY);
      used += 1;
    }

    if (used < samples * 0.7) return 0;
    return Math.abs(innerSum / used - outerSum / used);
  }

  for (let radius = minRadius; radius <= maxRadius; radius += radiusStep) {
    const accumulator = new Uint16Array(accWidth * accHeight);

    for (const edge of edges) {
      const length = Math.max(1, Math.sqrt(edge.gx * edge.gx + edge.gy * edge.gy));
      const ux = edge.gx / length;
      const uy = edge.gy / length;

      for (const direction of [-1, 1]) {
        const centerX = Math.round((edge.x + ux * radius * direction) / voteScale);
        const centerY = Math.round((edge.y + uy * radius * direction) / voteScale);
        if (centerX < 0 || centerY < 0 || centerX >= accWidth || centerY >= accHeight) continue;

        accumulator[centerY * accWidth + centerX] += 1;
      }
    }

    const voteThreshold = Math.max(6, Math.round((Math.PI * radius) / (edgeStride * voteScale * 2.4)));

    for (let y = 1; y < accHeight - 1; y += 1) {
      for (let x = 1; x < accWidth - 1; x += 1) {
        const index = y * accWidth + x;
        const value = accumulator[index];
        if (value < voteThreshold) continue;

        if (
          value < accumulator[index - 1] ||
          value < accumulator[index + 1] ||
          value < accumulator[index - accWidth] ||
          value < accumulator[index + accWidth]
        ) {
          continue;
        }

        const centerX = x * voteScale;
        const centerY = y * voteScale;
        const cropSize = Math.min(radius * 2.28, minDimension);
        const cropX = clamp(Math.round(centerX - cropSize / 2), 0, Math.max(0, width - cropSize));
        const cropY = clamp(Math.round(centerY - cropSize / 2), 0, Math.max(0, height - cropSize));
        const outerContrast = getOuterRingContrast(centerX, centerY, radius);
        if (outerContrast < 6) continue;

        candidates.push({
          x: cropX,
          y: cropY,
          width: Math.round(cropSize),
          height: Math.round(cropSize),
          area: Math.round(cropSize * cropSize),
          centerX,
          centerY,
          radius,
          score: (value / Math.max(1, radius)) * (1 + outerContrast / 80) * (1 + radius / maxRadius * 0.35),
        });
      }
    }
  }

  const strongCandidates = candidates
    .filter((candidate) => candidate.score >= percentile(candidates.map((item) => item.score), 0.52))
    .sort((a, b) => b.radius - a.radius || b.score - a.score);
  const expectedRadius = median(strongCandidates.slice(0, Math.max(12, Math.ceil(strongCandidates.length * 0.35))).map((item) => item.radius));
  const selected: Array<{ x: number; y: number; width: number; height: number; area: number }> = [];

  for (const candidate of strongCandidates) {
    if (expectedRadius && candidate.radius < expectedRadius * 0.62) continue;
    if (expectedRadius && candidate.radius > expectedRadius * 1.45) continue;

    if (
      selected.some((item) => {
        const itemCenterX = item.x + item.width / 2;
        const itemCenterY = item.y + item.height / 2;
        const itemRadius = item.width / 2.28;
        const centerDistance = Math.hypot(itemCenterX - candidate.centerX, itemCenterY - candidate.centerY);
        const samePhysicalCap = centerDistance < Math.max(itemRadius, candidate.radius, expectedRadius || 0) * 1.55;
        return intersectionOverUnion(item, candidate) > 0.08 || samePhysicalCap;
      })
    ) {
      continue;
    }

    selected.push(candidate);
    if (selected.length >= 80) break;
  }

  return selected;
}

function getDefaultSampleCircle(width: number, height: number): SampleCircle {
  return {
    x: width / 2,
    y: height / 2,
    radius: Math.min(width, height) * 0.43,
  };
}

function normalizeSampleCircle(circle: SampleCircle | undefined, width: number, height: number): SampleCircle {
  const fallback = getDefaultSampleCircle(width, height);
  const radius = clamp(Math.round(circle?.radius ?? fallback.radius), 12, Math.min(width, height) / 2);
  const x = clamp(Math.round(circle?.x ?? fallback.x), radius, width - radius);
  const y = clamp(Math.round(circle?.y ?? fallback.y), radius, height - radius);

  return { x, y, radius };
}

function getCircularPixels(data: Uint8ClampedArray, width: number, height: number, circle?: SampleCircle) {
  const sampleCircle = normalizeSampleCircle(circle, width, height);
  const pixels: Rgb[] = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - sampleCircle.x;
      const dy = y - sampleCircle.y;
      if (dx * dx + dy * dy > sampleCircle.radius * sampleCircle.radius) continue;

      pixels.push(getPixel(data, width, x, y));
    }
  }

  return pixels;
}

function getSampleFingerprint(cropData: ImageData, sampleCircle?: SampleCircle) {
  const normalizedCircle = normalizeSampleCircle(sampleCircle, cropData.width, cropData.height);
  const pixels = getCircularPixels(cropData.data, cropData.width, cropData.height, normalizedCircle);
  const averageRgb = computeAverage(pixels);

  return {
    averageColor: rgbToHex(averageRgb),
    averageRgb,
    histogram: computeHistogram(pixels),
    sampleCircle: normalizedCircle,
  };
}

function computeAverage(pixels: Rgb[]): Rgb {
  const sum: Rgb = [0, 0, 0];

  for (const pixel of pixels) {
    sum[0] += pixel[0];
    sum[1] += pixel[1];
    sum[2] += pixel[2];
  }

  return [sum[0] / pixels.length, sum[1] / pixels.length, sum[2] / pixels.length];
}

function computeHistogram(pixels: Rgb[]) {
  const bins = Array.from({ length: 64 }, () => 0);

  for (const [r, g, b] of pixels) {
    const ri = Math.min(3, Math.floor(r / 64));
    const gi = Math.min(3, Math.floor(g / 64));
    const bi = Math.min(3, Math.floor(b / 64));
    bins[ri * 16 + gi * 4 + bi] += 1;
  }

  return bins.map((value) => value / Math.max(1, pixels.length));
}

export async function processCapPhoto(file: File, foregroundThreshold: number): Promise<ProcessedCapPhoto> {
  const { image, dataUrl } = await loadImage(file);
  const scale = Math.min(1, 1200 / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.round(image.naturalWidth * scale);
  const height = Math.round(image.naturalHeight * scale);
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = width;
  sourceCanvas.height = height;
  const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  if (!sourceCtx) throw new Error('Canvas недоступен');

  sourceCtx.drawImage(image, 0, 0, width, height);
  const sourceData = sourceCtx.getImageData(0, 0, width, height);
  const foregroundBox = detectForegroundBox(sourceData.data, width, height, foregroundThreshold);
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = NORMALIZED_SIZE;
  cropCanvas.height = NORMALIZED_SIZE;
  const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true });
  if (!cropCtx) throw new Error('Canvas недоступен');

  cropCtx.drawImage(
    sourceCanvas,
    foregroundBox.x,
    foregroundBox.y,
    foregroundBox.width,
    foregroundBox.height,
    0,
    0,
    NORMALIZED_SIZE,
    NORMALIZED_SIZE,
  );

  const cropData = cropCtx.getImageData(0, 0, NORMALIZED_SIZE, NORMALIZED_SIZE);
  const fingerprint = getSampleFingerprint(cropData);

  return {
    averageColor: fingerprint.averageColor,
    averageRgb: fingerprint.averageRgb,
    cropDataUrl: cropCanvas.toDataURL('image/jpeg', 0.9),
    foregroundBox,
    histogram: fingerprint.histogram,
    sampleCircle: fingerprint.sampleCircle,
    source: {
      name: file.name,
      width: image.naturalWidth,
      height: image.naturalHeight,
      dataUrl,
      processedWidth: width,
      processedHeight: height,
    },
  };
}

function makeProcessedPhoto(
  sourceCanvas: HTMLCanvasElement,
  foregroundBox: { x: number; y: number; width: number; height: number },
  source: ProcessedCapPhoto['source'],
  sampleCircle?: SampleCircle,
): ProcessedCapPhoto {
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = NORMALIZED_SIZE;
  cropCanvas.height = NORMALIZED_SIZE;
  const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true });
  if (!cropCtx) throw new Error('Canvas недоступен');

  cropCtx.drawImage(
    sourceCanvas,
    foregroundBox.x,
    foregroundBox.y,
    foregroundBox.width,
    foregroundBox.height,
    0,
    0,
    NORMALIZED_SIZE,
    NORMALIZED_SIZE,
  );

  const cropData = cropCtx.getImageData(0, 0, NORMALIZED_SIZE, NORMALIZED_SIZE);
  const fingerprint = getSampleFingerprint(cropData, sampleCircle);

  return {
    averageColor: fingerprint.averageColor,
    averageRgb: fingerprint.averageRgb,
    cropDataUrl: cropCanvas.toDataURL('image/jpeg', 0.9),
    foregroundBox,
    histogram: fingerprint.histogram,
    sampleCircle: fingerprint.sampleCircle,
    source,
  };
}

function sortBoxesForReadingOrder<T extends { x: number; y: number; width: number; height: number }>(boxes: T[]) {
  const medianSize =
    boxes.length > 0
      ? [...boxes].sort((a, b) => a.height - b.height)[Math.floor(boxes.length / 2)].height
      : 0;
  const rowTolerance = Math.max(16, medianSize * 0.55);

  return [...boxes].sort((a, b) => {
    const centerAY = a.y + a.height / 2;
    const centerBY = b.y + b.height / 2;
    if (Math.abs(centerAY - centerBY) > rowTolerance) {
      return centerAY - centerBY;
    }

    const centerAX = a.x + a.width / 2;
    const centerBX = b.x + b.width / 2;
    return centerAX - centerBX;
  });
}

function makeDetectionBoxes(
  boxes: Array<{ x: number; y: number; width: number; height: number }>,
  stage: DetectionBox['stage'],
  limit = 160,
): DetectionBox[] {
  return sortBoxesForReadingOrder(boxes)
    .slice(0, limit)
    .map((box) => ({
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      stage,
    }));
}

export async function processCapBatchPhoto(file: File, foregroundThreshold: number): Promise<ProcessedCapPhoto[]> {
  const { image, dataUrl } = await loadImage(file);
  const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.round(image.naturalWidth * scale);
  const height = Math.round(image.naturalHeight * scale);
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = width;
  sourceCanvas.height = height;
  const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  if (!sourceCtx) throw new Error('Canvas недоступен');

  sourceCtx.drawImage(image, 0, 0, width, height);
  const sourceData = sourceCtx.getImageData(0, 0, width, height);
  const source: ProcessedCapPhoto['source'] = {
    name: file.name,
    width: image.naturalWidth,
    height: image.naturalHeight,
    dataUrl,
    processedWidth: width,
    processedHeight: height,
  };
  const rawForegroundBox = detectRawForegroundBounds(sourceData.data, width, height, foregroundThreshold);
  const foregroundBox = rawForegroundBox
    ? squareBoxAround(rawForegroundBox, width, height, 0.08)
    : { x: 0, y: 0, width, height };

  if (rawForegroundBox && isDominantSingleObject(rawForegroundBox, width, height)) {
    source.detectionBoxes = makeDetectionBoxes([foregroundBox], 'fallback');
    return [makeProcessedPhoto(sourceCanvas, foregroundBox, source)];
  }

  const circleComponents = detectCircleCandidates(sourceData.data, width, height, foregroundThreshold);
  const foregroundComponents = detectForegroundComponents(sourceData.data, width, height, foregroundThreshold);
  const denseComponents = detectDenseForegroundWindows(sourceData.data, width, height, foregroundThreshold);
  const components = mergeDetectedComponents([circleComponents, foregroundComponents, denseComponents]);

  if (!components.length) {
    source.detectionBoxes = makeDetectionBoxes([foregroundBox], 'fallback');
    return [makeProcessedPhoto(sourceCanvas, foregroundBox, source)];
  }

  const orderedComponents = sortBoxesForReadingOrder(components);
  source.detectionBoxes = [
    ...makeDetectionBoxes(circleComponents, 'circle'),
    ...makeDetectionBoxes(foregroundComponents, 'foreground'),
    ...makeDetectionBoxes(denseComponents, 'dense'),
    ...makeDetectionBoxes(orderedComponents, 'accepted'),
  ];

  return orderedComponents.map((component, index) =>
    makeProcessedPhoto(sourceCanvas, component, {
      ...source,
      name: `${file.name} #${index + 1}`,
    }),
  );
}

export function reprocessCapCrop(
  photo: ProcessedCapPhoto,
  nextBox: { x: number; y: number; width: number; height: number },
): Promise<ProcessedCapPhoto> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error('Не удалось загрузить исходное фото'));
    image.onload = () => {
      const sourceCanvas = document.createElement('canvas');
      sourceCanvas.width = photo.source.processedWidth;
      sourceCanvas.height = photo.source.processedHeight;
      const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
      if (!sourceCtx) {
        reject(new Error('Canvas недоступен'));
        return;
      }

      sourceCtx.drawImage(image, 0, 0, sourceCanvas.width, sourceCanvas.height);
      resolve(makeProcessedPhoto(sourceCanvas, nextBox, photo.source, photo.sampleCircle));
    };
    image.src = photo.source.dataUrl;
  });
}

export function reprocessCapSampling(photo: ProcessedCapPhoto, nextCircle: SampleCircle): Promise<ProcessedCapPhoto> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error('Не удалось загрузить кроп'));
    image.onload = () => {
      const cropCanvas = document.createElement('canvas');
      cropCanvas.width = NORMALIZED_SIZE;
      cropCanvas.height = NORMALIZED_SIZE;
      const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true });
      if (!cropCtx) {
        reject(new Error('Canvas недоступен'));
        return;
      }

      cropCtx.drawImage(image, 0, 0, NORMALIZED_SIZE, NORMALIZED_SIZE);
      const cropData = cropCtx.getImageData(0, 0, NORMALIZED_SIZE, NORMALIZED_SIZE);
      const fingerprint = getSampleFingerprint(cropData, nextCircle);
      resolve({
        ...photo,
        averageColor: fingerprint.averageColor,
        averageRgb: fingerprint.averageRgb,
        histogram: fingerprint.histogram,
        sampleCircle: fingerprint.sampleCircle,
      });
    };
    image.src = photo.cropDataUrl;
  });
}

function histogramDistance(a: number[], b: number[]) {
  const length = Math.min(a.length, b.length);
  let diff = 0;

  for (let index = 0; index < length; index += 1) {
    diff += Math.abs(a[index] - b[index]);
  }

  return diff / 2;
}

export function findDuplicateCandidates(
  current: SampleFingerprint,
  samples: SampleFingerprint[],
): DuplicateCandidate[] {
  return samples
    .map((sample, index) => {
      const colorDistance = distance(current.averageRgb, sample.averageRgb);
      const histogramDiff = histogramDistance(current.histogram, sample.histogram);
      const normalizedColorDistance = colorDistance / 441;
      const colorPenalty = Math.max(0, (colorDistance - 70) / 140);
      const score = normalizedColorDistance * 0.55 + histogramDiff * 0.45 + colorPenalty * 0.35;

      return {
        index,
        score,
        colorDistance,
        histogramDistance: histogramDiff,
      };
    })
    .filter(
      (candidate) =>
        candidate.colorDistance <= MAX_DUPLICATE_COLOR_DISTANCE &&
        candidate.histogramDistance <= MAX_DUPLICATE_HISTOGRAM_DISTANCE &&
        candidate.score < DUPLICATE_SCORE_THRESHOLD,
    )
    .sort((a, b) => a.score - b.score)
    .slice(0, 5);
}
