import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cropRequirementsPath = path.join(__dirname, "..", "config", "cropRequirements.json");
const cropRequirements = JSON.parse(readFileSync(cropRequirementsPath, "utf-8"));

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const safeNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeCrop = (value = "") => {
  const text = typeof value === "string" ? value.trim() : "";
  return text || "Default";
};

const cropFactorMap = {
  Rice: 1.2,
  Wheat: 1.05,
  Maize: 1.1,
  Cotton: 1.15,
  Groundnut: 0.9,
  Banana: 1.25,
  Sugarcane: 1.3,
  Vegetables: 1.1,
  Default: 1,
};

export const getCropRequirement = (cropType) => {
  const normalizedCrop = normalizeCrop(cropType);
  const matchedKey = Object.keys(cropRequirements).find(
    (key) => key.toLowerCase() === normalizedCrop.toLowerCase(),
  );
  return cropRequirements[matchedKey || "Default"];
};

export const getDeficiency = (predictionValues, cropType) => {
  const requirement = getCropRequirement(cropType);

  const compute = (current, required) => {
    const value = safeNumber(current);
    const deficit = Math.max(0, safeNumber(required) - value);
    const deficiencyPercent = required > 0 ? (deficit / required) * 100 : 0;
    return {
      required: safeNumber(required),
      predicted: value,
      deficit: Number(deficit.toFixed(2)),
      deficiencyPercent: Number(deficiencyPercent.toFixed(2)),
    };
  };

  return {
    crop: normalizeCrop(cropType),
    requirement,
    N: compute(predictionValues?.N, requirement.N),
    P: compute(predictionValues?.P, requirement.P),
    K: compute(predictionValues?.K, requirement.K),
  };
};

const getFertilizerEstimateKgPerAcre = (deficiency, cropType) => {
  const normalizedCrop = normalizeCrop(cropType);
  const matchedCropKey = Object.keys(cropFactorMap).find(
    (key) => key.toLowerCase() === normalizedCrop.toLowerCase(),
  );
  const cropFactor = cropFactorMap[matchedCropKey || "Default"];

  const ureaKg = (deficiency.N.deficit / 0.46) * cropFactor;
  const dapKg = (deficiency.P.deficit / 0.46) * cropFactor;
  const mopKg = (deficiency.K.deficit / 0.6) * cropFactor;

  return {
    cropFactor,
    urea: Number(clamp(ureaKg, 0, 140).toFixed(1)),
    dap: Number(clamp(dapKg, 0, 140).toFixed(1)),
    mop: Number(clamp(mopKg, 0, 140).toFixed(1)),
  };
};

