import argparse
from pathlib import Path

import tensorflow as tf
import tf2onnx


DEFAULT_INPUT_NAME = "input_1"
DEFAULT_OUTPUT_NAME = "predictions"


def convert_keras_to_onnx(model_path: Path, output_path: Path, opset: int):
    model = tf.keras.models.load_model(model_path, compile=False)

    # Keep a fixed image tensor shape for predictable server inference performance.
    spec = (tf.TensorSpec((None, 224, 224, 3), tf.float32, name=DEFAULT_INPUT_NAME),)
    _model_proto, _ = tf2onnx.convert.from_keras(
        model,
        input_signature=spec,
        opset=opset,
        output_path=str(output_path),
    )


def parse_args():
    parser = argparse.ArgumentParser(description="Convert crop disease Keras model to ONNX")
    parser.add_argument(
        "--model",
        default=str(Path(__file__).resolve().parents[1] / "models" / "crop_disease_model.h5"),
        help="Path to source Keras .h5 model",
    )
    parser.add_argument(
        "--out",
        default=str(Path(__file__).resolve().parents[1] / "models" / "crop_disease_model.onnx"),
        help="Path for generated ONNX file",
    )
    parser.add_argument("--opset", type=int, default=13, help="ONNX opset version")
    return parser.parse_args()


def main():
    args = parse_args()
    model_path = Path(args.model).resolve()
    output_path = Path(args.out).resolve()

    if not model_path.exists():
        raise FileNotFoundError(f"Model not found: {model_path}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    convert_keras_to_onnx(model_path, output_path, args.opset)
    print(f"ONNX model written to: {output_path}")


if __name__ == "__main__":
    main()
