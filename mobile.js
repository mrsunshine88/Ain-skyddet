let BASE_URL = ''; // Dynamisk adress från Supabase

// --- UI Elements ---
const activeCam = document.getElementById('activeCam');
const activeLabel = document.getElementById('activeLabel');
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const vaktBtn = document.getElementById('vaktBtn');
const galleryModal = document.getElementById('galleryModal');
const galleryGrid = document.getElementById('galleryGrid');

let currentZone = 'cam1';
let vaktMode = false;
let activeSession = null;
window.jarvisVolume = 0.5;

window.updateVol = (val) => {
    window.jarvisVolume = parseFloat(val);
    console.log("Mobil volym:", window.jarvisVolume);
};

// --- Auth Logic ---
const checkAuth = () => {
    const session = JSON.parse(localStorage.getItem('jarvis_session'));
    if (session) {
        activeSession = session;
        document.getElementById('loginOverlay').style.display = 'none';
        console.log(`Inloggad som: ${session.display_name}`);
    }
};

window.processLogin = async () => {
    const userCode = document.getElementById('loginUser').value;
    const passCode = document.getElementById('loginPass').value;
    const err = document.getElementById('loginError');
    
    if (!userCode || !passCode) return;
    
    // --- LOKAL DATABAS (GARANTERAD INLOGGNING ENLIGT BEGÄRAN) ---
    const localUsers = {
        '64112': { pass: '020406', display: 'Andreas', role: 'admin' },
        '64113': { pass: '020406', display: 'Lukas', role: 'user' },
        '67589': { pass: '004206', display: 'Helena', role: 'user' },
        '67590': { pass: '004206', display: 'Josephine', role: 'user' }
    };
    
    let isSuccess = false;
    let fallbackData = null;

    if (localUsers[userCode] && localUsers[userCode].pass === passCode) {
        isSuccess = true;
        fallbackData = {
            username: userCode,
            display_name: localUsers[userCode].display,
            role: localUsers[userCode].role
        };
    }
    
    if (!isSuccess && window.supabase) {
        try {
            const { data, error } = await window.supabase
                .from('app_users')
                .select('*')
                .eq('username', userCode)
                .eq('password', passCode)
                .single();
                
            if (data) {
                isSuccess = true;
                fallbackData = data;
            }
        } catch (e) { console.error("Supabase login check fail:", e); }
    }
            
    if (isSuccess && fallbackData) {
        activeSession = {
            name: fallbackData.display_name, // Skriv över med rätt namn för chatt-routing
            display_name: fallbackData.display_name,
            role: fallbackData.role
        };
        localStorage.setItem('jarvis_session', JSON.stringify(activeSession));
        document.getElementById('loginOverlay').style.opacity = '0';
        
        setTimeout(() => {
            document.getElementById('loginOverlay').style.display = 'none';
            
            // Kolla om vi redan ÄR en app (PWA)
            const isPWA = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
            if (isPWA) {
                const btn = document.getElementById('installBtn');
                if(btn) btn.style.display = 'none';
            }
            
            // Visa Setup-rutan om Push inte är godkänt ELLER om vi har en väntande App-installation (vissa webbläsare gömmer den annars)
            if (Notification.permission !== 'granted' || (window.deferredPrompt && !isPWA)) {
                document.getElementById('setupOverlay').style.display = 'flex';
            } else {
                window.subscribeToPush();
            }
            updateUIPermissions();
        }, 500);
    } else {
        err.style.display = 'block';
    }
};

checkAuth(); // Kör direkt vid laddning

// --- TUNNEL DISCOVERY (HITTA HEM) ---
async function initTunnel() {
    if (!window.supabase) return;
    try {
        const { data } = await window.supabase.from('jarvis_settings').select('data').eq('key', 'remote_tunnel').single();
        if (data && data.data.url) {
            BASE_URL = data.data.url;
            console.log("📱 JARVIS Hittad på:", BASE_URL);
            
            // Säkerhetskoll: Uppdatera bara om UI:t är redo
            const labelEl = document.getElementById('activeLabel');
            if (labelEl) {
                switchCam(currentZone, labelEl.innerText);
                
                // Uppdatera även tumnaglarna
                document.getElementById('thumb_cam1').src = `${BASE_URL}/cam1?t=${Date.now()}`;
                document.getElementById('thumb_cam2').src = `${BASE_URL}/cam2?t=${Date.now()}`;
                document.getElementById('thumb_cam3').src = `${BASE_URL}/cam3?t=${Date.now()}`;
                
                // Starta notis-kanalen
                initNotifications();
            }
        }
    } catch (e) {
        console.error("Tunnel discovery fail:", e);
    }
}
initTunnel(); // Hämta adressen direkt vid start

