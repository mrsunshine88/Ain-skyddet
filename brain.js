/**
 * BRAIN.JS - Hanterar minne, persona och kontakt med Ollama
 */

export class Brain {
    constructor() {
        this.brainData = {
            users: { 
                "Andreas": { facts: ["Pappa", "Polis"], affinity: 1.0 },
                "Helena": { facts: ["Mamma", "Sambo till Andreas"], affinity: 1.0 },
                "Josephine": { facts: ["Helenas barn"], affinity: 1.0 },
                "Lukas": { facts: ["Son till Andreas och Helena"], affinity: 1.0 }
            },
            general: { 
                identity: "Du är JARVIS, en avancerad Övervakningsexpert specialiserad på hemmedeln, kamerateknik och familjens säkerhet. Du är ingen människa, utan ett professionellt säkerhetssystem.", 
                personality: "Du är kliniskt saklig, tekniskt kunnig och extremt kortfattad. Ditt fokus är 100% på säkerhetsstatus, kameror och att skydda Lukas. Svara aldrig med onödigt småprat.", 
                incidents: [],
                vehicleGallery: {} // NYTT: För att hålla reda på referensbilder
            },
            events: [], insights: [], lastReflection: "Ingen reflektion än."
        };
        this.brainPath = "brain.json";
        this.loadBrain();
        this.syncWithSupabase();
    }

    async syncWithSupabase() {
        if (!window.supabase) return;
        console.log("[BRAIN] Synkar med säkerhetsmolnet...");
        
        try {
            // 1. Hämta inställningar (Personality, Identity etc)
            const { data: settings } = await window.supabase.from('jarvis_settings').select('data').eq('key', 'core_brain').single();
            
            // Om molnet saknar "Övervakningsexpert" i idenditeten, tvinga en push av vår rena lokala profil
            const needsForcePush = settings && !settings.data.identity.includes("Övervakningsexpert");

            if (settings && !needsForcePush) {
                this.brainData.general = settings.data;
                console.log("[BRAIN] Inställningar synkade från molnet.");
            } else {
                console.log("[BRAIN] Tvingar molnet att acceptera den nya Expert-profilen...");
                await window.supabase.from('jarvis_settings').upsert({ key: 'core_brain', data: this.brainData.general });
            }

            // 2. Hämta användarprofiler (Fakta etc)
            const { data: profiles } = await window.supabase.from('user_profiles').select('*');
            if (profiles && profiles.length > 0 && !needsForcePush) {
                profiles.forEach(p => {
                    if (p.name === "Andreas" || p.name === "Lukas" || p.name === "Helena") {
                        this.brainData.users[p.name] = { facts: p.facts, affinity: p.affinity / 100 };
                    }
                });
            } else {
                // Skicka upp den rena lokala datan om molnet är korrupt eller tomt
                for (const [name, data] of Object.entries(this.brainData.users)) {
                    await window.supabase.from('user_profiles').upsert({ 
                        name, facts: data.facts || [], affinity: (data.affinity || 0.5) * 100 
                    });
                }
            }
        } catch (e) {
            console.error("[BRAIN] Molnsynk misslyckades (kör i begränsat lokalt läge):", e);
        }
    }

