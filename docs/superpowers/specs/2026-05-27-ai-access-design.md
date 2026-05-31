# AI Access Design — BYOK + Managed AI Credits

**Status:** approved architecture, awaiting deferred decisions before commercial implementation
**Date:** 2026-05-27
**Scope:** Chrome extension UI + sidebar/options behavior + separate backend & portal blueprint
**Out of scope for now:** real backend, payment processor, credit ledger, public deployment

---

## Table of contents

1. Phase 0 — Stale UI diagnosis & build indicator
2. Section 1 — High-level architecture & two routes
3. Section 2 — File footprint (three-repo split)
4. Section 3 — Backend secret boundary, ledger, payment, pricing
5. Section 4 — Extension-side mode UX (sidebar + options + portal copy)
6. Section 5 — RED test plan
7. Deferred Decisions Required Before Commercial Implementation
8. Hard non-negotiables (security invariants)

---

## 1. Phase 0 — Stale UI diagnosis & build indicator

### 1.1 Diagnosis

The user's live Chrome screenshot showed provider-specific wording (`DeepSeek API key`, `Manage DeepSeek key`) while the workspace source already contains provider-neutral wording (`AI API Key`, `Manage AI API Key`). Source inspection confirmed:

```
lib/sidebar.js:              DeepSeek=0 | AI API Key=7
lib/ai-options-controller.js: DeepSeek=0 | AI API Key=5
lib/ai-answer-controller.js: DeepSeek=0 | AI API Key=1
options.html:                DeepSeek=0 | AI API Key=3
```

`lib/sidebar.js` line 122–126 renders the new wording. The screenshot was stale because Chrome's "Load unpacked" caches the directory at load time and re-reads it only on Reload, not on each file save.

### 1.2 Manual reload verification (mandatory before entering any key)

1. Open `chrome://extensions/`.
2. Confirm "Clipboard Cleaner" version 1.0.0 is loaded from path:
   `C:\Users\carlo\Desktop\Claude Code\Coursera\Copy and Paste Bypasser`
3. Click **Reload** on that extension card.
4. Reload your Coursera tab (Ctrl+R).
5. Open the sidebar, click **AI Answers**, and verify all four visible labels:
   - Card header: `AI API Key`
   - Status pill: `No AI API Key configured.`
   - Security note contains `Your AI API Key is entered only in extension settings, never on Coursera.`
   - Button: `Manage AI API Key`
6. Click the button. Verify the URL bar shows `chrome-extension://<id>/options.html` and the heading reads `AI API Key Settings`.

If the sidebar still shows "DeepSeek" after Reload + Coursera-tab reload, the loaded folder in step 2 is the wrong one and must be removed and re-added from the correct path.

### 1.3 Build indicator

Stage 0 adds a small `Build: <manifest.version>` text:
- In the options page footer.
- In the Diagnostics tab status block.

The version string comes from `manifest.json` (already public), not a hardcoded constant. Zero secret surface. Eliminates "is the new wording actually loaded?" ambiguity for the remainder of this commercial work.

---

## 2. Section 1 — High-level architecture & two routes

### 2.1 Topology

```
                                ┌────────────────────────┐
                                │   AI Answers sidebar   │
                                │  (read-only mode pill) │
                                └───────────┬────────────┘
                                            │
                            performGenerate(sanitized snapshot)
                                            │
                                            ▼
                              ┌──────────────────────────┐
                              │ ai-background-service.js │
                              │   reads aiAccessMode     │
                              └─────┬──────────┬─────────┘
                                    │          │
                       mode = personal-key   mode = managed-credits
                                    │          │
                          ┌─────────▼──┐   ┌───▼────────────────────┐
                          │ deepseek-  │   │ managed-client.js (NEW)│
                          │ client.js  │   │  POST <BACKEND>/api/   │
                          │ (existing) │   │     generate-          │
                          │            │   │     suggestions        │
                          │ uses BYOK  │   │  (bearer session token)│
                          │ key from   │   └──┬─────────────────────┘
                          │ chrome.    │      │
                          │ storage    │      │  HTTPS, no upstream
                          │            │      │  secret leaves backend
                          └────┬───────┘      │
                               │              ▼
                       https://api.    ┌──────────────────┐
                       deepseek.com    │  Backend service │
                                       │  (separate repo) │
                                       │                  │
                                       │  • secret store  │
                                       │  • credit ledger │
                                       │  • upstream call │
                                       └────────┬─────────┘
                                                │
                                       https://api.deepseek.com
```

