# Running simple timeline on this Mac

This bundle is already built. Nothing compiles here — you only need Node.

## 1. Check Node

Open Terminal and run:

```bash
node -v
```

You need **v24.0.0 or newer**. The app uses SQLite and TypeScript support that
Node only gained in v24, so v22 and earlier will not start.

No Node, or too old? Download the **LTS** installer for macOS from
<https://nodejs.org>, run it, then close and reopen Terminal and check again.

## 2. Start it

**The easy way** — double-click **`start.command`** in this folder. A Terminal
window opens and your browser follows a couple of seconds later.

**From Terminal**, if you prefer:

```bash
cd /path/to/simple-timeline
npm start
```

Either way the board is at **<http://localhost:5173>**.

Leave the Terminal window open while you use it. Press **Control-C**, or close
the window, to stop.

### If macOS blocks start.command

macOS quarantines files that arrive from another machine. If double-clicking
does nothing, or you see "cannot be opened because it is from an unidentified
developer":

```bash
cd /path/to/simple-timeline
xattr -dr com.apple.quarantine .
chmod +x start.command
```

Then double-click it again. Running `npm start` from Terminal always works and
sidesteps this entirely.

## 3. Your data

Everything lives in one file: **`data/timeline.db`**.

- **Back it up** by copying that file. That is the whole backup.
- **Move it to another machine** by copying the file over the one there.
- **Start over** by deleting it — the app rebuilds an empty database on the next
  start. To get the demo teams instead, run `npm run seed`.

> `npm run seed` **erases everything** and replaces it with demo data. Do not run
> it on a database you care about.

## Everyday use

| | |
|---|---|
| Start | double-click `start.command`, or `npm start` |
| Stop | Control-C in that Terminal window |
| Open the board | <http://localhost:5173> |
| Different port | `PORT=8080 npm start` |
| Back up | copy `data/timeline.db` |

## Does it need internet?

No. The board, its data, and its fonts are all local. Nothing is sent anywhere,
and there is no sign-in — anyone using this Mac can open the board.

## If something goes wrong

**"address already in use"** — it is already running in another window, or
something else holds the port. Use that window, or start on another port with
`PORT=8080 npm start`.

**"Cannot find module 'express'"** — the `node_modules` folder did not survive the
copy. Re-unzip the bundle, or with internet run `npm install --omit=dev` in this
folder.

**The page loads but stays empty** — you have no teams yet. Click **Teams**, then
**Add team**. It starts with SIT, UAT and PROD, and you can add projects and
bookings from there.

**Anything else** — the Terminal window shows the error. Copy that text when
asking for help.

## What this app is

A booking board for delivery environments. Teams own environments (SIT, UAT,
PROD…), projects book them for date ranges, and the board shows where two
projects want the same environment at the same time — a **double-booking**.

`README.md` covers how it works in more detail; `DESIGN.md` covers why it is
built and drawn the way it is.
