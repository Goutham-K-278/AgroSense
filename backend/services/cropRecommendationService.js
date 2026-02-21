import { RandomForestClassifier as RFClassifier } from "ml-random-forest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATASET_DIR = path.resolve(__dirname, "..", "..", "Data Set");
const MODEL_DIR = path.resolve(__dirname, "..", "models");
const CROP_MODEL_PATH = path.join(MODEL_DIR, "crop_model.json");

const CLASSIFIER_OPTIONS = {
  seed: 42,
  maxFeatures: 0.8,
  replacement: true,
  nEstimators: 40,
};

const parseCsvLine = (line = "") => {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values;
};

const parseCsvFile = (filePath) => {
  if (!existsSync(filePath)) return [];

  const raw = readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]);
  const rows = [];

  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const values = parseCsvLine(lines[lineIndex]);
    const row = {};

    for (let columnIndex = 0; columnIndex < headers.length; columnIndex += 1) {
      row[headers[columnIndex]] = values[columnIndex] ?? "";
    }

    rows.push(row);
  }

  return rows;
};

const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeCropName = (value) => {
  if (typeof value !== "string") return "";
  const text = value.trim().replace(/[_-]+/g, " ");
  if (!text) return "";

  return text
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

const pickTargetCrop = (row = {}) => {
  const candidate =
    normalizeCropName(row.label) ||
    normalizeCropName(row.Crop1) ||
    normalizeCropName(row.Crop) ||
    normalizeCropName(row.Crop_Type);

  return candidate;
};

const computeTamilNaduCropWeights = () => {
  const rows = parseCsvFile(path.join(DATASET_DIR, "Tamilnadu Crop-Production.csv"));
  const counts = new Map();

  for (const row of rows) {
    const cropName = normalizeCropName(row.Crop);
    if (!cropName) continue;

    counts.set(cropName, (counts.get(cropName) || 0) + 1);
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) {
    return new Map();
  }

  const maxCount = sorted[0][1];
  const weights = new Map();
  for (const [crop, count] of sorted) {
    const weight = 1 + Math.round((count / maxCount) * 2);
    weights.set(crop, Math.max(1, Math.min(weight, 3)));
  }

  return weights;
};

const buildCropTrainingData = () => {
  const rows = parseCsvFile(path.join(DATASET_DIR, "soil_with_crop_recommendations.csv"));
  const cropWeights = computeTamilNaduCropWeights();
  const cropToIndex = new Map();
  const indexToCrop = [];

  const features = [];
  const labels = [];

  for (const row of rows) {
    const N = toNumber(row.Nitrogen_Level);
    const P = toNumber(row.Phosphorus_Level);
    const K = toNumber(row.Potassium_Level);
    const rainfall = toNumber(row.rainfall) ?? 5;
    const temperature = toNumber(row.Ambient_Temperature);
    const humidity = toNumber(row.Humidity);
    const crop = pickTargetCrop(row);

    if (
      !crop ||
      !Number.isFinite(N) ||
      !Number.isFinite(P) ||
      !Number.isFinite(K) ||
      !Number.isFinite(temperature) ||
      !Number.isFinite(humidity)
    ) {
      continue;
    }

    if (!cropToIndex.has(crop)) {
      cropToIndex.set(crop, indexToCrop.length);
      indexToCrop.push(crop);
    }

    const classIndex = cropToIndex.get(crop);
    const repeatCount = cropWeights.get(crop) || 1;

    for (let repeat = 0; repeat < repeatCount; repeat += 1) {
      features.push([N, P, K, rainfall, temperature, humidity]);
      labels.push(classIndex);

      if (features.length >= 2500) {
        break;
      }
    }

    if (features.length >= 2500) {
      break;
    }
  }

  return {
    features,
    labels,
    labelsMap: indexToCrop,
    sampleCount: features.length,
  };
};

const trainAndPersistCropModel = () => {
  const dataset = buildCropTrainingData();
  const classifier = new RFClassifier(CLASSIFIER_OPTIONS);

  if (dataset.sampleCount < 150 || dataset.labelsMap.length < 3) {
    return {
      model: null,
      metadata: {
        enabled: false,
        reason: "Insufficient crop training data",
        sampleCount: dataset.sampleCount,
        classes: dataset.labelsMap,
      },
    };
  }

  classifier.train(dataset.features, dataset.labels);

  mkdirSync(MODEL_DIR, { recursive: true });
  writeFileSync(
    CROP_MODEL_PATH,
    JSON.stringify(
      {
        version: "1.0.0",
        trainedAt: new Date().toISOString(),
        sampleCount: dataset.sampleCount,
        classLabels: dataset.labelsMap,
        model: classifier.toJSON(),
      },
      null,
      2,
    ),
    "utf-8",
  );

  return {
    model: classifier,
    metadata: {
      enabled: true,
      source: "trained",
      sampleCount: dataset.sampleCount,
      classes: dataset.labelsMap,
      trainedAt: new Date().toISOString(),
    },
    classLabels: dataset.labelsMap,
  };
};

const loadPersistedCropModel = () => {
  if (!existsSync(CROP_MODEL_PATH)) return null;

  try {
    const payload = JSON.parse(readFileSync(CROP_MODEL_PATH, "utf-8"));
    if (!payload?.model || !Array.isArray(payload?.classLabels)) {
      return null;
    }

    return {
      model: RFClassifier.load(payload.model),
      classLabels: payload.classLabels,
      metadata: {
        enabled: true,
        source: "persisted",
        sampleCount: Number(payload.sampleCount) || 0,
        classes: payload.classLabels,
        trainedAt: payload.trainedAt || null,
      },
    };
  } catch (error) {
    console.error("Failed to load persisted crop model:", error?.message || error);
    return null;
  }
};

const normalizeProbabilities = (items) => {
  const total = items.reduce((sum, item) => sum + item.confidence, 0);
  if (total <= 0) return items;

  return items.map((item) => ({
    ...item,
    confidence: Number(((item.confidence / total) * 100).toFixed(2)),
  }));
};

let cropModelBundle = null;
try {
  const loadedModel = loadPersistedCropModel();
  cropModelBundle = loadedModel || trainAndPersistCropModel();
} catch (error) {
  console.error("Crop model initialization failed. Crop recommendations will be disabled.", error?.message || error);
  cropModelBundle = {
    model: null,
    classLabels: [],
    metadata: {
      enabled: false,
      reason: "Crop model initialization error",
    },
  };
}

export const cropModelMetadata = cropModelBundle?.metadata || { enabled: false, reason: "Crop model unavailable" };

export const recommendCrops = ({ N, P, K, rainfall, temperature, humidity }) => {
  if (!cropModelBundle?.model || !Array.isArray(cropModelBundle?.classLabels)) {
    return [];
  }

  const input = [[Number(N), Number(P), Number(K), Number(rainfall || 0), Number(temperature), Number(humidity)]];
  const classLabels = cropModelBundle.classLabels;

  const scored = classLabels.map((label, index) => {
    let confidence = 0;
    try {
      confidence = Number(cropModelBundle.model.predictProbability(input, index)?.[0] || 0);
    } catch (error) {
      confidence = 0;
    }

    return {
      crop: label,
      confidence,
    };
  });

  return normalizeProbabilities(scored)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3);
};
