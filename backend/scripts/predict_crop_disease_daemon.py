import base64
import json
import os
import sys

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

import numpy as np
from PIL import Image
import tensorflow as tf

try:
    import tf_keras as legacy_keras
except Exception:
    legacy_keras = None


def load_labels(labels_path: str):
    try:
        with open(labels_path, "r", encoding="utf-8") as file:
            parsed = json.load(file)
            if isinstance(parsed, list) and parsed:
                return parsed
    except Exception:
        return []
    return []


def load_disease_model(model_path: str):
    errors = []

    if legacy_keras is not None:
        try:
            return legacy_keras.models.load_model(model_path, compile=False)
        except Exception as error:
            errors.append(f"tf_keras loader failed: {error}")

    try:
        return tf.keras.models.load_model(model_path, compile=False)
    except Exception as error:
        errors.append(f"tf.keras loader failed: {error}")

    raise RuntimeError(" | ".join(errors))


def build_views(image_bytes: bytes):
    from io import BytesIO

    image = Image.open(BytesIO(image_bytes)).convert("RGB")
    image = image.resize((224, 224))
    base = np.asarray(image, dtype=np.float32)

    views = [
        base,
        np.fliplr(base),
        np.clip(base * 1.08, 0.0, 255.0),
    ]
    return views


def preprocess_view(view: np.ndarray):
    return tf.keras.applications.mobilenet_v2.preprocess_input(view.astype(np.float32))


def infer_scores(model, image_bytes: bytes):
    views = build_views(image_bytes)

    single = np.expand_dims(preprocess_view(views[0]), axis=0)
    single_scores = model.predict(single, verbose=0)[0]

    if float(np.max(single_scores)) >= 0.72:
        return single_scores

    batch = np.stack([preprocess_view(view) for view in views], axis=0)
    stacked_scores = model.predict(batch, verbose=0)
    return np.mean(stacked_scores, axis=0)


def main():
    model_path = os.environ.get("DISEASE_MODEL_PATH", "")
    labels_path = os.environ.get("DISEASE_LABELS_PATH", "")

    if not model_path:
        raise RuntimeError("DISEASE_MODEL_PATH environment variable is required")

    model = load_disease_model(model_path)
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
            scores_vec = infer_scores(model, image_bytes)
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
