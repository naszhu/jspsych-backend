const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.text({ type: '*/*' }));  // Accept raw CSV or JSON

app.post('/submit', (req, res) => {
  const timestamp = new Date().toISOString().replace(/:/g, '-');
  const filename = `data-${timestamp}.csv`;
  const filePath = path.join(__dirname, 'data', filename);

  fs.writeFile(filePath, req.body, err => {
    if (err) {
      console.error("Error saving data:", err);
      return res.status(500).send('Failed to save data');
    }
    console.log("Data saved to", filePath);
    res.status(200).send('Data received and saved');
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});