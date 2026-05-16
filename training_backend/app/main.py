from __future__ import annotations

import base64
import json
import shutil
import subprocess
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
IMAGES_DIR = DATA_DIR / "images"
CROPS_DIR = DATA_DIR / "crops"
GOOD_CROPS_DIR = CROPS_DIR / "good"
BAD_CROPS_DIR = CROPS_DIR / "bad"
MODELS_DIR = DATA_DIR / "models"
YOLO_DIR = DATA_DIR / "yolo"
ANNOTATIONS_PATH = DATA_DIR / "annotations.json"


class Box(BaseModel):
    x: float
    y: float
    width: float
    height: float


class SourceImage(BaseModel):
    name: str
    dataUrl: str
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    processedWidth: int = Field(gt=0)
    processedHeight: int = Field(gt=0)


class TrainingAnnotation(BaseModel):
    source: SourceImage
    box: Box
    cropDataUrl: str | None = None
    accepted: bool
    typeId: int | None = None
    averageColor: str | None = None
    neuralEmbedding: list[float] | None = None
    note: str | None = None


class DeleteAnnotationRequest(BaseModel):
    deleteCrop: bool = True


class TrainRequest(BaseModel):
    model: str = "yolo11n.pt"
    epochs: int = 80
    imgsz: int = 1280
    batch: int = 8


app = FastAPI(title="Caps Table Training Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:5174",
        "http://localhost:5174",
    ],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def ensure_dirs() -> None:
    for directory in [DATA_DIR, IMAGES_DIR, CROPS_DIR, GOOD_CROPS_DIR, BAD_CROPS_DIR, MODELS_DIR, YOLO_DIR]:
        directory.mkdir(parents=True, exist_ok=True)


def crop_directory_for_annotation(accepted: bool) -> Path:
    return GOOD_CROPS_DIR if accepted else BAD_CROPS_DIR


def migrate_crop_paths(data: dict[str, Any]) -> bool:
    changed = False
    for annotation in data.get("annotations", []):
        crop_path = annotation.get("cropPath")
        if not crop_path or crop_path.startswith("crops/good/") or crop_path.startswith("crops/bad/"):
            continue

        old_path = DATA_DIR / crop_path
        target_dir = crop_directory_for_annotation(bool(annotation.get("accepted")))
        target_path = target_dir / Path(crop_path).name
        target_relative = str(target_path.relative_to(DATA_DIR)).replace("\\", "/")

        if old_path.exists():
            if not target_path.exists():
                shutil.move(str(old_path), str(target_path))
        elif target_path.exists():
            pass

        annotation["cropPath"] = target_relative
        changed = True

    return changed


def read_annotations() -> dict[str, Any]:
    ensure_dirs()
    if not ANNOTATIONS_PATH.exists():
        return {"version": 1, "images": {}, "annotations": []}

    data = json.loads(ANNOTATIONS_PATH.read_text(encoding="utf-8"))
    if migrate_crop_paths(data):
        write_annotations(data)
    return data


def write_annotations(data: dict[str, Any]) -> None:
    ensure_dirs()
    ANNOTATIONS_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def split_data_url(data_url: str) -> tuple[str, bytes]:
    if "," not in data_url:
        raise HTTPException(status_code=400, detail="Invalid data URL")

    header, payload = data_url.split(",", 1)
    mime = header.split(";")[0].replace("data:", "")
    try:
        return mime, base64.b64decode(payload)
    except ValueError as error:
        raise HTTPException(status_code=400, detail="Invalid base64 payload") from error


def image_extension(mime: str) -> str:
    if mime == "image/png":
        return ".png"
    if mime in {"image/webp", "image/x-webp"}:
        return ".webp"
    return ".jpg"


def save_data_url(data_url: str, directory: Path, preferred_stem: str | None = None) -> tuple[str, str]:
    mime, content = split_data_url(data_url)
    digest = sha256(content).hexdigest()
    stem = preferred_stem or digest
    path = directory / f"{stem}{image_extension(mime)}"
    if not path.exists():
        path.write_bytes(content)
    return digest, str(path.relative_to(DATA_DIR)).replace("\\", "/")


def make_counts(data: dict[str, Any]) -> dict[str, int]:
    annotations = data["annotations"]
    accepted = [item for item in annotations if item.get("accepted")]
    return {
        "images": len(data["images"]),
        "annotations": len(annotations),
        "accepted": len(accepted),
        "negative": len(annotations) - len(accepted),
        "types": len({item.get("typeId") for item in accepted if item.get("typeId") is not None}),
    }


