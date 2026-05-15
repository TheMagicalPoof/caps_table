<script lang="ts">
  import { base } from '$app/paths';
  import { datasetDraftToCapsInventory, readDatasetDraft } from '$lib/datasetDraft';
  import { detectBrowserLocale, tl, t, type Locale } from '$lib/i18n';
  import { onMount } from 'svelte';

  type Cap = {
    id: number;
    x: number;
    y: number;
    color: string;
    image?: string;
    label?: string;
    target_color?: string | null;
    type_id: number;
    diameter: number;
  };

  type TableMeta = {
    used_caps: number;
    total_caps: number;
    capacity: number;
    requested_table_height: number;
    effective_table_height: number;
    use_all_caps: boolean;
  };

  type SourceCap = {
    color: string;
    diameter?: number;
    image?: string;
    label?: string;
    type_id?: number;
  };

  type CapType = {
    type_id: number;
    color: string;
    count: number;
    diameter?: number;
    label?: string;
    name?: string;
  };

  type CapsInventory = {
    caps: SourceCap[];
    types: CapType[];
  };

  type DatasetMeta = {
    image_count: number;
    sample_count: number;
    annotation_count: number;
    unknown_type_ids: number[];
  };

  type HexCell = {
    row: number;
    col: number;
    x: number;
    y: number;
  };

  type ColorGroup = {
    color: string;
    rgb: [number, number, number];
    caps: SourceCap[];
  };

  type LayoutSettings = {
    capRenderMode?: 'color' | 'photo';
    capsDiameter?: number;
    clusterPenalty?: number;
    ditherStrength?: number;
    gradientAngle?: number;
    gradientMode?: 'linear' | 'radial';
    gradientOpacity?: number;
    gradientStops?: string[];
    luminanceGuard?: number;
    randomness?: number;
    rotation?: number;
    tableHeight?: number;
    tableWidth?: number;
    transitionNoise?: number;
  };

  let showGradient = true;
  let gradientOpacity = 0;
  let gradientImage: HTMLImageElement | null = null;
  let gradientMode: 'linear' | 'radial' = 'linear';
  let capRenderMode: 'color' | 'photo' = 'color';
  let gradientAngle = 45;
  let gradientStops = ['#ff0000', '#00ff00', '#0000ff'];
  let ditherStrength = 0.85;
  let transitionNoise = 0.035;
  let luminanceGuard = 1.6;
  let clusterPenalty = 140;
  let randomness = 100;
  let tableMeta: TableMeta | null = null;
  let loadedCapsData: SourceCap[] | null = null;
  let loadedCapTypes: CapType[] = [];
  let locale: Locale = 'ru';
  let capsFileName = tl(locale, 'noInventory');
  let capsFileError = '';
  let datasetFileName = tl(locale, 'datasetNotLoaded');
  let datasetMeta: DatasetMeta | null = null;
  let datasetFileError = '';

  let tableWidth = 500;
  let tableHeight = 500;
  let capsDiameter = 30;

  let canvas: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D | null = null;

  const caps = new Map<number, Cap>();
  const capImageCache = new Map<string, HTMLImageElement | null>();
  const gradientPresets = [
    { name: 'RGB', mode: 'linear', angle: 45, stops: ['#ff0000', '#00ff00', '#0000ff'] },
    { name: 'warm', mode: 'linear', angle: 90, stops: ['#ff2d2d', '#ff9f1c', '#ffe66d'] },
    { name: 'ocean', mode: 'linear', angle: 90, stops: ['#00f5d4', '#00bbf9', '#4361ee'] },
    { name: 'sunset', mode: 'linear', angle: 35, stops: ['#7b2cbf', '#f72585', '#ffb703'] },
    { name: 'radius', mode: 'radial', angle: 45, stops: ['#fff7ad', '#22c55e', '#0f172a'] },
  ] as const;

  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let hasUserMovedView = false;
  let hasAutoFitView = false;

  let dragging = false;
  let dragStart = { x: 0, y: 0 };
  let rotation = 0;
  let hoveredCap: Cap | null = null;
  let hoverPosition = { x: 0, y: 0 };
  const exportScale = 4;
  const layoutSettingsKey = 'caps-table-layout-settings';

  function getStoredNumber(value: unknown, fallback: number, min: number, max: number) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;

    return Math.max(min, Math.min(max, parsed));
  }

  function persistLayoutSettings() {
    const settings: LayoutSettings = {
      capRenderMode,
      capsDiameter: Number(capsDiameter),
      clusterPenalty: Number(clusterPenalty),
      ditherStrength: Number(ditherStrength),
      gradientAngle: Number(gradientAngle),
      gradientMode,
      gradientOpacity: Number(gradientOpacity),
      gradientStops,
      luminanceGuard: Number(luminanceGuard),
      randomness: Number(randomness),
      rotation,
      tableHeight: Number(tableHeight),
      tableWidth: Number(tableWidth),
      transitionNoise: Number(transitionNoise),
    };

    localStorage.setItem(layoutSettingsKey, JSON.stringify(settings));
  }

  function restoreLayoutSettings() {
    try {
      const rawSettings = localStorage.getItem(layoutSettingsKey);
      if (!rawSettings) return;

      const settings = JSON.parse(rawSettings) as LayoutSettings;
      if (settings.capRenderMode === 'color' || settings.capRenderMode === 'photo') capRenderMode = settings.capRenderMode;
      if (settings.gradientMode === 'linear' || settings.gradientMode === 'radial') gradientMode = settings.gradientMode;
      if (Array.isArray(settings.gradientStops)) {
        const stops = settings.gradientStops.filter((color) => normalizeHexColor(color));
        if (stops.length >= 2) gradientStops = stops;
      }

      capsDiameter = getStoredNumber(settings.capsDiameter, capsDiameter, 1, 5000);
      clusterPenalty = getStoredNumber(settings.clusterPenalty, clusterPenalty, 0, 300);
      ditherStrength = getStoredNumber(settings.ditherStrength, ditherStrength, 0, 1.5);
      gradientAngle = getStoredNumber(settings.gradientAngle, gradientAngle, 0, 360);
      gradientOpacity = getStoredNumber(settings.gradientOpacity, gradientOpacity, 0, 1);
      luminanceGuard = getStoredNumber(settings.luminanceGuard, luminanceGuard, 0, 4);
      randomness = getStoredNumber(settings.randomness, randomness, 0, 120);
      rotation = getStoredNumber(settings.rotation, rotation, 0, 359);
      tableHeight = getStoredNumber(settings.tableHeight, tableHeight, 1, 5000);
      tableWidth = getStoredNumber(settings.tableWidth, tableWidth, 1, 5000);
      transitionNoise = getStoredNumber(settings.transitionNoise, transitionNoise, 0, 0.15);
    } catch {
      localStorage.removeItem(layoutSettingsKey);
    }
  }

  function resizeCanvas() {
    if (!canvas) return;
    const parent = canvas.parentElement;
    canvas.width = parent?.clientWidth ?? window.innerWidth;
    canvas.height = parent?.clientHeight ?? Math.max(window.innerHeight - canvas.offsetTop - 4, 320);
    if (hasAutoFitView) {
      centerTableIfNeeded();
    } else {
      fitTableToView();
    }
    draw();
  }

  function centerTableIfNeeded(force = false) {
    if (!canvas || (!force && hasUserMovedView)) return;

    offsetX = (canvas.width - tableWidth * scale) / 2 + (capsDiameter * scale) / 2;
    offsetY = (canvas.height - tableHeight * scale) / 2 + (capsDiameter * scale) / 2;
  }

  function fitTableToView(force = false) {
    if (!canvas || (!force && hasUserMovedView)) return;

    const padding = 32;
    const rotated = rotation % 180 !== 0;
    const fitWidth = rotated ? tableHeight : tableWidth;
    const fitHeight = rotated ? tableWidth : tableHeight;
    const availableWidth = Math.max(1, canvas.width - padding * 2);
    const availableHeight = Math.max(1, canvas.height - padding * 2);

    scale = Math.min(
      availableWidth / Math.max(fitWidth, 1),
      availableHeight / Math.max(fitHeight, 1),
      1,
    );
    centerTableIfNeeded(true);
    hasAutoFitView = true;
  }

  function getCapImage(src: string) {
    if (capImageCache.has(src)) {
      return capImageCache.get(src) ?? null;
    }

    const image = new Image();
    capImageCache.set(src, null);
    image.onload = () => {
      capImageCache.set(src, image);
      draw();
    };
    image.onerror = () => {
      capImageCache.delete(src);
    };
    image.src = src;

    return null;
  }

  function drawCapPhoto(cap: Cap, centerX: number, centerY: number, radius: number) {
    if (!cap.image || !ctx) return false;

    const image = getCapImage(cap.image);
    if (!image) return false;

    ctx.save();
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
    ctx.clip();
    ctx.drawImage(image, centerX - radius, centerY - radius, radius * 2, radius * 2);
    ctx.restore();
    return true;
  }

  function drawCapPhotoTo(targetCtx: CanvasRenderingContext2D, cap: Cap, centerX: number, centerY: number, radius: number) {
    if (!cap.image) return false;

    const image = getCapImage(cap.image);
    if (!image) return false;

    targetCtx.save();
    targetCtx.beginPath();
    targetCtx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
    targetCtx.clip();
    targetCtx.drawImage(image, centerX - radius, centerY - radius, radius * 2, radius * 2);
    targetCtx.restore();
    return true;
  }

  function getCanvasGradientForContext(targetCtx: CanvasRenderingContext2D, width: number, height: number) {
    if (gradientMode === 'radial') {
      return targetCtx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) / 2);
    }

    const angle = (gradientAngle * Math.PI) / 180;
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const cx = width / 2;
    const cy = height / 2;
    const length = Math.abs(width * ux) + Math.abs(height * uy);

    return targetCtx.createLinearGradient(
      cx - (ux * length) / 2,
      cy - (uy * length) / 2,
      cx + (ux * length) / 2,
      cy + (uy * length) / 2,
    );
  }

  function drawTableTo(targetCtx: CanvasRenderingContext2D, pixelScale = 1, includeBackground = true, forcePhotos = false) {
    const width = Math.max(1, Math.round(tableWidth * pixelScale));
    const height = Math.max(1, Math.round(tableHeight * pixelScale));
    targetCtx.clearRect(0, 0, width, height);

    if (includeBackground) {
      targetCtx.fillStyle = '#202833';
      targetCtx.fillRect(0, 0, width, height);
    }

    targetCtx.save();
    targetCtx.scale(pixelScale, pixelScale);

    for (const cap of caps.values()) {
      const centerX = cap.x + capsDiameter / 2;
      const centerY = cap.y + capsDiameter / 2;
      const radius = (cap.diameter ?? capsDiameter) / 2;
      const photoDrawn = (forcePhotos || capRenderMode === 'photo') && drawCapPhotoTo(targetCtx, cap, centerX, centerY, radius);

      targetCtx.beginPath();
      targetCtx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
      if (!photoDrawn) {
        targetCtx.fillStyle = cap.color;
        targetCtx.fill();
      }
      targetCtx.strokeStyle = 'rgba(0, 0, 0, 0.76)';
      targetCtx.lineWidth = 1.4 / pixelScale;
      targetCtx.stroke();
    }

    if (showGradient && gradientOpacity > 0) {
      const gradient = getCanvasGradientForContext(targetCtx, tableWidth, tableHeight);
      gradientStops.forEach((color, index) => {
        gradient.addColorStop(index / (gradientStops.length - 1), color);
      });
      targetCtx.globalAlpha = gradientOpacity;
      targetCtx.fillStyle = gradient;
      targetCtx.fillRect(0, 0, tableWidth, tableHeight);
      targetCtx.globalAlpha = 1;
    }

    targetCtx.restore();
  }

  function exportHighResolutionPng() {
    if (!caps.size) return;

    const offscreen = document.createElement('canvas');
    offscreen.width = Math.max(1, Math.round(tableWidth * exportScale));
    offscreen.height = Math.max(1, Math.round(tableHeight * exportScale));
    const exportCtx = offscreen.getContext('2d');
    if (!exportCtx) return;

    drawTableTo(exportCtx, exportScale, true, true);

    const link = document.createElement('a');
    link.href = offscreen.toDataURL('image/png');
    link.download = `caps-table-${Math.round(tableWidth)}x${Math.round(tableHeight)}@${exportScale}x.png`;
    link.click();
  }

  function setCapRenderMode(nextMode: 'color' | 'photo') {
    capRenderMode = nextMode;
    persistLayoutSettings();
    draw();
  }

  function updateGradientOpacity() {
    persistLayoutSettings();
    draw();
  }

  function draw() {
    if (!ctx || !canvas) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.translate(-canvas.width / 2, -canvas.height / 2);

    ctx.beginPath();
    ctx.rect(
      offsetX - (capsDiameter / 2) * scale,
      offsetY - (capsDiameter / 2) * scale,
      tableWidth * scale,
      tableHeight * scale,
    );
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 2;
    ctx.stroke();

    for (const cap of caps.values()) {
      const centerX = cap.x * scale + offsetX;
      const centerY = cap.y * scale + offsetY;
      const radius = (capsDiameter * scale) / 2;
      const photoDrawn = capRenderMode === 'photo' && drawCapPhoto(cap, centerX, centerY, radius);

      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
      if (!photoDrawn) {
        ctx.fillStyle = cap.color;
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.76)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }

    if (showGradient && gradientOpacity > 0 && gradientImage) {
      ctx.globalAlpha = gradientOpacity;
      ctx.drawImage(
        gradientImage,
        offsetX - (capsDiameter / 2) * scale,
        offsetY - (capsDiameter / 2) * scale,
        tableWidth * scale,
        tableHeight * scale,
      );
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }

  function updateTableSize() {
    persistLayoutSettings();
    refreshGradient();
    generateTable();
    hasUserMovedView = false;
    fitTableToView(true);
    draw();
  }

  function rotateCanvas() {
    rotation = (rotation + 90) % 360;
    persistLayoutSettings();
    fitTableToView(true);
    draw();
  }

  function updateHoveredCap(event: MouseEvent) {
    if (!canvas || dragging) {
      hoveredCap = null;
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const pointer = getDrawPointFromPointer(event.clientX, event.clientY);
    const worldX = (pointer.x - offsetX) / Math.max(scale, 0.0001);
    const worldY = (pointer.y - offsetY) / Math.max(scale, 0.0001);
    let nextCap: Cap | null = null;
    let nextDistance = Number.POSITIVE_INFINITY;

    for (const cap of caps.values()) {
      const radius = (cap.diameter ?? capsDiameter) / 2;
      const hitRadius = Math.max(radius, 8 / Math.max(scale, 0.0001));
      const distance = Math.hypot(worldX - cap.x, worldY - cap.y);
      if (distance <= hitRadius && distance < nextDistance) {
        nextCap = cap;
        nextDistance = distance;
      }
    }

    hoveredCap = nextCap;
    hoverPosition = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  function clearHoveredCap() {
    hoveredCap = null;
  }

  function getDrawPointFromPointer(clientX: number, clientY: number) {
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left) * (canvas.width / rect.width);
    const y = (clientY - rect.top) * (canvas.height / rect.height);
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const rad = (-rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dx = x - centerX;
    const dy = y - centerY;

    return {
      x: centerX + dx * cos - dy * sin,
      y: centerY + dx * sin + dy * cos,
    };
  }

  function generateHexCells(height: number, width: number, diameter: number) {
    const dx = diameter;
    const dy = (diameter * Math.sqrt(3)) / 2;
    const cols = Math.max(1, Math.floor(width / dx));
    const rows = Math.floor(height / dy);
    const capRadius = diameter / 2;
    const cells: HexCell[] = [];

    for (let row = 0; row < rows; row += 1) {
      const y = row * dy;
      if (y + diameter > height) continue;

      for (let col = 0; col < cols; col += 1) {
        let x = col * dx;
        if (row % 2 === 1) {
          x += dx / 2;
          if (x + capRadius > width) continue;
        }

        if (x + dx > width) continue;
        cells.push({ row, col, x, y });
      }
    }

    return cells;
  }

  function clamp(value: number, lower = 0, upper = 255) {
    return Math.max(lower, Math.min(upper, value));
  }

  function hexToRgb(color: string): [number, number, number] {
    const hex = color.replace('#', '');
    return [
      parseInt(hex.slice(0, 2), 16),
      parseInt(hex.slice(2, 4), 16),
      parseInt(hex.slice(4, 6), 16),
    ];
  }

  function rgbToHex(rgb: [number, number, number]) {
    return `#${rgb.map((value) => clamp(Math.round(value)).toString(16).padStart(2, '0')).join('')}`;
  }

  function getLuminance(rgb: [number, number, number]) {
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  }

  function interpolateGradientColor(t: number): [number, number, number] {
    const normalizedT = Math.max(0, Math.min(1, t));
    const scaled = normalizedT * (gradientStops.length - 1);
    const leftIndex = Math.min(gradientStops.length - 2, Math.floor(scaled));
    const localT = scaled - leftIndex;
    const left = hexToRgb(gradientStops[leftIndex]);
    const right = hexToRgb(gradientStops[leftIndex + 1]);

    return [
      left[0] * (1 - localT) + right[0] * localT,
      left[1] * (1 - localT) + right[1] * localT,
      left[2] * (1 - localT) + right[2] * localT,
    ];
  }

  function hexNoise(row: number, col: number) {
    let value = (row * 374761393 + col * 668265263) >>> 0;
    value = Math.imul(value ^ (value >>> 13), 1274126177) >>> 0;
    value = (value ^ (value >>> 16)) >>> 0;
    return value / 0xffffffff;
  }

  function targetGradientColor(x: number, y: number, tOffset = 0): [number, number, number] {
    const centerX = x + capsDiameter / 2;
    const centerY = y + capsDiameter / 2;
    let t: number;

    if (gradientMode === 'radial') {
      const dx = (centerX - tableWidth / 2) / Math.max(tableWidth / 2, 1);
      const dy = (centerY - tableHeight / 2) / Math.max(tableHeight / 2, 1);
      t = Math.sqrt(dx * dx + dy * dy);
    } else {
      const angle = (gradientAngle * Math.PI) / 180;
      const ux = Math.cos(angle);
      const uy = Math.sin(angle);
      const corners = [
        [0, 0],
        [tableWidth, 0],
        [0, tableHeight],
        [tableWidth, tableHeight],
      ];
      const projections = corners.map(([cornerX, cornerY]) => cornerX * ux + cornerY * uy);
      const minProjection = Math.min(...projections);
      const maxProjection = Math.max(...projections);
      const currentProjection = centerX * ux + centerY * uy;
      t = (currentProjection - minProjection) / Math.max(maxProjection - minProjection, 1);
    }

    return interpolateGradientColor(t + tOffset);
  }

  function shuffle<T>(items: T[]) {
    const shuffled = [...items];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  function buildColorGroups(capsData: SourceCap[]) {
    const groupsByColor = new Map<string, SourceCap[]>();
    for (const cap of capsData) {
      const color = cap.color.toLowerCase();
      groupsByColor.set(color, [...(groupsByColor.get(color) ?? []), cap]);
    }

    return [...groupsByColor.entries()].map(([color, groupCaps]): ColorGroup => ({
      color,
      rgb: hexToRgb(color),
      caps: groupCaps,
    }));
  }

  function getHexNeighbors(row: number, col: number) {
    const diagonalNeighbors =
      row % 2 === 0
        ? [
            [row - 1, col - 1],
            [row - 1, col],
            [row + 1, col - 1],
            [row + 1, col],
          ]
        : [
            [row - 1, col],
            [row - 1, col + 1],
            [row + 1, col],
            [row + 1, col + 1],
          ];

    return [
      [row, col - 1],
      [row, col + 1],
      ...diagonalNeighbors,
    ];
  }

  function getLowerHexNeighbors(row: number, col: number) {
    return row % 2 === 0
      ? [
          [row + 1, col - 1],
          [row + 1, col],
        ]
      : [
          [row + 1, col],
          [row + 1, col + 1],
        ];
  }

  function takeClosestCap(groups: ColorGroup[], desiredRgb: [number, number, number], neighborColors: string[]) {
    let bestGroup: ColorGroup | null = null;
    let bestCost = Number.POSITIVE_INFINITY;
    const desiredLuminance = getLuminance(desiredRgb);

    for (const group of groups) {
      if (!group.caps.length) continue;

      const distance = Math.sqrt(
        (desiredRgb[0] - group.rgb[0]) ** 2 +
          (desiredRgb[1] - group.rgb[1]) ** 2 +
          (desiredRgb[2] - group.rgb[2]) ** 2,
      );
      const groupLuminance = getLuminance(group.rgb);
      const luminanceDelta = Math.abs(desiredLuminance - groupLuminance);
      const tooDarkForTarget = Math.max(0, desiredLuminance - groupLuminance - 36);
      const luminanceCost = luminanceGuard * (luminanceDelta + tooDarkForTarget * 2.4);
      const sameNeighbors = neighborColors.filter((color) => color === group.color).length;
      const cost = distance + luminanceCost + clusterPenalty * sameNeighbors + (Math.random() * 2 - 1) * randomness;

      if (cost < bestCost) {
        bestCost = cost;
        bestGroup = group;
      }
    }

    if (!bestGroup) return null;
    return {
      cap: bestGroup.caps.pop()!,
      rgb: bestGroup.rgb,
    };
  }

  function addError(
    errors: Map<string, [number, number, number]>,
    key: string,
    colorError: [number, number, number],
    weight: number,
  ) {
    const current = errors.get(key) ?? [0, 0, 0];
    errors.set(key, [
      current[0] + colorError[0] * weight * ditherStrength,
      current[1] + colorError[1] * weight * ditherStrength,
      current[2] + colorError[2] * weight * ditherStrength,
    ]);
  }

  function distributeHexError(
    errors: Map<string, [number, number, number]>,
    row: number,
    col: number,
    cellsByKey: Map<string, HexCell>,
    colorError: [number, number, number],
  ) {
    const neighbors: Array<[string, number]> = [];
    const sameRowNeighbor = row % 2 ? `${row},${col - 1}` : `${row},${col + 1}`;
    if (cellsByKey.has(sameRowNeighbor)) neighbors.push([sameRowNeighbor, 1 / 3]);

    for (const [neighborRow, neighborCol] of getLowerHexNeighbors(row, col)) {
      const key = `${neighborRow},${neighborCol}`;
      if (cellsByKey.has(key)) neighbors.push([key, 1 / 3]);
    }

    if (!neighbors.length) return;

    const jitter = Math.min(0.85, randomness / 120);
    const rawWeights = neighbors.map(([, weight]) => Math.max(0.02, weight * (1 + (Math.random() * 2 - 1) * jitter)));
    const weightSum = rawWeights.reduce((sum, weight) => sum + weight, 0);

    neighbors.forEach(([key], index) => {
      addError(errors, key, colorError, rawWeights[index] / weightSum);
    });
  }

  function generateTable() {
    const sourceCaps = loadedCapsData ?? [];
    if (!sourceCaps.length) {
      caps.clear();
      tableMeta = null;
      return;
    }

    const cells = generateHexCells(Number(tableHeight), Number(tableWidth), Number(capsDiameter));
    const usableCells = cells.slice(0, sourceCaps.length);
    const cellsByKey = new Map(usableCells.map((cell) => [`${cell.row},${cell.col}`, cell]));
    const groups = buildColorGroups(shuffle(sourceCaps));
    const errors = new Map<string, [number, number, number]>();
    const placedColors = new Map<string, string>();
    const assignments: Cap[] = [];
    const rows = [...new Set(usableCells.map((cell) => cell.row))].sort((a, b) => a - b);

    for (const row of rows) {
      const rowCells = usableCells
        .filter((cell) => cell.row === row)
        .sort((a, b) => (row % 2 ? b.col - a.col : a.col - b.col));

      for (const cell of rowCells) {
        const key = `${cell.row},${cell.col}`;
        const error = errors.get(key) ?? [0, 0, 0];
        errors.delete(key);

        const noise = (hexNoise(cell.row, cell.col) + hexNoise(cell.row + 19, cell.col + 31)) / 2 - 0.5;
        const target = targetGradientColor(cell.x, cell.y, noise * transitionNoise);
        const desired: [number, number, number] = [
          clamp(target[0] + error[0]),
          clamp(target[1] + error[1]),
          clamp(target[2] + error[2]),
        ];
        const neighborColors = getHexNeighbors(cell.row, cell.col)
          .map(([neighborRow, neighborCol]) => placedColors.get(`${neighborRow},${neighborCol}`))
          .filter((color): color is string => Boolean(color));
        const picked = takeClosestCap(groups, desired, neighborColors);
        if (!picked) continue;

        placedColors.set(key, picked.cap.color.toLowerCase());
        distributeHexError(
          errors,
          cell.row,
          cell.col,
          cellsByKey,
          [desired[0] - picked.rgb[0], desired[1] - picked.rgb[1], desired[2] - picked.rgb[2]],
        );

        assignments.push({
          id: assignments.length,
          x: cell.x,
          y: cell.y,
          diameter: picked.cap.diameter ?? capsDiameter,
          color: picked.cap.color,
          image: picked.cap.image,
          label: picked.cap.label,
          target_color: rgbToHex(target),
          type_id: picked.cap.type_id ?? 0,
        });
      }
    }

    caps.clear();
    for (const cap of assignments) caps.set(cap.id, cap);
    tableMeta = {
      used_caps: assignments.length,
      total_caps: sourceCaps.length,
      capacity: cells.length,
      requested_table_height: Number(tableHeight),
      effective_table_height: Number(tableHeight),
      use_all_caps: false,
    };
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  function normalizeHexColor(color: unknown) {
    if (typeof color !== 'string') return null;

    const hex = color.replace('#', '').trim().toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex)) return null;

    return `#${hex}`;
  }

  function toPositiveInteger(value: unknown, fallback = 1) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;

    return Math.max(1, Math.floor(parsed));
  }

  function normalizeCapTypes(items: unknown[]): CapType[] {
    return items
      .map((item, index) => {
        if (!isRecord(item)) return null;

        const color = normalizeHexColor(item.color);
        if (!color) return null;

        const rawTypeId = item.type_id ?? item.id;
        const parsedTypeId = Number(rawTypeId);
        const type_id = Number.isFinite(parsedTypeId) ? parsedTypeId : index + 1;
        const diameter = item.diameter === undefined ? undefined : Number(item.diameter);
        const label = typeof item.label === 'string' ? item.label : undefined;
        const name = typeof item.name === 'string' ? item.name : undefined;

        return {
          type_id,
          color,
          count: toPositiveInteger(item.count),
          ...(Number.isFinite(diameter) ? { diameter } : {}),
          ...(label ? { label } : {}),
          ...(name ? { name } : {}),
        };
      })
      .filter((capType): capType is CapType => Boolean(capType));
  }

  function expandCapTypes(types: CapType[]) {
    return types.flatMap((capType) =>
      Array.from({ length: capType.count }, (): SourceCap => ({
        color: capType.color,
        diameter: capType.diameter,
        label: capType.label ?? capType.name,
        type_id: capType.type_id,
      })),
    );
  }

  function normalizeLegacyCaps(items: unknown[]): CapsInventory {
    const caps = items
      .filter((cap): cap is SourceCap => {
        if (!isRecord(cap)) return false;
        return Boolean(normalizeHexColor(cap.color));
      })
      .map((cap) => ({
        ...cap,
        color: normalizeHexColor(cap.color)!,
      }));
    const typesById = new Map<number | string, CapType>();

    for (const cap of caps) {
      const key = cap.type_id ?? `${cap.color}|${cap.label ?? ''}|${cap.diameter ?? ''}`;
      const existing = typesById.get(key);
      if (existing) {
        existing.count += 1;
        continue;
      }

      typesById.set(key, {
        type_id: cap.type_id ?? typesById.size + 1,
        color: cap.color,
        count: 1,
        diameter: cap.diameter,
        label: cap.label,
      });
    }

    return {
      caps,
      types: [...typesById.values()],
    };
  }

  function normalizeCapsData(data: unknown): CapsInventory {
    if (Array.isArray(data)) return normalizeLegacyCaps(data);

    if (isRecord(data)) {
      const rawTypes = Array.isArray(data.cap_types) ? data.cap_types : Array.isArray(data.groups) ? data.groups : null;
      if (rawTypes) {
        const types = normalizeCapTypes(rawTypes);
        return {
          caps: expandCapTypes(types),
          types,
        };
      }

      if (Array.isArray(data.caps)) return normalizeLegacyCaps(data.caps);
    }

    return { caps: [], types: [] };
  }

  function collectDatasetTypeIds(data: unknown) {
    const typeIds = new Set<number>();

    function visit(value: unknown) {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }

      if (!isRecord(value)) return;

      const rawTypeId = value.type_id;
      const parsedTypeId = Number(rawTypeId);
      if (Number.isFinite(parsedTypeId) && 'type_id' in value) {
        typeIds.add(parsedTypeId);
      }

      Object.values(value).forEach(visit);
    }

    visit(data);
    return typeIds;
  }

  function summarizeDataset(data: unknown, knownTypeIds: Set<number>): DatasetMeta {
    const imageSources = new Set<string>();
    let sample_count = 0;
    let annotation_count = 0;

    function visit(value: unknown) {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }

      if (!isRecord(value)) return;

      const src = value.src ?? value.image ?? value.path;
      if (typeof src === 'string') imageSources.add(src);
      if (Array.isArray(value.images)) {
        value.images.forEach((image) => {
          if (typeof image === 'string') imageSources.add(image);
        });
      }
      if ('type_id' in value && (src || 'images' in value)) sample_count += 1;
      if ('type_id' in value && ('bbox' in value || 'polygon' in value || 'center' in value)) annotation_count += 1;

      Object.values(value).forEach(visit);
    }

    visit(data);

    const unknown_type_ids = [...collectDatasetTypeIds(data)]
      .filter((typeId) => !knownTypeIds.has(typeId))
      .sort((a, b) => a - b);

    return {
      image_count: imageSources.size,
      sample_count,
      annotation_count,
      unknown_type_ids,
    };
  }

  async function handleCapsFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const normalized = normalizeCapsData(parsed);

      if (!normalized.caps.length) {
        throw new Error(tl(locale, 'invalidCapsFile'));
      }

      loadedCapsData = normalized.caps;
      loadedCapTypes = normalized.types;
      capsFileName = file.name;
      capsFileError = '';
      datasetMeta = null;
      datasetFileName = tl(locale, 'datasetNotLoaded');
      datasetFileError = '';
      updateTableSize();
    } catch (error) {
      capsFileError = error instanceof Error ? error.message : tl(locale, 'readCapsFailed');
      loadedCapsData = null;
      loadedCapTypes = [];
      capsFileName = tl(locale, 'noInventory');
      updateTableSize();
    } finally {
      input.value = '';
    }
  }

  async function handleDatasetFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const knownTypeIds = new Set(loadedCapTypes.map((capType) => capType.type_id));
      const meta = summarizeDataset(parsed, knownTypeIds);

      datasetMeta = meta;
      datasetFileName = file.name;
      datasetFileError = meta.unknown_type_ids.length
        ? tl(locale, 'unknownTypeIds', { ids: meta.unknown_type_ids.join(', ') })
        : '';
    } catch (error) {
      datasetMeta = null;
      datasetFileName = tl(locale, 'datasetNotLoaded');
      datasetFileError = error instanceof Error ? error.message : tl(locale, 'readDatasetFailed');
    } finally {
      input.value = '';
    }
  }

  function loadDraftInventory() {
    const draft = readDatasetDraft();
    if (draft.samples.length) {
      const normalized = normalizeCapsData(datasetDraftToCapsInventory(draft.samples, capsDiameter));

      loadedCapsData = normalized.caps;
      loadedCapTypes = normalized.types;
      capsFileName = tl(locale, 'draftDataset');
      capsFileError = '';
      datasetMeta = {
        image_count: new Set(draft.samples.map((sample) => sample.cropDataUrl)).size,
        sample_count: draft.samples.length,
        annotation_count: 0,
        unknown_type_ids: [],
      };
      datasetFileName = tl(locale, 'draftDataset');
      datasetFileError = '';
      updateTableSize();
      return;
    }

    loadedCapsData = null;
    loadedCapTypes = [];
    caps.clear();
    tableMeta = null;
    capsFileName = tl(locale, 'noInventory');
    capsFileError = '';
    datasetMeta = null;
    datasetFileName = tl(locale, 'datasetNotLoaded');
    datasetFileError = '';
    draw();
  }

  function getCanvasGradient(gctx: CanvasRenderingContext2D) {
    if (gradientMode === 'radial') {
      return gctx.createRadialGradient(
        tableWidth / 2,
        tableHeight / 2,
        0,
        tableWidth / 2,
        tableHeight / 2,
        Math.max(tableWidth, tableHeight) / 2,
      );
    }

    const angle = (gradientAngle * Math.PI) / 180;
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const cx = tableWidth / 2;
    const cy = tableHeight / 2;
    const length = Math.abs(tableWidth * ux) + Math.abs(tableHeight * uy);

    return gctx.createLinearGradient(
      cx - (ux * length) / 2,
      cy - (uy * length) / 2,
      cx + (ux * length) / 2,
      cy + (uy * length) / 2,
    );
  }

  function refreshGradient() {
    const offscreen = document.createElement('canvas');
    offscreen.width = tableWidth;
    offscreen.height = tableHeight;
    const gctx = offscreen.getContext('2d');
    if (!gctx) return;

    const gradient = getCanvasGradient(gctx);
    gradientStops.forEach((color, index) => {
      gradient.addColorStop(index / (gradientStops.length - 1), color);
    });

    gctx.fillStyle = gradient;
    gctx.fillRect(0, 0, tableWidth, tableHeight);

    const img = new Image();
    img.onload = () => {
      gradientImage = img;
      draw();
    };
    img.src = offscreen.toDataURL();
  }

  function applyGradientChanges() {
    refreshGradient();
    updateTableSize();
  }

  function setGradientStop(index: number, color: string) {
    gradientStops = gradientStops.map((stop, i) => (i === index ? color : stop));
    applyGradientChanges();
  }

  function addGradientStop() {
    gradientStops = [...gradientStops, gradientStops[gradientStops.length - 1] ?? '#ffffff'];
    applyGradientChanges();
  }

  function removeGradientStop(index: number) {
    if (gradientStops.length <= 2) return;
    gradientStops = gradientStops.filter((_, i) => i !== index);
    applyGradientChanges();
  }

  function applyGradientPreset(preset: (typeof gradientPresets)[number]) {
    gradientMode = preset.mode;
    gradientAngle = preset.angle;
    gradientStops = [...preset.stops];
    applyGradientChanges();
  }

  onMount(() => {
    locale = detectBrowserLocale();
    document.documentElement.lang = locale;
    capsFileName = tl(locale, 'noInventory');
    datasetFileName = tl(locale, 'datasetNotLoaded');
    restoreLayoutSettings();
    ctx = canvas.getContext('2d');
    resizeCanvas();
    refreshGradient();
    loadDraftInventory();

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      hasUserMovedView = true;
      const pointer = getDrawPointFromPointer(e.clientX, e.clientY);
      const previousScale = scale;
      const nextScale = scale * (e.deltaY < 0 ? 1.1 : 0.9);
      const worldX = (pointer.x - offsetX) / previousScale;
      const worldY = (pointer.y - offsetY) / previousScale;

      scale = nextScale;
      offsetX = pointer.x - worldX * nextScale;
      offsetY = pointer.y - worldY * nextScale;
      draw();
    };

    const onMouseDown = (e: MouseEvent) => {
      dragging = true;
      hoveredCap = null;
      dragStart = { x: e.clientX, y: e.clientY };
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!dragging) return;

      const rad = (rotation * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);

      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;

      offsetX += dx * cos + dy * sin;
      offsetY += -dx * sin + dy * cos;
      hasUserMovedView = true;

      dragStart = { x: e.clientX, y: e.clientY };
      draw();
    };

    const onMouseUp = () => {
      dragging = false;
    };

    const onCanvasPointerMove = (e: MouseEvent) => {
      if (dragging) {
        hoveredCap = null;
        return;
      }

      updateHoveredCap(e);
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mousemove', onCanvasPointerMove);
    canvas.addEventListener('mouseleave', clearHoveredCap);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('resize', resizeCanvas);

    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mousemove', onCanvasPointerMove);
      canvas.removeEventListener('mouseleave', clearHoveredCap);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('resize', resizeCanvas);
    };
  });
