const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const riskToScore = (riskLevel = "low") => {
  if (riskLevel === "high") return 35;
  if (riskLevel === "medium") return 65;
  return 100;
};

const moistureStabilityScore = (trendAnalysis = {}) => {
  const moistureTrend = trendAnalysis?.moistureTrend || "stable";
  const moistureRapidDrop = Boolean(trendAnalysis?.rapidDrop?.moisture);

  if (moistureRapidDrop) return 35;
  if (moistureTrend === "stable") return 100;
  if (moistureTrend === "decreasing") return 65;
  return 75;
};

const nutrientBalanceScore = (deficiency = {}) => {
  const nDef = Number(deficiency?.N?.deficiencyPercent || 0);
  const pDef = Number(deficiency?.P?.deficiencyPercent || 0);
  const kDef = Number(deficiency?.K?.deficiencyPercent || 0);

  const nScore = clamp(100 - nDef, 0, 100);
  const pScore = clamp(100 - pDef, 0, 100);
  const kScore = clamp(100 - kDef, 0, 100);

  return Number(((nScore + pScore + kScore) / 3).toFixed(2));
};

export const categorizeSoilHealth = (score) => {
  if (score >= 80) return "Healthy";
  if (score >= 60) return "Moderate";
  if (score >= 40) return "Poor";
  return "Critical";
};

export const computeSoilHealth = ({ deficiency, trendAnalysis }) => {
  const nutrientScore = nutrientBalanceScore(deficiency);
  const moistureScore = moistureStabilityScore(trendAnalysis);
  const riskScore = riskToScore(trendAnalysis?.riskLevel || "low");

  const weightedScore = nutrientScore * 0.55 + moistureScore * 0.25 + riskScore * 0.2;
  const score = Math.round(clamp(weightedScore, 0, 100));

  return {
    score,
    category: categorizeSoilHealth(score),
    components: {
      nutrientBalance: nutrientScore,
      moistureStability: moistureScore,
      trendRisk: riskScore,
    },
  };
};
