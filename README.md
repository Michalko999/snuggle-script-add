# Nákupný zoznam

Inteligentný nákupný zoznam — odfotíš papierový lístok a aplikácia z neho vytiahne
položky, zaradí ich do kategórií a zosynchronizuje medzi telefónmi.

**Živá verzia:** https://michalko999.github.io/snuggle-script-add/

## Čo vie

- **Sken lístka** — z fotky prečíta položky aj množstvá (Claude Sonnet)
- **Kategórie** — položky sa zaraďujú automaticky (Claude Haiku) a appka sa učí z ručných opráv
- **Synchronizácia** — spoločný zoznam na viacerých zariadeniach, funguje aj offline
- **Poradie kategórií** — dá sa nastaviť podľa toho, ako chodíš obchodom

## Ako je to postavené

React + Vite, PWA (dá sa pridať na plochu). Push do `main` spúšťa nasadenie na GitHub Pages.

```
src/App.jsx           celá aplikácia
cloudflare-worker.js  proxy na Anthropic API + úložisko zoznamu (KV)
public/               manifest, service worker, ikony
```

Anthropic kľúč je uložený vo Cloudflare Workeri, nie v prehliadači. Aplikácia posiela
len prístupový token, ktorý zadáš v nastaveniach (⚙️). Postup nasadenia workera
je v komentári na začiatku `cloudflare-worker.js`.

## Dochádzka

Dochádzkový systém, ktorý tu kedysi tiež býval, má vlastný repozitár:
**https://github.com/Michalko999/dochadzka**

Pôvodná adresa `/snuggle-script-add/dochadzka.html` už len presmeruje na novú.
