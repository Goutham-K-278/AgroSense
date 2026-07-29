import argparse
import json
import os
import sys

os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

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
    base = np.asarray(image, dtype=np.float32)
    return base


def preprocess_view(view: np.ndarray):
    # MobileNetV2 pre-processing: scale [0,255] to [-1,1].
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
    single_prediction = run_model(session, single_input)[0]

    if float(np.max(single_prediction)) >= 0.72:
        return single_prediction

    views = [
        image_array,
        np.fliplr(image_array),
        np.clip(image_array * 1.08, 0.0, 255.0),
    ]
    batch = np.stack([preprocess_view(view) for view in views], axis=0)
    prediction = run_model(session, batch)
    return np.mean(prediction, axis=0)


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

    session = create_session(args.model)
    labels = load_labels(args.labels) if args.labels else []

    scores_vec = infer_scores(session, image_bytes)
    scores = scores_vec.astype(float).tolist()

    best_index = int(np.argmax(scores_vec))
    best_score = float(scores_vec[best_index])
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