def to_original_box(annotation: TrainingAnnotation) -> dict[str, float]:
    scale_x = annotation.source.width / annotation.source.processedWidth
    scale_y = annotation.source.height / annotation.source.processedHeight
    x = annotation.box.x * scale_x
    y = annotation.box.y * scale_y
    width = annotation.box.width * scale_x
    height = annotation.box.height * scale_y

    return {
        "x": max(0, min(annotation.source.width, x)),
        "y": max(0, min(annotation.source.height, y)),
        "width": max(1, min(annotation.source.width, width)),
        "height": max(1, min(annotation.source.height, height)),
    }


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/training/annotations")
def add_annotation(annotation: TrainingAnnotation) -> dict[str, Any]:
    ensure_dirs()
    data = read_annotations()
    image_hash, image_path = save_data_url(annotation.source.dataUrl, IMAGES_DIR)
    crop_path = None

    if annotation.cropDataUrl:
        annotation_id_seed = f"{image_hash}:{annotation.box.x}:{annotation.box.y}:{annotation.box.width}:{annotation.box.height}"
        crop_stem = sha256(annotation_id_seed.encode("utf-8")).hexdigest()
        _, crop_path = save_data_url(
            annotation.cropDataUrl,
            crop_directory_for_annotation(annotation.accepted),
            crop_stem,
        )

    data["images"][image_hash] = {
        "id": image_hash,
        "path": image_path,
        "name": annotation.source.name,
        "width": annotation.source.width,
        "height": annotation.source.height,
        "processedWidth": annotation.source.processedWidth,
        "processedHeight": annotation.source.processedHeight,
    }

    stored_annotation = {
        "id": sha256(f"{image_hash}:{len(data['annotations'])}".encode("utf-8")).hexdigest(),
        "imageId": image_hash,
        "accepted": annotation.accepted,
        "typeId": annotation.typeId,
        "box": annotation.box.model_dump(),
        "originalBox": to_original_box(annotation),
        "cropPath": crop_path,
        "averageColor": annotation.averageColor,
        "neuralEmbedding": annotation.neuralEmbedding,
        "note": annotation.note,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    data["annotations"].append(stored_annotation)
    write_annotations(data)

    return {
        "ok": True,
        "imageId": image_hash,
        "annotationId": stored_annotation["id"],
        "acceptedCount": make_counts(data)["accepted"],
        "negativeCount": make_counts(data)["negative"],
    }


@app.get("/api/training/stats")
def stats() -> dict[str, Any]:
    data = read_annotations()
    return make_counts(data)


@app.get("/api/training/crops/{kind}/{filename}")
def get_crop(kind: str, filename: str) -> FileResponse:
    if kind not in {"good", "bad"}:
        raise HTTPException(status_code=404, detail="Unknown crop bucket")

    path = (CROPS_DIR / kind / filename).resolve()
    bucket = (CROPS_DIR / kind).resolve()
    if bucket not in path.parents or not path.exists():
        raise HTTPException(status_code=404, detail="Crop not found")

    return FileResponse(path)


@app.get("/api/training/annotations")
def list_annotations(
    accepted: bool | None = None,
    limit: int = Query(default=80, ge=1, le=500),
) -> dict[str, Any]:
    data = read_annotations()
    items = data["annotations"]
    if accepted is not None:
        items = [item for item in items if bool(item.get("accepted")) == accepted]

    selected = list(reversed(items))[:limit]
    return {
        "items": [
            {
                "id": item["id"],
                "accepted": bool(item.get("accepted")),
                "typeId": item.get("typeId"),
                "averageColor": item.get("averageColor"),
                "note": item.get("note"),
                "cropPath": item.get("cropPath"),
                "cropUrl": f"/api/training/{item['cropPath']}" if item.get("cropPath") else None,
                "createdAt": item.get("createdAt"),
                "sourceName": data["images"].get(item.get("imageId"), {}).get("name"),
            }
            for item in selected
        ],
        "counts": make_counts(data),
    }


@app.delete("/api/training/annotations/{annotation_id}")
def delete_annotation(annotation_id: str, request: DeleteAnnotationRequest | None = None) -> dict[str, Any]:
    data = read_annotations()
    annotations = data["annotations"]
    index = next((item_index for item_index, item in enumerate(annotations) if item.get("id") == annotation_id), -1)
    if index < 0:
        raise HTTPException(status_code=404, detail="Annotation not found")

    delete_crop = True if request is None else request.deleteCrop
    removed = annotations.pop(index)
    crop_path = removed.get("cropPath")
    if delete_crop and crop_path and not any(item.get("cropPath") == crop_path for item in annotations):
        path = (DATA_DIR / crop_path).resolve()
        if DATA_DIR.resolve() in path.parents and path.exists():
            path.unlink()

    write_annotations(data)
    return {
        "ok": True,
        "deleted": annotation_id,
        "counts": make_counts(data),
    }


@app.post("/api/training/export-yolo")
def export_yolo() -> dict[str, Any]:
    data = read_annotations()
    if not data["images"]:
        raise HTTPException(status_code=400, detail="No images collected")

    images_out = YOLO_DIR / "images" / "train"
    labels_out = YOLO_DIR / "labels" / "train"
    shutil.rmtree(YOLO_DIR, ignore_errors=True)
    images_out.mkdir(parents=True, exist_ok=True)
    labels_out.mkdir(parents=True, exist_ok=True)

    accepted_by_image: dict[str, list[dict[str, Any]]] = {}
    for annotation in data["annotations"]:
        if annotation.get("accepted"):
            accepted_by_image.setdefault(annotation["imageId"], []).append(annotation)

    exported_images = 0
    exported_boxes = 0

    for image_id, image in data["images"].items():
        source_path = DATA_DIR / image["path"]
        if not source_path.exists():
            continue

        annotations = accepted_by_image.get(image_id, [])
        if not annotations:
            continue

        image_name = f"{image_id}{source_path.suffix.lower()}"
        shutil.copy2(source_path, images_out / image_name)

        label_lines = []
        for annotation in annotations:
            box = annotation["originalBox"]
            center_x = (box["x"] + box["width"] / 2) / image["width"]
            center_y = (box["y"] + box["height"] / 2) / image["height"]
            width = box["width"] / image["width"]
            height = box["height"] / image["height"]
            label_lines.append(f"0 {center_x:.6f} {center_y:.6f} {width:.6f} {height:.6f}")
            exported_boxes += 1

        (labels_out / f"{image_id}.txt").write_text("\n".join(label_lines) + "\n", encoding="utf-8")
        exported_images += 1

    (YOLO_DIR / "data.yaml").write_text(
        f"path: {YOLO_DIR.as_posix()}\ntrain: images/train\nval: images/train\nnames:\n  0: cap\n",
        encoding="utf-8",
    )

    return {
        "ok": True,
        "path": str(YOLO_DIR),
        "images": exported_images,
        "boxes": exported_boxes,
    }


@app.post("/api/training/train")
def train(request: TrainRequest) -> dict[str, Any]:
    data_yaml = YOLO_DIR / "data.yaml"
    if not data_yaml.exists():
        export_yolo()

    command = [
        "yolo",
        "detect",
        "train",
        f"data={data_yaml}",
        f"model={request.model}",
        f"imgsz={request.imgsz}",
        f"epochs={request.epochs}",
        f"batch={request.batch}",
        f"project={DATA_DIR / 'runs'}",
        "name=cap-detector",
        "exist_ok=True",
    ]

    try:
        completed = subprocess.run(command, cwd=YOLO_DIR, capture_output=True, text=True, check=False)
    except FileNotFoundError as error:
        raise HTTPException(status_code=400, detail="Install ultralytics first: pip install ultralytics") from error

    if completed.returncode != 0:
        raise HTTPException(status_code=500, detail=completed.stderr[-4000:] or completed.stdout[-4000:])

    return {
        "ok": True,
        "stdout": completed.stdout[-4000:],
        "weights": str(DATA_DIR / "runs" / "cap-detector" / "weights" / "best.pt"),
    }


@app.post("/api/training/export-onnx")
def export_onnx() -> dict[str, Any]:
    weights = DATA_DIR / "runs" / "cap-detector" / "weights" / "best.pt"
    if not weights.exists():
        raise HTTPException(status_code=400, detail="Train model first")

    command = ["yolo", "export", f"model={weights}", "format=onnx", "opset=12", "simplify=True"]
    try:
        completed = subprocess.run(command, capture_output=True, text=True, check=False)
    except FileNotFoundError as error:
        raise HTTPException(status_code=400, detail="Install ultralytics first: pip install ultralytics") from error

    if completed.returncode != 0:
        raise HTTPException(status_code=500, detail=completed.stderr[-4000:] or completed.stdout[-4000:])

    exported = weights.with_suffix(".onnx")
    target = MODELS_DIR / "cap-detector.onnx"
    if not exported.exists():
        raise HTTPException(status_code=500, detail="ONNX export finished, but file was not found")

    shutil.copy2(exported, target)
    return {"ok": True, "model": str(target)}


@app.get("/api/training/model")
def download_model() -> FileResponse:
    target = MODELS_DIR / "cap-detector.onnx"
    if not target.exists():
        raise HTTPException(status_code=404, detail="Model is not exported yet")

    return FileResponse(target, filename="cap-detector.onnx")