Both routes return the same `{ ok, raw: { answers: [...] } }` shape so the existing `lib/ai-answer-validator.js` and `lib/answer-applier.js` are reused unchanged.

### 2.2 Storage

`chrome.storage.local["ccp.ai.accessMode"]` ∈ `{ "personal-key", "managed-credits" }`. Defaults to `"personal-key"` for existing users so today's behavior is preserved exactly.

### 2.3 Out-of-credits behavior

When Managed mode runs out of credits, generation fails closed with the honest message:

> "You are out of AI Credits. Add credits to continue, or open settings to switch to your own AI API Key."

There is no silent fallback between modes. Mode switches happen only when the user explicitly chooses in the options page.

---

## 3. Section 2 — File footprint (three-repo split)

### 3.1 Extension (this repo)

| File | Status | Stage | Purpose |
|---|---|---|---|
| `lib/sidebar.js` | modify | 0 + 2 | Stage 0: build tag in Diagnostics. Stage 2: read-only mode pill in AI Answers card. |
| `lib/ai-answer-controller.js` | modify | 2 | Add `aiAccessMode` read; route the existing onOpenOptions and a new onOpenPortal callback. |
| `lib/ai-background-service.js` | modify | 2 | Read `aiAccessMode`; dispatch to either `deepseekClient` (BYOK) or `managedClient` (new). |
| **`lib/managed-client.js`** | **NEW** | 2 (mocked) → 3 (real) | `createManagedClient({ fetchFn, backendBaseUrl, sessionTokenProvider, timeoutMs })` returning `{ generateAnswers(snapshot, sessionToken, opts) → Promise<{ok, raw, reason?}> }`. Stage 2 mock returns `{ ok:false, reason:'managed-not-implemented' }` without issuing any fetch. |
| `background.js` | modify | 2 | Wire `managedClient`; pass it alongside `deepseekClient` to the service. Read backend base URL from a build-time constant placeholder (NOT from extension storage). |
| `options.html` | modify | 0 + 2 | Stage 0: build tag in footer. Stage 2: add Managed AI Credits section with portal-link button + mode toggle. |
| `lib/ai-options-controller.js` | modify | 2 | Add mode-toggle handlers + managed status display. No new secret handling. |
| `manifest.json` | modify | 2 | Add `host_permissions` for `<BACKEND_BASE_URL>/*` placeholder (finalized in Stage 4). |
| `content.js` | modify | 2 | Wire new openPortalFn callback → `chrome.tabs.create({ url: <PORTAL_URL_PLACEHOLDER> })`. |
| `tests/managed-client.test.js` | NEW | 2 | RED tests for managed client request/response/error shapes. |
| `tests/sidebar.test.js` | modify | 0 + 2 | New tests for build tag + mode-aware pill. |
| `tests/ai-options-controller.test.js` | modify | 0 + 2 | New tests for build tag + mode toggle + portal link. |
| `tests/ai-answer-controller.test.js` | modify | 2 | New tests for mode-aware Generate routing. |
| `tests/ai-background-service.test.js` | modify | 2 | New tests for mode-aware dispatch. |

### 3.2 Out of scope for this repo

- The hosted **AI Credits Portal** — separate web app (different repo, different deploy). Stage 4 designs its content via plan-card schema; the portal HTML lives elsewhere.
- The **backend API service** — separate repo, different deploy. Stage 3 designs its endpoints + ledger; Stage 4 implements it after deferred decisions are answered.
- **Pricing/admin tools** — live in the backend repo.

