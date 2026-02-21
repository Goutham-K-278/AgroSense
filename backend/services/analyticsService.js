const safeNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const getDeficiencyType = (record = {}) => {
  const d = record.deficiency || {};
  const candidates = [
    { type: "N", value: safeNumber(d?.N?.deficiencyPercent) },
    { type: "P", value: safeNumber(d?.P?.deficiencyPercent) },
    { type: "K", value: safeNumber(d?.K?.deficiencyPercent) },
  ].sort((a, b) => b.value - a.value);

  return candidates[0]?.value > 0 ? candidates[0].type : "None";
};

const getTopCropName = (record = {}) => {
  const first = Array.isArray(record.cropRecommendation) ? record.cropRecommendation[0] : null;
  return first?.crop || null;
};

export const buildFarmAnalytics = ({ historyRecords = [] }) => {
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  const records30d = historyRecords.filter((item) => safeNumber(item.createdAtEpoch) >= thirtyDaysAgo);
  const records7d = historyRecords.filter((item) => safeNumber(item.createdAtEpoch) >= now - 7 * 24 * 60 * 60 * 1000);

  const avgSoilHealth =
    records30d.length > 0
      ? Number((records30d.reduce((sum, item) => sum + safeNumber(item.soilHealthScore), 0) / records30d.length).toFixed(2))
      : null;

  const deficiencyCount = records30d.reduce((map, item) => {
    const key = getDeficiencyType(item);
    map[key] = (map[key] || 0) + 1;
    return map;
  }, {});

  const mostFrequentDeficiency = Object.entries(deficiencyCount).sort((a, b) => b[1] - a[1])[0]?.[0] || "None";

  const irrigationFrequency = {
    urgent: records30d.filter((item) => String(item.irrigationAdvice || "").toLowerCase().includes("urgent")).length,
    delayedByForecast: records30d.filter((item) => String(item.irrigationAdvice || "").toLowerCase().includes("delay irrigation")).length,
    totalRecords: records30d.length,
  };

  const fertilizerUsageSummary = {
    usedRecentlyCount: records30d.filter((item) => Boolean(item.fertilizerUsed)).length,
    notUsedCount: records30d.filter((item) => !item.fertilizerUsed).length,
    recommendationIssuedCount: records30d.filter((item) => String(item.fertilizerAdvice || "").length > 0).length,
  };

  const cropSequence = records30d.map(getTopCropName).filter(Boolean);
  let suitabilityChanges = 0;
  for (let index = 1; index < cropSequence.length; index += 1) {
    if (cropSequence[index] !== cropSequence[index - 1]) suitabilityChanges += 1;
  }

  const weeklyInsights = {
    records: records7d.length,
    averageSoilHealth:
      records7d.length > 0
        ? Number((records7d.reduce((sum, item) => sum + safeNumber(item.soilHealthScore), 0) / records7d.length).toFixed(2))
        : null,
    topCrop: cropSequence[cropSequence.length - 1] || null,
  };

  return {
    generatedAt: new Date().toISOString(),
    recordsAnalyzed30d: records30d.length,
    avgSoilHealth30d: avgSoilHealth,
    mostFrequentDeficiency,
    irrigationFrequency,
    fertilizerUsageSummary,
    cropSuitabilityChanges: suitabilityChanges,
    weeklyInsights,
  };
};
