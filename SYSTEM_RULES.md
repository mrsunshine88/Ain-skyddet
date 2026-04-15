# SYSTEM_RULES - Projektets Grundlagar (RIDDAR-PROTOKOLLET)

Dessa regler är absoluta och får INTE ändras av någon AI utan uttryckligt godkännande och en presenterad plan till användaren.

## 1. Rollfördelning (Blind & Döv Arkitektur)
- **Frigate är ÖGONEN:** Frigate övervakar alla kameror 24/7. All detektering, spårning och primär identifiering (ansikte/regplåt via Double-Take/Plugins) sker i Frigates domän.
- **Systemlänken (main.js) är NERVSYSTEMET:**
    - Bryggan (`main.js`) ansvarar för att "tvätta" och översätta rå-data.
    - Om Frigate skickar ett regnr (t.ex. "ABC 123"), SKA bryggan slå upp ägaren i `brain.json` och skicka det färdiga namnet (t.ex. "Lukas bil") till JARVIS.
- **JARVIS/Travis är RÖSTEN & HJÄRNAN:** JARVIS ska vara helt **blind och döv** i viloläge.
    - JARVIS får INTE ha egna moduler för ansiktsigenkänning eller regplåtsläsning (ALPR) aktiva.
    - JARVIS får INTE försöka "gissa" identiteter själv genom att skanna bilder lokalt.
    - All identifiering SKA komma färdigdiskad via bryggan (`main.js`).
    - Travis roll är begränsad till att *beskriva* scenen efter att identiteten redan är fastställd.

## 2. Arbetsflöde för Notiser
1. Frigate/Double-Take identifierar en person/bil.
2. Frigate skickar en "Review" via MQTT till JARVIS.
3. JARVIS skickar omedelbart första notisen: "[Namn/Okänd] upptäckt vid [Plats]".
4. JARVIS hämtar sedan en ren 1080p snapshot från Frigate API.
5. Travis (Vision) analyserar bilden.
6. JARVIS skickar den fullständiga rapporten baserat på analysen.

## 3. Inget Brus
- Konsolen och fönstret får aldrig visa Frigates "tankar" eller pågående sökningar.
- Endast bekräftade händelser får loggas.

## 4. AI-Modifieringar
- **VIKTIGT:** Ingen AI får ändra arkitekturen (t.ex. reaktivera `frigate/events`) utan att först presentera en plan och få manuellt godkännande.
## 5. Tekniska Standarder (Frigate 0.17+)
- **Snapshot-hämtning:** Vid hämtning av bilder för analys SKA `/api/review/{id}/snapshot.jpg` användas som primär källa. Detta säkerställer att vi använder rätt ID-format från Frigate 0.17 reviews.
- **Data-synk:** All registrering av nya fordon eller ansikten i JARVIS UI SKA synkroniseras med servrarnas konfigurationsfiler (t.ex. `config.yml`) för att hålla "Ögonen" uppdaterade.

**Dessa regler utgör systemets kärna och får aldrig kompromissas.**
