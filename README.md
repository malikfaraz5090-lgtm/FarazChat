# FarazChat

A small, self-hosted real-time chat app with 8-digit contact-code accounts, editable display names and bios, exact-code search, private saved contact names, and persistent one-to-one conversations.

## Run locally

Requires Node.js 20 or newer.

```sh
npm install
npm run dev
```

Open the Vite URL shown in the terminal (usually http://localhost:5173). Create two accounts in separate browser profiles to try live messaging. Registration is a four-step flow: choose a unique 8-digit code, set and confirm a password, add a profile name/photo, then add a bio and accept the policies. Log in with the code and password; existing accounts receive a migrated code and can still use their old username during transition. Search requires the complete code, and saved contact names are private to the account that saves them. Lost passwords cannot be recovered; signed-in users can change them in Account settings. Signup also explains server storage and status expiry. The gear opens profile, photo, code-search privacy, notifications, dark mode, and password settings. Open a chat header to view/save a member profile. The inbox has Chats, Groups, and Status tabs. Create a group from the people icon, or post text/photo/video/emoji statuses that expire after 24 hours. Chat shows live online/offline and typing status, and supports photos and files up to 15 MB with member-only downloads. Messages, groups, statuses, preferences, and contact names are stored in `data/farazchat.sqlite`; attachment files persist under `data/message-files`, profile photos under `data/avatars`, and status media under `data/status-files`. Expired status media is cleaned automatically. Passwords are hashed with bcrypt, sign-out asks for confirmation, and notifications require browser permission. Existing accounts and direct messages keep working through additive database migrations. The local database and session-signing secret are excluded from git.

## Production

```sh
npm run build
npm start
```

The production server serves the built app on port 3000 by default. Set `PORT` to change it and keep the `data` directory on persistent storage. Deploy the app server over HTTPS and back up its data directory. This is a small private chat app, not an end-to-end encrypted service; messages are stored in readable form on the server.