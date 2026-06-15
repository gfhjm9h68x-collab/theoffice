# Fix: a fleet nem indul el automatikusan bootkor (linger)

**Státusz:** nyitott — javítani kell a telepítőben.
**Érintett fájl:** `scripts/install.sh` (5. lépés: "enable + start").
**Dátum:** 2026-06-10

---

## Tünet

A gép bekapcsolása után a The Office **nem indul el magától**. A service-ek csak
akkor jönnek fel, amikor a `marty` user **interaktívan belép** (login/SSH).
Headless boot, reboot vagy "csak bekapcsolom és nem lépek be" esetén a dashboard,
a Slack ingest, a scheduler és a bus nem futnak.

Tipikus jel: a `systemctl --user status theoffice.service` **Active since** ideje
a *bejelentkezés* idejéhez közeli, nem a *boot* idejéhez.

## Gyökérok

A `theoffice.service` és a `theoffice-tmux.service` **systemd `--user`** unitok.
Egy user systemd példánya (`user@<uid>.service`) bootkor csak akkor indul el
belépés nélkül, ha a felhasználóhoz be van kapcsolva a **linger**
(`loginctl enable-linger`). Linger nélkül a user-instance csak az első
interaktív bejelentkezéskor indul — ezért fut a fleet login után, de bootkor nem.

A `scripts/install.sh` **már próbálja** bekapcsolni a lingert, de a hívás
hibás módon csendben elbukik:

```bash
loginctl enable-linger "$USER" 2>/dev/null || warn "could not enable linger (services may not survive logout)"
```

Három probléma ezzel a sorral:

1. **`sudo` nélkül hívja.** A `loginctl enable-linger` privilegizált művelet
   (polkit/root kell hozzá). Nem-interaktív telepítéskor — pl. amikor a
   `bootstrap.sh` `curl ... | bash` formában fut, tty nélkül — a polkit
   megtagadja.
2. **Elnyeli a hibát** (`2>/dev/null`), így a telepítés "sikeresnek" látszik,
   miközben a linger valójában `no` maradt. A `|| warn` üzenet könnyen átsiklik.
3. **Nem ellenőrzi** utólag, hogy a linger tényleg `yes`-re váltott-e.

Eredmény: `Linger=no` marad, a fleet nem indul bootkor, és a telepítő mégis
zöld jelzést ad.

## Javítás (mit kell commitolni)

A `scripts/install.sh` 5. lépésében cseréld le a jelenlegi egysoros
`enable-linger` hívást erre a blokkra:

```bash
# ---- 5. enable + start ------------------------------------------------------
say "Enabling linger (so the fleet starts at boot, without login)"
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" = "yes" ]; then
  say "linger already enabled"
else
  # enable-linger needs root/polkit; try passwordless sudo, then interactive sudo,
  # then a plain call as a last resort.
  if sudo -n loginctl enable-linger "$USER" 2>/dev/null \
     || sudo loginctl enable-linger "$USER" 2>/dev/null \
     || loginctl enable-linger "$USER" 2>/dev/null; then :; fi
fi

# verify — do NOT continue silently if it failed
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
  warn "LINGER IS STILL OFF. The fleet will NOT start at boot until you run:"
  warn "    sudo loginctl enable-linger $USER"
  warn "Verify with: loginctl show-user $USER | grep Linger   # want: Linger=yes"
fi
```

A lényegi változások:

- **`sudo`-val próbálja** — előbb `sudo -n` (passwordless setupnál nem akad el),
  aztán interaktív `sudo`, végül plain fallback.
- **Ellenőrzi a `Linger` értéket** a hívás után, és ha még mindig `no`,
  **hangosan, kihagyhatatlanul** kiírja a pontos kézi parancsot — nem nyeli el
  a hibát.
- **Idempotens** — ha már `yes`, nem csinál semmit.

### Megjegyzés a `bootstrap.sh`-hoz

A `bootstrap.sh` `curl | bash` formában fut, ahol nincs tty az interaktív
sudóhoz. A `sudo -n` ág passwordless sudónál megoldja; ahol nincs passwordless
sudo, ott a hangos warning irányítja a usert a kézi parancsra.

## Ellenőrzés a javítás után

```bash
# linger be van kapcsolva?
loginctl show-user "$USER" | grep Linger        # want: Linger=yes

# teljes próba: reboot, majd login NÉLKÜL nézd meg
sudo reboot
systemctl --user status theoffice.service       # Active since ≈ boot ideje, nem login
```

## Azonnali kézi megoldás (a kód javítása nélkül)

Ha most kell, hogy menjen, kézzel elég egyszer:

```bash
sudo loginctl enable-linger marty
loginctl show-user marty | grep Linger          # Linger=yes
```

> Ez a `marty` userön **már be van kapcsolva** (`Linger=yes`, 2026-06-10).
> A fenti telepítő-javítás a jövőbeli / másik gépre szóló telepítésekre kell,
> hogy ne forduljon elő újra.
