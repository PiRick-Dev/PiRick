# PiRick

PiRick is a small web app that lets people ask for something to watch in plain language. An AI model (running in Ollama) searches Jackett, picks a good copy, and adds it to qBittorrent. When the download finishes it appears in Plex. Nobody has to learn Jackett.

Only people with an account can use it. Accounts are created by an admin.

```
Browser chat ──▶ PiRick ──▶ Ollama (decides what to do)
                   ├──▶ Jackett      (search)
                   └──▶ qBittorrent  (download) ──▶ files land in a Plex library folder
```

## Quick start

You need Docker, plus Ollama, Jackett and qBittorrent already running somewhere PiRick can reach.

1. Copy the example settings and fill them in:

   ```
   cp .env.example .env
   ```

   At minimum set `JACKETT_API_KEY`, `QBIT_USERNAME`, `QBIT_PASSWORD`, and check the three URLs and `OLLAMA_MODEL`.

2. Build and start:

   ```
   docker compose up -d --build
   ```

3. Get the admin password. If you left `ADMIN_PASSWORD` empty, PiRick made one and printed it once:

   ```
   docker compose logs pirick
   ```

4. Open `http://<this-machine>:8787`, sign in as `admin`, and open **Admin**. The **Connections** section shows whether Ollama, Jackett and qBittorrent are reachable, with the reason if not. Fix `.env` and run `docker compose up -d` again until all three are green.

5. Open **Admin > Libraries** and add the folders downloads should go into, for example Movies, TV and Anime. PiRick refuses to download until at least one exists. See "Libraries" below.

6. Change your password under **Account**, then add the people who should have access under **Admin > People**.

## Reaching your other services

The URLs in `.env` are used from inside the PiRick container.

| Where the service runs | Use this address |
|---|---|
| On the Docker host, with its port published | `http://host.docker.internal:<port>` |
| In a container on the same Docker network as PiRick | `http://<container-name>:<port>` (add that network to `docker-compose.yml`) |
| On another machine | `http://<ip-or-hostname>:<port>` |

On Linux, Ollama listens only on `127.0.0.1` by default. Set `OLLAMA_HOST=0.0.0.0` for the Ollama service so containers can reach it.

## Running it on another machine from a registry

`docker-compose.yml` builds the image from this folder, so it only works where the source is. To run PiRick somewhere else, such as a stack in Dockge or Portainer, push the image to a registry and deploy a compose file that has `image:` and no `build:`.

```
docker build -t registry.example.com/pirick:latest .
docker push registry.example.com/pirick:latest
```

```yaml
services:
  pirick:
    image: registry.example.com/pirick:latest
    container_name: pirick
    restart: unless-stopped
    env_file: .env
    ports:
      - 8787:8080
    volumes:
      - pirick-data:/data
    extra_hosts:
      - host.docker.internal:host-gateway
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
volumes:
  pirick-data:
```

- Put your settings in the stack's `.env` (Dockge has a box for it next to the compose file).
- Leaving `build: .` in the file makes Compose try to build on a machine that has no Dockerfile, and the deploy fails.
- With a private registry, the Docker client that runs Compose has to be logged in. Dockge runs its own client inside its container, so a login on the host (or in TrueNAS) does not count: the pull fails with `no basic auth credentials`. Run `docker login <registry>` inside the Dockge container, for example `docker exec -it <dockge container> docker login <registry>` from the host. That login is lost if the Dockge container is recreated.
- The new instance starts with an empty database. Its first-run admin password is in the stack's log, and libraries and people have to be added again.

## Libraries: where downloads go

PiRick does not talk to Plex. A download shows up in Plex because qBittorrent saves it inside a folder that a Plex library watches. You tell PiRick which folders those are under **Admin > Libraries**. PiRick only ever saves into a folder listed there. It never invents a folder or a qBittorrent category, and until at least one library exists it refuses to download.

Each library has:

| Field | Example | What it is for |
|---|---|---|
| Name | `Anime` | What the assistant and the chat call it |
| What goes here | `Japanese animated series and films` | How the assistant decides between libraries. Be specific where two overlap, such as TV and Anime. |
| Folder | `/media/Anime` | The path exactly as qBittorrent sees it, capitals included. If qBittorrent runs in a container, this is the path inside that container. |
| Subfolder per show | on | Saves into `/media/Anime/<Show name>/` instead of straight into the folder. Usual for TV and anime, off for films. |
| qBittorrent category | (empty) | Optional. Nothing is sent to qBittorrent unless you fill this in. |

A typical setup is three libraries: Movies (no subfolders), TV and Anime (a subfolder per show).

**Folder checks.** The Folder box suggests real folders as you type, and each library shows whether its folder was found. A folder that differs only in capitals (`/media/tv` when the real one is `/media/TV`) is flagged with a one-click fix. If a library's folder does not exist, downloads into it are refused, because qBittorrent would otherwise create a new, wrongly named folder. These checks need qBittorrent 5; with an older version the row says "Could not check" and the path is used as typed.

**One folder per show.** With subfolders on, the assistant names the show and PiRick decides the folder:

- If a folder for that show already exists, it is reused with its own spelling. Capitals, punctuation and a trailing year are ignored when comparing, so a request for "pioneer one" goes into an existing `Pioneer One (2010)`.
- If no folder matches but one looks similar (an existing `Les Vampires` when the assistant says "The Vampires"), PiRick asks the assistant whether it is the same show before creating anything.
- Otherwise a new folder is created, and the chat says `(new folder)` so a wrong guess is easy to spot.

This works well for a show's later seasons and for alternative titles the assistant recognises. It cannot know that two completely different names are the same show. When that happens the chat says `(new folder)`, and you can move the download to the right folder in qBittorrent.

Every download PiRick adds is tagged `pirick` and `pirick-<username>` in qBittorrent, so you can see who asked for what.

## Personality

Under **Admin > Personality** you can describe how PiRick should sound, for example a pirate captain or a grumpy video-store clerk. A few starters are provided. It applies to everyone from their next message.

The personality changes the assistant's voice, not what it does: the rules about searching, choosing and reporting stay in force. The grey status lines in the chat and PiRick's own error messages are never affected. Leave the box empty for the default.

## HTTPS and your reverse proxy

PiRick serves plain HTTP on port 8080 inside the container (8787 on the host). Put your reverse proxy in front of it for HTTPS. Without HTTPS, passwords cross the network unencrypted.

- Keep `TRUST_PROXY=1` when exactly one proxy sits in front of PiRick. PiRick then uses the visitor's real address for login lockouts and marks the session cookie `Secure`. Use `2` for two proxies (for example Cloudflare in front of your own proxy). Use `false` if people connect directly with no proxy.
- The proxy must pass `X-Forwarded-For` and `X-Forwarded-Proto`. Nginx Proxy Manager, Traefik and Caddy do this by default.
- If the proxy is on the same machine, change the port line in `docker-compose.yml` to `"127.0.0.1:8787:8080"` so PiRick cannot be reached around the proxy.
- Replies are streamed. PiRick asks nginx not to buffer them and sends a heartbeat every 15 seconds, so default proxy timeouts are fine.

Caddy:

```
pirick.example.com {
    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1
    }
}
```

nginx:

```
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## Choosing a model

`OLLAMA_MODEL` must support tool calling: `ollama show <model>` lists `tools` under Capabilities. PiRick was developed and tested with `gemma4:e4b`.

Small models make mistakes, most often saying "I've started the download" without doing it. PiRick guards against that: a reply is only shown once it matches what actually happened, and the model is sent back to finish the job if it does not. The grey status lines in the chat ("Searched for…", "Started downloading…") are written by PiRick, not the model, and always reflect what really happened.

If a model behaves badly, set `LOG_LEVEL=debug` to see each step it takes in `docker compose logs pirick`, or try a larger model.

## Settings

Connection settings are environment variables in `.env`. Restart with `docker compose up -d` after changing them. Libraries and personality are set in the Admin screen instead and take effect immediately.

| Variable | What it does | Default |
|---|---|---|
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | The first admin account. Used only when PiRick has no users yet. | `admin`, random |
| `OLLAMA_URL` | Ollama address | `http://host.docker.internal:11434` |
| `OLLAMA_MODEL` | Model to use; must support tools | `gemma4:e4b` |
| `OLLAMA_NUM_CTX` | Context window in tokens | `8192` |
| `OLLAMA_KEEP_ALIVE` | How long Ollama keeps the model loaded, e.g. `30m` | Ollama's default |
| `OLLAMA_API_KEY` | Bearer token, if your Ollama needs one | none |
| `OLLAMA_TIMEOUT_SECONDS` | Give up on a reply after this long | `300` |
| `JACKETT_URL` | Jackett address | `http://host.docker.internal:9117` |
| `JACKETT_API_KEY` | From the top right of the Jackett dashboard | none (required) |
| `JACKETT_INDEXER` | `all`, or one indexer's id | `all` |
| `JACKETT_TIMEOUT_SECONDS` | Give up on a search after this long | `60` |
| `SEARCH_RESULT_LIMIT` | How many results the model gets to choose from | `15` |
| `QBIT_URL` | qBittorrent Web UI address | `http://host.docker.internal:8080` |
| `QBIT_USERNAME`, `QBIT_PASSWORD` | qBittorrent Web UI login | none |
| `MAX_TORRENT_SIZE_GB` | Refuse anything larger; `0` = no limit | `0` |
| `TRUST_PROXY` | Number of reverse proxies in front of PiRick, or `false` | `false` (`1` in `.env.example`) |
| `COOKIE_SECURE` | `auto`, `true` or `false` | `auto` |
| `SESSION_IDLE_DAYS`, `SESSION_MAX_DAYS` | Sign out after this long unused / regardless | `7`, `30` |
| `LOG_LEVEL` | `debug`, `info`, `warn` or `error` | `info` |

## Security

What is in place:

- Passwords are hashed with scrypt and a per-user salt. They are never stored or logged.
- Sessions are random tokens in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` over HTTPS). Only a hash of the token is stored. Sessions end after 7 idle days or 30 days in total, and when the password changes.
- Login attempts are limited: 5 per address and username, 20 per username, 30 per address, every 15 minutes.
- Requests that change anything must come from PiRick's own pages (custom header plus the browser's same-origin signal), which blocks cross-site request forgery.
- A strict Content Security Policy allows no inline or third-party scripts. Model replies and torrent titles are inserted as text, never as HTML.
- The model never sees or supplies links, magnet addresses, folder paths or the Jackett key. It can only pick from results Jackett returned to that same person, by id, and only save into a library an admin defined. Show names it supplies are cleaned so they cannot point outside the library's folder.
- The container runs as a non-root user with a read-only filesystem, no Linux capabilities and no privilege escalation. Only `/data` is writable.

What it does not do:

- No two-factor login and no self-service sign-up or password recovery. Admins reset passwords.
- Anyone with an account can add downloads. Use `MAX_TORRENT_SIZE_GB` if disk space is a concern.
- `.env` holds your Jackett key and qBittorrent password in plain text. Keep the file private; it is excluded from git and from the Docker image.

## Managing people

Admins add people, reset passwords and remove people under **Admin > People**. Everyone can change their own password under **Account**.

If an admin is locked out:

```
docker compose exec pirick node src/cli.js reset-password <username>
```

This prints a new password and signs that person out everywhere.

The database (accounts, sessions, chat history, libraries and personality) is one SQLite file in the `pirick-data` volume. To back it up, stop PiRick and copy the volume.

## Troubleshooting

| What you see | Likely cause |
|---|---|
| Ollama: "model … is not pulled" | Run `ollama pull <model>` on the Ollama machine. |
| "Cannot reach … (ECONNREFUSED)" | Wrong URL, or the service only listens on `127.0.0.1`. See "Reaching your other services". |
| Jackett: "rejected the API key" or "did not return search results" | `JACKETT_API_KEY` or `JACKETT_URL` is wrong. |
| qBittorrent: "rejected the login" | Wrong `QBIT_USERNAME` / `QBIT_PASSWORD`. |
| qBittorrent: "temporarily banned" | Too many failed logins. Fix the password, then wait or restart qBittorrent. |
| Searches find nothing | Check that the same search works in Jackett's own page and that indexers are configured. |
| Downloads finish but are not in Plex | The library's folder is not inside a Plex library folder. See "Libraries". |
| "Not downloaded: the … library's folder does not exist" | The folder in Admin > Libraries is wrong, often only in its capitals. Open that screen and use the suggested fix. |
| A download went into the wrong library | Make the "What goes here" descriptions more specific, especially where two libraries overlap. |
| qBittorrent: "refusing PiRick before it looks at the password" | qBittorrent rejects requests whose port differs from its own, which happens when its port is remapped in Docker (for example `9090:8080`). Use the same port on both sides, or turn off "Enable Host header validation" in its Web UI options. |
| Signed out straight after signing in | `COOKIE_SECURE=true` while reaching PiRick over plain HTTP. Use `auto`. |
| One person's wrong passwords lock everyone out | `TRUST_PROXY` is `false` behind a proxy, so all visitors appear to share the proxy's address. |

Admins see the technical reason for a failure in the chat itself. Other people get a plain message, and the reason is in `docker compose logs pirick`.

## Upgrading from the first version

Earlier versions chose a qBittorrent category per media type (`movies`, `tv`, …) from `.env`, which made qBittorrent create folders with those names. That is gone.

1. Rebuild: `docker compose up -d --build`. Accounts and chat history are kept.
2. Add your libraries under **Admin > Libraries**. Downloads are refused until you do.
3. Remove the `QBIT_CATEGORY_*` and `QBIT_SAVEPATH_*` lines from `.env`. They are ignored, and PiRick logs a reminder while they remain.
4. In qBittorrent, move anything that landed in a stray folder such as lowercase `tv`, then delete that folder and the categories PiRick caused (`tv`, `movies`, `music`, `books`) if you do not use them.

## Development

Needs Node.js 22.13 or newer. Express is the only dependency.

```
npm install
npm test          # unit tests plus a full run against stand-in Ollama, Jackett and qBittorrent servers
npm run dev       # runs from .env with auto-reload; data goes to ./data
```

| Path | What is there |
|---|---|
| `src/server.js`, `src/build.js` | Start-up and wiring |
| `src/routes.js` | Pages, API, security headers |
| `src/auth.js` | Passwords, sessions, rate limiting, accounts |
| `src/agent.js` | The system prompt, the tool-calling loop and the check on model replies |
| `src/tools.js` | The three tools the model can call: search, download (into a library), list downloads |
| `src/ollama.js`, `src/jackett.js`, `src/qbittorrent.js` | Clients for the three services |
| `src/settings.js`, `src/folders.js` | Libraries and personality; folder naming, matching and checks |
| `src/conversation.js`, `src/db.js` | Chat history and the SQLite schema |
| `web/` | Login page, chat page, styles and browser scripts (no build step) |
| `test/` | Tests |
