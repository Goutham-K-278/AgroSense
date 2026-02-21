const OPENWEATHER_BASE_URL = "https://api.openweathermap.org/data/2.5";
const OPEN_METEO_BASE_URL = "https://api.open-meteo.com/v1/forecast";
const OPEN_METEO_GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const WEATHER_TIMEOUT_MS = Number(process.env.WEATHER_TIMEOUT_MS || 1200);
const WEATHER_CACHE_TTL_MS = Number(process.env.WEATHER_CACHE_TTL_MS || 10 * 60 * 1000);
const weatherCache = new Map();

const safeNumber = (value, fallback = null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toIsoDate = (unixSeconds) => {
  if (!Number.isFinite(unixSeconds)) return null;
  return new Date(unixSeconds * 1000).toISOString();
};

const toDateKeyWithOffset = (unixSeconds, offsetSeconds = 0) => {
  const timestampMs = Number(unixSeconds) * 1000;
  if (!Number.isFinite(timestampMs)) return null;

  const shifted = new Date(timestampMs + safeNumber(offsetSeconds, 0) * 1000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const getTomorrowDateKey = (offsetSeconds = 0) => {
  const nowShifted = new Date(Date.now() + safeNumber(offsetSeconds, 0) * 1000);
  const tomorrowShifted = new Date(nowShifted.getTime() + 24 * 60 * 60 * 1000);
  const year = tomorrowShifted.getUTCFullYear();
  const month = String(tomorrowShifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(tomorrowShifted.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const getTomorrowForecastSummary = (forecastList = [], timezoneOffsetSeconds = 0) => {
  const tomorrowKey = getTomorrowDateKey(timezoneOffsetSeconds);
  const tomorrowEntries = forecastList.filter(
    (item) => toDateKeyWithOffset(item?.dt, timezoneOffsetSeconds) === tomorrowKey,
  );

  if (tomorrowEntries.length === 0) {
    return {
      tomorrowKey,
      rainfallNext24h: 0,
      avgHumidityTomorrow: 0,
      dominantConditionCode: 800,
      precipitationProbabilityAvg: 0,
      tomorrowDescription: "clear sky",
      tomorrowEntries,
    };
  }

  const rainfallNext24h = Number(
    tomorrowEntries.reduce((sum, item) => sum + safeNumber(item?.rain?.["3h"], 0), 0).toFixed(2),
  );

  const avgHumidityTomorrow = Number(
    (
      tomorrowEntries.reduce((sum, item) => sum + safeNumber(item?.main?.humidity, 0), 0) /
      tomorrowEntries.length
    ).toFixed(2),
  );

  const precipitationProbabilityAvg = Number(
    (
      (tomorrowEntries.reduce((sum, item) => sum + safeNumber(item?.pop, 0), 0) / tomorrowEntries.length) *
      100
    ).toFixed(2),
  );

  const conditionCounts = new Map();
  for (const item of tomorrowEntries) {
    const code = safeNumber(item?.weather?.[0]?.id, 800);
    conditionCounts.set(code, (conditionCounts.get(code) || 0) + 1);
  }

  const dominantConditionCode = Number(
    [...conditionCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 800,
  );

  const representative = tomorrowEntries.find(
    (item) => safeNumber(item?.weather?.[0]?.id, 800) === dominantConditionCode,
  );

  return {
    tomorrowKey,
    rainfallNext24h,
    avgHumidityTomorrow,
    dominantConditionCode,
    precipitationProbabilityAvg,
    tomorrowDescription: String(representative?.weather?.[0]?.description || "clear sky").toLowerCase(),
    tomorrowEntries,
  };
};

const topThreeDayBuckets = (forecastList = []) => {
  const buckets = new Map();

  for (const item of forecastList) {
    const timestampMs = Number(item?.dt) * 1000;
    if (!Number.isFinite(timestampMs)) continue;

    const dayKey = new Date(timestampMs).toISOString().slice(0, 10);
    if (!buckets.has(dayKey)) {
      buckets.set(dayKey, {
        day: dayKey,
        rainfallMm: 0,
        avgHumidity: 0,
        avgTemperature: 0,
        count: 0,
      });
    }

    const bucket = buckets.get(dayKey);
    bucket.rainfallMm += safeNumber(item?.rain?.["3h"], 0);
    bucket.avgHumidity += safeNumber(item?.main?.humidity, 0);
    bucket.avgTemperature += safeNumber(item?.main?.temp, 0);
    bucket.count += 1;
  }

  return [...buckets.values()]
    .slice(0, 3)
    .map((bucket) => ({
      day: bucket.day,
      rainfallMm: Number(bucket.rainfallMm.toFixed(2)),
      humidity: Number((bucket.avgHumidity / Math.max(bucket.count, 1)).toFixed(2)),
      temperature: Number((bucket.avgTemperature / Math.max(bucket.count, 1)).toFixed(2)),
    }));
};

const fetchCurrentAndForecast = async ({ apiKey, city, lat, lon }) => {
  const byCoordinates = Number.isFinite(lat) && Number.isFinite(lon);
  const queryParam = byCoordinates ? `lat=${lat}&lon=${lon}` : `q=${encodeURIComponent(city)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS);

  try {
    const [currentResponse, forecastResponse] = await Promise.all([
      fetch(`${OPENWEATHER_BASE_URL}/weather?${queryParam}&appid=${apiKey}&units=metric`, { signal: controller.signal }),
      fetch(`${OPENWEATHER_BASE_URL}/forecast?${queryParam}&appid=${apiKey}&units=metric`, { signal: controller.signal }),
    ]);

    if (!currentResponse.ok || !forecastResponse.ok) {
      const currentError = await currentResponse.text();
      const forecastError = await forecastResponse.text();
      throw new Error(`OpenWeather request failed: current=${currentResponse.status} forecast=${forecastResponse.status} details=${currentError} ${forecastError}`);
    }

    const current = await currentResponse.json();
    const forecast = await forecastResponse.json();

    return { current, forecast };
  } finally {
    clearTimeout(timer);
  }
};

const getCacheKey = ({ city, lat, lon }) => {
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return `coords:${lat.toFixed(3)},${lon.toFixed(3)}`;
  }
  return `city:${String(city || "unknown").toLowerCase()}`;
};

const getCachedWeather = (cacheKey) => {
  const cached = weatherCache.get(cacheKey);
  if (!cached) return null;

  if (Date.now() - cached.cachedAtMs > WEATHER_CACHE_TTL_MS) {
    weatherCache.delete(cacheKey);
    return null;
  }

  return cached.data;
};

const cacheWeather = (cacheKey, data) => {
  weatherCache.set(cacheKey, {
    cachedAtMs: Date.now(),
    data,
  });
};

const fetchJsonWithTimeout = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Request failed (${response.status}) for ${url}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
};

const resolveCoordinatesForCity = async (city) => {
  if (!city) {
    return null;
  }

  try {
    const geoUrl = `${OPEN_METEO_GEOCODE_URL}?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
    const payload = await fetchJsonWithTimeout(geoUrl);
    const first = Array.isArray(payload?.results) ? payload.results[0] : null;
    if (!first) {
      return null;
    }

    return {
      latitude: safeNumber(first.latitude),
      longitude: safeNumber(first.longitude),
      name: first.name || city,
    };
  } catch (error) {
    console.warn("Geocoding fallback failed:", error?.message || error);
    return null;
  }
};

const fetchOpenMeteoWeather = async ({ city, lat, lon }) => {
  let latitude = safeNumber(lat);
  let longitude = safeNumber(lon);
  let resolvedCity = city;

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    const coords = await resolveCoordinatesForCity(city);
    latitude = safeNumber(coords?.latitude);
    longitude = safeNumber(coords?.longitude);
    resolvedCity = coords?.name || city;
  }

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error("Unable to resolve coordinates for Open-Meteo fallback.");
  }

  const params = new URLSearchParams({
    latitude: latitude.toFixed(3),
    longitude: longitude.toFixed(3),
    current: "temperature_2m,relative_humidity_2m,precipitation",
    hourly: "relative_humidity_2m,precipitation",
    forecast_days: "3",
    timezone: "auto",
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS);
  try {
    const response = await fetch(`${OPEN_METEO_BASE_URL}?${params.toString()}`, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Open-Meteo request failed: ${response.status}`);
    }

    const payload = await response.json();
    const current = payload?.current || {};
    const hourly = payload?.hourly || {};
    const hourlyPrecipitation = Array.isArray(hourly?.precipitation) ? hourly.precipitation : [];
    const hourlyHumidity = Array.isArray(hourly?.relative_humidity_2m) ? hourly.relative_humidity_2m : [];

    const rainfallNext24h = Number(
      hourlyPrecipitation.slice(0, 24).reduce((sum, value) => sum + safeNumber(value, 0), 0).toFixed(2),
    );

    const tomorrowHumiditySlice = hourlyHumidity.slice(24, 48);
    const avgHumidityTomorrow = Number(
      (
        tomorrowHumiditySlice.reduce((sum, value) => sum + safeNumber(value, 0), 0) /
        Math.max(tomorrowHumiditySlice.length || 1, 1)
      ).toFixed(2),
    );

    return {
      available: true,
      source: "open-meteo",
      location: resolvedCity,
      humidity: safeNumber(current?.relative_humidity_2m),
      temperature: safeNumber(current?.temperature_2m),
      rainfallCurrent: safeNumber(current?.precipitation, 0),
      rainfallNext24h,
      precipitationProbability: null,
      avgHumidityTomorrow,
      dominantConditionCode: 800,
      precipitationProbabilityAvg: null,
      tomorrowDateKey: getTomorrowDateKey(),
      conditionCode: 800,
      description: String(payload?.daily?.weathercode?.[0] ?? "clear sky").toLowerCase(),
      forecast3Days: [],
      shouldDelayIrrigation: rainfallNext24h > 10,
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
};

const defaultWeatherContext = (location, reason = "Weather unavailable") => ({
  available: false,
  source: "fallback",
  reason,
  location,
  humidity: null,
  temperature: null,
  rainfallCurrent: 0,
  rainfallNext24h: 0,
  precipitationProbability: 0,
  avgHumidityTomorrow: 0,
  dominantConditionCode: 800,
  precipitationProbabilityAvg: 0,
  tomorrowDateKey: null,
  conditionCode: 800,
  description: "clear sky",
  forecast3Days: [],
  shouldDelayIrrigation: false,
  fetchedAt: new Date().toISOString(),
});

export const getWeatherContext = async ({ location, lat, lon } = {}) => {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  const resolvedCity =
    typeof location === "string" && location.trim() && location.trim().toLowerCase() !== "field"
      ? location.trim()
      : process.env.DEFAULT_WEATHER_CITY || "Chennai";
  const latitude = safeNumber(lat);
  const longitude = safeNumber(lon);
  const cacheKey = getCacheKey({ city: resolvedCity, lat: latitude, lon: longitude });

  const buildFallback = async (reason) => {
    try {
      const fallback = await fetchOpenMeteoWeather({ city: resolvedCity, lat: latitude, lon: longitude });
      if (fallback) {
        cacheWeather(cacheKey, fallback);
        return fallback;
      }
    } catch (fallbackError) {
      console.warn("Open-Meteo fallback failed:", fallbackError?.message || fallbackError);
    }

    const cached = getCachedWeather(cacheKey);
    if (cached) {
      return { ...cached, source: "cache", cacheFallback: true };
    }

    return defaultWeatherContext(resolvedCity, reason);
  };

  if (!apiKey) {
    return buildFallback("OPENWEATHER_API_KEY missing");
  }

  try {
    const { current, forecast } = await fetchCurrentAndForecast({
      apiKey,
      city: resolvedCity,
      lat: latitude,
      lon: longitude,
    });

    const forecastList = Array.isArray(forecast?.list) ? forecast.list : [];
    const timezoneOffsetSeconds = safeNumber(forecast?.city?.timezone, 0);
    const tomorrowSummary = getTomorrowForecastSummary(forecastList, timezoneOffsetSeconds);
    const rainfallNext24h = tomorrowSummary.rainfallNext24h;
    const rainfallCurrent = safeNumber(current?.rain?.["1h"], 0);
    const precipitationProbability = tomorrowSummary.precipitationProbabilityAvg;
    const conditionCode = safeNumber(tomorrowSummary.dominantConditionCode, 800);
    const description = String(tomorrowSummary.tomorrowDescription || "clear sky").toLowerCase();

    const result = {
      available: true,
      source: "openweather",
      location: current?.name || resolvedCity,
      humidity: safeNumber(current?.main?.humidity),
      temperature: safeNumber(current?.main?.temp),
      rainfallCurrent,
      rainfallNext24h,
      precipitationProbability,
      avgHumidityTomorrow: tomorrowSummary.avgHumidityTomorrow,
      dominantConditionCode: tomorrowSummary.dominantConditionCode,
      precipitationProbabilityAvg: tomorrowSummary.precipitationProbabilityAvg,
      tomorrowDateKey: tomorrowSummary.tomorrowKey,
      conditionCode,
      description,
      forecast3Days: topThreeDayBuckets(forecastList),
      shouldDelayIrrigation: rainfallNext24h > 10,
      fetchedAt: toIsoDate(current?.dt) || new Date().toISOString(),
    };

    cacheWeather(cacheKey, result);
    return result;
  } catch (error) {
    console.error("Weather context fetch error:", error?.message || error);
    return buildFallback(error?.message || "Weather fetch failed");
  }
};
