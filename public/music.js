// ===== LECTEUR MUSIQUE YOUTUBE =====
let ytPlayer = null;
let musicStarted = false;
let currentVolume = 30;

// Playlist de vidéos YouTube (IDs)
const playlist = [
    { id: 'IvxHjs-gjB8', title: 'On the Precipice of Defeat' },
    { id: 'f4MmKTOzCEw', title: 'Comical World' },
    { id: 'JjWSuWKkWmg', title: 'Oh So Tired' },
    { id: 'K-4VtZO1a7g', title: 'Head in The Clouds' },
    {id: 'C7NJ7IaGjYM', title: 'Ditty for Daddy' },
    {id: 'iILgLk0D0gY', title: 'Creeping Shadows' },
    {id: 'TbzvVErq2Ic', title: 'Raw Breath Of Danger' },
    {id: 'k8R7cs7FnFw', title: 'Enemy Unseen' },
    {id: '7Jb0NP7dEk8', title: 'Will Of The Heart' },
    {id: '-LeWJ-5rbM8', title: 'Requiem For The Lost Ones' },
    {id: '_ZkGda9q6ZE', title: 'Nothing Can Be Explained' },
    {id: 'Mn6WrMGWgbs', title: 'Burden of the Past' },
    {id: 'v-LwlsDa_hU', title: 'Destiny Awaits' },
    {id: 'DVbZFY6HVMs', title: 'Catch-22' },
    {id: 'eqUE1Uq7JvU', title: 'Heat of the Battle' },
  { id: '9xya0oO5WgA', title: 'Bleach OST - Number One' },
  { id: 'JOHNtL9HhTE', title: 'Bleach OST - Invasion' },
  { id: 'zO_532nbu0c', title: 'Bleach OST - Never Meant to Belong' },
  { id: '0kYq-E8BJgU', title: 'Bleach OST - Treachery' },
  { id: 'k6LCykRfXL8', title: 'Bleach OST - Here to Stay' }
];

// Callback YouTube API
function onYouTubeIframeAPIReady() {
  console.log('🎵 YouTube API prête');
  
  ytPlayer = new YT.Player('youtubePlayer', {
    height: '0',
    width: '0',
    videoId: playlist[0].id,
    playerVars: {
      'autoplay': 0,
      'controls': 0,
      'disablekb': 1,
      'loop': 1,
      'playlist': playlist[0].id, // Nécessaire pour le loop
      'rel': 0,
      'showinfo': 0,
      'modestbranding': 1
    },
    events: {
      'onReady': onPlayerReady,
      'onStateChange': onPlayerStateChange,
      'onError': onPlayerError
    }
  });
}

function onPlayerReady(event) {
  console.log('🎵 Player prêt');
  ytPlayer.setVolume(currentVolume);
  updateVolumeDisplay(currentVolume);
}

function onPlayerStateChange(event) {
  // Quand la vidéo se termine, passer à la suivante
  if (event.data === YT.PlayerState.ENDED) {
    playNextTrack();
  }
  
  // Empêcher la pause (relancer si mis en pause)
  if (event.data === YT.PlayerState.PAUSED && musicStarted) {
    setTimeout(() => {
      if (ytPlayer && musicStarted) {
        ytPlayer.playVideo();
      }
    }, 100);
  }
}

function onPlayerError(event) {
  console.error('🎵 Erreur YouTube:', event.data);
  // En cas d'erreur, passer à la piste suivante
  playNextTrack();
}

// Démarrer la musique (appelé par l'overlay)
function startMusic() {
  const overlay = document.getElementById('musicStartOverlay');
  overlay.classList.add('hidden');
  
  if (ytPlayer && ytPlayer.playVideo) {
    ytPlayer.playVideo();
    musicStarted = true;
    console.log('🎵 Musique démarrée !');
  }
}

// Changer le volume
function setVolume(value) {
  currentVolume = parseInt(value);
  
  if (ytPlayer && ytPlayer.setVolume) {
    ytPlayer.setVolume(currentVolume);
  }
  
  updateVolumeDisplay(currentVolume);
  
  // Sauvegarder le volume
  localStorage.setItem('bleachRPVolume', currentVolume);
}

function updateVolumeDisplay(value) {
  const display = document.getElementById('volumeDisplay');
  const slider = document.getElementById('volumeSlider');
  
  if (display) display.textContent = value + '%';
  if (slider) slider.value = value;
}

// Changer de piste
function changeTrack() {
  const select = document.getElementById('musicSelect');
  const videoId = select.value;
  
  if (ytPlayer && ytPlayer.loadVideoById) {
    ytPlayer.loadVideoById({
      videoId: videoId,
      startSeconds: 0
    });
    
    // Mettre à jour le titre
    const option = select.options[select.selectedIndex];
    const titleEl = document.getElementById('musicTitle');
    if (titleEl) titleEl.textContent = option.textContent;
  }
}

// Passer à la piste suivante
function playNextTrack() {
  const select = document.getElementById('musicSelect');
  const currentIndex = select.selectedIndex;
  const nextIndex = (currentIndex + 1) % select.options.length;
  
  select.selectedIndex = nextIndex;
  changeTrack();
}

// Charger le volume sauvegardé
function loadSavedVolume() {
  const saved = localStorage.getItem('bleachRPVolume');
  if (saved !== null) {
    currentVolume = parseInt(saved);
    updateVolumeDisplay(currentVolume);
  }
}

// Initialiser au chargement
document.addEventListener('DOMContentLoaded', () => {
  loadSavedVolume();
});