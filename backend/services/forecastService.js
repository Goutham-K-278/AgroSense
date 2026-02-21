const safeNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toSeries = (records = [], picker) =>
  [...records]
    .sort((a, b) => safeNumber(a.createdAtEpoch) - safeNumber(b.createdAtEpoch))
    .map((item) => safeNumber(picker(item)));

const linearForecast = (series = [], futureSteps = 3) => {
  if (!Array.isArray(series) || series.length === 0) {
    return [];
  }

  if (series.length === 1) {
    return Array.from({ length: futureSteps }, () => Number(series[0].toFixed(2)));
  }

  const n = series.length;
  const xMean = (n - 1) / 2;
  const yMean = series.reduce((sum, value) => sum + value, 0) / n;

  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < n; index += 1) {
    const x = index - xMean;
    numerator += x * (series[index] - yMean);
    denominator += x * x;
  }

  const slope = denominator === 0 ? 0 : numerator / denominator;
  const intercept = yMean - slope * xMean;

  const forecast = [];
  for (let step = 0; step < futureSteps; step += 1) {
    const x = n + step;
    forecast.push(Number((intercept + slope * x).toFixed(2)));
  }

  return forecast;
};

const estimateRisk = ({ moistureForecast = [], nForecast = [], trendRisk = "low" }) => {
  let score = trendRisk === "high" ? 2 : trendRisk === "medium" ? 1 : 0;

  if (moistureForecast.length >= 2 && moistureForecast[moistureForecast.length - 1] < moistureForecast[0] * 0.88) {
    score += 2;
  }

  if (nForecast.length >= 2 && nForecast[nForecast.length - 1] < nForecast[0] * 0.85) {
    score += 2;
  }

  if (moistureForecast.some((value) => value < 28)) {
    score += 1;
  }

  if (score >= 4) return "high";
  if (score >= 2) return "medium";
  return "low";
};

export const buildForecast = ({ historyRecords = [], trendAnalysis }) => {
  const recent = [...historyRecords]
    .sort((a, b) => safeNumber(b.createdAtEpoch) - safeNumber(a.createdAtEpoch))
    .slice(0, 7)
    .reverse();

  const nitrogenSeries = toSeries(recent, (item) => item.predictedN);
  const phosphorusSeries = toSeries(recent, (item) => item.predictedP);
  const potassiumSeries = toSeries(recent, (item) => item.predictedK);
  const moistureSeries = toSeries(recent, (item) => item.moisture);

  const forecast = {
    next3Cycles: {
      N: linearForecast(nitrogenSeries, 3),
      P: linearForecast(phosphorusSeries, 3),
      K: linearForecast(potassiumSeries, 3),
      moisture: linearForecast(moistureSeries, 3),
    },
  };

  forecast.forecastRisk = estimateRisk({
    moistureForecast: forecast.next3Cycles.moisture,
    nForecast: forecast.next3Cycles.N,
    trendRisk: trendAnalysis?.riskLevel || "low",
  });

  return forecast;
};
