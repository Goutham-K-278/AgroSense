const WEATHER_DESC_TA = {
  'few clouds': 'சிறிய மேகங்கள்',
  'scattered clouds': 'சிதறிய மேகங்கள்',
  'broken clouds': 'மேக மூட்டம்',
  'overcast clouds': 'மிகுந்த மேக மூட்டம்',
  'clear sky': 'வானம் தெளிவு',
  mist: 'மூடுபனி',
  haze: 'மூடுபனி',
  fog: 'மூடுபனி',
  drizzle: 'சிறிய தூறல்',
  rain: 'மழை',
  'light rain': 'இலகு மழை',
  'moderate rain': 'மிதமான மழை',
  'heavy intensity rain': 'கனமழை',
  thunderstorm: 'இடி மின்னல் மழை',
}

const CROP_NAME_TA = {
  Rice: 'நெல்',
  Wheat: 'கோதுமை',
  Maize: 'சோளம்',
  Cotton: 'பருத்தி',
  Groundnut: 'வேர்க்கடலை',
  Banana: 'வாழை',
  Sugarcane: 'கரும்பு',
  Vegetables: 'காய்கறிகள்',
  Potato: 'உருளைக்கிழங்கு',
  Corn: 'மக்காச்சோளம்',
}

const sentenceReplacementsTa = [
  [/Clear sky expected tomorrow\. Continue normal irrigation schedule\./gi, 'நாளை வானம் தெளிவாக இருக்கும். வழக்கமான நீர்ப்பாசன அட்டவணையை தொடருங்கள்.'],
  [/Low risk: soil is stable now\. Continue routine monitoring and crop-stage nutrient plan\./gi, 'குறைந்த அபாயம்: மண் நிலைமை சீராக உள்ளது. வழக்கமான கண்காணிப்பையும் பயிர் நிலைக்கு ஏற்ப உர திட்டத்தையும் தொடருங்கள்.'],
  [/Detected nutrient deficiency\. Crop-factor based recommendation per acre:/gi, 'ஊட்டச்சத்து குறைவு கண்டறியப்பட்டது. ஏக்கருக்கு பரிந்துரை:'],
]

const phraseReplacementsTa = [
  [/Rainfall is expected/gi, 'மழை எதிர்பார்க்கப்படுகிறது'],
  [/in next 24h/gi, 'அடுத்த 24 மணி நேரத்தில்'],
  [/Delay irrigation/gi, 'நீர்ப்பாசனத்தை தாமதிக்கவும்'],
  [/monitor field moisture after rain/gi, 'மழைக்குப் பின் நில ஈரப்பதத்தை கண்காணிக்கவும்'],
  [/Moderate rain forecast tomorrow/gi, 'நாளை மிதமான மழை முன்னறிவு'],
  [/Adjust irrigation schedule/gi, 'நீர்ப்பாசன அட்டவணையை மாற்றவும்'],
  [/monitor runoff/gi, 'நீர் ஓட்டத்தை கவனிக்கவும்'],
  [/Phosphorus requirement is/gi, 'பாஸ்பரஸ் தேவையான அளவு'],
  [/but predicted level is/gi, 'ஆனால் கணிக்கப்பட்ட அளவு'],
  [/Deficit is/gi, 'குறைவு'],
  [/Schedule a maintenance feed and recheck levels\./gi, 'பராமரிப்பு உரம் கொடுத்து மீண்டும் அளவை சரிபார்க்கவும்.'],
  [/Plan corrective application within the next 2-3 days\./gi, 'அடுத்த 2-3 நாட்களில் திருத்த உரம் அளிக்க திட்டமிடவும்.'],
  [/N deficiency is/gi, 'நைட்ரஜன் குறைவு'],
  [/Apply correction dose as per fertilizer plan within/gi, 'உரம் திட்டப்படி திருத்த அளவை'],
  [/days\./gi, 'நாட்களில் பயன்படுத்தவும்.'],
  [/Weather Advisory/gi, 'வானிலை ஆலோசனை'],
  [/Phosphorus Slight Dip/gi, 'பாஸ்பரஸ் சற்று குறைவு'],
  [/Phosphorus Low/gi, 'பாஸ்பரஸ் குறைவு'],
  [/Fertilizer Application Due/gi, 'உரம் இட வேண்டியது'],
]

const localizeWeatherDescription = (description = '', language = 'en') => {
  if (language !== 'ta') return description
  const key = String(description || '').trim().toLowerCase()
  return WEATHER_DESC_TA[key] || description
}

const localizeCropName = (name = '', language = 'en') => {
  if (language !== 'ta') return name
  return CROP_NAME_TA[name] || name
}

const localizeFarmText = (input = '', language = 'en') => {
  const text = String(input || '')
  if (!text || language !== 'ta') return text

  let output = text
  sentenceReplacementsTa.forEach(([pattern, replacement]) => {
    output = output.replace(pattern, replacement)
  })

  phraseReplacementsTa.forEach(([pattern, replacement]) => {
    output = output.replace(pattern, replacement)
  })

  return output
}

export { localizeFarmText, localizeWeatherDescription, localizeCropName }