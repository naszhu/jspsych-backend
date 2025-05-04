// index.js
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { Storage } = require('@google-cloud/storage');

// --- load and parse your Render environment variable for Firebase service account ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

// --- initialize Firebase Admin SDK ---
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// --- initialize Google Cloud Storage client ---
const storage = new Storage({
  projectId: serviceAccount.project_id,
  credentials: serviceAccount
});
const bucket = storage.bucket('ctx-e3-data-export');

// --- set up Express ---
const app = express();
app.use(cors({ origin: 'http://localhost:8080' }));
app.options('*', cors());
app.use(express.json({ limit: '50mb' }));

// POST endpoint: save experiment data
app.post('/save-final-data', (req, res) => {
  const { participantId, allTrialData } = req.body;
  if (!participantId) {
    return res.status(400).json({ error: 'Missing participantId' });
  }

  // --- Stage 1: quick local write to disk ---
  const dataDir = path.join(__dirname, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const fileNameLocal = `${participantId}-${Date.now()}.json`;
  const filePathLocal = path.join(dataDir, fileNameLocal);
  try {
    fs.writeFileSync(filePathLocal, JSON.stringify(req.body));
  } catch (err) {
    console.error('Local write error:', err);
    return res.status(500).json({ error: 'Failed to save locally' });
  }

  // ACK back to the browser so your experiment can continue
  res.status(200).json({ message: 'Saved to Render datastore.' });

  // --- Stage 2: background Firestore writes (split per trial) ---
  (async () => {
    console.log(`Starting Firestore write for ${participantId}`);
    try {
      const BATCH_SIZE = 500;
      for (let i = 0; i < allTrialData.length; i += BATCH_SIZE) {
        const batch = db.batch();
        const chunk = allTrialData.slice(i, i + BATCH_SIZE);
        chunk.forEach(trial => {
          const docRef = db
            .collection('participants_finished')
            .doc(participantId)
            .collection('final_trials')
            .doc();
          batch.set(docRef, {
            ...trial,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
          });
        });
        await batch.commit();
        console.log(`Batch ${i / BATCH_SIZE + 1} committed (${chunk.length} trials)`);
      }
      console.log(`✅ All trials written for ${participantId}`);
    } catch (e) {
      console.error(`❌ Firestore write failed for ${participantId}:`, e);
    }
  })();

  // --- Stage 3: background Cloud Storage blob write ---
  (async () => {
    try {
      const nowIso = new Date().toISOString().replace(/[:.]/g, '_');
      const fileName = `${participantId}/${nowIso}.json`;
      const file = bucket.file(fileName);
      await file.save(JSON.stringify({ trials: allTrialData }), {
        contentType: 'application/json'
      });
      console.log(`✅ Saved blob to gs://${bucket.name}/${fileName}`);

      // optional: log blob path in Firestore
      await db
        .collection('participants_finished')
        .doc(participantId)
        .collection('data_blobs')
        .add({
          storagePath: fileName,
          bucket: bucket.name,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
      console.log(`✅ Logged blob path in Firestore for ${participantId}`);
    } catch (e) {
      console.error(`❌ Cloud Storage write failed for ${participantId}:`, e);
    }
  })();
});

// start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
