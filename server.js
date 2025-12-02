const express = require("express");
const fs = require("fs");
const cors = require("cors");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/data/rp.json", (req, res) => {
  res.sendFile(path.join(__dirname, "data", "rp.json"));
});

app.post("/save", (req, res) => {
  try {
    fs.writeFileSync(
      path.join(__dirname, "data", "rp.json"),
      JSON.stringify(req.body, null, 2)
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Hugging Face ----------
const HF_TOKEN = process.env.HF_TOKEN;

app.post("/hf", async (req, res) => {
  const userMsg = req.body.message;
  
  if (!HF_TOKEN) {
    return res.status(401).json({ error: "HF_TOKEN manquant" });
  }

  const systemPrompt = `Tu es un narrateur pour un roleplay Bleach. Réponds en français de manière immersive.`;

  try {
    // Format chat/completions (OpenAI-compatible)
    const response = await fetch(
      "https://router.huggingface.co/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${HF_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/gpt-oss-20b:groq",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMsg }
          ],
          max_tokens: 10000,
          temperature: 0.8
        }),
      }
    );

    const text = await response.text();
    console.log("Status:", response.status);
    console.log("Réponse:", text);

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return res.json({ reply: "⚠️ Erreur: " + text });
    }
    
    let reply = "(Pas de réponse)";
    
    // Format OpenAI
    if (data.choices?.[0]?.message?.content) {
      reply = data.choices[0].message.content.trim();
    }
    // Format ancien HF
    else if (Array.isArray(data) && data[0]?.generated_text) {
      reply = data[0].generated_text.trim();
    }
    // Erreur
    else if (data.error) {
      reply = "⚠️ " + data.error;
    }
    
    res.json({ reply });
    
  } catch (err) {
    console.error("Erreur:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = 3000;
app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));