</script>

<main class="app">
  <header class="topbar">
    <div class="brand">
      <img class="brand-icon" src={`${base}/favicon.png`} alt="" />
      <div class="brand-text">
        <strong>Caps Table</strong>
        <span>{t(locale, 'layoutSubtitle')}</span>
      </div>
    </div>

    <div class="topbar-actions">
      <nav class="mode-switch" aria-label={t(locale, 'modeNavLabel')}>
        <a href={`${base}/dataset`}>{t(locale, 'navDataset')}</a>
        <a class="active" href={`${base}/layout`}>{t(locale, 'navLayout')}</a>
      </nav>
    </div>
  </header>

  <div class="workspace">
    <aside class="sidebar" aria-label={tl(locale, 'layoutParams')}>
      {#if tableMeta}
        <section class="summary" data-testid="caps-status">
          <div>
            <span>{tl(locale, 'used')}</span>
            <strong>{tableMeta.used_caps} / {tableMeta.total_caps}</strong>
          </div>
          <div>
            <span>{tableMeta.use_all_caps ? tl(locale, 'length') : tl(locale, 'fieldCapacity')}</span>
            <strong>
              {#if tableMeta.use_all_caps && tableMeta.effective_table_height > tableMeta.requested_table_height}
                {Math.ceil(tableMeta.effective_table_height)} {tl(locale, 'mm')}
              {:else}
                {tableMeta.capacity}
              {/if}
            </strong>
          </div>
        </section>
      {/if}

      <section class="panel-section">
        <h2>{tl(locale, 'sizes')}</h2>
        <div class="size-row">
          <label for="tableWidth">
            <span>{tl(locale, 'width')}</span>
            <input data-testid="table-width" type="number" id="tableWidth" bind:value={tableWidth} min="1" max="5000" step="1" oninput={updateTableSize} />
          </label>

          <label for="tableHeight">
            <span>{tl(locale, 'height')}</span>
            <input data-testid="table-height" type="number" id="tableHeight" bind:value={tableHeight} min="1" max="5000" step="1" oninput={updateTableSize} />
          </label>

          <label for="capDiameter">
            <span>{tl(locale, 'diameter')}</span>
            <input data-testid="cap-diameter" type="number" id="capDiameter" bind:value={capsDiameter} min="1" max="5000" step="1" oninput={updateTableSize} />
          </label>
        </div>
        <div class="button-row">
          <button data-testid="rotate" onclick={rotateCanvas}>{tl(locale, 'rotate')}</button>
          <button disabled={!caps.size} onclick={exportHighResolutionPng}>{tl(locale, 'downloadPng')}</button>
        </div>
      </section>

      <section class="panel-section">
        <h2>{tl(locale, 'mode')}</h2>
        <div class="segmented">
          <button class:active={capRenderMode === 'color'} onclick={() => setCapRenderMode('color')}>{tl(locale, 'colors')}</button>
          <button class:active={capRenderMode === 'photo'} onclick={() => setCapRenderMode('photo')}>{tl(locale, 'photos')}</button>
        </div>
        <label class="slider-row" for="gradientOpacitySlider">
          <span>{tl(locale, 'opacity')} <b>{Math.round(gradientOpacity * 100)}%</b></span>
          <input type="range" id="gradientOpacitySlider" min="0" max="1" step="0.01" bind:value={gradientOpacity} oninput={updateGradientOpacity} />
        </label>

        <details class="gradient-menu">
          <summary>{tl(locale, 'gradient')}</summary>
          <div class="gradient-panel">
            <div class="segmented">
              <button class:active={gradientMode === 'linear'} onclick={() => { gradientMode = 'linear'; applyGradientChanges(); }}>{tl(locale, 'linear')}</button>
              <button class:active={gradientMode === 'radial'} onclick={() => { gradientMode = 'radial'; applyGradientChanges(); }}>{tl(locale, 'radial')}</button>
            </div>

            {#if gradientMode === 'linear'}
              <label class="slider-row" for="gradientAngle">
                <span>{tl(locale, 'direction')} <b>{gradientAngle}°</b></span>
                <input type="range" id="gradientAngle" min="0" max="360" step="1" bind:value={gradientAngle} oninput={applyGradientChanges} />
              </label>
            {/if}

            <div class="preset-grid">
              {#each gradientPresets as preset}
                <button onclick={() => applyGradientPreset(preset)}>{preset.name === 'RGB' ? 'RGB' : tl(locale, preset.name)}</button>
              {/each}
            </div>

            <div class="color-grid">
              {#each gradientStops as color, index}
                <label>
                  <span>{tl(locale, 'colorNumber', { index: index + 1 })}</span>
                  <span class="color-actions">
                    <input type="color" value={color} oninput={(event) => setGradientStop(index, event.currentTarget.value)} />
                    <button class="icon-button" disabled={gradientStops.length <= 2} onclick={() => removeGradientStop(index)}>−</button>
                  </span>
                </label>
              {/each}
            </div>

            <button class="wide-button" onclick={addGradientStop}>{tl(locale, 'addColor')}</button>
          </div>
        </details>
      </section>

      <section class="panel-section">
        <h2>{tl(locale, 'dithering')}</h2>
        <label class="slider-row" for="ditherStrength">
          <span>{tl(locale, 'strength')} <b>{ditherStrength.toFixed(2)}</b></span>
          <input data-testid="dither-strength" type="range" id="ditherStrength" min="0" max="1.5" step="0.05" bind:value={ditherStrength} oninput={updateTableSize} />
        </label>

        <label class="slider-row" for="transitionNoise">
          <span>{tl(locale, 'softness')} <b>{transitionNoise.toFixed(3)}</b></span>
          <input data-testid="transition-noise" type="range" id="transitionNoise" min="0" max="0.15" step="0.005" bind:value={transitionNoise} oninput={updateTableSize} />
        </label>

        <label class="slider-row" for="luminanceGuard">
          <span>{tl(locale, 'lightGuard')} <b>{luminanceGuard.toFixed(1)}</b></span>
          <input data-testid="luminance-guard" type="range" id="luminanceGuard" min="0" max="4" step="0.1" bind:value={luminanceGuard} oninput={updateTableSize} />
        </label>

        <label class="slider-row" for="clusterPenalty">
          <span>{tl(locale, 'antiSpots')} <b>{clusterPenalty}</b></span>
          <input data-testid="cluster-penalty" type="range" id="clusterPenalty" min="0" max="300" step="10" bind:value={clusterPenalty} oninput={updateTableSize} />
        </label>

        <label class="slider-row" for="randomness">
          <span>{tl(locale, 'randomness')} <b>{randomness}</b></span>
          <input data-testid="randomness" type="range" id="randomness" min="0" max="120" step="5" bind:value={randomness} oninput={updateTableSize} />
        </label>
      </section>
    </aside>

    <section class="canvas-pane" aria-label={tl(locale, 'workArea')}>
      <canvas data-testid="caps-canvas" bind:this={canvas}></canvas>
      {#if !loadedCapsData?.length}
        <div class="layout-empty-state">
          <h1>{tl(locale, 'emptyLayoutTitle')}</h1>
          <p>{tl(locale, 'emptyLayoutBody')}</p>
          <a href={`${base}/dataset`}>{tl(locale, 'emptyLayoutAction')}</a>
        </div>
      {/if}
      {#if hoveredCap}
        <aside
          class="cap-tooltip"
          style={`--tooltip-x: ${hoverPosition.x}px; --tooltip-y: ${hoverPosition.y}px; --tooltip-color: ${hoveredCap.color}; --tooltip-target: ${hoveredCap.target_color ?? hoveredCap.color};`}
          aria-live="polite"
        >
          {#if hoveredCap.image}
            <img src={hoveredCap.image} alt="" />
          {:else}
            <span class="tooltip-photo-fallback"></span>
          {/if}
          <div>
            <strong>#{hoveredCap.type_id} {hoveredCap.label ?? tl(locale, 'unnamed')}</strong>
            <span class="tooltip-row"><i></i><b>{tl(locale, 'cap')}</b>{hoveredCap.color}</span>
            {#if hoveredCap.target_color}
              <span class="tooltip-row target"><i></i><b>{tl(locale, 'target')}</b>{hoveredCap.target_color}</span>
            {/if}
          </div>
        </aside>
      {/if}
    </section>
  </div>
</main>

<style>
  :global(body) {
    margin: 0;
    overflow: hidden;
  }

  :global(*) {
    box-sizing: border-box;
  }

  .app {
    --accent: #38bdf8;
    --bg: #252b34;
    --canvas: #303844;
    --control: #343d4a;
    --control-hover: #3d4857;
    --line: rgba(203, 213, 225, 0.2);
    --muted: #c0cad8;
    --panel: #2b333f;
    --panel-2: #343d4a;
    --text: #edf2f7;
    --text-strong: #ffffff;

    background: var(--bg);
    color: var(--text);
    display: grid;
    grid-template-rows: 56px minmax(0, 1fr);
    height: 100vh;
    min-height: 100vh;
  }

  .topbar {
    align-items: center;
    background: var(--panel);
    border-bottom: 1px solid var(--line);
    display: flex;
    justify-content: space-between;
    padding: 0 18px;
    z-index: 2;
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

  .brand strong {
    color: var(--text-strong);
    font-size: 17px;
    white-space: nowrap;
  }

  .brand span {
    color: var(--muted);
    font-size: 13px;
    white-space: nowrap;
  }

  .topbar-actions {
    align-items: center;
    display: flex;
    gap: 10px;
    min-width: 0;
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
    color: var(--text-strong);
    display: inline-flex;
    justify-content: center;
    text-decoration: none;
    border-color: transparent;
    border-radius: 6px;
    font-size: 13px;
    min-height: 28px;
    padding: 4px 10px;
  }

  .mode-switch a.active {
    background: var(--accent);
    color: #06121f;
  }

  .workspace {
    display: grid;
    grid-template-columns: 336px minmax(0, 1fr);
    min-height: 0;
  }

  .sidebar {
    background: var(--panel);
    border-right: 1px solid var(--line);
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-height: 0;
    overflow: auto;
    padding: 14px;
  }

  .summary {
    display: grid;
    gap: 8px;
    grid-template-columns: 1fr 1fr;
  }

  .summary div {
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 8px;
    display: grid;
    gap: 5px;
    min-height: 70px;
    padding: 10px;
  }

  .summary span {
    color: var(--muted);
    font-size: 12px;
  }

  .summary strong {
    color: var(--text-strong);
    font-size: 18px;
  }

  .panel-section {
    border-top: 1px solid var(--line);
    display: grid;
    gap: 12px;
    padding-top: 14px;
  }

  .panel-section h2 {
    color: var(--text-strong);
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0;
    margin: 0;
  }

  .size-row {
    display: grid;
    gap: 8px;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .size-row label,
  .slider-row {
    color: var(--text);
    display: grid;
    font-size: 13px;
    gap: 7px;
  }

  .size-row span,
  .slider-row span {
    align-items: center;
    display: flex;
    justify-content: space-between;
  }

  .size-row span {
    color: var(--muted);
    font-size: 12px;
  }

  .button-row {
    display: grid;
    gap: 8px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .button-row button {
    min-width: 0;
  }

  .slider-row b {
    color: var(--text);
    font-weight: 600;
  }

  input[type='number'] {
    width: 100%;
  }

  input[type='number'],
  button {
    background: var(--control);
    border: 1px solid var(--line);
    border-radius: 6px;
    color: var(--text-strong);
    min-height: 36px;
    padding: 6px 10px;
  }

  button {
    cursor: pointer;
    font-weight: 600;
  }

  button:hover {
    background: var(--control-hover);
    border-color: var(--accent);
  }

  .wide-button {
    width: 100%;
  }

  .gradient-menu {
    display: grid;
    gap: 10px;
  }

  .gradient-menu summary {
    background: var(--control);
    border: 1px solid var(--line);
    border-radius: 6px;
    color: var(--text-strong);
    cursor: pointer;
    font-weight: 600;
    list-style: none;
    min-height: 36px;
    padding: 7px 10px;
    text-align: center;
  }

  .gradient-menu summary::-webkit-details-marker {
    display: none;
  }

  .gradient-menu[open] summary {
    border-color: var(--accent);
  }

  .gradient-panel {
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 8px;
    display: grid;
    gap: 10px;
    padding: 10px;
  }

  .segmented,
  .preset-grid {
    display: grid;
    gap: 6px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .segmented button,
  .preset-grid button {
    font-size: 13px;
    min-height: 32px;
    padding: 5px 8px;
  }

  .segmented button.active {
    background: var(--accent);
    border-color: var(--accent);
    color: #06121f;
  }

  .color-grid {
    display: grid;
    gap: 8px;
  }

  .color-grid label {
    align-items: center;
    color: var(--muted);
    display: grid;
    font-size: 13px;
    gap: 8px;
    grid-template-columns: 1fr 88px;
  }

  .color-actions {
    align-items: center;
    display: inline-flex;
    gap: 6px;
    justify-content: end;
  }

  .icon-button {
    border-radius: 6px;
    font-size: 18px;
    line-height: 1;
    min-height: 34px;
    padding: 0;
    width: 34px;
  }

  .icon-button:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }

  input[type='color'] {
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 6px;
    height: 34px;
    padding: 2px;
    width: 46px;
  }

  input[type='range'] {
    accent-color: var(--accent);
    width: 100%;
  }

  button,
  input,
  label {
    font: inherit;
  }

  .canvas-pane {
    background:
      linear-gradient(90deg, color-mix(in srgb, var(--canvas), transparent 18%) 1px, transparent 1px),
      linear-gradient(0deg, color-mix(in srgb, var(--canvas), transparent 18%) 1px, transparent 1px),
      var(--canvas);
    background-size: 32px 32px;
    min-height: 0;
    overflow: hidden;
    position: relative;
  }

  .layout-empty-state {
    align-items: center;
    background: rgba(37, 43, 52, 0.82);
    color: var(--text);
    display: flex;
    flex-direction: column;
    gap: 12px;
    inset: 0;
    justify-content: center;
    padding: 32px;
    position: absolute;
    text-align: center;
    z-index: 1;
  }

  .layout-empty-state h1 {
    color: var(--text-strong);
    font-size: 26px;
    line-height: 1.15;
    margin: 0;
  }

  .layout-empty-state p {
    color: var(--muted);
    font-size: 15px;
    line-height: 1.5;
    margin: 0;
    max-width: 520px;
  }

  .layout-empty-state a {
    background: var(--accent);
    border-radius: 8px;
    color: #062032;
    font-size: 14px;
    font-weight: 800;
    line-height: 1;
    padding: 12px 16px;
    text-decoration: none;
  }

  canvas {
    background: transparent;
    display: block;
    outline: none;
  }

  .cap-tooltip {
    align-items: center;
    background: rgba(15, 23, 42, 0.94);
    border: 1px solid rgba(203, 213, 225, 0.2);
    border-radius: 8px;
    box-shadow: 0 14px 36px rgba(8, 13, 22, 0.38);
    color: #edf2f7;
    display: grid;
    gap: 12px;
    grid-template-columns: 68px minmax(0, 1fr);
    left: min(calc(var(--tooltip-x) + 16px), calc(100% - 292px));
    max-width: 278px;
    min-width: 244px;
    padding: 10px;
    pointer-events: none;
    position: absolute;
    top: max(8px, calc(var(--tooltip-y) - 20px));
    z-index: 4;
  }

  .cap-tooltip img,
  .tooltip-photo-fallback {
    aspect-ratio: 1;
    background: var(--tooltip-color);
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 50%;
    display: block;
    object-fit: cover;
    width: 68px;
  }

  .cap-tooltip div {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  .cap-tooltip strong {
    color: #ffffff;
    font-size: 12px;
    line-height: 1.15;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cap-tooltip span {
    color: #cbd5e1;
    font-size: 12px;
    line-height: 1.25;
  }

  .tooltip-row {
    align-items: center;
    display: flex;
    gap: 5px;
  }

  .tooltip-row b {
    color: #94a3b8;
    font-size: 10px;
    font-weight: 700;
    min-width: 42px;
    text-transform: uppercase;
  }

  .tooltip-row i {
    background: var(--tooltip-color);
    border: 1px solid rgba(255, 255, 255, 0.24);
    border-radius: 50%;
    display: inline-block;
    height: 9px;
    width: 9px;
  }

  .tooltip-row.target i {
    background: var(--tooltip-target);
  }

  @media (max-width: 820px) {
    .app {
      grid-template-rows: 52px auto minmax(0, 1fr);
      overflow: auto;
    }

    .workspace {
      grid-template-columns: 1fr;
    }

    .sidebar {
      border-right: 0;
      border-bottom: 1px solid var(--line);
      max-height: 46vh;
    }

    .canvas-pane {
      min-height: 54vh;
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

