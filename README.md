# Calorie Calendar

A calorie log that works like an app: look up foods on Open Food Facts, turn grams into calories, and keep a dated list of what you ate. The backend is a FastAPI service for food search and user accounts; the frontend is a static progressive web app (PWA).

## Features

- **Food search with calorie maths.** Search Open Food Facts by name, compare kcal, protein, fat and carbs per 100 g, and pick a product to fill in an entry for the amount you ate.
- **Entry log.** Dated entries, newest first, saved in the browser (IndexedDB) so they survive reloads.
- **User accounts.** Register and log in from the page or the API. Passwords are hashed with PBKDF2-SHA256, and login tokens (JWT) last 60 minutes and carry the username and email.
- **Email-based Open Food Facts contact.** Open Food Facts asks API clients to include a contact email. A logged-in user's searches send that user's own email; other searches use an optional fallback you configure. No personal email is built into the code.
- **Installable PWA.** A web app manifest and icons let browsers install it, and a service worker keeps the app and saved entries available offline. Food search needs a connection.
- **Deploys without code changes.** The backend's allowed origins and the frontend's backend URL are both set through environment variables.

## Project layout

```text
backend/main.py            FastAPI app: /search-food, /register, /login, /me, /add-entry, /get-entries, /health
backend/requirements.txt   Python dependencies
backend/.env               Local backend settings; not committed (see Configuration)
frontend/                  Static site: index.html, config.js, js/app.js, css/, manifest.json, service-worker.js, icons/
frontend/config.js         Frontend settings: the backend's URL
scripts/build_frontend.py  Builds a deployable copy of the frontend in dist/
```

## Run locally

You need Python 3.12 (tested with 3.12.3). Run these from the project root.

1. Install the backend's dependencies:

   ```bash
   python3 -m venv .venv && .venv/bin/pip install -r backend/requirements.txt
   ```

2. Create `backend/.env` if it doesn't exist yet (see [Configuration](#configuration)).

3. Start the backend on http://127.0.0.1:8000:

   ```bash
   .venv/bin/uvicorn backend.main:app --env-file backend/.env
   ```

4. In a second terminal, serve the frontend on http://localhost:5500:

   ```bash
   python3 -m http.server 5500 --bind 127.0.0.1 --directory frontend
   ```

5. Open http://localhost:5500. By default the backend accepts browser requests only from http://localhost:5500 and http://127.0.0.1:5500, and `frontend/config.js` already points at the local backend.

## Configuration

### Backend

The backend reads its settings from environment variables. Locally they live in `backend/.env`, which uvicorn loads with `--env-file`. On a hosting service, set them in its dashboard or CLI instead: `backend/.env` is never committed or uploaded.

| Variable | Required | Purpose |
|---|---|---|
| `JWT_SECRET_KEY` | Yes | Signs login tokens. Use at least 32 random characters. Without it, the backend makes up a temporary key, so logins stop working whenever it restarts. Changing it logs everyone out. |
| `OPEN_FOOD_FACTS_CONTACT_EMAIL` | No | Fallback contact email for food searches sent without a valid login token; logged-in users' searches send their own email. Use an address you control, or leave it empty to send no contact. |
| `ALLOWED_ORIGINS` | No | Web page addresses allowed to call the API from a browser, separated by commas, like `https://calorie-calendar.netlify.app`. Each is a scheme and host with no path; a trailing slash is ignored, and invalid entries are skipped with a warning. Setting it replaces the default, `http://localhost:5500,http://127.0.0.1:5500`, so list those too if your local page should still work. |
| `CALORIE_CALENDAR_DATABASE` | No | Path of the SQLite file for accounts and entries added through the API. Default: `backend/calorieCalendar.db`. |

A `backend/.env` for local use:

```dotenv
OPEN_FOOD_FACTS_CONTACT_EMAIL=your@example.com
JWT_SECRET_KEY=replace-with-a-generated-secret
# ALLOWED_ORIGINS=http://localhost:5500,http://127.0.0.1:5500
# CALORIE_CALENDAR_DATABASE=backend/calorieCalendar.db
```

- Generate a secret with `python3 -c "import secrets; print(secrets.token_urlsafe(48))"`.
- `your@example.com` is a placeholder on a domain reserved for examples, so it never names a real person. Replace it with a contact address you control, or leave the value empty.
- `.gitignore` keeps `backend/.env`, `*.db` files, `.venv/`, `venv/`, `__pycache__/` and the `dist/` build folder out of Git.

### Frontend

The page reads the backend's URL from `frontend/config.js`, which points at the local backend (`http://127.0.0.1:8000`), so local development needs no setup. For a deployment, leave that file alone and build a copy with the deployed backend's URL:

```bash
API_BASE_URL=https://calorie-calendar-api.onrender.com python3 scripts/build_frontend.py
```

This copies the page to `dist/` and writes a `config.js` there that points at `API_BASE_URL`, which must be a full `http://` or `https://` URL. Deploy `dist/`, not `frontend/`. Netlify and Vercel can run the same command as their build step (see [Deployment](#deployment)).

## Accounts and the Open Food Facts contact

- Register with a username, password and email, then log in with the username and password. Both endpoints take form fields; the Account card on the page uses the same endpoints.
- Usernames are 3–50 letters, numbers, dots, dashes or underscores, and aren't case-sensitive. Passwords are 6–128 characters. Emails must be ASCII addresses like `name@example.com`, up to 254 characters; two accounts can share one.
- `/login` returns `{"access_token": "…", "token_type": "bearer"}`. The token lasts 60 minutes, and its claims include the username and email (`{"sub": "john", "email": "john@example.com", …}`). Tokens are signed, not encrypted, so anyone holding one can read them.
- Send the token as `Authorization: Bearer <token>`. `/add-entry` requires it, and `/me` returns the logged-in username. The page keeps the token in the browser's `localStorage`.
- `/search-food` works without a token. With a valid one, the backend sends the user's email to Open Food Facts in the User-Agent header: `CalorieCalendar/0.1 (john@example.com)`. Without a token, or with an expired or invalid one, it sends `OPEN_FOOD_FACTS_CONTACT_EMAIL` instead (or no email while that's empty). The page sends the token with every search while you're logged in.

## Test the full flow

Start the backend with debug logging, so it prints the User-Agent of each search (stop any backend already running on port 8000 first):

```bash
.venv/bin/uvicorn backend.main:app --env-file backend/.env --log-level debug
```

Then, in another terminal:

1. Register a user. Expect HTTP 201 and `{"status":"user created","username":"john","email":"john@example.com"}`. Running it again returns 409, because the username is taken.

   ```bash
   curl -X POST http://localhost:8000/register -d "username=john&password=secret&email=john@example.com"
   ```

2. Log in and copy the `access_token` value from the response.

   ```bash
   curl -X POST http://localhost:8000/login -d "username=john&password=secret"
   ```

   To check that the token carries the email, decode it (no secret needed). Expect `{'sub': 'john', 'email': 'john@example.com', 'iat': …, 'exp': …}`.

   ```bash
   .venv/bin/python -c "import sys; from jose import jwt; print(jwt.get_unverified_claims(sys.argv[1]))" "<JWT>"
   ```

3. Search with the token in place of `<JWT>`. Expect HTTP 200 and a `products` list.

   ```bash
   curl -X POST http://localhost:8000/search-food -H "Authorization: Bearer <JWT>" -H "Content-Type: application/json" -d '{"foodName": "banana"}'
   ```

4. In the backend's output, find `Open Food Facts User-Agent for this search: 'CalorieCalendar/0.1 (john@example.com)'`. The same search without the `Authorization` header logs the fallback from `OPEN_FOOD_FACTS_CONTACT_EMAIL` instead.

## Deployment

Each half needs the other's URL, so deploy in this order:

1. Put the project in Git.
2. Deploy the backend to Render or Heroku, and note its URL.
3. Deploy the frontend to Netlify or Vercel with `API_BASE_URL` set to the backend's URL, and note the frontend's URL.
4. Set `ALLOWED_ORIGINS` on the backend to the frontend's URL, then check the app.

Everything is configured through environment variables, so no code changes are needed. All four hosts serve HTTPS, which the service worker and app installation need.

### 1. Put the project in Git

Render, Heroku and Git-based Netlify or Vercel builds deploy from a Git repository. From the project root:

```bash
git init -b main
```

```bash
git add . && git status
```

Check that `git status` doesn't list `backend/.env`, a `.db` file, `dist/` or a virtual environment (`.gitignore` excludes them). Unstage anything you don't want to publish, such as the local notes in `context/`, with `git rm -r --cached <path>`. Then commit:

```bash
git commit -m "Calorie Calendar"
```

For Render, Netlify and Vercel, also push the repository to GitHub, GitLab or Bitbucket.

### 2a. Backend on Render

1. In the Render Dashboard, click **New > Web Service** and pick the repository.
2. Use these settings:
   - **Language:** Python 3
   - **Branch:** `main`
   - **Root Directory:** leave empty
   - **Build Command:** `pip install -r backend/requirements.txt`
   - **Start Command:** `uvicorn backend.main:app --host 0.0.0.0 --port $PORT`
3. Under **Advanced**, add these environment variables:
   - `PYTHON_VERSION` = `3.12.3`. Without it, new Render services get Python 3.14, which this app hasn't been tested on. Render needs the full version number.
   - `JWT_SECRET_KEY` = a newly generated secret; don't reuse your local one.
   - `OPEN_FOOD_FACTS_CONTACT_EMAIL` = an address you control (optional).
   - `ALLOWED_ORIGINS` comes in step 4, once the frontend has a URL. If you already know it, add it now.
4. Create the service. When the deploy finishes, open the service's `onrender.com` URL (shown at the top of its page) followed by `/health`; it should return `{"status":"healthy"}`. Every push to `main` redeploys the service.

On the free instance type:

- The service spins down after 15 minutes without traffic and takes about a minute to wake up. The page gives up on a search after 15 seconds, so the first search after a quiet spell may fail with "The search took too long"; search again.
- The filesystem is ephemeral: the SQLite file, with every account and API entry, is wiped on each redeploy, restart and spin-down. To keep them, use a paid instance with a persistent disk mounted at, for example, `/var/data`, and set `CALORIE_CALENDAR_DATABASE=/var/data/calorieCalendar.db`. Only files under the mount path persist, and a service with a disk can't run more than one instance.

### 2b. Backend on Heroku

Heroku has no free plan; its cheapest dyno type (Eco) sleeps after 30 minutes without traffic. Install the [Heroku CLI](https://devcenter.heroku.com/articles/heroku-cli) and run `heroku login` first.

1. Add the three files Heroku needs at the project root, then commit them. Heroku only recognizes a Python app by a `requirements.txt` in the root, starts it with the `Procfile`, and reads the Python version from `.python-version`.

   ```bash
   printf -- '-r backend/requirements.txt\n' > requirements.txt
   ```

   ```bash
   printf 'web: uvicorn backend.main:app --host 0.0.0.0 --port $PORT\n' > Procfile
   ```

   ```bash
   printf '3.12\n' > .python-version
   ```

   ```bash
   git add requirements.txt Procfile .python-version && git commit -m "Add Heroku settings"
   ```

2. Create the app. This adds a `heroku` Git remote and prints the app's URL, which ends in a random suffix (`https://<app-name>-<random>.herokuapp.com`).

   ```bash
   heroku create
   ```

3. Set the environment variables, replacing the placeholder with an address you control (or leaving out `OPEN_FOOD_FACTS_CONTACT_EMAIL`). `ALLOWED_ORIGINS` comes in step 4.

   ```bash
   heroku config:set JWT_SECRET_KEY="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')" OPEN_FOOD_FACTS_CONTACT_EMAIL=your@example.com
   ```

4. Deploy, then open the app's URL followed by `/health`; it should return `{"status":"healthy"}`. `heroku logs --tail` shows the server's output.

   ```bash
   git push heroku main
   ```

Dyno filesystems are ephemeral: anything written at runtime, including the SQLite file with every account and API entry, is discarded whenever the dyno stops or restarts, and an Eco dyno stops each time it sleeps. Heroku has no persistent disks, so keeping that data would mean switching to a hosted database such as Postgres, which needs code changes.

### 3a. Frontend on Netlify

**From Git**, so Netlify rebuilds the page on every push:

1. Go to https://app.netlify.com/start, connect your Git provider and pick the repository.
2. Use these build settings:
   - **Base directory:** leave empty
   - **Build command:** `python3 scripts/build_frontend.py`
   - **Publish directory:** `dist`
3. Add an environment variable named `API_BASE_URL` with the backend's URL, then deploy. If you add it after the first deploy, trigger a new deploy so the build picks it up. The site is served at `https://<site-name>.netlify.app`.

**Or build locally and upload:**

1. Build the page with the backend's URL:

   ```bash
   API_BASE_URL=https://calorie-calendar-api.onrender.com python3 scripts/build_frontend.py
   ```

2. Drop the `dist` folder onto https://app.netlify.com/drop (if you aren't logged in, you have one hour to claim the new site), or deploy it with the CLI after `npm install -g netlify-cli` and `netlify login`. `--site-name` creates the site if it doesn't exist yet; the name must be unique across Netlify.

   ```bash
   netlify deploy --dir dist --no-build --prod --site-name calorie-calendar-yourname
   ```

### 3b. Frontend on Vercel

**From Git**, so Vercel rebuilds the page on every push:

1. In Vercel, add a new project and import the repository. Leave **Root Directory** as the repository root.
2. Set **Framework Preset** to **Other**. Turn on the override for **Build Command** and enter `python3 scripts/build_frontend.py`, and turn on the override for **Output Directory** and enter `dist`.
3. Add an environment variable named `API_BASE_URL` with the backend's URL, then deploy.

**Or build locally and deploy with the CLI**, after `npm install -g vercel` and `vercel login`:

1. Build the page with the backend's URL:

   ```bash
   API_BASE_URL=https://calorie-calendar-api.onrender.com python3 scripts/build_frontend.py
   ```

2. Deploy the `dist` folder. The first run links it to a new Vercel project: choose your team and a project name, and keep the detected settings, since the folder is plain static files with no build step. The command prints the production URL.

   ```bash
   vercel deploy dist --prod
   ```

### 4. Connect and check

1. Set `ALLOWED_ORIGINS` on the backend to the frontend's URL, with no trailing slash. Separate several URLs with commas, and add `http://localhost:5500,http://127.0.0.1:5500` if your local page should also use the deployed backend.
   - **Render:** in the service's **Environment** settings, add the variable and choose **Save and deploy**.
   - **Heroku:** set it with the command below, which restarts the app.

   ```bash
   heroku config:set ALLOWED_ORIGINS=https://calorie-calendar.netlify.app
   ```

2. Check the backend's logs (the **Logs** tab on Render, or `heroku logs --tail`). After the restart they should show `Accepting browser requests from` followed by your frontend's URL.
3. Open the frontend's URL, register with an email, log in and search for a food. The browser's developer console should show no CORS or network errors.
4. To see the User-Agent each search sends, add `--log-level debug` to the start command. Remove it again afterwards, because it writes users' emails to the logs.
5. Install the app from the browser's install option, if it offers one.

### Before going live

- [ ] `backend/.env` isn't in the repository; secrets are set in the host's settings instead.
- [ ] `JWT_SECRET_KEY` on the host is a fresh random value of at least 32 characters.
- [ ] `OPEN_FOOD_FACTS_CONTACT_EMAIL` is an address you control, or empty.
- [ ] The frontend was built with `API_BASE_URL` set to the deployed backend, and the backend's `ALLOWED_ORIGINS` lists the deployed frontend.
- [ ] You're fine with accounts being reset on free hosting, or you've set up a persistent disk.

## Known limitations

- **No editing or deleting entries.** Neither the web page nor the API can change or remove an entry once it's added.
- **Two separate entry lists.** The web page stores entries in the browser (IndexedDB); the API (`/add-entry`, `/get-entries`) stores them in a SQLite file. They aren't synced, so entries added in one don't appear in the other.
- **One list per browser address.** http://localhost:5500 and http://127.0.0.1:5500 keep separate lists, and clearing the site's data in the browser deletes that address's entries.
- **Accounts don't own entries.** A login is only needed to add entries through the API. Those entries are shared rather than per user, `/get-entries` is public, and entries saved on the web page don't need a login at all.
- **A deployed backend is open to anyone.** Anyone with its URL can register, add entries through the API, read every API entry at `/get-entries` and browse the API docs at `/docs`. `ALLOWED_ORIGINS` only limits which web pages a browser lets call it.
- **Data doesn't last on free hosting.** Render free instances and Heroku dynos wipe the SQLite file when they restart, so accounts and API entries disappear (see [Deployment](#deployment)).
- **No account management.** There's no password or email change, no password reset, no account deletion, and no way to revoke a token before it expires; logging out only removes it from the browser.
- **The login token lives in `localStorage`.** Scripts running on the page can read it, so the page inserts search results and entries as plain text rather than HTML.
- **`/add-entry` and `/search-food` need JSON.** Requests without `Content-Type: application/json` (for example `curl -d "query=banana"` on its own) are rejected with `422`. `/search-food` takes `{"foodName": "…"}`.
- **Dependencies aren't pinned to exact versions.** Each deploy installs the newest releases. The app was tested with Python 3.12.3, fastapi 0.141.1, starlette 1.6.0, pydantic 2.13.5, uvicorn 0.52.4, httpx 0.28.1, python-jose 3.5.0, cryptography 50.0.1, passlib 1.7.4, python-multipart 0.0.32 and python-dotenv 1.2.3. If a new release breaks a deploy, pin these in `backend/requirements.txt` (for example `fastapi==0.141.1`).
- **Plain `uvicorn` crashes on this machine.** The `uvicorn` on the system PATH (`~/.local/bin/uvicorn`) fails with `ImportError: cannot import name 'ServerProtocol'` because of an old system `websockets` package. Use `.venv/bin/uvicorn`.
- **Food search needs the backend and the internet.** Offline, the page still opens and shows saved entries, but search doesn't work. Search also only works when the page's address is in the backend's `ALLOWED_ORIGINS` (by default http://localhost:5500 and http://127.0.0.1:5500).