### 3.3 Stage 2 production growth estimate

~150 lines of production code plus matching tests. Stage 2 is UI scaffolding + mocked managed service only. No payment, no real backend, no live commercial route.

---

## 4. Section 3 — Backend secret boundary, ledger, payment, pricing

### 4.1 Threat model — what the extension package contains

The Chrome extension package contains ZERO upstream secrets. The bundle ships:
- Backend base URL (public).
- Portal URL (public).
- `host_permissions` for those two domains.
- The user's own BYOK key when they enter one — stored in `chrome.storage`, never bundled.

The bundle does NOT ship:
- Upstream provider API key.
- Server-side credentials of any kind.
- A "default key" fallback.
- An `.env` file (env vars belong to the backend repo, gitignored).

If a customer unzips the `.crx` and reads every file, they find no provider secret.

### 4.2 Backend secret boundary

```
Backend service (separate repo + deploy)
├── secrets (from hosting platform secret manager — NEVER committed)
│   ├── UPSTREAM_AI_API_KEY        (the real key)
│   ├── PAYMENT_PROCESSOR_SECRET   (assigned in Stage 4)
│   ├── PAYMENT_WEBHOOK_SIGNING    (verify webhook authenticity)
│   ├── SESSION_JWT_SIGNING        (sign user sessions)
│   └── DATABASE_URL               (credit ledger + account store)
└── code
    ├── routes/...                 (public endpoints)
    ├── upstream-adapter.js        (the ONLY place that reads UPSTREAM_AI_API_KEY)
    ├── ledger.js                  (atomic reserve/settle/refund)
    ├── plans.js                   (retail plan config)
    ├── pricing-calculator.js      (admin-only, computes margin)
    └── tests/...
```

`upstream-adapter.js` mirrors the shape of this repo's `lib/deepseek-client.js`. Customer-facing `/api/generate-suggestions` validates session, checks ledger, reserves estimated cost, calls upstream, settles actual cost. The session token returned to the extension is a short-lived JWT with `{ userId, exp }` — nothing else. The upstream key is never present in any response payload, log line, or response header reachable by the extension.

### 4.3 Credit ledger flow

Append-only table `credit_ledger`:

```
| id | userId | type        | amount  | reqId        | timestamp | reason             |
|----|--------|-------------|---------|--------------|-----------|--------------------|
|  1 | u_42   | purchase    | +5000   |              | ...       | plan=starter       |
|  2 | u_42   | reservation | -250    | req_abc123   | ...       | est-max input+out  |
|  3 | u_42   | settlement  | +50     | req_abc123   | ...       | actual usage 200   |
|  4 | u_42   | refund      | +5000   |              | ...       | admin: chargeback  |
```

`balance(userId) = sum(amount where userId = u_42)`.

Request flow:
1. Extension posts sanitized snapshot + session token to `/api/generate-suggestions`.
2. Backend validates session, parses snapshot, computes `estimateMax` from configured upstream costs.
3. Backend inserts `reservation` row for `-estimateMax`. If new balance < 0 → roll back, return `{ ok:false, reason:'insufficient-credits' }`.
4. Backend calls upstream adapter.
5. On success: insert `settlement` row for `+(estimateMax - actualCost)`, refunding unused reservation.
6. On upstream failure: insert `settlement` row for `+estimateMax`, full refund.
7. Backend returns `{ ok:true, raw: {...}, balanceAfter: <credits> }`.

Idempotency: every reservation/settlement keys on `reqId`. Webhook events dedupe by event id.

### 4.4 Payment & webhook flow

```
Customer in Portal
       │
       │  click "Buy Starter Pack"
       ▼
Portal → POST /api/checkout/session
       │
       ▼
Backend → Payment Processor "Create Checkout Session" API
       │  returns checkoutUrl
       ▼
Portal redirects user to checkoutUrl (processor-hosted)
       │
       │  user enters card data ON THE PROCESSOR'S DOMAIN — never on us
       ▼
Processor → Backend POST /api/webhooks/payment-provider
       │  (signed event)
       ▼
Backend verifies signature, dedupes event.id, credits ledger
       │
       ▼
On user return, Portal polls /api/me/balance; extension sees broadcast or poll
```

