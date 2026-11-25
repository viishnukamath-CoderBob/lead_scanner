# Lead Capture – GitHub-only version

Just static files. No server, no database, no Google, no Render.

## Put it live (about 3 minutes)
1. On GitHub, create a new repository (Public).
2. Click **Add file → Upload files** and drag in **everything inside this folder** (`index.html`, `app.js`, `backend.js`, `style.css`, `sw.js`, `manifest.webmanifest`, `icon.svg`, `.nojekyll` and the `vendor` folder). Commit.
   - If the `vendor` folder or `.nojekyll` file won't drag in, use **Add file → Create new file**, type `.nojekyll` as the name and commit. For `vendor`, upload it on its own.
3. **Settings → Pages → Build and deployment → Deploy from a branch → `main` → `/ (root)` → Save.**
4. After about a minute your link is `https://<your-username>.github.io/<repo-name>/`. It is HTTPS, so the camera works.

## First use
1. Open the link. The first person to open it **on a device** chooses a username and password: that becomes the admin for that device.
2. **Admin → Add user** to create booth logins; **Admin** also manages topics.
3. Pick a topic, scan the nametag, check the name and company, choose Hot / Warm / Cold, add notes, save, scan the next person.
4. **Admin → Export Excel (.xlsx)** downloads the leads.

## Important limitation – read this
GitHub Pages only serves files. It cannot store data. So **leads are saved in the browser of the device that captured them**:
- Phones do **not** share data with each other, and there is no live sync between devices.
- Each device has its own admin, users and topics.
- Clearing browser data on that device deletes its leads. **Export to Excel before the end of the day.**
- Use the same phone and browser each time; a private/incognito tab does not keep data.

If several people must see one combined list, you need a shared backend (the Render or Google Sheets versions).