export const buildAdvisory = ({ predictionValues, inputs, trendAnalysis, weatherContext, soilHealth }) => {
  const deficiency = getDeficiency(predictionValues, inputs?.cropType);
  const fertilizerQty = getFertilizerEstimateKgPerAcre(deficiency, inputs?.cropType);

  const moisture = safeNumber(inputs?.moisture);
  const moistureDecreasing = trendAnalysis?.moistureTrend === "decreasing";
  const moistureRapidDrop = Boolean(trendAnalysis?.rapidDrop?.moisture);

  let irrigationAdvice = "Soil moisture is currently acceptable. Continue scheduled irrigation monitoring.";
  if (weatherContext?.available && weatherContext?.shouldDelayIrrigation) {
    irrigationAdvice = "Rainfall is expected (>10mm in next 24h). Delay irrigation and monitor field moisture after rain.";
  } else if (moisture < 25 || (moistureDecreasing && moistureRapidDrop)) {
    irrigationAdvice = "Irrigation is urgent. Moisture has dropped continuously. Apply light irrigation today and recheck in 12 hours.";
  } else if (moisture < 35 || moistureDecreasing) {
    irrigationAdvice = "Moisture is trending down. Plan irrigation within 24 hours to avoid crop stress.";
  }

  const severeDeficiency = [deficiency.N, deficiency.P, deficiency.K].some(
    (item) => item.deficiencyPercent >= 25,
  );

  let fertilizerAdvice = "Nutrients are near crop requirement. Maintain current fertilizer schedule.";
  if (severeDeficiency) {
    fertilizerAdvice = `Detected nutrient deficiency. Crop-factor based recommendation per acre: Urea ${fertilizerQty.urea} kg, DAP ${fertilizerQty.dap} kg, MOP ${fertilizerQty.mop} kg.`;
  } else if (
    deficiency.N.deficiencyPercent > 10 ||
    deficiency.P.deficiencyPercent > 10 ||
    deficiency.K.deficiencyPercent > 10
  ) {
    fertilizerAdvice = `Mild deficiency observed. Apply partial correction per acre: Urea ${Math.round(fertilizerQty.urea * 0.5)} kg, DAP ${Math.round(
      fertilizerQty.dap * 0.5,
    )} kg, MOP ${Math.round(fertilizerQty.mop * 0.5)} kg.`;
  }

  const riskLevel = trendAnalysis?.riskLevel || "low";
  const healthCategory = soilHealth?.category || "Moderate";
  const rainfallNext24h = safeNumber(weatherContext?.rainfallNext24h, 0);
  const conditionCode = safeNumber(
    weatherContext?.dominantConditionCode ?? weatherContext?.conditionCode,
    800,
  );
  const humidity = safeNumber(
    weatherContext?.avgHumidityTomorrow ?? weatherContext?.humidity,
    0,
  );

  const rainRiskLevel = rainfallNext24h >= 15 ? "HIGH" : rainfallNext24h >= 5 ? "MODERATE" : "LOW";

  const skyCondition =
    conditionCode === 800
      ? "CLEAR"
      : conditionCode >= 801 && conditionCode <= 804
        ? "CLOUDY"
        : conditionCode >= 500 && conditionCode <= 531
          ? "RAINY"
          : "MIXED";

  const humidityRiskLevel = humidity > 85 ? "HIGH" : humidity >= 70 ? "MODERATE" : "NORMAL";

  let advisoryMessage = "No major weather risk expected tomorrow. Continue routine field monitoring.";
  if (rainRiskLevel === "HIGH") {
    advisoryMessage = `Heavy rainfall expected tomorrow (${rainfallNext24h} mm). Delay irrigation and avoid fertilizer application.`;
  } else if (rainRiskLevel === "MODERATE") {
    advisoryMessage = `Moderate rain forecast tomorrow (${rainfallNext24h} mm). Adjust irrigation schedule and monitor runoff.`;
  } else if (skyCondition === "CLEAR") {
    advisoryMessage = "Clear sky expected tomorrow. Continue normal irrigation schedule.";
  } else if (skyCondition === "CLOUDY") {
    advisoryMessage = "Cloud cover expected tomorrow. Monitor soil moisture before irrigation.";
  }

  if (humidityRiskLevel === "HIGH") {
    advisoryMessage = `${advisoryMessage} High humidity may increase fungal disease risk.`;
  }

  const weatherRisk = {
    rainRiskLevel,
    humidityRiskLevel,
    skyCondition,
    advisoryMessage,
  };

  let weatherAlert = {
    type: "normal",
    message: advisoryMessage,
  };

  if (rainRiskLevel === "HIGH" || rainRiskLevel === "MODERATE") {
    weatherAlert = {
      type: "rain",
      message: advisoryMessage,
    };
  } else if (skyCondition === "CLEAR") {
    weatherAlert = {
      type: "clear",
      message: advisoryMessage,
    };
  } else if (humidityRiskLevel === "HIGH") {
    weatherAlert = {
      type: "humid",
      message: advisoryMessage,
    };
  } else if (skyCondition === "CLOUDY") {
    weatherAlert = {
      type: "cloudy",
      message: advisoryMessage,
    };
  }

  const insightMessage =
    riskLevel === "high"
      ? "High risk: nutrient/moisture decline is visible. Take irrigation and fertilizer action immediately."
      : riskLevel === "medium"
        ? "Moderate risk: trends show stress buildup. Follow corrective plan in the next 1-2 days."
        : healthCategory === "Healthy"
          ? "Low risk: soil is healthy and stable. Continue routine monitoring and planned nutrient application."
          : "Low risk: soil is stable now. Continue routine monitoring and crop-stage nutrient plan.";

  return {
    deficiency,
    fertilizerPlan: fertilizerQty,
    irrigationAdvice,
    fertilizerAdvice,
    insightMessage,
    weatherAlert,
    weatherRisk,
  };
};
