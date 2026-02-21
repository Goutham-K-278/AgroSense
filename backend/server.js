import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import admin from "firebase-admin";
import webpush from "web-push";
import multer from "multer";
import { RandomForestRegression as RFRegression } from "ml-random-forest";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { analyzeTrend } from "./services/trendService.js";
import { buildAdvisory } from "./services/advisoryService.js";
import { createAuthMiddleware } from "./middleware/authMiddleware.js";
import { getWeatherContext } from "./services/weatherService.js";
import { computeSoilHealth } from "./services/soilHealthService.js";
import { buildForecast } from "./services/forecastService.js";
import { buildFarmAnalytics } from "./services/analyticsService.js";
import { computeSustainability } from "./services/sustainabilityService.js";
import { createFertilizerPlan } from "./services/fertilizerPlanService.js";
import { generateFarmAlerts, sortAlertsByPriority } from "./services/alertEngine.js";

let cropModelMetadata = { enabled: false, reason: "Not loaded" };
let recommendCrops = () => [];
let cropServiceLoadAttempted = false;

const ensureCropService = async () => {
  if (cropServiceLoadAttempted) return;

  cropServiceLoadAttempted = true;
  try {
    const cropServiceModule = await import("./services/cropRecommendationService.js");
    cropModelMetadata = cropServiceModule.cropModelMetadata || cropModelMetadata;
    recommendCrops = cropServiceModule.recommendCrops || recommendCrops;
    console.log("🌾 Crop recommendation service loaded.");
  } catch (error) {
    cropModelMetadata = { enabled: false, reason: "Load error" };
    recommendCrops = () => [];
    console.error("Crop recommendation service failed to load. Continuing without crop model.", error);
  }
};

dotenv.config();

const FIREBASE_DATABASE_URL =
  process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_DB_URL || process.env.FIREBASE_RTDB_URL || null;
const SENSOR_DATA_PATH = (process.env.FIREBASE_SENSOR_PATH || "sensor").replace(/^\/+/u, "");

const app = express();
const PORT = process.env.PORT || 5000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tfLibPath = path.join(__dirname, "node_modules", "@tensorflow", "tfjs-node", "deps", "lib");
if (!process.env.PATH?.toLowerCase().includes(tfLibPath.toLowerCase())) {
  process.env.PATH = `${tfLibPath};${process.env.PATH || ""}`;
}
const tf = await import("@tensorflow/tfjs-node");
const MODEL_DIR = path.join(__dirname, "models");
const MODEL_FILE_PATH = path.join(MODEL_DIR, "npk_model.json");
const FRONTEND_DIST_PATH = path.join(__dirname, "..", "frontend", "dist");
const DISEASE_MODEL_H5_PATH = path.join(MODEL_DIR, "crop_disease_model.h5");
const DISEASE_LABELS_PATH = path.join(MODEL_DIR, "crop_disease_labels.json");
const DISEASE_PREDICT_SCRIPT_PATH = path.join(__dirname, "scripts", "predict_crop_disease.py");
const DISEASE_DAEMON_SCRIPT_PATH = path.join(__dirname, "scripts", "predict_crop_disease_daemon.py");
const VENV_PYTHON_PATH = path.join(__dirname, "..", ".venv", "Scripts", "python.exe");
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const resolveDatasetPath = () => {
  const candidates = [
    path.join(__dirname, "..", "crop__disease"),
    path.join(__dirname, "..", "Crop__disease"),
    path.join(__dirname, "..", "crop___disease"),
    path.join(__dirname, "..", "Crop___Disease"),
  ];

  return candidates.find((p) => existsSync(p)) || candidates[0];
};

const readDirSafe = (dirPath) => {
  try {
    return readdirSync(dirPath).filter((item) => statSync(path.join(dirPath, item)).isDirectory());
  } catch {
    return [];
  }
};

const VAPID_KEYS_PATH = path.join(__dirname, "vapid-keys.json");
const PUSH_SUBSCRIPTIONS_PATH = path.join(__dirname, "push-subscriptions.json");

const loadOrCreateVapidKeys = () => {
  try {
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
      return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
    }

    if (existsSync(VAPID_KEYS_PATH)) {
      const parsed = JSON.parse(readFileSync(VAPID_KEYS_PATH, "utf-8"));
      if (parsed?.publicKey && parsed?.privateKey) {
        return parsed;
      }
    }

    const generated = webpush.generateVAPIDKeys();
    writeFileSync(VAPID_KEYS_PATH, JSON.stringify(generated, null, 2));
    console.log("🔑 Generated VAPID keys and saved to vapid-keys.json");
    return generated;
  } catch (error) {
    console.error("Failed to load or generate VAPID keys:", error);
    return { publicKey: null, privateKey: null };
  }
};

