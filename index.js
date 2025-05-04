// index.js
const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const admin   = require('firebase-admin');

// --- 1) Initialize Firebase Admin SDK for Realtime Database ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  // ◉◉◉ Replace <YOUR-PROJECT> with your actual project ID:
  databaseURL: "https://ctx-e3-default-rtdb.firebaseio.com"
});
const db = admin.database();  // ← was admin.firestore()

// --- 2) Express setup with CORS and JSON parsing ---
const app = express();

// Allow all origins
app.use(cors());
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

  // Stage 2: Async write to Realtime Database
  (async () => {
    try {
      const ref = db.ref(`participants/${participantId}/trials`).push();
      await ref.set(trialData);
      console.log(`RTDB trial write complete for ${participantId}`);
    } catch (e) {
      console.error(`RTDB trial write failed for ${participantId}:`, e);
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

  // Stage 2: Async batch write each trial into RTDB under /participants_finished
  (async () => {
    try {
      const baseRef = db.ref(`participants_finished/${participantId}/final_trials`);
      // RTDB has no batch, so we do individual pushes (you could optimize with multi-path updates)
      for (const trial of allTrialData) {
        const ref = baseRef.push();
        await ref.set({
          ...trial,
          timestamp: admin.database.ServerValue.TIMESTAMP
        });
      }
      console.log(`✅ All final trials written for ${participantId}`);
    } catch (e) {
      console.error(`RTDB final-trials write failed for ${participantId}:`, e);
    }

    // Stage 3: Async write summary metadata (merge)
    try {
      const summaryRef = db.ref(`participants_finished/${participantId}/summary`);
      await summaryRef.update({
        subject_id: participantId,
        final_save_status: 'completed',
        final_save_timestamp: admin.database.ServerValue.TIMESTAMP,
        ...(typeof saveDurationMs === 'number' && { final_save_duration_ms: saveDurationMs })
      });
      console.log(`RTDB summary write complete for ${participantId}`);
    } catch (e) {
      console.error(`RTDB summary write failed for ${participantId}:`, e);
    }
  })();
});

// === Start server ===
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
