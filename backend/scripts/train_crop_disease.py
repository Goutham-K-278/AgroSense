import json
import os
import random
from pathlib import Path
import tensorflow as tf

DATA_ROOT_CANDIDATES = [
    Path(__file__).resolve().parent.parent / ".." / name
    for name in ["crop__disease", "Crop__disease", "crop___disease", "Crop___Disease"]
]
MODEL_DIR = Path(__file__).resolve().parent.parent / "models"
MODEL_PATH = MODEL_DIR / "crop_disease_model.h5"
LABELS_PATH = MODEL_DIR / "crop_disease_labels.json"
IMG_SIZE = (224, 224)
BATCH_SIZE = 32
HEAD_EPOCHS = 8
FINE_TUNE_EPOCHS = 6
VAL_SPLIT = 0.2
SEED = 42
FINE_TUNE_LAYERS = 40

FOCUS_CLASS_BOOST = {
    "Rice_Rice___Brown_Spot": 1.8,
    "Rice_Rice___Leaf_Blast": 1.8,
}


def collect_image_paths(root: Path):
    image_paths = []
    labels = []
    for crop_dir in sorted([p for p in root.iterdir() if p.is_dir()]):
        for disease_dir in sorted([p for p in crop_dir.iterdir() if p.is_dir()]):
            label = f"{crop_dir.name}_{disease_dir.name}"
            for img_path in disease_dir.rglob("*"):
                if img_path.suffix.lower() in {".jpg", ".jpeg", ".png", ".bmp", ".webp"}:
                    image_paths.append(str(img_path))
                    labels.append(label)
    return image_paths, labels


def split_stratified(image_paths, labels, val_split=0.2, seed=42):
    grouped = {}
    for path, label in zip(image_paths, labels):
        grouped.setdefault(label, []).append(path)

    rng = random.Random(seed)
    train_paths, train_labels = [], []
    val_paths, val_labels = [], []

    for label, paths in grouped.items():
        paths_copy = paths[:]
        rng.shuffle(paths_copy)
        val_count = max(1, int(len(paths_copy) * val_split))
        val_subset = paths_copy[:val_count]
        train_subset = paths_copy[val_count:]

        if not train_subset:
            train_subset = val_subset[:1]
            val_subset = val_subset[1:]

        train_paths.extend(train_subset)
        train_labels.extend([label] * len(train_subset))
        val_paths.extend(val_subset)
        val_labels.extend([label] * len(val_subset))

    return train_paths, train_labels, val_paths, val_labels


def build_dataset(image_paths, labels, class_names, training=False):
    label_to_index = {name: idx for idx, name in enumerate(class_names)}
    y = [label_to_index[label] for label in labels]

    ds = tf.data.Dataset.from_tensor_slices((image_paths, y))

    def load_image(path, label):
        raw = tf.io.read_file(path)
        img = tf.io.decode_image(raw, channels=3, expand_animations=False)
        img = tf.image.resize(img, IMG_SIZE)
        img = tf.cast(img, tf.float32)
        img = tf.keras.applications.mobilenet_v2.preprocess_input(img)
        return img, tf.one_hot(label, len(class_names))

    if training:
        ds = ds.shuffle(buffer_size=len(image_paths), seed=SEED)

    ds = ds.map(load_image, num_parallel_calls=tf.data.AUTOTUNE)
    ds = ds.batch(BATCH_SIZE).prefetch(tf.data.AUTOTUNE)
    return ds


def build_class_weights(labels, class_names):
    counts = {name: 0 for name in class_names}
    for label in labels:
        counts[label] = counts.get(label, 0) + 1

    total = max(1, len(labels))
    class_weights = {}
    for index, class_name in enumerate(class_names):
        count = max(1, counts.get(class_name, 0))
        weight = total / (len(class_names) * count)
        weight *= FOCUS_CLASS_BOOST.get(class_name, 1.0)
        class_weights[index] = float(weight)
    return class_weights


def train():
    data_root = next((p for p in DATA_ROOT_CANDIDATES if p.exists()), None)
    if not data_root:
        raise SystemExit("Dataset folder not found. Expected one of: " + ", ".join(str(p) for p in DATA_ROOT_CANDIDATES))

    image_paths, labels = collect_image_paths(data_root)
    if not image_paths:
        raise SystemExit("No images found. Ensure crop__disease/<crop>/<disease>/images exist.")

    class_names = sorted(set(labels))
    os.makedirs(MODEL_DIR, exist_ok=True)

    train_paths, train_labels, val_paths, val_labels = split_stratified(
        image_paths=image_paths,
        labels=labels,
        val_split=VAL_SPLIT,
        seed=SEED,
    )

    train_ds = build_dataset(train_paths, train_labels, class_names, training=True)
    val_ds = build_dataset(val_paths, val_labels, class_names, training=False)
    class_weights = build_class_weights(train_labels, class_names)

    base_model = tf.keras.applications.MobileNetV2(
        input_shape=(*IMG_SIZE, 3), include_top=False, weights="imagenet"
    )
    base_model.trainable = False

    data_augmentation = tf.keras.Sequential(
        [
            tf.keras.layers.RandomFlip("horizontal"),
            tf.keras.layers.RandomRotation(0.05),
            tf.keras.layers.RandomZoom(0.1),
            tf.keras.layers.RandomContrast(0.1),
        ]
    )

    model = tf.keras.Sequential(
        [
            tf.keras.layers.Input(shape=(*IMG_SIZE, 3)),
            data_augmentation,
            base_model,
            tf.keras.layers.GlobalAveragePooling2D(),
            tf.keras.layers.Dense(128, activation="relu"),
            tf.keras.layers.Dropout(0.3),
            tf.keras.layers.Dense(len(class_names), activation="softmax"),
        ]
    )

    model.compile(optimizer="adam", loss="categorical_crossentropy", metrics=["accuracy"])
    model.summary()

    callbacks = [tf.keras.callbacks.EarlyStopping(monitor="val_accuracy", patience=3, restore_best_weights=True)]

    model.fit(
        train_ds,
        validation_data=val_ds,
        epochs=HEAD_EPOCHS,
        callbacks=callbacks,
        class_weight=class_weights,
    )

    base_model.trainable = True
    for layer in base_model.layers[:-FINE_TUNE_LAYERS]:
        layer.trainable = False

    model.compile(
        optimizer=tf.keras.optimizers.Adam(learning_rate=1e-5),
        loss="categorical_crossentropy",
        metrics=["accuracy"],
    )

    model.fit(
        train_ds,
        validation_data=val_ds,
        epochs=HEAD_EPOCHS + FINE_TUNE_EPOCHS,
        initial_epoch=HEAD_EPOCHS,
        callbacks=callbacks,
        class_weight=class_weights,
    )

    model.save(MODEL_PATH)
    with open(LABELS_PATH, "w", encoding="utf-8") as fp:
        json.dump(class_names, fp, indent=2)
    print(f"Saved model to {MODEL_PATH}")
    print(f"Saved labels to {LABELS_PATH}")


if __name__ == "__main__":
    train()
