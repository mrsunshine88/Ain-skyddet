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
- **Data-synk (Academy Bridge):** All registrering av nya fordon eller ansikten i JARVIS UI SKA synkroniseras direkt med Frigates konfigurationsfiler (t.ex. `config.yml`) under `known_plates`. Detta säkerställer att "Ögonen" (Frigate) omedelbart lär sig nya identiteter så att de kan serveras färdigdiskade till JARVIS.
- **VIKTIGT:** Ingen AI får ändra arkitekturen (t.ex. reaktivera `frigate/events`) utan att först presentera en plan och få manuellt godkännande.

## 6. Remote Mirroring (Spegling)
- **Hitta hem:** JARVIS synkroniserar automatiskt sin `localtunnel`-adress till Supabase (`remote_tunnel`) vid start.
- **Speglingsskydd:** Vid fjärrstyrning får JARVIS-fönstret på datorn ALDRIG ändra storlek eller utseende. All anpassning sker på klientsidan (mobilen).
- **Säkerhet:** Alla speglings-strömmar ska ske via WSS för att fungera på moderna mobila webbläsare.

## 7. Aktiv Sökning & Realtids-LPR
- **On-Demand Förfrågningar:** Om användaren ställer en fråga (t.ex. "Vem står på infarten?"), ska JARVIS utföra en aktiv sökning.
- **Data-hierarki:** 
    1. JARVIS hämtar först identitetsdata (LPR/sub_label) direkt från Frigates API.
    2. Denna data (t.ex. "Andreas bil") klassas som **STADFÄST FAKTA**.
    3. Travis (Vision) analyserar sedan bilden men **utan** att försöka gissa på identiteten själv.
    4. Slutrapporten presenterar Frigates identitetsinfo som sanning och Travis analys som en kompletterande visuell beskrivning.
- **Robot-principen:** Inga prompter till AI:n får innehålla personnamn eller "övervaknings-ord" (säkerhet, bevakning) för att undvika att moraliska filter triggas. Använd kliniskt, tekniskt språk.

**Dessa regler utgör systemets kärna och får aldrig kompromissas.**