Card data never touches our backend or extension. The processor is PCI-DSS-compliant by design; we only see post-payment webhooks. The specific processor is **deferred** until you answer Stage 4 questions.

### 4.5 Pricing & margin model (admin-only)

Backend config tables, hot-editable:

```
provider_cost_config (single-row, internal-only)
├── modelId               e.g. "deepseek-v4-flash"
├── verifiedAt            "<ISO date>"
├── inputCachedPerMUsd    <from upstream docs at verifiedAt>
├── inputUncachedPerMUsd  <from upstream docs at verifiedAt>
├── outputPerMUsd         <from upstream docs at verifiedAt>
└── maxOutputTokens       <from upstream limits>

retail_plans (customer-visible via /api/plans)
├── id
├── displayName
├── priceText                 currency-aware string, formatted by backend
├── includedCreditsText
├── estimatedSuggestionsText  always labelled "Estimated"
├── perRequestLimitsText      product limit, not upstream full window
├── varianceNote              required text about variance
├── termsSummaryText          required before active:true
├── ctaLabel
├── active                    bool — must have all required fields populated

business_config
├── paymentProcessingPct
├── paymentProcessingFlat
├── reservePct                buffer for upstream price changes
└── targetGrossMarginPct

admin pricing calculator (separate CLI / dashboard, NOT customer-facing)
└── calculatePlanMargin(planId) =>
      { grossRevenue, processorFee, upstreamCost, reserveAllowance,
        grossProfit, grossMarginPct }
```

**Customer UI never shows upstream cost or our margin.** The portal shows price + included credits + truthful estimate text. Internal margin analysis is admin-only.

**1 "credit" = a fraction of a USD stable across upstream price changes.** When upstream prices change, we update `provider_cost_config.verifiedAt` and adjust how many credits we reserve per request — the customer's existing balance stays whole.

---

## 5. Section 4 — Extension-side mode UX (sidebar + options + portal copy)

### 5.1 Sidebar AI Answers card (read-only, one mode at a time)

**When `aiAccessMode === "personal-key"`:**
```
┌─────────────────────────────────────────┐
│ AI API Key                              │
│                                         │
│ [pill: No AI API Key configured. ]      │  (or "configured for this session.",
│                                         │   or "remembered on this browser.")
│ Your AI API Key is entered only in      │
│ extension settings, never on Coursera.  │
│                                         │
│ [ Manage AI API Key ]                   │
└─────────────────────────────────────────┘
```

**When `aiAccessMode === "managed-credits"`:**
```
┌─────────────────────────────────────────┐
│ AI Credits                              │
│                                         │
│ [pill: Not signed in.            ]      │  (or "12,450 credits remaining",
│                                         │   "Low balance", "No credits available")
│ No API key required. Credits power      │
│ generation through our hosted service.  │
│                                         │
│ [ Get AI Credits ]                      │  (when not signed in or balance 0)
│   — or —                                 │
│ [ View Balance / Add Credits ]          │  (when signed in with funded balance)
└─────────────────────────────────────────┘
```

The sidebar shows exactly one card. Switching modes requires the options page.

### 5.2 Options page layout

```
┌──────────────────────────────────────────────────────────┐
│  AI API Key Settings                                     │
│                                                          │
│  Choose how this extension calls the AI service.         │
│                                                          │
│  ●  Use my own AI API Key                                │
│  ○  Use Managed AI Credits                               │
│                                                          │
│  ────────────────────────────────────────────────────    │
│                                                          │
│  ▸ Use Your Own AI API Key                               │
│                                                          │
│    [ ✕    password input    ] [ Show ]                   │
│    □ Remember on this browser                            │
│    [ Save ]        [ Clear saved key ]                   │
│    Status: No AI API Key configured.                     │
│                                                          │
│  ────────────────────────────────────────────────────    │
│                                                          │
│  ▸ Managed AI Credits                                    │
│                                                          │
│    No API key required. Purchase credits in our          │
│    hosted portal to start generating suggestions.        │
│                                                          │
│    Balance: Not signed in.                               │
│                                                          │
│    [ Open AI Credits Portal ]                            │
│                                                          │
│  ────────────────────────────────────────────────────    │
│  Build: 1.0.0                                            │
└──────────────────────────────────────────────────────────┘
```