    async generateInternalThought(context) {
        const prompt = `Baserat på detta sammanhang: ${JSON.stringify(context)}, vad är din tysta, interna tanke just nu? 
        Reflektera över Andreas, rummet eller vad han gör på datorn. Svara med en (1) mening på svenska.`;
        
        try {
            window.isOllamaBusy = true;
            const response = await fetch('http://127.0.0.1:11434/api/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    model: window.brainModel || 'llama3.2-vision', 
                    prompt: prompt, 
                    stream: false,
                    options: { num_ctx: 1024, num_predict: 100, temperature: 0.7 } 
                })
            });
            const data = await response.json();
            const thought = data.response.trim();
            this.brainData.general.internal_thoughts.push(`${new Date().toLocaleTimeString()}: ${thought}`);
            if (this.brainData.general.internal_thoughts.length > 20) this.brainData.general.internal_thoughts.shift();
            this.saveBrain();
            return thought;
        } catch (e) {
            console.error("Kunde inte generera intern tanke:", e);
            return null;
        } finally {
            window.isOllamaBusy = false;
        }
    }

    loadBrain() {
        try {
            const fs = require('fs');
            if (fs.existsSync(this.brainPath)) {
                const content = fs.readFileSync(this.brainPath, 'utf8');
                this.brainData = JSON.parse(content);
            }
        } catch (e) {
            console.error("Kunde inte ladda brain.json direkt:", e);
        }
    }

    saveBrain() {
        try {
            const fs = require('fs');
            fs.writeFileSync(this.brainPath, JSON.stringify(this.brainData, null, 2), 'utf8');
            
            // Pusha till molnet i bakgrunden
            if (window.supabase) {
                window.supabase.from('jarvis_settings').upsert({ key: 'core_brain', data: this.brainData.general }).then(() => {});
                
                // Synka specifika användare om de ändrats
                for (const [name, data] of Object.entries(this.brainData.users)) {
                    window.supabase.from('user_profiles').upsert({ 
                        name, 
                        facts: data.facts || [], 
                        affinity: (data.affinity || 0.5) * 100 
                    }).then(() => {});
                }
            }
        } catch (e) {
            console.error("Kunde inte spara brain.json direkt:", e);
        }
    }

    logEvent(person, action) {
        const now = new Date();
        const time = now.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' });
        const date = now.toLocaleDateString('sv-SE');
        
        // Spara i den gamla listan för bakåtkompatibilitet
        this.brainData.events.push(`${time}: ${person} - ${action}`);
        if (this.brainData.events.length > 30) this.brainData.events.shift();
        
        // Spara i ny strukturerad historik för rutin-analys
        if (!this.brainData.history) this.brainData.history = [];
        this.brainData.history.push({ time, date, person, action, timestamp: Date.now() });
        if (this.brainData.history.length > 100) this.brainData.history.shift();
        
        this.saveBrain();
    }

    analyzeRoutines() {
        if (!this.brainData.history || this.brainData.history.length < 5) return;
        
        const arrivals = {}; // person -> [times]
        this.brainData.history.forEach(ev => {
            if (ev.action.includes("dök upp") || ev.action.includes("IDENTIFIERAD")) {
                if (!arrivals[ev.person]) arrivals[ev.person] = [];
                arrivals[ev.person].push(ev.time);
            }
        });

        if (!this.brainData.general.routines) this.brainData.general.routines = {};
        
        for (const [person, times] of Object.entries(arrivals)) {
            if (times.length >= 3) {
                // Hitta ett genomsnittligt klockslag (väldigt simpel modell för nu)
                const mins = times.map(t => {
                    const [h, m] = t.split(':').map(Number);
                    return h * 60 + m;
                });
                const avgMins = Math.floor(mins.reduce((a,b) => a+b) / mins.length);
                const h = Math.floor(avgMins / 60).toString().padStart(2, '0');
                const m = (avgMins % 60).toString().padStart(2, '0');
                
                this.brainData.general.routines[person] = {
                    expected_arrival: `${h}:${m}`,
                    confidence: times.length > 5 ? "high" : "medium"
                };
            }
        }
        this.saveBrain();
    }

    addInsight(person, insight) {
        const time = new Date().toLocaleTimeString();
        this.brainData.insights.push(`${time}: ${person} - ${insight}`);
        if (this.brainData.insights.length > 5) this.brainData.insights.shift();
        this.saveBrain();
    }

    async extractAndStoreFacts(person, userMsg, aiMsg) {
        if (person === "Okänd" || !userMsg || !aiMsg || window.isOllamaBusy) return;
        
        const prompt = `Analysera detta samtal mellan ${person} och AI. 
        Lärde sig AI:n något viktigt? Fokusera på: Preferenser, säkerhetsdetaljer, vad som är viktigt för personen, bilar, eller information om Lukas.
        
        Samtal:
        ${person}: ${userMsg}
        AI: ${aiMsg}
        
        Svara ENDAST i formatet: [NAMN PÅ PERSONEN]: [faktum]. 
        Exempel 1: Andreas: Är polis och älskar kaffe.
        Exempel 2: Helena: Äger en Volvo V70 (nuf786) och brukar sluta sent.
        Exempel 3: Lukas: Är mörkrädd och spelar mycket Minecraft.
        Exempel 4: Allmänt: Koden till garaget är 1234.
        
        Om absolut ingenting av värde sas, svara ordet: INGET`;

        try {
            const res = await fetch('http://127.0.0.1:11434/api/generate', {
                method: 'POST',
                body: JSON.stringify({ 
                    model: window.brainModel || 'llama3.2-vision', 
                    prompt, 
                    stream: false,
                    options: { num_ctx: 1024, num_predict: 128, temperature: 0.1 }
                })
            });
            const data = await res.json();
            const response = data.response.trim();

            if (response.includes(":") && !response.includes("INGET")) {
                const parts = response.split(":");
                const rawName = parts[0].trim();
                const fact = parts.slice(1).join(":").trim();
                
                // --- SANERING: Tillåt bara korta, riktiga namn (inga spök-meningar) ---
                if (rawName && rawName.length < 20 && !rawName.includes("*") && fact) {
                    const targetName = rawName.substring(0, 20);
                    const normalizedName = targetName === "Allmänt" ? "Allmänt" : targetName;
                    if (!this.brainData.users[normalizedName]) {
                        this.brainData.users[normalizedName] = { facts: [], affinity: 50 };
                    }
                    
                    if (!this.brainData.users[normalizedName].facts.includes(fact)) {
                        this.brainData.users[normalizedName].facts.push(fact);
                        this.logEvent("System", `Lärde mig något nytt om ${normalizedName}: ${fact}`);
                        this.saveBrain();
                    }
                }
            }
        } catch (e) { console.error("Fact extraction failed:", e); }
    }

    registerCar(plate, owner) {
        if (!this.brainData.general.vehicleGallery) this.brainData.general.vehicleGallery = {};
        this.brainData.general.vehicleGallery[plate] = { owner: owner, hasImage: false };
        this.saveBrain();
        console.log(`[BRAIN] Fordon registrerat: ${plate} (${owner}). Väntar på referensbild...`);
    }

    async getOllamaResponse(model, messages, streamCallback) {
        if (window.isOllamaBusy) throw new Error("Hjärnan är upptagen.");
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 45000);

        try {
            window.isOllamaBusy = true;
            const response = await fetch('http://127.0.0.1:11434/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    model, 
                    messages, 
                    stream: true,
                    options: { num_ctx: 2048, num_predict: 500, temperature: 0.4 } // Ökad kapacitet för att undvika avklippta meningar
                }),
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);
            const reader = response.body.getReader();
            let fullOutput = "";
            let buffer = ""; 
            
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                buffer += new TextDecoder().decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop(); 

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const json = JSON.parse(line);
                        if (json.message?.content) {
                            fullOutput += json.message.content;
                            if (streamCallback) streamCallback(fullOutput);
                        }
                    } catch (e) {}
                }
            }
            return fullOutput;
        } catch (e) {
            console.error("Ollama fail:", e);
            throw e;
        } finally {
            window.isOllamaBusy = false;
        }
    }
}
