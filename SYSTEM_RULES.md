# SYSTEM_RULES - Projektets Grundlagar (RIDDAR-PROTOKOLLET)

Dessa regler är absoluta och får INTE ändras av någon AI utan uttryckligt godkännande och en presenterad plan till användaren.

## 1. Rollfördelning (Blind & Döv Arkitektur)
- **Frigate är ÖGONEN:** Frigate övervakar alla kameror 24/7. All detektering, spårning och primär identifiering (ansikte/regplåt via Double-Take/Plugins) sker i Frigates domän.
- **Systemlänken (main.js) är NERVSYSTEMET:**
    - Bryggan (`main.js`) ansvarar för att vidarebefordra den identitet Frigate redan har fastställt.
    - Bryggan får INTE utföra egna sökningar eller gissningar i `brain.json` för att hitta ägare; detta ska vara klart i Frigates `config.yml`.
- **JARVIS/Travis är RÖSTEN & HJÄRNAN:** JARVIS ska vara helt **blind och döv** i viloläge.
    - All identifiering SKA komma färdigdiskad från Frigate (Served Identity).
    - JARVIS får INTE försöka "gissa" identiteter själv genom att skanna bilder eller slå upp regnummer.
    - Travis roll är strikt begränsad till att *beskriva* scenen objektivt efter att identiteten redan är fastställd.


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