The radio is the source of truth for `aiAccessMode`. Both sections remain visible at all times; only the selected one is the "active" route used by the sidebar.

### 5.3 Hosted AI Credits Portal — configurable copy

All prices, credit amounts, estimated generations, processor names, refund/expiry terms, and per-request limits are **configurable backend fields**, not hardcoded extension UI. The portal HTML reads from `/api/plans` at render time.

#### 5.3.1 Approved headline + supporting copy

> **Power your AI Answers with flexible credits**
> No API key setup required. Choose a credit pack, connect your extension, and generate suggestions on supported practice content.

#### 5.3.2 Plan card — configurable field schema

```
Plan Card
├── displayName              e.g. "Starter Credits"
├── priceText                currency-aware string from backend
├── includedCreditsText      e.g. "50,000 credits"
├── estimatedSuggestionsText always labelled "Estimated" + why-it-varies
├── perRequestLimitsText     PRODUCT limit (not upstream full window)
├── varianceNote             "Actual usage varies with page size and answer length."
├── termsSummaryText         required before active:true
└── ctaLabel                 e.g. "Get Started" / "Buy <displayName>"
```

**Placeholder rendering before policy finalization:**
```
┌─ Starter Credits ──────────────────────────────────────┐
│  Price: To be configured                               │
│  Included credits: To be configured                    │
│  Estimated suggestion sets: shown once plan pricing    │
│    is approved                                         │
│  Per-request limits: configured before launch          │
│  Actual usage varies with page size and answer length. │
│  [ Get Started ]                                       │
└────────────────────────────────────────────────────────┘
```

Production cards (post-config) MUST include all required fields populated. A plan with empty `termsSummaryText` or missing `perRequestLimitsText` does not pass the portal's render guard and is omitted from `/api/plans`.

#### 5.3.3 Approved labels (whitelist for public surfaces)

- `AI Credits`
- `Managed AI Credits`
- `Get AI Credits`
- `Add Credits`
- `View Balance`
- `Open AI Credits Portal`
- `Use Managed AI Credits`
- `Manage AI API Key`
- `AI API Key`
- `AI service`

#### 5.3.4 Forbidden public-facing wording (blacklist enforced by test)

- `Buy API Key`
- `Built-in API Key`
- `Use built-in API key`
- `Unlimited` (anything implying unlimited usage)
- `Guaranteed` (anything guaranteeing a specific number of generations)
- Any upstream provider name or trademark on customer-visible surfaces, unless an explicit `provider_branding_approved=true` config flag is set AND a documented legal review record exists.

#### 5.3.5 Payment processor — UNNAMED in the spec

> "Pay through our secure hosted checkout."

The specific processor is deferred. The backend spec treats the processor as an injected adapter with a stable interface, so swapping processors later does not require re-architecting.

#### 5.3.6 Expiry / refund / taxes — UNNAMED in the spec

> "Credit expiry and refund terms will be displayed before purchase."

These are policy decisions deferred until you finalize them. A plan with empty `termsSummaryText` is not `active:true`.

#### 5.3.7 Safety language (kept prominent on the portal)

> **What this service will not do**
> - It does not work on graded assignments, exams, peer reviews, programming assignments, discussion prompts, or other assessment activity.
> - Suggestions are previewed locally before you choose whether to apply them.
> - Nothing is submitted automatically. You always click Apply yourself.

#### 5.3.8 Profit and upstream-cost data — admin-only

Customer-visible:
- price paid
- included credits
- estimated typical generations
- product per-request limits
- terms summary

