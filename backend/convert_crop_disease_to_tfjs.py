import tensorflow as tf
import tensorflowjs as tfjs
from pathlib import Path

MODEL_DIR = Path(__file__).resolve().parent / "models"
H5_PATH = MODEL_DIR / "crop_disease_model.h5"
TFJS_DIR = MODEL_DIR / "crop_disease_model"

if not H5_PATH.exists():
    raise SystemExit(f"Missing source H5 model: {H5_PATH}")

TFJS_DIR.mkdir(parents=True, exist_ok=True)
model = tf.keras.models.load_model(H5_PATH)
tfjs.converters.save_keras_model(model, TFJS_DIR)
print(f"Converted {H5_PATH.name} -> {TFJS_DIR}")
