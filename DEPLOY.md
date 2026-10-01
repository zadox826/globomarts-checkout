# Deploying the checkout to `checkout.ninjjakoffe.site`

Your domain `ninjjakoffe.site` is registered at **Namecheap** and uses
**Namecheap BasicDNS** (`dns1/dns2.registrar-servers.com`). The apex already
points at Shopify (`23.227.38.65`) — leave that alone. We only add a **new
subdomain** for the checkout, so nothing about your existing store breaks.

---

## First: what "free VPS" actually means

There is no provider that hands out a VPS without an account. Every option below
needs **you** to sign up — I can't create an account, verify a phone, or put a
card on file on your behalf. Here are the real options, ranked for your case:

| Option | Cost | Card needed? | Custom domain | Honest catch |
|---|---|---|---|---|
| **Render** (web service) | $0 | **No** | Yes, free | Sleeps after 15 min idle; ~30–60 s cold start on first visit |
| **Koyeb** | $0 | No | Yes | 1 free service, similar sleep behaviour |
| **Oracle Cloud Always Free** | $0 forever | Yes (verification) | Yes | A **real** VPS (4 ARM cores / 24 GB). Signup often rejected for new/low-history accounts; can take days |
| **Google Cloud free tier** | $0 | Yes | Yes | e2-micro in select US regions only — far from Germany |
| **Fly.io** | ~$0–2 | Yes | Yes | No longer truly free; needs a card |
| **Railway** | $5 trial | Yes | Yes | Credit runs out, then it's paid |

**Recommendation: start with Render.** It's genuinely $0, needs no card, gives
you free HTTPS on `checkout.ninjjakoffe.site`, and the config is already written
(`render.yaml`). Move to Oracle/GCP later if you want a persistent server.

> Reminder: you still need the **publishable key** from your Chargebee dashboard
> before card fields work. See step 5.

---

## Path A — Render (free, ~10 minutes, recommended)

### 1. Put the project on GitHub
```bash
cd /home/user/chargebee-checkout
git init && git add -A && git commit -m "Chargebee custom checkout"
# create an empty PRIVATE repo on github.com, then:
git remote add origin git@github.com:<you>/ninjjakoffe-checkout.git
git push -u origin main
```
`.env` is gitignored — **verify it is not pushed**: `git ls-files | grep env`
should only show `.env.example` and `.env.production.example`.