Admin-only (separate CLI/dashboard in the backend repo):
- upstream input/output token unit costs
- payment processing fee + flat fee
- reserve allowance
- target margin %
- estimated gross profit
- estimated gross margin %

The admin calculator is never reachable from the customer portal. A test asserts customer-visible plan responses contain no `upstreamCost`, `marginPct`, or `grossProfit` fields.

---

## 6. Section 5 — RED test plan

### 6.1 Stage 0 (build indicator only)

`tests/sidebar.test.js`:
- Diagnostics tab renders `Build: <manifest.version>` text. Version string comes from `manifest.json`, not a hardcoded constant. No secret-looking value appears.

`tests/ai-options-controller.test.js`:
- options.html footer renders `Build: <version>`. Build text is informational only.

### 6.2 Stage 2 (UI scaffolding + mocked managed client)

#### Sidebar mode UX — `tests/sidebar.test.js`

- Default `aiAccessMode` is `"personal-key"` — sidebar renders BYOK card.
- `setAiAccessMode("managed-credits")` re-renders sidebar to show Managed Credits card, hides BYOK card.
- BYOK card content unchanged from U9.
- Managed card contains: title `AI Credits`, status pill, descriptive text, action button. NO password input, NO Save key button, NO Clear key button, NO key-display element.
- Managed card action button label varies with state: `Get AI Credits` (not signed in / unfunded) → `View Balance / Add Credits` (signed in + funded).
- Per-mode rendering never includes upstream provider name or forbidden blacklist substrings.

#### Options page mode toggle — `tests/ai-options-controller.test.js`

- Radio toggle with two values: `personal-key`, `managed-credits`.
- Toggling persists `aiAccessMode` to `chrome.storage.local` (verified via injected fake storage).
- Both sections (BYOK + Managed) remain visible at all times.
- Selecting Managed does NOT clear an existing stored BYOK key — it just deactivates the BYOK route.
- Portal link button is always visible in the Managed section.
- Build footer renders.

#### Managed client contract — `tests/managed-client.test.js` (NEW)

- `createManagedClient({ fetchFn, backendBaseUrl, sessionTokenProvider, timeoutMs })` returns `{ generateAnswers(snapshot, sessionToken, opts) → Promise<{ok, raw, reason?}> }`.
- In Stage 2 mocked form: `generateAnswers` returns `{ ok:false, reason:'managed-not-implemented' }` without making any network request.
- Tests verify no `fetch` call is issued in Stage 2.

#### Background service routing — `tests/ai-background-service.test.js`

- `aiAccessMode = "personal-key"` → calls injected `deepseekClient.generateAnswers`, ignores `managedClient`.
- `aiAccessMode = "managed-credits"` → calls injected `managedClient.generateAnswers`, ignores `deepseekClient`.
- Mode change persists across service-worker restart (test by reconstructing service with same fake storage).
- `keyStatus` returns BYOK key presence + Managed account presence as separate booleans: `{ ok:true, byokKeyPresent, managedSignedIn, managedBalance }`.
- Managed mode's `generateAnswers` never reads BYOK key storage, even if it's configured.

#### End-to-end controller — `tests/ai-answer-controller.test.js`

- In Managed mode, performGenerate sends snapshot through the managed route. Stage 2 mock returns `managed-not-implemented` and the sidebar shows an honest "Managed AI Credits is not yet available." message.
- Generate stays disabled in Managed mode until Stage 3's real client is wired AND user is signed in AND balance > 0.

### 6.3 Stage 3 (backend implementation in a separate repo)

`tests/managed-client.test.js` gains tests asserting the real HTTPS-call shape (with `fetchFn` stubbed):
- Request URL is `<backendBaseUrl>/api/generate-suggestions`.
- Authorization header is `Bearer <sessionToken>` and ONLY there.
- Body is exactly the sanitized snapshot from `aiQuestionContext.sanitizeForRequest()` — no localGuard, no upstream key, no BYOK key.
- 401 maps to `reason:'session-expired'`.
- 402 or response `{ ok:false, reason:'insufficient-credits' }` is surfaced honestly to the sidebar.
- 429 maps to `reason:'rate-limit'`.
- Response containing token-usage metadata is ignored by the extension (the validator only cares about `answers`); usage is the backend's business.