// --- NOTIFICATIONS (WebSocket) ---
let notificationWS;
function initNotifications() {
    if (!BASE_URL || notificationWS) return;
    const wsUrl = BASE_URL.replace('https://', 'wss://').replace('http://', 'ws://');
    notificationWS = new WebSocket(wsUrl);
    
    notificationWS.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'notification') {
            const banner = document.getElementById('alertBanner');
            banner.innerText = `⚠️ ${msg.text} (${msg.camera})`;
            banner.style.display = 'flex';
            
            // Vibrera om möjligt
            if (window.navigator.vibrate) window.navigator.vibrate([200, 100, 200]);
            
            // Dölj efter 8 sekunder
            setTimeout(() => { banner.style.display = 'none'; }, 8000);
        }
    };

    notificationWS.onclose = () => {
        notificationWS = null;
        setTimeout(initNotifications, 5000); // Reconnect
    };
}

// --- Camera Logic ---
let camInterval;
window.switchCam = (id, label) => {
    if (!BASE_URL) return;
    
    // Rensa gammalt intervall
    if (camInterval) clearInterval(camInterval);

    currentZone = id;
    if (label) activeLabel.innerText = label.toUpperCase();
    
    // Snabb-uppdatering (Syftar på 20-30 FPS)
    camInterval = setInterval(() => {
        activeCam.src = `${BASE_URL}/${id}?t=${Date.now()}`;
    }, 40); // 40ms = ~25 FPS

    // Update button states
    document.querySelectorAll('.cam-box').forEach(btn => btn.classList.remove('active'));
    const box = document.querySelector(`[onclick*="${id}"]`);
    if (box) box.classList.add('active');
};

// --- Chat Logic ---
window.askAI = async (text) => {
    const query = text || chatInput.value.trim();
    if (!query || !window.supabase) return;
    
    chatInput.value = '';
    
    // Vi lägger bara in meddelandet i Supabase. 
    // JARVIS hemma på datorn kommer se det och svara därifrån!
    await window.supabase.from('chat_messages').insert({
        sender: 'Mobile',
        content: query,
        recipient_name: activeSession ? activeSession.name : 'all'
    });
};

function appendMessage(role, text) {
    const div = document.createElement('div');
    div.className = `msg ${role.toLowerCase()}`;
    div.innerText = text;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return div;
}

// Lyssna på svar från JARVIS (Realtid från molnet)
if (window.supabase) {
    window.supabase
        .channel('public:chat_messages')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, payload => {
            const msg = payload.new;
            const isAdmin = activeSession && activeSession.role === 'admin';
            // Visa om det är till mig, till 'all', eller om jag är Admin
            if (isAdmin || (activeSession && (msg.recipient_name === activeSession.name || msg.recipient_name === 'all'))) {
                appendMessage(msg.sender, msg.content);
                
                // Läs upp med röst om det är JARVIS som pratar
                if (msg.sender === 'AI' || msg.sender === 'System') {
                    const utterance = new SpeechSynthesisUtterance(msg.content.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')); // Ta bort emojis
                    utterance.lang = 'sv-SE';
                    utterance.volume = window.jarvisVolume || 0.8;
                    window.speechSynthesis.speak(utterance);
                }
            }
        })
        .subscribe();
        
    // Ladda historik vid start
    const loadHistory = async () => {
        if (!activeSession) return;
        const isAdmin = activeSession.role === 'admin';
        
        // Admin ser ALLT (Master Sync). Andra ser bara sitt eget.
        let query = window.supabase.from('chat_messages').select('*');
        
        if (!isAdmin) {
            query = query.or(`recipient_name.eq.${activeSession.name},recipient_name.eq.all`);
        }
        
        const { data } = await query.order('created_at', { ascending: false }).limit(20);
            
        if (data) {
            chatMessages.innerHTML = "";
            data.reverse().forEach(m => appendMessage(m.sender === 'Mobile' ? 'User' : m.sender, m.content));
        }
    };
    
    // Kör history load efter att vi är säkra på att vi har en session
    setTimeout(loadHistory, 1000);
}

