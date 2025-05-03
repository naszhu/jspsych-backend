// Import necessary modules
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin'); // *** ADDED: Firebase Admin SDK ***
// const fs = require('fs'); // Keep if you still use file system elsewhere
// const path = require('path'); // Keep if you still use file system elsewhere

// --- Firebase Admin SDK Initialization ---
// IMPORTANT: Load Firebase Admin SDK credentials securely!
// Assumes Render environment variable FIREBASE_SERVICE_ACCOUNT_JSON is set
let serviceAccount;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        console.log("Loaded Firebase service account from environment variable.");
    } else {
        // Fallback for local development (requires ./secrets/your-key-file.json)
        // Make sure './secrets' is in .gitignore if you use this locally!
        console.warn("FIREBASE_SERVICE_ACCOUNT_JSON env var not found. Trying local key file (FOR DEV ONLY)...");
        serviceAccount = require('./secrets/your-key-file-name.json'); // <<<--- ADJUST FOR LOCAL DEV if needed
        console.log("Loaded Firebase service account from local file.");
    }
} catch (error) {
    console.error("FATAL ERROR: Could not load Firebase service account credentials.", error);
    process.exit(1); // Exit if credentials can't be loaded
}

// Initialize Firebase Admin SDK
try {
    // Check if already initialized (useful for some environments/hot-reloading)
    if (admin.apps.length === 0) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("Firebase Admin SDK Initialized Successfully.");
    } else {
        console.log("Firebase Admin SDK already initialized.");
    }
} catch (error) {
    console.error("FATAL ERROR: Firebase Admin SDK Initialization Failed.", error);
    process.exit(1);
}

const db = admin.firestore(); // Get Firestore instance
// --- End Firebase Initialization ---


// --- Firestore Configuration for FINAL data ---
const FINAL_DATA_COLLECTION = 'participants_finished'; // Or 'participants_final_data' - use the one you decided on
const FINAL_DATA_SUBCOLLECTION = 'final_trials';   // Or 'trials' - use the one you decided on

// Initialize Express app
const app = express();

// --- Middleware ---
app.use(cors()); // Enable CORS
// *** CHANGED: Use express.json() to parse incoming JSON data from jsPsych ***
app.use(express.json({ limit: '50mb' })); // Increase limit for large datasets

// --- Keep or Remove Old File Saving Logic ---
/* // Commenting out the old file-based saving route
const dataDir = path.join(__dirname, 'data');
app.post('/submit', (req, res) => {
  // This route expects plain text/CSV in req.body
  // And uses req.query.subject_id which might not be sent by the new jsPsych code
  const subjectId = req.query.subject_id || "unknown"; // Be careful with this
  const filePath = path.join(dataDir, `subject-${subjectId}.csv`);

  fs.mkdir(dataDir, { recursive: true }, (err) => {
    if (err) {
      console.error("Directory creation error:", err);
      return res.status(500).send('Failed to create directory');
    }
    // req.body here would be the JSON string if sent to this endpoint now
    // You might need JSON.stringify(req.body) if you adapt this
    fs.appendFile(filePath, req.body + "\n", err => { // Appending JSON might be weird
      if (err) {
        console.error("Error appending data:", err);
        return res.status(500).send('Failed to save data');
      }
      console.log("Data appended to", filePath);
      res.status(200).send('Data received and appended (Legacy)');
    });
  });
});
*/
// --- End Old File Saving Logic ---


// --- ADDED: New Route for Saving Final Data to Firestore ---
app.post('/save-final-data', async (req, res) => {
    console.log("Received request at /save-final-data");

    // 1. Extract data from request body
    const { participantId, allTrialData } = req.body; // Expecting JSON payload

    // 2. Basic validation
    if (!participantId || !Array.isArray(allTrialData) || allTrialData.length === 0) {
        console.error("Invalid data received for final save:", { participantId, trialDataLength: allTrialData?.length });
        return res.status(400).send({ message: 'Bad Request: Missing participantId or allTrialData array.' });
    }

    console.log(`Processing FINAL data for participant: ${participantId}. Total trials received: ${allTrialData.length}`);

    // 3. Prepare for Batched Writes to the FINAL Firestore location
    const maxBatchSize = 500;
    let batch = db.batch();
    let operationCount = 0;
    let batchesCommitted = 0;
    let trialsPreparedCount = 0;
    const finalSubcollectionRef = db.collection(FINAL_DATA_COLLECTION).doc(participantId).collection(FINAL_DATA_SUBCOLLECTION);

    try {
        // Loop through the received array of all trial data
        for (const rawTrial of allTrialData) {
            if (typeof rawTrial !== 'object' || rawTrial === null) {
                console.warn("Skipping non-object item in final allTrialData array:", rawTrial);
                continue;
            }

            // Server-side cleaning is less critical if client cleans, but ensure subject_id
            const cleanedTrial = { ...rawTrial };
            if (!cleanedTrial.subject_id) {
                cleanedTrial.subject_id = participantId;
            }

            // Create ref for new doc in the FINAL subcollection
            const newFinalTrialDocRef = finalSubcollectionRef.doc();

            batch.set(newFinalTrialDocRef, cleanedTrial);
            operationCount++;
            trialsPreparedCount++;

            // Commit batch if full
            if (operationCount >= maxBatchSize) {
                console.log(`Committing FINAL batch ${batchesCommitted + 1} (size ${operationCount}) for ${participantId}...`);
                await batch.commit();
                batchesCommitted++;
                batch = db.batch();
                operationCount = 0;
            }
        } // End loop

        // Commit remaining operations
        if (operationCount > 0) {
            console.log(`Committing FINAL batch ${batchesCommitted + 1} (size ${operationCount}) for ${participantId}...`);
            await batch.commit();
            batchesCommitted++;
        }

        console.log(`Successfully committed ${batchesCommitted} FINAL batches for ${trialsPreparedCount} trials for participant ${participantId}.`);

        // 4. Optional: Update parent document in FINAL collection
        try {
            const finalParentDocRef = db.collection(FINAL_DATA_COLLECTION).doc(participantId);
            await finalParentDocRef.set({
                subject_id: participantId,
                final_save_status: `Completed - ${trialsPreparedCount} trials saved via backend.`,
                final_save_timestamp: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
             console.log(`Updated parent document status in ${FINAL_DATA_COLLECTION} for ${participantId}.`);
        } catch (parentUpdateError) {
             console.error(`Error updating parent document status in ${FINAL_DATA_COLLECTION} for ${participantId}:`, parentUpdateError);
        }

        // 5. Send success response back to jsPsych
        res.status(200).send({ message: `Final data for ${trialsPreparedCount} trials received and saved successfully.` });

    } catch (error) {
        console.error(`Error processing/saving FINAL data for participant ${participantId}:`, error);
        res.status(500).send({ message: 'Internal Server Error: Failed to save final data.', error: error.message });
    }
});
// --- End Added Route ---


// Existing simple GET route
app.get("/", (req, res) => {
  res.send("jsPsych backend is running.");
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
