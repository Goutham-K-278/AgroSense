# Agro-Sense Deployment Report

Date: 2026-03-16
Public URL: https://agrosense.mooo.com/

## 1) Fixes Completed in Code

1. Removed backend root JSON route so frontend static serving handles "/".
- File: backend/server.js
- Evidence: only /api/health route remains; static frontend fallback block serves index.html for non-/api paths.

2. Disabled ONNX inference selection and forced TensorFlow H5 inference.
- File: backend/server.js
- Changes:
  - DISEASE_INFERENCE_ENGINE forced to "tensorflow"
  - USE_ONNX_DISEASE_INFERENCE forced to false
- Result: backend now uses crop_disease_model.h5 path and TensorFlow scripts.

## 2) Current Production Issues Observed

1. 401 Unauthorized on protected endpoints
- Endpoints: /api/alerts, /api/crop-diagnosis
- Browser evidence: network 401 responses and UI message "Unauthorized: invalid or expired token."

2. Weather page error: missing OpenWeather key
- UI message: "Missing OpenWeather API key. Set VITE_OPENWEATHER_API_KEY."

## 3) Root-Cause Analysis (with file references)

1. Protected API endpoints require Firebase bearer token verification.
- File: backend/middleware/authMiddleware.js
- Behavior:
  - Requires Authorization: Bearer <token>
  - Returns 401 when token verification fails or token is expired

2. The failing endpoints are intentionally auth-protected.
- File: backend/server.js
- Protected routes include /api/crop-diagnosis and /api/alerts via authGuard.

3. Weather page reads VITE_OPENWEATHER_API_KEY at frontend build/runtime.
- File: frontend/src/pages/Weather.jsx
- If missing during build/deploy, weather UI shows the missing-key error.

4. Current backend service account file appears placeholder/template-like and should be replaced with a real Firebase Admin key for the same Firebase project used by frontend auth.
- File: backend/serviceAccountKey.json
- project_id shows placeholder value.

## 4) Required VM Updates (Exact)

1. Backend Firebase Admin credentials
- Replace backend/serviceAccountKey.json with a real service account JSON from your Firebase project.
- Ensure project matches frontend Firebase project used in frontend/src/firebase.js.

2. Backend environment file
- Update backend/.env:
  - FIREBASE_SERVICE_ACCOUNT_PATH=./serviceAccountKey.json
  - GEMINI_API_KEY=<your_real_key> (if chat needed)
  - OPENWEATHER_API_KEY=<your_real_key> (if backend weather features use it)

3. Frontend environment file
- Update frontend/.env:
  - VITE_API_URL=https://agrosense.mooo.com
  - VITE_OPENWEATHER_API_KEY=<your_real_key>
  - VITE_OPENWEATHER_CITY=<your_default_city>

4. Rebuild frontend (required after any VITE_* change)
- Commands:
  - cd frontend
  - npm run build

5. Restart backend service
- If using Node directly:
  - cd backend
  - npm start
- If using PM2:
  - pm2 restart <your-process-name>
- If using Docker Compose:
  - docker compose up -d --build

6. Post-deploy verification
- Open: https://agrosense.mooo.com/api/health (expect status ok)
- Login in UI and test:
  - Alerts page loads without 401
  - Crop diagnosis works without unauthorized error
  - Weather page shows forecast (no missing key message)

## 5) Recommended Hardening

1. Do not keep real keys committed in repo files.
2. Keep backend/serviceAccountKey.json and .env files excluded from git.
3. Rotate exposed API keys if they were shared publicly.
4. Keep one consistent API base URL source to avoid mismatched environments.

## 6) Summary

Code-side fixes requested were completed:
- frontend route serving precedence fixed
- ONNX path disabled to force H5 TensorFlow path

Remaining production errors are deployment/config issues (auth credentials and missing frontend weather env), not route/inference code defects.
