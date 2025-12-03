// ---------- server.js avec Socket.io (FIXED & COMPLETE) ----------
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const cors = require("cors");
const path = require("path");

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
app.use(express.static(path.join(__dirname, "public")));

// ===== CONFIGURATION =====
const MAX_CHAT_HISTORY = 500;
const MAX_OOC_HISTORY = 200;
const DATA_PATH = path.join(__dirname, "data", "rp.json");

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
      const data = fs.readFileSync(DATA_PATH, "utf8");
      gameState.rpData = JSON.parse(data);
      gameState.currentRP = Object.keys(gameState.rpData)[0];
      console.log("✅ Données RP chargées:", Object.keys(gameState.rpData).length, "RP(s)");
    } else {
      gameState.rpData = createDefaultData();
      gameState.currentRP = Object.keys(gameState.rpData)[0];
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
    fs.writeFileSync(DATA_PATH, JSON.stringify(gameState.rpData, null, 2));
    return true;
  } catch (err) {
    console.error("❌ Erreur sauvegarde:", err);
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
loadGameData();

// ===== ROUTES API =====

app.get("/data/rp.json", (req, res) => {
  res.json(gameState.rpData);
});

app.post("/save", (req, res) => {
  try {
    gameState.rpData = req.body;
    if (saveGameData()) {
      io.emit("dataUpdated", gameState.rpData);
      res.json({ ok: true });
    } else {
      res.status(500).json({ ok: false, error: "Erreur d'écriture" });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    players: gameState.connectedPlayers.length,
    rps: Object.keys(gameState.rpData || {}).length,
    chatMessages: gameState.chat.length,
    oocMessages: gameState.oocChat.length
  });
});

// ===== HUGGING FACE IA (FORMAT CORRIGÉ) =====
const HF_TOKEN = process.env.HF_TOKEN;

async function getAIResponse(context, characterName, playerMessage) {
  if (!HF_TOKEN) {
    console.log("⚠️ HF_TOKEN non défini, IA désactivée");
    return null;
  }

  // Protection contre undefined
  if (!characterName || typeof characterName !== 'string') {
    console.error("❌ characterName invalide:", characterName);
    characterName = "Personnage";
  }
  
  if (!playerMessage || typeof playerMessage !== 'string') {
    console.error("❌ playerMessage invalide:", playerMessage);
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
  console.log("   characterName:", characterName);
  console.log("   message:", playerMessage.substring(0, 50) + "...");

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
          max_tokens: 500,
          temperature: 0.8
        }),
      }
    );

    const text = await response.text();
    console.log("📥 Status:", response.status);
    console.log("📥 Réponse:", text.substring(0, 300));

    if (!response.ok) {
      console.error("❌ Erreur HF API:", response.status, text);
      return null;
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.error("❌ Erreur parsing JSON:", e.message);
      return null;
    }

    let reply = null;

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
      console.error("❌ Erreur HF:", data.error);
      return null;
    }

    if (reply) {
      console.log("✅ Réponse IA:", reply.substring(0, 100) + "...");
    }

    return reply;

  } catch (err) {
    console.error("❌ Erreur IA:", err.message);
    return null;
  }
}

// ===== SOCKET.IO - TEMPS RÉEL =====

