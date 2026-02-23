# haniqa — Retail Management System

Internal tool for 2–3 managers. Node/Express + SQLite backend + plain HTML/CSS frontend.

---

## Local Development

```bash
npm install
npm run dev        # auto-reload with nodemon
```

Visit `http://localhost:3000`

The server creates all tables and seeds 16 products on first start.  
No default users are created — add users via the `/admin/create-user` API (see below).

---

## Adding Users

While logged in as an admin, run this in the browser console:

```js
fetch('/admin/create-user', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'name', password: 'pass123', role: 'manager' })
}).then(r => r.json()).then(console.log)
```

Roles: `admin` or `manager`

---

## VPS Deployment

### 1. Upload files to VPS

Use `scp`, `rsync`, or a Git repo. Do **not** upload `node_modules/` or `haniqa.db` from your local machine.

```bash
rsync -av --exclude node_modules --exclude haniqa.db --exclude .env \
  ./ user@your-vps-ip:/var/www/haniqa/
```

### 2. Set up environment on VPS

```bash
cd /var/www/haniqa
cp .env.example .env
nano .env   # fill in a strong SESSION_SECRET
```

### 3. Install dependencies and start with PM2

```bash
npm install --omit=dev
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # follow the printed command to auto-start on reboot
```

### 4. nginx reverse proxy (recommended)

Install nginx and create `/etc/nginx/sites-available/haniqa`:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/haniqa /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

### 5. HTTPS with Let's Encrypt

```bash
apt install certbot python3-certbot-nginx
certbot --nginx -d your-domain.com
```

Certbot will automatically update the nginx config for HTTPS.

### 6. Database backup (optional but recommended)

Add a daily cron job to back up the SQLite database:

```bash
crontab -e
# Add this line:
0 3 * * * cp /var/www/haniqa/haniqa.db /var/backups/haniqa-$(date +\%Y\%m\%d).db
```

---

## File Structure

```
haniqa/
├── server.js              # Express server + all API routes
├── db.js                  # SQLite (sql.js) setup, schema, seed data
├── ecosystem.config.js    # PM2 process config
├── package.json
├── .env                   # Secret config — never commit this
├── .env.example           # Template for .env
├── .gitignore
└── public/                # Static frontend files
    ├── styles.css
    ├── login.html
    ├── pos.html
    ├── dashboard.html
    ├── catalogue.html
    └── ai.html
```

---

## API Routes

| Method | Path                            | Auth     | Description                    |
|--------|---------------------------------|----------|--------------------------------|
| POST   | /api/auth/login                 | —        | Login                          |
| POST   | /api/auth/logout                | ✓        | Logout                         |
| GET    | /api/auth/me                    | ✓        | Check session                  |
| POST   | /admin/create-user              | admin    | Create a new user              |
| POST   | /admin/change-password          | admin    | Change a user's password       |
| GET    | /api/products                   | ✓        | All products                   |
| POST   | /api/products                   | ✓        | Add product                    |
| PATCH  | /api/products/:id               | ✓        | Update product                 |
| GET    | /api/transactions               | ✓        | Transaction history (last 200) |
| POST   | /api/transactions               | ✓        | Record sale or manual entry    |
| GET    | /api/dashboard/stats            | ✓        | Today's KPIs                   |
| GET    | /api/dashboard/monthly          | ✓        | Monthly revenue + units        |
| GET    | /api/dashboard/top-sellers      | ✓        | Top 8 products by sold         |
| GET    | /api/analytics/category-revenue | ✓        | Revenue by category            |
| GET    | /api/analytics/rankings         | ✓        | All products ranked by sold    |
