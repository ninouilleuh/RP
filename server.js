// ---------- server.js avec Socket.io (FIXED & COMPLETE) ----------
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const cors = require("cors");
const path = require("path");
const { MongoClient } = require('mongodb');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Global error handlers to surface crashes in PaaS logs
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
});

// Handle termination signals (helpful for PaaS debugging)
function gracefulShutdown(signal) {
  console.log(`⚠️ Received ${signal} - closing server gracefully...`);
  try {
    server.close(() => {
      console.log('✅ Server closed, exiting.');
      process.exit(0);
    });
    // Force exit if close doesn't finish in time
    setTimeout(() => {
      console.error('❌ Forced exit after timeout');
      process.exit(1);
    }, 10000).unref();
  } catch (err) {
    console.error('❌ Error during shutdown:', err);
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ===== CONFIGURATION =====
const MAX_CHAT_HISTORY = 500;
const MAX_OOC_HISTORY = 200;
const DATA_PATH = path.join(__dirname, "data", "rp.json");
// Server bindings (move early so startServer can access them)
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
// Hugging Face token (read early so startup messages can reference it)
const HF_TOKEN = process.env.HF_TOKEN;

// ===== ÉTAT DU JEU EN MÉMOIRE =====
let gameState = {
  rpData: null,
  currentRP: null,
  chat: [],
  oocChat: [],
  turnSystem: {
    enabled: true,
    currentTurn: 0,
    roundNumber: 1,
    playedThisRound: []
  },
  rpTime: {
    date: new Date(2024, 3, 1, 12, 0).toISOString(),
    tour: 1
  },
  connectedPlayers: []
};

// ===== FONCTIONS UTILITAIRES =====

function loadGameData() {
  try {
    const dataDir = path.join(__dirname, "data");
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    
    if (fs.existsSync(DATA_PATH)) {
      const raw = fs.readFileSync(DATA_PATH, "utf8");
      let data = null;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        console.error('❌ JSON parse error data file, recreating default:', e.message || e);
      }

      // Support legacy file that contained only rpData
      if (data && data.rpData) {
        gameState.rpData = data.rpData;
        gameState.chat = data.chat || [];
        gameState.oocChat = data.oocChat || [];
        gameState.turnSystem = data.turnSystem || gameState.turnSystem;
        gameState.rpTime = data.rpTime || gameState.rpTime;
      } else if (data) {
        // old format: file is rpData directly
        gameState.rpData = data;
      } else {
        gameState.rpData = createDefaultData();
      }

      gameState.currentRP = Object.keys(gameState.rpData)[0];
      console.log("✅ Données RP chargées:", Object.keys(gameState.rpData).length, "RP(s)");
    } else {
      gameState.rpData = createDefaultData();
      gameState.currentRP = Object.keys(gameState.rpData)[0];
      // persist the initial full state
      saveGameData();
      console.log("✅ Données par défaut créées");
    }
  } catch (err) {
    console.error("❌ Erreur chargement:", err);
    gameState.rpData = createDefaultData();
    gameState.currentRP = Object.keys(gameState.rpData)[0];
  }
}

function createDefaultData() {
  return {
    bleach_main: {
      title: "Bleach RP - Karakura Arc",
      players: [],
      npcs: [],
      bestiaire: {
        "Shinigami": [],
        "Hollow": [],
        "Humains": []
      },
      rpTime: {
        date: new Date(2024, 3, 1, 12, 0).toISOString(),
        tour: 1
      }
    }
  };
}

function saveGameData() {
  try {
    const toSave = {
      rpData: gameState.rpData,
      chat: gameState.chat,
      oocChat: gameState.oocChat,
      turnSystem: gameState.turnSystem,
      rpTime: gameState.rpTime
    };
    fs.writeFileSync(DATA_PATH, JSON.stringify(toSave, null, 2));
    // Mirror to DB asynchronously when configured
    if (process.env.MONGODB_URI) {
      saveGameDataToDB(toSave).then((ok) => {
        if (ok) console.log('💾 Données miroir sauvegardées en DB');
      }).catch((err) => {
        console.error('❌ Erreur miroir DB:', err);
      });
    }
    return true;
  } catch (err) {
    console.error("❌ Erreur sauvegarde:", err);
    return false;
  }
}

// Optional: MongoDB mirror (async). If `MONGODB_URI` is set, the server will
// store `rpData` in a collection named `rp_store` with a single document
// having `_id: 'rpData'` and `data: {...}`. This mirrors filesystem saves to
// a persistent database (useful on PaaS like Render where local disk is ephemeral).
let mongoClient = null;
let mongoDb = null;
const MONGODB_DB = process.env.MONGODB_DB || null;
const MONGODB_COLLECTION = process.env.MONGODB_COLLECTION || 'RPData';
// Accept multiple common env var names for the URI
const MONGO_URI = process.env.MONGODB_URI || process.env.MONGODB_URL || process.env.MONGO_URI || process.env.MONGO_URL || null;
async function initDb() {
  const uri = MONGO_URI;
  if (!uri) return;
  if (mongoClient) return;

  const baseOptions = { useNewUrlParser: true, useUnifiedTopology: true, serverSelectionTimeoutMS: 10000 };

  // First try: normal secure connection
  mongoClient = new MongoClient(uri, baseOptions);
  try {
    await mongoClient.connect();
    mongoDb = MONGODB_DB ? mongoClient.db(MONGODB_DB) : mongoClient.db();
    // No need to create an index on `_id` - it's unique by default.
    console.log('✅ MongoDB connected to', mongoDb.databaseName, 'collection:', MONGODB_COLLECTION);
    return;
  } catch (err) {
    console.error('❌ MongoDB secure connection failed:', err.message || err);
    // clean up client
    try { await mongoClient.close(); } catch (e) {}
    mongoClient = null;
    mongoDb = null;

    // If the failure looks like a TLS/SSL issue, try an insecure fallback for testing.
    const msg = String(err.message || '').toLowerCase();
    if (msg.includes('tls') || msg.includes('ssl') || msg.includes('tlsv1') || msg.includes('certificate')) {
      console.warn('⚠️ TLS/SSL error detected. Attempting temporary insecure connection (tlsAllowInvalidCertificates). Only use for testing.');
      const insecureOptions = Object.assign({}, baseOptions, { tls: true, tlsAllowInvalidCertificates: true, serverSelectionTimeoutMS: 8000 });
      try {
        mongoClient = new MongoClient(uri, insecureOptions);
        await mongoClient.connect();
        mongoDb = MONGODB_DB ? mongoClient.db(MONGODB_DB) : mongoClient.db();
        // No need to create an index on `_id` - it's unique by default.
        console.log('✅ MongoDB connected (insecure fallback) to', mongoDb.databaseName, 'collection:', MONGODB_COLLECTION);
        console.warn('⚠️ Connected using insecure TLS settings. Remove insecure fallback in production and fix certificate/URI.');
        return;
      } catch (err2) {
        console.error('❌ Insecure MongoDB connection also failed:', err2.message || err2);
        try { await mongoClient.close(); } catch (e) {}
        mongoClient = null;
        mongoDb = null;
        throw err2;
      }
    }

    // Not a TLS error or fallback failed: rethrow original
    throw err;
  }
}

async function saveGameDataToDB(data) {
  try {
    if (!process.env.MONGODB_URI) return false;
    if (!mongoClient) await initDb();
    if (!mongoDb) {
      console.error('❌ MongoDB not initialized, cannot save to DB');
      return false;
    }

    await mongoDb.collection(MONGODB_COLLECTION).updateOne(
      { _id: 'rpData' },
      { $set: { data: data } },
      { upsert: true }
    );
    return true;
  } catch (err) {
    console.error('❌ Erreur sauvegarde DB:', err.message || err);
    return false;
  }
}

async function loadFromDBIfAvailable() {
  try {
    if (!process.env.MONGODB_URI) return false;
    if (!mongoClient) await initDb();
    if (!mongoDb) {
      console.error('❌ MongoDB not initialized, cannot read DB');
      return false;
    }

    let doc = await mongoDb.collection(MONGODB_COLLECTION).findOne({ _id: 'rpData' });
    // fallback: if no document with _id 'rpData', try to read first doc in collection
    if (!doc) {
      doc = await mongoDb.collection(MONGODB_COLLECTION).findOne({});
    }

    if (doc) {
      const payload = doc.data || doc; // support both shapes
      if (payload.rpData) {
        gameState.rpData = payload.rpData;
        gameState.chat = payload.chat || [];
        gameState.oocChat = payload.oocChat || [];
        gameState.turnSystem = payload.turnSystem || gameState.turnSystem;
        gameState.rpTime = payload.rpTime || gameState.rpTime;
      } else {
        // legacy: stored only rpData
        gameState.rpData = payload;
      }

      gameState.currentRP = Object.keys(gameState.rpData)[0];
      console.log('✅ Données RP chargées depuis MongoDB');
      return true;
    }
    return false;
  } catch (err) {
    console.error('❌ Erreur lecture DB:', err.message || err);
    return false;
  }
}

function addChatMessage(message) {
  gameState.chat.push(message);
  if (gameState.chat.length > MAX_CHAT_HISTORY) {
    gameState.chat = gameState.chat.slice(-MAX_CHAT_HISTORY);
  }
  return message;
}

function addOOCMessage(message) {
  gameState.oocChat.push(message);
  if (gameState.oocChat.length > MAX_OOC_HISTORY) {
    gameState.oocChat = gameState.oocChat.slice(-MAX_OOC_HISTORY);
  }
  return message;
}

function getCurrentRP() {
  return gameState.rpData?.[gameState.currentRP];
}

function advanceToNextTurn() {
  const rp = getCurrentRP();
  if (!rp?.players?.length) return null;
  
  if (!gameState.turnSystem.playedThisRound.includes(gameState.turnSystem.currentTurn)) {
    gameState.turnSystem.playedThisRound.push(gameState.turnSystem.currentTurn);
  }
  
  gameState.turnSystem.currentTurn = (gameState.turnSystem.currentTurn + 1) % rp.players.length;
  
  let newRound = false;
  
  if (gameState.turnSystem.currentTurn === 0) {
    gameState.turnSystem.roundNumber++;
    gameState.turnSystem.playedThisRound = [];
    newRound = true;
    
    const currentDate = new Date(gameState.rpTime.date);
    currentDate.setMinutes(currentDate.getMinutes() + 5);
    gameState.rpTime.date = currentDate.toISOString();
    gameState.rpTime.tour = gameState.turnSystem.roundNumber;
  }
  
  return {
    newRound,
    currentPlayer: rp.players[gameState.turnSystem.currentTurn],
    roundNumber: gameState.turnSystem.roundNumber
  };
}

// ===== CHARGER LES DONNÉES =====
async function startServer() {
  console.log('🔄 Loading game data...');
  let loadedFromDb = false;
  if (process.env.MONGODB_URI) {
    try {
      await initDb();
      loadedFromDb = await loadFromDBIfAvailable();
    } catch (err) {
      console.error('❌ DB init/lecture échouée:', err);
    }
  }

  if (!loadedFromDb) {
    loadGameData();
  }

  console.log('✅ Game data loaded successfully');

  console.log(`🕒 Démarrage: ${new Date().toISOString()}`);
  console.log(`🌍 Environment: NODE_ENV=${process.env.NODE_ENV || 'development'}`);
  console.log(`💾 Data file: ${DATA_PATH}`);
  console.log(`🔗 Listening on ${HOST}:${PORT}...`);

  server.listen(PORT, HOST, () => {
    console.log(`🚀 Serveur ACTIVE sur ${HOST}:${PORT}`);
    console.log(`📡 WebSocket prêt`);
    console.log(`🤖 IA: ${HF_TOKEN ? 'Activée' : 'Désactivée (HF_TOKEN non défini)'}`);
    console.log(`✅ Ready to accept connections`);
  });
}

startServer().catch(err => {
  console.error('❌ Failed to start server:', err);
  process.exit(1);
});

// Auto-save all game state to file + DB every 60 seconds
setInterval(() => {
  const now = new Date().toISOString();
  console.log(`⏰ Auto-save triggered (${now})`);
  saveGameData();
}, 60000);

// ===== ROUTES API (AVANT express.static) =====
app.get("/health", (req, res) => {
  console.log('📍 Health check ping');
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/data/rp.json", (req, res) => {
  res.json(gameState.rpData);
});

// Sauvegarde
app.post("/save", (req, res) => {
  try {
    const body = req.body || {};

    if (body.rpData) {
      // Deep merge but protect bestiaire
      function merge(target, source) {
        for (const key in source) {
          if (key === "bestiaire") continue; // 🔒 block overwrite

          if (
            typeof source[key] === "object" &&
            source[key] !== null &&
            !Array.isArray(source[key])
          ) {
            if (!target[key]) target[key] = {};
            merge(target[key], source[key]);
          } else {
            target[key] = source[key];
          }
        }
      }

      merge(gameState.rpData, body.rpData);
    } else {
      // old format fallback
      merge(gameState.rpData, body);
    }

    if (saveGameData()) {
      io.emit("dataUpdated", { rpData: gameState.rpData, chat: gameState.chat });
      res.json({ ok: true });
    } else {
      res.status(500).json({ ok: false, error: "Erreur d'écriture" });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ===== HUGGING FACE IA =====
async function getAIResponse(context, characterName, playerMessage) {
  if (!HF_TOKEN) {
    console.log("⚠️ HF_TOKEN non défini, IA désactivée");
    return null;
  }

  if (!characterName || typeof characterName !== 'string') {
    characterName = "Personnage";
  }
  
  if (!playerMessage || typeof playerMessage !== 'string') {
    return null;
  }
  
  if (!context) {
    context = "Univers de Bleach";
  }

  const systemPrompt = `Tu es le Maître du Jeu (MJ) d'un roleplay basé sur l'univers de Bleach.
Tu dois répondre en français de manière immersive et descriptive.

RÈGLES IMPORTANTES:
- Décris l'environnement, les réactions des PNJ, et les conséquences des actions
- Ne parle JAMAIS à la place des joueurs ou de leurs personnages
- Ne prends pas de décisions pour les personnages joueurs
- Utilise un style narratif à la troisième personne
- Sois concis mais atmosphérique (2-4 phrases max)
- Reste fidèle à l'univers de Bleach
- Le personnage qui agit est: ${characterName}

Contexte actuel: ${context}`;

  const userMessage = `Action de ${characterName}: ${playerMessage}`;

  console.log("📤 Envoi à HF...");

  try {
    const response = await fetch(
      "https://router.huggingface.co/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${HF_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/gpt-oss-20b:groq",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage }
          ],
          max_tokens: 30000,
          temperature: 0.8
        }),
      }
    );

    const text = await response.text();
    console.log("📥 Status:", response.status);

    if (!response.ok) {
      console.error("❌ Erreur HF API:", response.status, text);
      return null;
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return null;
    }

    if (data.choices?.[0]?.message?.content) {
      return data.choices[0].message.content.trim();
    }
    if (Array.isArray(data) && data[0]?.generated_text) {
      return data[0].generated_text.trim();
    }

    return null;

  } catch (err) {
    console.error("❌ Erreur IA:", err.message);
    return null;
  }
}

