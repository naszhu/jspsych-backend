// Import necessary modules
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const bodyParser = require('body-parser'); // Use explicit body-parser
// const fs = require('fs');
// const path = require('path');

// --- Firebase Admin SDK Initialization ---
// IMPORTANT: Load Firebase Admin SDK credentials securely!
// Assumes Render environment variable FIREBASE_SERVICE_ACCOUNT_JSON is set
let serviceAccount;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        console.log("Loaded Firebase service account from environment variable.");
    } else {
        console.warn("FIREBASE_SERVICE_ACCOUNT_JSON env var not found. Trying local key file (FOR DEV ONLY)...");
        // Ensure this path is correct for your local setup if needed
        serviceAccount = require('/home/lea/Insync/naszhu@gmail.com/Google Drive/shulai@iu.edu 2022-09-04 14:28/IUB/ctx-e3-0c2d428f6ca9.json');
        console.log("Loaded Firebase service account from local file.");
    }
} catch (error) {
    console.error("FATAL ERROR: Could not load Firebase service account credentials.", error);
    process.exit(1);
}

// Initialize Firebase Admin SDK
try {
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

const db = admin.firestore();
// --- End Firebase Initialization ---


// --- Firestore Configuration for FINAL data ---
// *** VERIFY THESE NAMES ARE CORRECT ***
const FINAL_DATA_COLLECTION = 'participants_finished'; // Or 'participants_final_data'
const FINAL_DATA_SUBCOLLECTION = 'final_trials';   // Or 'trials'

// Initialize Express app
const app = express();

// --- Middleware ---
app.use(cors()); // Enable CORS - Should be high up

// *** REVERTED: Use bodyParser.json() to parse incoming JSON ***
app.use(bodyParser.json({ limit: '50mb' })); // Increase limit for large datasets

// *** REMOVED: Raw Body Logger is no longer needed ***
// app.use((req, res, next) => { ... }); // Raw body logger removed

// --- Routes ---

// --- Route for Saving Final Data to Firestore ---
app.post('/save-final-data', async (req, res) => {
    console.log("Received request at /save-final-data");

    // Log the received body AFTER parsing by bodyParser
    console.log("Parsed req.body type:", typeof req.body);
    if (typeof req.body === 'object' && req.body !== null) {
        // Log carefully - avoid logging huge amounts of data if possible
        console.log("Keys in req.body:", Object.keys(req.body));
        if (req.body.participantId) {
            console.log("Received participantId:", req.body.participantId);
        }
        if (Array.isArray(req.body.allTrialData)) {
            console.log("Received allTrialData array with length:", req.body.allTrialData.length);
        } else {
             console.log("Received allTrialData is NOT an array.");
        }
    } else {
        console.log("req.body is not an object or is null after parsing.");
        // If body is empty/wrong type after parsing, send error immediately
         return res.status(400).send({ message: 'Bad Request: Expected JSON body not found or invalid.' });
    }

    // 1. Extract data from the parsed body
    const { participantId, allTrialData } = req.body; // Use req.body directly

    // 2. Basic validation (redundant if check above is done, but safe)
    if (!participantId || !Array.isArray(allTrialData) || allTrialData.length === 0) {
        console.error("Invalid data structure after parsing:", { participantId, trialDataLength: allTrialData?.length });
        return res.status(400).send({ message: 'Bad Request: Missing participantId or valid allTrialData array after parsing.' });
    }

    console.log(`Processing FINAL data for participant: ${participantId}. Total trials received: ${allTrialData.length}`);

    // 3. Prepare for Batched Writes (Logic remains the same)
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

            const cleanedTrial = { ...rawTrial };
            if (!cleanedTrial.subject_id) {
                cleanedTrial.subject_id = participantId;
            }

            const newFinalTrialDocRef = finalSubcollectionRef.doc();
            batch.set(newFinalTrialDocRef, cleanedTrial);
            operationCount++;
            trialsPreparedCount++;

            if (operationCount >= maxBatchSize) {
                console.log(`Committing FINAL batch ${batchesCommitted + 1} (size ${operationCount}) for ${participantId}...`);
                await batch.commit();
                batchesCommitted++;
                batch = db.batch();
                operationCount = 0;
            }
        } // End loop

        if (operationCount > 0) {
            console.log(`Committing FINAL batch ${batchesCommitted + 1} (size ${operationCount}) for ${participantId}...`);
            await batch.commit();
            batchesCommitted++;
        }

        console.log(`Successfully committed ${batchesCommitted} FINAL batches for ${trialsPreparedCount} trials for participant ${participantId}.`);

        // 4. Optional: Update parent document in FINAL collection (Logic remains the same)
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
// --- End Route ---


// Existing simple GET route
app.get("/", (req, res) => {
  res.send("jsPsych backend is running.");
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
