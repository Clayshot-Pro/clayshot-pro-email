# App address, admin sign-in and mail domains

These are three separate things.

## App address

The app works on whatever HTTPS address serves it (`workers.dev` or a custom domain like `mail.example.org`). Nothing in the code or config names it.

- **Passkeys are tied to the address.** A passkey made on `mail.example.org` works only there. Choose the final address before first-run setup.
- **Changing the address of a running instance does not move its passkeys**, and new passkeys can't be registered once one exists. Keep the original address. Never delete authentication rows or disable passkeys to get around this.
- **Gmail:** the OAuth redirect URI is `https://<app address>/api/accounts/gmail/callback`. Add the exact URI in Google Cloud for every address you use.

## Admin sign-in

Sign in as `admin@<main mail domain>`, which is also the admin's mailbox. `admin@<app address>` works as an alias. Both use the same password and passkey.

## Mail domains

Mail domains are managed in **Admin → Domains**. The main one is chosen at first-run setup. Changing the app address never changes mailbox addresses, routing or sending. Renaming the main mail domain of a running instance is not supported.

## New instance on another address

Deploy a separate Worker, D1 database and R2 bucket (the Deploy to Cloudflare button does this), add the custom domain, then run first-run setup on that address. See the [README](../README.md).
