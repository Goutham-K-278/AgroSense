const safeNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toPercent = (value) => Number(safeNumber(value, 0).toFixed(1));
const toValue = (value) => Number(safeNumber(value, 0).toFixed(1));

const buildAlert = ({ type, title, message, priority, actionDeadlineHours }) => ({
  id: `${Date.now()}-${type}-${Math.random().toString(36).slice(2, 7)}`,
  type,
  title,
  message,
  priority,
  actionDeadlineHours,
  createdAt: new Date().toISOString(),
  createdAtEpoch: Date.now(),
});

const nutrientLabels = {
  N: "Nitrogen",
  P: "Phosphorus",
  K: "Potassium",
};

const nutrientPriorityTitles = {
  high: "Critical Low",
  medium: "Low",
  low: "Slight Dip",
};

const nutrientActionWindows = {
  high: 36,
  medium: 72,
  low: 120,
};

const resolvePriorityFromStatus = (status) => {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "deficient") return "high";
  if (normalized === "moderate") return "medium";
  return null;
};

const resolvePriorityFromDeficit = (percent) => {
  const value = safeNumber(percent, 0);
  if (value >= 30) return "high";
  if (value >= 15) return "medium";
  if (value >= 8) return "low";
  return null;
};

const nutrientGuidance = {
  high: "Apply the recommended correction dose immediately.",
  medium: "Plan corrective application within the next 2-3 days.",
  low: "Schedule a maintenance feed and recheck levels.",
};

const buildNutrientAlerts = ({ deficiency = {}, npkStatus = {}, npkValues = {} } = {}) => {
  const nutrientAlerts = [];
  ["N", "P", "K"].forEach((nutrient) => {
    const profile = deficiency?.[nutrient];
    if (!profile) return;

    const percent = safeNumber(profile?.deficiencyPercent);
    const percentPriority = resolvePriorityFromDeficit(percent);
    const statusPriority = resolvePriorityFromStatus(npkStatus?.[nutrient]);
    const priority = percentPriority || statusPriority;
    if (!priority) return;

    const required = toValue(profile?.required);
    const predicted = toValue(profile?.predicted ?? npkValues?.[nutrient]);
    const deficitPercent = toPercent(percent);
    const label = nutrientLabels[nutrient] || nutrient;
    const titleSuffix = nutrientPriorityTitles[priority];
    nutrientAlerts.push(
      buildAlert({
        type: "npk",
        title: `${label} ${titleSuffix}`,
        message: `${label} requirement is ${required} but predicted level is ${predicted}. Deficit is ${deficitPercent}%. ${nutrientGuidance[priority]}`,
        priority,
        actionDeadlineHours: nutrientActionWindows[priority] || 96,
      }),
    );
  });

  return nutrientAlerts;
};

const getMaxDeficiency = (deficiency = {}) => {
  const candidates = [
    { nutrient: "N", value: safeNumber(deficiency?.N?.deficiencyPercent) },
    { nutrient: "P", value: safeNumber(deficiency?.P?.deficiencyPercent) },
    { nutrient: "K", value: safeNumber(deficiency?.K?.deficiencyPercent) },
  ].sort((a, b) => b.value - a.value);

  return candidates[0] || { nutrient: "N", value: 0 };
};