const loadPushSubscriptions = () => {
  try {
    if (existsSync(PUSH_SUBSCRIPTIONS_PATH)) {
      const parsed = JSON.parse(readFileSync(PUSH_SUBSCRIPTIONS_PATH, "utf-8"));
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch (error) {
    console.error("Failed to read push subscriptions:", error);
  }
  return [];
};

const persistSubscriptions = (items) => {
  try {
    writeFileSync(PUSH_SUBSCRIPTIONS_PATH, JSON.stringify(items, null, 2));
  } catch (error) {
    console.error("Failed to persist push subscriptions:", error);
  }
};

let vapidKeys = loadOrCreateVapidKeys();
let pushSubscriptions = loadPushSubscriptions();

if (vapidKeys?.publicKey && vapidKeys?.privateKey) {
  webpush.setVapidDetails("mailto:alerts@uzhavar.ai", vapidKeys.publicKey, vapidKeys.privateKey);
} else {
  console.warn("⚠ VAPID keys missing; push notifications will be disabled.");
}

const addOrUpdateSubscription = ({ subscription, uid }) => {
  if (!subscription?.endpoint) {
    return null;
  }

  const existingIndex = pushSubscriptions.findIndex((item) => item.subscription?.endpoint === subscription.endpoint);
  const now = Date.now();

  const record = {
    subscription,
    uid: uid || "",
    createdAt: existingIndex >= 0 ? pushSubscriptions[existingIndex].createdAt : now,
    updatedAt: now,
  };

  if (existingIndex >= 0) {
    pushSubscriptions[existingIndex] = record;
  } else {
    pushSubscriptions.push(record);
  }

  persistSubscriptions(pushSubscriptions);
  return record;
};

const sendPushToAll = async (payload, excludeUid = null) => {
  if (!vapidKeys?.publicKey || !vapidKeys?.privateKey) {
    console.warn("Push skipped: VAPID keys not set.");
    return { sent: 0, failed: pushSubscriptions.length };
  }

  let sent = 0;
  let failed = 0;
  const nextSubscriptions = [];

  for (const entry of pushSubscriptions) {
    if (excludeUid && entry.uid && entry.uid === excludeUid) {
      nextSubscriptions.push(entry);
      continue;
    }

    try {
      await webpush.sendNotification(entry.subscription, JSON.stringify(payload));
      sent += 1;
      nextSubscriptions.push(entry);
    } catch (error) {
      failed += 1;
      if (error?.statusCode !== 410 && error?.statusCode !== 404) {
        console.error("Push send failed:", error?.message || error);
        nextSubscriptions.push(entry);
      }
    }
  }

  pushSubscriptions = nextSubscriptions;
  persistSubscriptions(pushSubscriptions);

  return { sent, failed };
};

const deriveLabelsFromDataset = () => {
  const datasetPath = resolveDatasetPath();
  if (!existsSync(datasetPath)) {
    return [];
  }

  const labels = new Set();
  const crops = readDirSafe(datasetPath);

  for (const crop of crops) {
    const cropDir = path.join(datasetPath, crop);
    const diseaseFolders = readDirSafe(cropDir);
    for (const disease of diseaseFolders) {
      labels.add(`${crop}_${disease}`);
    }
  }

  return Array.from(labels).sort((a, b) => a.localeCompare(b));
};

const loadDiseaseLabels = () => {
  try {
    if (existsSync(DISEASE_LABELS_PATH)) {
      const parsed = JSON.parse(readFileSync(DISEASE_LABELS_PATH, "utf-8"));
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch (error) {
    console.error("Failed to load disease labels:", error);
  }

  const derived = deriveLabelsFromDataset();
  if (derived.length > 0) {
    console.log(`⚠ Using derived labels from dataset (${derived.length})`);
  }
  return derived;
};

let diseaseLabels = loadDiseaseLabels();
let diseaseModelLogged = false;
let diseaseDaemon = null;
let diseaseDaemonReady = false;
let diseaseDaemonStdoutBuffer = "";
let diseaseDaemonNextId = 1;
const diseaseDaemonPending = new Map();

const resolvePythonCommand = () => {
  if (existsSync(VENV_PYTHON_PATH)) {
    return VENV_PYTHON_PATH;
  }
  return process.env.PYTHON_PATH || "python";
};

const rejectAllDiseaseDaemonPending = (reason) => {
  for (const [, pending] of diseaseDaemonPending) {
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
  }
  diseaseDaemonPending.clear();
};

const resetDiseaseDaemon = (reason = "Disease daemon reset") => {
  if (diseaseDaemon && !diseaseDaemon.killed) {
    try {
      diseaseDaemon.kill();
    } catch {
      // ignore
    }
  }
  diseaseDaemon = null;
  diseaseDaemonReady = false;
  diseaseDaemonStdoutBuffer = "";
  rejectAllDiseaseDaemonPending(reason);
};

const handleDiseaseDaemonStdoutChunk = (chunk) => {
  diseaseDaemonStdoutBuffer += chunk.toString();

  let lineBreakIndex = diseaseDaemonStdoutBuffer.indexOf("\n");
  while (lineBreakIndex >= 0) {
    const line = diseaseDaemonStdoutBuffer.slice(0, lineBreakIndex).trim();
    diseaseDaemonStdoutBuffer = diseaseDaemonStdoutBuffer.slice(lineBreakIndex + 1);

    if (line) {
      try {
        const parsed = JSON.parse(line);

        if (parsed?.type === "ready") {
          diseaseDaemonReady = true;
        } else if (Number.isFinite(Number(parsed?.id))) {
          const requestId = Number(parsed.id);
          const pending = diseaseDaemonPending.get(requestId);
          if (pending) {
            diseaseDaemonPending.delete(requestId);
            clearTimeout(pending.timer);
            if (parsed.error) {
              pending.reject(new Error(parsed.error));
            } else {
              pending.resolve(parsed);
            }
          }
        }
      } catch {
        // ignore malformed daemon line
      }
    }

    lineBreakIndex = diseaseDaemonStdoutBuffer.indexOf("\n");
  }
};

const ensureDiseaseDaemon = () =>
  new Promise((resolve, reject) => {
    if (diseaseDaemon && diseaseDaemonReady) {
      resolve(diseaseDaemon);
      return;
    }

    if (!existsSync(DISEASE_MODEL_H5_PATH)) {
      reject(new Error("Disease model not found. Expected backend/models/crop_disease_model.h5"));
      return;
    }

    if (!existsSync(DISEASE_DAEMON_SCRIPT_PATH)) {
      reject(new Error("Disease daemon script missing at backend/scripts/predict_crop_disease_daemon.py"));
      return;
    }

    if (!diseaseDaemon) {
      diseaseDaemonReady = false;
      diseaseDaemonStdoutBuffer = "";

      diseaseDaemon = spawn(resolvePythonCommand(), [DISEASE_DAEMON_SCRIPT_PATH], {
        cwd: __dirname,
        env: {
          ...process.env,
          DISEASE_MODEL_PATH: DISEASE_MODEL_H5_PATH,
          DISEASE_LABELS_PATH,
        },
      });

      diseaseDaemon.stdout.on("data", handleDiseaseDaemonStdoutChunk);
      diseaseDaemon.stderr.on("data", (chunk) => {
        const message = chunk.toString().trim();
        if (message) {
          console.warn("Disease daemon stderr:", message);
        }
      });

      diseaseDaemon.on("error", (error) => {
        resetDiseaseDaemon(`Disease daemon error: ${error.message}`);
      });

      diseaseDaemon.on("close", (code) => {
        resetDiseaseDaemon(`Disease daemon exited with code ${code}`);
      });
    }

    const start = Date.now();
    const waitUntilReady = () => {
      if (diseaseDaemon && diseaseDaemonReady) {
        resolve(diseaseDaemon);
        return;
      }

      if (Date.now() - start > 12000) {
        reject(new Error("Disease daemon startup timeout"));
        return;
      }

      setTimeout(waitUntilReady, 120);
    };

    waitUntilReady();
  });

const runPersistentPythonDiseaseInference = async (imageBuffer) => {
  const daemon = await ensureDiseaseDaemon();

  return new Promise((resolve, reject) => {
    const requestId = diseaseDaemonNextId++;
    const timer = setTimeout(() => {
      diseaseDaemonPending.delete(requestId);
      reject(new Error("Disease inference timeout"));
    }, 15000);

    diseaseDaemonPending.set(requestId, { resolve, reject, timer });

    const payload = `${JSON.stringify({ id: requestId, image: imageBuffer.toString("base64") })}\n`;
    daemon.stdin.write(payload, (error) => {
      if (error) {
        clearTimeout(timer);
        diseaseDaemonPending.delete(requestId);
        reject(new Error(`Disease daemon stdin write failed: ${error.message}`));
      }
    });
  });
};

const runPythonDiseaseInference = (imageBuffer) =>
  new Promise((resolve, reject) => {
    if (!existsSync(DISEASE_MODEL_H5_PATH)) {
      reject(new Error("Disease model not found. Expected backend/models/crop_disease_model.h5"));
      return;
    }

    if (!existsSync(DISEASE_PREDICT_SCRIPT_PATH)) {
      reject(new Error("Disease inference script missing at backend/scripts/predict_crop_disease.py"));
      return;
    }

    const child = spawn(
      resolvePythonCommand(),
      [DISEASE_PREDICT_SCRIPT_PATH, "--model", DISEASE_MODEL_H5_PATH, "--labels", DISEASE_LABELS_PATH],
      { cwd: __dirname, env: process.env },
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(new Error(`Python inference process failed to start: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Disease inference failed with exit code ${code}`));
        return;
      }

      try {
        const jsonStart = stdout.indexOf("{");
        const jsonEnd = stdout.lastIndexOf("}");
        const jsonPayload = jsonStart >= 0 && jsonEnd > jsonStart ? stdout.slice(jsonStart, jsonEnd + 1) : stdout;
        const parsed = JSON.parse(jsonPayload);
        resolve(parsed);
      } catch {
        const snippet = stdout.trim().slice(0, 180);
        reject(new Error(`Disease inference returned invalid JSON${snippet ? `: ${snippet}` : ""}`));
      }
    });

    child.stdin.write(imageBuffer);
    child.stdin.end();
  });

const recommendationBook = {
  rice_leaf_blast: {
    problem: "Fungal infection (Magnaporthe oryzae)",
    whatToDo: [
      "Avoid excess nitrogen and waterlogging",
      "Improve drainage and field airflow",
      "Apply label-approved fungicide in the evening",
    ],
    prevention: ["Use resistant varieties", "Maintain wider spacing", "Monitor for early lesions"],
    urgency: "high",
  },
  rice_brown_spot: {
    problem: "Likely nutrient stress or fungal leaf spot",
    whatToDo: ["Apply balanced NPK", "Remove heavily infected leaves", "Avoid overhead irrigation"],
    prevention: ["Use clean seed", "Maintain potash levels", "Rotate fields if pressure repeats"],
    urgency: "medium",
  },
  rice_neck_blast: {
    problem: "Severe blast on panicle/neck region",
    whatToDo: ["Spray targeted blast fungicide at booting", "Improve drainage", "Avoid late nitrogen"],
    prevention: ["Use tolerant cultivars", "Ensure balanced nutrition", "Scout during heading"],
    urgency: "high",
  },
  rice_healthy: {
    problem: "Crop appears healthy",
    whatToDo: ["Maintain balanced nutrition", "Continue field scouting", "Irrigate as per schedule"],
    prevention: ["Keep canopy airy", "Avoid overwatering", "Use clean tools"],
    urgency: "low",
  },
  corn_gray_leaf_spot: {
    problem: "Gray leaf spot fungal infection",
    whatToDo: ["Remove heavily infected leaves", "Avoid late-evening leaf wetness", "Spray recommended fungicide if spread increases"],
    prevention: ["Use disease-tolerant seed", "Maintain spacing for airflow", "Avoid excess nitrogen"],
    urgency: "medium",
  },
  corn_common_rust: {
    problem: "Common rust fungal disease",
    whatToDo: ["Monitor rust pustules on upper leaves", "Spray rust-target fungicide at threshold", "Maintain field sanitation"],
    prevention: ["Use resistant hybrids", "Timely sowing", "Balanced fertilizer schedule"],
    urgency: "medium",
  },
  corn_northern_leaf_blight: {
    problem: "Northern leaf blight fungal disease",
    whatToDo: ["Remove severely damaged leaves", "Apply recommended fungicide", "Reduce prolonged leaf moisture"],
    prevention: ["Use resistant hybrids", "Crop rotation", "Avoid dense canopy"],
    urgency: "high",
  },
  corn_healthy: {
    problem: "Crop appears healthy",
    whatToDo: ["Continue routine scouting", "Maintain moisture balance", "Follow standard nutrient plan"],
    prevention: ["Keep weeds low", "Use clean tools", "Observe weekly"],
    urgency: "low",
  },
  potato_early_blight: {
    problem: "Early blight fungal infection",
    whatToDo: ["Remove affected leaves", "Spray recommended fungicide in rotation", "Avoid overhead irrigation"],
    prevention: ["Use healthy seed tubers", "Improve spacing", "Maintain potash level"],
    urgency: "medium",
  },
  potato_late_blight: {
    problem: "Late blight high-risk fungal infection",
    whatToDo: ["Immediate fungicide spray as per label", "Destroy severely infected plants", "Avoid water stagnation"],
    prevention: ["Use certified seed", "Monitor daily in humid weather", "Ensure drainage"],
    urgency: "high",
  },
  potato_healthy: {
    problem: "Crop appears healthy",
    whatToDo: ["Continue irrigation schedule", "Monitor lower leaves weekly", "Maintain balanced nutrients"],
    prevention: ["Sanitize tools", "Avoid crowded canopy", "Use quality seed"],
    urgency: "low",
  },
  wheat_brown_rust: {
    problem: "Brown rust fungal disease",
    whatToDo: ["Scout for rust spread in upper leaves", "Apply rust-specific fungicide if needed", "Avoid excess late nitrogen"],
    prevention: ["Use resistant varieties", "Timely sowing", "Balanced fertilizer"],
    urgency: "medium",
  },
  wheat_yellow_rust: {
    problem: "Yellow rust fungal disease",
    whatToDo: ["Start fungicide quickly", "Remove heavily infected area if localized", "Monitor every 2-3 days"],
    prevention: ["Use resistant varieties", "Avoid delayed management", "Maintain field hygiene"],
    urgency: "high",
  },
  wheat_healthy: {
    problem: "Crop appears healthy",
    whatToDo: ["Continue routine monitoring", "Maintain irrigation schedule", "Follow recommended nutrient plan"],
    prevention: ["Keep weeds controlled", "Use clean tools", "Scout weekly"],
    urgency: "low",
  },
  sugarcane_bacterial_blight: {
    problem: "Possible bacterial blight infection",
    whatToDo: ["Remove heavily infected leaves", "Avoid splash irrigation", "Consult local extension for bactericide guidance"],
    prevention: ["Use clean planting material", "Sanitize cutting tools", "Maintain drainage"],
    urgency: "medium",
  },
  sugarcane_red_rot: {
    problem: "Red rot severe fungal disease",
    whatToDo: ["Rogue and destroy infected clumps", "Avoid ratooning infected field", "Treat setts before planting"],
    prevention: ["Use resistant varieties", "Field sanitation", "Crop rotation where possible"],
    urgency: "high",
  },
  sugarcane_healthy: {
    problem: "Crop appears healthy",
    whatToDo: ["Continue regular field checks", "Maintain irrigation and drainage", "Follow nutrient schedule"],
    prevention: ["Use clean tools", "Monitor for stalk discoloration", "Keep field clean"],
    urgency: "low",
  },
  default: {
    problem: "Likely foliar stress detected",
    whatToDo: ["Improve drainage and airflow", "Avoid over-irrigation", "Apply broad-spectrum fungicide if spreading"],
    prevention: ["Sanitize tools", "Maintain balanced fertilizer", "Monitor daily for change"],
    urgency: "medium",
  },
};

const recommendationTamilBook = {
  rice_leaf_blast: {
    problem: "பூஞ்சை தொற்று (Leaf Blast)",
    whatToDo: ["அதிக நைட்ரஜன் தவிர்க்கவும்", "நீர்த் தேக்கம் வராமல் வடிகால் மேம்படுத்தவும்", "மாலை நேரத்தில் பரிந்துரைக்கப்பட்ட பூஞ்சைநாசினி பயன்படுத்தவும்"],
    prevention: ["எதிர்ப்பு வகை விதை பயன்படுத்தவும்", "செடிகளுக்கு இடைவெளி வையுங்கள்", "ஆரம்ப அறிகுறி தினமும் பாருங்கள்"],
  },
  rice_brown_spot: {
    problem: "ஊட்டச்சத்து குறைபாடு அல்லது பழுப்பு புள்ளி நோய் சாத்தியம்",
    whatToDo: ["சமநிலை NPK உரம் இடவும்", "மிக பாதித்த இலைகளை அகற்றவும்", "மேலிருந்து நீர் பாய்ச்சலை குறைக்கவும்"],
    prevention: ["சுத்தமான விதை பயன்படுத்தவும்", "பொட்டாசியம் அளவை சீராக வைத்திருக்கவும்", "மீண்டும் மீண்டும் வந்தால் பயிர் மாறுதல் செய்யவும்"],
  },
  rice_neck_blast: {
    problem: "கதிர்/கழுத்து பகுதியில் கடுமையான blast தாக்கம்",
    whatToDo: ["கதிர் கட்டும் நிலையில் குறிவைத்த மருந்து தெளிக்கவும்", "வடிகால் மேம்படுத்தவும்", "தாமத நைட்ரஜன் தவிர்க்கவும்"],
    prevention: ["சகிப்புத்தன்மை உள்ள வகை பயன்படுத்தவும்", "சமநிலை உரமிடவும்", "கதிர் கட்டும் காலத்தில் கண்காணிக்கவும்"],
  },
  rice_healthy: {
    problem: "பயிர் ஆரோக்கியமாக உள்ளது",
    whatToDo: ["சமநிலை உரமிடலை தொடரவும்", "வயல் கண்காணிப்பை வழக்கமாக செய்யவும்", "அட்டவணைப்படி நீர்ப்பாசனம் செய்யவும்"],
    prevention: ["அதிக ஈரத்தை தவிர்க்கவும்", "கருவிகளை சுத்தமாக வைத்திருக்கவும்", "இடைவெளி பராமரிக்கவும்"],
  },
  corn_gray_leaf_spot: {
    problem: "சோளத்தில் சாம்பல் இலைப்புள்ளி பூஞ்சை பாதிப்பு",
    whatToDo: ["அதிக பாதித்த இலைகளை அகற்றவும்", "இலை நீண்ட நேரம் ஈரமாக இருப்பதை தவிர்க்கவும்", "பரவல் அதிகரித்தால் பரிந்துரைக்கப்பட்ட பூஞ்சைநாசினி தெளிக்கவும்"],
    prevention: ["எதிர்ப்பு விதை/ஹைபிரிட் பயன்படுத்தவும்", "காற்றோட்ட இடைவெளி பராமரிக்கவும்", "அதிக நைட்ரஜன் தவிர்க்கவும்"],
  },
  corn_common_rust: {
    problem: "சோளத்தில் பொதுத் துரு நோய்",
    whatToDo: ["மேல் இலைகளில் துரு புள்ளி பரவலை கண்காணிக்கவும்", "தேவையானால் குறிவைத்த பூஞ்சைநாசினி பயன்படுத்தவும்", "வயல் சுத்தம் பராமரிக்கவும்"],
    prevention: ["எதிர்ப்பு ஹைபிரிட் பயன்படுத்தவும்", "சரியான நேர விதைப்பு", "சமநிலை உரம்"],
  },
  corn_northern_leaf_blight: {
    problem: "சோளத்தில் வடக்கு இலை ப்ளைட் பூஞ்சை தாக்கம்",
    whatToDo: ["மிக பாதித்த இலைகளை அகற்றவும்", "பரிந்துரைக்கப்பட்ட மருந்து தெளிக்கவும்", "இலை ஈரநேரம் குறைக்கவும்"],
    prevention: ["எதிர்ப்பு ஹைபிரிட்", "பயிர் மாறுதல்", "அடர்த்தி குறைக்கவும்"],
  },
  corn_healthy: {
    problem: "பயிர் ஆரோக்கியமாக உள்ளது",
    whatToDo: ["வழக்கமான கண்காணிப்பை தொடரவும்", "நீர்ப்பாசனம் சமநிலையாக வைக்கவும்", "உர அட்டவணையைப் பின்பற்றவும்"],
    prevention: ["களைகள் கட்டுப்பாடு", "கருவி சுத்தம்", "வாராந்திர பரிசோதனை"],
  },
  potato_early_blight: {
    problem: "உருளைக்கிழங்கில் ஆரம்ப ப்ளைட் பூஞ்சை தாக்கம்",
    whatToDo: ["பாதித்த இலைகளை அகற்றவும்", "மாற்றி மாற்றி பரிந்துரைக்கப்பட்ட மருந்து தெளிக்கவும்", "மேலிருந்து நீர்ப்பாசனம் குறைக்கவும்"],
    prevention: ["ஆரோக்கிய விதைக் கிழங்கு", "இடைவெளி பராமரிப்பு", "பொட்டாசியம் போதுமான அளவு"],
  },
  potato_late_blight: {
    problem: "உருளைக்கிழங்கில் கடுமையான தாமத ப்ளைட் ஆபத்து",
    whatToDo: ["உடனடி மருந்து தெளிக்கவும்", "மிக பாதித்த செடிகளை நீக்கவும்", "நீர்த் தேக்கம் தவிர்க்கவும்"],
    prevention: ["சான்றளிக்கப்பட்ட விதை", "ஈரமான காலநிலையில் தினசரி கண்காணிப்பு", "வடிகால் பராமரிப்பு"],
  },
  potato_healthy: {
    problem: "பயிர் ஆரோக்கியமாக உள்ளது",
    whatToDo: ["நீர்ப்பாசன அட்டவணையை தொடரவும்", "கீழ் இலைகளை வாரம் ஒருமுறை பார்க்கவும்", "சமநிலை உரம் பயன்படுத்தவும்"],
    prevention: ["கருவி சுத்தம்", "அடர்த்தி தவிர்க்கவும்", "தரமான விதை பயன்படுத்தவும்"],
  },
  wheat_brown_rust: {
    problem: "கோதுமையில் பழுப்பு துரு நோய்",
    whatToDo: ["மேல் இலை துரு பரவலை கண்காணிக்கவும்", "தேவையானால் துரு மருந்து தெளிக்கவும்", "தாமத நைட்ரஜன் அதிகப்படுத்த வேண்டாம்"],
    prevention: ["எதிர்ப்பு வகை", "சரியான நேர விதைப்பு", "சமநிலை உரம்"],
  },
  wheat_yellow_rust: {
    problem: "கோதுமையில் மஞ்சள் துரு நோய்",
    whatToDo: ["மருந்தை விரைவாக தொடங்கவும்", "உள்ளூர் தாக்கம் அதிகம் হলে பாதித்த பகுதியை அகற்றவும்", "2-3 நாளுக்கு ஒருமுறை கண்காணிக்கவும்"],
    prevention: ["எதிர்ப்பு வகை", "தாமதம் இல்லாத மேலாண்மை", "வயல் சுத்தம்"],
  },
  wheat_healthy: {
    problem: "பயிர் ஆரோக்கியமாக உள்ளது",
    whatToDo: ["வழக்கமான கண்காணிப்பு", "நீர்ப்பாசன அட்டவணை", "பரிந்துரைத்த உர திட்டம்"],
    prevention: ["களை கட்டுப்பாடு", "கருவி சுத்தம்", "வாராந்திர பார்வை"],
  },
  sugarcane_bacterial_blight: {
    problem: "கரும்பில் பாக்டீரியா ப்ளைட் தாக்கம் இருக்கலாம்",
    whatToDo: ["மிக பாதித்த இலைகளை அகற்றவும்", "தூவல் நீர்ப்பாசனம் தவிர்க்கவும்", "உள்ளூர் வேளாண்மை அலுவலரின் வழிகாட்டலின்படி மருந்து பயன்படுத்தவும்"],
    prevention: ["சுத்தமான நடவு பொருள்", "வெட்டுக் கருவி சுத்தம்", "வடிகால் பராமரிப்பு"],
  },
  sugarcane_red_rot: {
    problem: "கரும்பில் Red Rot கடுமையான நோய்",
    whatToDo: ["பாதித்த கொத்துகளை அகற்றி அழிக்கவும்", "பாதித்த வயலில் ratoon தவிர்க்கவும்", "நடவுக்கு முன் செட் சிகிச்சை செய்யவும்"],
    prevention: ["எதிர்ப்பு வகைகள்", "வயல் சுத்தம்", "சாத்தியமெனில் பயிர் மாறுதல்"],
  },
  sugarcane_healthy: {
    problem: "பயிர் ஆரோக்கியமாக உள்ளது",
    whatToDo: ["வழக்கமான வயல் கண்காணிப்பு", "நீர்ப்பாசனம் மற்றும் வடிகால் சமநிலை", "உர அட்டவணை தொடரவும்"],
    prevention: ["கருவி சுத்தம்", "தண்டு நிற மாற்றம் கண்காணிக்கவும்", "வயல் சுத்தம்"],
  },
  default: {
    problem: "இலை அழுத்தம் இருக்கலாம்",
    whatToDo: ["வடிகால் மற்றும் காற்றோட்டத்தை மேம்படுத்தவும்", "அதிக நீர்ப்பாசனம் தவிர்க்கவும்", "பரவல் இருந்தால் பொதுப் பூஞ்சைநாசினி பரிசீலிக்கவும்"],
    prevention: ["கருவிகளை சுத்தம் செய்யவும்", "சமநிலை உரம் பயன்படுத்தவும்", "தினமும் மாற்றம் கண்காணிக்கவும்"],
  },
};

const treatmentInputBook = {
  rice_leaf_blast: {
    fertilizer: ["Use split nitrogen only (avoid excess urea)", "Add potash (MOP) 20-25 kg/acre if soil test is low"],
    medicine: ["Tricyclazole 75% WP (as per label dose)", "Azoxystrobin + Tebuconazole mix (as per label dose)"]
  },
  rice_brown_spot: {
    fertilizer: ["Apply balanced NPK based on soil test", "Apply MOP 20-30 kg/acre where potash is low"],
    medicine: ["Mancozeb 75% WP (as per label dose)", "Carbendazim + Mancozeb mix (as per label dose)"]
  },
  rice_neck_blast: {
    fertilizer: ["Stop late heavy nitrogen top-dress", "Use balanced NPK with adequate potash"],
    medicine: ["Tricyclazole 75% WP at booting stage", "Isoprothiolane (as per label dose)"]
  },
  corn_gray_leaf_spot: {
    fertilizer: ["Maintain balanced N and K", "Avoid excess nitrogen in late stage"],
    medicine: ["Azoxystrobin based fungicide (label dose)", "Propiconazole based fungicide (label dose)"]
  },
  corn_common_rust: {
    fertilizer: ["Use balanced NPK; avoid nitrogen excess", "Maintain micronutrients where deficient"],
    medicine: ["Tebuconazole (label dose)", "Propiconazole (label dose)"]
  },
  corn_northern_leaf_blight: {
    fertilizer: ["Balanced NPK with good potash", "Avoid late nitrogen excess"],
    medicine: ["Mancozeb + systemic fungicide rotation", "Azoxystrobin + Difenoconazole mix"]
  },
  potato_early_blight: {
    fertilizer: ["Maintain potash-rich balanced nutrition", "Avoid only-urea feeding"],
    medicine: ["Mancozeb (label dose)", "Chlorothalonil / Azoxystrobin rotation"]
  },
  potato_late_blight: {
    fertilizer: ["Use balanced NPK; avoid excess nitrogen", "Ensure calcium and potash adequacy"],
    medicine: ["Metalaxyl + Mancozeb (label dose)", "Cymoxanil based fungicide rotation"]
  },
  wheat_brown_rust: {
    fertilizer: ["Avoid excess late nitrogen", "Maintain balanced NPK"],
    medicine: ["Propiconazole (label dose)", "Tebuconazole (label dose)"]
  },
  wheat_yellow_rust: {
    fertilizer: ["Balanced NPK; avoid heavy top-dress late", "Apply recommended sulfur if deficient"],
    medicine: ["Tebuconazole + Trifloxystrobin mix", "Propiconazole (label dose)"]
  },
  sugarcane_bacterial_blight: {
    fertilizer: ["Avoid excess nitrogen", "Use balanced NPK with micronutrients"],
    medicine: ["Copper oxychloride (label guidance)", "Streptocycline only as per local extension advice"]
  },
  sugarcane_red_rot: {
    fertilizer: ["Balanced basal nutrition; avoid heavy N excess", "Improve organic matter in soil"],
    medicine: ["Carbendazim sett treatment before planting", "Field drench/fungicide only as advised locally"]
  },
  default: {
    fertilizer: ["Use balanced NPK based on soil test", "Avoid excess nitrogen and over-irrigation"],
    medicine: ["Use crop-specific fungicide after local confirmation", "Follow label dose strictly and wear safety gear"]
  },
};

const treatmentInputTamilBook = {
  rice_leaf_blast: {
    fertilizer: ["யூரியா அதிகப்படுத்த வேண்டாம்; நைட்ரஜன் பிரித்து இடவும்", "மண் பரிசோதனை குறைவாக இருந்தால் MOP 20-25 கி/ஏக்கர்"],
    medicine: ["Tricyclazole 75% WP (லேபிள் அளவு)", "Azoxystrobin + Tebuconazole கலவை (லேபிள் அளவு)"]
  },
  rice_brown_spot: {
    fertilizer: ["மண் பரிசோதனைப்படி சமநிலை NPK இடவும்", "பொட்டாசியம் குறைவு இருந்தால் MOP 20-30 கி/ஏக்கர்"],
    medicine: ["Mancozeb 75% WP (லேபிள் அளவு)", "Carbendazim + Mancozeb கலவை (லேபிள் அளவு)"]
  },
  rice_neck_blast: {
    fertilizer: ["தாமதமாக அதிக நைட்ரஜன் இடாதீர்கள்", "சமநிலை NPK + பொட்டாசியம் பராமரிக்கவும்"],
    medicine: ["Tricyclazole 75% WP (booting நிலையில்)", "Isoprothiolane (லேபிள் அளவு)"]
  },
  corn_gray_leaf_spot: {
    fertilizer: ["N மற்றும் K சமநிலையாக வைத்திருங்கள்", "கடைசி நிலையில் நைட்ரஜன் அதிகப்படுத்த வேண்டாம்"],
    medicine: ["Azoxystrobin வகை பூஞ்சைநாசினி", "Propiconazole வகை பூஞ்சைநாசினி"]
  },
  corn_common_rust: {
    fertilizer: ["சமநிலை NPK பயன்படுத்தவும்", "சிறுதாது குறைவு இருந்தால் திருத்தவும்"],
    medicine: ["Tebuconazole (லேபிள் அளவு)", "Propiconazole (லேபிள் அளவு)"]
  },
  corn_northern_leaf_blight: {
    fertilizer: ["சமநிலை NPK + போதிய பொட்டாசியம்", "தாமத நைட்ரஜன் அதிகப்படுத்த வேண்டாம்"],
    medicine: ["Mancozeb + systemic rotation", "Azoxystrobin + Difenoconazole கலவை"]
  },
  potato_early_blight: {
    fertilizer: ["பொட்டாசியம் நிறைந்த சமநிலை ஊட்டம்", "யூரியா மட்டும் இடாமல் இருங்கள்"],
    medicine: ["Mancozeb (லேபிள் அளவு)", "Chlorothalonil / Azoxystrobin மாற்றி தெளிக்கவும்"]
  },
  potato_late_blight: {
    fertilizer: ["சமநிலை NPK; நைட்ரஜன் அதிகம் தவிர்க்கவும்", "கால்சியம்/பொட்டாசியம் போதுமான அளவில் வையுங்கள்"],
    medicine: ["Metalaxyl + Mancozeb (லேபிள் அளவு)", "Cymoxanil வகை மாற்றி தெளிக்கவும்"]
  },
  wheat_brown_rust: {
    fertilizer: ["தாமத நைட்ரஜன் அதிகப்படுத்த வேண்டாம்", "சமநிலை NPK பயன்படுத்தவும்"],
    medicine: ["Propiconazole (லேபிள் அளவு)", "Tebuconazole (லேபிள் அளவு)"]
  },
  wheat_yellow_rust: {
    fertilizer: ["சமநிலை NPK; தாமதமாக கனமாக உரம் இட வேண்டாம்", "சல்பர் குறைவு இருந்தால் சரிசெய்யவும்"],
    medicine: ["Tebuconazole + Trifloxystrobin கலவை", "Propiconazole (லேபிள் அளவு)"]
  },
  sugarcane_bacterial_blight: {
    fertilizer: ["நைட்ரஜன் அதிகப்படுத்த வேண்டாம்", "சமநிலை NPK + சிறுதாது ஊட்டம்"],
    medicine: ["Copper oxychloride (லேபிள் வழிகாட்டல்)", "Streptocycline உள்ளூர் ஆலோசனைப்படி மட்டும்"]
  },
  sugarcane_red_rot: {
    fertilizer: ["அடிப்படை உரம் சமநிலையாக இடவும்", "மண்ணில் கரிமப் பொருள் அதிகரிக்கவும்"],
    medicine: ["நடவுக்கு முன் Carbendazim sett treatment", "வயல் மருந்து உள்ளூர் ஆலோசனையுடன் மட்டும்"]
  },
  default: {
    fertilizer: ["மண் பரிசோதனைப்படி சமநிலை NPK பயன்படுத்தவும்", "அதிக நைட்ரஜன் மற்றும் அதிக நீர்ப்பாசனம் தவிர்க்கவும்"],
    medicine: ["பயிர்-சார்ந்த மருந்தை உள்ளூர் உறுதிப்பாட்டுடன் பயன்படுத்தவும்", "லேபிள் அளவை கண்டிப்பாக பின்பற்றவும்"]
  },
};

const diseaseNameBook = {
  rice_leaf_blast: { en: "Rice - Leaf Blast", ta: "நெல் - இலை வெடிப்பு (Leaf Blast)" },
  rice_brown_spot: { en: "Rice - Brown Spot", ta: "நெல் - பழுப்பு புள்ளி (Brown Spot)" },
  rice_neck_blast: { en: "Rice - Neck Blast", ta: "நெல் - கழுத்து வெடிப்பு (Neck Blast)" },
  rice_healthy: { en: "Rice - Healthy", ta: "நெல் - ஆரோக்கியம்" },
  wheat_brown_rust: { en: "Wheat - Brown Rust", ta: "கோதுமை - பழுப்பு துரு" },
  wheat_yellow_rust: { en: "Wheat - Yellow Rust", ta: "கோதுமை - மஞ்சள் துரு" },
  wheat_healthy: { en: "Wheat - Healthy", ta: "கோதுமை - ஆரோக்கியம்" },
  corn_common_rust: { en: "Corn - Common Rust", ta: "சோளம் - பொதுத் துரு" },
  corn_gray_leaf_spot: { en: "Corn - Gray Leaf Spot", ta: "சோளம் - சாம்பல் இலைப்புள்ளி" },
  corn_northern_leaf_blight: { en: "Corn - Northern Leaf Blight", ta: "சோளம் - வடக்கு இலை ப்ளைட்" },
  corn_healthy: { en: "Corn - Healthy", ta: "சோளம் - ஆரோக்கியம்" },
  potato_early_blight: { en: "Potato - Early Blight", ta: "உருளைக்கிழங்கு - தொடக்க ப்ளைட்" },
  potato_late_blight: { en: "Potato - Late Blight", ta: "உருளைக்கிழங்கு - தாமத ப்ளைட்" },
  potato_healthy: { en: "Potato - Healthy", ta: "உருளைக்கிழங்கு - ஆரோக்கியம்" },
  sugarcane_bacterial_blight: { en: "Sugarcane - Bacterial Blight", ta: "கரும்பு - பாக்டீரியா ப்ளைட்" },
  sugarcane_red_rot: { en: "Sugarcane - Red Rot", ta: "கரும்பு - Red Rot" },
  sugarcane_healthy: { en: "Sugarcane - Healthy", ta: "கரும்பு - ஆரோக்கியம்" },
  unknown: { en: "Field issue detected", ta: "பயிர் பிரச்சினை கண்டறியப்பட்டது" },
};

const diseaseKeywordHints = {
  rice_brown_spot: ["brown spot", "brown patch", "brown pigment", "பழுப்பு", "புள்ளி", "spot"],
  rice_leaf_blast: ["leaf blast", "blast", "diamond", "வெடிப்பு", "இலை வெடிப்பு"],
  rice_neck_blast: ["neck blast", "panicle", "கதிர்", "கழுத்து"],
};

const cropHintToKeyPrefix = {
  rice: "rice",
  paddy: "rice",
  corn: "corn",
  maize: "corn",
  potato: "potato",
  wheat: "wheat",
  sugarcane: "sugarcane",
  கரும்பு: "sugarcane",
  நெல்: "rice",
  அரிசி: "rice",
  சோளம்: "corn",
  உருளை: "potato",
  கோதுமை: "wheat",
};

const normalizeCropHintKey = (rawCropHint = "") => {
  const value = normalizeText(rawCropHint).toLowerCase();
  if (!value) return "";

  if (cropHintToKeyPrefix[value]) {
    return cropHintToKeyPrefix[value];
  }

  for (const [hint, normalized] of Object.entries(cropHintToKeyPrefix)) {
    if (value.includes(hint)) {
      return normalized;
    }
  }

  return "";
};

const normalizeDiseaseKey = (rawLabel) => {
  if (typeof rawLabel !== "string" || !rawLabel.trim()) {
    return "unknown";
  }

  const cleaned = rawLabel
    .trim()
    .toLowerCase()
    .replace(/__/g, "_")
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  const directMap = {
    rice_rice_brown_spot: "rice_brown_spot",
    rice_rice_leaf_blast: "rice_leaf_blast",
    rice_rice_neck_blast: "rice_neck_blast",
    rice_rice_healthy: "rice_healthy",
    wheat_wheat_brown_rust: "wheat_brown_rust",
    wheat_wheat_yellow_rust: "wheat_yellow_rust",
    wheat_wheat_healthy: "wheat_healthy",
    corn_corn_common_rust: "corn_common_rust",
    corn_corn_gray_leaf_spot: "corn_gray_leaf_spot",
    corn_corn_northern_leaf_blight: "corn_northern_leaf_blight",
    corn_corn_healthy: "corn_healthy",
    potato_potato_early_blight: "potato_early_blight",
    potato_potato_late_blight: "potato_late_blight",
    potato_potato_healthy: "potato_healthy",
    sugarcane_bacterial_blight: "sugarcane_bacterial_blight",
    sugarcane_red_rot: "sugarcane_red_rot",
    sugarcane_healthy: "sugarcane_healthy",
  };

  if (directMap[cleaned]) {
    return directMap[cleaned];
  }

  if (cleaned.includes("rice") && cleaned.includes("brown") && cleaned.includes("spot")) return "rice_brown_spot";
  if (cleaned.includes("rice") && cleaned.includes("leaf") && cleaned.includes("blast")) return "rice_leaf_blast";
  if (cleaned.includes("rice") && cleaned.includes("neck") && cleaned.includes("blast")) return "rice_neck_blast";
  if (cleaned.includes("rice") && cleaned.includes("healthy")) return "rice_healthy";

  return cleaned;
};

const pickRecommendation = (diseaseKey) => recommendationBook[diseaseKey] || recommendationBook.default;

const pickTamilRecommendation = (diseaseKey) => recommendationTamilBook[diseaseKey] || recommendationTamilBook.default;
const pickTreatmentInputs = (diseaseKey) => treatmentInputBook[diseaseKey] || treatmentInputBook.default;
const pickTamilTreatmentInputs = (diseaseKey) => treatmentInputTamilBook[diseaseKey] || treatmentInputTamilBook.default;

const getDiseaseDisplayName = (diseaseKey) => diseaseNameBook[diseaseKey] || diseaseNameBook.unknown;

const chooseLabelWithFarmerHint = ({ rawLabel, scores, note, cropHint }) => {
  const normalizedRawKey = normalizeDiseaseKey(rawLabel || "unknown");
  const cropHintKey = normalizeCropHintKey(cropHint);
  if (!Array.isArray(scores) || scores.length === 0) {
    return {
      diseaseKey: normalizedRawKey,
      confidence: 0,
      alternatives: [],
      adjustedByNote: false,
      adjustedByCropHint: false,
    };
  }

  const ranked = scores
    .map((score, index) => {
      const raw = diseaseLabels[index] || `class_${index}`;
      return {
        raw,
        key: normalizeDiseaseKey(raw),
        score: Number(score) || 0,
      };
    })
    .sort((a, b) => b.score - a.score);

  const best = ranked[0] || { key: normalizedRawKey, score: 0 };

  if (cropHintKey) {
    const cropCandidates = ranked.filter((item) => (item.key || "").startsWith(`${cropHintKey}_`));
    const bestCropCandidate = cropCandidates[0];
    if (bestCropCandidate) {
      return {
        diseaseKey: bestCropCandidate.key,
        confidence: Number(bestCropCandidate.score) || 0,
        alternatives: cropCandidates.slice(0, 3),
        adjustedByNote: false,
        adjustedByCropHint: bestCropCandidate.key !== best.key,
      };
    }
  }

  const noteText = normalizeText(note).toLowerCase();

  if (!noteText) {
    return {
      diseaseKey: best.key || normalizedRawKey,
      confidence: Number(best.score) || 0,
      alternatives: ranked.slice(0, 3),
      adjustedByNote: false,
      adjustedByCropHint: false,
    };
  }

  for (const [candidateKey, hints] of Object.entries(diseaseKeywordHints)) {
    const hasHint = hints.some((hint) => noteText.includes(hint.toLowerCase()));
    if (!hasHint) continue;

    const candidate = ranked.find((item) => item.key === candidateKey);
    if (!candidate) continue;

    const gap = (Number(best.score) || 0) - (Number(candidate.score) || 0);
    const sameCrop = (best.key || "").split("_")[0] === candidateKey.split("_")[0];

    const confidentAlternative = (Number(candidate.score) || 0) >= 0.12;
    const bestNotExtreme = (Number(best.score) || 0) < 0.9;

    if (sameCrop && (gap <= 0.22 || (confidentAlternative && bestNotExtreme))) {
      return {
        diseaseKey: candidate.key,
        confidence: Number(candidate.score) || 0,
        alternatives: ranked.slice(0, 3),
        adjustedByNote: candidate.key !== best.key,
        adjustedByCropHint: false,
      };
    }
  }

  return {
    diseaseKey: best.key || normalizedRawKey,
    confidence: Number(best.score) || 0,
    alternatives: ranked.slice(0, 3),
    adjustedByNote: false,
    adjustedByCropHint: false,
  };
};

const predictDisease = async (buffer) => {
  let result;
  try {
    result = await runPersistentPythonDiseaseInference(buffer);
  } catch (daemonError) {
    console.warn("Disease daemon inference failed, using fallback:", daemonError?.message || daemonError);
    result = await runPythonDiseaseInference(buffer);
  }

  if (!diseaseModelLogged) {
    console.log("🌿 Crop disease model loaded successfully");
    diseaseModelLogged = true;
  }

  return {
    label: result?.label || "unknown",
    confidence: Number(result?.confidence || 0),
    scores: Array.isArray(result?.scores) ? result.scores : [],
  };
};

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  const startTime = Date.now();
  res.on("finish", () => {
    const elapsed = Date.now() - startTime;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} ${elapsed}ms`);
  });
  next();
});

const initializeFirebaseAdmin = () => {
  if (admin.apps.length > 0) {
    return admin.firestore();
  }

  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      const options = {
        credential: admin.credential.cert(serviceAccount),
      };
      if (FIREBASE_DATABASE_URL) {
        options.databaseURL = FIREBASE_DATABASE_URL;
      }
      admin.initializeApp(options);
      return admin.firestore();
    }

    const serviceAccountPath =
      process.env.FIREBASE_SERVICE_ACCOUNT_PATH || path.join(__dirname, "serviceAccountKey.json");

    if (existsSync(serviceAccountPath)) {
      const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, "utf-8"));
      const options = {
        credential: admin.credential.cert(serviceAccount),
      };
      if (FIREBASE_DATABASE_URL) {
        options.databaseURL = FIREBASE_DATABASE_URL;
      }
      admin.initializeApp(options);
      return admin.firestore();
    }

    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      const options = {
        credential: admin.credential.applicationDefault(),
      };
      if (FIREBASE_DATABASE_URL) {
        options.databaseURL = FIREBASE_DATABASE_URL;
      }
      admin.initializeApp(options);
      return admin.firestore();
    }

    console.warn(
      "⚠ Firebase Admin credentials not found. /api/sensor-data will be unavailable until credentials are configured.",
    );
    return null;
  } catch (error) {
    console.error("❌ Firebase Admin initialization failed:", error);
    return null;
  }
};

const adminDb = initializeFirebaseAdmin();
const authGuard = createAuthMiddleware(admin);


app.get("/api/push/public-key", (req, res) => {
  if (!vapidKeys?.publicKey) {
    return res.status(503).json({ error: "Push is not configured." });
  }

  return res.status(200).json({ publicKey: vapidKeys.publicKey });
});

app.post("/api/push/subscribe", authGuard, (req, res) => {
  const { subscription } = req.body || {};

  if (!subscription?.endpoint) {
    return res.status(400).json({ error: "subscription is required" });
  }

  const record = addOrUpdateSubscription({ subscription, uid: req.user?.uid });
  if (!record) {
    return res.status(500).json({ error: "Unable to save subscription" });
  }

  return res.status(200).json({ ok: true, publicKey: vapidKeys.publicKey, endpoint: record.subscription.endpoint });
});

app.post("/api/push/notify", authGuard, async (req, res) => {
  const { title, message, url, tag, priority, source } = req.body || {};

  if (!title || !message) {
    return res.status(400).json({ error: "title and message are required" });
  }

  try {
    const payload = {
      title,
      message,
      url: url || "/",
      tag: tag || "agrosense",
      priority: priority || "medium",
      source: source || "general",
      timestamp: Date.now(),
    };

    const result = await sendPushToAll(payload, req.user?.uid);
    return res.status(200).json({ ...result, payload });
  } catch (error) {
    console.error("Push notify error:", error);
    return res.status(500).json({ error: "Failed to send push notification" });
  }
});

app.post("/api/crop-diagnosis", authGuard, upload.single("image"), async (req, res) => {
  if (!req.file?.buffer) {
    return res.status(400).json({ error: "image is required" });
  }

  if (!req.file.mimetype?.startsWith("image/")) {
    return res.status(400).json({ error: "Only image files are supported." });
  }

  try {
    const { label, confidence, scores } = await predictDisease(req.file.buffer);
    const note = req.body?.note || "";
    const cropHint = req.body?.cropType || "";
    const calibrated = chooseLabelWithFarmerHint({ rawLabel: label, scores, note, cropHint });
    const diseaseKey = calibrated.diseaseKey;
    const displayName = getDiseaseDisplayName(diseaseKey);
    const recommendation = pickRecommendation(diseaseKey);
    const recommendationTa = pickTamilRecommendation(diseaseKey);
    const treatmentInputs = pickTreatmentInputs(diseaseKey);
    const treatmentInputsTa = pickTamilTreatmentInputs(diseaseKey);
    const confidenceValue = Number.isFinite(calibrated.confidence) && calibrated.confidence > 0
      ? calibrated.confidence
      : confidence;

    const response = {
      disease: displayName.en,
      diseaseTa: displayName.ta,
      diseaseKey,
      rawModelLabel: label,
      confidence: confidenceValue,
      confidenceText:
        confidenceValue >= 0.75
          ? { en: "High confidence", ta: "உயர் நம்பிக்கை" }
          : confidenceValue >= 0.55
            ? { en: "Medium confidence", ta: "இடைநிலை நம்பிக்கை" }
            : { en: "Low confidence", ta: "குறைந்த நம்பிக்கை" },
      recommendation: {
        ...recommendation,
        fertilizer: treatmentInputs.fertilizer,
        medicine: treatmentInputs.medicine,
      },
      recommendationTa: {
        ...recommendationTa,
        fertilizer: treatmentInputsTa.fertilizer,
        medicine: treatmentInputsTa.medicine,
      },
      note,
      cropHint,
      adjustedByFarmerNote: calibrated.adjustedByNote,
      adjustedByCropHint: calibrated.adjustedByCropHint,
      alternatives: calibrated.alternatives.map((item) => ({
        diseaseKey: item.key,
        disease: getDiseaseDisplayName(item.key).en,
        diseaseTa: getDiseaseDisplayName(item.key).ta,
        confidence: Number(item.score) || 0,
      })),
    };

    return res.status(200).json(response);
  } catch (error) {
    console.error("Diagnosis error:", error?.message || error);
    return res.status(503).json({ error: error?.message || "Model unavailable" });
  }
});

const DATASET_DIR = path.resolve(__dirname, "..", "Data Set");
const serverBootAt = new Date().toISOString();

const cropEffectMap = {
  Rice: { n: 18, p: 12, k: 10 },
  Wheat: { n: 14, p: 10, k: 9 },
  Maize: { n: 16, p: 9, k: 11 },
  Cotton: { n: 12, p: 8, k: 14 },
  Groundnut: { n: 9, p: 11, k: 8 },
  Banana: { n: 13, p: 9, k: 16 },
  Sugarcane: { n: 17, p: 9, k: 15 },
  Vegetables: { n: 11, p: 10, k: 10 },
};

const defaultCropList = Object.keys(cropEffectMap);
const cropList = [...defaultCropList];

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const isFiniteNumber = (value) => Number.isFinite(Number(value));
const nowMs = () => Date.now();

const parseCsvLine = (line = "") => {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (character === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
      continue;
    }

    current += character;
  }

  values.push(current.trim());
  return values;
};

const parseCsv = (filePath) => {
  const raw = readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);

  if (lines.length < 2) {
    return [];
  }

  const headers = parseCsvLine(lines[0]);
  const rows = [];

  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const values = parseCsvLine(lines[lineIndex]);
    if (values.length === 0) {
      continue;
    }

    const row = {};
    for (let valueIndex = 0; valueIndex < headers.length; valueIndex += 1) {
      row[headers[valueIndex]] = values[valueIndex] ?? "";
    }
    rows.push(row);
  }

  return rows;
};

const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const pickNumeric = (row, keys) => {
  for (const key of keys) {
    if (!(key in row)) {
      continue;
    }

    const value = toNumber(row[key]);
    if (value !== null) {
      return value;
    }
  }

  return null;
};

const normalizeCropName = (value) => {
  if (typeof value !== "string") {
    return "";
  }

  const cleaned = value.trim().replace(/[_-]+/g, " ");
  if (!cleaned) {
    return "";
  }

  return cleaned
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
};

const registerCropName = (cropType) => {
  const normalized = normalizeCropName(cropType);
  if (!normalized) {
    return 0;
  }

  const existingIndex = cropList.findIndex((item) => item.toLowerCase() === normalized.toLowerCase());
  if (existingIndex >= 0) {
    return existingIndex;
  }

  cropList.push(normalized);
  return cropList.length - 1;
};

const getCropTypeFromRow = (row = {}) => {
  const candidates = [row.Crop_Type, row.label, row.Crop1, row.Crop2, row.Crop3, row.Plant_ID]
    .map((value) => (typeof value === "string" ? value.trim() : String(value ?? "").trim()))
    .filter(Boolean);

  return candidates[0] || "Rice";
};

const getFertilizerFlagFromRow = (row = {}) => {
  const numericLastSeason = toNumber(row.Fertilizer_Used_Last_Season);
  if (numericLastSeason !== null) {
    return numericLastSeason > 0;
  }

  if (typeof row.Recommended_Fertilizer === "string" && row.Recommended_Fertilizer.trim()) {
    return true;
  }

  return false;
};

const randomBetween = (min, max) => min + Math.random() * (max - min);

const buildSyntheticTrainingData = (size = syntheticTrainingSize) => {
  const features = [];
  const targetN = [];
  const targetP = [];
  const targetK = [];

  for (let index = 0; index < size; index += 1) {
    const moisture = randomBetween(10, 60);
    const temperature = randomBetween(20, 40);
    const humidity = randomBetween(40, 90);
    const rainfall = randomBetween(0, 20);
    const fertilizerUsed = Math.random() > 0.45 ? 1 : 0;
    const cropCode = Math.floor(Math.random() * cropList.length);
    const cropName = cropList[cropCode];
    const cropEffect = cropEffectMap[cropName] || { n: 12, p: 9, k: 11 };

    const tempStress = Math.pow(temperature - 30, 2);

    const nitrogen = clamp(
      18 +
        0.8 * moisture +
        0.5 * rainfall +
        0.2 * humidity +
        cropEffect.n +
        fertilizerUsed * 12 -
        0.15 * tempStress +
        randomBetween(-5, 5),
      18,
      120,
    );

    const phosphorus = clamp(
      5 +
        0.45 * moisture +
        0.15 * rainfall +
        cropEffect.p +
        fertilizerUsed * 7 -
        0.08 * tempStress +
        randomBetween(-3, 3),
      5,
      60,
    );

    const potassium = clamp(
      40 +
        0.62 * humidity +
        0.32 * rainfall +
        cropEffect.k +
        fertilizerUsed * 9 -
        0.05 * tempStress +
        randomBetween(-5, 5),
      40,
      200,
    );

    features.push([moisture, temperature, humidity, rainfall, cropCode, fertilizerUsed]);
    targetN.push(nitrogen);
    targetP.push(phosphorus);
    targetK.push(potassium);
  }

  return { features, targetN, targetP, targetK };
};

const buildTrainingDataFromDatasets = () => {
  const features = [];
  const targetN = [];
  const targetP = [];
  const targetK = [];

  const datasetPaths = [
    path.join(DATASET_DIR, "soil_with_crop_recommendations.csv"),
    path.join(DATASET_DIR, "fertilizer_recommendation.csv"),
  ];

  for (const datasetPath of datasetPaths) {
    if (!existsSync(datasetPath)) {
      continue;
    }

    const rows = parseCsv(datasetPath);
    for (const row of rows) {
      const moisture = pickNumeric(row, ["Soil_Moisture", "soil_moisture"]);
      const temperature = pickNumeric(row, ["Ambient_Temperature", "Temperature", "temperature"]);
      const humidity = pickNumeric(row, ["Humidity", "humidity"]);
      const rainfall = pickNumeric(row, ["rainfall", "Rainfall"]);
      const nitrogen = pickNumeric(row, ["Nitrogen_Level", "N"]);
      const phosphorus = pickNumeric(row, ["Phosphorus_Level", "P"]);
      const potassium = pickNumeric(row, ["Potassium_Level", "K"]);

      if (
        moisture === null ||
        temperature === null ||
        humidity === null ||
        rainfall === null ||
        nitrogen === null ||
        phosphorus === null ||
        potassium === null
      ) {
        continue;
      }

      const cropType = getCropTypeFromRow(row);
      const fertilizerUsed = getFertilizerFlagFromRow(row);

      features.push([moisture, temperature, humidity, rainfall, registerCropName(cropType), fertilizerUsed ? 1 : 0]);
      targetN.push(nitrogen);
      targetP.push(phosphorus);
      targetK.push(potassium);

      if (features.length >= datasetSampleLimit) {
        break;
      }
    }

    if (features.length >= datasetSampleLimit) {
      break;
    }
  }

  return { features, targetN, targetP, targetK };
};

const toCropCode = (cropType) => {
  return registerCropName(cropType);
};

const rfOptions = {
  seed: 42,
  maxFeatures: 0.8,
  replacement: true,
  nEstimators: 45,
};

const serializeModels = (models) => ({
  nitrogenModel: models.nitrogenModel.toJSON(),
  phosphorusModel: models.phosphorusModel.toJSON(),
  potassiumModel: models.potassiumModel.toJSON(),
});

const loadModelBundleFromDisk = () => {
  if (!existsSync(MODEL_FILE_PATH)) {
    return null;
  }

  try {
    const payload = JSON.parse(readFileSync(MODEL_FILE_PATH, "utf-8"));
    if (!payload?.models?.nitrogenModel || !payload?.models?.phosphorusModel || !payload?.models?.potassiumModel) {
      return null;
    }

    if (Array.isArray(payload.cropList) && payload.cropList.length > 0) {
      cropList.splice(0, cropList.length, ...payload.cropList);
    }

    return {
      nitrogenModel: RFRegression.load(payload.models.nitrogenModel),
      phosphorusModel: RFRegression.load(payload.models.phosphorusModel),
      potassiumModel: RFRegression.load(payload.models.potassiumModel),
      metadata: {
        source: payload.source || "persisted",
        sampleCount: Number(payload.sampleCount) || 0,
        trainedAt: payload.trainedAt || null,
        modelPath: MODEL_FILE_PATH,
      },
    };
  } catch (error) {
    console.error("Failed to load persisted model bundle:", error);
    return null;
  }
};

const trainAndPersistModelBundle = (options = {}) => {
  const { forceSynthetic = false, syntheticSize = syntheticTrainingSize } = options;
  const datasetTrainingData = buildTrainingDataFromDatasets();
  const hasDatasetTrainingData = datasetTrainingData.features.length >= 120;
  const trainingData = !forceSynthetic && hasDatasetTrainingData ? datasetTrainingData : buildSyntheticTrainingData(syntheticSize);

  const nitrogenModel = new RFRegression(rfOptions);
  const phosphorusModel = new RFRegression(rfOptions);
  const potassiumModel = new RFRegression(rfOptions);

  nitrogenModel.train(trainingData.features, trainingData.targetN);
  phosphorusModel.train(trainingData.features, trainingData.targetP);
  potassiumModel.train(trainingData.features, trainingData.targetK);

  const metadata = {
    source: hasDatasetTrainingData ? "csv-datasets" : "synthetic-fallback",
    sampleCount: trainingData.features.length,
    trainedAt: new Date().toISOString(),
    modelPath: MODEL_FILE_PATH,
  };

  mkdirSync(MODEL_DIR, { recursive: true });
  writeFileSync(
    MODEL_FILE_PATH,
    JSON.stringify(
      {
        version: "1.0.0",
        cropList,
        ...metadata,
        models: serializeModels({ nitrogenModel, phosphorusModel, potassiumModel }),
      },
      null,
      2,
    ),
    "utf-8",
  );

  console.log(`🌱 NPK model trained and persisted (${metadata.source}, ${metadata.sampleCount} samples).`);
  return { nitrogenModel, phosphorusModel, potassiumModel, metadata };
};

let nitrogenModel = null;
let phosphorusModel = null;
let potassiumModel = null;
let modelWarmupInProgress = false;

const modelMetadata = {
  source: "bootstrap-fallback",
  sampleCount: 0,
  trainedAt: null,
  modelPath: MODEL_FILE_PATH,
};

const setModelBundle = (bundle, sourceOverride = null) => {
  nitrogenModel = bundle.nitrogenModel;
  phosphorusModel = bundle.phosphorusModel;
  potassiumModel = bundle.potassiumModel;
  modelMetadata.source = sourceOverride || bundle?.metadata?.source || modelMetadata.source;
  modelMetadata.sampleCount = bundle?.metadata?.sampleCount || 0;
  modelMetadata.trainedAt = bundle?.metadata?.trainedAt || null;
};

const ensureNpkModelWarmup = () => {
  if (nitrogenModel && phosphorusModel && potassiumModel) {
    return;
  }

  if (modelWarmupInProgress) {
    return;
  }

  modelWarmupInProgress = true;

  setTimeout(() => {
    try {
      const loaded = loadModelBundleFromDisk();
      if (loaded) {
        setModelBundle(loaded, "persisted");
        console.log(`🌱 NPK model loaded from disk (${modelMetadata.sampleCount} samples).`);
        modelWarmupInProgress = false;
        return;
      }

      const trained = trainAndPersistModelBundle({ forceSynthetic: false });
      setModelBundle(trained, trained?.metadata?.source);
      console.log(`🌱 NPK model warmup completed (${modelMetadata.source}, ${modelMetadata.sampleCount} samples).`);
    } catch (error) {
      console.error("NPK model warmup failed, using heuristic fallback:", error);
      modelMetadata.source = "heuristic-fallback";
    } finally {
      modelWarmupInProgress = false;
    }
  }, 0);
};

ensureNpkModelWarmup();

const npkHistoryCache = [];

const getStatus = (value, type) => {
  if (type === "N") {
    if (value < 30) return "Deficient";
    if (value < 50) return "Moderate";
    if (value < 85) return "Optimal";
    return "Excess";
  }

  if (type === "P") {
    if (value < 15) return "Deficient";
    if (value < 25) return "Moderate";
    if (value < 45) return "Optimal";
    return "Excess";
  }

  if (value < 70) return "Deficient";
  if (value < 100) return "Moderate";
  if (value < 150) return "Optimal";
  return "Excess";
};

const heuristicPredictNpk = ({ moisture, temperature, humidity, rainfall, fertilizerUsed }) => {
  const tempStress = Math.pow(Number(temperature) - 30, 2);
  const fertilizerBoost = fertilizerUsed ? 9 : 0;

  const nitrogen = clamp(
    Number((20 + 0.75 * Number(moisture) + 0.25 * Number(humidity) + 0.4 * Number(rainfall) + fertilizerBoost - 0.12 * tempStress).toFixed(2)),
    18,
    120,
  );
  const phosphorus = clamp(
    Number((8 + 0.42 * Number(moisture) + 0.14 * Number(rainfall) + fertilizerBoost * 0.55 - 0.07 * tempStress).toFixed(2)),
    5,
    60,
  );
  const potassium = clamp(
    Number((45 + 0.52 * Number(humidity) + 0.2 * Number(rainfall) + fertilizerBoost * 0.7 - 0.05 * tempStress).toFixed(2)),
    40,
    200,
  );

  return {
    values: {
      N: nitrogen,
      P: phosphorus,
      K: potassium,
    },
    status: {
      N: getStatus(nitrogen, "N"),
      P: getStatus(phosphorus, "P"),
      K: getStatus(potassium, "K"),
    },
  };
};

const predictNpk = ({ moisture, temperature, humidity, rainfall, cropType, fertilizerUsed }) => {
  if (!nitrogenModel || !phosphorusModel || !potassiumModel) {
    return heuristicPredictNpk({ moisture, temperature, humidity, rainfall, fertilizerUsed });
  }

  const input = [
    Number(moisture),
    Number(temperature),
    Number(humidity),
    Number(rainfall),
    toCropCode(cropType),
    fertilizerUsed ? 1 : 0,
  ];

  const nitrogen = clamp(Number(nitrogenModel.predict([input])[0].toFixed(2)), 18, 120);
  const phosphorus = clamp(Number(phosphorusModel.predict([input])[0].toFixed(2)), 5, 60);
  const potassium = clamp(Number(potassiumModel.predict([input])[0].toFixed(2)), 40, 200);

  return {
    values: {
      N: nitrogen,
      P: phosphorus,
      K: potassium,
    },
    status: {
      N: getStatus(nitrogen, "N"),
      P: getStatus(phosphorus, "P"),
      K: getStatus(potassium, "K"),
    },
  };
};

const normalizeSensorInput = async ({ payload = {}, simulationData = null, mode = "live" } = {}) => {
  const sourceData = simulationData && typeof simulationData === "object" ? simulationData : payload;

  let moisture = Number(sourceData.moisture);
  let temperature = Number(sourceData.temperature);
  let humidity = Number(sourceData.humidity);
  let rainfall = Number(sourceData.rainfall);

  const shouldUseLiveSensor = mode !== "simulation";
  const realtimeSensor = shouldUseLiveSensor ? await fetchRealtimeSensorData() : null;

  if (shouldUseLiveSensor && (!Number.isFinite(moisture) || !Number.isFinite(temperature)) && adminDb) {
    const latestSensorSnapshot = await adminDb
      .collection("sensorData")
      .orderBy("timestamp", "desc")
      .limit(1)
      .get();

    const latestDoc = latestSensorSnapshot.docs[0]?.data();
    if (latestDoc) {
      moisture = Number.isFinite(moisture) ? moisture : Number(latestDoc.moisture);
      temperature = Number.isFinite(temperature) ? temperature : Number(latestDoc.temperature);
    }
  }

  if (!Number.isFinite(moisture) && Number.isFinite(realtimeSensor?.moisture)) {
    moisture = realtimeSensor.moisture;
  }

  if (!Number.isFinite(temperature) && Number.isFinite(realtimeSensor?.temperature)) {
    temperature = realtimeSensor.temperature;
  }

  if (!Number.isFinite(humidity) && Number.isFinite(realtimeSensor?.humidity)) {
    humidity = realtimeSensor.humidity;
  }

  if (!Number.isFinite(rainfall) && Number.isFinite(realtimeSensor?.rainfall)) {
    rainfall = realtimeSensor.rainfall;
  }

  return {
    moisture: Number.isFinite(moisture) ? moisture : 35,
    temperature: Number.isFinite(temperature) ? temperature : 29,
    humidity: Number.isFinite(humidity) ? humidity : 68,
    rainfall: Number.isFinite(rainfall) ? rainfall : 0,
    cropType: typeof sourceData.cropType === "string" && sourceData.cropType.trim() ? sourceData.cropType.trim() : "Rice",
    soilType: typeof sourceData.soilType === "string" && sourceData.soilType.trim() ? sourceData.soilType.trim() : "Loamy",
    fertilizerUsed: Boolean(sourceData.fertilizerUsed),
  };
};

function normalizeFarmId(farmId) {
  if (typeof farmId !== "string") {
    return "defaultFarm";
  }

  const sanitized = farmId.trim().replace(/[^a-zA-Z0-9_-]/g, "");
  return sanitized || "defaultFarm";
}
const allowDefaultFarmFallback = (() => {
  const raw = String(process.env.ALLOW_DEFAULT_FARM ?? "true").trim().toLowerCase();
  return !(raw === "false" || raw === "0" || raw === "no");
})();
const fallbackFarmId = normalizeFarmId(process.env.DEFAULT_FARM_ID || "demoFarm");
const datasetSampleLimit = clamp(Number(process.env.NPK_DATASET_SAMPLE_LIMIT || 900), 200, 2000);
const syntheticTrainingSize = clamp(Number(process.env.NPK_SYNTHETIC_TRAINING_SIZE || 220), 120, 1500);

const convertAnalogMoistureToPercent = (value) => {
  const analog = Number(value);
  if (!Number.isFinite(analog)) {
    return null;
  }
  const percent = (1 - analog / 4095) * 100;
  if (!Number.isFinite(percent)) {
    return null;
  }
  return clamp(Math.round(percent), 0, 100);
};

const pickLatestSensorPayload = (data) => {
  if (!data || typeof data !== "object") {
    return null;
  }

  if (Array.isArray(data)) {
    return data[data.length - 1] || null;
  }

  if ("soil_moisture" in data || "soilMoisture" in data || "temperature" in data) {
    return data;
  }

  const keys = Object.keys(data);
  if (keys.length === 0) {
    return null;
  }

  keys.sort();
  const latestKey = keys[keys.length - 1];
  return data[latestKey] || null;
};

const fetchRealtimeSensorData = async () => {
  if (!admin.apps.length) {
    return null;
  }

  try {
    const database = typeof admin.database === "function" ? admin.database() : null;
    if (!database) {
      return null;
    }

    const snapshot = await database.ref(SENSOR_DATA_PATH || "sensor").get();
    if (!snapshot?.exists()) {
      return null;
    }

    const payload = pickLatestSensorPayload(snapshot.val());
    if (!payload) {
      return null;
    }

    const analogMoisture = payload.soil_moisture ?? payload.soilMoisture ?? payload.moisture_raw ?? payload.moistureRaw;
    const normalizedMoisture = Number.isFinite(Number(payload.moisture))
      ? Number(payload.moisture)
      : convertAnalogMoistureToPercent(analogMoisture);

    return {
      moisture: Number.isFinite(normalizedMoisture) ? normalizedMoisture : null,
      temperature: Number.isFinite(Number(payload.temperature)) ? Number(payload.temperature) : null,
      humidity: Number.isFinite(Number(payload.humidity)) ? Number(payload.humidity) : null,
      rainfall: Number.isFinite(Number(payload.rainfall)) ? Number(payload.rainfall) : null,
    };
  } catch (error) {
    console.warn("Realtime sensor fetch failed:", error?.message || error);
    return null;
  }
};

const resolveFarmIdForUid = async (uid) => {
  if (!adminDb) {
    if (allowDefaultFarmFallback) {
      console.warn("Firebase unavailable. Using fallback farm mapping.");
      return fallbackFarmId;
    }
    throw new Error("FIREBASE_UNAVAILABLE");
  }

  if (!uid) {
    return allowDefaultFarmFallback ? fallbackFarmId : null;
  }

  try {
    const userDoc = await adminDb.collection("users").doc(uid).get();
    if (!userDoc.exists) {
      if (allowDefaultFarmFallback) {
        console.warn(`User profile not found for uid ${uid}. Falling back to ${fallbackFarmId}.`);
        return fallbackFarmId;
      }
      console.warn(`Access denied: user profile not found for uid ${uid}.`);
      return null;
    }

    const userData = userDoc.data() || {};
    const mappedFarmId = normalizeFarmId(userData.farmId || userData.farmID || userData.farm_id || "");
    if (!mappedFarmId || mappedFarmId === "defaultFarm") {
      if (allowDefaultFarmFallback) {
        console.warn(`Farm ID missing for uid ${uid}. Using fallback ${fallbackFarmId}.`);
        return fallbackFarmId;
      }
      console.warn(`Access denied: farmId missing for uid ${uid}.`);
      return null;
    }

    return mappedFarmId;
  } catch (error) {
    console.error("Farm resolution error:", error?.message || error);
    if (allowDefaultFarmFallback) {
      return fallbackFarmId;
    }
    throw error;
  }
};

const buildPredictionRecord = ({ normalizedInput, prediction, farmId, location }) => ({
  farmId,
  location,
  cropType: normalizedInput.cropType,
  moisture: normalizedInput.moisture,
  temperature: normalizedInput.temperature,
  humidity: normalizedInput.humidity,
  rainfall: normalizedInput.rainfall,
  soilType: normalizedInput.soilType,
  fertilizerUsed: Boolean(normalizedInput.fertilizerUsed),
  predictedN: prediction.values.N,
  predictedP: prediction.values.P,
  predictedK: prediction.values.K,
  generatedAt: new Date().toISOString(),
  createdAtEpoch: Date.now(),
});

const getRecentPredictionRecords = async (farmId, limitValue = 6) => {
  const safeLimit = clamp(Number(limitValue), 1, 30);
  if (adminDb) {
    const snapshot = await adminDb
      .collection("farms")
      .doc(farmId)
      .collection("predictions")
      .orderBy("createdAtEpoch", "desc")
      .limit(safeLimit)
      .get();

    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }

  return npkHistoryCache.filter((entry) => entry.farmId === farmId).slice(0, safeLimit);
};

const getFarmPredictionRecords = async (farmId, limitValue = 120) => {
  const safeLimit = clamp(Number(limitValue), 1, 400);
  if (adminDb) {
    const snapshot = await adminDb
      .collection("farms")
      .doc(farmId)
      .collection("predictions")
      .orderBy("createdAtEpoch", "desc")
      .limit(safeLimit)
      .get();

    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }

  return npkHistoryCache.filter((entry) => entry.farmId === farmId).slice(0, safeLimit);
};

const getFarmAlerts = async (farmId, limitValue = 60) => {
  const safeLimit = clamp(Number(limitValue), 1, 120);

  if (adminDb) {
    const snapshot = await adminDb
      .collection("farms")
      .doc(farmId)
      .collection("alerts")
      .orderBy("createdAtEpoch", "desc")
      .limit(safeLimit)
      .get();

    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }

  return [];
};

const saveFarmAlerts = async ({ farmId, alerts }) => {
  const items = Array.isArray(alerts) ? alerts : [];
  if (!adminDb || items.length === 0) return;

  const now = Date.now();
  const batch = adminDb.batch();

  items.forEach((item, index) => {
    const docId = `${now}-${index}-${String(item?.type || "general")}`;
    const ref = adminDb.collection("farms").doc(farmId).collection("alerts").doc(docId);
    batch.set(ref, {
      ...item,
      farmId,
      createdAtEpoch: Number(item?.createdAtEpoch || now),
      createdAt: item?.createdAt || new Date().toISOString(),
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  await batch.commit();
};

const buildResponsePayload = ({ normalizedInput, prediction, trendAnalysis, advisory, farmId, location, generatedAt }) => ({
  farmId,
  location,
  generatedAt,
  inputs: normalizedInput,
  prediction,
  N: prediction.values.N,
  P: prediction.values.P,
  K: prediction.values.K,
  soilHealthScore: advisory.soilHealthScore,
  trendAnalysis,
  irrigationAdvice: advisory.irrigationAdvice,
  fertilizerAdvice: advisory.fertilizerAdvice,
  insightMessage: advisory.insightMessage,
  deficiency: advisory.deficiency,
  soilHealthCategory: advisory.soilHealthCategory,
  weatherContext: advisory.weatherContext,
  cropRecommendation: advisory.cropRecommendation,
  fertilizerPlan: advisory.fertilizerPlan,
  forecast: advisory.forecast,
  sustainability: advisory.sustainability,
  weatherAlert: advisory.weatherAlert,
  weatherRisk: advisory.weatherRisk,
});

const persistFarmAnalytics = async ({ farmId, records }) => {
  const analyticsSummary = buildFarmAnalytics({ historyRecords: records });
  const sustainability = computeSustainability({ historyRecords: records.slice(0, 30) });

  if (adminDb) {
    await adminDb
      .collection("farms")
      .doc(farmId)
      .collection("analytics")
      .doc("summary")
      .set(
        {
          ...analyticsSummary,
          sustainability,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  }

  return {
    ...analyticsSummary,
    sustainability,
  };
};

const saveNpkPrediction = async ({ farmId, record, responsePayload }) => {
  const cacheEntry = {
    ...record,
    prediction: responsePayload.prediction,
    inputs: responsePayload.inputs,
    response: responsePayload,
  };

  npkHistoryCache.unshift(cacheEntry);
  if (npkHistoryCache.length > 50) {
    npkHistoryCache.length = 50;
  }

  if (!adminDb) {
    return;
  }

  const predictionDocId = String(record.createdAtEpoch);

  await adminDb
    .collection("farms")
    .doc(farmId)
    .collection("predictions")
    .doc(predictionDocId)
    .set({
      ...record,
      irrigationAdvice: responsePayload.irrigationAdvice,
      fertilizerAdvice: responsePayload.fertilizerAdvice,
      insightMessage: responsePayload.insightMessage,
      trendAnalysis: responsePayload.trendAnalysis,
      forecast: responsePayload.forecast,
      soilHealthScore: responsePayload.soilHealthScore,
      soilHealthCategory: responsePayload.soilHealthCategory,
      deficiency: responsePayload.deficiency,
      weatherContext: responsePayload.weatherContext,
      weatherAlert: responsePayload.weatherAlert,
      weatherRisk: responsePayload.weatherRisk,
      cropRecommendation: responsePayload.cropRecommendation,
      fertilizerPlan: responsePayload.fertilizerPlan,
      sustainability: responsePayload.sustainability,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

  await adminDb.collection("npkPredictions").add({
    ...responsePayload,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });
};

const generatePredictionResponse = async ({ payload = {}, farmId, location: requestedLocation, persist = true }) => {
  await ensureCropService();

  const predictionTraceId = `npk-${nowMs()}-${Math.floor(Math.random() * 1000)}`;
  const timing = {
    startMs: nowMs(),
  };
  console.time(`${predictionTraceId}:total prediction time`);

  const location = typeof requestedLocation === "string" && requestedLocation.trim() ? requestedLocation.trim() : "Field";
  const requestedMode = payload?.mode === "simulation" ? "simulation" : "live";
  const simulationData = payload?.simulationData && typeof payload.simulationData === "object" ? payload.simulationData : null;

  console.time(`${predictionTraceId}:weather fetch`);
  const weatherContext = await getWeatherContext({
    location,
    lat: payload?.lat,
    lon: payload?.lon,
  });
  console.timeEnd(`${predictionTraceId}:weather fetch`);

  const normalizedInput = await normalizeSensorInput({
    payload,
    simulationData,
    mode: requestedMode,
  });
  const mergedInput = {
    ...normalizedInput,
    humidity: isFiniteNumber(payload?.humidity)
      ? normalizedInput.humidity
      : isFiniteNumber(weatherContext?.humidity)
        ? Number(weatherContext.humidity)
        : normalizedInput.humidity,
    rainfall: isFiniteNumber(payload?.rainfall)
      ? normalizedInput.rainfall
      : isFiniteNumber(weatherContext?.rainfallNext24h)
        ? Number(weatherContext.rainfallNext24h)
        : normalizedInput.rainfall,
    temperature:
      isFiniteNumber(payload?.temperature) || !isFiniteNumber(weatherContext?.temperature)
        ? normalizedInput.temperature
        : Number(weatherContext.temperature),
  };

  const prediction = predictNpk(mergedInput);

  const currentRecord = buildPredictionRecord({
    normalizedInput: mergedInput,
    prediction,
    farmId,
    location,
  });

  const previousRecords = await getRecentPredictionRecords(farmId, 7);

  console.time(`${predictionTraceId}:forecastService`);
  const trendAnalysis = analyzeTrend([...previousRecords, currentRecord]);
  const forecast = buildForecast({
    historyRecords: [...previousRecords, currentRecord],
    trendAnalysis,
  });
  console.timeEnd(`${predictionTraceId}:forecastService`);

  console.time(`${predictionTraceId}:advisoryService`);
  const advisoryBase = buildAdvisory({
    predictionValues: prediction.values,
    inputs: mergedInput,
    trendAnalysis,
    weatherContext,
    soilHealth: null,
  });

  const soilHealth = computeSoilHealth({
    deficiency: advisoryBase.deficiency,
    trendAnalysis,
  });

  const advisory = buildAdvisory({
    predictionValues: prediction.values,
    inputs: mergedInput,
    trendAnalysis,
    weatherContext,
    soilHealth,
  });

  const cropRecommendation = recommendCrops({
    N: prediction.values.N,
    P: prediction.values.P,
    K: prediction.values.K,
    rainfall: mergedInput.rainfall,
    temperature: mergedInput.temperature,
    humidity: mergedInput.humidity,
  });

  const advisoryWithHealth = {
    ...advisory,
    soilHealthScore: soilHealth.score,
    soilHealthCategory: soilHealth.category,
    weatherContext,
    cropRecommendation,
    weatherAlert: advisory.weatherAlert,
  };

  const sustainability = computeSustainability({
    historyRecords: [...previousRecords, currentRecord],
  });
  console.timeEnd(`${predictionTraceId}:advisoryService`);

  const responsePayload = buildResponsePayload({
    normalizedInput: mergedInput,
    prediction,
    trendAnalysis,
    advisory: advisoryWithHealth,
    farmId,
    location,
    generatedAt: currentRecord.generatedAt,
  });

  responsePayload.soilHealthComponents = soilHealth.components;
  responsePayload.forecast = forecast;
  responsePayload.forecastRisk = forecast.forecastRisk;
  responsePayload.sustainability = sustainability;
  responsePayload.weatherAlert = advisory.weatherAlert;
  responsePayload.weatherRisk = advisory.weatherRisk;
  responsePayload.mode = requestedMode;

  const generatedAlerts = sortAlertsByPriority(
    generateFarmAlerts({
      moisture: mergedInput.moisture,
      trendAnalysis,
      soilHealthScore: responsePayload.soilHealthScore,
      forecastRisk: responsePayload.forecastRisk,
      weatherContext,
      weatherAlert: responsePayload.weatherAlert,
      weatherRisk: responsePayload.weatherRisk,
      deficiency: responsePayload.deficiency,
      fertilizerPlan: responsePayload.fertilizerPlan,
      npkStatus: prediction.status,
      npkValues: prediction.values,
    }),
  );
  responsePayload.alerts = generatedAlerts;

  if (persist) {
    try {
      console.time(`${predictionTraceId}:Firebase write`);
      await saveNpkPrediction({
        farmId,
        record: currentRecord,
        responsePayload,
      });

      const recordsForAnalytics = await getFarmPredictionRecords(farmId, 120);
      responsePayload.analyticsSummary = await persistFarmAnalytics({
        farmId,
        records: recordsForAnalytics,
      });

      await saveFarmAlerts({
        farmId,
        alerts: generatedAlerts,
      });
      console.timeEnd(`${predictionTraceId}:Firebase write`);
    } catch (persistError) {
      console.error(`[${predictionTraceId}] persistence failed, returning prediction without storage`, persistError);
    }
  }

  const totalPredictionMs = nowMs() - timing.startMs;
  responsePayload.performance = {
    totalPredictionMs,
  };
  console.log(`[${predictionTraceId}] total prediction time: ${totalPredictionMs}ms`);
  console.timeEnd(`${predictionTraceId}:total prediction time`);

  return responsePayload;
};

const normalizeText = (value) => {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
};

const getLocaleSafe = (value) => {
  if (value === "ta") return "ta";
  return "en";
};

const getRefusalMessage = (locale) => {
  if (locale === "ta") {
    return "நான் விவசாயம்/வேளாண்மை தொடர்பான கேள்விகளுக்கு மட்டும் பதில் சொல்வேன். பயிர்கள், மண், உரம், பாசனம், பூச்சி/நோய்கள் போன்றவற்றைப் பற்றி கேளுங்கள்.";
  }
  return "I can only help with agriculture-related questions (crops, soil, fertilizer, irrigation, pests/diseases, livestock, etc). Please ask something related to farming.";
};

const isAgricultureQuery = (rawMessage, contextText = "") => {
  const message = normalizeText(rawMessage);
  if (!message) return false;

  const lowered = message.toLowerCase();
  const contextLowered = normalizeText(contextText).toLowerCase();

  // Allow very short greetings / openings.
  if (lowered.length <= 8) {
    const greetings = ["hi", "hello", "hey", "vanakkam", "வணக்கம்", "hai"];
    if (greetings.some((g) => lowered === g || message === g)) return true;
  }

  // Quick deny-list for common totally off-topic intents.
  const offTopicHints = [
    "movie",
    "song",
    "cricket",
    "football",
    "politics",
    "election",
    "relationship",
    "girlfriend",
    "boyfriend",
    "joke",
    "meme",
    "programming",
    "javascript",
    "react",
    "python",
    "java",
  ];
  if (offTopicHints.some((hint) => lowered.includes(hint))) return false;

  const agriKeywords = [
    // English
    "agri",
    "agriculture",
    "farm",
    "farming",
    "crop",
    "crops",
    "paddy",
    "rice",
    "wheat",
    "maize",
    "millet",
    "sorghum",
    "cotton",
    "sugarcane",
    "banana",
    "coconut",
    "groundnut",
    "pulses",
    "chickpea",
    "lentil",
    "cowpea",
    "onion",
    "tomato",
    "brinjal",
    "chilli",
    "turmeric",
    "ginger",
    "seed",
    "plant",
    "planting",
    "cultivate",
    "cultivation",
    "sowing",
    "season",
    "kharif",
    "rabi",
    "zaid",
    "nursery",
    "transplant",
    "harvest",
    "yield",
    "soil",
    "ph",
    "fertilizer",
    "manure",
    "compost",
    "urea",
    "dap",
    "npk",
    "irrigation",
    "drip",
    "sprinkler",
    "pest",
    "disease",
    "fungus",
    "blight",
    "aphid",
    "thrips",
    "whitefly",
    "weed",
    "herbicide",
    "pesticide",
    "neem",
    "weather",
    "rain",
    "rainfall",
    "monsoon",
    "drought",
    "livestock",
    "cattle",
    "cow",
    "goat",
    "sheep",
    "poultry",
    "dairy",
    "fish",
    "aquaculture",
    "beekeeping",
    // Tamil
    "விவசாய",
    "வேளாண்மை",
    "பயிர்",
    "நெல்",
    "அரிசி",
    "கோதுமை",
    "மக்காச்சோளம்",
    "கரும்பு",
    "பருத்தி",
    "வாழை",
    "தேங்காய்",
    "வெங்காய",
    "தக்காளி",
    "கத்தரிக்காய்",
    "மிளகாய்",
    "மஞ்சள்",
    "இஞ்சி",
    "விதை",
    "விதைப்ப",
    "விதைப்பு",
    "நாற்று",
    "நடவு",
    "சாகுபடி",
    "அறுவடை",
    "பருவம்",
    "காலநிலை",
    "மழை",
    "மண்",
    "உரம்",
    "சாணம்",
    "கம்போஸ்ட்",
    "பாசனம்",
    "நீர்",
    "சொட்டு",
    "தெளிப்பு",
    "பூச்சி",
    "நோய்",
    "களை",
    "மருந்து",
    "கால்நடை",
    "மாடு",
    "ஆடு",
    "கோழி",
    "பால்",
    "மீன்",
    "தேனீ",
    "தேன்",
  ];

  const messageHasAgriKeyword = agriKeywords.some((kw) => message.includes(kw) || lowered.includes(kw));
  if (messageHasAgriKeyword) return true;

  const genericFollowups = [
    "what to do",
    "how to solve",
    "how to fix",
    "next step",
    "solution",
    "treatment",
    "cure",
    "explain this",
    "what is result",
    "இப்போ என்ன செய்ய",
    "எப்படி சரி செய்ய",
    "தீர்வு என்ன",
    "பரிந்துரை என்ன",
    "விளக்கு",
  ];

  const isGenericFollowup = genericFollowups.some((phrase) => lowered.includes(phrase) || message.includes(phrase));
  if (!isGenericFollowup) return false;

  const contextHasAgriKeyword = agriKeywords.some((kw) => contextLowered.includes(kw));
  if (contextHasAgriKeyword) return true;

  const pageHints = ["crop", "analysis", "npk", "soil", "weather", "fertilizer", "alert", "வானிலை", "மண்", "பயிர்", "உரம்", "எச்சரிக்கை"];
  return pageHints.some((hint) => contextLowered.includes(hint));
};

// ✅ Ensure API key exists
const apiKey = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
const modelName = process.env.GEMINI_MODEL || "gemini-2.5-flash";

if (!apiKey) {
  console.error("❌ GEMINI_API_KEY is not set in environment variables.");
}

const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

// ✅ Health check route
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "AgroSense backend is running 🚜" });
});

app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    uptimeSeconds: Number(process.uptime().toFixed(1)),
    startedAt: serverBootAt,
    model: modelMetadata,
    firebaseConfigured: Boolean(adminDb),
    cacheSize: npkHistoryCache.length,
    timestamp: new Date().toISOString(),
  });
});

// ✅ ESP32 Sensor ingest route
app.post("/api/sensor-data", async (req, res) => {
  if (!adminDb) {
    return res.status(503).json({
      error: "Firebase Admin is not configured. Add serviceAccountKey.json or FIREBASE_SERVICE_ACCOUNT_JSON.",
    });
  }

  try {
    const { moisture, temperature, humidity, rainfall, cropType, fertilizerUsed } = req.body || {};
    const moistureValue = Number(moisture);
    const temperatureValue = Number(temperature);
    const humidityValue = Number(humidity);
    const rainfallValue = Number(rainfall);

    if (!Number.isFinite(moistureValue) || !Number.isFinite(temperatureValue)) {
      return res.status(400).json({ error: "moisture and temperature must be numeric values." });
    }

    await adminDb.collection("sensorData").add({
      moisture: moistureValue,
      temperature: temperatureValue,
      humidity: Number.isFinite(humidityValue) ? humidityValue : null,
      rainfall: Number.isFinite(rainfallValue) ? rainfallValue : null,
      cropType: typeof cropType === "string" ? cropType : null,
      fertilizerUsed: Boolean(fertilizerUsed),
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({ message: "Data stored successfully" });
  } catch (error) {
    console.error("Sensor data ingest error:", error);
    return res.status(500).json({ error: "Failed to store data" });
  }
});

app.post("/api/predict-npk", authGuard, async (req, res) => {
  try {
    const farmId = await resolveFarmIdForUid(req.user?.uid);
    if (!farmId) {
      return res.status(403).json({ error: "No farm mapping found for this user." });
    }

    if (req.body?.farmId || req.query?.farmId) {
      console.warn(`Ignoring client-provided farmId for uid ${req.user?.uid}.`);
    }

    const responsePayload = await generatePredictionResponse({
      payload: req.body || {},
      farmId,
      location: req.body?.location,
      persist: true,
    });

    return res.status(200).json(responsePayload);
  } catch (error) {
    if (error?.message === "FIREBASE_UNAVAILABLE") {
      return res.status(503).json({ error: "Data service unavailable." });
    }

    console.error("NPK prediction error:", error);
    return res.status(500).json({ error: "Failed to generate NPK prediction." });
  }
});

app.get("/api/npk/live-sensor", authGuard, async (req, res) => {
  try {
    const farmId = await resolveFarmIdForUid(req.user?.uid);
    if (!farmId) {
      return res.status(403).json({ error: "No farm mapping found for this user." });
    }

    const location = typeof req.query?.location === "string" && req.query.location.trim()
      ? req.query.location.trim()
      : process.env.DEFAULT_WEATHER_CITY || "Chennai";

    let moisture = null;
    let temperature = null;

    if (adminDb) {
      const latestSensorSnapshot = await adminDb
        .collection("sensorData")
        .orderBy("timestamp", "desc")
        .limit(1)
        .get();

      const latestDoc = latestSensorSnapshot.docs[0]?.data() || {};
      const moistureValue = Number(latestDoc?.moisture);
      const temperatureValue = Number(latestDoc?.temperature);

      moisture = Number.isFinite(moistureValue) ? moistureValue : null;
      temperature = Number.isFinite(temperatureValue) ? temperatureValue : null;
    }

    const weatherContext = await getWeatherContext({ location });

    return res.status(200).json({
      farmId,
      location,
      moisture: Number.isFinite(moisture) ? moisture : 35,
      temperature: Number.isFinite(temperature) ? temperature : 29,
      humidity: Number.isFinite(Number(weatherContext?.humidity)) ? Number(weatherContext.humidity) : 68,
      rainfall: Number.isFinite(Number(weatherContext?.rainfallNext24h)) ? Number(weatherContext.rainfallNext24h) : 0,
      weatherContext,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error?.message === "FIREBASE_UNAVAILABLE") {
      return res.status(503).json({ error: "Data service unavailable." });
    }

    console.error("Live sensor fetch error:", error);
    return res.status(500).json({ error: "Failed to fetch live sensor data." });
  }
});

app.post("/api/fertilizer/plan", authGuard, async (req, res) => {
  try {
    const {
      crop,
      soilType,
      fertilizerApplied,
      appliedFertilizer,
      quantity,
    } = req.body || {};

    if (typeof crop !== "string" || !crop.trim()) {
      return res.status(400).json({ error: "crop is required." });
    }

    if (typeof soilType !== "string" || !soilType.trim()) {
      return res.status(400).json({ error: "soilType is required." });
    }

    const isApplied = Boolean(fertilizerApplied);
    if (isApplied) {
      if (typeof appliedFertilizer !== "string" || !appliedFertilizer.trim()) {
        return res.status(400).json({ error: "appliedFertilizer is required when fertilizerApplied is true." });
      }

      const quantityValue = Number(quantity);
      if (!Number.isFinite(quantityValue) || quantityValue < 0) {
        return res.status(400).json({ error: "quantity must be a valid non-negative number." });
      }
    }

    const plan = await createFertilizerPlan({
      crop,
      soilType,
      fertilizerApplied: isApplied,
      appliedFertilizer,
      quantity,
    });

    return res.status(200).json(plan);
  } catch (error) {
    console.error("Fertilizer plan error:", error);
    return res.status(500).json({ error: "Failed to generate fertilizer plan." });
  }
});

app.get("/api/alerts", authGuard, async (req, res) => {
  try {
    const farmId = await resolveFarmIdForUid(req.user?.uid);
    if (!farmId) {
      return res.status(403).json({ error: "No farm mapping found for this user." });
    }

    const limit = clamp(Number(req.query?.limit || 40), 1, 100);
    let alerts = await getFarmAlerts(farmId, limit);

    if (alerts.length === 0) {
      const latestPayload = await generatePredictionResponse({
        payload: { mode: "live" },
        farmId,
        location: req.query?.location,
        persist: true,
      });
      alerts = Array.isArray(latestPayload?.alerts) ? latestPayload.alerts : [];
    }

    const sorted = sortAlertsByPriority(alerts).slice(0, limit);
    return res.status(200).json({
      farmId,
      count: sorted.length,
      alerts: sorted,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error?.message === "FIREBASE_UNAVAILABLE") {
      return res.status(503).json({ error: "Data service unavailable." });
    }

    console.error("Alerts API error:", error);
    return res.status(500).json({ error: "Failed to fetch farm alerts." });
  }
});

app.get("/api/npk/latest", authGuard, async (req, res) => {
  try {
    const farmId = await resolveFarmIdForUid(req.user?.uid);
    if (!farmId) {
      return res.status(403).json({ error: "No farm mapping found for this user." });
    }

    if (req.query?.farmId || req.body?.farmId) {
      console.warn(`Ignoring client-provided farmId for uid ${req.user?.uid}.`);
    }

    if (adminDb) {
      const latestSnapshot = await adminDb
        .collection("farms")
        .doc(farmId)
        .collection("predictions")
        .orderBy("createdAtEpoch", "desc")
        .limit(1)
        .get();

      const latestDoc = latestSnapshot.docs[0];
      if (latestDoc) {
        const latestData = latestDoc.data();
        if (latestData.response) {
          return res.status(200).json({ id: latestDoc.id, ...latestData.response });
        }

        return res.status(200).json({ id: latestDoc.id, ...latestData });
      }
    }

    const cachedEntry = npkHistoryCache.find((entry) => entry.farmId === farmId);
    if (cachedEntry?.response) {
      return res.status(200).json(cachedEntry.response);
    }

    const payload = await generatePredictionResponse({
      payload: {},
      farmId,
      location: "Field",
      persist: false,
    });

    return res.status(200).json(payload);
  } catch (error) {
    if (error?.message === "FIREBASE_UNAVAILABLE") {
      return res.status(503).json({ error: "Data service unavailable." });
    }

    console.error("Latest NPK fetch error:", error);
    return res.status(500).json({ error: "Failed to fetch latest NPK data." });
  }
});

app.get("/api/npk/history", authGuard, async (req, res) => {
  const limitValue = clamp(Number(req.query.limit || 10), 1, 30);

  try {
    const farmId = await resolveFarmIdForUid(req.user?.uid);
    if (!farmId) {
      return res.status(403).json({ error: "No farm mapping found for this user." });
    }

    if (req.query?.farmId) {
      console.warn(`Ignoring client-provided farmId for uid ${req.user?.uid}.`);
    }

    if (adminDb) {
      const historySnapshot = await adminDb
        .collection("farms")
        .doc(farmId)
        .collection("predictions")
        .orderBy("createdAtEpoch", "desc")
        .limit(limitValue)
        .get();

      const history = historySnapshot.docs.map((doc) => {
        const data = doc.data();
        if (data.response) {
          return {
            id: doc.id,
            timestamp: data.response.generatedAt || data.generatedAt || null,
            generatedAt: data.response.generatedAt || data.generatedAt || null,
            N: data.response.N,
            P: data.response.P,
            K: data.response.K,
            moisture: data.response.inputs?.moisture,
            soilHealthScore: data.response.soilHealthScore,
            ...data.response,
          };
        }

        return {
          id: doc.id,
          farmId: data.farmId,
          timestamp: data.generatedAt,
          generatedAt: data.generatedAt,
          inputs: {
            moisture: data.moisture,
            temperature: data.temperature,
            humidity: data.humidity,
            rainfall: data.rainfall,
            cropType: data.cropType,
            fertilizerUsed: data.fertilizerUsed,
          },
          prediction: {
            values: {
              N: data.predictedN,
              P: data.predictedP,
              K: data.predictedK,
            },
          },
          N: data.predictedN,
          P: data.predictedP,
          K: data.predictedK,
          irrigationAdvice: data.irrigationAdvice,
          fertilizerAdvice: data.fertilizerAdvice,
          trendAnalysis: data.trendAnalysis,
          soilHealthScore: data.soilHealthScore,
          insightMessage: data.insightMessage,
        };
      });

      return res.status(200).json({ history });
    }

    const history = npkHistoryCache
      .filter((entry) => entry.farmId === farmId)
      .slice(0, limitValue)
      .map((entry) => {
        const base = entry.response || entry;
        return {
          timestamp: base.generatedAt || null,
          generatedAt: base.generatedAt || null,
          N: base.N ?? base?.prediction?.values?.N,
          P: base.P ?? base?.prediction?.values?.P,
          K: base.K ?? base?.prediction?.values?.K,
          moisture: base?.inputs?.moisture ?? base?.moisture,
          soilHealthScore: base?.soilHealthScore ?? null,
          ...base,
        };
      });

    return res.status(200).json({ history });
  } catch (error) {
    if (error?.message === "FIREBASE_UNAVAILABLE") {
      return res.status(503).json({ error: "Data service unavailable." });
    }

    console.error("NPK history fetch error:", error);
    return res.status(500).json({ error: "Failed to fetch NPK history." });
  }
});

app.get("/api/npk/model-info", (req, res) => {
  res.status(200).json({
    model: modelMetadata,
    cropModel: cropModelMetadata,
    cropCount: cropList.length,
    crops: cropList,
    modelFileExists: existsSync(MODEL_FILE_PATH),
  });
});

app.post("/api/crop/recommend", authGuard, async (req, res) => {
  try {
    const farmId = await resolveFarmIdForUid(req.user?.uid);
    if (!farmId) {
      return res.status(403).json({ error: "No farm mapping found for this user." });
    }

    const latestResponse = await generatePredictionResponse({
      payload: req.body || {},
      farmId,
      location: req.body?.location,
      persist: false,
    });

    return res.status(200).json({
      farmId,
      recommendation: latestResponse.cropRecommendation || [],
      weatherContext: latestResponse.weatherContext || null,
      generatedAt: latestResponse.generatedAt,
    });
  } catch (error) {
    if (error?.message === "FIREBASE_UNAVAILABLE") {
      return res.status(503).json({ error: "Data service unavailable." });
    }

    console.error("Crop recommendation error:", error);
    return res.status(500).json({ error: "Failed to generate crop recommendations." });
  }
});

app.get("/api/demo/summary", authGuard, async (req, res) => {
  try {
    const farmId = await resolveFarmIdForUid(req.user?.uid);
    if (!farmId) {
      return res.status(403).json({ error: "No farm mapping found for this user." });
    }

    const latestPayload = await generatePredictionResponse({
      payload: {},
      farmId,
      location: "Field",
      persist: false,
    });

    const records = await getFarmPredictionRecords(farmId, 120);
    const analyticsSummary = buildFarmAnalytics({ historyRecords: records });
    const sustainability = computeSustainability({ historyRecords: records.slice(0, 30) });
    const forecast = buildForecast({ historyRecords: records.slice(0, 7), trendAnalysis: latestPayload.trendAnalysis });

    const weeklySummary = {
      averageSoilHealth: analyticsSummary.weeklyInsights?.averageSoilHealth,
      mostFrequentDeficiency: analyticsSummary.mostFrequentDeficiency,
      irrigationUrgentCount: analyticsSummary.irrigationFrequency?.urgent || 0,
      cropSuitabilityChanges: analyticsSummary.cropSuitabilityChanges || 0,
    };

    const alertsCount =
      (forecast.forecastRisk === "high" ? 2 : forecast.forecastRisk === "medium" ? 1 : 0) +
      (latestPayload.soilHealthCategory === "Critical" || latestPayload.soilHealthCategory === "Poor" ? 1 : 0);

    return res.status(200).json({
      farmId,
      farmHealthScore: latestPayload.soilHealthScore,
      forecastRisk: forecast.forecastRisk,
      topCrop: latestPayload.cropRecommendation?.[0]?.crop || null,
      sustainabilityScore: sustainability.score,
      sustainabilityCategory: sustainability.category,
      weeklySummary,
      alertsCount,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error?.message === "FIREBASE_UNAVAILABLE") {
      return res.status(503).json({ error: "Data service unavailable." });
    }

    console.error("Demo summary error:", error);
    return res.status(500).json({ error: "Failed to generate demo summary." });
  }
});

// ✅ Chat route
app.post("/chat", async (req, res) => {
  const { message, locale, pageContext, history } = req.body || {};
  const localeSafe = getLocaleSafe(locale);
  const userMessage = normalizeText(message);

  if (!userMessage) {
    return res.status(400).json({ error: "Message is required" });
  }

  const safePageContext = {
    page: normalizeText(pageContext?.page || ""),
    path: normalizeText(pageContext?.path || ""),
    snapshot: normalizeText(pageContext?.snapshot || ""),
    summary: normalizeText(pageContext?.summary || ""),
  };
  const contextTextForGate = `${safePageContext.page} ${safePageContext.path} ${safePageContext.summary} ${safePageContext.snapshot}`;

  // Agriculture-only gate: refuse off-topic questions without calling the model.
  if (!isAgricultureQuery(userMessage, contextTextForGate)) {
    return res.json({ reply: getRefusalMessage(localeSafe) });
  }

  if (!genAI) {
    return res.status(503).json({
      error: "AI service not configured. Add GEMINI_API_KEY in environment variables.",
    });
  }

  try {
    const safeHistory = Array.isArray(history)
      ? history
          .slice(-6)
          .map((item) => ({
            role: item?.role === "assistant" ? "assistant" : "user",
            text: normalizeText(item?.text || "").slice(0, 900),
          }))
          .filter((item) => item.text)
      : [];

    const systemPrompt =
      "You are Uzhavar AI, an agriculture-only assistant for farmers in Tamil Nadu, India. " +
      "You MUST answer ONLY agriculture-related questions (crops, soil, irrigation, fertilizers, pests/diseases, farm management, livestock, fisheries, beekeeping, agri schemes, weather impacts on farming). " +
      "If the user asks anything outside agriculture, refuse with a brief message and ask them to rephrase as an agriculture question. " +
      "Use very simple farmer-friendly language. Avoid jargon and complex maths. Keep answers short with clear next steps. " +
      "Understand follow-up questions like 'what to do' or 'how to solve' using prior chat and current page context. " +
      "If user asks about current page results, explain only what is present in supplied page context. If context is missing, say so politely and ask user to open the result page. " +
      "If locale is 'ta', reply ONLY in Tamil script and Tamil words. If locale is 'en', reply only in English.";

    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: systemPrompt,
    });

    const contents = [];
    safeHistory.forEach((item) => {
      contents.push({
        role: item.role,
        parts: [{ text: item.text }],
      });
    });
    contents.push({
      role: "user",
      parts: [
        {
          text:
            `Locale: ${localeSafe}\n` +
            `Page: ${safePageContext.page || "unknown"}\n` +
            `Path: ${safePageContext.path || "unknown"}\n` +
            `Page summary: ${safePageContext.summary || "not available"}\n` +
            `Page snapshot: ${safePageContext.snapshot || "not available"}\n` +
            `User: ${userMessage}`,
        },
      ],
    });

    const result = await model.generateContent({
      contents,
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 512,
      },
    });

    let reply = result.response.text().trim();

    if (localeSafe === "ta") {
      const tamilCharCount = (reply.match(/[\u0B80-\u0BFF]/g) || []).length;
      if (tamilCharCount < 8) {
        const retryResult = await model.generateContent({
          contents: [
            {
              role: "user",
              parts: [{ text: `Respond only in simple Tamil for farmers. Question: ${userMessage}` }],
            },
          ],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 256,
          },
        });
        reply = retryResult.response.text().trim() || reply;
      }
    }

    // Extra safety: if the model returns something clearly off-topic, override it.
    if (!isAgricultureQuery(reply, contextTextForGate)) {
      return res.json({ reply: getRefusalMessage(localeSafe) });
    }

    res.json({ reply });
  } catch (error) {
    console.error("Gemini Error:", error);

    const localeSafe = getLocaleSafe(req.body?.locale);
    const message = typeof error?.message === "string" ? error.message : "";
    const isQuota =
      message.includes("429") ||
      message.toLowerCase().includes("quota") ||
      message.toLowerCase().includes("rate limit") ||
      message.toLowerCase().includes("rate-limit");

    if (isQuota) {
      const reply =
        localeSafe === "ta"
          ? "இப்போது AI சேவை பயன்பாட்டு வரம்பை (quota/rate limit) அடைந்துள்ளது. சில நிமிடங்கள் கழித்து மீண்டும் முயற்சிக்கவும்."
          : "The AI service has hit a quota/rate limit right now. Please try again in a few minutes.";
      return res.status(429).json({ error: "AI quota exceeded", reply });
    }

    res.status(500).json({
      error: "Failed to fetch AI response",
      details: error.message,
    });
  }
});

const realtimePredictionIntervalMs = Number(process.env.REALTIME_PREDICTION_INTERVAL_MS || 0);
if (Number.isFinite(realtimePredictionIntervalMs) && realtimePredictionIntervalMs >= 30000) {
  setInterval(async () => {
    try {
      const farmId = normalizeFarmId(process.env.DEFAULT_FARM_ID || "defaultFarm");
      await generatePredictionResponse({
        payload: { farmId },
        farmId,
        location: "Field",
        persist: true,
      });
      console.log(`⏱ Realtime prediction cycle completed for farm ${farmId}.`);
    } catch (error) {
      console.error("Realtime prediction loop error:", error);
    }
  }, realtimePredictionIntervalMs);

  console.log(`⏱ Realtime prediction loop enabled (${realtimePredictionIntervalMs} ms interval).`);
}

if (existsSync(FRONTEND_DIST_PATH)) {
  app.use(express.static(FRONTEND_DIST_PATH));

  app.use((req, res, next) => {
    if (req.originalUrl.startsWith("/api")) {
      return next();
    }
    res.sendFile(path.join(FRONTEND_DIST_PATH, "index.html"));
  });

  console.log(`📦 Serving frontend build from ${FRONTEND_DIST_PATH}`);
} else {
  console.warn(
    `⚠️ Frontend build directory not found at ${FRONTEND_DIST_PATH}. Run \"npm run build\" inside frontend/ before deploying.`,
  );
}

app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.use((error, req, res, next) => {
  console.error("Unhandled server error:", error);
  res.status(500).json({ error: "Internal server error" });
});

// ✅ IMPORTANT: Use dynamic port for Render
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  ensureDiseaseDaemon()
    .then(() => {
      console.log("⚡ Disease inference daemon warmed up.");
    })
    .catch((error) => {
      console.warn("Disease daemon warm-up failed, fallback mode will be used:", error?.message || error);
    });
});

process.on("SIGINT", () => {
  resetDiseaseDaemon("Server shutting down");
  process.exit(0);
});

process.on("SIGTERM", () => {
  resetDiseaseDaemon("Server shutting down");
  process.exit(0);
});
