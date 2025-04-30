const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.text({ type: '*/*' }));  // Accept raw CSV or plain text

const dataDir = path.join(__dirname, 'data');
// const filePath = path.join(dataDir, 'experiment-data.csv');
const subjectId = req.query.subject_id || "unknown";
const filePath = path.join(dataDir, `subject-${subjectId}.csv`);

app.post('/submit', (req, res) => {
  fs.mkdir(dataDir, { recursive: true }, (err) => {
    if (err) {
      console.error("Directory creation error:", err);
      return res.status(500).send('Failed to create directory');
    }

    fs.appendFile(filePath, req.body + "\n", err => {
      if (err) {
        console.error("Error appending data:", err);
        return res.status(500).send('Failed to save data');
      }
      console.log("Data appended to", filePath);
      res.status(200).send('Data received and appended');
    });
  });
});

app.get("/", (req, res) => {
  res.send("jsPsych backend is running.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
