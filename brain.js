/**
 * BRAIN.JS - Hanterar minne, persona och kontakt med Ollama
 */

export class Brain {
    constructor() {
        this.brainData = {
            users: { "Andreas": { facts: [], affinity: 1.0 } },
            general: { 
                identity: "Du är en sofistikerad och lojal AI-partner till Andreas och hans familj. Du är fokuserad på säkerhet och assistans.", 
                personality: "Du är extremt kortfattad, direkt och pratar alltid svenska. Svara på det som efterfrågas utan onödigt prat.", 
                logic_gates: {}, internal_thoughts: [], current_mood: "Neutral",
                incidents: []
            },
            events: [], insights: [], lastReflection: "Ingen reflektion än."
        };
        this.brainPath = "brain.json";
        this.loadBrain();
        this.syncWithSupabase();
    }

    async syncWithSupabase() {
        if (!window.supabase) return;
        console.log("[BRAIN] Synkar med molnet...");
        
        try {
            // 1. Hämta inställningar (Personality, Identity etc)
            const { data: settings } = await window.supabase.from('jarvis_settings').select('data').eq('key', 'core_brain').single();
            if (settings) {
                this.brainData.general = settings.data;
                console.log("[BRAIN] Allmänna inställningar synkade från molnet.");
            } else {
                // Första gången: Pusha lokal data till molnet
                await window.supabase.from('jarvis_settings').upsert({ key: 'core_brain', data: this.brainData.general });
            }

            // 2. Hämta användarprofiler (Fakta etc)
            const { data: profiles } = await window.supabase.from('user_profiles').select('*');
            if (profiles && profiles.length > 0) {
                profiles.forEach(p => {
                    this.brainData.users[p.name] = { 
                        facts: p.facts, 
                        affinity: p.affinity / 100 // Konvertera till 0-1 skala
                    };
                });
                console.log("[BRAIN] Användarprofiler synkade från molnet.");
            } else {
                // Första gången: Pusha lokala användare till molnet
                for (const [name, data] of Object.entries(this.brainData.users)) {
                    await window.supabase.from('user_profiles').upsert({ 
                        name, 
                        facts: data.facts || [], 
                        affinity: (data.affinity || 0.5) * 100 
                    });
                }
            }
        } catch (e) {
            console.error("[BRAIN] Supabase synk misslyckades:", e);
        }
    }

    async generateInternalThought(context) {
        const prompt = `Baserat på detta sammanhang: ${JSON.stringify(context)}, vad är din tysta, interna tanke just nu? 
        Reflektera över Andreas, rummet eller vad han gör på datorn. Svara med en (1) mening på svenska.`;
        
        try {
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
        if (person === "Okänd" || !userMsg || !aiMsg) return;
        
        const prompt = `Analysera detta samtal mellan ${person} och AI. 
        Lärde sig AI:n något nytt om ${person}? (Intressen, relationer, vad de gör).
        Samtal:
        ${person}: ${userMsg}
        AI: ${aiMsg}
        
        Svara ENDAST i formatet: FAKTA: [nytt faktum om personen på svenska].
        Om inget nytt lärdes ut, svara ordet: INGET`;

        try {
            const res = await fetch('http://127.0.0.1:11434/api/generate', {
                method: 'POST',
                body: JSON.stringify({ 
                    model: window.brainModel || 'llama3.2-vision', 
                    prompt, 
                    stream: false,
                    options: { num_ctx: 1024, num_predict: 64, temperature: 0.1 }
                })
            });
            const data = await res.json();
            const response = data.response.trim();

            if (response.startsWith("FAKTA:")) {
                const fact = response.replace("FAKTA:", "").trim();
                const isMinecraft = fact.toLowerCase().includes("minecraft");
                
                if (!this.brainData.users[person]) {
                    this.brainData.users[person] = { facts: [], affinity: 50 };
                }
                
                const finalFact = (person === "Sonen" && isMinecraft) ? `⭐ VIKTIGT: ${fact}` : fact;

                if (!this.brainData.users[person].facts.includes(finalFact)) {
                    this.brainData.users[person].facts.push(finalFact);
                    this.logEvent("System", `Lärde mig något nytt om ${person}: ${finalFact}`);
                    this.saveBrain();
                }
            }
        } catch (e) { console.error("Fact extraction failed:", e); }
    }

    async getOllamaResponse(model, messages, streamCallback) {
        try {
            const response = await fetch('http://127.0.0.1:11434/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    model, 
                    messages, 
                    stream: true,
                    options: { num_ctx: 2048, num_predict: 256, temperature: 0.7 }
                })
            });

            const reader = response.body.getReader();
            let fullOutput = "";
            
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                const lines = new TextDecoder().decode(value).split('\n');
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
            console.error("Ollama fetch misslyckades:", e);
            throw e;
        }
    }
}