// --- PWA INSTALLATION HELPER ---
window.addEventListener('beforeinstallprompt', (e) => {
    console.log("PWA: Install-prompt redo.");
    e.preventDefault();
    window.deferredPrompt = e;
    
    // Visa installations-knappen om den finns
    const installBtn = document.getElementById('installBtn');
    if (installBtn) {
        installBtn.style.display = 'block';
        // Om vi inte redan är en PWA, tvinga fram setup-rutan för att uppmuntra installation
        const isPWA = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
        if (!isPWA) {
            const setupOverlay = document.getElementById('setupOverlay');
            if (setupOverlay) setupOverlay.style.display = 'flex';
        }
    }
});


window.installApp = async () => {
    if (!window.deferredPrompt) return;
    window.deferredPrompt.prompt();
    const { outcome } = await window.deferredPrompt.userChoice;
    if (outcome === 'accepted') {
        document.getElementById('installBtn').style.display = 'none';
        
        if (Notification.permission === 'granted') {
             document.getElementById('setupOverlay').style.display = 'none';
        }
    }
    window.deferredPrompt = null;
};

// --- PRO-PUSH SUBSCRIPTION LOGIC ---
const VAPID_PUBLIC_KEY = 'BN_Vd4xG2V9U5p7p2Z5p7p2Z5p7p2Z5p7p2Z5p7p2Z5p7p2Z5p7p2Z5p7p2Z5p7p2Z';

window.subscribeToPush = async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        console.warn("Push-notiser stöds inte i denna webbläsare.");
        return;
    }

    try {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;

        document.getElementById('pushBtn').style.display = 'none';
        
        // Om även installBtn är borta kan vi stänga hela rutan
        const noInstall = document.getElementById('installBtn').style.display === 'none';
        if (noInstall || window.matchMedia('(display-mode: standalone)').matches) {
            document.getElementById('setupOverlay').style.display = 'none';
        }

        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: VAPID_PUBLIC_KEY
        });

        if (subscription && window.supabase && activeSession) {
            // Spara/Uppdatera prenumerationen i Supabase
            await window.supabase.from('push_subscriptions').upsert({
                user_id: activeSession.name,
                subscription: subscription
            }, { onConflict: 'user_id' });
            
            console.log("Push-notiser aktiverade för:", activeSession.name);
        }
    } catch (e) {
        console.error("Kunde inte aktivera push:", e);
    }
};

// --- Vaktläge Logic ---
window.toggleVakt = async () => {
    vaktMode = !vaktMode;
    vaktBtn.innerText = `VAKTLÄGE: ${vaktMode ? 'PÅ' : 'AV'}`;
    vaktBtn.classList.toggle('active');
    
    // Synka via Supabase (fungerar var som helst i världen)
    if (window.supabase) {
        await window.supabase.from('chat_messages').insert({
            sender: 'System',
            content: vaktMode ? 'CMD:VAKT_ON' : 'CMD:VAKT_OFF',
            recipient_name: 'all'
        });
    }
};

// --- Gallery Logic ---
window.toggleGallery = async () => {
    if (galleryModal.style.display === 'flex') {
        galleryModal.style.display = 'none';
        return;
    }
    
    galleryModal.style.display = 'flex';
    galleryGrid.innerHTML = '<div class="msg ai">Laddar incident-logg...</div>';
    
    try {
        const res = await fetch(`${BASE_URL}/api/incidents`, {
            headers: { 'Bypass-Tunnel-Reminder': 'true' }
        });
        let files = await res.json();
        
        // --- NYTT: FILTRERA GALLERI ---
        const isAdmin = activeSession && (activeSession.role === 'admin' || activeSession.name === 'Andreas');
        if (!isAdmin) {
            // Visa endast utomhusbilder (zon_...)
            files = files.filter(f => f.startsWith('zon'));
        }

        galleryGrid.innerHTML = '';
        if (files.length === 0) {
            galleryGrid.innerHTML = '<div class="msg ai">Inga sparade rutor än.</div>';
            return;
        }

        files.forEach(file => {
            const div = document.createElement('div');
            div.className = 'gallery-item';
            const time = file.split('_')[1];
            const displayTime = time ? new Date(parseInt(time)).toLocaleTimeString() : 'Tid okänd';
            div.innerHTML = `
                <img src="${BASE_URL}/incidents/${file}" loading="lazy">
                <div class="item-label">${displayTime}</div>
            `;
            galleryGrid.appendChild(div);
        });
    } catch (e) {
        galleryGrid.innerHTML = '<div class="msg ai">Kunde inte hämta händelser.</div>';
    }
};

