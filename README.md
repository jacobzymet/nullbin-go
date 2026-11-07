# Nullbin

Share text and files with a private link. Nullbin encrypts everything in
your browser before uploading it, so the server only ever stores data it
cannot read. The key is the part of the link after `#`, which browsers never
send to the server.

Passwords, file attachments, encrypted comments, expiry, and burn after
reading are all built in. There are no accounts and no database.

## Start here

| I want to… | Go to |
|---|---|
| Learn how to use Nullbin | [Using Nullbin](#using-nullbin) |
| Try it on my own computer | [Try it locally](#try-it-locally) |
| Host it for others | [Choose a setup](#choose-a-setup), then [Option A](#option-a-one-server-recommended) or [Option B](#option-b-separate-hosting) |
| Update, check or manage my server | [Run your server](#run-your-server) |
| Fix a problem | [Troubleshooting](#troubleshooting) |
| Understand what is protected | [How your data is protected](#how-your-data-is-protected) |
| Look up limits, settings, the API or the encryption | [Reference](#reference) |
| Report a security problem | [SECURITY.md](SECURITY.md): email hi@jacobzymet.com, never a public issue |

## Using Nullbin

Nullbin works in current Chrome, Edge, Firefox and Safari (browsers from
mid-2022 on; Safari 16.4 or later). Older browsers cannot open it.

1. Enter text, attach a file, or both.
2. Choose how long the paste lasts, and any options: a password, a
   discussion, or burn after reading.
3. Select **Create** and share the **whole link, including everything after
   `#`**. It is copied for you when the browser allows; otherwise use
   **Copy link**.
4. If you set a password, send it separately from the link. Keep the
   **delete link** to yourself: anyone with it can delete the paste.

| Option | What it does |
|---|---|
| **Password** | Readers need the password as well as the link. At least 8 characters. |
| **Discussion** | Readers with the link and password can post encrypted comments. Needs a password; cannot be combined with burn after reading. |
| **Burn after reading** | The paste is deleted after a set number of opens (1 to 1,000; 1 by default). Every authorized open counts, including reloads and interrupted downloads; wrong passwords and link previews do not. |

After opening a paste:

| Button | What it does |
|---|---|
| **New** | Starts a blank paste. |
| **Clone** | Copies the text and attachment into a new draft, where you choose new settings. Comments and the password are not copied. |
| **Raw text** | Opens the full text in a new tab as plain text. |
| **Save document** | Downloads the full text as `paste.txt`. Attachments have their own **Save file** button. |
| **Email** | Opens your email app with the link. The text and password are not included and nothing is sent automatically. |
| **QR code** | Shows a QR code of the link, made in your browser. |

Email and QR code contain the secret link, so send any password another
way. If a paste contains invisible or direction-changing characters (a trick
that makes text look different from what it does when copied), Nullbin shows
a warning above it.

Large attachments: desktop Chrome and Edge save files of any size directly
to disk. Other browsers can save attachments up to 64 MiB. Clone works for
attachments up to 64 MiB, or for larger ones after you save them.

## Try it locally

**You need** [Docker Desktop](https://docs.docker.com/get-started/get-docker/),
installed and running (on Windows, using **Linux containers**). You do not
need Node.js or Go. These commands work in Windows PowerShell, Linux and
macOS.

1. Download Nullbin:

   ```sh
   git clone https://github.com/jacobzymet/nullbin-go.git nullbin
   cd nullbin
   ```

   This is the development version, which is fine for trying it out. For
   the latest release, also run `git checkout v1.2.3` with the version from
   the [Releases page](https://github.com/jacobzymet/nullbin-go/releases).

2. Build it. The first build takes a few minutes:

   ```sh
   docker build --build-arg VERSION=$(git describe --tags --always) -t nullbin-dev .
   ```

   The `VERSION` part puts the version at the bottom of every page. If you
   downloaded a ZIP instead of using Git, leave it out:
   `docker build -t nullbin-dev .`

3. Start it:

   ```sh
   docker run --rm -p 127.0.0.1:8080:8080 -v nullbin-dev-data:/data nullbin-dev
   ```

4. Open [http://localhost:8080](http://localhost:8080) and create a paste.
   Press **Ctrl+C** in the terminal to stop it. Run the same `docker run`
   command to start it again; your pastes are kept.

This local copy is only reachable from your own computer. To host Nullbin
for others, with HTTPS, follow one of the setups below.

## Choose a setup

Nullbin has two parts: the **website** (the frontend, which encrypts and
decrypts in the browser) and the **API** (which stores encrypted pastes).

| Setup | Where the parts run | Choose it if |
|---|---|---|
| [**Option A: One server**](#option-a-one-server-recommended) (recommended) | Both on one server, in separate containers | You want the simplest setup. |
| [**Option B: Separate hosting**](#option-b-separate-hosting) | Website on a static host such as Cloudflare Pages; API on your server | You want the website to stay safe even if the API server is broken into. |

Both support every feature. Option A is easier. Option B is safer if the
server is ever compromised: the code that handles keys is not on it.

**What you need for either:**

- A server running **Ubuntu 24.04** with at least **1 GB of RAM** and SSH
  access.
- A **domain name** (such as `paste.example.com`) whose DNS points at that
  server.
- TCP ports **80 and 443** open in the server's firewall and in your
  hosting provider's firewall.
- Optional: **Cloudflare's proxy** in front of the server. See
  [Behind Cloudflare](#behind-cloudflare).

**Servers always run a published release**, never the development branch:
the install steps download the latest release, and Docker builds it on your
server from source. Nothing prebuilt is downloaded.

**Prefer no manual steps?** [cloud-init](#new-server-with-cloud-init) sets
up Option A automatically when you create the server.

## Option A: One server (recommended)

Replace `paste.example.com` with your domain throughout.

**1. Install Docker and download the latest release.** Connect to your
server with SSH and run:

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2 git curl
VERSION=$(curl -fsSL https://api.github.com/repos/jacobzymet/nullbin-go/releases/latest | grep -o '"tag_name": *"[^"]*"' | head -n 1 | cut -d '"' -f 4)
echo "Installing $VERSION"
git clone --branch "$VERSION" https://github.com/jacobzymet/nullbin-go.git nullbin
cd nullbin/deploy
```

It should print a version such as `Installing v1.2.3`. If it prints only
`Installing`, stop: see [troubleshooting](#troubleshooting). A message about
a "detached HEAD" is normal.

**2. Set your domain.** Give the domain name only, without `https://`:

```bash
sudo ./nullbin setup paste.example.com
```

If Cloudflare's proxy (orange cloud) will be in front of the server, add
`--cloudflare` to that command and read
[Behind Cloudflare](#behind-cloudflare) first.

**3. Start Nullbin.** The first start takes a few minutes:

```bash
sudo ./nullbin start
```

**4. Check it.** Open `https://paste.example.com` and create a test paste.
The bottom of the page shows the version you installed. HTTPS certificates
are created and renewed automatically, and Nullbin starts again by itself
after the server reboots.

Done. To update and manage it, see [Run your server](#run-your-server).

## Option B: Separate hosting

You will use two addresses. Replace both with your own throughout:

| Address | What it is | Points at |
|---|---|---|
| `https://paste.example.com` | The website people open | Your static host |
| `https://api.example.com` | The API that stores encrypted pastes | Your server |

**1. Set up the API on your server.** Point `api.example.com` at the server,
connect with SSH and run:

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2 git curl
VERSION=$(curl -fsSL https://api.github.com/repos/jacobzymet/nullbin-go/releases/latest | grep -o '"tag_name": *"[^"]*"' | head -n 1 | cut -d '"' -f 4)
echo "Installing $VERSION"
git clone --branch "$VERSION" https://github.com/jacobzymet/nullbin-go.git nullbin
cd nullbin/deploy
```

**Write down the version it prints** (such as `v1.2.3`); you will build the
website from the same one. If it prints only `Installing`, stop: see
[troubleshooting](#troubleshooting).

Configure the API with its domain name, then the website's exact address
(`https://` and no trailing slash), and start it:

```bash
sudo ./nullbin setup-api api.example.com https://paste.example.com
sudo ./nullbin start
```

Check: `https://api.example.com/api/v1/version` should show `"mode":"api"`
and your version. The API's home page showing "Not found" is expected.

**2. Build the website on your own computer.** Use the version you wrote
down:

```sh
git clone --branch v1.2.3 https://github.com/jacobzymet/nullbin-go.git nullbin
cd nullbin
```

Then build it with your API's address, using **one** of these:

- **With Docker** (works in PowerShell, Linux and macOS). The output folder
  is `out/frontend`:

  ```sh
  docker build --target frontend-files --build-arg API_ORIGIN=https://api.example.com --build-arg VERSION=$(git describe --tags) --output type=local,dest=out/frontend .
  ```

- **With Node.js 26 or later.** The output folder is `web/dist`:

  ```sh
  npm ci --ignore-scripts
  ```

  Then on Linux or macOS:

  ```bash
  NULLBIN_API_ORIGIN=https://api.example.com npm run build:frontend
  ```

  Or in Windows PowerShell:

  ```powershell
  $env:NULLBIN_API_ORIGIN = "https://api.example.com"
  npm run build:frontend
  ```

**3. Upload the website.** Use a static host that supports `_headers` and
`_redirects` files, such as Cloudflare Pages. These apply the security
headers and make paste links work. For Cloudflare Pages:

1. Create a Pages project using **Direct Upload**.
2. Upload the **whole** output folder (`out/frontend` or `web/dist`),
   including `_headers` and `_redirects`.
3. Under **Custom domains**, add `paste.example.com` and follow the DNS
   instructions.

**4. Check it.** Open `https://paste.example.com`, create a paste and open
its link.

The website's address must **exactly** match the one you gave `setup-api`.
Preview addresses from your host are not allowed. To use your host's own
address instead (such as `https://your-project.pages.dev`), give that to
`setup-api`.

Done. To update and manage it, see [Run your server](#run-your-server).

## Run your server

Everything here runs **on the server, in the `nullbin/deploy` folder**
(`/opt/nullbin/deploy` on a cloud-init server), and works the same for
Option A and Option B.

### Everyday commands

| Task | Command |
|---|---|
| Update to the latest release | `sudo ./nullbin update` |
| Show the running version and container status | `sudo ./nullbin status` |
| Read recent logs | `sudo ./nullbin logs` |
| Stop | `sudo ./nullbin stop` |
| Start | `sudo ./nullbin start` |
| Remove a reported paste | `sudo ./nullbin delete <paste id>` |
| Turn Cloudflare mode on or off | `sudo ./nullbin cloudflare on` (or `off`) |
| Show Cloudflare mode, the certificate and the SSL setting to use | `sudo ./nullbin cloudflare` |
| Free disk space used by old builds | `sudo ./nullbin cleanup` |
| List every command | `./nullbin help` |

None of these delete pastes, except `delete` for the one paste you name.

### Update

**To hear about new releases**, open the
[repository](https://github.com/jacobzymet/nullbin-go) on GitHub and choose
**Watch → Custom → Releases**. Install security fixes promptly.

1. Read the release's notes on the
   [Releases page](https://github.com/jacobzymet/nullbin-go/releases). They
   say if an update needs anything extra.
2. Connect to the server with SSH and run:

   ```bash
   cd ~/nullbin/deploy
   sudo ./nullbin update
   ```

   It shows the installed and the new version, switches to the new release,
   rebuilds, and waits until Nullbin is running. Your settings and pastes
   are kept; the site is down for a few seconds. If the new version does
   not start, it goes back to the one you had and says so.
3. Open your site and create a test paste.

**Option B:** after updating the server, build the website from the same
version and upload it again (steps 2 and 3 of
[Option B](#option-b-separate-hosting)). In your existing copy on your
computer, switch versions with `git fetch --tags` and `git checkout v1.2.3`.
Always update the server first.

`update` installs only versions published on the Releases page from the
main branch, and refuses if files in `~/nullbin` were changed or added
(other than your settings), because they would be built in.

**To go back to an earlier release**, give its version:
`sudo ./nullbin update v1.2.2`. Check that release's notes first; a release
that changes how pastes are stored will say whether going back is safe.

### Remove a reported paste

A report usually includes a link such as
`https://paste.example.com/p/0123456789abcdef0123456789abcdef#…`. You need
only the 32 characters after `/p/` (or `/d/`), not the part after `#`:

```bash
sudo ./nullbin delete 0123456789abcdef0123456789abcdef
```

It prints `Deleted.`, and the paste and its comments are gone. The API is
offline for a few seconds while it runs.

### Change settings

The settings are in `deploy/.env` (Option A) or `deploy/.env.api`
(Option B). Edit the file, for example with `nano .env`, then apply the
change with `sudo ./nullbin start`.

| Setting | Default | What it controls |
|---|---|---|
| `MAX_SIZE` | `100MiB` | Largest paste, including its attachment. Up to `2GiB`. |
| `MAX_STORAGE` | `10GiB` | Total space Nullbin may use. Keep it well below the disk's free space. |
| `MAX_PENDING` | `1024` | How many uploads can be in progress at once. |
| `MAX_PASTES` | `100000` | Most pastes kept at once. Each uses about four inodes; check with `df -i` before raising it. |
| `DOMAIN` (A) or `API_DOMAIN` (B) | set by `setup` | The server's domain name. |
| `FRONTEND_ORIGIN` (B only) | set by `setup-api` | The website's exact address. |
| `CLOUDFLARE` | not set (off) | `true` when Cloudflare's proxy is in front. Change it with `sudo ./nullbin cloudflare on` or `off`, not by hand. See [Behind Cloudflare](#behind-cloudflare). |

Write each setting on its own line as `NAME=value`, with no quotes or
spaces. `./nullbin` refuses to start with anything else (other forms that
Docker Compose would accept, unknown names, a name set twice, or Windows line
endings), because the domain names end up in the HTTPS proxy's
configuration.

If you change the **API's address** in Option B, also rebuild and upload
the website with the new address. If you change the **website's address**,
existing share links keep pointing at the old one.

### Behind Cloudflare

Use Cloudflare mode when Cloudflare's proxy (the orange cloud) is in front
of your server, in Option A or Option B.

**1. Turn it on**, on the server:

```bash
sudo ./nullbin cloudflare on
```

(Or add `--cloudflare` to `setup` or `setup-api` when you first set up.)
`sudo ./nullbin cloudflare off` turns it off again.

**2. In Cloudflare's dashboard:**

- **DNS:** the record for your domain points at the server and is
  **Proxied** (orange cloud).
- **SSL/TLS → Overview:** run `sudo ./nullbin cloudflare`. It says which
  mode to use:
  - **Full (strict)** once the server has a Let's Encrypt certificate. This
    is the one to aim for: Cloudflare then checks that it is really talking
    to your server.
  - **Full** while the server uses its own certificate (see below). It is
    encrypted, but Cloudflare does not check who answers.
  - Never **Flexible**: it would send everything unencrypted between
    Cloudflare and your server.
- **Turn off features that rewrite pages:** Rocket Loader, Email Address
  Obfuscation and automatic Web Analytics injection. Nullbin's security
  checks block such changes, so they would break the page.

**What Cloudflare mode does:**

- **Only Cloudflare can reach the site.** Any other connection gets
  `403 This site is served only through Cloudflare.`. This is enforced by
  Nullbin's own proxy, so it holds even though Docker's published ports skip
  host firewalls such as ufw. Keep **port 80 open to Cloudflare**: Let's
  Encrypt checks your domain through it.
- **Each visitor keeps their own rate limits.** Behind Cloudflare, every
  connection comes from Cloudflare's addresses. Nullbin uses the visitor's
  address that Cloudflare reports in `CF-Connecting-IP`, and believes that
  header only on connections from Cloudflare's published addresses
  ([list](https://www.cloudflare.com/ips/)). Nobody else can fake it.
- **Certificates:** the server asks Let's Encrypt for a certificate first.
  If that fails, it uses a certificate from its own local authority right
  away, so the site works with Cloudflare's **Full** mode. It tries Let's
  Encrypt again about every 40 minutes and switches over once it succeeds.
  Visitors only ever see Cloudflare's certificate.

**What Cloudflare can see:** Cloudflare decrypts the traffic between
visitors and your server. It sees visitors' addresses, paste IDs, access
tokens and encrypted pastes, but never paste contents, passwords or keys:
those stay in the browser, and the key is never sent over the network. In
Option A, Cloudflare also delivers the website's code, so you trust it as
much as your own server not to change that code. In Option B, with only the
API behind Cloudflare, it never delivers code.

Cloudflare's address list is built into Nullbin and checked against
Cloudflare's published one on every change. If Cloudflare adds addresses,
a Nullbin update brings them; until then, visitors routed through the new
addresses are refused rather than trusted.

### Before you go public

1. **Keep it updated.** Watch for releases (see [Update](#update)).
   cloud-init servers install Ubuntu updates automatically; on other
   servers, turn on `unattended-upgrades`.
2. **Protect the accounts that control it.** Use SSH keys, not passwords,
   for the server. Keep the `nullbin` folder owned and writable by you
   alone: whoever can change it controls what runs as root, as with any
   Docker setup. Turn on two-factor authentication for the GitHub account
   that publishes releases. For Option B, protect the static host account
   too: it controls the code that handles keys.
3. **Publish a way to report abuse**, such as an email address on your
   domain. You cannot see what pastes contain, so reports are how you hear
   about illegal content. The **Report a vulnerability** link at the bottom
   of every page goes to the Nullbin maintainer and is only for security
   flaws in the software, not for reporting pastes.
4. **Check the live site from outside** with the
   [SSL Labs server test](https://www.ssllabs.com/ssltest/) and
   [Mozilla HTTP Observatory](https://developer.mozilla.org/en-US/observatory).
   Both should give top grades; look into any warning.

### What the server knows

The server stores only encrypted pastes and what it needs to serve them:
size, creation and expiry times, burn and discussion settings, and hashes of
access tokens. It does not log IP addresses, paste IDs or tokens, and keeps
nothing linking a paste to who uploaded it. So you cannot read a reported
paste, and you have no uploader details to hand over. Expired and deleted
pastes are removed from disk within a minute, but backups and disk
snapshots may keep copies.

### Data and backups

- Pastes are in the `nullbin_nullbin-data` Docker volume; HTTPS certificates
  are in `proxy-data` and `proxy-config`. Updates and `stop` keep them.
- The only thing that deletes all pastes is `docker compose down -v`, which
  removes the volumes. `nullbin` never does this.
- Run **one** API on **local disk**. Several API processes, or network file
  systems, are not supported.
- To switch between Option A and B on the same server, run
  `sudo ./nullbin stop`, delete the old settings file (`.env` or
  `.env.api`), run `setup` or `setup-api`, then `start`. Pastes are kept. Keep
  the same website address if existing links should keep working.

## Troubleshooting

| Problem | What to do |
|---|---|
| The install prints only `Installing`, or `nullbin update` cannot find the latest release | The server could not reach GitHub, or no release exists yet. Check the [Releases page](https://github.com/jacobzymet/nullbin-go/releases) and try again. Do not continue without a version. |
| The site does not open, or HTTPS is not ready | Check that DNS points at the right server and ports 80 and 443 are open in both firewalls. Then check `sudo ./nullbin status` and `sudo ./nullbin logs`. |
| The site says "This site is served only through Cloudflare." | Cloudflare mode is on, but visitors reach the server directly. Set the DNS record to **Proxied** in Cloudflare, or turn the mode off with `sudo ./nullbin cloudflare off`. |
| Cloudflare shows error 526 (invalid SSL certificate) | The server is using its own certificate while Cloudflare is set to **Full (strict)**. Run `sudo ./nullbin cloudflare` and set the mode it shows. |
| Cloudflare shows error 521 or 522 | Cloudflare cannot connect to the server. Check that ports 80 and 443 are open to Cloudflare in your hosting provider's firewall, and `sudo ./nullbin status`. |
| Option B: the API's home page shows "Not found" | That is expected. Check `https://api.example.com/api/v1/version` instead. |
| Option B: the website opens, but creating or opening pastes fails | The website's address must exactly match the one given to `setup-api`, and the website must be built with the API's address. Fix whichever is wrong, then rebuild or restart. |
| A share link opens the host's "page not found" | Upload the whole output folder, including `_redirects`. |
| `nullbin` says to run it with sudo | Run `sudo ./nullbin …` from the `deploy` folder. |
| `nullbin update` says files that came with Nullbin were edited | A file such as a Caddyfile was changed by hand, and updating would overwrite it. `git -C ~/nullbin stash` sets the changes aside so the update can continue. Your settings file is never affected. |
| `nullbin setup` says it is already configured | Edit the existing settings file instead (see [Change settings](#change-settings)), or delete it to start over. |
| The server is running out of disk space | Run `sudo ./nullbin cleanup`. It never deletes pastes. |

## How your data is protected

**In the browser.** Encryption, decryption, passwords and comments are all
handled in the browser. The server only ever receives encrypted data and
the access tokens it needs; it enforces expiry, burn after reading and
limits.

**The whole link is a secret.** Anyone with the full link can read the
paste, and also needs the password if one is set. Send the two separately.
Links can linger in browser history, chat logs and clipboard history.

**What you still have to trust:**

- **Whoever controls the website's code** (the server in Option A, or the
  static host in Option B) could change it to steal keys. Protect those
  accounts and keep the code updated.
- **The API** could delete or withhold pastes, keep encrypted copies, and
  see metadata such as sizes and times. It cannot read them.
- **Your own device:** malware or a malicious browser extension can read
  anything you see.

**Downloads and burning.** An interrupted burn download still uses an open.
Once the last open is used, the paste is gone for good.

For the full analysis, see the [threat model](THREAT_MODEL.md).

## Reference

<details>
<summary><strong>Technical specifications</strong>: architecture, encryption, keys and content limits</summary>

### Architecture

| Component | Specification |
|---|---|
| Frontend | TypeScript with native browser APIs; Bootstrap 5.3.8 CSS, without Bootstrap JavaScript or a framework. Builds to static HTML, JavaScript and CSS. |
| Cryptography | `libsodium-wrappers-sumo` 0.8.4 with bundled WebAssembly, running in the browser. No CDN or outside service. |
| Backend | Go 1.25 or later, standard library only: no third-party Go modules, database or accounts. |
| Storage | Ciphertext and JSON metadata on local disk. One API process per data directory. Files use mode `0600`, directories `0700`. |
| Deployment | The API and the Caddy HTTPS proxy run from distroless images (no shell, tools or package manager) as non-root users, with read-only root filesystems, no added capabilities and process limits; only their data volumes are writable. The API has no internet access. Caddy serves HTTP/1.1 and HTTP/2, without HTTP/3. Linux is the supported production platform. |
| Browser | JavaScript and WebAssembly; HTTPS in production. Clipboard access and streaming file saves are optional. |
| HTTP security | Strict Content Security Policy with Trusted Types (the browser refuses HTML-injection APIs), Subresource Integrity, `no-referrer`, `nosniff`, COOP and CORP `same-origin`, and COEP `require-corp` (isolating the page from side-channel memory reads). The API's CORS allows only the configured website, without cookies or credentials. |
| Distribution | Pinned dependencies, reproducible builds, and a checksum list with each release. Nothing prebuilt is published. See **Verify a build** below and the [third-party notices](THIRD_PARTY_NOTICES). |

### Encryption and keys

Pastes use **XChaCha20-Poly1305 with 256-bit keys**, through libsodium's
[`crypto_secretstream_xchacha20poly1305`](https://doc.libsodium.org/secret-key_cryptography/secretstream).
It encrypts files in small chunks and detects altered, missing, duplicated,
reordered or truncated data, without holding whole files in memory.

| Property | Specification |
|---|---|
| Link secret | 32 fresh random bytes per paste, written as 43 base64url characters after `#`. |
| Encryption key | A 32-byte stream key derived from the master key: the link secret alone, or the link secret combined with the password. |
| Password | Argon2id v1.3 with a fresh 16-byte salt, `opslimit = 3`, `memlimit = 256 MiB` and a 32-byte result, after Unicode NFC normalization. Keyed BLAKE2b-256 combines it with the link secret. Neither the password nor the master key is sent to the API. |
| Separate keys | Paste encryption, comment encryption, discussion access and burn access use distinct `crypto_kdf_derive_from_key` contexts. Access tokens sent to the server cannot decrypt anything. |
| Comments | XChaCha20-Poly1305 with a fresh 24-byte random nonce, under the separate comment key, bound to the paste ID. Names, text, times and replies are encrypted. Names are not verified. |
| IDs and tokens | Paste IDs are 128 random bits (32 hexadecimal characters); upload and delete tokens are 256 random bits. The server stores SHA-256 hashes of tokens and compares them in constant time. |

The part of the link before `#` finds the paste; browsers never send the
part after it. Nullbin reads the key, then removes it from the address bar.
The website's code must still be trusted: malicious code could read the key
or the text.

### Content limits

Binary units are powers of 1,024. Text limits count JavaScript UTF-16 units.

| Item | Limit |
|---|---|
| Paste size | 100 MiB by default; configurable from 64 KiB to 2 GiB, including encryption overhead. |
| Text and metadata | The encrypted metadata, including the text, filename and type, must fit in 16 MiB. |
| Attachments | One file per paste, with optional text. Filename and type up to 255 characters each. |
| Text preview | Up to 5,000 lines or 100,000 characters. Copy, Raw text, Save document and Clone use the full text. |
| Saving and cloning files | Up to 64 MiB in memory. Larger files need streaming saves (desktop Chrome or Edge). Files are never previewed or opened. |
| Discussions | Up to 200 comments per paste; 4,000 characters of text and a 40-character name each. |
| Expiry | 5 minutes, 1 hour, 1 day, 7 days or 30 days. Never unlimited. Expired pastes are never served and are removed within a minute. |
| Burn after reading | 1 to 1,000 authorized opens (default 1), counted before delivery and kept across restarts. |

<details>
<summary>Key derivation and version 1 data formats</summary>

Without a password, `master = link_secret`. With a password:

```text
stretched = Argon2id-v1.3(NFC(password), salt,
                        output=32 bytes, opslimit=3, memlimit=256 MiB)
master    = BLAKE2b-256(key=link_secret, message=stretched)
```

Each subkey is `crypto_kdf_derive_from_key(32, 1, context, master)`:

| Context | Purpose |
|---|---|
| `nbstream` | Paste and file encryption key |
| `nbcmtenc` | Comment encryption key |
| `nbcmtacc` | Discussion access token |
| `nbburnac` | Burn-read access token |

The salt is public: random with a password, all zeros without. Access tokens
are base64url encoded; the server stores only their hashes.

**Encrypted paste, version 1:**

| Offset | Size | Field |
|---|---|---|
| 0 | 4 bytes | Magic `NBN1` |
| 4 | 1 byte | Version `1` |
| 5 | 1 byte | Flags: bit 0 means password protected; other bits must be zero |
| 6 | 16 bytes | Password salt |
| 22 | 24 bytes | libsodium secretstream header |
| 46 | rest | Encrypted frames |

Each frame is a 4-byte big-endian ciphertext length, then the ciphertext
(17 bytes of overhead). The first frame holds UTF-8 JSON with exactly
`type`, `text`, `filename`, `mime`, `size` and `discussion`, and authenticates
bytes 0 to 21. A text-only paste ends there with `TAG_FINAL`; otherwise file
frames of 64 KiB follow, the last carrying `TAG_FINAL` (even for an empty
file). Trailing bytes, bad lengths and incomplete streams are rejected. The
total size is 46 bytes, plus 21 and the JSON size, plus the file size and 21
bytes per file frame.

**Encrypted comment, version 1:** a version byte (`1`), a 24-byte nonce,
then XChaCha20-Poly1305 ciphertext with a 16-byte tag, of UTF-8 JSON with
`id`, `parent`, `name`, `text` and `time` (milliseconds). The additional
authenticated data is `nullbin comment v1 <paste id>`.

Code: [paste crypto](web/src/crypto.ts), [format](web/src/format.ts),
[comments](web/src/comments.ts), [links](web/src/link.ts).

</details>

</details>

<details>
<summary><strong>Server configuration</strong>: environment variables, rate limits and transfer limits</summary>

The settings files set these environment variables for the API. Bad values,
and unknown `NULLBIN_*` variables (usually typos), stop the server at
startup.

| Variable | Default | Meaning |
|---|---|---|
| `NULLBIN_API_ONLY` | `false` (`true` in the API image) | Serve only the API, no website. |
| `NULLBIN_FRONTEND_ORIGIN` | empty | The exact HTTPS website address allowed to call the API. |
| `NULLBIN_LISTEN_ADDR` | `127.0.0.1:8080` (`:8080` in the image) | Address and port to listen on. |
| `NULLBIN_DATA_DIR` | `data` (`/data` in the image) | Data directory, created with mode `0700`. |
| `NULLBIN_MAX_STORAGE` | `10GiB` | Total storage budget, from `64KiB` up to `1048576GiB` (1 PiB), including unfinished uploads, metadata and comments. Units: `KiB`, `MiB`, `GiB`. |
| `NULLBIN_MAX_PENDING` | `1024` | Unfinished uploads at once (1 to 4096). |
| `NULLBIN_MAX_PASTES` | `100000` | Pastes at once, including unfinished ones (1 to 10,000,000). Keeps a volume from running out of inodes before bytes. |
| `NULLBIN_MAX_SIZE` | `100MiB` | Largest paste, `64KiB` to `2GiB`. |
| `NULLBIN_BEHIND_HTTPS` | `false` | `true` sends `Strict-Transport-Security: max-age=31536000`. |
| `NULLBIN_TRUSTED_PROXIES` | empty | IPs or CIDR ranges whose `X-Forwarded-For` header is trusted. |

The `nullbin` program also has `nullbin healthcheck` (used by the container
health check) and `nullbin delete <paste id>` (used by `./nullbin delete`;
the server must be stopped).

**Request rates per client** (IPv4 address or IPv6 `/64`):

| Requests | Sustained | Burst |
|---|---|---|
| Create a paste | 20 per minute | 20 |
| Upload chunks and finalize | 10 per second | 50 |
| Post comments | 20 per minute | 10 |
| Delete a paste | 60 per minute | 20 |
| Downloads, burn reads and comment reads (shared) | 20 per minute | 20 |
| Pages, assets and the version link | 5 per second | 100 |

One IPv6 `/48` as a whole gets four times a client's rates and bursts.
Each limiter tracks up to 100,000 clients and refuses new ones when full.
Forwarded addresses are trusted only from `NULLBIN_TRUSTED_PROXIES`.

**Transfer and timeout limits:**

| Limit | Value |
|---|---|
| Unfinished upload lifetime | 2 minutes without a completed chunk; 1 hour at most |
| Unfinished uploads | `MAX_PENDING` in total; 8 per client and 32 per IPv6 `/48` |
| Upload chunk size | 4 MiB to 8 MiB, except the last chunk |
| Concurrent chunk uploads | 512 in total; 4 per client and 16 per IPv6 `/48` |
| Minimum upload rate | 16 KiB/s on average after 5 seconds |
| Concurrent downloads | 512 in total; 16 per client and 32 per IPv6 `/48` |
| Minimum download rate | 32 KiB/s on average after 2 minutes (for password and save dialogs). Time the server spends on its own bandwidth limits does not count. Every download also ends 1 minute plus 1 second per 32 KiB of paste after it starts. |
| Download bandwidth | 4 MiB/s per client, 16 MiB/s in total |
| Request size | 1 KiB to create a paste; 16 KiB of headers |
| Disk writes at once | 64 creates, finalizes, deletes and comments; others wait up to 10 s |
| Timeouts | 10 s for headers, 60 s idle, 30 s for other requests, 5 minutes per upload chunk |

An upload is charged 32 KiB when it starts and its bytes as they arrive,
so uploads that send nothing cannot fill the budget. It starts only if the
whole paste fits at that moment, but other uploads can take the space
before it finishes. Each comment is charged when it is posted, so an
unused discussion costs nothing. A full budget returns `507`; too
many uploads or transfers return `503` with `Retry-After`. This is
Nullbin's own budget, not a disk quota: leave free disk space, or use a
dedicated volume.

</details>

<details>
<summary><strong>API reference</strong>: endpoints, tokens, responses and link formats</summary>

All endpoints are under `/api/v1`. Errors are JSON: `{"error": "..."}`.
Every response carries the security headers. Unknown, expired and burned
pastes, and wrong tokens, all return the same `404`.

**`POST /api/v1/pastes`** starts an upload (`Content-Type: application/json`;
rate limited):

```json
{"expires_in": 86400, "burn_after_reading": false, "total_size": 12345}
```

- `expires_in`: seconds; one of `300`, `3600`, `86400`, `604800`, `2592000`.
- `total_size`: the exact ciphertext size, from 67 bytes to the maximum.
- `max_reads` (optional, burn only): 1 to 1000, default 1.
- `comment_token` (optional, not with burn): 43 base64url characters;
  enables a discussion.
- `burn_token` (required for burn, otherwise not allowed): 43 base64url
  characters, derived in the browser with the `nbburnac` context.

Returns `201` with `{"id": "...", "upload_token": "...", "delete_token": "..."}`;
or `400` invalid, `413` too large (with `max_size`), `415` wrong type, `429`
rate limited, `503` too many uploads in progress, `507` storage full.

**`PUT /api/v1/pastes/{id}/chunks/{n}`** uploads chunk `n` (0, 1, 2, … in
order; `application/octet-stream`) with `Nullbin-Upload-Token`. Each chunk is
4 MiB to 8 MiB, except the last. A failed chunk may be sent again with the
same `n`. An upload expires after 2 minutes without a completed chunk, and
after 1 hour at most. Returns `204`; or `400` bad index, empty or too-small
chunk, `404`, `409` out of order (with `next_chunk`) or busy, `413` too
large, `415` wrong type.

**`POST /api/v1/pastes/{id}/finalize`** (with `Nullbin-Upload-Token`)
publishes the paste once all bytes have arrived. Returns `200` with
`{"expires_at": "..."}`; or `400` incomplete, `404`.

**`GET /api/v1/pastes/{id}`** streams a normal paste's ciphertext. Burn
pastes return `404`. `HEAD` returns `405`.

**`GET /api/v1/pastes/{id}/prefix`** returns a burn paste's first 22 bytes
(format, flags and password salt), without using an open.

**`POST /api/v1/pastes/{id}/read`** (with `Nullbin-Burn-Token`) streams a
burn paste, using one open before any data is sent. A wrong or missing
token returns `404` and uses nothing. The response includes
`Nullbin-Reads-Remaining`.

**`DELETE /api/v1/pastes/{id}`** (with `Nullbin-Delete-Token`) deletes the
paste and its comments. Returns `204`; or `404`, `409` busy.

**`POST /api/v1/pastes/{id}/comments`** (with `Nullbin-Comment-Token`) adds
one encrypted comment of 41 bytes to 32 KiB. Returns `201` with
`{"count": n}`; or `400`, `404`, `409` full or busy, `413`, `415`.

**`GET /api/v1/pastes/{id}/comments`** (with `Nullbin-Comment-Token`)
returns `{"comments": ["<base64>", ...]}` in arrival order, streamed;
clients must require a complete JSON document.

**`GET /api/v1/version`** returns `{"version":"v1.2.3","mode":"api"}` from the
API. The local all-in-one server also returns its website files' hashes. A
separately hosted website lists its version and hashes at `/version.json`.

**Links** always use the website's address: `https://host/p/<id>#<key>`
(with `.b` after the key for burn after reading), and
`https://host/d/<id>#d.<delete token>`.

**Separate website (Option B):** the API's `NULLBIN_FRONTEND_ORIGIN` and the
website's build-time `NULLBIN_API_ORIGIN` name each other. CORS allows only
that exact website, never with cookies or credentials, and tokens are still
required for every change.

</details>

<details>
<summary><strong>Verify a build</strong>: check that a release or a live site matches the source</summary>

Each release is its tagged source plus a `SHA256SUMS` file. The release
workflow builds the tag twice from scratch, checks both builds match, and
records their checksums, so building it yourself gives the same files.

**A release.** In a checkout of the release (replace `v1.2.3`):

```bash
docker build --target artifacts --build-arg VERSION=v1.2.3 --output type=local,dest=out .
sha256sum out/nullbin out/dist/app.js out/dist/app.css out/dist/index.html
```

Compare with the release's `SHA256SUMS`. `nullbin` matches
`nullbin-linux-amd64` or `nullbin-linux-arm64`, depending on your machine.
The three website files are those of the local all-in-one server.

**A separately hosted website.** Its `/version.json` lists its version, API
address, asset paths and file hashes. Build the same version with the same
API address, then compare the downloaded page, script and style with your
build. The page's Subresource Integrity hashes tie the scripts to the page.

A check proves only what was served to you at that moment; a compromised
host could serve different code later or to someone else.

</details>

<details>
<summary><strong>Other ways to deploy</strong>: cloud-init, automatic website builds and custom static hosts</summary>

### New server with cloud-init

[deploy/cloud-init.yaml](deploy/cloud-init.yaml) sets up Option A on a new
Ubuntu 24.04 server. Put your domain in its settings block, point the domain
at the server, and paste the file into your provider's "user data" or
"cloud-init" field when creating the server. It installs Docker, sets up the
firewall and automatic Ubuntu updates, turns off SSH passwords, downloads
the latest release and starts Nullbin. It is installed in `/opt/nullbin`;
manage it with the [usual commands](#run-your-server) from
`/opt/nullbin/deploy`.

The Compose setup is tested in CI; the full cloud-init boot has not been
tested on a real cloud server.

### Automatic website builds

A static host can build the website from Git. Use these settings with a
host that supports `_headers` and `_redirects`:

| Setting | Value |
|---|---|
| Root directory | Repository root |
| Node version | 26 or later |
| Build command | `npm ci --ignore-scripts && npm run build:frontend` |
| Output directory | `web/dist` |
| Environment variable | `NULLBIN_API_ORIGIN=https://api.example.com` |

Automatic builds follow a branch, so do not point them at `main`. Use a
branch in your own fork that you only move to release tags. Turn off any
feature that injects analytics or rewrites the HTML or JavaScript: it would
break the security policy. Cloudflare's guides:
[Git integration](https://developers.cloudflare.com/pages/get-started/git-integration/),
[Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/),
[custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/).

### Your own static host

Serve the output folder from the site root, over HTTPS, and:

- serve `index.html` for `/p/<id>` and `/d/<id>`, without changing the URL;
- send the headers in `_headers`, including the Content-Security-Policy;
- cache files under `/assets/` (their names contain their hash), but always
  serve a fresh `index.html`;
- add no scripts and change no files.

`web/generated/headers.caddy` has the same headers for Caddy, and
`deploy/Caddyfile` shows the routing.

</details>

<details>
<summary><strong>Development</strong>: build from source and run the tests</summary>

Use Go 1.25 or later and Node.js 26 or later. CI and release tool versions
are pinned in the workflows and the Dockerfile.

**API only** (no Node.js needed):

```bash
go build -tags=api -trimpath -o nullbin ./cmd/nullbin
NULLBIN_API_ONLY=true ./nullbin
```

On Windows PowerShell, build with `-o nullbin.exe`, set
`$env:NULLBIN_API_ONLY = "true"`, and run `./nullbin.exe`.

**All-in-one local server** (website and API in one process, without the
separate website boundary used in production):

```bash
npm ci --ignore-scripts
npm run build
go build -trimpath -o nullbin ./cmd/nullbin
./nullbin
```

Then open `http://127.0.0.1:8080`.

**Website only:** `NULLBIN_API_ORIGIN=https://api.example.com npm run build:frontend`
builds `web/dist`. The API address is fixed at build time; links and API
responses cannot change it.

**Tests:**

```bash
npm run typecheck
npm test
npm run build
go vet ./...
go test -race ./...
go test -tags=api -race ./...
go test -run='^$' -fuzz=FuzzHandler -fuzztime=15s ./internal/server
npm run test:browser
NB_TEST_SPLIT=1 npm run test:browser
```

Browser tests need Chrome (set `CHROME_PATH` to choose one). They cover
every feature under the real security policy, in both layouts. CI also
tests both Compose deployments over HTTPS. See
[CONTRIBUTING.md](CONTRIBUTING.md) for contribution and release rules.

</details>

## License

Copyright (C) 2026 jacobzymet. Nullbin is free software, licensed under the
[GNU Affero General Public License, version 3](LICENSE) only
(AGPL-3.0-only): you may use, change and share it under its terms.

If you run a **modified** version for others to use, the AGPL requires you
to offer them its source code, for example with a link to your fork.
Running an unmodified release needs nothing extra: its source is public
here.

Bundled third-party components keep [their own licenses](THIRD_PARTY_NOTICES).