io.on("connection", (socket) => {
  console.log(`🟢 Connexion: ${socket.id}`);

  // === REJOINDRE LA PARTIE ===
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
    
    const joinMsg = addChatMessage({
      id: Date.now(),
      type: 'system',
      text: `🟢 ${visitorName} a rejoint la partie`,
      timestamp: new Date().toISOString()
    });
    io.emit("chatMessage", joinMsg);
    io.emit("playersUpdated", gameState.connectedPlayers);
  });

  // === SÉLECTION DE PERSONNAGE ===
  socket.on("selectCharacter", (characterIndex) => {
    socket.characterIndex = characterIndex;
    
    const player = gameState.connectedPlayers.find(p => p.id === socket.id);
    if (player) {
      player.characterIndex = characterIndex;
    }
    
    const rp = getCurrentRP();
    const character = rp?.players?.[characterIndex];
    
    if (character) {
      console.log(`🎭 ${socket.visitorName} joue maintenant ${character.name}`);
    }
    
    io.emit("playersUpdated", gameState.connectedPlayers);
  });

  // === ENVOYER UN MESSAGE RP ===
  socket.on("sendMessage", async (data) => {
    console.log("📩 sendMessage reçu:", JSON.stringify(data));
    
    if (!data?.text || typeof data.text !== 'string') {
      console.log("❌ Pas de texte valide");
      return;
    }
    
    const type = data.type || 'joueur';
    const text = data.text.trim().substring(0, 2000);
    const characterIndex = data.characterIndex ?? -1;
    
    if (!text) return;
    
    // Résoudre le nom du personnage
    let characterName = data.characterName;
    
    if (!characterName && characterIndex >= 0) {
      const rp = getCurrentRP();
      characterName = rp?.players?.[characterIndex]?.name;
    }
    
    if (!characterName) {
      characterName = socket.visitorName || 'Personnage inconnu';
    }
    
    console.log("✅ characterName résolu:", characterName);
    
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
    
    // Si message joueur et IA activée
    if (type === 'joueur' && HF_TOKEN && characterIndex >= 0) {
      io.emit("aiTyping", true);
      
      try {
        const rp = getCurrentRP();
        const character = rp?.players?.[characterIndex];
        const location = character?.location || 'Karakura Town';
        const context = `Lieu: ${location}. Tour ${gameState.turnSystem.roundNumber}. Espèce: ${character?.species || 'Inconnu'}. HP: ${character?.hp || '?'}/${character?.maxHp || '?'}.`;
        
        console.log("🤖 Appel IA:");
        console.log("   context:", context);
        console.log("   characterName:", characterName);
        console.log("   text:", text);
        
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
          console.log("✅ Message IA envoyé");
        } else {
          console.log("⚠️ Pas de réponse IA valide");
        }
      } catch (err) {
        console.error("❌ Erreur réponse IA:", err);
      }
      
      io.emit("aiTyping", false);
    }
  });

  // === MESSAGES OOC (Hors RP) ===
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
  });

  // === SYSTÈME DE TOUR ===
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
  });

  socket.on("setTurn", (index) => {
    const rp = getCurrentRP();
    if (!rp?.players?.[index]) return;
    
    gameState.turnSystem.currentTurn = index;
    
    io.emit("turnChanged", {
      turnSystem: gameState.turnSystem,
      currentPlayerName: rp.players[index]?.name || 'Joueur inconnu'
    });
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
  });

  // === MISE À JOUR DES DONNÉES ===
  socket.on("updatePlayer", (data) => {
    const { playerIndex, updates } = data;
    const rp = getCurrentRP();
    
    if (rp?.players?.[playerIndex]) {
      Object.assign(rp.players[playerIndex], updates);
      saveGameData();
      io.emit("playerUpdated", { playerIndex, player: rp.players[playerIndex] });
    }
  });

  socket.on("updateRPTime", (newTime) => {
    gameState.rpTime = newTime;
    io.emit("rpTimeUpdated", newTime);
  });

  socket.on("clearChat", () => {
    gameState.chat = [];
    io.emit("chatCleared");
  });

  socket.on("clearOOC", () => {
    gameState.oocChat = [];
    io.emit("oocCleared");
  });

    // === DÉCONNEXION ===
  socket.on("disconnect", () => {
    const visitorName = socket.visitorName || 'Inconnu';
    console.log(`🔴 ${visitorName} déconnecté`);
    
    gameState.connectedPlayers = gameState.connectedPlayers.filter(p => p.id !== socket.id);
    
    const leaveMsg = addChatMessage({
      id: Date.now(),
      type: 'system',
      text: `🔴 ${visitorName} a quitté la partie`,
      timestamp: new Date().toISOString()
    });
    io.emit("chatMessage", leaveMsg);
    io.emit("playersUpdated", gameState.connectedPlayers);
  });
});

// ===== ROUTE API POUR TEST HF (optionnel) =====
// ===== ROUTES API =====

// Route racine - IMPORTANT pour Railway healthcheck
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/health", (req, res) => {
  res.json({ 
    status: "ok", 
    timestamp: new Date().toISOString(),
    players: gameState.connectedPlayers.length 
  });
});

app.get("/data/rp.json", (req, res) => {
  res.json(gameState.rpData);
});

// ... reste du code
app.post("/hf", async (req, res) => {
  const userMsg = req.body.message;
  
  if (!HF_TOKEN) {
    return res.status(401).json({ error: "HF_TOKEN manquant" });
  }

  if (!userMsg) {
    return res.status(400).json({ error: "Message manquant" });
  }

  const systemPrompt = `Tu es un narrateur pour un roleplay Bleach. Réponds en français de manière immersive.`;

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
            { role: "user", content: userMsg }
          ],
          max_tokens: 500,
          temperature: 0.8
        }),
      }
    );

    const text = await response.text();
    console.log("Status:", response.status);
    console.log("Réponse:", text.substring(0, 300));

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return res.json({ reply: "⚠️ Erreur parsing: " + text.substring(0, 100) });
    }
    
    let reply = "(Pas de réponse)";
    
    if (data.choices?.[0]?.message?.content) {
      reply = data.choices[0].message.content.trim();
    }
    else if (Array.isArray(data) && data[0]?.generated_text) {
      reply = data[0].generated_text.trim();
    }
    else if (data.error) {
      reply = "⚠️ " + (typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
    }
    
    res.json({ reply });
    
  } catch (err) {
    console.error("Erreur:", err);
    res.status(500).json({ error: err.message });
  }
});

// ===== DÉMARRAGE =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Serveur: http://localhost:${PORT}`);
  console.log(`📡 WebSocket prêt`);
  console.log(`🤖 IA: ${HF_TOKEN ? 'Activée' : 'Désactivée (HF_TOKEN non défini)'}`);
});