# Nullbin

Share text and files with a private link. Nullbin encrypts the content in
your browser before uploading it. The decryption key stays in the part of
the link after `#`; the browser never sends that part to the server.

Supports passwords, file attachments, encrypted comments, expiry, and burn
after reading. No accounts or database required.

## Start here

| I want to… | Follow this guide |
|---|---|
| Try Nullbin on my computer | [Local quick start](#try-it-on-your-computer) — Docker builds and runs everything. |
| Host Nullbin for others | [Option A: One server](#option-a-one-server-recommended) — the recommended starting point. |
| Host the frontend separately from the API | [Option B: Separate hosting](#option-b-separate-hosting) — a stronger security boundary. |
| Update a server I already set up | [Option A update](#update-to-a-new-release) or [Option B update](#update-the-api-and-frontend) |
| Understand the encryption, architecture, and limits | [Technical specifications](#technical-specifications) |
| Build from source or run tests | [Development guide](#development) |

Already running it? See [running a public instance](#running-a-public-instance),
[storage and upload limits](#storage-and-upload-limits),
[troubleshooting](#troubleshooting), or the [API reference](#api-reference).

## Try it on your computer

**You need:** [Docker Desktop](https://docs.docker.com/get-started/get-docker/),
installed and running. On Windows, select **Linux containers**. Docker
builds the app for you; you do not need Node.js or Go installed.

### 1. Get the source

Clone the repository:

```sh
git clone https://github.com/jacobzymet/nullbin-go.git nullbin
cd nullbin
```

This gets the development version (`main`), which is fine for trying
Nullbin out. To try the latest release instead, find its version on the
[Releases page](https://github.com/jacobzymet/nullbin-go/releases) and run
`git checkout v1.2.3` with that version.

You can also download and extract the repository as a ZIP. Open a terminal
in the extracted folder containing `Dockerfile`.

### 2. Build the image

```sh
docker build --build-arg VERSION=$(git describe --tags --always) -t nullbin-dev .
```

The first build takes a few minutes. Wait for it to finish successfully
before continuing. The `VERSION` part stamps the build with the version
you checked out, shown at the bottom of every page. If you downloaded a
ZIP, leave it out (`docker build -t nullbin-dev .`); the page then says
`dev`.

### 3. Start Nullbin

```sh
docker run --rm -p 127.0.0.1:8080:8080 -v nullbin-dev-data:/data nullbin-dev
```

These commands work in **Windows PowerShell 5.1 or later, Linux, and macOS**.

Open [http://localhost:8080](http://localhost:8080) and create a paste.
The terminal stays attached to the running app. Press **Ctrl+C** to stop it.
Run the same `docker run` command to start it again; pastes remain in the
`nullbin-dev-data` Docker volume.

This setup is for local use: it listens only on your computer and runs the
frontend and API together. To publish a site with HTTPS, use a deployment
option below.

## Using Nullbin

1. Enter text, attach a file, or both.
2. Choose an expiry and any optional settings: password, discussion, or
   burn after reading. A discussion requires a password and cannot be
   combined with burn after reading.
3. Select **Create** and share the **full link, including everything after
   `#`**. The link is copied automatically when the browser permits it;
   otherwise, use **Copy link** or copy it manually.
4. If you set a password, send it separately from the link. Keep the
   **Delete link** private; anyone with it can remove the paste and its
   comments for everyone.

**Burn after reading has a configurable open limit:** 1–1,000 opens, with
one open by default. Each authorized download uses one open, including
reloads and interrupted downloads. Wrong passwords and link previews do
not count. The paste becomes unavailable when the limit or expiry is
reached. This counts opens, not unique people.

### Actions after opening a paste

| Action | What it does |
|---|---|
| **New** | Opens a blank paste. |
| **Clone** | Copies the text and verified attachment into an editable draft. Choose its expiry, password, and other settings before creating it; comments and the original password are not copied. |
| **Raw text** | Opens the complete text in a new tab as plain text, without line numbers or HTML interpretation. |
| **Save document** | Downloads the complete text as `paste.txt`. Use **Save file** for an attachment. |
| **Email** | Opens your email app with the full share link. It does not include the paste text or password, or send anything automatically. |
| **QR code** | Generates a code locally for the full share link. No QR service receives the link or its key. |

Email and QR code are also available immediately after creation. Both
include the secret key in the share link; send any password separately.
They are disabled after the final allowed burn open has been used.

Cloning attachments up to **64 MiB** uses a verified copy held in browser
memory. For larger attachments, first use a streaming **Save file** in
desktop Chrome or Edge; Clone can then reuse the saved file without
buffering the whole attachment. Otherwise, save the file and attach it to
a new paste manually. Cloning does not fetch the paste again or use another
burn open.

## Choose how to deploy

Nullbin has two parts:

- **Frontend:** the website people open. It encrypts and decrypts content
  in their browsers.
- **API (backend):** the service that stores encrypted pastes on disk and
  handles uploads, downloads, expiry, and deletion.

| Option | Where it runs | Choose this if… |
|---|---|---|
| [A: One server](#option-a-one-server-recommended) | Frontend and API in separate containers on one server | You want the simplest hosted setup. |
| [B: Separate hosting](#option-b-separate-hosting) | Frontend on a static host; API on your server | You want a stronger boundary if the API server is compromised. |

**Both options support every Nullbin feature.** Both keep encrypted paste
data on the API server's own disk. The frontend can be hosted statically;
the API needs a server or container host with a persistent disk.

Option A starts both containers with one Docker Compose command. Its API
container cannot change the frontend files, but a whole-server compromise
can affect both. Option B keeps the frontend outside the API server's
control when its hosting and publishing credentials stay separate.

**Always deploy a release, not the `main` branch.** `main` is where
development happens and can be unstable. Each release is a tested commit
from `main`. The guides below download the latest release's source, and
Docker builds Nullbin from it on your server; nothing prebuilt is
downloaded.

## Option A: One server (recommended)

Use this path to host the frontend and API in separate containers on one
server. Caddy serves the website and manages HTTPS automatically.

### Before you start

- An Ubuntu 24.04 server with at least **1 GB of RAM** and SSH access.
- A domain such as `paste.example.com`, with DNS pointing to that server.
- TCP ports **80 and 443** open in both the server firewall and your hosting
  provider's firewall.

Replace `paste.example.com` with your domain throughout this guide.

### 1. Install Docker and download Nullbin

**On your server**, connect with SSH and run:

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2 git curl
VERSION=$(curl -fsSL https://api.github.com/repos/jacobzymet/nullbin-go/releases/latest | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')
echo "Installing $VERSION"
git clone --branch "$VERSION" https://github.com/jacobzymet/nullbin-go.git nullbin
cd nullbin/deploy
```

The `VERSION` line asks GitHub for the latest release, so `git clone`
downloads that release instead of `main`. The `echo` line should print a
version such as `Installing v1.2.3`. If it prints only `Installing`, no
release was found; see [troubleshooting](#troubleshooting).

Git may mention a "detached HEAD"; that is normal for a release. If you use
a private fork, clone it with a GitHub account that has access and set
`VERSION` to a release tag yourself.

### 2. Set your domain

Still in `nullbin/deploy`, run this with your domain name, **without
`https://` or a trailing slash**:

```bash
sudo ./nullbin setup paste.example.com
```

It writes the configuration file, `deploy/.env`. The defaults suit most
servers; to change [storage limits](#storage-and-upload-limits) later, edit
that file and run `sudo ./nullbin start`.

### 3. Start and check the site

From `nullbin/deploy`, run:

```bash
sudo ./nullbin start
```

The first start takes a few minutes. Open `https://paste.example.com` and
create a test paste. Caddy creates and renews HTTPS certificates for you.
The bottom of every page shows the installed version, such as
**Nullbin v1.2.3**.

You now have two containers:

- **Caddy:** serves the frontend files and handles HTTPS.
- **Nullbin:** runs only the API and stores encrypted pastes.

The containers start again automatically when the server reboots.

### Update to a new release

**To hear about new releases**, open the
[repository](https://github.com/jacobzymet/nullbin-go) on GitHub and choose
**Watch → Custom → Releases**. Install security fixes promptly.

1. Read the new release's notes on the
   [Releases page](https://github.com/jacobzymet/nullbin-go/releases). They
   say if an update needs anything beyond this step.
2. Connect to the server with SSH and run:

   ```bash
   cd ~/nullbin/deploy
   sudo ./nullbin update
   ```

   It shows the installed and the new version, switches to the new
   release, rebuilds, and waits until Nullbin is running again.
3. Open your site and create a test paste.

Your `.env` file and pastes are kept. The site is unavailable for a few
seconds while the new containers start. On a
[cloud-init](#new-ubuntu-vm-with-cloud-init) server, Nullbin is in
`/opt/nullbin/deploy`; run `cd /opt/nullbin/deploy` instead.

**To go back to an earlier release**, give its version, for example
`sudo ./nullbin update v1.2.2`. Check that release's notes first; a release
that changes how pastes are stored will say whether going back is safe.

### Check, stop, and maintain it

Run these **on the server, from `nullbin/deploy`** (`/opt/nullbin/deploy` on
cloud-init servers):

| Task | Command |
|---|---|
| Show the installed version and container status | `sudo ./nullbin status` |
| Read recent logs | `sudo ./nullbin logs` |
| Stop | `sudo ./nullbin stop` |
| Start again after stopping | `sudo ./nullbin start` |
| Remove a reported paste | `sudo ./nullbin delete <paste id>` ([details](#remove-a-reported-paste)) |
| Free disk space used by old builds | `sudo ./nullbin cleanup` |
| List every command | `./nullbin help` |

Stopping keeps pastes. Freeing disk space removes only unused images and
build files, never pastes; the next update rebuilds a little more slowly.
The only command that deletes all pastes is `docker compose down -v`,
which removes the data volume; `nullbin` never uses it.

## Option B: Separate hosting

Use this path to keep the frontend outside the API server's control.
Keep the frontend's hosting account and publishing credentials separate
from that server.

You will use two public addresses:

| Address in this guide | Purpose | Where it points |
|---|---|---|
| `https://paste.example.com` | Website people open and share | Your static frontend host |
| `https://api.example.com` | Stores and serves encrypted pastes | Your API server |

Replace both example addresses with your own. Complete the API setup
**on your server**, then build the frontend **on your computer**.

### 1. Set up the API on your server

You need an Ubuntu 24.04 server with at least **1 GB of RAM** and SSH access.
Point `api.example.com` at it and open TCP ports **80 and 443** in both firewalls.

Connect to the server with SSH, then run:

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2 git curl
VERSION=$(curl -fsSL https://api.github.com/repos/jacobzymet/nullbin-go/releases/latest | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')
echo "Installing $VERSION"
git clone --branch "$VERSION" https://github.com/jacobzymet/nullbin-go.git nullbin
cd nullbin/deploy
```

This downloads the latest release, not `main`. **Write down the printed
version** (such as `v1.2.3`): you will build the frontend from the same one.
If it prints only `Installing`, no release was found; see
[troubleshooting](#troubleshooting).

Configure the API with its own domain name, then the website's exact
address (with `https://`, and no path or trailing slash):

```bash
sudo ./nullbin setup-api api.example.com https://paste.example.com
```

Start the API from `nullbin/deploy`:

```bash
sudo ./nullbin start
```

It finds `.env.api` and starts the separate-API layout.

**Checkpoint:** open `https://api.example.com/api/v1/version`. You should
get JSON containing `"mode":"api"` and the version you installed. The API's home page returning **404
is expected**; it does not serve the website.

### 2. Build the frontend on your computer

Use a checkout on **your own computer**, separate from the API server.
Replace `v1.2.3` with the version printed on the API server:

```sh
git clone --branch v1.2.3 https://github.com/jacobzymet/nullbin-go.git nullbin
cd nullbin
```

If you already have a local checkout, open its top-level folder and run
`git fetch --tags` then `git checkout v1.2.3` instead.
Choose **one** build method below. Both produce static files; the frontend
does not need server-side JavaScript to run.

#### Build with Node.js

Install **Node.js 26 or later**, then install the project's dependencies:

```sh
npm ci --ignore-scripts
```

Build with your API's actual HTTPS address:

**Linux or macOS:**

```bash
NULLBIN_API_ORIGIN=https://api.example.com npm run build:frontend
```

**Windows PowerShell:**

```powershell
$env:NULLBIN_API_ORIGIN = "https://api.example.com"
npm run build:frontend
```

Your output folder is **`web/dist`**.

<details>
<summary><strong>Alternative: build with Docker instead of Node.js</strong></summary>

From the repository's top-level folder, run this single command. It works
in PowerShell, Linux, and macOS:

```sh
docker build --target frontend-files --build-arg API_ORIGIN=https://api.example.com --build-arg VERSION=$(git describe --tags) --output type=local,dest=out/frontend .
```

Replace the API address with your own. Your output folder is
**`out/frontend`** instead of `web/dist`. You do not need to install Node.js
or run `npm ci` with this method.

</details>

### 3. Upload the frontend to a static host

Use a host that supports **`_headers` and `_redirects`**, such as Cloudflare
Pages. These files apply security headers and make paste and delete links
work when opened directly.

For Cloudflare Pages:

1. Create a Pages project using **Direct Upload**.
2. Upload the complete output folder: **`web/dist`** for a Node.js build,
   or **`out/frontend`** for a Docker build. Include `_headers` and `_redirects`.
3. Add `paste.example.com` under the project's **Custom domains** settings
   and follow the DNS instructions.
4. Open `https://paste.example.com`, create a paste, and open its full share
   link to confirm the frontend can reach the API.

**The website address must exactly match `FRONTEND_ORIGIN`.** Alternate
and preview addresses are not automatically allowed. You can use a
`https://your-project.pages.dev` address instead of a custom domain if you
set that exact origin in `.env.api` and restart the API containers.

Share links from the **frontend**, not the API. The key stays in the
browser; the API receives encrypted content and the access tokens it needs.

### Update the API and frontend

**To hear about new releases**, open the
[repository](https://github.com/jacobzymet/nullbin-go) on GitHub and choose
**Watch → Custom → Releases**. Install security fixes promptly.

Keep both parts on the same release, and **update the API first**, then
the frontend:

1. Read the new release's notes on the
   [Releases page](https://github.com/jacobzymet/nullbin-go/releases).
2. **Update the API.** Connect to the API server with SSH and run:

   ```bash
   cd ~/nullbin/deploy
   sudo ./nullbin update
   ```

   Write down the printed version.
3. **Update the frontend.** On your computer, in your frontend checkout,
   run these with that version:

   ```sh
   git fetch --tags
   git checkout v1.2.3
   ```

   Then repeat your [build](#2-build-the-frontend-on-your-computer)
   (for Node.js, run `npm ci --ignore-scripts` again first) and
   [upload](#3-upload-the-frontend-to-a-static-host) the new output folder.
4. Open your site and create a test paste.

Pastes and `.env.api` are kept. To go back to an earlier release, run
`sudo ./nullbin update v1.2.2` on the API server and build the frontend
from the same version, after checking its release notes.

Every [Option A command](#check-stop-and-maintain-it) works the same way on
the API server.

| If you change… | You must also… |
|---|---|
| The API address | Rebuild and upload the frontend with the new `NULLBIN_API_ORIGIN` (or Docker `API_ORIGIN`). |
| The frontend address | Update `FRONTEND_ORIGIN` in `.env.api` and run `sudo ./nullbin start`. Existing share links still use the old website address. |

## Storage and upload limits

Edit the configuration **on the API server, in `nullbin/deploy`**:

- **Option A:** `.env`
- **Option B:** `.env.api`

| Setting | Default | What it controls |
|---|---|---|
| `MAX_SIZE` | `100MiB` | Largest encrypted paste, including its attachment and encryption overhead. |
| `MAX_STORAGE` | `10GiB` | Total reserved storage for pastes, unfinished uploads, metadata, and discussion capacity. |
| `MAX_PENDING` | `64` | Maximum number of unfinished uploads at once. |

Set `MAX_STORAGE` **below the data volume's capacity**. Leave space for the
operating system, filesystem overhead, container images, and other files.
After editing, run `sudo ./nullbin start` to apply the changes.

Pastes live in a Docker volume on the API server. Ordinary updates and
stops preserve it; `docker compose down -v` deletes it. Run **one API
instance with local persistent disk**. Multiple API processes and shared
network filesystems are unsupported.

See the [configuration reference](#server-configuration) for
all settings, accepted values, and fixed limits.

## Running a public instance

Anyone on the internet can use a public Nullbin. Before you share its
address:

1. **Keep the server updated.** Watch the repository for releases (see
   [updating](#update-to-a-new-release)) and install security fixes
   promptly. The cloud-init setup also installs Ubuntu updates
   automatically; on other servers, turn on `unattended-upgrades`.
2. **Protect the accounts that control it.** Use SSH keys rather than
   passwords for the server, and keep the `nullbin` folder owned and
   writable by you alone: whoever can change it controls what runs as root,
   as with any Docker setup. Turn on two-factor authentication for the
   GitHub account that publishes releases. With Option B, also protect the
   static host account that publishes the frontend: whoever controls it
   controls the code that handles keys.
3. **Publish a way to report abuse,** such as an email address on your
   domain. You cannot see what pastes contain, so reports are how you
   learn about illegal content. The **Report a vulnerability** link at the
   bottom of every page goes to the Nullbin maintainer and is only for
   security flaws in the software, not for reporting pastes.
4. **Check the live site from outside.** Run your address through the
   [SSL Labs server test](https://www.ssllabs.com/ssltest/) (HTTPS setup) and
   [Mozilla HTTP Observatory](https://developer.mozilla.org/en-US/observatory)
   (security headers). Both should give top grades; look into any warning.

### Remove a reported paste

A report usually includes a link like
`https://paste.example.com/p/0123456789abcdef0123456789abcdef#…`. You need
only the 32 characters after `/p/` (or `/d/`), not the part after `#`,
which is the key.

**On the server, from `nullbin/deploy`**, replace the example ID and run:

```bash
sudo ./nullbin delete 0123456789abcdef0123456789abcdef
```

It prints `Deleted.` and the paste, with its comments, is gone. The API is
offline for a few seconds while it runs; the website stays up. It works
the same in both layouts.

### What the server knows

The server stores only encrypted pastes and the minimum needed to serve
them: size, creation and expiry times, burn and discussion settings, and
hashes of the access tokens. It does not log IP addresses, paste IDs or tokens, and it
keeps nothing that ties a paste to whoever uploaded it. So you cannot
read a reported paste, and you have no uploader details to hand over.
Expired and deleted pastes are removed from disk within a minute, though
backups and disk snapshots may keep copies.

## Security in plain language

### What happens in the browser

Encryption, decryption, password processing, and comment encryption all
happen in the browser. The API stores encrypted bytes and enforces access
tokens, expiry, burn after reading, storage limits, and transfer limits.

The **full link is a secret**. A password adds another requirement; anyone
with both the link and password can read the paste. Send them separately.

### What you still need to trust

- **Frontend host and publishing account:** someone who controls these
  can change the code that handles keys and content. Protect publishing
  access and keep the frontend code updated.
- **API availability and behavior:** a compromised API can delete or
  withhold pastes, keep encrypted copies, and observe metadata.
- **Deployment isolation:** Option A separates containers, but a
  whole-server compromise can affect both. Option B keeps the frontend
  outside the API server's control only when its hosting and publishing
  credentials remain separate.

Both parts need updates and careful access control. Backups and snapshots
may retain deleted or expired ciphertext.

### File downloads, caching, and traffic

- **Interrupted burn downloads use an open.** You can open the paste again
  only if allowed opens remain. Once the final open is used, it cannot be
  retrieved again.
- **Large attachments need streaming file saves.** Browsers that support
  them can save large files; other browsers use a memory-based fallback
  limited to **64 MiB**. Desktop Chrome and Edge support streaming saves.
- **Public assets can be cached; pastes cannot.** Frontend assets have
  content-hashed names. Paste responses are never cached.
- **API limits cover API traffic.** Caddy or the static host serves public
  frontend traffic. Apply any required public-site traffic limits at that
  host or its ingress.

Read the [full threat model](THREAT_MODEL.md) for the detailed guarantees
and limitations.

## Technical specifications

### Architecture and runtime

| Component | Specification |
|---|---|
| Frontend | TypeScript with native browser APIs; Bootstrap 5.3.8 CSS, without Bootstrap JavaScript or a frontend framework. Builds to static HTML, JavaScript, and CSS. |
| Cryptographic library | `libsodium-wrappers-sumo` 0.8.4, including bundled WebAssembly. Encryption runs in the browser; no CDN or external cryptographic service is used. |
| Backend | Go 1.25 or later, standard library only; no third-party Go modules, database, accounts, or server-side JavaScript runtime. |
| Storage | Ciphertext and JSON operational metadata on local persistent disk. One API process per data directory; shared network filesystems and multiple API writers are unsupported. Files use mode `0600`, directories `0700`. |
| Deployment | Separate static frontend and API, on one server or separate hosts. In the provided production Compose layouts, the API and the Caddy HTTPS proxy both run from distroless images (no shell, tools or package manager) as non-root users with read-only root filesystems and no added capabilities; only their data volumes are writable. The API has no internet access. Caddy serves HTTP/1.1 and HTTP/2 only, without HTTP/3. Linux is the supported production platform. |
| Browser requirements | JavaScript and WebAssembly. Production uses HTTPS. Clipboard access is optional; manual copying remains available. Streaming file saves are optional, with the limits below. |
| HTTP security | Strict Content Security Policy with Trusted Types (the browser refuses HTML-injection APIs), Subresource Integrity for scripts/styles, `no-referrer`, `nosniff`, and `same-origin` COOP/CORP headers, and COEP `require-corp`, which isolates the page from side-channel memory reads. API CORS permits only the configured frontend origin, without cookies or credentialed requests. |
| Distribution | Dependencies are pinned; frontend files have SHA-256 manifests and content-hashed asset names. Builds are reproducible, and each release lists the checksums its build produces. Nothing prebuilt is published. See [verification](#verify-a-build-or-running-site) and [third-party notices](THIRD_PARTY_NOTICES), including the pinned local QR encoder. |

HTTPS protects the connection separately from paste encryption. Its TLS
cipher is negotiated by the browser and HTTPS host.

### Encryption and keys

**Pastes use XChaCha20-Poly1305 with 256-bit keys**, through libsodium's
`crypto_secretstream_xchacha20poly1305` API. This authenticated streaming
construction processes files in small chunks and detects altered, missing,
duplicated, reordered, or truncated data. It supplies the stream's nonce
management and authentication, which fits large attachments without loading
the whole file into memory. See the
[libsodium streaming-encryption documentation](https://doc.libsodium.org/secret-key_cryptography/secretstream).

| Property | Specification |
|---|---|
| Link secret | Fresh 32 random bytes (256 bits) per paste, encoded as 43 unpadded base64url characters after `#`. This is a shared secret for one paste, not a personal public/private key pair. |
| Encryption key | A separate 32-byte stream key derived from the master key. The master is the link secret alone, or a combination of the link secret and password as detailed below. |
| Password protection | Argon2id v1.3, with a fresh 16-byte salt, `opslimit = 3`, `memlimit = 256 MiB`, and a 32-byte result. Passwords are normalized to Unicode NFC first. A keyed BLAKE2b-256 operation combines that result with the link secret. |
| Password requirements | At least 8 characters in the browser UI. Argon2id's memory budget is consumed on the reader's/writer's device; the browser needs additional memory for its own runtime. Neither the password nor master key is sent to the API. |
| Independent capabilities | Paste encryption, comment encryption, discussion access, and burn access use distinct `crypto_kdf_derive_from_key` contexts. The access tokens sent to the server cannot decrypt content. |
| Discussions | Each comment uses XChaCha20-Poly1305 with a fresh 24-byte random nonce and 16-byte authentication tag, under the separate comment key. Authentication binds it to its paste ID. Names, text, timestamps, and reply relationships are encrypted. Names are not verified identities. |
| IDs and server tokens | Paste IDs contain 128 random bits (32 hexadecimal characters). Upload/delete tokens contain 256 random bits (43 base64url characters). The server stores SHA-256 hashes of capability tokens and compares hashes in constant time. |

**The complete share link is a secret.** The portion before `#` locates
the encrypted paste; the browser does not include the fragment in its HTTP
request. Nullbin reads it locally, then removes it from the address bar.
Anyone with the complete link can decrypt the paste unless a password was
also set, in which case both are required. Email and QR sharing intentionally
include that link secret. A delete link carries a separate deletion token.

The website's code must still be trusted: malicious frontend code could
read the fragment or plaintext. See [security in plain language](#security-in-plain-language)
for the deployment and trust boundaries.

### Content and browser limits

These describe the current implementation. Binary units use powers of
1,024. String-length limits use JavaScript UTF-16 code units.

| Item | Limit or behavior |
|---|---|
| Encrypted paste | 100 MiB by default; configurable from 64 KiB to a hard maximum of 2 GiB. Encryption overhead counts toward the limit. |
| Text and encrypted metadata | The complete UTF-8 metadata JSON, including text, filename, MIME type, and other fields, must fit within 16 MiB. The usable text limit is slightly smaller. |
| Attachment count | One file per paste, optionally accompanied by text. Filename and MIME-type strings are limited to 255 units each. |
| File encryption frames | 64 KiB of plaintext per non-final file frame; the final frame may be shorter. This differs from HTTP upload chunks: the browser batches ciphertext into 4 MiB requests, and the API accepts up to 8 MiB per request. |
| Text preview | At most 5,000 lines or 100,000 units. Copy, Raw text, Save document, and Clone use the full text. |
| File saves and cloning | Memory-based downloads and retained clone copies are capped at 64 MiB. Streaming saves support larger files; a successfully saved File can then be reused for cloning in bounded slices. Desktop Chrome/Edge support this path. Files are never previewed or executed by Nullbin. |
| Discussion | At most 200 encrypted comments per paste; each stored comment is at most 32 KiB. The browser accepts up to 4,000 units of comment text and 40 units for an optional name. Discussions require a password and cannot burn after reading. |
| Expiry | 5 minutes, 1 hour, 1 day, 7 days, or 30 days. There is no unlimited-expiry setting. Expired pastes are never served; physical cleanup runs once per minute. |
| Burn after reading | 1–1,000 authorized opens, default 1. Reloads and interrupted downloads count; wrong passwords and link previews do not. Counters are persisted before delivery and survive restarts. |

See [server configuration](#server-configuration) for storage quotas,
request rates, concurrency, bandwidth, and timeout limits, and the
[API reference](#api-reference) for endpoint and compatibility details.

<details>
<summary>Exact key derivation and version 1 wire formats</summary>

Without a password, `master = link_secret`. With a password:

```text
stretched = Argon2id-v1.3(NFC(password), salt,
                        output=32 bytes, opslimit=3, memlimit=256 MiB)
master    = BLAKE2b-256(key=link_secret, message=stretched)
```

Each subkey is `crypto_kdf_derive_from_key(32, 1, context, master)`:

| Context (8 ASCII bytes) | Purpose |
|---|---|
| `nbstream` | Paste/file encryption key |
| `nbcmtenc` | Comment encryption key |
| `nbcmtacc` | Discussion access token |
| `nbburnac` | Burn-read access token |

The salt is public and random when a password is used, and all zero
otherwise. Derived access tokens are base64url encoded before use in API
headers; their hashes are registered with the server at paste creation.

**Encrypted paste blob, version 1:**

| Byte offset | Size | Field |
|---|---|---|
| 0 | 4 bytes | Magic `NBN1` |
| 4 | 1 byte | Version `1` |
| 5 | 1 byte | Flags: bit 0 indicates password protection; other bits must be zero |
| 6 | 16 bytes | Password salt |
| 22 | 24 bytes | Libsodium secretstream header |
| 46 | Remaining bytes | Encrypted frames |

Every frame contains a 4-byte big-endian ciphertext length followed by the
ciphertext, with 17 bytes of secretstream overhead. The first frame holds
UTF-8 JSON with exactly `type`, `text`, `filename`, `mime`, `size`, and
`discussion`. Bytes 0–21 are authenticated as additional data for this frame.
For text-only pastes it carries `TAG_FINAL`; otherwise file frames follow,
with the last carrying `TAG_FINAL`. Even an empty attached file has a final
file frame. Trailing bytes, invalid lengths, and incomplete streams are rejected.

The exact blob size is 46 header bytes, plus 21 bytes and the JSON size for
the metadata frame, plus the file's bytes and 21 bytes per file frame.

**Encrypted comment, version 1:** one version byte (`1`), a 24-byte nonce,
then XChaCha20-Poly1305 ciphertext with a 16-byte authentication tag. The
encrypted UTF-8 JSON contains `id`, `parent`, `name`, `text`, and `time`.
Comment IDs are 128-bit random hexadecimal values; `parent` is another
comment ID or `null`, and `time` is the writer's Unix timestamp in
milliseconds. Additional authenticated data is `nullbin comment v1 <paste id>`.

Implementation references: [paste crypto](web/src/crypto.ts),
[blob parsing](web/src/format.ts), [comment crypto](web/src/comments.ts),
and [link encoding](web/src/link.ts).

</details>

## Troubleshooting

| Symptom | What to check |
|---|---|
| The hosted site does not open or HTTPS is not ready | Check that DNS points to the correct host and ports 80/443 are open in both firewalls. On the server, check `sudo ./nullbin status` and `sudo ./nullbin logs` from `nullbin/deploy`. |
| The API home page returns 404 | Expected in Option B. Check `/api/v1/version` instead; it should report `"mode":"api"`. |
| The frontend opens, but creating or opening pastes fails | Check the API version endpoint, the exact `FRONTEND_ORIGIN`, and the API address used to build the frontend. Rebuild and upload the frontend after changing the API address. |
| A share link opens a hosting provider's 404 page | Make sure the full output folder was uploaded, including `_redirects`, and that the host applies its routing rules. |
| The install's version line prints only `Installing`, or `nullbin update` cannot look up the latest release | The server could not reach GitHub, or no release has been published yet. Check the [Releases page](https://github.com/jacobzymet/nullbin-go/releases), then run the commands again. Do not continue without a version. |
| `nullbin update` says files that came with Nullbin were edited | A file such as a Caddyfile was changed by hand, and updating would overwrite it. It lists the files; `git -C ~/nullbin stash` sets the edits aside so the update can continue. `.env` and `.env.api` are never affected. |
| `nullbin` says to run it with sudo | It needs administrator rights for Docker: run `sudo ./nullbin ...` from the `deploy` folder. |
| The server is running out of disk space | Free space used by old builds with `sudo ./nullbin cleanup`. This never deletes pastes. |

## More deployment options

Optional alternatives to the two deployment guides above.

### Automatic frontend builds

A static hosting service can build the frontend from Git automatically.
For a service that supports `_headers` and `_redirects`, use:

| Setting | Value |
|---|---|
| Root directory | Repository root |
| Node version | 26 or later |
| Build command | `npm ci --ignore-scripts && npm run build:frontend` |
| Output directory | `web/dist` |
| Environment variable | `NULLBIN_API_ORIGIN=https://api.example.com` |

Automatic builds follow a branch, so do not point them at this repository's
`main`, which can be unstable. Use a branch in your own fork that you only
move to release tags, or build a release yourself and use Direct Upload.

Set the API's `FRONTEND_ORIGIN` to the exact production frontend address.
Preview domains are not automatically trusted. Keep the frontend service's
publishing credentials off the API server. Disable any feature that injects
analytics or rewrites/minifies the built HTML/JavaScript; it would change
the verified code or break the security policy.

For Cloudflare Pages, use its official instructions for
[Git integration](https://developers.cloudflare.com/pages/get-started/git-integration/),
[Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)
and [custom domains](https://developers.cloudflare.com/pages/configuration/custom-domains/).

### Use your own static host

Serve the contents of `web/dist` from the site root. Required behavior:

- `/p/<id>` and `/d/<id>` must serve `index.html` without changing the URL.
- Apply the headers in `_headers`, including CSP and Referrer-Policy.
- Use HTTPS. Do not add scripts, change code, or cache API responses.
- Cache content-hashed `/assets/` files; serve a fresh `index.html`.
- Apply public-site traffic controls at the static host or its ingress.

Caddy's equivalent header file is generated at `web/generated/headers.caddy`.
The provided `deploy/Caddyfile` shows static routing and API response
isolation. It forces a sandboxed CSP on API responses and removes
Set-Cookie and Service-Worker-Allowed so the API cannot supply executable
pages or register a worker for the frontend's root.

### New Ubuntu VM with cloud-init

[deploy/cloud-init.yaml](deploy/cloud-init.yaml) installs and starts
Option A on a new Ubuntu 24.04 VM. Set `DOMAIN` in its marked settings block,
point that domain at the VM, and provide the file as cloud-init/user data
when creating the VM. It installs Docker, configures the firewall, enables
host updates, downloads the latest Nullbin release, builds it and starts
both containers. Nullbin is installed in `/opt/nullbin`. Manage and update
it with the [same commands](#check-stop-and-maintain-it), run from
`/opt/nullbin/deploy`.

The Compose setup is tested in CI. The complete cloud-init boot process
has not been tested on a real cloud VM.

### Data and upgrades

Caddy keeps its HTTPS certificates in the `proxy-data` and `proxy-config`
volumes.

Both Compose layouts use the same `nullbin_nullbin-data` named volume. Its
contents are ciphertext and minimal metadata. Updates and ordinary
`docker compose down` preserve it. `down -v` deletes it.

To switch layouts on the same API server, stop the old layout without `-v`
before starting the other one. The frontend's public address should stay
the same if you want existing share links to keep working. Running both
layouts simultaneously would conflict on ports and the shared data volume.

The API must have one running instance and local persistent disk. Multiple
API processes or network filesystems are unsupported. Backups and disk
snapshots may retain deleted or expired ciphertext. Set MAX_STORAGE below
the data volume's capacity and leave room for the OS and other files.

### Optional combined server

The default Dockerfile target and ordinary Go build retain the combined
UI/API mode for local use and existing integrations. This mode has no
separate frontend security boundary. See [Development](#development).
For the isolated deployment, use Compose or the Dockerfile `backend` and
`frontend` targets.

## Development

<details>
<summary>Build from source and run the test suites</summary>

Use Go 1.25 or later and Node.js 26 or later. CI and release tool versions
are pinned in the workflows and Dockerfile.

### Quick local test with Docker

See [Try it on your computer](#try-it-on-your-computer) for
one-line commands for Windows PowerShell, Linux and macOS. This builds and
runs the combined frontend/API container at http://localhost:8080.
Windows users need Docker Desktop running in Linux-container mode.

### API only

No Node.js or frontend build is needed:

```bash
go build -tags=api -trimpath -o nullbin ./cmd/nullbin
NULLBIN_API_ONLY=true ./nullbin
```

On Windows PowerShell, build with `-o nullbin.exe`, set environment variables
with `$env:NULLBIN_API_ONLY = "true"`, and run `.\nullbin.exe`.

For an independently hosted frontend, also set
`NULLBIN_FRONTEND_ORIGIN=https://paste.example.com`. Run one API process
with local persistent storage.

### Frontend only

```bash
npm ci --ignore-scripts
NULLBIN_API_ORIGIN=https://api.example.com npm run build:frontend
```

Upload `web/dist` to your static host. Build from a trusted computer or
frontend build service; keep frontend deployment credentials off the API
server. `NULLBIN_API_ORIGIN` is fixed in the build. Shared links and API
responses cannot change it. An empty value uses the frontend's own origin.

`web/dist/_headers` contains the security policy, including the API origin.
`web/dist/_redirects` rewrites paste/delete routes to `index.html`.
`web/generated/headers.caddy` is the equivalent Caddy header configuration.
Only public assets with content-hashed names receive long-lived caching.

### Combined binary for local development

The optional combined mode still serves the UI and API from one process:

```bash
npm ci --ignore-scripts
npm run build
go build -trimpath -o nullbin ./cmd/nullbin
./nullbin
```

Open `http://127.0.0.1:8080`. This mode has no separate frontend security
boundary. Production Compose files use the API-only image instead.

### Tests

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

Browser tests require Chrome. They test passwords, attachments, burn reads,
comments, deletion, preview bounds, CSP and request destinations. The split
run uses a real API-only binary and an independent static HTTP test server.
CI also tests both actual Caddy/Compose deployments over HTTPS.

Use `NB_TEST_BINARY` to provide an existing binary and `CHROME_PATH` to
select Chrome. API builds should run with `NULLBIN_API_ONLY=true`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution and dependency rules.

</details>

## API reference

<details>
<summary>Endpoints, authentication tokens, responses, and link formats</summary>

All endpoints are under `/api/v1`. Errors are JSON, `{"error": "..."}`.
Every response carries the security headers (CSP, `no-store`, `nosniff`,
`no-referrer`, COOP, CORP, Permissions-Policy). Unknown pastes, expired
pastes, burned pastes and wrong tokens all return the same `404`.

### `POST /api/v1/pastes`

Starts an upload. Requires `Content-Type: application/json`. Rate limited.

```json
{"expires_in": 86400, "burn_after_reading": false, "total_size": 12345}
```

- `expires_in`: seconds, one of `300`, `3600`, `86400`, `604800`, `2592000`.
- `total_size`: exact ciphertext size in bytes, at least 67, at most the
  configured maximum.
- `max_reads` (optional): integer from `1` to `1000`, allowed only when
  `burn_after_reading` is true. Defaults to `1`. Counts authorized download
  attempts, including interrupted transfers and reloads, not unique people.
- `comment_token` (optional): 43 base64url characters. Present means the
  paste has a discussion. The browser derives it from the link key and the
  password; the server stores only its SHA-256. Not allowed together with
  `burn_after_reading`.
- `burn_token`: required when `burn_after_reading` is true, forbidden otherwise.
  43 base64url characters derived in the browser from the master key using
  `crypto_kdf_derive_from_key(32, 1, "nbburnac", master)`. Only SHA-256 of the
  token is stored; the token cannot decrypt the paste.

`201 Created`:

```json
{"id": "<32 hex chars>", "upload_token": "<43 chars>", "delete_token": "<43 chars>"}
```

`400` invalid request, `413` too large (body includes `max_size`), `415`
wrong content type, `429` rate limited (with `Retry-After`), `507` storage
capacity reached, `503` too many pending uploads (with `Retry-After`).

### `PUT /api/v1/pastes/{id}/chunks/{n}`

Uploads chunk `n` (0, 1, 2, ... in order) as `application/octet-stream`,
with header `Nullbin-Upload-Token: <upload_token>`. At most 8 MiB per
request, and at least 4 MiB for every chunk except the one that completes
the upload. A chunk that failed part-way may be sent again with the same
`n`. An upload expires if 2 minutes pass without a chunk completing (a
chunk still arriving keeps it alive), and always 1 hour after it was
created. Rate limited.

`204` stored, `400` bad index, empty body or chunk below 4 MiB, `404` unknown upload or wrong
token, `409` out of order (the body's `next_chunk` is the index the server
expects, so a client whose response got lost can tell its chunk arrived) or
another request is busy with this upload, `413` chunk too large or over
`total_size`, `415` wrong content type.

### `POST /api/v1/pastes/{id}/finalize`

With header `Nullbin-Upload-Token`. Publishes the paste atomically once
exactly `total_size` bytes have arrived. The upload token stops working.

`200` with `{"expires_at": "<RFC 3339>"}`, `400` upload incomplete, `404`.

### `GET /api/v1/pastes/{id}`

Streams a reusable paste's ciphertext as `application/octet-stream` with
`Content-Disposition: attachment`. Burn pastes return `404`, even with a token.
`HEAD` returns `405`. Rate limited and bandwidth controlled.

### `GET /api/v1/pastes/{id}/prefix`

For a burn paste, returns only the first 22 public format bytes (magic,
version, flags, password salt). It never claims or consumes the paste, and
reveals no encrypted metadata/content. Rate limited. `HEAD` returns `405`.

### `POST /api/v1/pastes/{id}/read`

With header `Nullbin-Burn-Token: <burn_token>`, streams a burn paste's
ciphertext. The browser uses the public prefix to derive the master key
from the link key and optional password, then derives the separate burn
token. Authentication happens before the atomic claim. Missing or incorrect
tokens return `404` without consuming anything. Requests from untrusted
browser origins are rejected. Each authorized request consumes one allowed open before
any ciphertext is returned. Multi-open counters are atomically persisted
before delivery and survive restarts. The paste becomes unavailable when
its limit is reached; encrypted files are removed when readers close,
with the sweeper retrying cleanup after failures or crashes. Interrupted
downloads still count. Rate limited and bandwidth controlled. Reusable
pastes return `404`.

Successful responses include `Nullbin-Reads-Remaining`, the number of
opens left after this request's reservation. This is a snapshot; concurrent
readers may use the remaining opens. Prefix and error responses do not
expose this count. Ordinary GET/HEAD requests, wrong passwords/tokens, and
link previews do not consume opens.

**Compatibility:** existing burn pastes with a registered token but no
read-limit metadata retain the one-open default. Legacy burn pastes
without a registered token remain unreadable, deletable with the existing
delete link, and subject to expiry. Reusable pastes and share-link formats
are unchanged. Deploy the updated API before creating multi-open pastes
with the updated frontend; older APIs reject the new `max_reads` field.

### `DELETE /api/v1/pastes/{id}`

With header `Nullbin-Delete-Token: <delete_token>`. `204` deleted (with any
comments), `404`, `409` busy for a moment (try again).

### `POST /api/v1/pastes/{id}/comments`

Adds one encrypted comment (`application/octet-stream`, 41 bytes to
32 KiB) with header `Nullbin-Comment-Token: <comment_token>`. Rate limited.

`201` with `{"count": n}`, `400` too short, `404` unknown or expired paste,
no discussion, or wrong token, `409` discussion full (200 comments) or busy
for a moment, `413` too large, `415` wrong content type.

### `GET /api/v1/pastes/{id}/comments`

With header `Nullbin-Comment-Token`. `200` with
`{"comments": ["<base64>", ...]}` in arrival order, or the same `404`.
The JSON is streamed without a fixed `Content-Length`; an interrupted or
corrupt response is aborted, so clients must require a complete JSON document.

### `GET /api/v1/version`

```json
{"version": "v1.2.3", "js_sha256": "...", "css_sha256": "...", "html_sha256": "..."}
```

In API-only mode this returns `{"version":"...","mode":"api"}`.
The optional combined binary also reports its embedded frontend hashes.
For a separately hosted frontend, read `/version.json` on the frontend host.

### Links

Links always use the **frontend** address, even when the API is elsewhere.

- View: `https://host/p/<id>#<key>` (or `#<key>.b` for burn after reading,
  so the page can warn before fetching). The key is 32 bytes, base64url.
- Delete: `https://host/d/<id>#<delete_token>`.


### Separate frontend origins

Set `NULLBIN_FRONTEND_ORIGIN=https://paste.example.com` on the API and build
that frontend with `NULLBIN_API_ORIGIN=https://api.example.com`. Use full
origins with no path or trailing slash. HTTPS is required outside localhost.

CORS allows only that exact frontend origin. Preflights allow GET, HEAD,
POST, PUT and DELETE, plus Content-Type and the four Nullbin token headers.
The API never uses cookies or allows credentialed CORS. Tokens are still
required for uploads, deletion, burn reads and comments. Retry-After,
Content-Length and Nullbin-Reads-Remaining are exposed to the frontend.
Other browser origins receive no CORS grant, and cross-site unsafe requests
remain blocked.

</details>

## Server configuration

<details>
<summary>Environment variables, storage reservations, and fixed limits</summary>

Environment variables only. Bad values, and any unknown `NULLBIN_*`
variable (usually a typo), stop the server at startup.

The binary has three commands: `nullbin` runs the server, `nullbin
healthcheck` checks a running one (the container health check uses it),
and `nullbin delete <paste id>` removes one paste or unfinished upload
from the data directory, without its delete link. Stop the server before
using `delete`; see [removing a reported paste](#remove-a-reported-paste).

| Variable | Default | Meaning |
|---|---|---|
| `NULLBIN_API_ONLY` | `false` (`true` in the API image) | Serve only the API; no frontend routes. |
| `NULLBIN_FRONTEND_ORIGIN` | empty | Exact HTTPS frontend origin allowed to call the API. No path or trailing slash. Empty allows no cross-origin frontend. |
| `NULLBIN_LISTEN_ADDR` | `127.0.0.1:8080` (`:8080` in the image) | `host:port` to listen on. Host must be empty, `localhost` or an IP. |
| `NULLBIN_DATA_DIR` | `data` (`/data` in the image) | Data directory. Created with mode `0700` if missing. |
| `NULLBIN_MAX_STORAGE` | `10GiB` | Total reserved storage budget (bytes or binary units, `64KiB`–1 PiB). Includes full unfinished uploads, metadata overhead and discussion capacity; reconstructed on restart. Set below the data volume capacity with free space for other uses. |
| `NULLBIN_MAX_PENDING` | `64` | Maximum unfinished uploads (1–4096). An upload stops counting once finalized or expired (2 minutes without progress, at most 1 hour); cleanup runs once per minute. |
| `NULLBIN_MAX_SIZE` | `100MiB` | Largest paste (ciphertext). Bytes or `KiB`/`MiB`/`GiB`. Between `64KiB` and the hard ceiling of `2GiB`. |
| `NULLBIN_BEHIND_HTTPS` | `false` | `true` sends `Strict-Transport-Security: max-age=31536000`. |
| `NULLBIN_TRUSTED_PROXIES` | *(empty)* | Comma-separated IPs or CIDR prefixes. `X-Forwarded-For` is read only when the direct peer is in this list. |

### Fixed request rates

These token-bucket limits are fixed in code. The burst is the maximum
immediately available request allowance; it refills at the sustained rate.

| Request class | Sustained rate per client | Burst |
|---|---|---|
| Create a paste | 20/minute | 20 |
| Upload chunks and finalize | 10/second | 50 |
| Post comments | 20/minute | 10 |
| Paste downloads, burn-prefix/read requests, and discussion reads (shared) | 20/minute | 20 |
| Pages and public assets in combined mode | 5/second | 100 |

IPv6 clients are grouped by `/64`; concurrent-transfer limits also cap each IPv6 `/48`, since one `/48` holds 65,536 `/64` networks. Each per-client limiter tracks at most
100,000 client networks and fails closed when full. Forwarded client IPs
are trusted only through `NULLBIN_TRUSTED_PROXIES`. Deletion and version
endpoints have no dedicated request-rate bucket.

### Fixed transfer and timeout limits

| Limit | Value |
|---|---|
| Create-request JSON body | 1 KiB |
| HTTP headers | 16 KiB |
| Unfinished upload lifetime | 2 minutes without a completed chunk, and at most 1 hour in total |
| Upload chunk size | At least 4 MiB, except the last chunk; the browser sends 4 MiB |
| Upload request body | At most 8 MiB; the browser normally sends 4 MiB |
| Concurrent chunk uploads | 128 across the API process, 4 per client network, 16 per IPv6 `/48` |
| Minimum chunk upload rate | 16 KiB/s average after a 15-second grace period |
| Concurrent downloads | 512 across the API process, 16 per client network, 64 per IPv6 `/48` |
| Minimum download rate | 32 KiB/s average after a 2-minute grace period. Only time spent waiting for the client counts, not time the server spends on its own bandwidth limits. |
| Unfinished uploads | 8 per client network (plus the global `MAX_PENDING`), freed when finalized or expired |
| Download bandwidth | 4 MiB/s per client, 16 MiB/s total, each with one second of burst capacity |
| Header / idle timeouts | 10 seconds / 60 seconds |
| Default request read / write timeouts | 30 seconds each |
| Chunk request deadlines | 5 minutes for reading; another 10 seconds for the response |
| Download deadlines | Scale with the response-size allowance, using a 60-second base plus time at 32 KiB/s. Password and save dialogs pause a download; a pause longer than the 2-minute grace period ends it. |

Paste and discussion responses share the bandwidth and download-concurrency
budgets. The optional combined binary also applies them to static responses.
Separately hosted frontend traffic uses its host's own controls. Discussion
responses stream one encrypted comment at a time. Browser rendering, content,
expiry, and burn limits are listed under [Technical specifications](#technical-specifications).

Uploads reserve their entire declared size plus 32 KiB for filesystem and
metadata overhead before any chunks are accepted. Discussions also reserve
capacity for all 200 comments. Full capacity returns `507`; too many pending
uploads or concurrent transfers returns `503` with `Retry-After`. Reservations
are released after successful deletion, expiry or burning; files still open
for download remain charged until closed. Reducing the quota below existing
usage blocks new uploads while preserving live pastes. This is an application
budget, not a filesystem quota: leave disk headroom and use a dedicated volume
or filesystem quota to protect against other applications filling the disk.

The viewer reads ciphertext on demand and streams attachments to disk when
the browser supports the File System Access API. The fallback for other
browsers is capped at 64 MiB; larger files require desktop Chrome/Edge with
streaming saves. Password/save prompts do not buffer the full ciphertext.

</details>

## Verify a build or running site

<details>
<summary>Check file hashes and reproducible builds</summary>

Use the same source revision and build settings as the deployer. The API
address is part of an independently hosted frontend build, so changing it
changes the JavaScript and HTML hashes.

### Static frontend

The frontend exposes `/version.json`, which lists its version, API origin,
content-hashed asset URLs, and the SHA-256 of its page, script and style.
The same version appears at the bottom of every page.
These values describe frontend files; the API does not supply them.

1. Build the same revision with the same API address:

   ```bash
   npm ci --ignore-scripts
   NULLBIN_API_ORIGIN=https://api.example.com npm run build:frontend
   ```

2. Download `https://paste.example.com/` and `/version.json`. Compare the
   page and manifest with the files in `web/dist`.
3. Download the script and style at the exact URLs listed in the manifest.
   Hash them with `sha256sum` and compare with your local build and manifest.
4. You can also save those responses from your browser's Network panel and
   hash the saved files to check what that browser actually received.

The page includes Subresource Integrity hashes. A matching HTML document
therefore requires matching script/style bytes. HTML is not cached, and
hashed public assets can be cached for a year.

### API

`GET https://api.example.com/api/v1/version` reports the running version and
`"mode":"api"`. It cannot vouch for the separately hosted frontend. To
check the API, rebuild its release and compare checksums as below.

### Releases and reproducible builds

Nothing prebuilt is published: each release is its tagged source plus a
`SHA256SUMS` file. GitHub's release workflow builds the tag twice from
scratch, checks both builds are identical, and records the checksums.
Building the same release yourself gives exactly the same files.

To check, run this in a checkout of the release, replacing `v1.2.3`:

```bash
docker build --target artifacts --build-arg VERSION=v1.2.3 --output type=local,dest=out .
sha256sum out/nullbin out/dist/app.js out/dist/app.css out/dist/index.html
```

Compare the output with the release's `SHA256SUMS`. `nullbin` matches
`nullbin-linux-amd64` or `nullbin-linux-arm64`, depending on your machine.
The three frontend files are those embedded in the optional combined
server, which has no separate API origin. A separately hosted frontend is
built with its own API address, so check it with the
[static frontend steps](#static-frontend) instead.

Checks only prove what was served to you at that time. A compromised
frontend host or build account can serve different code later or to
another visitor. Keep frontend hosting and publishing separate from the
API server when using the stronger deployment option.

</details>

## More information

| Guide | Covers |
|---|---|
| [More deployment options](#more-deployment-options) | Automatic builds, custom static hosts, cloud-init, and switching layouts |
| [Development](#development) | Build from source, run locally without Docker, and run tests |
| [Technical specifications](#technical-specifications) | Architecture, encryption choices and parameters, key handling, wire formats, and browser/content limits |
| [API and configuration](#api-reference) | Endpoints, server settings, and limits |
| [Verify a build or running site](#verify-a-build-or-running-site) | File hashes, reproducible builds, and release checksums |
| [Report a security issue](SECURITY.md) | Email hi@jacobzymet.com; never open a public issue |
| [License](LICENSE) | Currently all rights reserved; bundled third-party components have [their own licenses](THIRD_PARTY_NOTICES). |