export const generateFarmAlerts = ({
  moisture,
  trendAnalysis,
  soilHealthScore,
  forecastRisk,
  weatherContext,
  weatherAlert,
  weatherRisk,
  deficiency,
  fertilizerPlan,
  npkStatus,
  npkValues,
} = {}) => {
  const alerts = [];

  const currentMoisture = safeNumber(moisture, safeNumber(trendAnalysis?.movingAverage?.moisture, 0));
  const rainfallNext24h = safeNumber(weatherContext?.rainfallNext24h, 0);
  const deficiencyPeak = getMaxDeficiency(deficiency);
  const topDeficit = safeNumber(deficiencyPeak?.value, 0);
  const soilScore = safeNumber(soilHealthScore, 70);
  const nutrientAlerts = buildNutrientAlerts({ deficiency, npkStatus, npkValues });
  alerts.push(...nutrientAlerts);

  const plannedFertilizerQty = [
    safeNumber(fertilizerPlan?.urea),
    safeNumber(fertilizerPlan?.dap),
    safeNumber(fertilizerPlan?.mop),
  ].reduce((sum, value) => sum + value, 0);
  const fertilizerPlannedWithin24h = topDeficit > 20 || plannedFertilizerQty > 0;

  if (currentMoisture < 30 && rainfallNext24h < 5) {
    alerts.push(
      buildAlert({
        type: "irrigation",
        title: "Irrigation Recommended",
        message: `Moisture is ${toPercent(currentMoisture)}%. Rainfall expected is only ${toPercent(
          rainfallNext24h,
        )} mm in next 24h. Start irrigation soon.`,
        priority: "high",
        actionDeadlineHours: 18,
      }),
    );
  }

  if (topDeficit > 20 && nutrientAlerts.length === 0) {
    alerts.push(
      buildAlert({
        type: "fertilizer",
        title: "Fertilizer Application Due",
        message: `${deficiencyPeak.nutrient} deficiency is ${toPercent(
          topDeficit,
        )}%. Apply correction dose as per fertilizer plan within 3 days.`,
        priority: topDeficit >= 30 ? "high" : "medium",
        actionDeadlineHours: 72,
      }),
    );
  }

  if (rainfallNext24h >= 10 && fertilizerPlannedWithin24h) {
    alerts.push(
      buildAlert({
        type: "weather",
        title: "Heavy Rain Expected",
        message: `Forecast rain is ${toPercent(
          rainfallNext24h,
        )} mm in next 24h. Delay fertilizer application to avoid nutrient loss.`,
        priority: "high",
        actionDeadlineHours: 24,
      }),
    );
  }

  if (soilScore < 60) {
    alerts.push(
      buildAlert({
        type: "soil",
        title: "Soil Health Declining",
        message: `Soil health score is ${toPercent(
          soilScore,
        )}. Investigate nutrient imbalance and improve organic matter input.`,
        priority: soilScore < 50 ? "high" : "medium",
        actionDeadlineHours: 48,
      }),
    );
  }

  if (String(forecastRisk || "").toLowerCase() === "high") {
    alerts.push(
      buildAlert({
        type: "deadline",
        title: "Action Window Narrow",
        message: "Forecast risk is high for upcoming cycles. Execute irrigation and fertilizer actions within 24h.",
        priority: "high",
        actionDeadlineHours: 24,
      }),
    );
  }

  const hasWeatherAlert = alerts.some((alert) => alert.type === "weather");
  const advisoryMessage = weatherAlert?.message || weatherRisk?.advisoryMessage;
  if (!hasWeatherAlert && advisoryMessage) {
    const rainSeverity = String(weatherRisk?.rainRiskLevel || "").toUpperCase();
    const humiditySeverity = String(weatherRisk?.humidityRiskLevel || "").toUpperCase();
    const inferredPriority = rainSeverity === "HIGH" ? "high" : rainSeverity === "MODERATE" || humiditySeverity === "HIGH" ? "medium" : "low";
    alerts.push(
      buildAlert({
        type: "weather",
        title: "Weather Advisory",
        message: advisoryMessage,
        priority: inferredPriority,
        actionDeadlineHours: inferredPriority === "high" ? 24 : 48,
      }),
    );
  }

  return alerts;
};

export const sortAlertsByPriority = (alerts = []) => {
  const rank = { high: 3, medium: 2, low: 1 };

  return [...alerts].sort((a, b) => {
    const priorityDelta = safeNumber(rank[b?.priority], 0) - safeNumber(rank[a?.priority], 0);
    if (priorityDelta !== 0) return priorityDelta;
    return safeNumber(b?.createdAtEpoch, 0) - safeNumber(a?.createdAtEpoch, 0);
  });
};
