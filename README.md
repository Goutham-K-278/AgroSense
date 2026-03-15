# Agro-Sense

Agro-Sense is a full-stack smart agriculture platform for farmers and agronomy workflows.

It combines:

- Real-time and historical farm/sensor insights
- NPK prediction and fertilizer planning
- Crop recommendation and disease diagnosis
- Alerts and weather-aware advisories
- A bilingual (English/Tamil) AI assistant chat

The project uses a React + Vite frontend, an Express backend, Firebase services, and Python ML scripts for crop disease tasks.

---

## 1) Architecture

### System Architecture (PNG)

![Agro-Sense Architecture PNG](images/AgroSence.drawio.png)

---

## 2) Tech Stack

### Frontend

- React (Vite)
- Tailwind CSS
- Framer Motion
- React Router
- i18next (Tamil/English)
- Firebase client SDK (Auth, Firestore, Realtime DB, Storage)

### Backend

- Node.js + Express
- nodemon (development auto-reload)
- Firebase Admin SDK
- Google Generative AI SDK (Gemini)
- Web Push notifications
- Multer for image upload
- TensorFlow.js Node runtime
- ML Random Forest (for NPK logic)

### Python ML

- TensorFlow
- TensorFlow.js converter
- NumPy
- Pillow
- tf2onnx
- onnxruntime

### Dev Tooling

- concurrently (root-level parallel frontend + backend dev run)

---

## 3) Repository Structure

```text
Agro-Sense/
|- backend/
|  |- config/
|  |- middleware/
|  |- models/
|  |- scripts/
|  |- services/
|  |- server.js
|  `- requirements.txt
|- frontend/
|  |- public/
|  `- src/
|- Crop___Disease/
|- Data Set/
|- images/
|- Dockerfile
|- docker-compose.yml
`- package.json
```

---

## 4) Prerequisites

Install these first:

1. Node.js 20+
2. Python 3.10 or 3.11
3. Git
4. VS Code (recommended)

Optional but commonly needed:

- Firebase project (Auth/Admin + DB)
- OpenWeather API key
- Gemini API key

---

## 5) Quick Start (Windows PowerShell)

```powershell
git clone https://github.com/Goutham-K-278/AgroSense.git
cd Agro-Sense
npm install
cd backend
npm install
cd ..\frontend
npm install
cd ..
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install --upgrade pip
pip install -r backend\requirements.txt
Copy-Item backend/.env.example backend/.env
Copy-Item frontend/.env.example frontend/.env
npm run dev
```

Frontend default URL: `http://localhost:5173`

Backend default URL: `http://localhost:5000`

---

## 6) Environment Variables

Templates included:

- `backend/.env.example`
- `frontend/.env.example`

Create local files:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

Update values before production use.

Do not commit secrets.

Recommended backend Firebase env names:

```env
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxx@your-project-id.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYOUR_PRIVATE_KEY_CONTENT\n-----END PRIVATE KEY-----\n"
FIREBASE_DATABASE_URL=https://your-project-id-default-rtdb.firebaseio.com
FIREBASE_SENSOR_PATH=sensor
```

`FIREBASE_SERVICE_ACCOUNT_JSON` and `FIREBASE_SERVICE_ACCOUNT_PATH` are still supported as fallbacks.

---

## 7) Production Deployment (Docker)

Build image:

```bash
docker build -t agrosense:latest .
```

Run container with backend env file:

```bash
docker run --rm -p 5000:5000 --env-file backend/.env agrosense:latest
```

Use local build + run via Compose:

```bash
docker compose up --build -d
```

Use GHCR production image via Compose:

```bash
cp .env.production.example .env
# fill in real values in .env first
docker compose -f docker-compose.prod.yml up -d
```

---

## 8) CI/CD

Workflows in `.github/workflows/`:

- `ci.yml`: installs deps, builds frontend, validates Python scripts, validates compose config, and builds Docker image with Buildx cache
- `deploy-container.yml`: publishes image to GHCR after successful CI on `main` (or manual dispatch), then optionally triggers `DEPLOY_WEBHOOK_URL`

Published image tags include:

- `ghcr.io/goutham-k-278/agrosense:latest` (default branch)
- `ghcr.io/goutham-k-278/agrosense:sha-<commit>`

---

## 9) ONNX Model Optimization

Convert Keras model to ONNX:

```bash
npm run convert-model:onnx
```

Generated file:

- `backend/models/crop_disease_model.onnx`

Use ONNX inference engine:

- `DISEASE_INFERENCE_ENGINE=onnx`

Backend supports persistent ONNX daemon for lower latency:

- `backend/scripts/predict_crop_disease_onnx_daemon.py`

---

## 12) Key API Endpoints

- `GET /api/health`
- `POST /api/crop-diagnosis` (auth)
- `POST /api/predict-npk` (auth)
- `POST /api/fertilizer/plan` (auth)
- `POST /api/crop/recommend` (auth)
- `GET /api/alerts` (auth)
- `POST /chat`

---

## 10) Production Checklist

1. Rotate and secure Firebase keys if previously exposed.
2. Keep secrets only in env or secret manager.
3. Set `DISEASE_INFERENCE_ENGINE=onnx` for faster CPU inference.
4. Validate `GET /api/health` after deployment.
5. Test weather, diagnosis upload, and auth-protected endpoints.
6. Confirm CI and deploy workflows are green.

---

## 11) Useful Scripts

From project root:

- `npm run dev`
- `npm run backend`
- `npm run frontend`
- `npm run convert-model`
- `npm run convert-model:onnx`
- `npm run docker:build`
- `npm run docker:run`
- `npm run docker:compose:up`
- `npm run docker:compose:down`
- `npm run docker:compose:prod:up`
- `npm run docker:compose:prod:down`
- `npm run setup:ubuntu`
- `npm run setup:copilot-cli`

---
