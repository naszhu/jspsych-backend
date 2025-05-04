// index.js
const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const admin   = require('firebase-admin');

// --- 1) Initialize Firebase Admin SDK ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// --- 2) Express setup with CORS and JSON parsing ---
const app = express();
app.use(cors({ origin: 'http://localhost:8080' }));
app.options('*', cors());
app.use(express.json({ limit: '50mb' }));

// === Endpoint: Save single trial ===
app.post('/save-trial-data', (req, res) => {
  const { participantId, trialData } = req.body;
  if (!participantId || !trialData) {
    return res.status(400).json({ error: 'Missing participantId or trialData' });
  }

  // Stage 1: Write to local file (milliseconds)
  const trialFolder = path.join(__dirname, 'data', 'trials', participantId);
  fs.mkdirSync(trialFolder, { recursive: true });
  const trialFile = `trial_${Date.now()}.json`;
  try {
    fs.writeFileSync(
      path.join(trialFolder, trialFile),
      JSON.stringify(trialData),
      'utf8'
    );
  } catch (e) {
    console.error('Local trial write error:', e);
    return res.status(500).json({ error: 'Failed to save trial locally' });
  }

  // Respond immediately
  res.status(200).json({ message: 'Trial saved locally.' });

  // Stage 2: Async write to Firestore
  (async () => {
    try {
      const colRef = db
        .collection('participants')
        .doc(participantId)
        .collection('trials_backup');
      await colRef.add(trialData);
      console.log(`Firestore trial write complete for ${participantId}`);
    } catch (e) {
      console.error(`Firestore trial write failed for ${participantId}:`, e);
    }
  })();
});

// === Endpoint: Save final data ===
app.post('/save-final-data', (req, res) => {
  const { participantId, allTrialData, saveDurationMs } = req.body;
  if (!participantId || !Array.isArray(allTrialData)) {
    return res.status(400).json({ error: 'Missing participantId or allTrialData' });
  }

  // Stage 1: Write final payload to local file
  const finalFolder = path.join(__dirname, 'data', 'final', participantId);
  fs.mkdirSync(finalFolder, { recursive: true });
  const finalFile = `final_${Date.now()}.json`;
  try {
    fs.writeFileSync(
      path.join(finalFolder, finalFile),
      JSON.stringify(allTrialData),
      'utf8'
    );
  } catch (e) {
    console.error('Local final write error:', e);
    return res.status(500).json({ error: 'Failed to save final data locally' });
  }

  // Respond immediately
  res.status(200).json({ message: 'Final data saved locally.' });

  // Stage 2: Async batch write each trial into Firestore subcollection
  (async () => {
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
        console.log(
          `Firestore final batch ${i / BATCH_SIZE + 1} committed (${chunk.length} docs)`
        );
      }
      console.log(`✅ All final trials written for ${participantId}`);
    } catch (e) {
      console.error(`Firestore final-trials write failed for ${participantId}:`, e);
    }

    // Stage 3: Async write summary metadata (merge)
    try {
      const summaryRef = db
        .collection('participants_finished')
        .doc(participantId);
      await summaryRef.set(
        {
          subject_id: participantId,
          final_save_status: 'completed',
          final_save_timestamp: admin.firestore.FieldValue.serverTimestamp(),
          ...(typeof saveDurationMs === 'number' && { final_save_duration_ms: saveDurationMs })
        },
        { merge: true }
      );
      console.log(`Firestore summary write complete for ${participantId}`);
    } catch (e) {
      console.error(`Firestore summary write failed for ${participantId}:`, e);
    }
  })();
});

// === Start server ===
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