// Test HF API
app.post("/hf", async (req, res) => {
  const userMsg = req.body.message;
  
  if (!HF_TOKEN) {
    return res.status(401).json({ error: "HF_TOKEN manquant" });
  }

  if (!userMsg) {
    return res.status(400).json({ error: "Message manquant" });
  }

  try {
    const reply = await getAIResponse("Test", "Testeur", userMsg);
    res.json({ reply: reply || "(Pas de réponse)" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== FICHIERS STATIQUES (APRÈS les routes API) =====
app.use(express.static(path.join(__dirname, "public")));



// ===== SOCKET.IO - TEMPS RÉEL =====

io.on("connection", (socket) => {
  console.log(`🟢 Connexion: ${socket.id}`);

  socket.on("joinGame", (data) => {
    let visitorName, characterIndex;
    
    if (typeof data === 'string') {
      visitorName = data;
      characterIndex = -1;
    } else {
      visitorName = data?.visitorName || 'Visiteur';
      characterIndex = data?.characterIndex ?? -1;
    }
    
    visitorName = visitorName.trim().substring(0, 30);
    socket.visitorName = visitorName;
    socket.characterIndex = characterIndex;
    
    const existingIndex = gameState.connectedPlayers.findIndex(p => p.visitorName === visitorName);
    if (existingIndex === -1) {
      gameState.connectedPlayers.push({
        id: socket.id,
        visitorName: visitorName,
        characterIndex: characterIndex,
        joinedAt: new Date().toISOString()
      });
    } else {
      gameState.connectedPlayers[existingIndex].id = socket.id;
      gameState.connectedPlayers[existingIndex].characterIndex = characterIndex;
    }
    
    console.log(`👤 ${visitorName} a rejoint (${gameState.connectedPlayers.length} connectés)`);
    
    socket.emit("gameState", {
      rpData: gameState.rpData,
      currentRP: gameState.currentRP,
      chat: gameState.chat.slice(-100),
      oocChat: gameState.oocChat.slice(-50),
      turnSystem: gameState.turnSystem,
      rpTime: gameState.rpTime,
      connectedPlayers: gameState.connectedPlayers
    });
    
    // Emit player joined event (non-persistent, transient notification)
    io.emit("playerJoined", { visitorName, characterIndex });
    io.emit("playersUpdated", gameState.connectedPlayers);
  });

  socket.on("selectCharacter", (characterIndex) => {
    socket.characterIndex = characterIndex;
    
    const player = gameState.connectedPlayers.find(p => p.id === socket.id);
    if (player) {
      player.characterIndex = characterIndex;
    }
    
    io.emit("playersUpdated", gameState.connectedPlayers);
  });

  socket.on("sendMessage", async (data) => {
    if (!data?.text || typeof data.text !== 'string') return;
    
    const type = data.type || 'joueur';
    const text = data.text.trim().substring(0, 2000);
    const characterIndex = data.characterIndex ?? -1;
    
    if (!text) return;
    
    let characterName = data.characterName;
    if (!characterName && characterIndex >= 0) {
      const rp = getCurrentRP();
      characterName = rp?.players?.[characterIndex]?.name;
    }
    if (!characterName) {
      characterName = socket.visitorName || 'Personnage inconnu';
    }
    
    const authorName = type === 'joueur' ? characterName : (socket.visitorName || 'MJ');
    
    const message = addChatMessage({
      id: Date.now(),
      type: type,
      text: text,
      author: authorName,
      visitorName: socket.visitorName,
      characterIndex: characterIndex,
      turn: gameState.turnSystem.roundNumber,
      timestamp: new Date().toISOString()
    });
    
    io.emit("chatMessage", message);
    // persist chat
    saveGameData();
    
    if (type === 'joueur' && HF_TOKEN && characterIndex >= 0) {
      io.emit("aiTyping", true);
      
      try {
        const rp = getCurrentRP();
        const character = rp?.players?.[characterIndex];
        const location = character?.location || 'Karakura Town';
        const context = `Lieu: ${location}. Tour ${gameState.turnSystem.roundNumber}. Espèce: ${character?.species || 'Inconnu'}.`;
        
        const aiReply = await getAIResponse(context, characterName, text);
        
        if (aiReply && aiReply.length > 5) {
          const aiMessage = addChatMessage({
            id: Date.now(),
            type: 'narrateur',
            text: aiReply,
            author: '🎭 MJ (IA)',
            turn: gameState.turnSystem.roundNumber,
            timestamp: new Date().toISOString()
          });
          io.emit("chatMessage", aiMessage);
          // persist AI reply as part of chat
          saveGameData();
        }
      } catch (err) {
        console.error("❌ Erreur IA:", err);
      }
      
      io.emit("aiTyping", false);
    }
  });

  socket.on("sendOOC", (data) => {
    if (!data?.text || typeof data.text !== 'string') return;
    
    const cleanText = data.text.trim().substring(0, 1000);
    if (!cleanText) return;
    
    const message = addOOCMessage({
      id: Date.now(),
      type: 'ooc',
      text: cleanText,
      author: socket.visitorName || 'Anonyme',
      timestamp: new Date().toISOString()
    });
    
    io.emit("oocMessage", message);
    // persist OOC
    saveGameData();
  });

  socket.on("nextTurn", () => {
    if (!gameState.turnSystem.enabled) return;
    
    const result = advanceToNextTurn();
    if (!result) return;
    
    if (result.newRound) {
      const roundMsg = addChatMessage({
        id: Date.now(),
        type: 'system',
        text: `═══════════ 🔄 TOUR ${result.roundNumber} ═══════════`,
        timestamp: new Date().toISOString()
      });
      io.emit("chatMessage", roundMsg);
      io.emit("rpTimeUpdated", gameState.rpTime);
    }
    
    io.emit("turnChanged", {
      turnSystem: gameState.turnSystem,
      currentPlayerName: result.currentPlayer?.name || 'Joueur inconnu'
    });
    // persist turn change + rpTime
    saveGameData();
  });

  socket.on("skipTurn", () => {
    if (!gameState.turnSystem.enabled) return;
    
    const rp = getCurrentRP();
    const currentCharacter = rp?.players?.[gameState.turnSystem.currentTurn];
    const skipperName = currentCharacter?.name || socket.visitorName || 'Un joueur';
    
    const skipMsg = addChatMessage({
      id: Date.now(),
      type: 'system',
      text: `⏭️ ${skipperName} passe son tour.`,
      timestamp: new Date().toISOString()
    });
    io.emit("chatMessage", skipMsg);
    
    const result = advanceToNextTurn();
    if (!result) return;
    
    if (result.newRound) {
      const roundMsg = addChatMessage({
        id: Date.now(),
        type: 'system',
        text: `═══════════ 🔄 TOUR ${result.roundNumber} ═══════════`,
        timestamp: new Date().toISOString()
      });
      io.emit("chatMessage", roundMsg);
      io.emit("rpTimeUpdated", gameState.rpTime);
    }
    
    io.emit("turnChanged", {
      turnSystem: gameState.turnSystem,
      currentPlayerName: result.currentPlayer?.name || 'Joueur inconnu'
    });
    // persist turn change + rpTime
    saveGameData();
  });

  socket.on("setTurn", (index) => {
    const rp = getCurrentRP();
    if (!rp?.players?.[index]) return;
    
    gameState.turnSystem.currentTurn = index;
    
    io.emit("turnChanged", {
      turnSystem: gameState.turnSystem,
      currentPlayerName: rp.players[index]?.name || 'Joueur inconnu'
    });
    // persist selected turn
    saveGameData();
  });

  socket.on("resetTurns", () => {
    gameState.turnSystem = {
      enabled: true,
      currentTurn: 0,
      roundNumber: 1,
      playedThisRound: []
    };
    
    const rp = getCurrentRP();
    const firstPlayer = rp?.players?.[0]?.name || 'Joueur 1';
    
    const resetMsg = addChatMessage({
      id: Date.now(),
      type: 'system',
      text: `🔄 Tours réinitialisés. C'est au tour de ${firstPlayer}.`,
      timestamp: new Date().toISOString()
    });
    io.emit("chatMessage", resetMsg);
    io.emit("turnChanged", { 
      turnSystem: gameState.turnSystem, 
      currentPlayerName: firstPlayer 
    });
    // persist reset of turn system
    saveGameData();
  });

  socket.on("toggleTurnSystem", () => {
    gameState.turnSystem.enabled = !gameState.turnSystem.enabled;
    
    const toggleMsg = addChatMessage({
      id: Date.now(),
      type: 'system',
      text: gameState.turnSystem.enabled 
        ? '✅ Système de tour activé.'
        : '❌ Système de tour désactivé (mode libre).',
      timestamp: new Date().toISOString()
    });
    io.emit("chatMessage", toggleMsg);
    io.emit("turnChanged", { turnSystem: gameState.turnSystem });
    // persist toggle
    saveGameData();
  });

  socket.on("updatePlayer", (data) => {
    const { playerIndex, updates } = data;
    const rp = getCurrentRP();
    
    if (rp?.players?.[playerIndex]) {
      Object.assign(rp.players[playerIndex], updates);
      saveGameData();
      io.emit("playerUpdated", { playerIndex, player: rp.players[playerIndex] });
    }
  });

  socket.on("addPlayer", (playerData) => {
    const rp = getCurrentRP();
    if (!rp) return;
    if (!rp.players) rp.players = [];

    // Ensure player has required fields
    const newPlayer = playerData || {};
    newPlayer.id = newPlayer.id || Date.now();
    newPlayer.name = newPlayer.name || 'Nouveau joueur';
    newPlayer.species = newPlayer.species || 'Humain';
    newPlayer.location = newPlayer.location || 'Karakura Town';

    rp.players.push(newPlayer);
    saveGameData(); // Persist new player to file and DB

    io.emit("playerAdded", { playerIndex: rp.players.length - 1, player: newPlayer });
    io.emit("playersUpdated", rp.players);
  });

  socket.on("deletePlayer", (playerIndex) => {
    const rp = getCurrentRP();
    if (!rp || !rp.players || playerIndex < 0 || playerIndex >= rp.players.length) return;

    const deletedPlayer = rp.players[playerIndex];
    rp.players.splice(playerIndex, 1);
    saveGameData(); // Persist deletion to file and DB

    io.emit("playerDeleted", { playerIndex, playerName: deletedPlayer.name });
    io.emit("playersUpdated", rp.players);
  });

  // Update NPC info in bestiaire
  socket.on('updateNPC', (data) => {
    // data: { factionName, index, npc }
    const { factionName, index, npc } = data || {};
    const rp = getCurrentRP();
    if (!rp || !rp.bestiaire || !rp.bestiaire[factionName]) return;
    if (index < 0 || index >= rp.bestiaire[factionName].length) return;

    rp.bestiaire[factionName][index] = npc;
    saveGameData();
    io.emit('npcUpdated', { factionName, index, npc });
    io.emit('bestiaireUpdated', rp.bestiaire);
  });

  socket.on("updateRPTime", (newTime) => {
    gameState.rpTime = newTime;
    io.emit("rpTimeUpdated", newTime);
    // persist rpTime
    saveGameData();
  });

  socket.on("clearChat", () => {
    gameState.chat = [];
    io.emit("chatCleared");
    saveGameData();
  });

  socket.on("clearOOC", () => {
    gameState.oocChat = [];
    io.emit("oocCleared");
    saveGameData();
  });

  socket.on("disconnect", () => {
    const visitorName = socket.visitorName || 'Inconnu';
    console.log(`🔴 ${visitorName} déconnecté`);
    
    gameState.connectedPlayers = gameState.connectedPlayers.filter(p => p.id !== socket.id);
    
    // Emit player left event (non-persistent, transient notification)
    io.emit("playerLeft", { visitorName });
    io.emit("playersUpdated", gameState.connectedPlayers);
  });
});

// Startup is handled by `startServer()` above which calls `server.listen()`.

server.on('error', (err) => {
  console.error('❌ Server error:', err);
});