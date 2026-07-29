import base64
import json
import os
import sys

os.environ.setdefault("OMP_NUM_THREADS", "1")

import numpy as np
import onnxruntime as ort
from PIL import Image


def load_labels(labels_path: str):
    try:
        with open(labels_path, "r", encoding="utf-8") as file:
            parsed = json.load(file)
            if isinstance(parsed, list) and parsed:
                return parsed
    except Exception:
        return []
    return []


def preprocess_image(image_bytes: bytes):
    from io import BytesIO

    image = Image.open(BytesIO(image_bytes)).convert("RGB")
    image = image.resize((224, 224))
    return np.asarray(image, dtype=np.float32)


def preprocess_view(view: np.ndarray):
    return (view / 127.5) - 1.0


def create_session(model_path: str):
    providers = ort.get_available_providers()
    preferred_providers = []

    if "CUDAExecutionProvider" in providers:
        preferred_providers.append("CUDAExecutionProvider")
    preferred_providers.append("CPUExecutionProvider")

    return ort.InferenceSession(model_path, providers=preferred_providers)


def run_model(session, batch: np.ndarray):
    input_name = session.get_inputs()[0].name
    output_name = session.get_outputs()[0].name
    output = session.run([output_name], {input_name: batch.astype(np.float32)})[0]
    return output


def infer_scores(session, image_bytes: bytes):
    image_array = preprocess_image(image_bytes)
    single_input = np.expand_dims(preprocess_view(image_array), axis=0)
    single_scores = run_model(session, single_input)[0]

    if float(np.max(single_scores)) >= 0.72:
        return single_scores

    views = [
        image_array,
        np.fliplr(image_array),
        np.clip(image_array * 1.08, 0.0, 255.0),
    ]
    batch = np.stack([preprocess_view(view) for view in views], axis=0)
    stacked_scores = run_model(session, batch)
    return np.mean(stacked_scores, axis=0)


def main():
    model_path = os.environ.get("DISEASE_MODEL_PATH", "")
    labels_path = os.environ.get("DISEASE_LABELS_PATH", "")

    if not model_path:
        raise RuntimeError("DISEASE_MODEL_PATH environment variable is required")

    session = create_session(model_path)
    labels = load_labels(labels_path) if labels_path else []

    print(json.dumps({"type": "ready"}), flush=True)

    for raw_line in sys.stdin:
        line = (raw_line or "").strip()
        if not line:
            continue

        request_id = None
        try:
            payload = json.loads(line)
            request_id = payload.get("id")
            image_b64 = payload.get("image")
            if not image_b64:
                raise ValueError("Missing image field")

            image_bytes = base64.b64decode(image_b64)
            scores_vec = infer_scores(session, image_bytes)
            scores = scores_vec.astype(float).tolist()
            best_index = int(np.argmax(scores_vec))
            best_score = float(scores_vec[best_index])
            label = labels[best_index] if labels and best_index < len(labels) else f"class_{best_index}"

            print(
                json.dumps(
                    {
                        "id": request_id,
                        "label": label,
                        "confidence": best_score,
                        "scores": scores,
                    }
                ),
                flush=True,
            )
        except Exception as error:
            print(
                json.dumps(
                    {
                        "id": request_id,
                        "error": str(error),
                    }
                ),
                flush=True,
            )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.stderr.write(str(error))
        sys.exit(1)
