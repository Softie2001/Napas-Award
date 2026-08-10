# NAPAS Award Night — Premium Voting Redesign

This package is the replacement public voting experience for the existing `Softie2001/Napas-Award` project.

## What is included

- Premium white + deep-gradient-purple visual system with restrained gold accents.
- NAPAS logo + Dinner & Award Night flyer used as the visual identity.
- Mobile-first two-column contestant grid so each viewport shows two contestants side-by-side.
- Contestants remain mixed across categories instead of forcing category-by-category rows.
- Large, readable contestant names, vote totals and action buttons.
- Search, category filters, category browser and live leaderboard.
- Clean vote sheet with preset quantities (1, 5, 10, 20, 50, 100) plus custom quantity.
- Voter name, email and phone fields.
- `Continue to Payment` is the final action at the bottom of the voting sheet.
- Payment is initialized by the Cloudflare Worker; the Paystack secret is never exposed to the browser.
- Payment is verified server-side before votes are credited to Firestore.
- Paystack `charge.success` webhook support so a successful payment can still be credited even when a voter closes the browser before returning to the site.
- Duplicate references are protected by a Firestore create precondition, so the same payment cannot credit votes twice.

## Files to replace in the website

Replace only:

- `index.html`
- `css/styles.css`
- `js/app.js`
- `js/config.js`

Keep the existing `assets/` folder, especially:

- `assets/napas-logo.jpeg`
- `assets/event-flyer.jpeg`

Do not replace the existing `admin/` folder.

## Cloudflare Worker

The `worker/` folder is for the existing Cloudflare Worker named `crimson-wave-afc5`.

Copy/replace:

- `worker/src/index.ts` → your Worker's `src/index.ts`
- `worker/package.json` → your Worker's `package.json`
- `worker/wrangler.jsonc` → your Worker's `wrangler.jsonc`

Your existing Worker secrets must remain:

- `FIREBASE_SERVICE_ACCOUNT`
- `PAYSTACK_SECRET_KEY`

The Worker URL used by the frontend is:

`https://crimson-wave-afc5.quadrisubomi.workers.dev`

## Worker deployment

From the existing Worker directory:

```powershell
npm install
npx wrangler deploy
```

Do NOT create another Worker. The project already has `crimson-wave-afc5`.

## Paystack webhook — one required dashboard setting

In Paystack, set the webhook URL to:

`https://crimson-wave-afc5.quadrisubomi.workers.dev/paystack-webhook`

The Worker verifies Paystack's `x-paystack-signature` using the secret stored in Cloudflare before accepting webhook events.

## Firebase

The public browser continues to read contestants and voting settings from the existing Firebase project `napas-award`.

The browser no longer writes vote totals directly. Only the Cloudflare Worker writes verified payments and increments contestant votes.

This avoids requiring Firebase Blaze/Secret Manager for the payment verification path.
