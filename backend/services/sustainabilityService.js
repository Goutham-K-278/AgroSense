const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const safeNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const categoryFromScore = (score) => {
  if (score >= 80) return "Excellent";
  if (score >= 60) return "Good";
  if (score >= 40) return "Moderate";
  return "Low";
};

export const computeSustainability = ({ historyRecords = [] }) => {
  if (!Array.isArray(historyRecords) || historyRecords.length === 0) {
    return {
      score: 50,
      category: "Moderate",
      components: {
        nutrientBalanceStability: 50,
        irrigationEfficiency: 50,
        overFertilizationAvoidance: 50,
      },
    };
  }

  const nutrientPenalty =
    historyRecords.reduce((sum, item) => {
      const deficiency = item.deficiency || {};
      const n = safeNumber(deficiency?.N?.deficiencyPercent);
      const p = safeNumber(deficiency?.P?.deficiencyPercent);
      const k = safeNumber(deficiency?.K?.deficiencyPercent);
      return sum + (n + p + k) / 3;
    }, 0) / historyRecords.length;

  const nutrientBalanceStability = clamp(100 - nutrientPenalty, 0, 100);

  const delaySignals = historyRecords.filter((item) => String(item.irrigationAdvice || "").toLowerCase().includes("delay irrigation")).length;
  const urgentSignals = historyRecords.filter((item) => String(item.irrigationAdvice || "").toLowerCase().includes("urgent")).length;
  const irrigationEfficiency = clamp(70 + delaySignals * 5 - urgentSignals * 4, 0, 100);

  const overFertilizationEvents = historyRecords.filter((item) => {
    const deficiency = item.deficiency || {};
    const requiredN = safeNumber(deficiency?.N?.required);
    const requiredP = safeNumber(deficiency?.P?.required);
    const requiredK = safeNumber(deficiency?.K?.required);
    const predictedN = safeNumber(deficiency?.N?.predicted);
    const predictedP = safeNumber(deficiency?.P?.predicted);
    const predictedK = safeNumber(deficiency?.K?.predicted);

    return predictedN > requiredN * 1.2 || predictedP > requiredP * 1.2 || predictedK > requiredK * 1.2;
  }).length;

  const overFertilizationAvoidance = clamp(100 - (overFertilizationEvents / historyRecords.length) * 100, 0, 100);

  const weighted =
    nutrientBalanceStability * 0.45 + irrigationEfficiency * 0.3 + overFertilizationAvoidance * 0.25;
  const score = Math.round(clamp(weighted, 0, 100));

  return {
    score,
    category: categoryFromScore(score),
    components: {
      nutrientBalanceStability: Number(nutrientBalanceStability.toFixed(2)),
      irrigationEfficiency: Number(irrigationEfficiency.toFixed(2)),
      overFertilizationAvoidance: Number(overFertilizationAvoidance.toFixed(2)),
    },
  };
};
