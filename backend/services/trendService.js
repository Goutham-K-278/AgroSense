const safeNumber = (value, fallback = null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const getSlopeLabel = (series = []) => {
  if (series.length < 2) {
    return "stable";
  }

  const first = series[0];
  const last = series[series.length - 1];
  if (!Number.isFinite(first) || !Number.isFinite(last)) {
    return "stable";
  }

  const delta = last - first;
  const threshold = Math.max(Math.abs(first) * 0.05, 2);
  if (delta > threshold) return "increasing";
  if (delta < -threshold) return "decreasing";
  return "stable";
};

const movingAverage = (series = [], windowSize = 3) => {
  if (!Array.isArray(series) || series.length === 0) {
    return null;
  }

  const slice = series.slice(-windowSize).filter((value) => Number.isFinite(value));
  if (slice.length === 0) {
    return null;
  }

  const total = slice.reduce((accumulator, value) => accumulator + value, 0);
  return Number((total / slice.length).toFixed(2));
};

const hasRapidDrop = (series = []) => {
  if (series.length < 2) {
    return false;
  }

  for (let index = 1; index < series.length; index += 1) {
    const previous = series[index - 1];
    const current = series[index];

    if (!Number.isFinite(previous) || !Number.isFinite(current) || previous <= 0) {
      continue;
    }

    const dropPercent = ((previous - current) / previous) * 100;
    if (dropPercent > 15) {
      return true;
    }
  }

  return false;
};

export const analyzeTrend = (historyRecords = []) => {
  const readings = [...historyRecords].reverse().map((item) => ({
    moisture: safeNumber(item.moisture),
    nitrogen: safeNumber(item.predictedN),
    phosphorus: safeNumber(item.predictedP),
    potassium: safeNumber(item.predictedK),
  }));

  const moistureSeries = readings.map((item) => item.moisture).filter((value) => Number.isFinite(value));
  const nitrogenSeries = readings.map((item) => item.nitrogen).filter((value) => Number.isFinite(value));
  const phosphorusSeries = readings.map((item) => item.phosphorus).filter((value) => Number.isFinite(value));
  const potassiumSeries = readings.map((item) => item.potassium).filter((value) => Number.isFinite(value));

  const nitrogenRapidDrop = hasRapidDrop(nitrogenSeries);
  const moistureRapidDrop = hasRapidDrop(moistureSeries);

  let riskScore = 0;
  if (nitrogenRapidDrop) riskScore += 2;
  if (moistureRapidDrop) riskScore += 2;
  if (getSlopeLabel(nitrogenSeries) === "decreasing") riskScore += 1;
  if (getSlopeLabel(moistureSeries) === "decreasing") riskScore += 1;

  let riskLevel = "low";
  if (riskScore >= 4) riskLevel = "high";
  else if (riskScore >= 2) riskLevel = "medium";

  return {
    nitrogenTrend: getSlopeLabel(nitrogenSeries),
    moistureTrend: getSlopeLabel(moistureSeries),
    movingAverage: {
      moisture: movingAverage(moistureSeries, 3),
      N: movingAverage(nitrogenSeries, 3),
      P: movingAverage(phosphorusSeries, 3),
      K: movingAverage(potassiumSeries, 3),
    },
    rapidDrop: {
      nitrogen: nitrogenRapidDrop,
      moisture: moistureRapidDrop,
    },
    riskLevel,
  };
};