// --- HJÄLPMETOD: BEHÖRIGHET ---
function updateUIPermissions() {
    const isAdmin = activeSession && (activeSession.role === 'admin' || activeSession.name === 'Andreas');
    const masterBtn = document.querySelector('[onclick*="cam0"]');
    if (masterBtn && !isAdmin) {
        masterBtn.style.display = 'none';
    }
}
updateUIPermissions(); // Kör vid start

// --- MOBIL RÖST-STYRNING ---
const voiceBtn = document.getElementById('voiceBtn');
const SpeechR = window.SpeechRecognition || window.webkitSpeechRecognition;

if (SpeechR && voiceBtn) {
    const recognition = new SpeechR();
    recognition.lang = 'sv-SE';
    recognition.interimResults = false;
    
    let isListening = false;
    
    recognition.onstart = () => {
        isListening = true;
        voiceBtn.style.background = '#f43f5e';
        chatInput.placeholder = "Lyssnar...";
    };
    
    recognition.onresult = (event) => {
        const text = event.results[0][0].transcript;
        chatInput.value = text;
        askAI();
    };
    
    recognition.onerror = () => {
        voiceBtn.style.background = 'transparent';
        chatInput.placeholder = "Prata med JARVIS...";
        isListening = false;
    };
    
    recognition.onend = () => {
        voiceBtn.style.background = 'transparent';
        chatInput.placeholder = "Prata med JARVIS...";
        isListening = false;
    };
    
    voiceBtn.onclick = () => {
        if (isListening) recognition.stop();
        else recognition.start();
    };
} else {
    if (voiceBtn) voiceBtn.style.display = 'none'; // Göm om mobilen inte stödjer det
}

// --- Events ---
sendBtn.onclick = () => askAI();
chatInput.onkeypress = (e) => { if (e.key === 'Enter') askAI(); };

// --- Connection Heartbeat ---
setInterval(async () => {
    try {
        const res = await fetch(`${BASE_URL}/api/health`, {
            headers: { 'Bypass-Tunnel-Reminder': 'true' }
        });
        const data = await res.json();
        document.querySelector('.dot').style.background = (data.server === 'online' && data.frigate === 'online') ? '#00ff88' : '#ffcc00';
        document.getElementById('statusText').innerText = (data.server === 'online' && data.frigate === 'online') ? 'JARVIS ONLINE' : 'SYSTEMET VÄNTAR';
    } catch (e) {
        document.querySelector('.dot').style.background = '#f43f5e';
        document.getElementById('statusText').innerText = 'ANSLUTNING BRUTEN';
    }
}, 5000);

// --- NYTT: REALTIDS-SYNK AV IDENTIFIERING ---
if (window.supabase) {
    window.supabase
        .channel('public:family_notifications')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'family_notifications' }, payload => {
            const note = payload.new;
            const badge = document.getElementById('idBadgeMobile');
            
            // Om notisen rör nuvarande zon
            const zoneMap = { 'cam1': 'Ytterdörren', 'cam2': 'Infarten', 'cam3': 'Garaget' };
            if (note.zone === zoneMap[currentZone] && note.title.includes('IDENTIFIERAD')) {
                const name = note.title.replace('IDENTIFIERAD: ', '').trim();
                if (badge) {
                    badge.innerText = `IDENTIFIERAD: ${name.toUpperCase()}`;
                    badge.className = "cam-id-badge active identified";
                    
                    // Göm efter 10 sekunder
                    clearTimeout(window.badgeTimeout);
                    window.badgeTimeout = setTimeout(() => {
                        badge.classList.remove('active');
                    }, 10000);
                }
            } else if (note.zone === zoneMap[currentZone] && note.message.includes('okänd person')) {
                 if (badge) {
                    badge.innerText = "OKÄND PERSON";
                    badge.className = "cam-id-badge active unknown";
                    
                    clearTimeout(window.badgeTimeout);
                    window.badgeTimeout = setTimeout(() => {
                        badge.classList.remove('active');
                    }, 10000);
                }
            }
        })
        .subscribe();
}
