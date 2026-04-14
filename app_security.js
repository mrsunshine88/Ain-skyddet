/**
 * APP_SECURITY.JS - Hanterar kameror, patrullering och larm
 */

export function initSecurity(ui, vision, audio, brain) {
    console.log("[SECURITY] Modul laddad.");

    const fs = require('fs');
    
    const zoneNames = ["Ytterdörren", "Infarten", "Garaget"];
    const zoneSequence = { "Vägen": 0, "Infarten": 1, "Garaget": 2, "Ytterdörren": 3 };
    window.lastAlerts = {};
    window.lastSentMessage = "";
    window.roadPassages = 0;

    // --- [CHECK] LADDA SPARADE POSITIONER FRÅN FIL ---
    try {
        if (fs.existsSync('tracker.json')) {
            window.movementTracker = JSON.parse(fs.readFileSync('tracker.json', 'utf8'));
            console.log("[SECURITY] Rörelse-minne laddat från fil.");
        } else {
            window.movementTracker = {};
        }
    } catch (e) {
        window.movementTracker = {};
    }

    window.startSecurityLoop = () => {
        console.log("Säkerhetsmatris laddad. VÄNTAR PÅ FRIGATE (BLIND-LÄGE AKTIVT).");
        
        // --- AUTONOM SCAN AVAKTIVERAD ---
        // Vi sitter inte längre och scannar kamerorna själva.
        // Vi väntar på 'frigate-event' via MQTT istället.
    };

    window.handleCameraFailure = (camIdx) => {
        const zones = ["Ytterdörren", "Infarten", "Garaget"];
        window.appendMessage('System', `Kamerafel vid ${zones[camIdx]}. Försöker återansluta...`);
    };

    window.sendTelegram = async (msg) => {
        const botToken = '7774187062:AAH9Q70hRInsh3pCHgYF8_H6R2m8w_n8Y5A';
        const chatId = '5677943573';
        const url = `https://api.telegram.org/bot${botToken}/sendMessage?chat_id=${chatId}&text=${encodeURIComponent(msg)}`;
        fetch(url).catch(e => console.error("Telegram error:", e));
    };

    window.sendTelegramPhoto = async (msg, base64Image) => {
        const botToken = '7774187062:AAH9Q70hRInsh3pCHgYF8_H6R2m8w_n8Y5A';
        const chatId = '5677943573';
        try {
            const blob = await (await fetch(base64Image)).blob();
            const fd = new FormData();
            fd.append('chat_id', chatId);
            fd.append('caption', msg);
            fd.append('photo', blob, 'alert.jpg');
            fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, { method: 'POST', body: fd }).catch(e => console.error("Telegram photo error:", e));
        } catch (e) {
            console.error("Failed to convert/send photo", e);
            window.sendTelegram(msg); 
        }
    };
}