### 6.4 Stage 4 (real payment processor + plans endpoint)

`tests/portal-contract.test.js` (new in this repo) consumes the backend's `/api/plans` shape and asserts:
- Each plan has all six required fields populated and non-empty.
- No plan response includes `upstreamCost`, `marginPct`, `grossProfit`, or any blacklisted forbidden-wording substring.
- Plan price is a string formatted by backend (currency-aware), not a raw number.

### 6.5 Existing regression suites that must remain green

- options-page key isolation
- strict options sender authorization
- sanitized key-status broadcast
- blocked-page gate (URL + title + current-activity visible-content)
- live Generate revalidation
- local apply guard
- per-tab cancellation
- safe inert rendering (textContent only)
- no auto-submit
- Autopilot untouched

---

## 7. Deferred Decisions Required Before Commercial Implementation

These eight decisions must be answered before Stage 3 (backend) and Stage 4 (real payment + plans) implementation begins. Stage 0 and Stage 2 may proceed without them.

### Decision 1 — Backend hosting platform and production secret-management system

**Options to choose from (non-exhaustive):** Cloudflare Workers, Vercel, Render, Fly.io, AWS Lambda, a managed VPS.

**What hinges on this:** cold-start tolerance, geographic latency to your customers, the specific secret-manager API used to store `UPSTREAM_AI_API_KEY`, deploy CI surface, monthly cost floor, and whether the backend can run in a region close to the payment processor for low-latency webhook handling.

**Status:** UNDECIDED.

### Decision 2 — Authentication method for managed-credit users

**Options:** email + magic link (no password); email + password; OAuth (Google / GitHub / Microsoft); anonymous device-linked balance (token in `chrome.storage` mapped to a balance with no email).

**Trade-offs:** magic-link is lowest-friction commercial flow and avoids password storage; OAuth adds third-party dependency and KYC implications; anonymous device-linked is easiest for customers but loses purchase recoverability across devices and complicates support.

**Status:** UNDECIDED.

### Decision 3 — Hosted portal domain and deployment arrangement

**Questions:** What public domain do you own / plan to register for the portal? Will the portal and backend share a domain (e.g., `app.example.com` for portal, `api.example.com` for backend) or live on separate domains? What CDN / static host serves the portal HTML/CSS?

**Status:** UNDECIDED.

### Decision 4 — Payment processor selection

**Candidates:** Stripe, Lemon Squeezy, Paddle, PayMongo, others.

**Trade-offs:** international support, currency coverage (especially PHP), merchant-of-record vs direct, fee structure, KYC requirements for your jurisdiction, ease of webhook signature verification, support for hosted-checkout UI that we don't have to design ourselves.

**Status:** UNDECIDED. The spec uses the placeholder phrase "secure hosted checkout" everywhere.

### Decision 5 — Currency, customer region, tax/VAT, and billing-policy requirements

**Questions:** Which currencies should the portal accept? Customer regions you serve? Local tax/VAT/GST obligations? Whether the chosen payment processor handles tax-collection automatically (merchant-of-record processors like Paddle / Lemon Squeezy do; Stripe Direct does not). Chargeback / dispute handling.

**Status:** UNDECIDED.

### Decision 6 — Actual credit-pack prices, credit accounting unit, usage estimation, and margin assumptions

**Questions:** Initial three (or N) plans — display name, price, currency, included credits, estimated typical generations, per-request input/output limits. Target gross margin %. Reserve % buffer. How long credits are valid for. Refund policy for unused credits.

**Status:** UNDECIDED. Public surfaces use "To be configured" / "shown once plan pricing is approved" placeholders.

### Decision 7 — Refund, expiry, terms-of-service, privacy-policy, and support policies

