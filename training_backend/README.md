# Caps Table training backend

Dev-only backend for the `neuron-cup-detection` branch. It is not part of the final frontend-only product.

The browser UI can send confirmed/rejected cap candidates here while you annotate photos. The backend stores source images and annotations, exports YOLO labels, and can run Ultralytics training/export when the optional ML dependencies are installed.

## Setup

```bash
cd training_backend
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
.\.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8787 --reload
```

Optional training dependencies:

```bash
.\.venv\Scripts\pip install ultralytics
```

## Flow

1. Start this backend on `127.0.0.1:8787`.
2. Start the Svelte UI.
3. Annotate caps in `/dataset`.
4. Confirmed caps become positive `cap` boxes.
5. Skipped candidates become negative examples for later filtering/re-id work.
6. Export YOLO data:

```bash
curl -X POST http://127.0.0.1:8787/api/training/export-yolo
```

7. Train:

```bash
curl -X POST http://127.0.0.1:8787/api/training/train
```

8. Export ONNX:

```bash
curl -X POST http://127.0.0.1:8787/api/training/export-onnx
```

The exported model is written to `training_backend/data/models/cap-detector.onnx`.

