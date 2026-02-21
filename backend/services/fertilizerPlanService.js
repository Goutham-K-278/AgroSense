import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cropRequirementsPath = path.join(__dirname, "..", "config", "cropRequirements.json");
const cropRequirements = JSON.parse(readFileSync(cropRequirementsPath, "utf-8"));

const fertilizerProfiles = {
  Urea: { N: 0.46, P: 0, K: 0, pricePerKg: 6.2 },
  DAP: { N: 0.18, P: 0.46, K: 0, pricePerKg: 27.5 },
  MOP: { N: 0, P: 0, K: 0.6, pricePerKg: 18.4 },
  "NPK 19-19-19": { N: 0.19, P: 0.19, K: 0.19, pricePerKg: 42.0 },
  "Organic Manure": { N: 0.02, P: 0.01, K: 0.01, pricePerKg: 2.5 },
};

const soilAdvice = {
  Sandy: "Use split doses (2-3 rounds) to reduce nutrient leaching in sandy soils.",
  Clay: "Normal single + top-dress schedule is suitable for clay soils.",
  Loamy: "Balanced split in 2 rounds is recommended for loamy soils.",
  "Black Soil": "Apply in 2 stages and monitor moisture retention before top dressing.",
  "Red Soil": "Use smaller split applications with moisture monitoring for red soils.",
};

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const round2 = (value) => Number(toNumber(value).toFixed(2));
const clampMinZero = (value) => Math.max(0, round2(value));

const normalizeCrop = (crop) => {
  const input = String(crop || "").trim();
  if (!input) return "Default";

  const found = Object.keys(cropRequirements).find((key) => key.toLowerCase() === input.toLowerCase());
  return found || "Default";
};

const normalizeSoil = (soilType) => {
  const input = String(soilType || "").trim();
  const found = Object.keys(soilAdvice).find((key) => key.toLowerCase() === input.toLowerCase());
  return found || "Loamy";
};

const normalizeFertilizer = (fertilizerType) => {
  const input = String(fertilizerType || "").trim();
  const found = Object.keys(fertilizerProfiles).find((key) => key.toLowerCase() === input.toLowerCase());
  return found || null;
};

const getCropRequirement = (crop) => {
  const normalizedCrop = normalizeCrop(crop);
  const requirement = cropRequirements[normalizedCrop] || cropRequirements.Default;

  return {
    crop: normalizedCrop,
    N: toNumber(requirement?.N, 75),
    P: toNumber(requirement?.P, 35),
    K: toNumber(requirement?.K, 55),
  };
};

const getSuppliedNpk = ({ fertilizerType, quantityKgPerAcre }) => {
  const normalizedFertilizer = normalizeFertilizer(fertilizerType);
  const quantity = Math.max(0, toNumber(quantityKgPerAcre, 0));

  if (!normalizedFertilizer) {
    return {
      fertilizerType: null,
      quantityKgPerAcre: quantity,
      N: 0,
      P: 0,
      K: 0,
    };
  }

  const profile = fertilizerProfiles[normalizedFertilizer];

  return {
    fertilizerType: normalizedFertilizer,
    quantityKgPerAcre: quantity,
    N: round2(quantity * profile.N),
    P: round2(quantity * profile.P),
    K: round2(quantity * profile.K),
  };
};

const buildRemainingDeficit = ({ cropRequirement, suppliedNPK }) => ({
  N: clampMinZero(cropRequirement.N - toNumber(suppliedNPK?.N, 0)),
  P: clampMinZero(cropRequirement.P - toNumber(suppliedNPK?.P, 0)),
  K: clampMinZero(cropRequirement.K - toNumber(suppliedNPK?.K, 0)),
});