**Questions:** Refund window and conditions. Credit expiry (e.g., 12 months, never, conditional). Terms of Service drafting and hosting. Privacy policy contents (we collect: email if used for sign-in, payment metadata via processor, usage logs with no prompt content). Support channel (email, ticket system, Discord). Jurisdiction for disputes.

**Status:** UNDECIDED. Portal copy uses "Credit expiry and refund terms will be displayed before purchase." until policies are written.

### Decision 8 — Verification of AI provider commercial terms, model/pricing assumptions, and any branding restrictions before launch

**Questions:** Does the upstream AI provider permit commercial managed resale of their API under their Terms of Service? Some providers require a special agreement for resale; others forbid it; others allow with attribution. What's the current per-million-token pricing (input cached, input uncached, output) for the chosen model, and when was it last verified? Is the provider's name/logo permitted on the customer-facing portal? If branding restrictions apply, document the `provider_branding_approved` config flag's required legal-review record.

**Status:** UNDECIDED. This decision can block the project from shipping in Managed mode entirely. Resolve before Stage 4.

---

## 8. Hard non-negotiables (security invariants)

These invariants apply at every stage and must never be relaxed.

### 8.1 No upstream secret in the extension

- Never put a real upstream API key into: extension source code, `manifest.json`, content scripts, `background.js`, JSON config packaged with the extension, documentation, tests, logs, frontend build-time variables, browser storage distributed to customers, a repository-tracked `.env` file.
- The Chrome extension package (the `.crx` / unpacked directory) contains zero upstream provider secrets.
- For local backend development only, an untracked `.env.local` may eventually be supported with a placeholder `.env.example`, but `.env.local` must be gitignored, must belong to the backend service (never the extension bundle), and the real production secret must be entered into a hosting-platform secret manager — not committed.

### 8.2 BYOK secret entry is options-page-only

- No password input, textarea, key input, Save key button, Clear key button, Show/hide toggle, or "Use built-in API key" control may appear in the Coursera-injected sidebar.
- BYOK key entry remains only at `chrome-extension://<id>/options.html` (extension origin).
- The strict `canManageSecretsStrict` predicate in `background.js` continues to require `sender.url === chrome.runtime.getURL('options.html')` for `setSessionKey` and `clearKey` commands.

### 8.3 Managed mode never exposes the upstream key

- The extension calls the backend; the backend calls the upstream AI provider.
- The upstream API key is read only from backend secret storage and never returned to the extension or web client in any response body, header, or log line.
- Managed-mode requests use a short-lived session token (JWT) carrying only `{ userId, exp }`.

### 8.4 Honest customer language

- Customer purchases are described as buying AI Credits, not buying API keys.
- "Buy API Key", "Built-in API Key", "Use built-in API key", "Unlimited generations", "Guaranteed number of answers" are forbidden on all customer-visible surfaces.
- Upstream provider name / logo do not appear on public customer UI unless an explicit `provider_branding_approved=true` flag is set with a documented legal-review record.

### 8.5 Existing safety gates remain intact

- No auto-submit behavior is added in any stage.
- Blocked-page detection (URL pattern + title pattern + current-activity visible-content) remains and is enforced before Scan, Generate, and Apply.
- Generate revalidates the live current page before sending.
- Apply uses the local answer-change guard to refuse overwriting user-entered values.
- Per-tab AbortController isolation remains (`state.byTab` Map in `lib/ai-background-service.js`).
- Sanitized payload only: no localGuard, no upstream key, no BYOK key, no DOM nodes ever appear in any outbound request body.
- Inert text rendering only: textContent for all dynamic UI; no `innerHTML` for any model or user input.
- Autopilot production source and tests remain untouched.

### 8.6 No real key, no live test, no git mutation during architecture work

- Do not enter, paste, type, or request the user's real API key while implementing scaffolding.
- Do not run live Coursera assessment flows.
- Do not commit, push, reset, clean, revert, checkout, or amend during architecture/spec/Stage-0/Stage-2 work.
