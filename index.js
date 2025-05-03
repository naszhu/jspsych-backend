// Import necessary modules
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const bodyParser = require('body-parser'); // *** ADDED: Explicit body-parser ***
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
        serviceAccount = require('./secrets/your-key-file-name.json'); // <<<--- ADJUST FOR LOCAL DEV if needed
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
const FINAL_DATA_COLLECTION = 'participants_finished'; // Or 'participants_final_data'
const FINAL_DATA_SUBCOLLECTION = 'final_trials';   // Or 'trials'

// Initialize Express app
const app = express();

// --- Middleware ---
app.use(cors()); // Enable CORS - Should be high up

// *** CHANGED: Use bodyParser.json() instead of express.json() ***
app.use(bodyParser.json({ limit: '50mb' })); // Increase limit for large datasets

// *** ADDED: Optional Raw Body Logger (for debugging if JSON error persists) ***
/* // Uncomment this block temporarily if JSON errors continue, to see the raw body
app.use((req, res, next) => {
    if (req.originalUrl === '/save-final-data' && req.method === 'POST') {
        let data = '';
        req.setEncoding('utf8');
        req.on('data', function(chunk) {
           data += chunk;
        });
        req.on('end', function() {
            console.log("------ RAW BODY RECEIVED (/save-final-data) ------");
            console.log(data.substring(0, 500) + (data.length > 500 ? '...' : '')); // Log first 500 chars
            console.log("------ END RAW BODY ------");
            // We are NOT calling next() here in this temporary logger
            // as body-parser needs the original stream.
            // This is just for seeing what arrives if parsing fails.
            // REMEMBER TO COMMENT THIS OUT AGAIN AFTER DEBUGGING.
        });
    }
    // IMPORTANT: If using the raw body logger above, you might need to call next()
    // if you intend for the actual route handler to still process the request,
    // BUT body-parser might complain if the stream was already consumed.
    // It's best used *instead* of body-parser temporarily for inspection.
    next(); // Call next() if NOT using the temporary logger above
});
*/

// --- Routes ---

// --- ADDED: New Route for Saving Final Data to Firestore ---
app.post('/save-final-data', async (req, res) => {
    console.log("Received request at /save-final-data");
    // *** ADDED: Log to confirm body was parsed (or if it's empty) ***
    console.log("Parsed req.body type:", typeof req.body);
    if (typeof req.body === 'object' && req.body !== null) {
        console.log("First few keys in req.body:", Object.keys(req.body).slice(0, 5));
    } else {
        console.log("req.body is not an object or is null.");
    }
    // *** End Added Log ***

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
