// index.js
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

// Parse and initialize Firebase service account
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// Express setup
const app = express();
app.use(cors({ origin: 'http://localhost:8080' }));
app.options('*', cors());
app.use(express.json({ limit: '50mb' }));

app.post('/save-final-data', (req, res) => {
  const { participantId, allTrialData, saveDurationMs } = req.body;
  if (!participantId) return res.status(400).json({ error: 'Missing participantId' });

  // Stage 1: quick local write to disk
  const dataDir = path.join(__dirname, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const fileNameLocal = `${participantId}-${Date.now()}.json`;
  try {
    fs.writeFileSync(
      path.join(dataDir, fileNameLocal),
      JSON.stringify({ participantId, allTrialData, saveDurationMs })
    );
  } catch (err) {
    console.error('Local write error:', err);
    return res.status(500).json({ error: 'Local save failed' });
  }

  // Acknowledge immediately
  res.status(200).json({ message: 'Saved locally.' });

  // Stage 2: Firestore writes per trial
  (async () => {
    let status = 'success';
    try {
      const BATCH_SIZE = 500;
      for (let i = 0; i < allTrialData.length; i += BATCH_SIZE) {
        const batch = db.batch();
        allTrialData.slice(i, i + BATCH_SIZE).forEach(trial => {
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
      }
    } catch (e) {
      status = 'failed';
      console.error('Firestore write failed:', e);
    }

    // Stage 3: write metadata under participant doc
    const metadata = {
      subject_id: participantId,
      final_save_status: status,
      final_save_timestamp: admin.firestore.FieldValue.serverTimestamp(),
    };
    // use client-reported duration if provided, else calculate server-side approximate
    if (typeof saveDurationMs === 'number') {
      metadata.save_duration_ms = saveDurationMs;
    }
    try {
      await db
        .collection('participants_finished')
        .doc(participantId)
        .set(metadata, { merge: true });
      console.log(`Metadata saved for ${participantId}`);
    } catch (e) {
      console.error('Metadata write failed:', e);
    }
  })();
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));