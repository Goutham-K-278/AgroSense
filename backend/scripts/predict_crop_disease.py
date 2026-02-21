import argparse
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


def preprocess_image(image_bytes: bytes):
    from io import BytesIO

    image = Image.open(BytesIO(image_bytes)).convert("RGB")
    image = image.resize((224, 224))
    base = np.asarray(image, dtype=np.float32)
    return base


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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--labels", required=False)
    parser.add_argument("--image", required=False)
    args = parser.parse_args()

    if args.image:
        with open(args.image, "rb") as image_file:
            image_bytes = image_file.read()
    else:
        image_bytes = sys.stdin.buffer.read()

    if not image_bytes:
        raise ValueError("No image bytes received on stdin")

    model = load_disease_model(args.model)
    labels = load_labels(args.labels) if args.labels else []

    image_array = preprocess_image(image_bytes)
    single_input = np.expand_dims(tf.keras.applications.mobilenet_v2.preprocess_input(image_array), axis=0)
    single_prediction = model.predict(single_input, verbose=0)[0]

    if float(np.max(single_prediction)) >= 0.72:
        mean_scores = single_prediction
    else:
        views = [
            image_array,
            np.fliplr(image_array),
            np.clip(image_array * 1.08, 0.0, 255.0),
        ]
        batch = np.stack(
            [tf.keras.applications.mobilenet_v2.preprocess_input(view.astype(np.float32)) for view in views],
            axis=0,
        )
        prediction = model.predict(batch, verbose=0)
        mean_scores = np.mean(prediction, axis=0)

    scores = mean_scores.astype(float).tolist()

    best_index = int(np.argmax(mean_scores))
    best_score = float(mean_scores[best_index])
    label = labels[best_index] if labels and best_index < len(labels) else f"class_{best_index}"

    output = {
        "label": label,
        "confidence": best_score,
        "scores": scores,
    }
    sys.stdout.write(json.dumps(output))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.stderr.write(str(error))
        sys.exit(1)