const buildRecommendedFertilizer = (remainingDeficit) => {
  const ureaQty = clampMinZero(toNumber(remainingDeficit?.N, 0) / fertilizerProfiles.Urea.N);
  const dapQty = clampMinZero(toNumber(remainingDeficit?.P, 0) / fertilizerProfiles.DAP.P);
  const mopQty = clampMinZero(toNumber(remainingDeficit?.K, 0) / fertilizerProfiles.MOP.K);

  return [
    { type: "Urea", quantityKgPerAcre: ureaQty },
    { type: "DAP", quantityKgPerAcre: dapQty },
    { type: "MOP", quantityKgPerAcre: mopQty },
  ];
};

const buildCostEstimate = ({ suppliedNPK, recommendedFertilizer }) => {
  const suppliedCost = suppliedNPK?.fertilizerType
    ? round2(
        toNumber(suppliedNPK.quantityKgPerAcre, 0) *
          toNumber(fertilizerProfiles[suppliedNPK.fertilizerType]?.pricePerKg, 0),
      )
    : 0;

  const recommendedCost = round2(
    (recommendedFertilizer || []).reduce((total, item) => {
      const pricePerKg = toNumber(fertilizerProfiles[item.type]?.pricePerKg, 0);
      return total + toNumber(item.quantityKgPerAcre, 0) * pricePerKg;
    }, 0),
  );

  return {
    currency: "INR",
    suppliedCost,
    recommendedCost,
    totalEstimatedCost: round2(suppliedCost + recommendedCost),
  };
};

const buildApplicationAdvice = ({ soilType, fertilizerApplied, recommendedFertilizer, remainingDeficit }) => {
  const soilGuidance = soilAdvice[normalizeSoil(soilType)] || soilAdvice.Loamy;
  const hasRemainingDeficit = ["N", "P", "K"].some((key) => toNumber(remainingDeficit?.[key], 0) > 0);

  if (!hasRemainingDeficit) {
    return `NPK requirement is already met from applied fertilizer. ${soilGuidance}`;
  }

  const planText = recommendedFertilizer
    .map((item) => `${item.type}: ${round2(item.quantityKgPerAcre)} kg/acre`)
    .join(", ");

  if (fertilizerApplied) {
    return `After adjusting for applied fertilizer, remaining correction dose is ${planText}. ${soilGuidance}`;
  }

  return `Apply planned base dose ${planText}. ${soilGuidance}`;
};

export const createFertilizerPlan = async ({
  crop,
  soilType,
  fertilizerApplied,
  appliedFertilizer,
  quantity,
}) => {
  const cropRequirement = getCropRequirement(crop);
  const isApplied = Boolean(fertilizerApplied);

  const suppliedNPKRaw = isApplied
    ? getSuppliedNpk({ fertilizerType: appliedFertilizer, quantityKgPerAcre: quantity })
    : { fertilizerType: null, quantityKgPerAcre: 0, N: 0, P: 0, K: 0 };

  const suppliedNPK = {
    N: round2(suppliedNPKRaw.N),
    P: round2(suppliedNPKRaw.P),
    K: round2(suppliedNPKRaw.K),
  };

  const remainingDeficit = buildRemainingDeficit({ cropRequirement, suppliedNPK });
  const recommendedFertilizer = buildRecommendedFertilizer(remainingDeficit);

  const response = {
    crop: cropRequirement.crop,
    soilType: normalizeSoil(soilType),
    fertilizerApplied: isApplied,
    appliedFertilizer: suppliedNPKRaw.fertilizerType,
    appliedQuantityKgPerAcre: round2(suppliedNPKRaw.quantityKgPerAcre),
    cropRequirement: {
      N: round2(cropRequirement.N),
      P: round2(cropRequirement.P),
      K: round2(cropRequirement.K),
    },
    suppliedNPK,
    remainingDeficit,
    recommendedFertilizer,
  };

  response.applicationAdvice = buildApplicationAdvice({
    soilType,
    fertilizerApplied: isApplied,
    recommendedFertilizer,
    remainingDeficit,
  });

  response.costEstimate = buildCostEstimate({
    suppliedNPK: suppliedNPKRaw,
    recommendedFertilizer,
  });

  return response;
};