### 2. Create the Render service
1. Sign up at [render.com](https://render.com) (GitHub login, no card).
2. **New → Blueprint** → pick your repo. Render reads `render.yaml`.
3. It will prompt for the two secret values:
   - `CHARGEBEE_API_KEY` → your `test_...` API key
   - `CHARGEBEE_PUBLISHABLE_KEY` → your `test__...` publishable key (or leave blank for now)
4. Deploy. First build takes ~2 minutes.
5. Check it works: `https://<your-app>.onrender.com/healthz` → `{"ok":true,...}`

### 3. Add your custom domain
1. Render → your service → **Settings → Custom Domains → Add Custom Domain**.
2. Enter `checkout.ninjjakoffe.site`. Render shows you a **CNAME target** like
   `ninjjakoffe-checkout.onrender.com`.
3. Go to **Namecheap → Domain List → ninjjakoffe.site → Advanced DNS** and add:

   | Type | Host | Value | TTL |
   |---|---|---|---|
   | CNAME Record | `checkout` | `ninjjakoffe-checkout.onrender.com` | Automatic |

   **Do not touch** the existing `@` A record (Shopify) or the MX records (email).
4. Wait 5–30 min. Render auto-issues a Let's Encrypt certificate once DNS resolves.
5. Confirm: `dig +short checkout.ninjjakoffe.site` should show the CNAME target.

### 4. Update the redirect URLs
Render → Environment → set:
```
REDIRECT_URL = https://checkout.ninjjakoffe.site/success
CANCEL_URL   = https://checkout.ninjjakoffe.site/cancel
```
Save (it redeploys automatically).

### 5. Allowlist the domain in Chargebee (required)
Chargebee blocks redirects to domains it doesn't know:
**Settings → Configure Chargebee → Checkout & Self-Serve Portal → Advanced
Settings → Add domains** → enter `https://checkout.ninjjakoffe.site` → **Apply**
→ **Publish**.

### 6. Add the publishable key
Chargebee dashboard → **Settings → Configure Chargebee → API Keys and
Webhooks → API Keys → Add API Key → Publishable Key**. Copy the `test__...`
value into Render's `CHARGEBEE_PUBLISHABLE_KEY`. Card fields then mount.

---

## Path B — Real VPS (Oracle Cloud / GCP / Hetzner / DigitalOcean)

Once you have an Ubuntu 22.04/24.04 server with a public IP:

### 1. Point DNS at it
Namecheap → Advanced DNS → add:

| Type | Host | Value | TTL |
|---|---|---|---|
| A Record | `checkout` | `<your server public IP>` | Automatic |

Verify: `dig +short checkout.ninjjakoffe.site` → your IP.

### 2. Upload and run the setup script
```bash
# from your local machine
scp -r /home/user/chargebee-checkout ubuntu@<server-ip>:/tmp/checkout
ssh ubuntu@<server-ip>
sudo bash /tmp/checkout/deploy/setup-vps.sh
```

The script installs Node 20 + nginx + certbot, deploys to `/opt/checkout`,
starts a hardened systemd service, configures the nginx reverse proxy, and gets
a Let's Encrypt certificate. It sanity-checks DNS first and warns you if it
doesn't match.

### 3. Fill in the keys
```bash
sudo nano /opt/checkout/.env        # paste API key + publishable key
sudo systemctl restart checkout
```

### 4. Verify
```bash
curl -s https://checkout.ninjjakoffe.site/healthz      # {"ok":true,...}
curl -s https://checkout.ninjjakoffe.site/api/price    # price JSON
sudo journalctl -u checkout -f                         # live logs
```

Then do **steps 5 and 6 from Path A** (Chargebee domain allowlist + publishable key).

### Useful commands
```bash
sudo systemctl status checkout      # is it running?
sudo systemctl restart checkout     # after editing .env
sudo journalctl -u checkout -n 50   # recent logs
sudo nginx -t && sudo systemctl reload nginx
sudo certbot renew --dry-run        # test cert auto-renewal
```

---

## Docker (works on any host)

```bash
docker build -t ninjjakoffe-checkout .
docker run -d --name checkout \
  --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  --env-file .env \
  ninjjakoffe-checkout
```
Bind to `127.0.0.1` and let nginx terminate TLS in front of it.

---

## Security checklist before going live

- [ ] `.env` is **not** in git (`git ls-files | grep -E '^\.env$'` → empty)
- [ ] API key is server-side only — grep the frontend: `grep -r "test_P6" public/` → no hits
- [ ] HTTPS works and HTTP redirects to it
- [ ] `checkout.ninjjakoffe.site` is allowlisted in Chargebee
- [ ] Test a real card: `4111 1111 1111 1111`, any future expiry, any CVV
- [ ] Test the PayPal button (needs a PayPal gateway connected in Chargebee)
- [ ] When you go live: swap the test API key for a **live** key and use live publishable key
- [ ] Never put a live secret API key in frontend code or a public repo

---

## Things that will still not work after deploy

1. **PayPal button** — needs a PayPal gateway connected in Chargebee. Confirmed
   there is no API for this; it's dashboard-only, and the gateway form wants
   **API Username / Password / Signature**, not a Client ID + Secret.
2. **€1.00 display** — your item price is USD until you enable multicurrency
   (Settings → Configure Chargebee → Currencies → add EUR). After that, switch
   the item price currency and the page shows `€1.00` automatically.
3. **Card fields** — need the publishable key (step 6 above).
