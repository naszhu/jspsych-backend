// index.js
const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const admin   = require('firebase-admin');

// --- Firebase Admin init from your Render env var ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// --- Express setup ---
const app = express();

// 1) CORS first
app.use(cors({ origin: 'http://localhost:8080' }));
app.options('*', cors());

// 2) JSON body parser
app.use(express.json({ limit: '50mb' }));

// 3) POST /save-final-data
app.post('/save-final-data', (req, res) => {
  const { participantId, allTrialData } = req.body;
  if (!participantId) {
    return res.status(400).json({ error: 'Missing participantId' });
  }

  // ----- Stage 1: write to local file -----
  const fileName = `${participantId}-${Date.now()}.json`;
  const filePath = path.join(__dirname, 'data', fileName);
  try {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(req.body));
  } catch (err) {
    console.error('Local write error:', err);
    return res.status(500).json({ error: 'Failed to save locally' });
  }

  // ACK the experiment immediately
  res.status(200).json({ message: 'Saved to Render datastore.' });

  // ----- Stage 2: async Firestore write -----
  (async () => {
    try {
      const batch = db.batch();
      const parent = db
        .collection('participants_finished')
        .doc(participantId)
        .collection('final_trials')
        .doc(); // auto-ID
      batch.set(parent, {
        trials: allTrialData,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
      await batch.commit();
      console.log(`Firestore write complete for ${participantId}`);
    } catch (e) {
      console.error(`Firestore write failed for ${participantId}:`, e);
    }
  })();
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
