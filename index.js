// Import necessary modules
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const bodyParser = require('body-parser'); // Keep the import, though we comment out its use
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

// *** TEMPORARILY COMMENTED OUT bodyParser.json() FOR DEBUGGING ***
// app.use(bodyParser.json({ limit: '50mb' }));

// *** UNCOMMENTED Raw Body Logger (for debugging JSON errors) ***
// This will intercept the request BEFORE the route handler if body parsing fails
app.use((req, res, next) => {
    // Only log for the specific route and method we are debugging
    if (req.originalUrl === '/save-final-data' && req.method === 'POST') {
        let rawData = '';
        req.setEncoding('utf8');
        req.on('data', function(chunk) {
           rawData += chunk;
        });
        req.on('end', function() {
            console.log("------ RAW BODY RECEIVED (/save-final-data) ------");
            // Log the first 500 characters to see the structure
            console.log(rawData.substring(0, 500) + (rawData.length > 500 ? '...' : ''));
            console.log("------ END RAW BODY ------");
            // Store the raw data on the request object so the route handler can try parsing it
            // NOTE: This bypasses the standard body-parser middleware!
            req.rawBody = rawData;
            next(); // Continue to the actual route handler
        });
        // Handle potential errors reading the stream
        req.on('error', (err) => {
             console.error("Error reading request stream:", err);
             next(err); // Pass error to Express error handler
        });
    } else {
        // If not the target route/method, just continue
        next();
    }
});
// --- End Raw Body Logger ---


// --- Routes ---

// --- Route for Saving Final Data to Firestore (MODIFIED TO PARSE RAW BODY) ---
app.post('/save-final-data', async (req, res) => {
    console.log("Received request at /save-final-data");

    // *** ADDED: Attempt to parse the raw body collected by the logger middleware ***
    let parsedBody;
    if (req.rawBody) {
        try {
            parsedBody = JSON.parse(req.rawBody);
            console.log("Successfully parsed rawBody manually.");
            console.log("Parsed req.body type:", typeof parsedBody);
             if (typeof parsedBody === 'object' && parsedBody !== null) {
                console.log("First few keys in parsed body:", Object.keys(parsedBody).slice(0, 5));
            }
        } catch (parseError) {
            console.error("Error manually parsing rawBody:", parseError);
            // Log the raw body again on error for inspection
            console.error("Raw body that failed parsing:", req.rawBody.substring(0, 500) + (req.rawBody.length > 500 ? '...' : ''));
            return res.status(400).send({ message: 'Bad Request: Invalid JSON format received.', error: parseError.message });
        }
    } else {
        // This case shouldn't happen if the logger middleware worked, but good to have a fallback
        console.error("Error: req.rawBody is missing. Body parser might be interfering or request was empty.");
         return res.status(400).send({ message: 'Bad Request: Request body missing or processing error.' });
    }
    // *** End Added Parsing Logic ***


    // 1. Extract data from the MANUALLY PARSED body
    const { participantId, allTrialData } = parsedBody; // Use parsedBody instead of req.body

    // 2. Basic validation
    if (!participantId || !Array.isArray(allTrialData) || allTrialData.length === 0) {
        console.error("Invalid data after manual parsing:", { participantId, trialDataLength: allTrialData?.length });
        return res.status(400).send({ message: 'Bad Request: Missing participantId or allTrialData array after parsing.' });
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
// --- End Modified Route ---


// Existing simple GET route
app.get("/", (req, res) => {
  res.send("jsPsych backend is running.");
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
