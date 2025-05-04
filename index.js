// index.js
const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const admin   = require('firebase-admin');

// 1) Init Firebase Admin (Realtime Database)
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://ctx-e3-default-rtdb.firebaseio.com"
});
const db = admin.database();

// 2) Express + CORS + JSON
const app = express();
app.use(cors());
app.options('*', cors());
app.use(express.json({ limit: '50mb' }));

// 3) Save single trial (unchanged)
app.post('/save-trial-data', (req, res) => {
  const { participantId, trialData } = req.body;
  if (!participantId || !trialData) {
    return res.status(400).json({ error: 'Missing participantId or trialData' });
  }

  // Local file backup
  const trialFolder = path.join(__dirname, 'data', 'trials', participantId);
  fs.mkdirSync(trialFolder, { recursive: true });
  fs.writeFileSync(
    path.join(trialFolder, `trial_${Date.now()}.json`),
    JSON.stringify(trialData),
    'utf8'
  );

  res.status(200).json({ message: 'Trial saved locally.' });

  // Async: push to RTDB
  (async () => {
    try {
      const ref = db.ref(`participants/${participantId}/trials`).push();
      await ref.set(trialData);
    } catch (e) {
      console.error(`RTDB trial write failed:`, e);
    }
  })();
});

// 4) Save final data → write the entire array in one go
app.post('/save-final-data', (req, res) => {
  const { participantId, allTrialData, saveDurationMs } = req.body;
  if (!participantId || !Array.isArray(allTrialData)) {
    return res.status(400).json({ error: 'Missing participantId or allTrialData' });
  }

  // Local file backup
  const finalFolder = path.join(__dirname, 'data', 'final', participantId);
  fs.mkdirSync(finalFolder, { recursive: true });
  fs.writeFileSync(
    path.join(finalFolder, `final_${Date.now()}.json`),
    JSON.stringify(allTrialData),
    'utf8'
  );

  res.status(200).json({ message: 'Final data saved locally.' });

  // Async: single .set() of the whole array
  (async () => {
    try {
      const trialsRef = db.ref(`participants_finished/${participantId}/all_trials`);
      await trialsRef.set({
        trials:   allTrialData,
        saved_at: admin.database.ServerValue.TIMESTAMP
      });
      // summary metadata
      const summaryRef = db.ref(`participants_finished/${participantId}/summary`);
      await summaryRef.update({
        subject_id:             participantId,
        final_save_status:      'completed',
        final_save_timestamp:   admin.database.ServerValue.TIMESTAMP,
        ...(typeof saveDurationMs === 'number' && { final_save_duration_ms: saveDurationMs })
      });
    } catch (e) {
      console.error(`RTDB final write failed:`, e);
    }
  })();
});

// 5) Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
