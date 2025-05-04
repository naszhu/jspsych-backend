// index.js
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

// Load and parse Firebase service account from Render env var
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

// Initialize Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// Express setup
const app = express();
app.use(cors({ origin: 'http://localhost:8080' }));
app.options('*', cors());
app.use(express.json({ limit: '50mb' }));

// POST endpoint to save experiment data
app.post('/save-final-data', (req, res) => {
  const { participantId, allTrialData } = req.body;
  if (!participantId) {
    return res.status(400).json({ error: 'Missing participantId' });
  }

  // Stage 1: quick local write to disk
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

  // Acknowledge immediately so the experiment can continue
  res.status(200).json({ message: 'Saved to Render datastore.' });

  // Stage 2: Firestore write—each trial as its own document
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
            .doc(); // auto-ID per trial
          batch.set(docRef, {
            ...trial,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
          });
        });
        await batch.commit();
        console.log(`Batch ${i/BATCH_SIZE + 1} committed (${chunk.length} docs)`);
      }
      console.log(`✅ All ${allTrialData.length} trials written for ${participantId}`);
    } catch (e) {
      console.error(`❌ Firestore write failed for ${participantId}:`, e);
    }
  })();
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));